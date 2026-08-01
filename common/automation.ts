import { z } from "zod";

import { SkillArchitecture, slugifySkillName } from "./skill";
import { migrateLegacyInputsToValues, renderValues, ValueSchema } from "./values";

/**
 * The Automation Builder's contract — the automation-flavoured sibling of
 * `skill.ts`. From an *approved* {@link Analysis} the multi-turn builder agent
 * first proposes a **plan** ({@link AutomationPlan}) — a **trigger** (a schedule
 * it proposes, refinable in natural language) plus the generalized, ordered
 * **steps** (each a natural-language prompt to the target agent) — which the user
 * refines. On confirmation the agent submits the final **built automation**
 * ({@link BuiltAutomation}), which is rendered to the import JSON and written into a
 * bundle folder (the automation is imported from it; it is not auto-loaded like a
 * skill). Kept separate from `analysis.ts` (the builder's *input*); this is the
 * builder's *output*.
 *
 * The recorder-side schedule carries three kinds but omits the redundant top-level
 * `hour`/`minute` mirror the import schema also carries — the renderer fills that in
 * {@link renderAutomationJson} so the emitted JSON validates against a strict
 * importer without relying on its import-time schedule migration.
 */

/** A wall-clock time of day, 24-hour. */
export const TimeOfDaySchema = z.object({
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59),
});
export type TimeOfDay = z.infer<typeof TimeOfDaySchema>;

/** Days of the week the schedule fires on (0 = Sunday … 6 = Saturday). */
export const DaysSchema = z.array(z.number().int().min(0).max(6));

/** The generated schedule. One of the three kinds; `naturalLanguage` is the
 *  human phrasing shown in the plan and refined by the user. */
export const AutomationScheduleSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("single"),
    naturalLanguage: z.string().default(""),
    days: DaysSchema.default([]),
    /** The single time of day it runs. */
    time: TimeOfDaySchema,
  }),
  z.object({
    kind: z.literal("interval"),
    naturalLanguage: z.string().default(""),
    days: DaysSchema.default([]),
    /** Minutes between runs; must divide a day (1440) evenly. */
    intervalMinutes: z
      .number()
      .int()
      .positive()
      .refine((m) => m <= 1440 && 1440 % m === 0, {
        message: "intervalMinutes must divide 1440 evenly",
      }),
    /** The first run of the day (the interval anchor). */
    anchor: TimeOfDaySchema,
  }),
  z.object({
    kind: z.literal("multi"),
    naturalLanguage: z.string().default(""),
    days: DaysSchema.default([]),
    /** Two or more times of day it runs. */
    times: z.array(TimeOfDaySchema).min(1),
  }),
]);
export type AutomationSchedule = z.infer<typeof AutomationScheduleSchema>;

/** How an automation is triggered. `schedule` is always present (for condition
 *  triggers it is the check cadence); `condition` gates a run when set. */
export const AutomationTriggerType = z.enum(["schedule", "condition"]);
export type AutomationTriggerType = z.infer<typeof AutomationTriggerType>;

export const AutomationTriggerSchema = z.object({
  type: AutomationTriggerType.default("schedule"),
  schedule: AutomationScheduleSchema,
  /** Natural-language condition to check before running (condition triggers only). */
  condition: z.string().default(""),
  /** How often (minutes) to re-check the condition. */
  conditionCheckInterval: z.number().int().positive().optional(),
});
export type AutomationTrigger = z.infer<typeof AutomationTriggerSchema>;

/** One generalized step of the automation: a short label + the NL prompt the agent runs. */
export const AutomationStepDraftSchema = z.object({
  /** Short label for the step, e.g. "Collect new leads". */
  label: z.string().default(""),
  /** The natural-language instruction to the target agent for this step. */
  prompt: z.string(),
  /**
   * The capability this step uses — in practice an `api:<operationId>` reference into an
   * attached API reference (see `common/api-reference.ts`), which the builders lint
   * against the index. Planning metadata only: the prompt still has to say what to do, so
   * this is deliberately NEVER emitted into the import JSON ({@link toAutomationImport}).
   */
  tool: z.string().default(""),
});
export type AutomationStepDraft = z.infer<typeof AutomationStepDraftSchema>;

/**
 * The agent's proposed plan, shown to the user before any automation is written.
 * This is what `propose_automation_plan` submits and what the user refines in NL.
 */
export const AutomationPlanSchema = z.preprocess(
  migrateLegacyInputsToValues,
  z.object({
  /** Target architecture this plan is written for. */
  architecture: SkillArchitecture,
  /** kebab-case automation id, e.g. "daily-lead-digest". */
  name: z.string().transform(slugifySkillName),
  /** Human-friendly title, e.g. "Daily lead digest". */
  title: z.string(),
  /** What the automation does (becomes the automation `description`). */
  description: z.string(),
  /** Plain-language summary of what it does. */
  summary: z.string().default(""),
  /** How the recorded specifics are generalized into a repeatable procedure. */
  generalization: z.string().default(""),
  /** The proposed trigger (schedule + optional condition). */
  trigger: AutomationTriggerSchema,
  /** Named fixed literals (URLs / paths / constants) the step prompts reference by
   *  `{{id}}`; substituted deterministically at export. */
  values: z.array(ValueSchema).default([]),
  /** The generalized procedure, as ordered label + prompt steps. */
  steps: z.array(AutomationStepDraftSchema).default([]),
  /**
   * Engine-owned model selection, kept in the schema so plans persisted before it
   * became engine-owned still parse. Semantics per target: **omitted** for
   * `copilot-studio` (the maker's agent owns its model — {@link toAutomationImport}
   * drops it when falsy); for `app`, an optional Foundry **deployment name** reserved
   * for the in-app runner. The builder agent no longer proposes it.
   */
  model: z.string().default(""),
  /** Built-in skills the steps rely on (for the user's awareness). */
  skillNames: z.array(z.string()).default([]),
  }),
);
export type AutomationPlan = z.infer<typeof AutomationPlanSchema>;

/**
 * The payload the agent submits via `submit_automation` once the plan is approved.
 * The engine renders this into the import JSON and wraps it into a
 * {@link BuiltAutomation}.
 */
export const AutomationSubmissionSchema = z.object({
  /** kebab-case automation id. */
  name: z.string().transform(slugifySkillName),
  /** The automation `description`. */
  description: z.string().default(""),
  triggerType: AutomationTriggerType.default("schedule"),
  schedule: AutomationScheduleSchema,
  condition: z.string().default(""),
  conditionCheckInterval: z.number().int().positive().optional(),
  /** Engine-owned; see {@link AutomationPlanSchema}'s `model`. Usually empty. */
  model: z.string().default(""),
  /** Fixed values substituted into the step prompts at export (the pill literals). */
  values: z.array(ValueSchema).default([]),
  /** The generalized, ordered steps (each an NL prompt). */
  steps: z.array(AutomationStepDraftSchema).min(1),
});
export type AutomationSubmission = z.infer<typeof AutomationSubmissionSchema>;

/** The full, persisted result of an automation build for a session. */
export const BuiltAutomationSchema = z.object({
  version: z.literal(1),
  sessionId: z.string(),
  kind: z.literal("automation"),
  architecture: SkillArchitecture,
  name: z.string(),
  description: z.string().default(""),
  triggerType: AutomationTriggerType,
  schedule: AutomationScheduleSchema,
  condition: z.string().default(""),
  conditionCheckInterval: z.number().int().positive().optional(),
  /** Engine-owned; see {@link AutomationPlanSchema}'s `model`. Usually empty. */
  model: z.string().default(""),
  steps: z.array(AutomationStepDraftSchema),
  /** Fixed values substituted into the step prompts at export (the pill literals). */
  values: z.array(ValueSchema).default([]),
  /** The plan the automation was built from (for the UI / re-export). */
  plan: AutomationPlanSchema.nullable().default(null),
  createdAt: z.number(),
  /** Absolute path of the exported automation.json, once exported. */
  exportedPath: z.string().optional(),
  exportedAt: z.number().optional(),
});
export type BuiltAutomation = z.infer<typeof BuiltAutomationSchema>;

/** Build a full BuiltAutomation from an agent submission + engine-managed fields. */
export function toBuiltAutomation(
  sessionId: string,
  architecture: SkillArchitecture,
  submission: AutomationSubmission,
  plan: AutomationPlan | null,
): BuiltAutomation {
  return BuiltAutomationSchema.parse({
    version: 1,
    sessionId,
    kind: "automation",
    architecture,
    name: slugifySkillName(submission.name),
    description: submission.description,
    triggerType: submission.triggerType,
    schedule: submission.schedule,
    condition: submission.condition,
    conditionCheckInterval: submission.conditionCheckInterval,
    model: submission.model,
    steps: submission.steps,
    values: submission.values,
    plan,
    createdAt: Date.now(),
  });
}

/** Build an {@link AutomationSubmission} directly from a (user-edited) plan. The plan
 *  fully determines the bundle, so create can skip a second agent turn and honor the
 *  reviewed tiles exactly. Throws if the plan has no steps (a bundle needs ≥1). */
export function planToAutomationSubmission(plan: AutomationPlan): AutomationSubmission {
  return AutomationSubmissionSchema.parse({
    name: plan.name,
    description: plan.description,
    triggerType: plan.trigger.type,
    schedule: plan.trigger.schedule,
    condition: plan.trigger.condition,
    conditionCheckInterval: plan.trigger.conditionCheckInterval,
    model: plan.model,
    values: plan.values,
    steps: plan.steps,
  });
}

/** The primary time of day for a schedule — the value mirrored into the
 *  schedule's top-level `hour`/`minute`. */
function primaryTime(schedule: AutomationSchedule): TimeOfDay {
  switch (schedule.kind) {
    case "single":
      return schedule.time;
    case "interval":
      return schedule.anchor;
    case "multi":
      return schedule.times[0];
  }
}

/** Convert a recorder schedule into the strict import schedule shape (adds the
 *  redundant top-level `hour`/`minute` mirror the import schema requires). */
function scheduleToImport(schedule: AutomationSchedule): Record<string, unknown> {
  const t = primaryTime(schedule);
  const base = {
    naturalLanguage: schedule.naturalLanguage,
    days: schedule.days,
    hour: t.hour,
    minute: t.minute,
  };
  switch (schedule.kind) {
    case "single":
      return { kind: "single", ...base, time: schedule.time };
    case "interval":
      return { kind: "interval", ...base, intervalMinutes: schedule.intervalMinutes, anchor: schedule.anchor };
    case "multi":
      return { kind: "multi", ...base, times: schedule.times };
  }
}

/**
 * Shape a {@link BuiltAutomation} into the plain object the importer accepts
 * (`workingDir`/`skillNames` are injected at import time from the bundle context, so
 * they are intentionally omitted here). `model` is engine-owned and only travels when
 * it is actually set — a Copilot Studio bundle never carries one.
 */
export function toAutomationImport(a: BuiltAutomation): Record<string, unknown> {
  const obj: Record<string, unknown> = {
    name: slugifySkillName(a.name),
    description: a.description,
    triggerType: a.triggerType,
    schedule: scheduleToImport(a.schedule),
    steps: a.steps.map((s) => ({
      label: renderValues(s.label, a.values),
      prompt: renderValues(s.prompt, a.values),
    })),
  };
  if (a.triggerType === "condition" && a.condition) obj.condition = a.condition;
  if (a.conditionCheckInterval) obj.conditionCheckInterval = a.conditionCheckInterval;
  if (a.model) obj.model = a.model;
  return obj;
}

/** Render a {@link BuiltAutomation} to the `automation.json` text the bundle carries. */
export function renderAutomationJson(a: BuiltAutomation): string {
  return JSON.stringify(toAutomationImport(a), null, 2) + "\n";
}

/** A human one-liner describing a schedule, for the plan/done UI. */
export function describeSchedule(schedule: AutomationSchedule): string {
  if (schedule.naturalLanguage.trim()) return schedule.naturalLanguage.trim();
  const t = primaryTime(schedule);
  const time = `${String(t.hour).padStart(2, "0")}:${String(t.minute).padStart(2, "0")}`;
  switch (schedule.kind) {
    case "single":
      return `Once a day at ${time}`;
    case "interval":
      return `Every ${schedule.intervalMinutes} min from ${time}`;
    case "multi":
      return `${schedule.times.length}× a day`;
  }
}
