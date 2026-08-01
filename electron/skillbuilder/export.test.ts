import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { BuiltSkillSchema, type BuiltSkill } from "../../common/skill";
import { writeReference } from "../builders/api-reference-store";
import { SkillBuilder } from "./builder";

/**
 * The **export copy path**: a skill whose plan is grounded on an attached API spec must
 * carry that spec with it, because the session it came from can be deleted the minute
 * after the skill is installed, and a copilot-studio bundle has to hand the maker
 * something to import as a custom connector.
 *
 * Both placement methods are private (the public `create()` needs a live model turn, which
 * is gate GJ's job, not a unit test's), so they are called directly through a cast — the
 * point under test is the file layout, and nothing else in the class is exercised: this
 * SkillBuilder never starts a Foundry client.
 */

/** Matches our own id shape, and passes `isValidSessionId`'s traversal guard. */
const SESSION_ID = "20260801-090000-abc123";

const SPEC = {
  openapi: "3.0.3",
  info: { title: "Sales API", version: "1.0" },
  paths: {
    "/sales/orders": { post: { operationId: "createSalesOrder", summary: "Create an order" } },
    "/customers": { get: { operationId: "listCustomers", summary: "List customers" } },
  },
};

function builtSkill(apiReference: BuiltSkill["apiReference"]): BuiltSkill {
  return BuiltSkillSchema.parse({
    version: 1,
    sessionId: SESSION_ID,
    architecture: "app",
    name: "create-sales-order",
    description: "Create a sales order for a customer.",
    allowedTools: ["api:createSalesOrder"],
    body: "## Steps\n\nCall createSalesOrder with the customer and items.",
    values: [],
    plan: null,
    apiReference,
    createdAt: Date.now(),
  });
}

/** A temp sessions root + skills root, with the reference already attached. */
function withDirs(
  attachSpec: boolean,
  run: (ctx: { skills: string; exports: string; builder: SkillBuilder }) => void,
): void {
  const sessions = mkdtempSync(path.join(tmpdir(), "sr-export-sessions-"));
  const skills = mkdtempSync(path.join(tmpdir(), "sr-export-skills-"));
  const exports = mkdtempSync(path.join(tmpdir(), "sr-export-dl-"));
  const priorSessions = process.env.SKILL_RECORDER_SESSIONS_DIR;
  const priorSkills = process.env.SKILL_RECORDER_SKILLS_DIR;
  process.env.SKILL_RECORDER_SESSIONS_DIR = sessions;
  process.env.SKILL_RECORDER_SKILLS_DIR = skills;
  try {
    const dir = path.join(sessions, SESSION_ID);
    mkdirSync(dir, { recursive: true });
    if (attachSpec) writeReference(dir, { spec: SPEC });
    run({ skills, exports, builder: new SkillBuilder(() => undefined) });
  } finally {
    if (priorSessions === undefined) delete process.env.SKILL_RECORDER_SESSIONS_DIR;
    else process.env.SKILL_RECORDER_SESSIONS_DIR = priorSessions;
    if (priorSkills === undefined) delete process.env.SKILL_RECORDER_SKILLS_DIR;
    else process.env.SKILL_RECORDER_SKILLS_DIR = priorSkills;
    for (const d of [sessions, skills, exports]) rmSync(d, { recursive: true, force: true });
  }
}

type ExportMethods = {
  exportSkill(skill: BuiltSkill): string;
  exportSkillTo(skill: BuiltSkill, baseDir: string): string;
};

test("an installed grounded skill carries the spec and its index", () => {
  withDirs(true, ({ builder }) => {
    const file = (builder as unknown as ExportMethods).exportSkill(
      builtSkill({ operations: ["createSalesOrder"], specFile: "api/openapi.json" }),
    );
    const dir = path.dirname(file);
    assert.equal(existsSync(file), true);
    // The pointer in `apiReference.specFile` has to name a file that is really there.
    const spec = path.join(dir, "api", "openapi.json");
    assert.equal(existsSync(spec), true);
    assert.equal(JSON.parse(readFileSync(spec, "utf8")).info.title, "Sales API");
    const index = JSON.parse(readFileSync(path.join(dir, "api", "index.json"), "utf8"));
    assert.deepEqual(
      index.operations.map((o: { operationId: string }) => o.operationId).sort(),
      ["createSalesOrder", "listCustomers"],
    );
  });
});

test("an exported (downloaded) grounded skill carries the spec too", () => {
  withDirs(true, ({ builder, exports }) => {
    const file = (builder as unknown as ExportMethods).exportSkillTo(
      builtSkill({ operations: ["createSalesOrder"], specFile: "api/openapi.json" }),
      exports,
    );
    assert.equal(existsSync(path.join(path.dirname(file), "api", "openapi.json")), true);
  });
});

test("an un-grounded skill exports no api/ folder, even with a spec attached", () => {
  withDirs(true, ({ builder }) => {
    const file = (builder as unknown as ExportMethods).exportSkill(builtSkill(null));
    assert.equal(existsSync(path.join(path.dirname(file), "api")), false);
  });
});

test("a grounded skill whose session lost its spec still exports a valid SKILL.md", () => {
  withDirs(false, ({ builder }) => {
    const file = (builder as unknown as ExportMethods).exportSkill(
      builtSkill({ operations: ["createSalesOrder"], specFile: "api/openapi.json" }),
    );
    assert.equal(readFileSync(file, "utf8").startsWith("---\nname: create-sales-order"), true);
    assert.equal(existsSync(path.join(path.dirname(file), "api")), false);
  });
});
