import {
  FOUNDRY_NOT_CONFIGURED_ERROR,
  type FoundryConfig,
} from "../../common/foundry";
import { createLogger } from "../logger";
import { loadFoundryConfig } from "./config";

/**
 * A minimal agent runtime over the Azure AI Foundry (Azure OpenAI) chat-completions
 * API: one client that resolves the connection, sessions that own a conversation,
 * and a tool loop that runs our in-process tools until the model stops calling them.
 *
 * The public surface deliberately mirrors the Copilot SDK's
 * (`start`/`createSession`/`sendAndWait`/`abort`/`disconnect`/`stop`) and its `Tool`
 * contract, so the existing `tools.ts` files and their call sites move over by
 * changing an import line.
 *
 * Built on Node's global `fetch` — **no new npm dependency** — and free of any
 * `electron` import so the eval harness can load it outside the app.
 *
 * Non-goals, deliberately deferred:
 * - **Streaming.** Nothing consumes token deltas; progress comes from tool callbacks.
 * - **History trimming/compaction.** Turns are already bounded (≤500 event rows per
 *   `get_events`, ≤6 images per `get_frames`, and the 32-round cap below).
 * - **Parallel tool execution.** Handlers share mutable in-process state (the frame
 *   extractor), so calls run sequentially in the order the model asked for them.
 * - **Entra ID auth.** Key auth only.
 */

const log = createLogger("Foundry");

/** Hard stop on a runaway tool loop inside a single turn. */
const MAX_ROUNDS_PER_TURN = 32;

/** Statuses worth retrying — throttling and transient gateway failures. */
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

/** Total attempts per request (1 initial + 2 retries). */
const MAX_ATTEMPTS = 3;

/** Backoff before attempt n+1, indexed by the attempt that just failed. */
const BACKOFF_MS = [1_000, 2_000];

/** Never honor a `Retry-After` longer than this — the turn has its own deadline. */
const MAX_RETRY_AFTER_MS = 30_000;

const msg = (err: unknown) => (err instanceof Error ? err.message : String(err));

// --- tool contract (drop-in for the Copilot SDK's) --------------------------

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
  /** Seeded as the conversation's system message. */
  instructions?: string;
  tools?: Tool[];
  /** Deployment override; defaults to the client's configured deployment. */
  model?: string;
}

// --- wire shapes ------------------------------------------------------------

interface ChatTextPart {
  type: "text";
  text: string;
}

interface ChatImagePart {
  type: "image_url";
  image_url: { url: string };
}

type ChatContentPart = ChatTextPart | ChatImagePart;

interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ChatContentPart[] | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
}

interface ChatResponseMessage {
  role?: string;
  content?: string | null;
  tool_calls?: ChatToolCall[];
}

interface ChatCompletionResponse {
  choices?: { message?: ChatResponseMessage }[];
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
 * One conversation. Owns its message history, runs one turn at a time, and executes
 * tool calls in process. History survives across turns so the feedback loop stays in
 * the same conversation; a failed turn is rolled back so it can't corrupt it.
 */
export class FoundrySession {
  private readonly config: FoundryConfig;
  private readonly tools: Tool[];
  private readonly toolsByName: Map<string, Tool>;
  private readonly model: string;
  private readonly messages: ChatMessage[] = [];
  /** Non-null exactly while a turn is in flight (the single-flight latch). */
  private controller: AbortController | null = null;
  private closed = false;

  constructor(config: FoundryConfig, options: SessionOptions) {
    this.config = config;
    this.tools = options.tools ?? [];
    this.toolsByName = new Map(this.tools.map((t) => [t.name, t]));
    this.model = options.model?.trim() || config.deployment;
    const instructions = options.instructions?.trim();
    if (instructions) this.messages.push({ role: "system", content: instructions });
  }

  /**
   * Send one user prompt and run the tool loop until the model answers without
   * calling tools. Resolves with the final assistant text.
   *
   * On **any** failure the history is rolled back to its pre-prompt length. Without
   * that, a timed-out round can strand an assistant `tool_calls` message with no
   * matching `role:"tool"` replies, and the API rejects (HTTP 400) every later
   * request in the conversation — which would break "analysis times out → user
   * sends feedback → same session".
   */
  async sendAndWait(prompt: string, timeoutMs: number): Promise<string> {
    if (this.closed) throw new Error("This agent session has been closed.");
    if (this.controller) throw new Error("A turn is already running in this session.");

    const historyLength = this.messages.length;
    this.messages.push({ role: "user", content: prompt });

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
      if (!completed) this.messages.length = historyLength;
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
      const message = await this.requestCompletion(signal);
      const toolCalls = message.tool_calls ?? [];
      // Echo the assistant message back into the history verbatim: the wire format
      // requires the `tool_calls` we are about to answer to be present.
      this.messages.push({
        role: "assistant",
        content: message.content ?? null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
      if (toolCalls.length === 0) return message.content ?? "";
      const imageMessages = await this.runToolCalls(toolCalls);
      // Only now, once every tool_call_id has its reply, may other messages follow.
      for (const imageMessage of imageMessages) this.messages.push(imageMessage);
    }
    throw new Error(`The agent exceeded ${MAX_ROUNDS_PER_TURN} tool rounds in one turn.`);
  }

  /**
   * Run one round's tool calls sequentially, appending a `role:"tool"` message per
   * call. Every failure mode answers *in band* — an unknown tool, unparseable
   * arguments, or a throwing handler become tool content the model can recover from,
   * because dropping a reply would invalidate the whole conversation.
   *
   * Returns the image-carrying user messages for the caller to append **after** all
   * tool messages of the round.
   */
  private async runToolCalls(calls: ChatToolCall[]): Promise<ChatMessage[]> {
    const imageMessages: ChatMessage[] = [];
    for (const call of calls) {
      const name = call.function?.name ?? "";
      const tool = this.toolsByName.get(name);
      if (!tool) {
        this.reply(call, `Unknown tool "${name}". Available tools: ${this.toolNames()}.`);
        continue;
      }

      let args: unknown;
      const rawArgs = call.function?.arguments ?? "";
      try {
        args = rawArgs.trim() ? JSON.parse(rawArgs) : {};
      } catch (err) {
        this.reply(
          call,
          `Could not parse the arguments for ${name} as JSON (${msg(err)}). ` +
            `Call ${name} again with a valid JSON object as its arguments.`,
        );
        continue;
      }

      let result: ToolResult;
      try {
        result = await tool.handler(args);
      } catch (err) {
        const text = `Tool ${name} failed: ${msg(err)}`;
        log.warn(text);
        this.reply(call, text);
        continue;
      }

      const object: ToolResultObject =
        typeof result === "string" ? { textResultForLlm: result } : result;
      const text = object.textResultForLlm ?? "";
      this.reply(call, object.resultType === "failure" ? `Tool failed: ${text}` : text);

      const images = object.binaryResultsForLlm ?? [];
      if (images.length) imageMessages.push(imageUserMessage(name, images));
    }
    return imageMessages;
  }

  private reply(call: ChatToolCall, content: string): void {
    this.messages.push({ role: "tool", tool_call_id: call.id, content });
  }

  private toolNames(): string {
    return this.tools.map((t) => t.name).join(", ") || "(none)";
  }

  /** One POST (with retries) plus response validation. */
  private async requestCompletion(signal: AbortSignal): Promise<ChatResponseMessage> {
    const response = await this.post(this.requestBody(), signal);
    let data: ChatCompletionResponse;
    try {
      data = (await response.json()) as ChatCompletionResponse;
    } catch {
      throw new Error("Azure AI Foundry returned a response that could not be read as JSON.");
    }
    const message = data?.choices?.[0]?.message;
    if (!message) throw new Error("Azure AI Foundry returned no completion choices.");
    return message;
  }

  /**
   * Default route is the modern `/openai/v1` surface (deployment travels in the
   * body); an explicitly configured `apiVersion` switches to the legacy data-plane
   * route, which encodes the deployment in the path instead.
   */
  private requestUrl(): string {
    const { endpoint, apiVersion } = this.config;
    if (apiVersion) {
      return (
        `${endpoint}/openai/deployments/${encodeURIComponent(this.model)}/chat/completions` +
        `?api-version=${encodeURIComponent(apiVersion)}`
      );
    }
    return `${endpoint}/openai/v1/chat/completions`;
  }

  /**
   * Only what the contract needs. No `temperature`/`max_tokens`/other sampling
   * knobs — codex-class deployments reject or ignore them; add knobs only if the
   * live smoke test demands them.
   */
  private requestBody(): Record<string, unknown> {
    const body: Record<string, unknown> = { messages: this.messages };
    if (!this.config.apiVersion) body.model = this.model;
    if (this.tools.length) {
      body.tools = this.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      body.tool_choice = "auto";
    }
    return body;
  }

  private async post(body: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
    const url = this.requestUrl();
    // Both auth headers: the Azure OpenAI data plane reads `api-key`, the newer
    // Foundry surface reads the bearer token, and the two are the same key.
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "api-key": this.config.apiKey,
      Authorization: `Bearer ${this.config.apiKey}`,
    };
    const payload = JSON.stringify(body);

    for (let attempt = 1; ; attempt++) {
      let response: Response;
      try {
        response = await fetch(url, { method: "POST", headers, body: payload, signal });
      } catch (err) {
        // An abort is not a network problem — let sendAndWait map it to its reason.
        if (signal.aborted) throw err;
        log.warn(`request to ${this.config.endpoint} failed:`, msg(err));
        throw new Error(
          `Could not reach ${this.config.endpoint}. Check your network and the endpoint URL.`,
        );
      }
      if (response.ok) return response;
      if (RETRYABLE_STATUS.has(response.status) && attempt < MAX_ATTEMPTS) {
        log.warn(`HTTP ${response.status} from Azure AI Foundry; retrying (attempt ${attempt + 1}/${MAX_ATTEMPTS}).`);
        await delay(retryDelayMs(response, attempt), signal);
        continue;
      }
      throw await httpError(response, this.model);
    }
  }
}

// --- helpers ----------------------------------------------------------------

/**
 * The vision bridge. Tool messages are text-only on this API, so images returned by
 * a tool ride in as a following user message: one text part naming the source tool
 * and numbering the images, then one `image_url` part per image as a data URI.
 */
function imageUserMessage(toolName: string, images: ToolBinaryResult[]): ChatMessage {
  const lines = images.map((img, i) => `${i + 1}. ${img.description ?? "(no description)"}`);
  const parts: ChatContentPart[] = [
    { type: "text", text: [`Images returned by ${toolName} (in order):`, ...lines].join("\n") },
  ];
  for (const img of images) {
    parts.push({ type: "image_url", image_url: { url: `data:${img.mimeType};base64,${img.data}` } });
  }
  return { role: "user", content: parts };
}

/** The Error an aborted turn should surface (timeout message, or the cancel one). */
function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error("The agent turn was canceled.");
}

/** Sleep that rejects promptly when the turn is aborted mid-backoff. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Honor a numeric `Retry-After` (capped), else the fixed 1s/2s backoff. */
function retryDelayMs(response: Response, attempt: number): number {
  const header = response.headers?.get("retry-after");
  if (header) {
    const seconds = Number(header.trim());
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1_000, MAX_RETRY_AFTER_MS);
    }
  }
  return BACKOFF_MS[attempt - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1];
}

/**
 * Map a failed response to a user-facing message — these land in UI banners
 * verbatim, so they name the fix, not the stack. The API key appears in none of
 * them (the detail comes from the server's own body).
 */
async function httpError(response: Response, model: string): Promise<Error> {
  const detail = await errorDetail(response);
  const suffix = detail ? ` ${detail}` : "";
  if (response.status === 401 || response.status === 403) {
    return new Error(
      `Azure AI Foundry rejected the API key (HTTP ${response.status}). Check the connection settings.${suffix}`,
    );
  }
  if (response.status === 404) {
    return new Error(
      `Azure AI Foundry could not find the "${model}" deployment (HTTP 404). Check the endpoint and deployment name.${suffix}`,
    );
  }
  if (response.status === 429) {
    return new Error("Azure AI Foundry is rate-limiting requests (HTTP 429). Try again in a moment.");
  }
  return new Error(
    `Azure AI Foundry request failed (HTTP ${response.status}): ${detail || response.statusText || "no details"}`,
  );
}

/** `error.message` from a JSON body, else the first 300 characters of it. */
async function errorDetail(response: Response): Promise<string> {
  let text = "";
  try {
    text = await response.text();
  } catch {
    return "";
  }
  if (!text.trim()) return "";
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } };
    const message = parsed?.error?.message;
    if (typeof message === "string" && message.trim()) return message.trim();
  } catch {
    // Not JSON — fall through to the raw prefix.
  }
  return text.slice(0, 300);
}
