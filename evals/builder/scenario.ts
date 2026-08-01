// Scenario model for the **builder** evals.
//
// Unlike the describer evals (which score how a recording is reconstructed), these
// score the *final stage*: how the builder GENERALIZES an approved analysis into a
// runnable artifact. The variance we care about here is native-tool choice — e.g.
// mapping GitHub work to the `gh` CLI instead of replaying github.com through the
// browser. To isolate the builder from describer variance, each scenario ships a
// FIXED analysis (as if the describer had produced it); the harness seeds it to
// disk and runs the real builder against it.

import type { AnalysisSubmission } from "../../common/analysis";
import type { SkillArchitecture } from "../../common/skill";

/** Deterministic rubric for a builder's generalized output (its step prompts). */
export interface BuilderRubric {
  /**
   * Each group is a set of synonyms; the built output must contain at least one
   * member of every group (case-insensitive). Use it to require the RIGHT native
   * tool, e.g. [["gh "], ["gh issue", "gh api"]].
   */
  mustUseAny: string[][];
  /**
   * None of these may appear in the built output (case-insensitive) — the signals
   * of the WRONG tool, e.g. replaying the UI ("playwright", "browser_", "click").
   */
  forbidden: string[];
}

export interface BuilderScenario {
  /** Slug used for the session id and result keys. */
  id: string;
  /** Human-readable title. */
  title: string;
  /** Which target agent's catalogue the builder generalizes against. */
  architecture: SkillArchitecture;
  /** The device OS the automation will run on (macOS or Windows). */
  platform: NodeJS.Platform;
  /** Ground-truth description of the task (for docs + humans reading failures). */
  truth: string;
  /** The approved analysis fed to the builder, exactly as the describer would emit it. */
  analysis: AnalysisSubmission;
  rubric: BuilderRubric;
}
