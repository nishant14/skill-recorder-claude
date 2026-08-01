import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  attachFromFile,
  attachFromUrl,
  loadIndex,
  loadReference,
  MAX_DOC_SOURCES,
  MAX_SOURCE_BYTES,
  removeSource,
  writeReference,
  YAML_REFUSAL,
} from "./api-reference-store";

/**
 * Filesystem tests for the API-reference store. Every case runs against a temp
 * `SKILL_RECORDER_SESSIONS_DIR` and restores the variable afterwards, and the
 * URL-attach cases swap `globalThis.fetch` for a scripted fake restored in a
 * `finally` — nothing here opens a socket or touches the real sessions root.
 *
 * What is being defended: the **YAML refusal** (an honest message beats a parse
 * error), the **attach limits** (a refused attach must leave the existing reference
 * untouched), **replace semantics** for the single spec, and the invariant that
 * `index.json` is rebuilt from the sources on every mutation.
 */

/** Matches our own id shape, and passes `isValidSessionId`'s traversal guard. */
const SESSION_ID = "20260801-120000-abc123";

const SPEC = {
  openapi: "3.0.3",
  info: { title: "Sales API", version: "2.1" },
  paths: {
    "/sales/orders": {
      get: { operationId: "listSalesOrders", summary: "List orders" },
      post: { operationId: "createSalesOrder", summary: "Create an order" },
    },
  },
};

const SMALLER_SPEC = {
  openapi: "3.0.3",
  info: { title: "Sales API (trimmed)", version: "3.0" },
  paths: { "/sales/orders": { post: { operationId: "createSalesOrder" } } },
};

interface Ctx {
  /** The session's directory — what `loadReference` / `loadIndex` take. */
  dir: string;
  /** A scratch directory for the files we attach *from*. */
  incoming: string;
  /** Write a file into `incoming` and return its absolute path. */
  file(name: string, content: string): string;
}

/** Run `body` against an isolated sessions root, restoring the environment after. */
async function withSession(body: (ctx: Ctx) => Promise<void> | void): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), "skill-recorder-apiref-"));
  const previous = process.env.SKILL_RECORDER_SESSIONS_DIR;
  process.env.SKILL_RECORDER_SESSIONS_DIR = root;
  const dir = path.join(root, SESSION_ID);
  const incoming = path.join(root, "incoming");
  mkdirSync(dir, { recursive: true });
  mkdirSync(incoming, { recursive: true });
  try {
    await body({
      dir,
      incoming,
      file(name, content) {
        const p = path.join(incoming, name);
        writeFileSync(p, content);
        return p;
      },
    });
  } finally {
    if (previous === undefined) delete process.env.SKILL_RECORDER_SESSIONS_DIR;
    else process.env.SKILL_RECORDER_SESSIONS_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

/** Install a scripted fetch for one attach, then always restore the real one. */
async function withFetch<T>(respond: (url: string) => Response, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => respond(String(input))) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test("attaching a spec writes the bundle layout and indexes its operations", async () => {
  await withSession(async ({ dir, file }) => {
    const summary = await attachFromFile(SESSION_ID, file("sales.json", JSON.stringify(SPEC)));

    assert.equal(summary.name, "Sales API");
    assert.equal(summary.operationCount, 2);
    assert.equal(summary.chunkCount, 0);
    assert.deepEqual(summary.sources.map((s) => [s.id, s.kind, s.name, s.operationCount]), [
      ["spec", "openapi", "sales.json", 2],
    ]);

    const api = path.join(dir, "api-reference");
    assert.ok(existsSync(path.join(api, "manifest.json")));
    assert.ok(existsSync(path.join(api, "spec.json")));
    assert.ok(existsSync(path.join(api, "index.json")));
    // The spec is stored verbatim so a later export can hand it to a connector import.
    assert.deepEqual(JSON.parse(readFileSync(path.join(api, "spec.json"), "utf8")), SPEC);

    const index = loadIndex(dir);
    assert.deepEqual(index?.operations.map((o) => o.operationId), ["listSalesOrders", "createSalesOrder"]);
    assert.deepEqual(loadReference(dir), summary);
  });
});

test("nothing attached reads as null, not an empty reference", async () => {
  await withSession(({ dir }) => {
    assert.equal(loadReference(dir), null);
    assert.equal(loadIndex(dir), null);
  });
});

test("YAML is refused with the export-as-JSON message, by extension or by content", async () => {
  await withSession(async ({ dir, file }) => {
    await assert.rejects(
      attachFromFile(SESSION_ID, file("sales.yaml", "openapi: 3.0.3\npaths: {}\n")),
      { message: YAML_REFUSAL },
    );
    // A YAML spec saved under a friendlier extension gets the same answer.
    await assert.rejects(
      attachFromFile(SESSION_ID, file("spec.txt", "openapi: 3.0.3\ninfo:\n  title: Sales\n")),
      { message: YAML_REFUSAL },
    );
    assert.equal(loadReference(dir), null); // a refused attach writes nothing
  });
});

test("documentation attaches as chunks alongside the spec, and the index holds both", async () => {
  await withSession(async ({ dir, file }) => {
    await attachFromFile(SESSION_ID, file("sales.json", JSON.stringify(SPEC)));
    const summary = await attachFromFile(
      SESSION_ID,
      file("guide.md", "# Orders\nPost to /sales/orders.\n\n# Lines\nAdd lines after.\n"),
    );

    assert.equal(summary.operationCount, 2);
    assert.equal(summary.chunkCount, 2);
    assert.deepEqual(summary.sources.map((s) => [s.id, s.kind, s.chunkCount]), [
      ["spec", "openapi", 0],
      ["doc-1", "docs", 2],
    ]);
    assert.ok(existsSync(path.join(dir, "api-reference", "docs", "doc-1.txt")));
    const index = loadIndex(dir);
    assert.equal(index?.operations.length, 2);
    assert.deepEqual(index?.chunks.map((c) => c.heading), ["Orders", "Lines"]);
  });
});

test("HTML documentation is stored as extracted text, not markup", async () => {
  await withSession(async ({ dir, file }) => {
    await attachFromFile(
      SESSION_ID,
      file("page.html", "<html><body><script>x()</script><h1>Orders</h1><p>POST /sales/orders</p></body></html>"),
    );
    const stored = readFileSync(path.join(dir, "api-reference", "docs", "doc-1.txt"), "utf8");
    assert.ok(!stored.includes("<p>"));
    assert.ok(!stored.includes("x()"));
    assert.ok(stored.includes("POST /sales/orders"));
  });
});

test("re-attaching a spec replaces the one already there and rebuilds the index", async () => {
  await withSession(async ({ dir, file }) => {
    await attachFromFile(SESSION_ID, file("sales.json", JSON.stringify(SPEC)));
    const summary = await attachFromFile(SESSION_ID, file("trimmed.json", JSON.stringify(SMALLER_SPEC)));

    assert.equal(summary.sources.filter((s) => s.kind === "openapi").length, 1);
    assert.equal(summary.name, "Sales API (trimmed)");
    assert.equal(summary.operationCount, 1);
    assert.deepEqual(loadIndex(dir)?.operations.map((o) => o.operationId), ["createSalesOrder"]);
    assert.deepEqual(JSON.parse(readFileSync(path.join(dir, "api-reference", "spec.json"), "utf8")), SMALLER_SPEC);
  });
});

test("a spec with no operations is refused rather than indexed empty", async () => {
  await withSession(async ({ dir, file }) => {
    await assert.rejects(
      attachFromFile(SESSION_ID, file("empty.json", JSON.stringify({ openapi: "3.0.3", paths: {} }))),
      /no operations under/,
    );
    assert.equal(loadReference(dir), null);
  });
});

test("JSON that is not a spec is indexed as documentation, and broken JSON is refused", async () => {
  await withSession(async ({ file }) => {
    const summary = await attachFromFile(SESSION_ID, file("notes.json", JSON.stringify({ notes: "call POST /orders" })));
    assert.equal(summary.sources[0].kind, "docs");
    assert.equal(summary.operationCount, 0);
    await assert.rejects(attachFromFile(SESSION_ID, file("broken.json", "{ oops")), /isn't valid JSON/);
  });
});

test("the doc-count limit holds and refuses the extra file by name", async () => {
  await withSession(async ({ dir, file }) => {
    for (let n = 1; n <= MAX_DOC_SOURCES; n++) {
      await attachFromFile(SESSION_ID, file(`doc-${n}.md`, `# Section ${n}\nBody ${n}.\n`));
    }
    const before = loadReference(dir);
    assert.equal(before?.sources.length, MAX_DOC_SOURCES);
    await assert.rejects(
      attachFromFile(SESSION_ID, file("one-too-many.md", "# Nope\nBody.\n")),
      /up to 8 documentation files/,
    );
    assert.deepEqual(loadReference(dir), before); // the refusal changed nothing
  });
});

test("a file over the 10 MB cap is refused before it is read", async () => {
  await withSession(async ({ dir, file }) => {
    await assert.rejects(
      attachFromFile(SESSION_ID, file("huge.md", "a".repeat(MAX_SOURCE_BYTES + 1))),
      /limit is 10 MB per attachment/,
    );
    assert.equal(loadReference(dir), null);
  });
});

test("a document that would blow the chunk budget is refused", async () => {
  await withSession(async ({ dir, file }) => {
    // One chunk per heading; 3001 of them is one past the index-wide ceiling.
    const doc = Array.from({ length: 3001 }, (_, n) => `# H${n}\nbody ${n}\n`).join("\n");
    await assert.rejects(attachFromFile(SESSION_ID, file("huge.md", doc)), /too long to index/);
    assert.equal(loadReference(dir), null);
  });
});

test("an empty or missing file is refused with a readable reason", async () => {
  await withSession(async ({ file, incoming }) => {
    await assert.rejects(attachFromFile(SESSION_ID, file("blank.md", "")), /empty/);
    await assert.rejects(
      attachFromFile(SESSION_ID, path.join(incoming, "gone.md")),
      /Couldn't read that file/,
    );
  });
});

test("attaching from a URL downloads, names, and indexes the spec", async () => {
  await withSession(async ({ dir }) => {
    const summary = await withFetch(
      () => new Response(JSON.stringify(SPEC), { headers: { "content-type": "application/json" } }),
      () => attachFromUrl(SESSION_ID, "https://example.invalid/specs/sales.json"),
    );
    assert.equal(summary.operationCount, 2);
    assert.deepEqual(summary.sources.map((s) => [s.name, s.kind]), [["sales.json", "openapi"]]);
    const manifest = JSON.parse(readFileSync(path.join(dir, "api-reference", "manifest.json"), "utf8"));
    assert.equal(manifest.sources[0].origin, "url");
    assert.equal(manifest.sources[0].location, "https://example.invalid/specs/sales.json");
  });
});

test("only http(s) URLs are accepted, and a failed download says why", async () => {
  await withSession(async ({ dir }) => {
    await assert.rejects(attachFromUrl(SESSION_ID, "ftp://example.invalid/spec.json"), /http:\/\/ and https:\/\//);
    await assert.rejects(attachFromUrl(SESSION_ID, "not a url"), /doesn't look like a URL/);
    await assert.rejects(
      withFetch(
        () => new Response("nope", { status: 404 }),
        () => attachFromUrl(SESSION_ID, "https://example.invalid/spec.json"),
      ),
      /answered 404/,
    );
    assert.equal(loadReference(dir), null);
  });
});

test("a download over the cap is refused while it streams", async () => {
  await withSession(async ({ dir }) => {
    await assert.rejects(
      withFetch(
        () => new Response("a".repeat(MAX_SOURCE_BYTES + 1024)),
        () => attachFromUrl(SESSION_ID, "https://example.invalid/huge.md"),
      ),
      /larger than the 10 MB limit/,
    );
    assert.equal(loadReference(dir), null);
  });
});

test("removing one source rebuilds the index; removing the last one clears the folder", async () => {
  await withSession(async ({ dir, file }) => {
    await attachFromFile(SESSION_ID, file("sales.json", JSON.stringify(SPEC)));
    await attachFromFile(SESSION_ID, file("guide.md", "# Orders\nPost to /sales/orders.\n"));

    const afterSpecRemoved = removeSource(SESSION_ID, "spec");
    assert.equal(afterSpecRemoved?.operationCount, 0);
    assert.equal(afterSpecRemoved?.chunkCount, 1);
    assert.ok(!existsSync(path.join(dir, "api-reference", "spec.json")));
    assert.deepEqual(loadIndex(dir)?.operations, []);
    // Removing something already gone is a no-op, not an error.
    assert.deepEqual(removeSource(SESSION_ID, "spec"), afterSpecRemoved);

    assert.equal(removeSource(SESSION_ID, "doc-1"), null);
    assert.ok(!existsSync(path.join(dir, "api-reference")));
    assert.equal(loadReference(dir), null);
  });
});

test("removing without a source id detaches the whole reference", async () => {
  await withSession(async ({ dir, file }) => {
    await attachFromFile(SESSION_ID, file("sales.json", JSON.stringify(SPEC)));
    await attachFromFile(SESSION_ID, file("guide.md", "# Orders\nPost to /sales/orders.\n"));
    assert.equal(removeSource(SESSION_ID), null);
    assert.ok(!existsSync(path.join(dir, "api-reference")));
    assert.equal(removeSource(SESSION_ID), null); // idempotent
  });
});

test("attaching to an unknown session is refused", async () => {
  await withSession(async ({ file }) => {
    await assert.rejects(
      attachFromFile("20260801-999999-nope", file("sales.json", JSON.stringify(SPEC))),
      /Unknown session/,
    );
  });
});

test("writeReference seeds the same layout an attach produces", async () => {
  await withSession(async ({ dir }) => {
    // The eval harnesses' seeding path: in-memory sources, no dialog, no download. It has
    // to land the same four artifacts the attach path does, or a seeded scenario would be
    // measuring something the app never builds.
    const summary = writeReference(dir, {
      spec: SPEC,
      docs: [{ name: "orders.md", text: "# Orders\nPost to /sales/orders to create one.\n" }],
    });

    const api = path.join(dir, "api-reference");
    assert.ok(existsSync(path.join(api, "manifest.json")));
    assert.deepEqual(JSON.parse(readFileSync(path.join(api, "spec.json"), "utf8")), SPEC);
    assert.ok(existsSync(path.join(api, "docs", "doc-1.txt")));

    assert.equal(summary?.name, "Sales API");
    assert.equal(summary?.operationCount, 2);
    assert.ok((summary?.chunkCount ?? 0) > 0);
    assert.deepEqual(loadReference(dir), summary);
    assert.deepEqual(loadIndex(dir)?.operations.map((o) => o.operationId), [
      "listSalesOrders",
      "createSalesOrder",
    ]);
  });
});

test("writeReference with nothing to write leaves no empty reference behind", async () => {
  await withSession(async ({ dir }) => {
    assert.equal(writeReference(dir, {}), null);
    assert.ok(!existsSync(path.join(dir, "api-reference")));
    assert.equal(loadReference(dir), null);
  });
});
