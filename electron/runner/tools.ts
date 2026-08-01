import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Tool } from "../foundry/agent";
import { foundryConfigFile } from "../foundry/config";
import {
  allowsCapability,
  capabilityRefusal,
  matchesShell,
  shellRefusal,
  type CompiledAllowlist,
} from "./allowlist";

/**
 * The tools a skill run executes with: shell, files, web, and a way to ask the user a
 * question. This is the only place in the app where a model's output turns into a side
 * effect on the machine, so every guard lives here rather than in the caller:
 *
 * - **Home scoping.** Every path is resolved against `os.homedir()` and must land
 *   inside it. Resolution is textual first (`path.resolve` + prefix), then retried
 *   through `realpath` so a symlinked home (or `/var` → `/private/var` on macOS)
 *   is tolerated rather than refused.
 * - **Deny-list.** `~/.skill-recorder/foundry.json` holds the Foundry key and
 *   `~/.skill-recorder/runs` holds run transcripts (which quote tool output): both are
 *   unreadable *and* unwritable, so a skill can neither exfiltrate the key nor rewrite
 *   the record of what it did.
 * - **Env scrub.** Child processes inherit the environment minus every
 *   `AZURE_OPENAI_*` / `FOUNDRY_*` variable, so the key never reaches a command the
 *   model composed.
 * - **Caps.** Output, file, and response sizes are bounded (a `cat` of a 2 GB file must
 *   degrade, not blow up the turn), and both the shell and the network have deadlines.
 * - **Confirmation.** `run_shell` and `write_file` are gated behind a {@link ConfirmGate}
 *   the caller supplies; a denial or an unanswered prompt answers *in band*, because a
 *   run the user walked away from should degrade into a report, not an error.
 *
 * Everything the guards can't do in-process — the shell, `fetch`, the confirmation UI —
 * is an injected seam, which is what lets the whole file be unit-tested offline.
 *
 * `call_api` (the API-grounded half) is Workstream H-b and lives beside these.
 */

/** Per-command wall clock. Long enough for a build, short enough to notice a hang. */
const SHELL_TIMEOUT_MS = 120_000;
/** Combined stdout+stderr handed to the model, in characters. */
const SHELL_OUTPUT_CAP = 20_000;
/** Inline file read cap; a larger file reports its size plus this much of its head. */
const READ_CAP_BYTES = 200 * 1024;
/** A skill writes documents, not disk images. */
const WRITE_CAP_BYTES = 1024 * 1024;
/** Response body cap and deadline for `fetch_url`. */
const FETCH_CAP_BYTES = 200 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

/** The exact in-band answer to a denied side effect. A denial is an instruction. */
export const DECLINED_MESSAGE = "The user declined this action.";
/** The exact in-band answer when an interactive wait timed out. */
export const NO_RESPONSE_MESSAGE = "The user did not respond — skip this action or finish up.";

export type ConfirmDecision = "approve" | "deny" | "timeout";

/** What a side-effecting tool asks before it acts. Implemented by the UI (H-c) and the
 *  auto-approve policy; tests inject a fake. */
export interface ConfirmGate {
  /**
   * @param kind    Tool name, so the UI can group "always allow" by capability.
   * @param summary One line, safe to show in a card title.
   * @param detail  The full thing the user is approving (command, path + preview).
   */
  request(kind: string, summary: string, detail: string): Promise<ConfirmDecision>;
}

/** How `ask_user` reaches the person watching the run. */
export interface AskGate {
  /** Resolves with the user's text, or `null` when the wait timed out. */
  ask(question: string): Promise<string | null>;
}

/** One finished child process. The seam's contract — never a thrown timeout. */
export interface ShellOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ShellSpec {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

export type RunShellFn = (spec: ShellSpec) => Promise<ShellOutcome>;

export interface ExecutionToolsContext {
  /** Compiled `allowed-tools` — the enforcement half. */
  allowlist: CompiledAllowlist;
  confirm: ConfirmGate;
  ask: AskGate;
  /** Test seam: run a child process. Defaults to `child_process.spawn`. */
  runShell?: RunShellFn;
  /** Test seam: the HTTP client. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Test seam: the directory every path is scoped to. Defaults to `os.homedir()`. */
  homeDir?: string;
}

/**
 * Where run transcripts live (`SKILL_RECORDER_RUNS_DIR` overrides, for tests and the
 * smoke). It lives here rather than in the runner because the deny-list is what makes
 * it interesting: the tools must refuse this tree, and a helper the guard can't see
 * would drift away from the guard.
 */
export function runsRoot(): string {
  const override = process.env.SKILL_RECORDER_RUNS_DIR;
  if (override) return path.resolve(override);
  return path.join(os.homedir(), ".skill-recorder", "runs");
}

const msg = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** True when `target` is `root` itself or nested inside it. */
function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function tryRealpath(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * The realpath of a path that may not exist yet: resolve the deepest existing ancestor
 * and re-append what is missing. Needed for `write_file`, whose target is usually new.
 */
function resolvedThroughLinks(target: string): string {
  const direct = tryRealpath(target);
  if (direct) return direct;
  const parent = tryRealpath(path.dirname(target));
  return parent ? path.join(parent, path.basename(target)) : target;
}

/** Every path a skill may never touch, for reads and writes alike. */
function deniedPaths(home: string): string[] {
  const paths = [
    foundryConfigFile(),
    path.join(home, ".skill-recorder", "foundry.json"),
    runsRoot(),
    path.join(home, ".skill-recorder", "runs"),
  ];
  return [...new Set(paths.map((p) => path.resolve(p)))];
}

type PathCheck = { ok: true; path: string } | { ok: false; refusal: string };

/**
 * Resolve a model-supplied path and apply both guards. Relative paths are relative to
 * the home dir, which is also the default cwd — so "notes.txt" means what the model
 * expects it to mean.
 */
function resolvePath(home: string, raw: unknown): PathCheck {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return { ok: false, refusal: "Pass a `path` — the file to act on." };
  const expanded = value === "~" || value.startsWith(`~${path.sep}`) || value.startsWith("~/")
    ? path.join(home, value.slice(1))
    : value;
  const target = path.resolve(home, expanded);

  const realHome = tryRealpath(home) ?? home;
  const scoped = isInside(home, target) || isInside(realHome, resolvedThroughLinks(target));
  if (!scoped) {
    return {
      ok: false,
      refusal:
        `This skill may only touch files inside ${home}. ` +
        "Pick a path in the home folder, or do this step another way.",
    };
  }

  for (const denied of deniedPaths(home)) {
    if (isInside(denied, target) || isInside(denied, resolvedThroughLinks(target))) {
      return {
        ok: false,
        refusal:
          "That path holds this app's own connection settings and run transcripts, " +
          "which skills may never read or write. Use a different path.",
      };
    }
  }
  return { ok: true, path: target };
}

/** The child environment: everything except the Foundry credentials. */
export function scrubbedEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (/^(AZURE_OPENAI_|FOUNDRY_)/i.test(key)) continue;
    env[key] = value;
  }
  return env;
}

/** Keep the head and say how much was dropped — the start of the output is the part
 *  that explains what happened; a marker keeps the model from trusting a cut-off tail. */
function capText(text: string, cap: number): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}\n…[truncated: ${text.length - cap} more characters]`;
}

const defaultRunShell: RunShellFn = (spec) =>
  new Promise<ShellOutcome>((resolve, reject) => {
    const child = spawn(spec.file, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    // Collect at most a little more than we will ever show: a runaway command must not
    // be able to fill this process's memory before its deadline fires.
    const collectCap = SHELL_OUTPUT_CAP * 2;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, spec.timeoutMs);

    child.stdout?.on("data", (chunk) => {
      if (stdout.length < collectCap) stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < collectCap) stderr += String(chunk);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });

/** `bash -lc "<command>"`, or `cmd /c "<command>"` on Windows. */
function shellFor(command: string): { file: string; args: string[] } {
  return process.platform === "win32"
    ? { file: "cmd", args: ["/c", command] }
    : { file: "bash", args: ["-lc", command] };
}

/** One line, short enough for a confirmation card title. */
function oneLine(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Build the execution toolset for one run. Order matters only for the model's reading
 * of the tool list; enforcement is per handler.
 */
export function createExecutionTools(ctx: ExecutionToolsContext): Tool[] {
  const home = ctx.homeDir ? path.resolve(ctx.homeDir) : os.homedir();
  const runShell = ctx.runShell ?? defaultRunShell;
  const doFetch = ctx.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const { allowlist, confirm } = ctx;
  const askGate = ctx.ask;

  /** Approve/deny/timeout, collapsed to "may I act?" plus the in-band answer. */
  const gate = async (kind: string, summary: string, detail: string): Promise<string | null> => {
    const decision = await confirm.request(kind, summary, detail);
    if (decision === "approve") return null;
    return decision === "deny" ? DECLINED_MESSAGE : NO_RESPONSE_MESSAGE;
  };

  const runShellTool: Tool = {
    name: "run_shell",
    description:
      "Run one shell command on the user's machine and return its exit code, stdout and stderr. " +
      "The user must approve each command. Only commands this skill's allowed-tools permit can run.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command line to run." },
        cwd: { type: "string", description: "Working directory (defaults to the home folder)." },
      },
      required: ["command"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const { command, cwd } = (args ?? {}) as { command?: unknown; cwd?: unknown };
      const line = typeof command === "string" ? command.trim() : "";
      if (!line) return "Pass a `command` — the shell command line to run.";
      if (!matchesShell(allowlist, line)) return shellRefusal(allowlist);

      let dir = home;
      if (typeof cwd === "string" && cwd.trim()) {
        const resolved = resolvePath(home, cwd);
        if (!resolved.ok) return resolved.refusal;
        if (!existsSync(resolved.path)) return `That working directory does not exist: ${resolved.path}`;
        dir = resolved.path;
      }

      const refusal = await gate("run_shell", `Run: ${oneLine(line)}`, `${line}\n\nWorking directory: ${dir}`);
      if (refusal) return refusal;

      const shell = shellFor(line);
      let outcome: ShellOutcome;
      try {
        outcome = await runShell({
          file: shell.file,
          args: shell.args,
          cwd: dir,
          env: scrubbedEnv(),
          timeoutMs: SHELL_TIMEOUT_MS,
        });
      } catch (err) {
        return { textResultForLlm: `Could not run that command: ${msg(err)}`, resultType: "failure" };
      }

      const parts = [
        outcome.timedOut
          ? `The command was stopped after ${SHELL_TIMEOUT_MS / 1000}s (timeout).`
          : `exit code ${outcome.code ?? "unknown"}`,
      ];
      if (outcome.stdout.trim()) parts.push(`stdout:\n${outcome.stdout.trimEnd()}`);
      if (outcome.stderr.trim()) parts.push(`stderr:\n${outcome.stderr.trimEnd()}`);
      if (parts.length === 1) parts.push("(no output)");
      const text = capText(parts.join("\n\n"), SHELL_OUTPUT_CAP);
      return outcome.timedOut || (outcome.code ?? 1) !== 0
        ? { textResultForLlm: text, resultType: "failure" }
        : text;
    },
  };

  const readFileTool: Tool = {
    name: "read_file",
    description:
      "Read a UTF-8 text file from the user's home folder and return its contents " +
      `(up to ${READ_CAP_BYTES / 1024} KB; larger files return their size plus the start of the file).`,
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Absolute path, or relative to the home folder." } },
      required: ["path"],
      additionalProperties: false,
    },
    handler: (args) => {
      if (!allowsCapability(allowlist, "read_file")) return capabilityRefusal(allowlist, "read_file");
      const resolved = resolvePath(home, (args as { path?: unknown })?.path);
      if (!resolved.ok) return resolved.refusal;

      let size: number;
      try {
        const stat = statSync(resolved.path);
        if (stat.isDirectory()) return `${resolved.path} is a folder, not a file.`;
        size = stat.size;
      } catch {
        return `No such file: ${resolved.path}`;
      }
      try {
        const buffer = readFileSync(resolved.path);
        const head = buffer.subarray(0, READ_CAP_BYTES).toString("utf8");
        if (size <= READ_CAP_BYTES) return head;
        return (
          `${resolved.path} is ${size} bytes — larger than the ${READ_CAP_BYTES / 1024} KB inline limit. ` +
          `The first ${READ_CAP_BYTES / 1024} KB follow.\n\n${head}`
        );
      } catch (err) {
        return { textResultForLlm: `Could not read that file: ${msg(err)}`, resultType: "failure" };
      }
    },
  };

  const writeFileTool: Tool = {
    name: "write_file",
    description:
      "Write a UTF-8 text file inside the user's home folder, creating parent folders as needed. " +
      "The user must approve each write. Overwrites the file if it already exists.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path, or relative to the home folder." },
        content: { type: "string", description: "The full file contents to write." },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    handler: async (args) => {
      if (!allowsCapability(allowlist, "write_file")) return capabilityRefusal(allowlist, "write_file");
      const { path: rawPath, content } = (args ?? {}) as { path?: unknown; content?: unknown };
      const resolved = resolvePath(home, rawPath);
      if (!resolved.ok) return resolved.refusal;
      const text = typeof content === "string" ? content : "";
      const bytes = Buffer.byteLength(text);
      if (bytes > WRITE_CAP_BYTES) {
        return (
          `That content is ${Math.round(bytes / 1024)} KB — the limit is ` +
          `${WRITE_CAP_BYTES / 1024} KB per write. Write less, or split it across files.`
        );
      }

      const refusal = await gate(
        "write_file",
        `Write ${bytes} bytes to ${oneLine(resolved.path, 80)}`,
        `${resolved.path}\n\n${capText(text, 4_000)}`,
      );
      if (refusal) return refusal;

      try {
        mkdirSync(path.dirname(resolved.path), { recursive: true });
        writeFileSync(resolved.path, text);
      } catch (err) {
        return { textResultForLlm: `Could not write that file: ${msg(err)}`, resultType: "failure" };
      }
      return `Wrote ${bytes} bytes to ${resolved.path}.`;
    },
  };

  const fetchUrlTool: Tool = {
    name: "fetch_url",
    description:
      "Fetch an http(s) URL and return the status, content type and response body " +
      `(up to ${FETCH_CAP_BYTES / 1024} KB). No credentials are added for you.`,
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The http:// or https:// URL." },
        method: { type: "string", description: "HTTP method (default GET)." },
        headers: { type: "object", description: "Extra request headers.", additionalProperties: { type: "string" } },
        body: { type: "string", description: "Request body, for non-GET methods." },
      },
      required: ["url"],
      additionalProperties: false,
    },
    handler: async (args) => {
      if (!allowsCapability(allowlist, "fetch_url")) return capabilityRefusal(allowlist, "fetch_url");
      const { url, method, headers, body } = (args ?? {}) as {
        url?: unknown;
        method?: unknown;
        headers?: unknown;
        body?: unknown;
      };
      let parsed: URL;
      try {
        parsed = new URL(String(url ?? "").trim());
      } catch {
        return "That isn't a URL. Pass a full http:// or https:// address.";
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return "Only http:// and https:// URLs can be fetched.";
      }

      const requestHeaders: Record<string, string> = {};
      if (headers && typeof headers === "object" && !Array.isArray(headers)) {
        for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
          if (typeof value === "string") requestHeaders[key] = value;
        }
      }
      const verb = typeof method === "string" && method.trim() ? method.trim().toUpperCase() : "GET";

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const response = await doFetch(parsed.toString(), {
          method: verb,
          headers: requestHeaders,
          ...(typeof body === "string" && verb !== "GET" && verb !== "HEAD" ? { body } : {}),
          signal: controller.signal,
        });
        const text = await response.text();
        const contentType = response.headers.get("content-type") ?? "unknown";
        return (
          `HTTP ${response.status} ${response.statusText}\ncontent-type: ${contentType}\n\n` +
          capText(text, FETCH_CAP_BYTES)
        );
      } catch (err) {
        if (controller.signal.aborted) {
          return {
            textResultForLlm: `That request took longer than ${FETCH_TIMEOUT_MS / 1000}s and was stopped.`,
            resultType: "failure",
          };
        }
        return { textResultForLlm: `Could not fetch that URL: ${msg(err)}`, resultType: "failure" };
      } finally {
        clearTimeout(timer);
      }
    },
  };

  const askUserTool: Tool = {
    name: "ask_user",
    description:
      "Ask the person watching this run one short question and wait for their answer. " +
      "Use it when a step needs information the skill does not carry.",
    parameters: {
      type: "object",
      properties: { question: { type: "string", description: "The question to show." } },
      required: ["question"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const question = String((args as { question?: unknown })?.question ?? "").trim();
      if (!question) return "Pass a `question` — what you want to ask the user.";
      const answer = await askGate.ask(question);
      if (answer === null) return NO_RESPONSE_MESSAGE;
      return answer.trim() ? `The user answered: ${answer.trim()}` : "The user answered with nothing.";
    },
  };

  return [runShellTool, readFileTool, writeFileTool, fetchUrlTool, askUserTool];
}
