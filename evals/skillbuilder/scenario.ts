// Scenario model for the **skill builder** evals.
//
// A sibling of evals/builder/ (which guards the AutomationBuilder). This one guards
// the SkillBuilder — the stage that turns an approved analysis into a reusable
// SKILL.md plan. It exists to exercise the richer skill *plan* shape the builder now
// proposes: fixed **values** referenced from step text as `{{id}}` tokens, and an
// ordered list of typed `steps` (calculation vs action, each with its native tool and
// an optional confirmation pause). Like the automation harness, each scenario ships a
// FIXED approved analysis so a failure points at the builder, not the describer.

import type { AnalysisSubmission } from "../../common/analysis";
import type { SkillArchitecture } from "../../common/skill";

/**
 * Deterministic rubric for a proposed SkillPlan. Beyond the native-tool check the
 * automation harness does, it asserts the plan's *structure* — that genuinely fixed
 * literals are pulled out as `values` (and every `{{token}}` a step references resolves
 * to one), and that the procedure is split into calculations and actions.
 */
export interface SkillRubric {
  /**
   * Each group is a set of synonyms; the plan's steps (text + tool) or allowed-tools
   * must contain at least one member of every group (case-insensitive). Use it to
   * require the RIGHT native tool, e.g. [["gh "], ["gh issue", "gh api"]].
   */
  mustUseAny: string[][];
  /** None of these may appear in the steps or allowed-tools — signals of the WRONG tool. */
  forbidden: string[];
  /** The plan must declare at least this many fixed values. Default 0. */
  minValues?: number;
  /** The plan must contain at least this many `calculation` steps. Default 1. */
  minCalculations?: number;
  /** The plan must contain at least this many `action` steps. Default 1. */
  minActions?: number;
}

export interface SkillBuilderScenario {
  /** Slug used for the session id and result keys. */
  id: string;
  /** Human-readable title. */
  title: string;
  /** Which target agent's catalogue the builder generalizes against. */
  architecture: SkillArchitecture;
  /** The device OS the skill will run on (macOS or Windows). */
  platform: NodeJS.Platform;
  /** Ground-truth description of the task (for docs + humans reading failures). */
  truth: string;
  /** The approved analysis fed to the builder, exactly as the describer would emit it. */
  analysis: AnalysisSubmission;
  rubric: SkillRubric;
}
