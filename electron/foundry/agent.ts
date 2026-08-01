import {
  FOUNDRY_NOT_CONFIGURED_ERROR,
  type FoundryConfig,
} from "../../common/foundry";
import { createLogger } from "../logger";
import { loadFoundryConfig } from "./config";
import { abortReason, authHeaders, isRecord, msg, postWithRetry } from "./http";

/**
 * A minimal agent runtime over the Azure AI Foundry **Responses API**: one client that
 * resolves the connection, sessions that own a conversation, and a tool loop that runs
 * our in-process tools until the model stops calling them.
 *
 * **Why Responses and not chat-completions.** Gate G1 (the live smoke against the real
 * `gpt-5.3-codex` deployment) found that every POST to `/openai/v1/chat/completions`
 * comes back `HTTP 400 · "The requested operation is unsupported."` — this deployment
 * exposes `/openai/v1/responses` only. So the transport speaks the Responses wire:
 * a system prompt travels as top-level `instructions`, the conversation travels as an
 * `input` item array, tools are **flat** (`{ type, name, description, parameters }`,
 * no nested `function` object), tool replies are `function_call_output` items keyed by
 * `call_id`, and images ride as `input_image` parts whose `image_url` is a plain data-URI
 * string.
 *
 * **`store: false` on every request.** The conversation stays entirely in this process:
 * nothing is persisted server-side, which keeps the privacy posture identical to the
 * chat-completions build *and* keeps the rollback design intact — a failed turn is undone
 * by truncating our own array, with no server state left pointing at it. The cost is that
 * each request is stateless, so **every** output item the model returns (messages,
 * `function_call`s, and the opaque `reasoning` items reasoning models like codex require
 * back) is appended to the history verbatim and echoed on the next request. That is also
 * why the body asks for `include: ["reasoning.encrypted_content"]` — without the encrypted
 * payload a reasoning item cannot be re-submitted. If a deployment rejects that include
 * value, the session drops it once and remembers (surface drift tolerance).
 *
 * The public surface was modelled on the Copilot SDK this app used to run on
 * (`start`/`createSession`/`sendAndWait`/`abort`/`disconnect`/`stop`) and on its `Tool`
 * contract, which is why the `tools.ts` files and their call sites moved over by
 * changing an import line. That lineage is history now — nothing here depends on it.
 *
 * Built on Node's global `fetch` — **no new npm dependency** — and free of any
 * `electron` import so the eval harness can load it outside the app.
 *
 * Non-goals, deliberately deferred:
 * - **Streaming.** Nothing consumes token deltas; progress comes from tool callbacks.
 * - **Server-side conversation state.** `store: false` + local history (see above).
 * - **History trimming/compaction.** Turns are already bounded (≤500 event rows per
 *   `get_events`, ≤6 images per `get_frames`, and the 32-round cap below).
 * - **Parallel tool execution.** Handlers share mutable in-process state (the frame
 *   extractor), so calls run sequentially in the order the model asked for them —
 *   `parallel_tool_calls: false` tells the model the same thing.
 * - **Entra ID auth.** Key auth only.
 */

const log = createLogger("Foundry");

/** Hard stop on a runaway tool loop inside a single turn. */
const MAX_ROUNDS_PER_TURN = 32;

/** Asked for so reasoning items come back re-submittable under `store: false`. */
const REASONING_INCLUDE = "reasoning.encrypted_content";

// --- tool contract (shaped after the Copilot SDK's, which this replaced) -----

export interface ToolBinaryResult {
  type: "image";
  /** Base64 payload with no `data:` prefix. */
  data: string;
  /** e.g. `image/jpeg`. */
  mimeType: string;
  description?: string;
}

export interface ToolResultObject {
  textResultForLlm: string;
  binaryResultsForLlm?: ToolBinaryResult[];
  resultType?: "success" | "failure";
}

export type ToolResult = string | ToolResultObject;

export interface Tool {
  name: string;
  description: string;
  /** Plain JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
  /** Receives the **parsed** arguments; may return text or text + images. */
  handler: (args: unknown) => ToolResult | Promise<ToolResult>;
}

export interface SessionOptions {
  /** Sent as the request's top-level `instructions`. */
  instructions?: string;
  tools?: Tool[];
  /** Deployment override; defaults to the client's configured deployment. */
  model?: string;
}

// --- wire shapes ------------------------------------------------------------

/**
 * One item on the Responses `input`/`output` timeline. Deliberately open-ended: the
 * deployment may return item types this build has never seen, and the contract is to
 * carry them back verbatim rather than to understand them.
 */
type ResponseItem = Record<string, unknown>;

interface ResponsesBody {
  status?: unknown;
  error?: unknown;
  output?: unknown;
  /** `{ input_tokens, output_tokens, total_tokens }` in practice — read tolerantly. */
  usage?: unknown;
}

/** What a session has been billed for so far. Plain counters, no wire types. */
interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  requests: number;
}

// --- client -----------------------------------------------------------------

/**
 * Holds the resolved connection. Cheap by design — there is no process to spawn and
 * no handshake — but kept as an explicit lifecycle so call sites that used the SDK's
 * client (start once, share across sessions, stop on quit) don't have to change.
 */
export class FoundryClient {
  private config: FoundryConfig | null = null;

  /** Resolve the connection, or throw the "not configured" contract error. */
  async start(): Promise<void> {
    if (this.config) return;
    const loaded = loadFoundryConfig();
    if (!loaded) throw new Error(FOUNDRY_NOT_CONFIGURED_ERROR);
    this.config = loaded.config;
    // Never log the key — endpoint, deployment and source only.
    log.info(
      `ready · ${loaded.config.endpoint} · deployment ${loaded.config.deployment} (from ${loaded.source})`,
    );
  }

  /** The active deployment. Only meaningful after {@link start}. */
  get deployment(): string {
    if (!this.config) throw new Error("The Azure AI Foundry client has not been started.");
    return this.config.deployment;
  }

  /** Auto-starts, so callers can create a session without a separate start step. */
  async createSession(options: SessionOptions): Promise<FoundrySession> {
    await this.start();
    const config = this.config;
    if (!config) throw new Error(FOUNDRY_NOT_CONFIGURED_ERROR);
    return new FoundrySession(config, options);
  }

  /** Forget the connection so the next start picks up re-saved settings. */
  async stop(): Promise<void> {
    this.config = null;
  }
}

// --- session ----------------------------------------------------------------

/**
 * One conversation. Owns its item history, runs one turn at a time, and executes tool
 * calls in process. History survives across turns so the feedback loop stays in the same
 * conversation; a failed turn is rolled back so it can't corrupt it.
 */
export class FoundrySession {
  private readonly config: FoundryConfig;
  private readonly tools: Tool[];
  private readonly toolsByName: Map<string, Tool>;
  private readonly model: string;
  private readonly instructions: string;
  /** The `input` timeline: our items plus every output item echoed back verbatim. */
  private readonly items: ResponseItem[] = [];
  /** Cleared for the session's lifetime if the deployment rejects the include value. */
  private includeReasoning = true;
  /** Non-null exactly while a turn is in flight (the single-flight latch). */
  private controller: AbortController | null = null;
  private closed = false;
  /** Running token totals across every request of every turn. Never reset. */
  private readonly totals: UsageTotals = { inputTokens: 0, outputTokens: 0, requests: 0 };

  constructor(config: FoundryConfig, options: SessionOptions) {
    this.config = config;
    this.tools = options.tools ?? [];
    this.toolsByName = new Map(this.tools.map((t) => [t.name, t]));
    this.model = options.model?.trim() || config.deployment;
    this.instructions = options.instructions?.trim() ?? "";
  }

  /**
   * Tokens this session has been billed for, summed over **every** request of every
   * turn — a tool loop that took six rounds counts all six. A turn that failed and was
   * rolled back still counts too: the history is undone, the spend is not. Deployments
   * that omit `usage` simply contribute nothing, so a zero here means "not reported",
   * not "free".
   *
   * Returns a copy: callers (the eval harness reads it per scenario run) must not be
   * able to mutate the session's counters, and a snapshot must not drift underneath
   * them while a turn is running.
   */
  get usage(): { inputTokens: number; outputTokens: number; requests: number } {
    return { ...this.totals };
  }

  /**
   * Send one user prompt and run the tool loop until the model answers without
   * calling tools. Resolves with the final assistant text.
   *
   * On **any** failure the history is rolled back to its pre-prompt length. Without
   * that, a timed-out round can strand a `function_call` item with no matching
   * `function_call_output`, and the API rejects (HTTP 400) every later request in the
   * conversation — which would break "analysis times out → user sends feedback → same
   * session".
   */
  async sendAndWait(prompt: string, timeoutMs: number): Promise<string> {
    if (this.closed) throw new Error("This agent session has been closed.");
    if (this.controller) throw new Error("A turn is already running in this session.");

    const historyLength = this.items.length;
    this.items.push(userMessage([{ type: "input_text", text: prompt }]));

    const controller = new AbortController();
    this.controller = controller;
    const timer = setTimeout(
      () => controller.abort(new Error(`The agent turn timed out after ${Math.round(timeoutMs / 1000)}s.`)),
      timeoutMs,
    );

    let completed = false;
    try {
      const text = await this.runTurn(controller.signal);
      completed = true;
      return text;
    } catch (err) {
      // A timeout or abort surfaces as whatever the in-flight primitive threw
      // (fetch's own AbortError, say) — replace it with the reason we aborted for.
      if (controller.signal.aborted) throw abortReason(controller.signal);
      throw err;
    } finally {
      clearTimeout(timer);
      this.controller = null;
      if (!completed) this.items.length = historyLength;
    }
  }

  /** Cancel the in-flight turn. A silent no-op when the session is idle. */
  async abort(): Promise<void> {
    this.controller?.abort(new Error("The agent turn was canceled."));
  }

  /** Abort, then close the session forever. Idempotent. */
  async disconnect(): Promise<void> {
    if (this.closed) return;
    await this.abort();
    this.closed = true;
  }

  // --- internals ------------------------------------------------------------

  private async runTurn(signal: AbortSignal): Promise<string> {
    for (let round = 0; round < MAX_ROUNDS_PER_TURN; round++) {
      const output = await this.requestResponse(signal);
      // Echo every output item back into the history verbatim: `store: false` makes each
      // request stateless, so the model only sees its own messages, function calls and
      // (opaque) reasoning items if we send them again.
      for (const item of output) this.items.push(item);

      const calls = output.filter((item) => item.type === "function_call");
      if (calls.length === 0) return outputText(output);

      const imageMessages = await this.runToolCalls(calls);
      // Only now, once every call_id has its output, may other items follow.
      for (const imageMessage of imageMessages) this.items.push(imageMessage);
    }
    throw new Error(`The agent exceeded ${MAX_ROUNDS_PER_TURN} tool rounds in one turn.`);
  }

  /**
   * Run one round's tool calls sequentially, appending a `function_call_output` item per
   * call. Every failure mode answers *in band* — an unknown tool, unparseable arguments,
   * or a throwing handler become tool output the model can recover from, because dropping
   * a reply would invalidate the whole conversation.
   *
   * Returns the image-carrying user messages for the caller to append **after** all
   * `function_call_output` items of the round.
   */
  private async runToolCalls(calls: ResponseItem[]): Promise<ResponseItem[]> {
    const imageMessages: ResponseItem[] = [];
    for (const call of calls) {
      const callId = callIdOf(call);
      const name = typeof call.name === "string" ? call.name : "";
      const tool = this.toolsByName.get(name);
      if (!tool) {
        this.reply(callId, `Unknown tool "${name}". Available tools: ${this.toolNames()}.`);
        continue;
      }

      let args: unknown;
      const rawArgs = call.arguments;
      if (isRecord(rawArgs)) {
        // Tolerated drift: some surfaces hand back an already-parsed object.
        args = rawArgs;
      } else {
        const text = typeof rawArgs === "string" ? rawArgs : "";
        try {
          args = text.trim() ? JSON.parse(text) : {};
        } catch (err) {
          this.reply(
            callId,
            `Could not parse the arguments for ${name} as JSON (${msg(err)}). ` +
              `Call ${name} again with a valid JSON object as its arguments.`,
          );
          continue;
        }
      }

      let result: ToolResult;
      try {
        result = await tool.handler(args);
      } catch (err) {
        const text = `Tool ${name} failed: ${msg(err)}`;
        log.warn(text);
        this.reply(callId, text);
        continue;
      }

      const object: ToolResultObject =
        typeof result === "string" ? { textResultForLlm: result } : result;
      const text = object.textResultForLlm ?? "";
      this.reply(callId, object.resultType === "failure" ? `Tool failed: ${text}` : text);

      const images = object.binaryResultsForLlm ?? [];
      if (images.length) imageMessages.push(imageUserMessage(name, images));
    }
    return imageMessages;
  }

  private reply(callId: string, output: string): void {
    this.items.push({ type: "function_call_output", call_id: callId, output });
  }

  private toolNames(): string {
    return this.tools.map((t) => t.name).join(", ") || "(none)";
  }

  /** One POST (with retries) plus response validation; returns the output items. */
  private async requestResponse(signal: AbortSignal): Promise<ResponseItem[]> {
    const response = await this.post(signal);
    let data: ResponsesBody;
    try {
      data = (await response.json()) as ResponsesBody;
    } catch {
      throw new Error("Azure AI Foundry returned a response that could not be read as JSON.");
    }
    // Before the error check: a response we could read was a request the deployment
    // charged for, whether or not the turn goes on to succeed.
    this.countUsage(data?.usage);
    // A 200 can still carry a failure (`status: "failed"` + `error`).
    if (data?.error) throw new Error(responseErrorMessage(data.error));
    const output = Array.isArray(data?.output) ? data.output.filter(isRecord) : [];
    if (output.length === 0) throw new Error("Azure AI Foundry returned no output.");
    return output;
  }

  /**
   * Fold one response's `usage` into the session totals. Accounting must never break a
   * turn, so every unknown shape degrades to zero rather than throwing: a missing
   * object, a partial one (input but no output), or numbers of the wrong type all just
   * add nothing, and extra fields (`total_tokens`, per-modality breakdowns) are ignored
   * because they are derivable or not ours to interpret.
   */
  private countUsage(usage: unknown): void {
    this.totals.requests += 1;
    if (!isRecord(usage)) return;
    this.totals.inputTokens += tokenCount(usage.input_tokens);
    this.totals.outputTokens += tokenCount(usage.output_tokens);
  }

  /**
   * The Responses route. `apiVersion` is an escape hatch that pins the surface version;
   * it stays on the same path (the legacy `/openai/deployments/...` route has no
   * `responses` operation).
   */
  private requestUrl(): string {
    const { endpoint, apiVersion } = this.config;
    const url = `${endpoint}/openai/v1/responses`;
    return apiVersion ? `${url}?api-version=${encodeURIComponent(apiVersion)}` : url;
  }

  /**
   * Only what the contract needs. No `temperature`/`max_tokens`/other sampling
   * knobs — codex-class deployments reject or ignore them; add knobs only if the
   * live smoke test demands them.
   */
  private requestBody(): Record<string, unknown> {
    const body: Record<string, unknown> = { model: this.model };
    if (this.instructions) body.instructions = this.instructions;
    body.input = this.items;
    body.store = false;
    if (this.tools.length) {
      // Flat function tools — the Responses API has no nested `function` object.
      // `strict: false` because these are plain JSON Schemas, not strict-mode-complete.
      body.tools = this.tools.map((t) => ({
        type: "function",
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        strict: false,
      }));
      body.tool_choice = "auto";
      body.parallel_tool_calls = false;
    }
    if (this.includeReasoning) body.include = [REASONING_INCLUDE];
    return body;
  }

  private async post(signal: AbortSignal): Promise<Response> {
    const headers = { "Content-Type": "application/json", ...authHeaders(this.config) };
    return postWithRetry({
      url: this.requestUrl(),
      endpoint: this.config.endpoint,
      model: this.model,
      signal,
      // Rebuilt per attempt: dropping `include` must change the payload we resend.
      init: () => ({ headers, body: JSON.stringify(this.requestBody()) }),
      // Surface drift: a deployment that does not know `reasoning.encrypted_content`
      // rejects the whole request. Drop the include once and resend, then remember.
      onBadRequest: (detail) => {
        if (!this.includeReasoning || !/include/i.test(detail)) return false;
        log.warn(`the deployment rejected include:["${REASONING_INCLUDE}"]; resending without it.`);
        this.includeReasoning = false;
        return true;
      },
    });
  }
}

// --- helpers ----------------------------------------------------------------

/** A `message` input item with the given parts. */
function userMessage(content: Record<string, unknown>[]): ResponseItem {
  return { type: "message", role: "user", content };
}

/**
 * The vision bridge. `function_call_output` is text-only, so images returned by a tool
 * ride in as a following user message: one `input_text` part naming the source tool and
 * numbering the images, then one `input_image` part per image whose `image_url` is the
 * data URI **as a plain string** (the Responses API does not wrap it in an object).
 */
function imageUserMessage(toolName: string, images: ToolBinaryResult[]): ResponseItem {
  const lines = images.map((img, i) => `${i + 1}. ${img.description ?? "(no description)"}`);
  const parts: Record<string, unknown>[] = [
    { type: "input_text", text: [`Images returned by ${toolName} (in order):`, ...lines].join("\n") },
  ];
  for (const img of images) {
    parts.push({ type: "input_image", image_url: `data:${img.mimeType};base64,${img.data}` });
  }
  return userMessage(parts);
}

/** A reported token count, or 0 for anything that isn't a usable non-negative number. */
function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** `call_id` is what a `function_call_output` must reference; `id` is the fallback. */
function callIdOf(call: ResponseItem): string {
  if (typeof call.call_id === "string" && call.call_id) return call.call_id;
  if (typeof call.id === "string" && call.id) return call.id;
  return "";
}

/**
 * The turn's answer: every `output_text` the model produced, in order. Read loosely —
 * a `content` string, or parts carrying `text`, both count.
 */
function outputText(items: ResponseItem[]): string {
  const texts: string[] = [];
  for (const item of items) {
    if (item.type !== "message") continue;
    const content = item.content;
    if (typeof content === "string") {
      texts.push(content);
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!isRecord(part)) continue;
      if (typeof part.text !== "string") continue;
      if (part.type === undefined || part.type === "output_text" || part.type === "text") {
        texts.push(part.text);
      }
    }
  }
  return texts.join("");
}

/** Pull a user-facing message out of a response-level `error` of unknown shape. */
function responseErrorMessage(error: unknown): string {
  if (typeof error === "string" && error.trim()) return error.trim();
  if (isRecord(error)) {
    const message = error.message;
    if (typeof message === "string" && message.trim()) return message.trim();
    const code = error.code;
    if (typeof code === "string" && code.trim()) return `Azure AI Foundry returned an error: ${code.trim()}`;
  }
  return "Azure AI Foundry returned an error with no details.";
}

// The transport (POST + retry policy), the status→message taxonomy, and the abort
// primitives live in `./http` — `transcribe.ts` fails exactly the same way.
