import assert from "node:assert/strict";
import test from "node:test";

import {
  AutomationPlanSchema,
  BuiltAutomationSchema,
  planToAutomationSubmission,
  renderAutomationJson,
  toAutomationImport,
  toBuiltAutomation,
  type BuiltAutomation,
} from "./automation";

/**
 * The automation half of the retarget guard (see `skill.test.ts`). The architecture
 * enum is shared, so what matters here is that the automation schemas inherit the
 * migration — including through `plan`, which is nested inside a built automation —
 * and that the engine-owned `model` stays out of an export unless it is actually set.
 */

/** A `built-automation.json` exactly as the Scout-era build wrote it. */
const legacyBuiltAutomation = {
  version: 1,
  sessionId: "2026-07-01T09-00-00-000Z",
  kind: "automation",
  architecture: "scout",
  name: "daily-pr-nudge",
  description: "Nudge pull requests awaiting review.",
  triggerType: "schedule",
  schedule: { kind: "single", naturalLanguage: "every weekday at 9am", days: [1, 2, 3, 4, 5], time: { hour: 9, minute: 0 } },
  model: "",
  steps: [{ label: "List stale PRs", prompt: "Run gh pr list -R {{repo}} and keep the ones older than two days." }],
  values: [{ id: "repo", name: "Target repo", value: "acme/api" }],
  plan: {
    architecture: "scout",
    name: "daily-pr-nudge",
    title: "Nudge stale PRs",
    description: "Nudge pull requests awaiting review.",
    trigger: {
      type: "schedule",
      schedule: { kind: "single", naturalLanguage: "every weekday at 9am", days: [1, 2, 3, 4, 5], time: { hour: 9, minute: 0 } },
    },
    values: [{ id: "repo", name: "Target repo", value: "acme/api" }],
    steps: [{ label: "List stale PRs", prompt: "Run gh pr list -R {{repo}} and keep the ones older than two days." }],
  },
  createdAt: 1_780_000_000_000,
};

test("legacy architecture ids migrate through the automation schemas", () => {
  const plan = AutomationPlanSchema.parse({
    architecture: "cowork",
    name: "daily-digest",
    title: "Daily digest",
    description: "Post the morning digest.",
    trigger: { schedule: { kind: "single", time: { hour: 9, minute: 0 } } },
  });
  assert.equal(plan.architecture, "copilot-studio");

  const built = BuiltAutomationSchema.parse(legacyBuiltAutomation);
  assert.equal(built.architecture, "app");
  // The nested plan migrates too — same shared enum, same preprocess.
  assert.equal(built.plan?.architecture, "app");
  assert.equal(JSON.stringify(built).includes("scout"), false);
});

test("a legacy-architecture plan still converts into a submission", () => {
  const plan = AutomationPlanSchema.parse(legacyBuiltAutomation.plan);
  const submission = planToAutomationSubmission(plan);
  assert.equal(submission.name, "daily-pr-nudge");
  assert.equal(submission.triggerType, "schedule");
  assert.equal(submission.steps.length, 1);
  assert.equal(submission.model, "");
});

test("toAutomationImport omits a falsy model and substitutes value tokens", () => {
  const built = BuiltAutomationSchema.parse(legacyBuiltAutomation);
  const exported = toAutomationImport(built);
  assert.equal("model" in exported, false);
  assert.deepEqual(exported.steps, [
    { label: "List stale PRs", prompt: "Run gh pr list -R acme/api and keep the ones older than two days." },
  ]);
  // The mirrored top-level hour/minute the strict import schema wants.
  assert.deepEqual(exported.schedule, {
    kind: "single",
    naturalLanguage: "every weekday at 9am",
    days: [1, 2, 3, 4, 5],
    hour: 9,
    minute: 0,
    time: { hour: 9, minute: 0 },
  });
  assert.equal(renderAutomationJson(built).includes('"model"'), false);
});

test("toAutomationImport carries a model only when the engine set one", () => {
  const built: BuiltAutomation = { ...BuiltAutomationSchema.parse(legacyBuiltAutomation), model: "gpt-5.3-codex" };
  assert.equal(toAutomationImport(built).model, "gpt-5.3-codex");
});

test("a step's tool defaults to empty and round-trips through plan, submission and build", () => {
  // Plans written before the field existed (like the legacy fixture) still parse.
  const legacyPlan = AutomationPlanSchema.parse(legacyBuiltAutomation.plan);
  assert.equal(legacyPlan.steps[0].tool, "");

  const plan = AutomationPlanSchema.parse({
    ...legacyBuiltAutomation.plan,
    steps: [
      { label: "Create the order", prompt: "Create a sales order for each row.", tool: "api:createSalesOrder" },
      { label: "Report", prompt: "Summarize what was created." },
    ],
  });
  assert.deepEqual(plan.steps.map((s) => s.tool), ["api:createSalesOrder", ""]);

  const submission = planToAutomationSubmission(plan);
  assert.equal(submission.steps[0].tool, "api:createSalesOrder");
  const built = toBuiltAutomation("2026-08-01T09-00-00-000Z", "app", submission, plan);
  assert.equal(built.steps[0].tool, "api:createSalesOrder");
  assert.equal(BuiltAutomationSchema.parse(JSON.parse(JSON.stringify(built))).steps[0].tool, "api:createSalesOrder");
});

test("a step's tool is planning metadata and never reaches the import JSON", () => {
  const built = toBuiltAutomation(
    "2026-08-01T09-00-00-000Z",
    "app",
    planToAutomationSubmission(
      AutomationPlanSchema.parse({
        ...legacyBuiltAutomation.plan,
        steps: [{ label: "Create the order", prompt: "Create a sales order.", tool: "api:createSalesOrder" }],
      }),
    ),
    null,
  );
  assert.deepEqual(toAutomationImport(built).steps, [
    { label: "Create the order", prompt: "Create a sales order." },
  ]);
  assert.equal(renderAutomationJson(built).includes("api:createSalesOrder"), false);
});
