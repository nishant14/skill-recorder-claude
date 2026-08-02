import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

import type { SkillListEntry } from "../../common/ipc";
import { createLogger } from "../logger";
import { skillsRoot } from "../skillbuilder/builder";

/**
 * Reads this app's own skill library off disk for the runner: what is installed, what
 * each skill's frontmatter declares, and whether it carries the two optional side files
 * a run may need (a copied API reference, and the user's per-skill `runner.json`).
 *
 * **Why a hand-written frontmatter parser.** The only producer of these files is
 * {@link renderSkillMarkdown}, which emits three things: `name: <slug>`, a
 * JSON-stringified `description:` scalar, and an optional `allowed-tools:` dash list.
 * Parsing exactly that needs no YAML dependency (and `common/` is deliberately
 * dependency-free apart from zod). The parser is nonetheless *tolerant*, because a
 * SKILL.md is a plain text file the user is invited to hand-edit: an unquoted
 * description, single quotes, odd indentation, CRLF line endings, a missing
 * `allowed-tools` block, or no frontmatter at all all still yield a loadable skill
 * rather than a parse error.
 *
 * **No token substitution.** `{{value}}` tokens were substituted at install time
 * (`renderValues` inside `renderSkillMarkdown`), so what is on disk is already literal.
 * The runner must never re-run substitution — doing so would silently rewrite a
 * hand-edited body.
 *
 * Electron-free (paths come from `skillsRoot()`), so tests and headless runs can load it.
 */

const log = createLogger("Runner/library");

/** Folder inside a skill that carries its copied API reference (written by the builder). */
const API_DIR = "api";
/**
 * The only folder names {@link deleteSkill} will remove: a single path segment shaped
 * like what the installer writes (`slugifySkillName`, plus its `-2` collision suffix),
 * widened only to the dots and underscores a hand-created folder plausibly carries. A
 * leading `.` is refused, which also refuses `.` and `..` before they reach a join.
 */
const SAFE_SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
/** User-authored per-skill config. Never written by us — documented for the user. */
const RUNNER_CONFIG_FILE = "runner.json";

/** What the renderer lists in the Skills panel — a wire shape, defined in `common/ipc`. */
export type { SkillListEntry };

/**
 * The user's per-skill runner config: where API credentials live. Read tolerantly —
 * this file is hand-written, and a typo in it must degrade the run, not crash it.
 * (Only H-b's `call_api` consumes it; the library merely surfaces it.)
 */
export interface SkillRunnerConfig {
  apiBase?: string;
  headers?: Record<string, string>;
}

/** A skill loaded for execution: the list entry plus everything a run needs. */
export interface InstalledSkill extends SkillListEntry {
  /** Absolute path of the SKILL.md. */
  file: string;
  /** `allowed-tools` entries, verbatim (compiled by `allowlist.ts`). */
  allowedTools: string[];
  /** Everything after the frontmatter — the instructions the runner executes. */
  body: string;
  /** Absolute path of the copied spec, when {@link hasApi}. */
  specFile: string | null;
  /** Absolute path of the derived operation index, when {@link hasApi}. */
  indexFile: string | null;
  /** Parsed `runner.json`, or null when absent or unreadable. */
  runnerConfig: SkillRunnerConfig | null;
}

export interface SkillFrontmatter {
  name: string;
  description: string;
  allowedTools: string[];
}

/**
 * Split a SKILL.md into its frontmatter and body. A file that does not open with a
 * `---` fence has no frontmatter: the whole text is the body, which is what makes a
 * hand-written skill still runnable (the caller falls back to the folder name).
 */
export function parseSkillMarkdown(text: string): { frontmatter: SkillFrontmatter; body: string } {
  const empty: SkillFrontmatter = { name: "", description: "", allowedTools: [] };
  // Tolerate CRLF and a leading BOM — both survive a round trip through an editor.
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { frontmatter: empty, body: text.trim() };

  const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  // An unterminated fence is a truncated file, not frontmatter — keep the whole text.
  if (end < 0) return { frontmatter: empty, body: text.trim() };

  const frontmatter: SkillFrontmatter = { name: "", description: "", allowedTools: [] };
  let inAllowedTools = false;
  for (const raw of lines.slice(1, end)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (inAllowedTools && line.startsWith("-")) {
      const entry = line.slice(1).trim();
      if (entry) frontmatter.allowedTools.push(unquote(entry));
      continue;
    }
    const match = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2].trim();
    inAllowedTools = key === "allowed-tools" && value === "";
    if (key === "name") frontmatter.name = unquote(value);
    else if (key === "description") frontmatter.description = unquote(value);
    else if (key === "allowed-tools" && value) {
      // Hand-edited flow style (`allowed-tools: [Read, Bash(gh *)]`) as well as the
      // dash list we emit. Bash globs contain no commas, so a plain split is safe.
      frontmatter.allowedTools.push(
        ...value
          .replace(/^\[|\]$/g, "")
          .split(",")
          .map((v) => unquote(v.trim()))
          .filter(Boolean),
      );
    }
  }
  return { frontmatter, body: lines.slice(end + 1).join("\n").trim() };
}

/**
 * Read a YAML scalar the way our writer emits it (`JSON.stringify`, i.e. a double-quoted
 * string with JSON escapes) while tolerating what a hand edit leaves behind: a
 * single-quoted or bare scalar.
 */
function unquote(value: string): string {
  if (value.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === "string") return parsed;
    } catch {
      // Fall through: an unterminated or hand-mangled quote is stripped literally.
    }
    return value.replace(/^"|"$/g, "").trim();
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).replace(/''/g, "'").trim();
  }
  return value.trim();
}

/** Read `runner.json` from a skill folder. Absent / unreadable / not an object → null. */
function readRunnerConfig(file: string): SkillRunnerConfig | null {
  if (!existsSync(file)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    log.warn(`ignoring ${file}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    log.warn(`ignoring ${file}: expected a JSON object.`);
    return null;
  }
  const raw = parsed as { apiBase?: unknown; headers?: unknown };
  const config: SkillRunnerConfig = {};
  if (typeof raw.apiBase === "string" && raw.apiBase.trim()) config.apiBase = raw.apiBase.trim();
  if (raw.headers && typeof raw.headers === "object" && !Array.isArray(raw.headers)) {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw.headers as Record<string, unknown>)) {
      // Numbers and booleans are a plausible hand-edit; anything else is dropped.
      if (typeof value === "string") headers[key] = value;
      else if (typeof value === "number" || typeof value === "boolean") headers[key] = String(value);
    }
    if (Object.keys(headers).length) config.headers = headers;
  }
  return config;
}

/** Load one skill folder, or null when it holds no SKILL.md. */
export function loadSkillFromDir(dir: string): InstalledSkill | null {
  const file = path.join(dir, "SKILL.md");
  if (!existsSync(file)) return null;
  let text: string;
  let mtimeMs = 0;
  try {
    text = readFileSync(file, "utf8");
    mtimeMs = statSync(file).mtimeMs;
  } catch (err) {
    log.warn(`could not read ${file}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  const { frontmatter, body } = parseSkillMarkdown(text);
  const specFile = path.join(dir, API_DIR, "openapi.json");
  const indexFile = path.join(dir, API_DIR, "index.json");
  // Both halves are required: `call_api` resolves operations from the *index*, and
  // validates against the spec — a spec with no index is not executable.
  const hasApi = existsSync(specFile) && existsSync(indexFile);
  const runnerConfigFile = path.join(dir, RUNNER_CONFIG_FILE);

  return {
    name: frontmatter.name || path.basename(dir),
    description: frontmatter.description,
    dir,
    file,
    allowedTools: frontmatter.allowedTools,
    body,
    hasApi,
    specFile: hasApi ? specFile : null,
    indexFile: hasApi ? indexFile : null,
    hasRunnerConfig: existsSync(runnerConfigFile),
    runnerConfig: readRunnerConfig(runnerConfigFile),
    unrestricted: frontmatter.allowedTools.length === 0,
    mtimeMs,
  };
}

/** Every SKILL.md one level under the library root, by name. A missing root is empty. */
export function listInstalledSkills(): SkillListEntry[] {
  const root = skillsRoot();
  if (!existsSync(root)) return [];
  let names: string[];
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch (err) {
    log.warn(`could not read ${root}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }

  const entries: SkillListEntry[] = [];
  for (const name of names.sort()) {
    const skill = loadSkillFromDir(path.join(root, name));
    if (!skill) continue;
    entries.push({
      name: skill.name,
      description: skill.description,
      dir: skill.dir,
      hasApi: skill.hasApi,
      hasRunnerConfig: skill.hasRunnerConfig,
      unrestricted: skill.unrestricted,
      mtimeMs: skill.mtimeMs,
    });
  }
  return entries;
}

/**
 * Resolve the skill a run names. Matched on the frontmatter `name` first and on the
 * folder name second, because the two can differ after a hand edit and the UI shows
 * the former while the disk carries the latter.
 */
export function findInstalledSkill(name: string): InstalledSkill | null {
  const wanted = String(name ?? "").trim();
  if (!wanted) return null;
  const root = skillsRoot();
  if (!existsSync(root)) return null;

  // A folder name is a single path segment by construction; refuse anything that could
  // escape the library root before it reaches `path.join`.
  if (!wanted.includes("/") && !wanted.includes("\\") && !wanted.includes("..")) {
    const direct = loadSkillFromDir(path.join(root, wanted));
    if (direct) return direct;
  }
  for (const entry of listInstalledSkills()) {
    if (entry.name === wanted) return loadSkillFromDir(entry.dir);
  }
  return null;
}

/**
 * Uninstall one skill: remove its folder from the library root, recursively.
 *
 * `slug` is the **folder** name, not the frontmatter name — the two can differ after a
 * hand rename, and only the folder is a path. Callers that hold a {@link SkillListEntry}
 * pass `path.basename(entry.dir)`.
 *
 * Deletion deliberately stops at the library: `~/.skill-recorder/runs/<skill>/` is left
 * alone. Those transcripts record what a skill actually did on this machine — an audit
 * trail — so uninstalling the skill must not erase the history of having run it.
 *
 * Throws a message written for the user; these strings surface verbatim in the Skills
 * panel's banner.
 */
export function deleteSkill(slug: string): void {
  const wanted = String(slug ?? "").trim();
  if (!SAFE_SLUG.test(wanted)) throw new Error(`"${wanted}" is not an installed skill.`);

  const root = path.resolve(skillsRoot());
  const dir = path.resolve(root, wanted);
  // The shape check already refuses separators and `..`; this second check is what
  // guarantees the invariant we actually care about — we only ever remove a *direct
  // child* of the library root, never the root itself and never anything outside it.
  if (path.dirname(dir) !== root) throw new Error(`"${wanted}" is not an installed skill.`);
  // Require the SKILL.md, not just the folder: that is what makes a directory a skill,
  // and it keeps a stray folder under the root from being removed by a typo'd name.
  if (!existsSync(path.join(dir, "SKILL.md"))) {
    throw new Error(`"${wanted}" is not installed any more — the Skills list may be out of date.`);
  }

  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    throw new Error(`Could not delete ${dir}: ${err instanceof Error ? err.message : String(err)}`);
  }
  log.info(`deleted skill ${wanted} (run transcripts kept)`);
}

export { skillsRoot };
