import assert from "node:assert/strict";
import test from "node:test";

import {
  ARCHITECTURES,
  BuiltSkillSchema,
  renderSkillMarkdown,
  SkillArchitecture,
  SkillPlanSchema,
  TARGETS,
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
