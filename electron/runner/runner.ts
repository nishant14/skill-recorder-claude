import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { FoundryClient, type FoundrySession, type Tool } from "../foundry/agent";
import { createLogger } from "../logger";
import { compileAllowlist, type CompiledAllowlist } from "./allowlist";
import { findInstalledSkill, type InstalledSkill } from "./library";
import {
  createExecutionTools,
  runsRoot,
  type AskGate,
  type ConfirmDecision,
  type ConfirmGate,
  type ExecutionToolsContext,
} from "./tools";

/**
 * Runs an installed skill: one {@link FoundrySession} turn over the execution toolset,
 * with the skill's own SKILL.md as the instructions and the user watching.
 *
 * Follows the `Describer` / `AgentBuilder` register — one shared {@link FoundryClient},
 * a progress callback, `cancel`, `dispose` — with one deliberate difference: **exactly
 * one run at a time, globally**. A skill run types on the user's real machine, so two
 * of them interleaving approvals would be unreviewable; a second `run()` is refused.
 *
 * What this class owns beyond the turn:
 * - **The transcript.** Every event (`model`, `tool-call`, `tool-result`,
 *   `confirm-request`, `confirm-decision`, `user-input`, `error`, `done`) is appended to
 *   `~/.skill-recorder/runs/<skill>/<timestamp>.json` *as it happens*, so a crashed or
 *   canceled run still leaves a record of what it did to the machine.
 * - **Redaction.** Everything persisted or streamed goes through {@link redactEntry}
 *   first. Today that covers the values of `runner.json.headers` (where API credentials
 *   live); Workstream H-b widens it. The Foundry key never gets this far — it is
 *   scrubbed out of the child environment in `tools.ts` and never enters a tool result.
 * - **The gates.** `interactive` relays confirmations to the UI (wired in H-c);
 *   `auto-approve` — the smoke/eval path only — approves silently but still records
 *   every decision, so an unattended run is as auditable as a watched one.
 *
 * Electron-free, so the smoke script and the unit tests can drive it headlessly.
 */

const log = createLogger("SkillRunner");

/** One run is one turn; a real skill can take many tool rounds to finish. */
const TURN_TIMEOUT_MS = 15 * 60_000;
/** Executing a skill is a longer tool chain than building one (agent default is 32). */
const MAX_ROUNDS_PER_TURN = 64;
/**
 * How long an interactive wait (a confirmation, an `ask_user` question) may sit
 * unanswered before it resolves *in band*. Enforced here rather than in the UI so a
 * user who walked away — or a renderer that never answered — degrades the run into a
 * report instead of holding the turn open until the 15-minute deadline kills it.
 */
const INTERACTIVE_TIMEOUT_MS = 3 * 60_000;
/** What a redacted secret looks like everywhere it would otherwise appear. */
export const REDACTED = "«redacted»";

const RUNNER_INSTRUCTIONS = [
  "You are executing an installed skill on the user's own computer, on their behalf, right now.",
  "",
  "- Follow the skill's steps below in order. It is a procedure, not a suggestion.",
  "- Use only the tools you have been given. You cannot see the screen and you cannot",
  "  click anything: everything happens through these tools.",
  "- Every side effect (running a command, writing a file) is shown to the user for",
  "  approval first. A denial is an instruction, not an error — skip that step or find",
  "  another way, and keep going.",
  "- If a step needs information the skill does not carry, ask for it with ask_user.",
  "- Never print, echo, or ask for credentials, and never try to read this app's own",
  "  settings.",
  "- When you are done (or blocked), stop calling tools and reply with a short",
  "  plain-language report of what you actually did, what you changed, and anything the",
  "  user still needs to do.",
].join("\n");

const KICKOFF_PROMPT = "Run this skill now.";

const msg = (err: unknown) => (err instanceof Error ? err.message : String(err));

export type RunPolicy = "interactive" | "auto-approve";

export type TranscriptEntryType =
  | "model"
  | "tool-call"
  | "tool-result"
  | "confirm-request"
  | "confirm-decision"
  | "user-input"
  | "error"
  | "done";

/** One line of the run record. Deliberately flat — the UI renders it as a list. */
export interface TranscriptEntry {
  type: TranscriptEntryType;
  /** Epoch ms. */
  at: number;
  /** Tool or confirmation kind, when the entry is about one. */
  name?: string;
  /** The human-readable half: model text, tool output, question, error message. */
  text?: string;
  /** Full detail behind a confirmation (the command, the path + preview). */
  detail?: string;
  /** A tool call's parsed arguments. */
  args?: unknown;
  decision?: ConfirmDecision;
  /** True when the tool reported failure (the model still sees the text). */
  failed?: boolean;
}

export interface RunProgress {
  runId: string;
  skillName: string;
  phase: "start" | "working" | "confirm" | "done" | "error";
  message: string;
  entry?: TranscriptEntry;
}

/** The persisted document — a whole run in one JSON file. */
export interface RunTranscript {
  version: 1;
  runId: string;
  skill: string;
  skillDir: string;
  policy: RunPolicy;
  startedAt: number;
  finishedAt: number | null;
  status: "running" | "done" | "canceled" | "error";
  entries: TranscriptEntry[];
}

export interface RunInput {
  /** Frontmatter name or folder name of an installed skill. */
  name: string;
  /** Optional free text from the user, appended to the kickoff prompt. */
  input?: string;
  policy: RunPolicy;
}

export interface RunResult {
  runId: string;
  skillName: string;
  /** The model's closing report. */
  summary: string;
  /** Absolute path of the persisted transcript. */
  transcriptFile: string;
}

/** Injected seams. The app passes the UI gates (H-c); tests pass fakes. */
export interface SkillRunnerSeams {
  /** Interactive gates for a run. Without them, an interactive run cannot prompt. */
  gates?: (ctx: { runId: string; skillName: string }) => { confirm: ConfirmGate; ask: AskGate };
  /** Test seams handed straight to `createExecutionTools`. */
  tools?: Pick<ExecutionToolsContext, "runShell" | "fetchImpl" | "homeDir">;
  /** Test seam: shorten the interactive wait deadline. */
  interactiveTimeoutMs?: number;
}

interface ActiveRun {
  runId: string;
  skill: InstalledSkill;
  allowlist: CompiledAllowlist;
  session: FoundrySession | null;
  doc: RunTranscript;
  file: string;
  /** Literal strings that must never appear in the transcript or a progress event. */
  secrets: string[];
  canceled: boolean;
}

/** Replace every known secret inside a string. Substring-based: a header value can be
 *  echoed back inside a larger body, and half a credential is still a credential. */
function redactString(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join(REDACTED);
  }
  return out;
}

function redactValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return redactString(value, secrets);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, secrets));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactValue(v, secrets);
    }
    return out;
  }
  return value;
}

/**
 * The single choke point every transcript entry and progress event passes through.
 * H-b extends the secret set; the *shape* — one function, one call site — is what
 * keeps a later widening from missing a path.
 */
export function redactEntry(entry: TranscriptEntry, secrets: readonly string[]): TranscriptEntry {
  if (secrets.length === 0) return entry;
  return {
    ...entry,
    ...(entry.text === undefined ? {} : { text: redactString(entry.text, secrets) }),
    ...(entry.detail === undefined ? {} : { detail: redactString(entry.detail, secrets) }),
    ...(entry.args === undefined ? {} : { args: redactValue(entry.args, secrets) }),
  };
}

/**
 * Resolve `work`, or `fallback` once the deadline passes. The timer is always cleared,
 * so an answered prompt leaves nothing pending behind it.
 */
async function withDeadline<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Credential-bearing literals this skill carries: the values of `runner.json.headers`. */
function secretsOf(skill: InstalledSkill): string[] {
  const headers = skill.runnerConfig?.headers ?? {};
  return Object.values(headers).filter((v) => typeof v === "string" && v.length >= 4);
}

/** A single, safe path segment for a skill name that reached us off disk. */
function safeSegment(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|-+$/g, "").slice(0, 60) || "skill";
}

/** ISO 8601 with the characters Windows forbids in a filename swapped for dashes. */
function timestampSegment(at: number): string {
  return new Date(at).toISOString().replace(/[:.]/g, "-");
}

export class SkillRunner {
  private client: FoundryClient | null = null;
  private clientStart: Promise<FoundryClient> | null = null;
  private model: string | undefined;
  private active: ActiveRun | null = null;

  constructor(
    private readonly emitProgress: (progress: RunProgress) => void,
    private readonly seams: SkillRunnerSeams = {},
  ) {}

  /** True while a run is in flight (there is at most one, app-wide). */
  isRunning(): boolean {
    return this.active !== null;
  }

  /**
   * Execute one installed skill and resolve with the model's closing report. Rejects
   * with a user-facing message — these strings reach the run panel verbatim.
   */
  async run(input: RunInput): Promise<RunResult> {
    if (this.active) throw new Error("A skill is already running.");

    const skill = findInstalledSkill(input.name);
    if (!skill) throw new Error(`No installed skill named "${input.name}".`);

    const startedAt = Date.now();
    const runId = `${safeSegment(skill.name)}-${timestampSegment(startedAt)}`;
    const file = path.join(runsRoot(), safeSegment(skill.name), `${timestampSegment(startedAt)}.json`);
    const run: ActiveRun = {
      runId,
      skill,
      allowlist: compileAllowlist(skill.allowedTools),
      session: null,
      file,
      secrets: secretsOf(skill),
      canceled: false,
      doc: {
        version: 1,
        runId,
        skill: skill.name,
        skillDir: skill.dir,
        policy: input.policy,
        startedAt,
        finishedAt: null,
        status: "running",
        entries: [],
      },
    };
    this.active = run;

    try {
      this.emit(run, "start", `Running ${skill.name}…`);
      const tools = this.buildTools(run, input.policy);
      const client = await this.ensureClient();
      const session = await client.createSession({
        instructions: `${RUNNER_INSTRUCTIONS}\n\n---\n\n${skill.body}`,
        tools,
        maxRoundsPerTurn: MAX_ROUNDS_PER_TURN,
        ...(this.model ? { model: this.model } : {}),
      });
      run.session = session;
      // A cancel can land while the client is still starting (that is a network hop),
      // and it must not start a turn nobody is waiting for any more.
      if (run.canceled) throw new Error("The skill run was canceled.");

      const prompt = input.input?.trim()
        ? `${KICKOFF_PROMPT}\n\nThe user added this input:\n${input.input.trim()}`
        : KICKOFF_PROMPT;

      let summary: string;
      try {
        summary = await session.sendAndWait(prompt, TURN_TIMEOUT_MS);
      } catch (err) {
        // Don't leave the turn running past our deadline or the user's cancel.
        await session.abort().catch(() => undefined);
        throw run.canceled ? new Error("The skill run was canceled.") : new Error(`Skill run failed: ${msg(err)}`);
      } finally {
        await session.disconnect().catch(() => undefined);
      }

      const text = summary.trim() || "(the skill finished without a report)";
      this.append(run, { type: "model", at: Date.now(), text }, "working");
      run.doc.status = "done";
      this.append(run, { type: "done", at: Date.now(), text }, "done");
      this.finish(run);
      return { runId, skillName: skill.name, summary: text, transcriptFile: file };
    } catch (err) {
      const message = msg(err);
      run.doc.status = run.canceled ? "canceled" : "error";
      this.append(run, { type: "error", at: Date.now(), text: message }, "error");
      this.finish(run);
      throw err instanceof Error ? err : new Error(message);
    } finally {
      this.active = null;
    }
  }

  /**
   * Cancel the active run. A `runId` that isn't the active one — a stale button in the
   * UI — is a silent no-op rather than an error.
   */
  async cancel(runId?: string): Promise<void> {
    const run = this.active;
    if (!run) return;
    if (runId && runId !== run.runId) return;
    run.canceled = true;
    await run.session?.abort().catch(() => undefined);
  }

  /** Tear down the shared client (called on app quit). */
  async dispose(): Promise<void> {
    await this.cancel().catch(() => undefined);
    if (this.client) await this.client.stop().catch(() => undefined);
    this.client = null;
    this.clientStart = null;
  }

  // --- internals ------------------------------------------------------------

  private async ensureClient(): Promise<FoundryClient> {
    if (this.client) return this.client;
    if (this.clientStart) return this.clientStart;
    this.clientStart = (async () => {
      const client = new FoundryClient();
      await client.start();
      // The main deployment: executing a skill is agentic tool work, which is the codex
      // model's task shape. `SKILL_RECORDER_MODEL` still wins (the evals' --model flag).
      this.model = process.env.SKILL_RECORDER_MODEL || undefined;
      // Never log the key — the deployment is all that identifies the connection.
      log.info(`Foundry ready · deployment ${this.model ?? client.deployment}`);
      this.client = client;
      return client;
    })();
    try {
      return await this.clientStart;
    } catch (err) {
      this.clientStart = null;
      throw err;
    }
  }

  /** The execution toolset, wrapped so every call and result lands in the transcript. */
  private buildTools(run: ActiveRun, policy: RunPolicy): Tool[] {
    const gates = this.gatesFor(run, policy);
    const tools = createExecutionTools({
      allowlist: run.allowlist,
      confirm: gates.confirm,
      ask: gates.ask,
      ...(this.seams.tools ?? {}),
    });
    return tools.map((tool) => this.instrument(run, tool));
  }

  private instrument(run: ActiveRun, tool: Tool): Tool {
    return {
      ...tool,
      handler: async (args) => {
        this.append(run, { type: "tool-call", at: Date.now(), name: tool.name, args }, "working");
        try {
          const result = await tool.handler(args);
          const object = typeof result === "string" ? { textResultForLlm: result } : result;
          this.append(
            run,
            {
              type: "tool-result",
              at: Date.now(),
              name: tool.name,
              text: object.textResultForLlm ?? "",
              ...(object.resultType === "failure" ? { failed: true } : {}),
            },
            "working",
          );
          return result;
        } catch (err) {
          // The agent answers a throwing handler in band; the transcript must still
          // show that the tool blew up rather than silently returning nothing.
          this.append(run, { type: "error", at: Date.now(), name: tool.name, text: msg(err) }, "error");
          throw err;
        }
      },
    };
  }

  /**
   * The confirmation + ask gates for one run. `auto-approve` never prompts (the smoke
   * path has no user) but records the same decisions; `interactive` uses the gates the
   * app wired in, and — with none wired — degrades to the in-band "no response" answer
   * rather than blocking forever.
   */
  private gatesFor(run: ActiveRun, policy: RunPolicy): { confirm: ConfirmGate; ask: AskGate } {
    if (policy === "auto-approve") {
      return this.logged(run, {
        confirm: { request: async () => "approve" },
        ask: { ask: async () => null },
      });
    }
    const wired = this.seams.gates?.({ runId: run.runId, skillName: run.skill.name });
    if (wired) return this.logged(run, wired);
    log.warn("no interactive gates are wired — side effects will time out in band.");
    return this.logged(run, {
      confirm: { request: async () => "timeout" },
      ask: { ask: async () => null },
    });
  }

  /** Wrap gates so the request, the decision and the user's answer are all recorded. */
  private logged(run: ActiveRun, gates: { confirm: ConfirmGate; ask: AskGate }): { confirm: ConfirmGate; ask: AskGate } {
    return {
      confirm: {
        request: async (kind, summary, detail) => {
          this.append(
            run,
            { type: "confirm-request", at: Date.now(), name: kind, text: summary, detail },
            "confirm",
          );
          const decision = await withDeadline(
            gates.confirm.request(kind, summary, detail),
            this.seams.interactiveTimeoutMs ?? INTERACTIVE_TIMEOUT_MS,
            "timeout" as ConfirmDecision,
          );
          this.append(
            run,
            { type: "confirm-decision", at: Date.now(), name: kind, decision, text: `${kind}: ${decision}` },
            "working",
          );
          return decision;
        },
      },
      ask: {
        ask: async (question) => {
          this.append(run, { type: "user-input", at: Date.now(), name: "question", text: question }, "confirm");
          const answer = await withDeadline(
            gates.ask.ask(question),
            this.seams.interactiveTimeoutMs ?? INTERACTIVE_TIMEOUT_MS,
            null,
          );
          this.append(
            run,
            {
              type: "user-input",
              at: Date.now(),
              name: "answer",
              text: answer === null ? "(no answer)" : answer,
            },
            "working",
          );
          return answer;
        },
      },
    };
  }

  /**
   * Redact, append, persist, stream — in that order, so nothing unredacted escapes to
   * disk or to the renderer. `phase` is the progress phase this entry streams under.
   */
  private append(run: ActiveRun, entry: TranscriptEntry, phase: RunProgress["phase"]): TranscriptEntry {
    const redacted = redactEntry(entry, run.secrets);
    run.doc.entries.push(redacted);
    this.persist(run);
    this.emitProgress({
      runId: run.runId,
      skillName: run.skill.name,
      phase,
      message: redacted.text ?? redacted.name ?? redacted.type,
      entry: redacted,
    });
    return redacted;
  }

  private finish(run: ActiveRun): void {
    run.doc.finishedAt = Date.now();
    this.persist(run);
  }

  /**
   * Rewrite the whole document. Cheap (a run is tens of entries) and it means the file
   * on disk is always valid JSON, which an append-per-line format would not be if the
   * app died mid-run.
   */
  private persist(run: ActiveRun): void {
    try {
      mkdirSync(path.dirname(run.file), { recursive: true });
      writeFileSync(run.file, JSON.stringify(run.doc, null, 2));
    } catch (err) {
      // A transcript we cannot write must not kill a run that is changing the machine.
      log.warn(`could not write the run transcript: ${msg(err)}`);
    }
  }

  /** A progress event with no transcript entry behind it (run start). */
  private emit(run: ActiveRun, phase: RunProgress["phase"], message: string): void {
    this.emitProgress({ runId: run.runId, skillName: run.skill.name, phase, message });
  }
}
