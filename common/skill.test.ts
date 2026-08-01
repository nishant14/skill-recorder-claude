import assert from "node:assert/strict";
import test from "node:test";

import {
  ARCHITECTURES,
  BuiltSkillSchema,
  renderSkillMarkdown,
  SkillArchitecture,
  SkillPlanSchema,
  SkillSubmissionSchema,
  TARGETS,
  toBuiltSkill,
} from "./skill";

/**
 * Guards the retarget from the Scout/Cowork era to `app` / `copilot-studio`. The
 * migration is the load-bearing part: every `skill.json` written before the retarget
 * carries an old architecture id, and it has to keep parsing — through the plan
 * schema, the built-skill schema, AND the plan nested inside a built skill.
 */

/** A `skill.json` exactly as the Scout-era build wrote it. */
const legacyBuiltSkill = {
  version: 1,
  sessionId: "2026-07-01T09-00-00-000Z",
  architecture: "scout",
  name: "triage-bug-issues",
  description: "Triage new unassigned bug issues in a repo.",
  allowedTools: ["Bash(gh *)"],
  body: "## When to use\n\nWhen new bug issues need triage.",
  values: [{ id: "repo", name: "Target repo", value: "acme/api" }],
  plan: {
    architecture: "scout",
    name: "triage-bug-issues",
    title: "Triage bug issues",
    description: "Triage new unassigned bug issues in a repo.",
    values: [{ id: "repo", name: "Target repo", value: "acme/api" }],
    steps: [{ kind: "action", title: "Comment", text: "Comment on each issue in {{repo}}.", tool: "Bash(gh *)" }],
    allowedTools: ["Bash(gh *)"],
  },
  createdAt: 1_780_000_000_000,
};

test("legacy architecture ids migrate through every schema that references the enum", () => {
  assert.equal(SkillArchitecture.parse("scout"), "app");
  assert.equal(SkillArchitecture.parse("cowork"), "copilot-studio");

  const plan = SkillPlanSchema.parse({
    architecture: "cowork",
    name: "post-digest",
    title: "Post a digest",
    description: "Post the morning digest.",
  });
  assert.equal(plan.architecture, "copilot-studio");

  const built = BuiltSkillSchema.parse(legacyBuiltSkill);
  assert.equal(built.architecture, "app");
  // The nested plan is migrated too — it goes through the same shared enum.
  assert.equal(built.plan?.architecture, "app");
});

test("current architecture ids pass through and unknown ones still fail", () => {
  assert.equal(SkillArchitecture.parse("app"), "app");
  assert.equal(SkillArchitecture.parse("copilot-studio"), "copilot-studio");

  assert.equal(SkillArchitecture.safeParse("cowork-studio").success, false);
  assert.equal(SkillArchitecture.safeParse("").success, false);
  // Non-strings pass the preprocess untouched so the enum reports the real error.
  assert.equal(SkillArchitecture.safeParse(7).success, false);
  assert.equal(SkillArchitecture.safeParse(null).success, false);
});

test("migration never leaks a legacy id back into a parsed artifact", () => {
  const built = BuiltSkillSchema.parse(legacyBuiltSkill);
  const serialized = JSON.stringify(built);
  assert.equal(serialized.includes("scout"), false);
  assert.equal(serialized.includes("cowork"), false);
});

test("TARGETS and ARCHITECTURES stay consistent with the enum", () => {
  const ids = ARCHITECTURES.map((a) => a.id);
  assert.deepEqual(ids, ["app", "copilot-studio"]);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(
    ARCHITECTURES.every((a) => a.enabled && a.label.trim() && a.note.trim()),
    true,
  );

  assert.equal(TARGETS.length, 4);
  assert.equal(TARGETS.every((t) => t.enabled), true);
  for (const target of TARGETS) {
    assert.equal(SkillArchitecture.safeParse(target.architecture).success, true);
    assert.equal(ids.includes(target.architecture), true);
    assert.equal(["skill", "automation"].includes(target.kind), true);
    assert.ok(target.label.trim() && target.note.trim());
  }
  // Every (kind, architecture) pair appears exactly once.
  const pairs = TARGETS.map((t) => `${t.kind}:${t.architecture}`);
  assert.equal(new Set(pairs).size, TARGETS.length);
});

/* --- API grounding (Workstream J) ------------------------------------------ */

/**
 * `apiReference` is the pointer the Workstream H runner reads, and it is **engine-owned**:
 * every skill written before J parses with it absent, the model has no way to supply one
 * (it isn't part of the submission the agent fills in), and what the builder passes in
 * survives a JSON round-trip unchanged.
 */
test("apiReference defaults to null so pre-J skill.json files still parse", () => {
  const built = BuiltSkillSchema.parse(legacyBuiltSkill);
  assert.equal(built.apiReference, null);
  // Explicit null is the same as absent — the builder writes one for un-grounded skills.
  assert.equal(BuiltSkillSchema.parse({ ...legacyBuiltSkill, apiReference: null }).apiReference, null);
});

test("apiReference is engine-owned — a submission can never carry one", () => {
  const submission = SkillSubmissionSchema.parse({
    name: "Create sales order",
    description: "Create a sales order for a customer.",
    allowedTools: ["api:createSalesOrder"],
    body: "## Steps\n\nCall createSalesOrder.",
    // What a model might try to smuggle in; the submission schema has no such field.
    apiReference: { operations: ["deleteEverything"], specFile: "/etc/passwd" },
  });
  assert.equal("apiReference" in submission, false);

  // Without the engine's argument the built skill is un-grounded, whatever the agent sent.
  const ungrounded = toBuiltSkill("s1", "app", submission, null);
  assert.equal(ungrounded.apiReference, null);

  const grounded = toBuiltSkill("s1", "app", submission, null, {
    operations: ["createSalesOrder", "listCustomers"],
    specFile: "api/openapi.json",
  });
  assert.deepEqual(grounded.apiReference, {
    operations: ["createSalesOrder", "listCustomers"],
    specFile: "api/openapi.json",
  });
});

test("apiReference round-trips through persistence unchanged", () => {
  const built = BuiltSkillSchema.parse({
    ...legacyBuiltSkill,
    apiReference: { operations: ["createSalesOrder"], specFile: "api/openapi.json" },
  });
  const reparsed = BuiltSkillSchema.parse(JSON.parse(JSON.stringify(built)));
  assert.deepEqual(reparsed.apiReference, built.apiReference);
  // `operations` may be empty (refs that resolved to nothing were dropped) but the
  // pointer still has to say where the spec is, so `specFile` is required.
  assert.deepEqual(
    BuiltSkillSchema.parse({ ...legacyBuiltSkill, apiReference: { specFile: "api/openapi.json" } })
      .apiReference,
    { operations: [], specFile: "api/openapi.json" },
  );
  assert.equal(
    BuiltSkillSchema.safeParse({ ...legacyBuiltSkill, apiReference: { operations: ["x"] } }).success,
    false,
  );
});

test("the API reference never leaks into the rendered SKILL.md frontmatter", () => {
  const skill = BuiltSkillSchema.parse({
    ...legacyBuiltSkill,
    apiReference: { operations: ["createSalesOrder"], specFile: "api/openapi.json" },
  });
  assert.equal(renderSkillMarkdown(skill).includes("apiReference"), false);
});

test("renderSkillMarkdown is byte-stable — the SKILL.md format is unchanged by the retarget", () => {
  const skill = BuiltSkillSchema.parse({
    ...legacyBuiltSkill,
    description: 'Triage bugs: comment, then label "needs-info".',
    body: "## When to use\n\nWhen new bug issues need triage in {{repo}}.\n",
  });
  const expected = [
    "---",
    "name: triage-bug-issues",
    'description: "Triage bugs: comment, then label \\"needs-info\\"."',
    "allowed-tools:",
    "  - Bash(gh *)",
    "---",
    "",
    "## When to use",
    "",
    "When new bug issues need triage in acme/api.",
    "",
  ].join("\n");
  assert.equal(renderSkillMarkdown(skill), expected);
});
