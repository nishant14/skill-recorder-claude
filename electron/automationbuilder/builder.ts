import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { collectApiRefs, unresolvedApiOperations } from "../../common/api-reference";
import {
  AutomationPlanSchema,
  BuiltAutomationSchema,
  planToAutomationSubmission,
  renderAutomationJson,
  toBuiltAutomation,
  type AutomationPlan,
  type AutomationSubmission,
  type BuiltAutomation,
} from "../../common/automation";
import type { AutomationBuildInput, AutomationBuildProgress } from "../../common/ipc";
import { slugifySkillName, type SkillArchitecture } from "../../common/skill";
import { AgentBuilder, type BaseLive } from "../builders/agent-builder";
import { loadIndex, loadReference, specPath } from "../builders/api-reference-store";
import { createApiReferenceTools, renderApiReferenceBrief } from "../builders/api-reference-tools";
import { createReadTools } from "../builders/read-tools";
import { loadPersistedAnalysis } from "../describer/describer";
import type { FoundrySession } from "../foundry/agent";
import { createLogger } from "../logger";
import { isValidSessionId, sessionDir } from "../recorder/session-store";
import { AUTOMATION_BUILDER_INSTRUCTIONS } from "./instructions";
import { automationCatalogueFor } from "./app-automation-catalog";
import { createAutomationBuilderTools } from "./tools";

const log = createLogger("AutomationBuilder");

const TURN_TIMEOUT_MS = 180_000;

/** Folder inside an exported bundle that carries the copied API reference. */
const API_BUNDLE_DIR = "api";

const KICKOFF_PROMPT =
  "Read get_analysis (and get_timeline where the tool mapping or schedule needs evidence), then call " +
  "propose_automation_plan with how you'll generalize this task, a sensible default schedule, and the " +
  "generalized prompt-steps. Stop after propose_automation_plan so the user can review it.";

const msg = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * This app's own automation library — where a built bundle lands and where the in-app
 * scheduler (Workstream H) will pick automations up. Overridable for dev/tests.
 */
function automationsRoot(): string {
  const override = process.env.SKILL_RECORDER_AUTOMATIONS_DIR;
  if (override) return path.resolve(override);
  return path.join(os.homedir(), ".skill-recorder", "automations");
}

interface LiveBuild extends BaseLive {
  sessionDir: string;
  architecture: SkillArchitecture;
  agent: FoundrySession;
  holder: { plan: AutomationPlan | undefined };
  /** Last plan proposed this build (kept so create can reference it). */
  lastPlan: AutomationPlan | null;
}

function readJson<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Load a previously built + persisted automation for a session, if any. */
export function loadPersistedAutomation(sessionId: string): BuiltAutomation | null {
  if (!isValidSessionId(sessionId)) return null;
  const raw = readJson<unknown>(path.join(sessionDir(sessionId), "built-automation.json"));
  if (!raw) return null;
  const parsed = BuiltAutomationSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Drives the multi-turn Foundry Codex agent that turns a recording's analysis
 * into a generalized **automation** (a trigger + ordered prompt-steps). Shares the
 * {@link AgentBuilder} pool (one live conversation per recording) so the plan →
 * refine → create flow stays in a single session. Streams progress out via a callback
 * and writes a bundle (automation.json) into this app's automation library.
 */
export class AutomationBuilder extends AgentBuilder<LiveBuild> {
  constructor(private readonly emitProgress: (p: AutomationBuildProgress) => void) {
    super("AutomationBuilder");
  }

  /** Propose a plan (first pass) or refine the current one with NL feedback. */
  async build(input: AutomationBuildInput): Promise<AutomationPlan> {
    const { sessionId, architecture, feedback } = input;
    if (this.active.has(sessionId)) throw new Error("A build is already running for this session.");
    if (!automationCatalogueFor(architecture)) {
      throw new Error("That target architecture isn't available yet. Choose the app or Copilot Studio.");
    }
    const analysis = loadPersistedAnalysis(sessionId);
    if (!analysis) throw new Error("There is no analysis for this recording yet.");

    this.active.add(sessionId);
    try {
      const refining = Boolean(feedback && feedback.trim());
      this.emit(sessionId, "start", refining ? "Refining the plan…" : "Planning the automation…");
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

  /** Finalize the user-edited plan into an automation bundle and export it. The reviewed
   *  plan fully determines the bundle, so this is deterministic — no agent turn. Each step
   *  prompt's `{{id}}` value tokens are substituted for their literals at render time
   *  ({@link toAutomationImport}), so what the user reviewed is exactly what ships. Throws
   *  if the plan has no steps (a bundle needs ≥1). */
  async create(sessionId: string, editedPlan?: AutomationPlan): Promise<{ automation: BuiltAutomation; path: string }> {
    if (this.active.has(sessionId)) throw new Error("Wait for the current step to finish.");
    const held = this.live.get(sessionId);
    // Prefer the user's edited plan from the review tiles; fall back to the last
    // proposed plan for older callers that don't pass one.
    const plan = editedPlan ? AutomationPlanSchema.parse(editedPlan) : held?.lastPlan ?? null;
    if (!plan) throw new Error("There is no plan to build from yet.");
    // The reviewed tiles are the whole payload: validate ≥1 step and carry the
    // trigger/schedule/name/description/model/values verbatim. No second agent turn.
    let submission: AutomationSubmission;
    try {
      submission = planToAutomationSubmission(plan);
    } catch {
      throw new Error("Add at least one step before you create the automation.");
    }
    const dir = sessionDir(sessionId);
    // The agent is hard-rejected at propose time, but the plan the user edited is
    // authoritative — they may know an operation this reference doesn't describe. Warn,
    // never fail; the runner revalidates when it actually calls the API.
    const unknownOperations = unresolvedApiOperations(
      collectApiRefs(submission.steps),
      loadIndex(dir)?.operations ?? [],
    );
    if (unknownOperations.length) {
      log.warn(`plan references API operations the attached reference doesn't have: ${unknownOperations.join(", ")}`);
    }
    if (held) held.lastPlan = plan;

    this.active.add(sessionId);
    try {
      this.emit(sessionId, "drafting", "Writing the automation…");
      const built = toBuiltAutomation(sessionId, plan.architecture, submission, plan);
      const exportPath = this.exportAutomation(built);
      const finalAutomation: BuiltAutomation = { ...built, exportedPath: exportPath, exportedAt: Date.now() };
      this.persist(dir, finalAutomation);
      // Both targets land in the app's automation library; only the copilot-studio one
      // is a bundle the user then takes somewhere else.
      const verb = plan.architecture === "copilot-studio" ? "exported to" : "saved to";
      this.emit(sessionId, "done", `Automation ${verb} ${exportPath}`);
      return { automation: finalAutomation, path: exportPath };
    } finally {
      this.active.delete(sessionId);
    }
  }

  // --- internals -----------------------------------------------------------

  private emit(sessionId: string, phase: AutomationBuildProgress["phase"], message: string): void {
    this.emitProgress({ sessionId, phase, message });
  }

  private async createLive(sessionId: string, architecture: SkillArchitecture): Promise<LiveBuild> {
    const dir = sessionDir(sessionId);
    const analysis = loadPersistedAnalysis(sessionId);
    if (!analysis) throw new Error("There is no analysis for this recording yet.");

    const holder: LiveBuild["holder"] = { plan: undefined };
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
      ...createAutomationBuilderTools({
        architecture,
        apiIndex,
        onProgress: (m) => this.emit(sessionId, "working", m),
        onPlan: (p) => {
          holder.plan = p;
        },
      }),
    ];

    const catalogue = automationCatalogueFor(architecture) ?? "";
    // The API brief comes AFTER the catalogue: it narrows one application's steps onto
    // concrete operations, it does not replace the target's capability ladder.
    const reference = loadReference(dir);
    const apiBrief = reference
      ? renderApiReferenceBrief({ reference, architecture, kind: "automation" })
      : "";
    const systemContent = [AUTOMATION_BUILDER_INSTRUCTIONS, catalogue, apiBrief]
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

  private async runProposeTurn(live: LiveBuild, prompt: string): Promise<AutomationPlan> {
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

  /** Write the bundle (automation.json) into the automation library; returns its path. */
  private exportAutomation(automation: BuiltAutomation): string {
    const root = automationsRoot();
    const name = slugifySkillName(automation.name);
    const prior = loadPersistedAutomation(automation.sessionId);
    // Re-export to the same folder if this session already exported one; otherwise pick
    // a fresh, non-colliding directory so we never clobber an unrelated automation.
    let dir = prior?.exportedPath ? path.dirname(prior.exportedPath) : path.join(root, name);
    if (!prior?.exportedPath && existsSync(dir)) {
      let n = 2;
      while (existsSync(path.join(root, `${name}-${n}`))) n++;
      dir = path.join(root, `${name}-${n}`);
    }
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "automation.json");
    writeFileSync(file, renderAutomationJson(automation));
    this.copyApiReference(automation, dir);
    return file;
  }

  /**
   * A copilot-studio bundle carries the spec next to `automation.json`: the maker imports
   * it as a custom connector, which is what turns the steps' `api:` operations into
   * actions they can wire up. An app automation stays in this app, where the runner still
   * has the session's own reference, so it needs no copy. Best effort — a failed copy
   * leaves a valid bundle, so it warns rather than failing the export.
   */
  private copyApiReference(automation: BuiltAutomation, bundleDir: string): void {
    if (automation.architecture !== "copilot-studio") return;
    if (collectApiRefs(automation.steps).length === 0) return;
    const spec = specPath(sessionDir(automation.sessionId));
    if (!spec) return;
    try {
      const target = path.join(bundleDir, API_BUNDLE_DIR);
      mkdirSync(target, { recursive: true });
      copyFileSync(spec, path.join(target, "openapi.json"));
    } catch (err) {
      log.warn("could not copy the API reference into the automation bundle:", msg(err));
    }
  }

  private persist(dir: string, automation: BuiltAutomation): void {
    try {
      writeFileSync(path.join(dir, "built-automation.json"), JSON.stringify(automation, null, 2));
    } catch (err) {
      log.warn("failed to persist automation:", msg(err));
    }
  }
}

/** Render the current plan into a compact spec for the refine prompt (the propose turn). */
function renderRefinePrompt(feedback: string, prior: AutomationPlan | null): string {
  const lines = [
    "The user reviewed your proposed plan and wants changes. Revise the plan and call",
    "propose_automation_plan again (do not submit the automation yet).",
    "",
  ];
  if (prior) {
    lines.push(`Current plan: ${prior.title} (${prior.name})`);
    lines.push(`- generalization: ${prior.generalization || "(none)"}`);
    lines.push(`- trigger: ${prior.trigger.type}, schedule "${prior.trigger.schedule.naturalLanguage || "(unset)"}"`);
    if (prior.steps.length) {
      lines.push(`- steps: ${prior.steps.map((s) => s.label || s.prompt.slice(0, 32)).join("; ")}`);
    }
    lines.push("");
  }
  lines.push(`Their feedback: ${feedback}`);
  return lines.join("\n");
}
