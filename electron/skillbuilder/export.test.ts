import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { AGENT_ZIP_ENTRIES } from "../../common/declarative-agent";
import { BuiltSkillSchema, type BuiltSkill } from "../../common/skill";
import { writeReference } from "../builders/api-reference-store";
import { SkillBuilder, type IconRenderer } from "./builder";

/**
 * The **export copy path**: a skill whose plan is grounded on an attached API spec must
 * carry that spec with it, because the session it came from can be deleted the minute
 * after the skill is installed, and a copilot-studio bundle has to hand the maker
 * something to import as a custom connector. Plus gate GG ②: a copilot-studio export
 * also lays down the declarative agent bundle and its importable zip.
 *
 * Both placement methods are private (the public `create()` needs a live model turn, which
 * is gate GJ's job, not a unit test's), so they are called directly through a cast — the
 * point under test is the file layout, and nothing else in the class is exercised: this
 * SkillBuilder never starts a Foundry client.
 */

/** Matches our own id shape, and passes `isValidSessionId`'s traversal guard. */
const SESSION_ID = "20260801-090000-abc123";

/** `adm-zip` ships no type declarations (and is only a devDependency here), so it is
 *  required with the one method this file uses declared inline. */
const require = createRequire(import.meta.url);
const AdmZip = require("adm-zip") as new (file: string) => { getEntries(): { entryName: string }[] };

const SPEC = {
  openapi: "3.0.3",
  info: { title: "Sales API", version: "1.0" },
  paths: {
    "/sales/orders": { post: { operationId: "createSalesOrder", summary: "Create an order" } },
    "/customers": { get: { operationId: "listCustomers", summary: "List customers" } },
  },
};

function builtSkill(
  apiReference: BuiltSkill["apiReference"],
  over: Partial<BuiltSkill> = {},
): BuiltSkill {
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
    ...over,
  });
}

/** The same skill retargeted at Copilot Studio, with a plan the checklist can read. */
function copilotSkill(apiReference: BuiltSkill["apiReference"] = null): BuiltSkill {
  return builtSkill(apiReference, {
    architecture: "copilot-studio",
    allowedTools: apiReference
      ? ["Outlook.SendEmail", "api:createSalesOrder"]
      : ["Outlook.SendEmail"],
    body: "## Steps\n\nSend the order confirmation to {{recipient}}.",
    values: [{ id: "recipient", name: "Confirmation list", value: "orders@contoso.com" }],
    plan: {
      architecture: "copilot-studio",
      name: "create-sales-order",
      title: "Create a sales order",
      description: "Create a sales order for a customer.",
      summary: "",
      generalization: "",
      values: [{ id: "recipient", name: "Confirmation list", value: "orders@contoso.com" }],
      steps: [
        {
          kind: "action",
          title: "Confirm the order",
          text: "Email {{recipient}} once the order exists.",
          tool: "Outlook.SendEmail",
        },
      ],
      allowedTools: ["Outlook.SendEmail"],
    },
  });
}

/**
 * Icon seam stub: sharp's native binding is far too heavy for a unit test, and the point
 * here is the bundle's *shape*. It still writes real bytes so the zip has real entries.
 */
function stubIcons(): { renderIcon: IconRenderer; calls: { size: number; dest: string }[] } {
  const calls: { size: number; dest: string }[] = [];
  const renderIcon: IconRenderer = async (source, size, dest) => {
    assert.equal(existsSync(source), true, "the icon source must be a real file");
    calls.push({ size, dest: path.basename(dest) });
    writeFileSync(dest, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  };
  return { renderIcon, calls };
}

/** A temp sessions root + skills root, with the reference already attached. `run` is
 *  awaited: the placement methods are async now (the bundle path zips and renders icons),
 *  so the temp dirs must outlive the promise. */
async function withDirs(
  attachSpec: boolean,
  run: (ctx: {
    skills: string;
    exports: string;
    builder: SkillBuilder;
    icons: { size: number; dest: string }[];
  }) => Promise<void> | void,
): Promise<void> {
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
    const { renderIcon, calls } = stubIcons();
    await run({
      skills,
      exports,
      builder: new SkillBuilder(() => undefined, { renderIcon }),
      icons: calls,
    });
  } finally {
    if (priorSessions === undefined) delete process.env.SKILL_RECORDER_SESSIONS_DIR;
    else process.env.SKILL_RECORDER_SESSIONS_DIR = priorSessions;
    if (priorSkills === undefined) delete process.env.SKILL_RECORDER_SKILLS_DIR;
    else process.env.SKILL_RECORDER_SKILLS_DIR = priorSkills;
    for (const d of [sessions, skills, exports]) rmSync(d, { recursive: true, force: true });
  }
}

type ExportMethods = {
  exportSkill(skill: BuiltSkill): Promise<string>;
  exportSkillTo(skill: BuiltSkill, baseDir: string): Promise<string>;
};

test("an installed grounded skill carries the spec and its index", async () => {
  await withDirs(true, async ({ builder }) => {
    const file = await (builder as unknown as ExportMethods).exportSkill(
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

test("an exported (downloaded) grounded skill carries the spec too", async () => {
  await withDirs(true, async ({ builder, exports }) => {
    const file = await (builder as unknown as ExportMethods).exportSkillTo(
      builtSkill({ operations: ["createSalesOrder"], specFile: "api/openapi.json" }),
      exports,
    );
    assert.equal(existsSync(path.join(path.dirname(file), "api", "openapi.json")), true);
  });
});

test("an un-grounded skill exports no api/ folder, even with a spec attached", async () => {
  await withDirs(true, async ({ builder }) => {
    const file = await (builder as unknown as ExportMethods).exportSkill(builtSkill(null));
    assert.equal(existsSync(path.join(path.dirname(file), "api")), false);
  });
});

test("a grounded skill whose session lost its spec still exports a valid SKILL.md", async () => {
  await withDirs(false, async ({ builder }) => {
    const file = await (builder as unknown as ExportMethods).exportSkill(
      builtSkill({ operations: ["createSalesOrder"], specFile: "api/openapi.json" }),
    );
    assert.equal(readFileSync(file, "utf8").startsWith("---\nname: create-sales-order"), true);
    assert.equal(existsSync(path.join(path.dirname(file), "api")), false);
  });
});

test("a copilot-studio export writes the declarative agent bundle and its zip", async () => {
  await withDirs(false, async ({ builder, exports, icons }) => {
    const file = await (builder as unknown as ExportMethods).exportSkillTo(
      copilotSkill(),
      exports,
    );
    const dir = path.dirname(file);
    for (const name of ["declarativeAgent.json", "manifest.json", "connectors.md", "color.png", "outline.png"]) {
      assert.equal(existsSync(path.join(dir, name)), true, `${name} is missing`);
    }
    // The icon seam is called once per size, into the bundle's two icon files.
    assert.deepEqual(icons, [
      { size: 192, dest: "color.png" },
      { size: 32, dest: "outline.png" },
    ]);

    const agent = JSON.parse(readFileSync(path.join(dir, "declarativeAgent.json"), "utf8"));
    assert.equal(agent.version, "v1.2");
    assert.ok(agent.instructions.length <= 8000);
    // Values are substituted in the agent instructions exactly as in the SKILL.md.
    assert.ok(agent.instructions.includes("orders@contoso.com"));
    assert.equal(agent.instructions.includes("{{recipient}}"), false);

    const manifest = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8"));
    assert.equal(manifest.copilotAgents.declarativeAgents[0].file, "declarativeAgent.json");

    const connectors = readFileSync(path.join(dir, "connectors.md"), "utf8");
    assert.ok(connectors.includes("| Outlook | SendEmail |"));
    assert.equal(connectors.includes("## Custom connector"), false);

    // Gate GG ②: the importable zip, with exactly the four entries and nothing else.
    const zip = path.join(dir, "create-sales-order-agent.zip");
    assert.equal(existsSync(zip), true);
    const entries = new AdmZip(zip).getEntries().map((e) => e.entryName);
    assert.deepEqual(entries.sort(), [...AGENT_ZIP_ENTRIES].sort());
  });
});

test("an app-architecture export writes none of the bundle files", async () => {
  await withDirs(false, async ({ builder, icons }) => {
    const file = await (builder as unknown as ExportMethods).exportSkill(builtSkill(null));
    const dir = path.dirname(file);
    for (const name of [
      "declarativeAgent.json",
      "manifest.json",
      "connectors.md",
      "color.png",
      "outline.png",
      "create-sales-order-agent.zip",
    ]) {
      assert.equal(existsSync(path.join(dir, name)), false, `${name} should not exist`);
    }
    assert.deepEqual(icons, []);
  });
});

test("an API-grounded copilot-studio bundle points the maker at the custom connector", async () => {
  await withDirs(true, async ({ builder, exports }) => {
    const file = await (builder as unknown as ExportMethods).exportSkillTo(
      copilotSkill({ operations: ["createSalesOrder"], specFile: "api/openapi.json" }),
      exports,
    );
    const dir = path.dirname(file);
    const connectors = readFileSync(path.join(dir, "connectors.md"), "utf8");
    assert.ok(connectors.includes("## Custom connector"));
    assert.ok(connectors.includes("`api/openapi.json`"));
    assert.ok(connectors.includes("- `createSalesOrder`"));
    // The spec it points at really shipped, and the zip still carries only the four.
    assert.equal(existsSync(path.join(dir, "api", "openapi.json")), true);
    const entries = new AdmZip(path.join(dir, "create-sales-order-agent.zip"))
      .getEntries()
      .map((e) => e.entryName);
    assert.deepEqual(entries.sort(), [...AGENT_ZIP_ENTRIES].sort());
  });
});
