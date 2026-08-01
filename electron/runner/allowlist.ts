/**
 * Compiles a skill's `allowed-tools` frontmatter into the capabilities its run may use.
 *
 * The frontmatter is **enforced, not advisory**: `allowed-tools` is what the user
 * approved when they built the skill, so the runner treats an undeclared capability as
 * a refusal the model is told about *in band* (a refusal is an instruction to find
 * another way, never a crashed run).
 *
 * Two rules carry the design:
 * - **A skill that declares nothing is `unrestricted`** — nothing is refused, because a
 *   hand-written skill with no frontmatter would otherwise be unable to do anything at
 *   all. The price is that always-allow is disabled for it: every side effect needs an
 *   individual approval, and the run panel labels the skill "unrestricted".
 * - **A skill that declares anything is held to it.** If any `Bash(...)` pattern
 *   exists, a non-matching command is refused and the model is told which patterns do
 *   exist; likewise a `read_file` / `write_file` / `fetch_url` call the frontmatter
 *   never mentioned.
 *
 * Pure, dependency-free, and unit-tested: no filesystem, no process, no model.
 */

/** The non-shell capabilities a declared entry can grant. */
export type RunnerCapability = "read_file" | "write_file" | "fetch_url";

export interface CompiledAllowlist {
  /** Globs from `Bash(<glob>)` entries, in declaration order. Empty ⇒ no shell rule. */
  shellPatterns: string[];
  /** Operation ids from `api:<op>` entries, or null when the skill named none. */
  apiOps: Set<string> | null;
  allowFetch: boolean;
  allowRead: boolean;
  allowWrite: boolean;
  /** The skill declared no `allowed-tools` at all. */
  unrestricted: boolean;
  /** The declared entries, verbatim — quoted back to the model in refusals. */
  entries: string[];
}

/** `Bash(git status)` → `{ tool: "bash", arg: "git status" }`; `Read` → `{ tool: "read" }`. */
function splitEntry(entry: string): { tool: string; arg: string } {
  const match = /^([^(]*)\((.*)\)\s*$/.exec(entry.trim());
  if (match) return { tool: normalizeToolName(match[1]), arg: match[2].trim() };
  return { tool: normalizeToolName(entry), arg: "" };
}

/** Fold the spellings the builders and hand edits produce (`web_fetch`, `WebFetch`). */
function normalizeToolName(name: string): string {
  return name.trim().toLowerCase().replace(/[\s_-]+/g, "");
}

/**
 * Compile the frontmatter entries. Unknown entries (a Copilot Studio connector name,
 * say) are kept in {@link CompiledAllowlist.entries} but grant nothing — they still
 * count as "the skill declared something", which is what turns enforcement on.
 */
export function compileAllowlist(entries: readonly string[] | undefined): CompiledAllowlist {
  const declared = (entries ?? []).map((e) => String(e ?? "").trim()).filter(Boolean);
  const list: CompiledAllowlist = {
    shellPatterns: [],
    apiOps: null,
    allowFetch: false,
    allowRead: false,
    allowWrite: false,
    unrestricted: declared.length === 0,
    entries: declared,
  };
  if (list.unrestricted) {
    list.allowFetch = true;
    list.allowRead = true;
    list.allowWrite = true;
    return list;
  }

  for (const entry of declared) {
    if (/^api:/i.test(entry)) {
      const op = entry.slice(entry.indexOf(":") + 1).trim();
      if (!op) continue;
      list.apiOps ??= new Set<string>();
      list.apiOps.add(op);
      continue;
    }
    const { tool, arg } = splitEntry(entry);
    switch (tool) {
      case "bash":
      case "shell":
      case "runshell":
        // `Bash` with no glob is a blanket grant; an empty `Bash()` is a no-op typo.
        if (arg) list.shellPatterns.push(arg);
        else if (!/\(/.test(entry)) list.shellPatterns.push("*");
        break;
      case "webfetch":
      case "fetchurl":
      case "fetch":
      case "websearch":
        list.allowFetch = true;
        break;
      case "read":
      case "readfile":
      case "view":
        list.allowRead = true;
        break;
      case "write":
      case "writefile":
      case "edit":
        list.allowWrite = true;
        break;
      default:
        break;
    }
  }
  return list;
}

/** Collapse runs of whitespace so `gh  pr   list` matches the pattern `gh *`. */
function normalizeCommand(command: string): string {
  return String(command ?? "").trim().replace(/\s+/g, " ");
}

/**
 * Glob → anchored regex. `*` matches any run of characters **including spaces** (a
 * command is one line, so there is no path-segment boundary to respect), `?` matches
 * one; everything else is literal. That is why `Bash(gh *)` gates commands starting
 * `gh ` — and why bare `gh` does not match it.
 */
function globToRegExp(pattern: string): RegExp {
  const source = normalizeCommand(pattern).replace(/[.*+?^${}()|[\]\\]/g, (ch) =>
    ch === "*" ? "[\\s\\S]*" : ch === "?" ? "[\\s\\S]" : `\\${ch}`,
  );
  return new RegExp(`^${source}$`);
}

/** True when the skill's shell rule permits `command` (multiple patterns OR). */
export function matchesShell(list: CompiledAllowlist, command: string): boolean {
  // No `Bash(...)` entry at all: an unrestricted skill may run anything (subject to
  // confirmation), a restricted one may not run shell commands it never declared.
  if (list.shellPatterns.length === 0) return list.unrestricted;
  const normalized = normalizeCommand(command);
  return list.shellPatterns.some((pattern) => globToRegExp(pattern).test(normalized));
}

/** The in-band refusal for a shell command the allowlist doesn't cover. */
export function shellRefusal(list: CompiledAllowlist): string {
  if (list.shellPatterns.length === 0) {
    return (
      "This skill's allowed-tools do not include shell commands " +
      `(they list: ${list.entries.join(", ") || "nothing"}). ` +
      "Do this step another way, or finish and report what is missing."
    );
  }
  return (
    "That command is not covered by this skill's allowed-tools, which permit only: " +
    `${list.shellPatterns.map((p) => `Bash(${p})`).join(", ")}. ` +
    "Run a command that matches one of those, or do this step another way."
  );
}

/** True when the skill may use a non-shell capability. */
export function allowsCapability(list: CompiledAllowlist, capability: RunnerCapability): boolean {
  if (list.unrestricted) return true;
  if (capability === "read_file") return list.allowRead;
  if (capability === "write_file") return list.allowWrite;
  return list.allowFetch;
}

/** The in-band refusal for a capability the frontmatter never declared. */
export function capabilityRefusal(list: CompiledAllowlist, capability: RunnerCapability): string {
  return (
    `This skill's allowed-tools do not include ${capability} ` +
    `(they list: ${list.entries.join(", ") || "nothing"}). ` +
    "Do this step another way, or finish and report what is missing."
  );
}

/**
 * True when the skill may call `api:<operationId>`. A skill that named **no** `api:`
 * entry is not restricted to an empty set — it simply has no API rule, and `call_api`
 * is then bounded by the reference the skill carries (and by confirmation).
 */
export function allowsApiOperation(list: CompiledAllowlist, operationId: string): boolean {
  if (list.apiOps === null) return true;
  const wanted = operationId.trim().toLowerCase();
  for (const op of list.apiOps) if (op.toLowerCase() === wanted) return true;
  return false;
}

/** The in-band refusal for an operation this skill's `api:` entries never named. */
export function apiOperationRefusal(list: CompiledAllowlist, operationId: string): string {
  const allowed = [...(list.apiOps ?? [])].map((op) => `api:${op}`).join(", ");
  return (
    `This skill's allowed-tools do not include api:${operationId} — it may only call: ${allowed || "nothing"}. ` +
    "Use one of those operations, or finish and report what is missing."
  );
}
