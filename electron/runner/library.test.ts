import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { BuiltSkillSchema, renderSkillMarkdown } from "../../common/skill";
import { deleteSkill, findInstalledSkill, listInstalledSkills, parseSkillMarkdown } from "./library";

/**
 * The runner's view of the skill library. Every case runs against a temp
 * `SKILL_RECORDER_SKILLS_DIR` that is restored afterwards — nothing here touches the
 * real library.
 *
 * The load-bearing case is the **round trip**: the only producer of these files is
 * `renderSkillMarkdown`, so the parser is tested against its actual output rather than
 * against a hand-written fixture that could drift from it. The rest defend tolerance —
 * a SKILL.md is a text file users are invited to edit, and a stray quote must not make
 * a skill unrunnable.
 */

interface Ctx {
  root: string;
  /** Write `<root>/<dir>/<file>` and return its absolute path. */
  write(dir: string, file: string, content: string): string;
}

function withSkills(body: (ctx: Ctx) => void): void {
  const root = mkdtempSync(path.join(tmpdir(), "sr-runner-library-"));
  const previous = process.env.SKILL_RECORDER_SKILLS_DIR;
  process.env.SKILL_RECORDER_SKILLS_DIR = root;
  try {
    body({
      root,
      write(dir, file, content) {
        const target = path.join(root, dir, file);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, content);
        return target;
      },
    });
  } finally {
    if (previous === undefined) delete process.env.SKILL_RECORDER_SKILLS_DIR;
    else process.env.SKILL_RECORDER_SKILLS_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

/** A SKILL.md exactly as the builder installs it. */
function rendered(name: string, description: string, allowedTools: string[], body: string): string {
  return renderSkillMarkdown(
    BuiltSkillSchema.parse({
      version: 1,
      sessionId: "20260801-090000-abc123",
      architecture: "app",
      name,
      description,
      allowedTools,
      body,
      values: [],
      plan: null,
      apiReference: null,
      createdAt: Date.now(),
    }),
  );
}

test("what renderSkillMarkdown writes is exactly what the runner reads back", () => {
  // A description carrying the characters that force the double-quoted scalar.
  const description = 'Create a "sales order": use when the user says invoice, order, or PO.';
  const text = rendered("create-sales-order", description, ["Bash(gh *)", "api:createSalesOrder"], "## Steps\n\n1. Do it.");

  const { frontmatter, body } = parseSkillMarkdown(text);
  assert.equal(frontmatter.name, "create-sales-order");
  assert.equal(frontmatter.description, description);
  assert.deepEqual(frontmatter.allowedTools, ["Bash(gh *)", "api:createSalesOrder"]);
  assert.equal(body, "## Steps\n\n1. Do it.");
});

test("hand-edited frontmatter still parses: bare and single-quoted scalars, odd spacing, CRLF", () => {
  const text = [
    "---",
    "name:   my-skill  ",
    "description: Run the nightly report, no quotes here",
    "allowed-tools:",
    "    - Bash(git status)",
    "  -   Read",
    "---",
    "",
    "Body line.",
  ].join("\r\n");

  const { frontmatter, body } = parseSkillMarkdown(text);
  assert.equal(frontmatter.name, "my-skill");
  assert.equal(frontmatter.description, "Run the nightly report, no quotes here");
  assert.deepEqual(frontmatter.allowedTools, ["Bash(git status)", "Read"]);
  assert.equal(body, "Body line.");

  const quoted = parseSkillMarkdown("---\nname: x\ndescription: 'It''s fine'\n---\nBody.");
  assert.equal(quoted.frontmatter.description, "It's fine");

  // Flow style is not what we emit, but an editor's autoformat produces it.
  const flow = parseSkillMarkdown('---\nname: x\nallowed-tools: [Read, "Bash(gh *)"]\n---\nBody.');
  assert.deepEqual(flow.frontmatter.allowedTools, ["Read", "Bash(gh *)"]);
});

test("a file with no frontmatter (or an unterminated fence) is all body, never an error", () => {
  const plain = parseSkillMarkdown("# Just markdown\n\nDo the thing.");
  assert.deepEqual(plain.frontmatter, { name: "", description: "", allowedTools: [] });
  assert.equal(plain.body, "# Just markdown\n\nDo the thing.");

  const truncated = parseSkillMarkdown("---\nname: half-written\ndescription: oops");
  assert.equal(truncated.frontmatter.name, "");
  assert.match(truncated.body, /half-written/);
});

test("listInstalledSkills reports each skill's api, runner.json and unrestricted flags", () => {
  withSkills((ctx) => {
    ctx.write("create-sales-order", "SKILL.md", rendered("create-sales-order", "Create an order.", ["api:createSalesOrder"], "Steps."));
    ctx.write("create-sales-order", path.join("api", "openapi.json"), "{}");
    ctx.write("create-sales-order", path.join("api", "index.json"), "{}");
    ctx.write("create-sales-order", "runner.json", JSON.stringify({ apiBase: "http://127.0.0.1:8787", headers: { "X-Api-Key": "demo" } }));

    // A spec with no derived index is not executable — `call_api` resolves ops from
    // the index, so this must not advertise an API.
    ctx.write("half-api", "SKILL.md", rendered("half-api", "Half an API.", [], "Steps."));
    ctx.write("half-api", path.join("api", "openapi.json"), "{}");

    // Not a skill folder at all.
    mkdirSync(path.join(ctx.root, "not-a-skill"), { recursive: true });

    const entries = listInstalledSkills();
    assert.deepEqual(entries.map((e) => e.name), ["create-sales-order", "half-api"]);

    const [order, half] = entries;
    assert.equal(order.description, "Create an order.");
    assert.equal(order.hasApi, true);
    assert.equal(order.hasRunnerConfig, true);
    assert.equal(order.unrestricted, false, "the skill declared allowed-tools");
    assert.ok(order.mtimeMs > 0);

    assert.equal(half.hasApi, false, "openapi.json without index.json is not a usable reference");
    assert.equal(half.hasRunnerConfig, false);
    assert.equal(half.unrestricted, true, "no allowed-tools ⇒ unrestricted");
  });
});

test("runner.json is read tolerantly: junk degrades to null, presence is still reported", () => {
  withSkills((ctx) => {
    ctx.write("good", "SKILL.md", rendered("good", "d", [], "b"));
    ctx.write("good", "runner.json", '{ "apiBase": " http://x.test ", "headers": { "X-Api-Key": "k", "X-Count": 7, "bad": [1] } }');
    ctx.write("broken", "SKILL.md", rendered("broken", "d", [], "b"));
    ctx.write("broken", "runner.json", "{ not json");
    ctx.write("wrong-shape", "SKILL.md", rendered("wrong-shape", "d", [], "b"));
    ctx.write("wrong-shape", "runner.json", "[1,2,3]");

    const good = findInstalledSkill("good");
    assert.ok(good);
    assert.equal(good.runnerConfig?.apiBase, "http://x.test");
    assert.deepEqual(good.runnerConfig?.headers, { "X-Api-Key": "k", "X-Count": "7" });

    const broken = findInstalledSkill("broken");
    assert.ok(broken);
    assert.equal(broken.hasRunnerConfig, true, "the file is there — the UI should say so");
    assert.equal(broken.runnerConfig, null, "…but nothing usable came out of it");

    assert.equal(findInstalledSkill("wrong-shape")?.runnerConfig, null);
  });
});

test("findInstalledSkill matches the folder name or the frontmatter name, and refuses traversal", () => {
  withSkills((ctx) => {
    // Folder and frontmatter deliberately disagree (a hand rename).
    ctx.write("folder-name", "SKILL.md", rendered("declared-name", "A skill.", ["Read"], "Body text."));

    const byFolder = findInstalledSkill("folder-name");
    assert.ok(byFolder);
    assert.equal(byFolder.name, "declared-name", "the frontmatter name is what the UI shows");
    assert.equal(byFolder.body, "Body text.");
    assert.deepEqual(byFolder.allowedTools, ["Read"]);

    assert.equal(findInstalledSkill("declared-name")?.dir, byFolder.dir);
    assert.equal(findInstalledSkill("../../etc"), null);
    assert.equal(findInstalledSkill("nope"), null);
    assert.equal(findInstalledSkill(""), null);
  });
});

test("a name-less SKILL.md falls back to its folder name", () => {
  withSkills((ctx) => {
    ctx.write("hand-written", "SKILL.md", "Do the thing, carefully.");
    const [entry] = listInstalledSkills();
    assert.equal(entry.name, "hand-written");
    assert.equal(entry.description, "");
    assert.equal(entry.unrestricted, true);
    assert.equal(findInstalledSkill("hand-written")?.body, "Do the thing, carefully.");
  });
});

test("deleteSkill removes the whole skill folder and nothing else in the library", () => {
  withSkills((ctx) => {
    ctx.write("create-sales-order", "SKILL.md", rendered("create-sales-order", "Create an order.", ["api:createSalesOrder"], "Steps."));
    ctx.write("create-sales-order", path.join("api", "openapi.json"), "{}");
    ctx.write("create-sales-order", path.join("api", "index.json"), "{}");
    ctx.write("create-sales-order", "runner.json", JSON.stringify({ apiBase: "http://127.0.0.1:8787" }));
    ctx.write("keep-me", "SKILL.md", rendered("keep-me", "Untouched.", [], "Steps."));

    deleteSkill("create-sales-order");

    assert.equal(existsSync(path.join(ctx.root, "create-sales-order")), false, "the folder, and its api/ + runner.json, are gone");
    assert.equal(findInstalledSkill("create-sales-order"), null);
    assert.deepEqual(listInstalledSkills().map((e) => e.name), ["keep-me"]);
    assert.equal(existsSync(ctx.root), true, "the library root itself survives");
  });
});

test("deleting a skill keeps its run transcripts — they are the audit trail", () => {
  withSkills((ctx) => {
    const runsRoot = mkdtempSync(path.join(tmpdir(), "sr-runner-runs-"));
    const previousRuns = process.env.SKILL_RECORDER_RUNS_DIR;
    process.env.SKILL_RECORDER_RUNS_DIR = runsRoot;
    const transcript = path.join(runsRoot, "create-sales-order", "2026-08-02T09-00-00-000Z.json");
    try {
      ctx.write("create-sales-order", "SKILL.md", rendered("create-sales-order", "d", [], "b"));
      mkdirSync(path.dirname(transcript), { recursive: true });
      writeFileSync(transcript, '{"version":1}');

      deleteSkill("create-sales-order");

      assert.equal(existsSync(transcript), true, "uninstalling must not erase what the skill did");
    } finally {
      if (previousRuns === undefined) delete process.env.SKILL_RECORDER_RUNS_DIR;
      else process.env.SKILL_RECORDER_RUNS_DIR = previousRuns;
      rmSync(runsRoot, { recursive: true, force: true });
    }
  });
});

test("deleteSkill refuses traversal, separators and anything that isn't a plain folder name", () => {
  withSkills((ctx) => {
    // A sibling of the library root: the thing a traversal would be reaching for.
    const outside = path.join(ctx.root, "..", path.basename(ctx.root) + "-outsider");
    mkdirSync(outside, { recursive: true });
    ctx.write("real", "SKILL.md", rendered("real", "d", [], "b"));

    try {
      for (const bad of [
        "..",
        ".",
        "../" + path.basename(outside),
        "..\\evil",
        "nested/real",
        "nested\\real",
        path.resolve(ctx.root, "real"),
        "",
        "   ",
        ".hidden",
        "-leading-dash",
      ]) {
        assert.throws(() => deleteSkill(bad), /is not an installed skill|is not installed any more/, `expected "${bad}" to be refused`);
      }
      assert.equal(existsSync(outside), true, "nothing outside the library root was touched");
      assert.equal(existsSync(path.join(ctx.root, "real")), true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test("deleteSkill errors, in the user's words, when the skill isn't there", () => {
  withSkills((ctx) => {
    // A folder under the root with no SKILL.md is not a skill — a typo'd name must not
    // take it out.
    mkdirSync(path.join(ctx.root, "not-a-skill"), { recursive: true });

    assert.throws(() => deleteSkill("nope"), /"nope" is not installed any more/);
    assert.throws(() => deleteSkill("not-a-skill"), /is not installed any more/);
    assert.equal(existsSync(path.join(ctx.root, "not-a-skill")), true);
  });
});

test("a missing library root is empty, not an error", () => {
  const previous = process.env.SKILL_RECORDER_SKILLS_DIR;
  process.env.SKILL_RECORDER_SKILLS_DIR = path.join(tmpdir(), "sr-runner-library-does-not-exist");
  try {
    assert.deepEqual(listInstalledSkills(), []);
    assert.equal(findInstalledSkill("anything"), null);
  } finally {
    if (previous === undefined) delete process.env.SKILL_RECORDER_SKILLS_DIR;
    else process.env.SKILL_RECORDER_SKILLS_DIR = previous;
  }
});
