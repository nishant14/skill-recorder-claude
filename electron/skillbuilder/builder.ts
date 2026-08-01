import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  collectApiRefs,
  findOperation,
  normalizeApiRef,
  unresolvedApiOperations,
  type ApiOperation,
} from "../../common/api-reference";
import {
  BuiltSkillSchema,
  renderSkillMarkdown,
  SkillPlanSchema,
  slugifySkillName,
  toBuiltSkill,
  type BuiltSkill,
  type SkillArchitecture,
  type SkillPlan,
  type SkillSubmission,
} from "../../common/skill";
import { unresolvedTokens } from "../../common/values";
import type { SkillBuildInput, SkillBuildProgress } from "../../common/ipc";
import { AgentBuilder, type BaseLive } from "../builders/agent-builder";
import { indexPath, loadIndex, loadReference, specPath } from "../builders/api-reference-store";
import { createApiReferenceTools, renderApiReferenceBrief } from "../builders/api-reference-tools";
import { createReadTools } from "../builders/read-tools";
import { loadPersistedAnalysis } from "../describer/describer";
import type { FoundrySession } from "../foundry/agent";
import { createLogger } from "../logger";
import { isValidSessionId, sessionDir } from "../recorder/session-store";
import { catalogueFor } from "./app-catalog";
import { SKILL_BUILDER_INSTRUCTIONS } from "./instructions";
import { createSkillBuilderTools } from "./tools";

const log = createLogger("SkillBuilder");

const TURN_TIMEOUT_MS = 180_000;

/** Folder inside a skill that carries its copied API reference. */
const API_BUNDLE_DIR = "api";
/** The `apiReference.specFile` pointer: relative to the skill folder, always posix. */
const EXPORTED_SPEC_FILE = `${API_BUNDLE_DIR}/openapi.json`;

const KICKOFF_PROMPT =
  "Read get_analysis (and get_timeline where the tool mapping needs evidence), then call " +
  "propose_plan with how you'll generalize this task, its fixed values (each an id + name + " +
  "value, referenced from steps as {{id}}), and its ordered steps (each a short title + " +
  "description, with the native tool it uses). Stop after propose_plan so the user can review it.";

const CREATE_PROMPT =
  "The user reviewed and edited the plan below. Build the SKILL.md from EXACTLY this plan — do not " +
  "add, drop, reorder, or rename its values or steps. Call submit_skill with a generalized, " +
  "native-tool-first instructions body that follows these steps faithfully and references each fixed " +
  "value by its {{id}} token (never inline the literal). The name and description are already decided — " +
  "you may echo them.";

const msg = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * This app's own skill library — where an installed SKILL.md lands and where the
 * in-app runner loads skills from (`electron/runner/library.ts` imports this rather
 * than re-deriving the path, so writer and reader can never drift). Overridable for
 * dev/tests.
 */
export function skillsRoot(): string {
  const override = process.env.SKILL_RECORDER_SKILLS_DIR;
  if (override) return path.resolve(override);
  return path.join(os.homedir(), ".skill-recorder", "skills");
}

/**
 * Where an export lands when the caller asked to install something that can't be
 * installed (a copilot-studio bundle). The UI never takes this path — it only offers
 * export for copilot-studio — so this is the defensive landing spot, deliberately
 * outside the library the runner loads.
 */
function exportsRoot(): string {
  return path.join(os.homedir(), ".skill-recorder", "exports");
}

/** True when `dir` is `root` or nested inside it (so we can safely re-use it). */
function isInside(root: string, dir: string): boolean {
  const rel = path.relative(root, dir);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Where {@link SkillBuilder.create} writes the finished SKILL.md:
 * - **install** — into this app's own skill library ({@link skillsRoot}). Valid only
 *   for `architecture === "app"`; a copilot-studio skill has nothing to install into.
 * - **export** — into a user-picked folder (a "download"), as `<dir>/<name>/SKILL.md`.
 */
export type SkillTarget = { kind: "install" } | { kind: "export"; dir: string };

interface LiveBuild extends BaseLive {
  sessionDir: string;
  architecture: SkillArchitecture;
  agent: FoundrySession;
  holder: { plan: SkillPlan | undefined; submission: SkillSubmission | undefined };
  /** Last plan proposed this build (kept so submit can reference it). */
  lastPlan: SkillPlan | null;
}

function readJson<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Load a previously built + persisted skill for a session, if any. */
export function loadPersistedSkill(sessionId: string): BuiltSkill | null {
  if (!isValidSessionId(sessionId)) return null;
  const raw = readJson<unknown>(path.join(sessionDir(sessionId), "skill.json"));
  if (!raw) return null;
  const parsed = BuiltSkillSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Drives the multi-turn Foundry Codex agent that turns a recording's analysis
 * into a generalized, native-tool-first skill for a target architecture. Shares the
 * {@link AgentBuilder} pool (one live conversation per recording) so the plan →
 * refine → build flow stays in a single session. Streams progress out via a
 * callback and writes the final SKILL.md into this app's skill library or into a
 * user-picked export folder.
 */
export class SkillBuilder extends AgentBuilder<LiveBuild> {
  constructor(private readonly emitProgress: (p: SkillBuildProgress) => void) {
    super("SkillBuilder");
  }

  /** Propose a plan (first pass) or refine the current one with NL feedback. */
  async build(input: SkillBuildInput): Promise<SkillPlan> {
    const { sessionId, architecture, feedback } = input;
    if (this.active.has(sessionId)) throw new Error("A build is already running for this session.");
    if (!catalogueFor(architecture)) {
      throw new Error("That target architecture isn't available yet. Choose the app or Copilot Studio.");
    }
    const analysis = loadPersistedAnalysis(sessionId);
    if (!analysis) throw new Error("There is no analysis for this recording yet.");

    this.active.add(sessionId);
    try {
      const refining = Boolean(feedback && feedback.trim());
      this.emit(sessionId, "start", refining ? "Refining the plan…" : "Planning the skill…");
      let live = this.live.get(sessionId);
      if (!refining || !live) {
        await this.disposeLive(sessionId); // fresh conversation for a fresh plan
        live = await this.createLive(sessionId, architecture);
      }
      const prompt = refining ? renderRefinePrompt(feedback!.trim(), live.lastPlan) : KICKOFF_PROMPT;
      return await this.runProposeTurn(live, prompt);
    } finally {
      this.active.delete(sessionId);
    }
  }

  /** Finalize the user-edited plan into a SKILL.md and place it. The edited plan is
   *  authoritative: its name/description/values/steps are used verbatim and only the
   *  markdown body is written by the agent (which references each fixed value by its
   *  `{{id}}` token; `renderSkillMarkdown` substitutes the literals). `target` picks the
   *  destination — installed into this app's skill library, or exported (downloaded)
   *  to a user-picked dir. Installing is only meaningful for `architecture === "app"`;
   *  a copilot-studio install request degrades to an export. */
  async create(
    sessionId: string,
    editedPlan?: SkillPlan,
    target: SkillTarget = { kind: "install" },
  ): Promise<{ skill: BuiltSkill; path: string }> {
    if (this.active.has(sessionId)) throw new Error("Wait for the current step to finish.");
    let held = this.live.get(sessionId);
    // Prefer the user's edited plan from the review tiles; fall back to the last
    // proposed plan for older callers that don't pass one.
    const plan = editedPlan ? SkillPlanSchema.parse(editedPlan) : held?.lastPlan ?? null;
    if (!plan) throw new Error("There is no plan to build from yet.");
    // The pool may have evicted the live conversation while the user edited the plan;
    // recreate one so export always works.
    if (!held) held = await this.createLive(sessionId, plan.architecture);
    const live = held;
    live.lastPlan = plan;

    this.active.add(sessionId);
    try {
      this.emit(sessionId, "drafting", "Writing the skill…");
      live.holder.submission = undefined;
      try {
        await live.agent.sendAndWait(`${CREATE_PROMPT}\n\n${renderPlanForPrompt(plan)}`, TURN_TIMEOUT_MS);
      } catch (err) {
        await live.agent.abort().catch(() => undefined);
        throw new Error(`Skill build failed: ${msg(err)}`);
      }
      const submission = live.holder.submission as SkillSubmission | undefined;
      if (!submission) throw new Error("The agent finished without submitting a skill.");
      // Lint the authored body: the agent is given each value as `{{id}} — name` (never the
      // literal), so it can only reference tokens. Any token that doesn't match a declared
      // value would ship un-substituted, so surface it (the render leaves unknown tokens as-is).
      const unknownTokens = unresolvedTokens(submission.body, plan.values);
      if (unknownTokens.length) {
        log.warn(`skill body references unknown value tokens: ${unknownTokens.map((t) => `{{${t}}}`).join(", ")}`);
      }
      // The same posture for API grounding: the agent is hard-rejected at propose time,
      // but the plan the user edited is authoritative — they may know an operation this
      // reference doesn't describe. Warn, never fail; Workstream H revalidates at run time.
      const apiRefs = collectApiRefs(plan.steps, plan.allowedTools);
      const indexedOperations = loadIndex(live.sessionDir)?.operations ?? [];
      const unknownOperations = unresolvedApiOperations(apiRefs, indexedOperations);
      if (unknownOperations.length) {
        log.warn(`plan references API operations the attached reference doesn't have: ${unknownOperations.join(", ")}`);
      }
      // The engine — never the model — decides whether this skill is API-grounded: it is
      // when the reviewed plan names `api:` operations AND a spec is attached to copy.
      // The pointer travels with the skill so the runner never has to find the session.
      const apiReference =
        apiRefs.length && specPath(live.sessionDir)
          ? { operations: resolvedOperationIds(apiRefs, indexedOperations), specFile: EXPORTED_SPEC_FILE }
          : null;
      // The frontmatter comes from the edited plan (authoritative); only the body is
      // the agent's generated prose. allowed-tools may be tightened by the agent to the
      // final steps, but never emptied below what the plan declared.
      const finalSubmission: SkillSubmission = {
        name: plan.name,
        description: plan.description,
        allowedTools: submission.allowedTools.length ? submission.allowedTools : plan.allowedTools,
        body: submission.body,
      };
      const built = toBuiltSkill(sessionId, plan.architecture, finalSubmission, plan, apiReference);
      // Only an app skill has a library to be installed into; anything else is a bundle
      // the user takes elsewhere, so an install request degrades to an export.
      const installing = target.kind === "install" && plan.architecture === "app";
      const exportPath = installing
        ? this.exportSkill(built)
        : this.exportSkillTo(built, target.kind === "export" ? target.dir : exportsRoot());
      const finalSkill: BuiltSkill = { ...built, exportedPath: exportPath, exportedAt: Date.now() };
      this.persist(live.sessionDir, finalSkill);
      this.emit(
        sessionId,
        "done",
        installing ? `Skill added: ${exportPath}` : `Skill exported to ${exportPath}`,
      );
      return { skill: finalSkill, path: exportPath };
    } finally {
      this.active.delete(sessionId);
    }
  }

  // --- internals -----------------------------------------------------------

  private emit(sessionId: string, phase: SkillBuildProgress["phase"], message: string): void {
    this.emitProgress({ sessionId, phase, message });
  }

  private async createLive(sessionId: string, architecture: SkillArchitecture): Promise<LiveBuild> {
    const dir = sessionDir(sessionId);
    const analysis = loadPersistedAnalysis(sessionId);
    if (!analysis) throw new Error("There is no analysis for this recording yet.");

    const holder: LiveBuild["holder"] = { plan: undefined, submission: undefined };
    // Read once per live conversation: the tools, the propose-time lint, and the prompt
    // block below must all describe the same attachment.
    const apiIndex = loadIndex(dir);
    const tools = [
      ...createReadTools({
        sessionDir: dir,
        analysis,
        onProgress: (m) => this.emit(sessionId, "working", m),
      }),
      ...createApiReferenceTools({
        sessionDir: dir,
        onProgress: (m) => this.emit(sessionId, "working", m),
      }),
      ...createSkillBuilderTools({
        architecture,
        apiIndex,
        onProgress: (m) => this.emit(sessionId, "working", m),
        onPlan: (p) => {
          holder.plan = p;
        },
        onSubmit: (s) => {
          holder.submission = s;
        },
      }),
    ];

    const catalogue = catalogueFor(architecture) ?? "";
    // The API brief comes AFTER the catalogue: it narrows one application's steps onto
    // concrete operations, it does not replace the target's capability ladder.
    const reference = loadReference(dir);
    const apiBrief = reference
      ? renderApiReferenceBrief({ reference, architecture, kind: "skill" })
      : "";
    const systemContent = [SKILL_BUILDER_INSTRUCTIONS, catalogue, apiBrief]
      .map((part) => part.trim())
      .filter(Boolean)
      .join("\n\n");

    const client = await this.ensureClient();
    const agent = await client.createSession({
      instructions: systemContent,
      tools,
      ...(this.model ? { model: this.model } : {}),
    });

    const live: LiveBuild = {
      sessionId,
      sessionDir: dir,
      architecture,
      agent,
      holder,
      lastPlan: null,
    };
    this.registerLive(live);
    return live;
  }

  private async runProposeTurn(live: LiveBuild, prompt: string): Promise<SkillPlan> {
    live.holder.plan = undefined;
    this.emit(live.sessionId, "working", "Thinking…");
    try {
      await live.agent.sendAndWait(prompt, TURN_TIMEOUT_MS);
    } catch (err) {
      await live.agent.abort().catch(() => undefined);
      throw new Error(`Planning failed: ${msg(err)}`);
    }
    const plan = live.holder.plan;
    if (!plan) throw new Error("The agent finished without proposing a plan.");
    live.lastPlan = plan;
    this.emit(live.sessionId, "done", "Plan ready for your review.");
    return plan;
  }

  /** Write the SKILL.md into this app's own skill library; returns its path. */
  private exportSkill(skill: BuiltSkill): string {
    const root = skillsRoot();
    const name = slugifySkillName(skill.name);
    const prior = loadPersistedSkill(skill.sessionId);
    const priorDir = prior?.exportedPath ? path.dirname(prior.exportedPath) : null;
    // Re-install over the same folder only when it already lives under the install root;
    // a prior *export* (download) folder must not be reused here. Otherwise pick a fresh,
    // non-colliding directory so we never clobber an unrelated skill.
    const reuse = priorDir !== null && isInside(root, priorDir);
    let dir = reuse ? (priorDir as string) : path.join(root, name);
    if (!reuse && existsSync(dir)) {
      let n = 2;
      while (existsSync(path.join(root, `${name}-${n}`))) n++;
      dir = path.join(root, `${name}-${n}`);
    }
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "SKILL.md");
    writeFileSync(file, renderSkillMarkdown(skill));
    this.copyApiReference(skill, dir);
    return file;
  }

  /** Export (download) the SKILL.md into a user-picked folder as `<baseDir>/<name>/SKILL.md`;
   *  returns its path. Always picks a fresh, non-colliding subfolder within `baseDir`. */
  private exportSkillTo(skill: BuiltSkill, baseDir: string): string {
    const name = slugifySkillName(skill.name);
    let dir = path.join(baseDir, name);
    if (existsSync(dir)) {
      let n = 2;
      while (existsSync(path.join(baseDir, `${name}-${n}`))) n++;
      dir = path.join(baseDir, `${name}-${n}`);
    }
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "SKILL.md");
    writeFileSync(file, renderSkillMarkdown(skill));
    this.copyApiReference(skill, dir);
    return file;
  }

  /**
   * Copy the session's spec (+ its derived index) into `<skillDir>/api/`. An installed
   * skill has to keep working after the recording it came from is deleted, and a
   * copilot-studio bundle carries the spec so the maker can import it as a custom
   * connector — so the reference travels *with* the skill instead of being looked up
   * from the session at run time. Best effort: a failed copy leaves a valid SKILL.md
   * (the runner revalidates operations anyway), so it warns rather than failing the build.
   */
  private copyApiReference(skill: BuiltSkill, skillDir: string): void {
    if (!skill.apiReference) return;
    const source = sessionDir(skill.sessionId);
    const spec = specPath(source);
    if (!spec) return;
    try {
      const target = path.join(skillDir, API_BUNDLE_DIR);
      mkdirSync(target, { recursive: true });
      copyFileSync(spec, path.join(target, "openapi.json"));
      const index = indexPath(source);
      if (index) copyFileSync(index, path.join(target, "index.json"));
    } catch (err) {
      log.warn("could not copy the API reference into the skill folder:", msg(err));
    }
  }

  private persist(dir: string, skill: BuiltSkill): void {
    try {
      writeFileSync(path.join(dir, "skill.json"), JSON.stringify(skill, null, 2));
    } catch (err) {
      log.warn("failed to persist skill:", msg(err));
    }
  }
}

/** The distinct operation ids a plan's `api:` refs actually resolve to, in first-seen
 *  order. Unresolved refs are dropped here (they are warned about separately) — the
 *  pointer must only promise operations the stored spec really describes. */
function resolvedOperationIds(refs: readonly string[], operations: readonly ApiOperation[]): string[] {
  const ids: string[] = [];
  for (const raw of refs) {
    const ref = normalizeApiRef(raw);
    const op = ref ? findOperation(operations, ref) : null;
    if (op && !ids.includes(op.operationId)) ids.push(op.operationId);
  }
  return ids;
}

/** Render the final, user-edited plan into a compact spec the create turn builds from. */
function renderPlanForPrompt(plan: SkillPlan): string {
  const lines = [`Title: ${plan.title}`, `Name: ${plan.name}`, `Description: ${plan.description}`];
  if (plan.generalization) lines.push(`Generalization: ${plan.generalization}`);
  if (plan.values.length) {
    lines.push(
      "",
      "Values (reference each by its {{id}} token in the body — never write the literal value yourself):",
    );
    for (const v of plan.values) lines.push(`- {{${v.id}}}${v.name ? ` — ${v.name}` : ""}`);
  }
  if (plan.steps.length) {
    lines.push("", "Steps (in order):");
    plan.steps.forEach((s, idx) => {
      const head = [s.title, s.text].filter(Boolean).join(" — ");
      const bits = [`${idx + 1}. (${s.kind}) ${head}`];
      if (s.tool) bits.push(`[tool: ${s.tool}]`);
      lines.push(bits.join(" "));
    });
  }
  if (plan.allowedTools.length) lines.push("", `allowed-tools: ${plan.allowedTools.join(", ")}`);
  return lines.join("\n");
}

function renderRefinePrompt(feedback: string, prior: SkillPlan | null): string {
  const lines = [
    "The user reviewed your proposed plan and wants changes. Revise the plan and call",
    "propose_plan again (do not write the skill yet).",
    "",
  ];
  if (prior) {
    lines.push(`Current plan: ${prior.title} (${prior.name})`);
    lines.push(`- generalization: ${prior.generalization || "(none)"}`);
    if (prior.values.length) {
      lines.push(`- values: ${prior.values.map((v) => v.name || v.id).join(", ")}`);
    }
    lines.push("");
  }
  lines.push(`Their feedback: ${feedback}`);
  return lines.join("\n");
}
