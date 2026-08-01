import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { ApiReferenceIndex } from "../../common/api-reference";
import type { Tool, ToolResultObject } from "../foundry/agent";
import { createApiReferenceTools, MAX_LISTED_OPERATIONS, renderApiReferenceBrief } from "./api-reference-tools";

/**
 * The agent-facing API-reference tools. Every case writes an `api-reference/` folder into
 * a temp session directory by hand — the tools only ever read `index.json` and
 * `spec.json`, so seeding the files directly keeps these tests about the *tool contracts*
 * (what the model is shown, and how it is told to self-correct) rather than about the
 * store's attach path, which `api-reference-store.test.ts` already defends.
 *
 * What is being defended: the set is **absent** when nothing is attached (and the doc
 * search is absent without chunks), long lists are **capped with a hint** instead of
 * flooding the turn, an unknown operationId fails with **near-misses** the model can act
 * on, and detail answers never carry anything but security *scheme names*.
 */

const SPEC = {
  openapi: "3.0.3",
  info: { title: "Sales API", version: "2.1" },
  security: [{ apiKeyAuth: [] }],
  paths: {
    "/sales/orders": {
      get: {
        operationId: "listSalesOrders",
        summary: "List sales orders",
        tags: ["orders"],
        parameters: [{ name: "status", in: "query", schema: { type: "string" }, description: "Filter by status" }],
        responses: { "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/Order" } } } } },
      },
      post: {
        operationId: "createSalesOrder",
        summary: "Create a sales order",
        tags: ["orders"],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/Order" } } },
        },
        responses: { "201": { content: { "application/json": { schema: { $ref: "#/components/schemas/Order" } } } } },
      },
    },
    "/customers": {
      get: { operationId: "listCustomers", summary: "List customers", tags: ["customers"] },
    },
  },
  components: {
    schemas: {
      Order: {
        type: "object",
        required: ["customerId"],
        properties: {
          id: { type: "string" },
          customerId: { type: "string", description: "The customer placing the order" },
          total: { type: "number", format: "double" },
        },
      },
    },
    securitySchemes: { apiKeyAuth: { type: "apiKey", name: "X-Api-Key", in: "header" } },
  },
};

const OPERATIONS: ApiReferenceIndex["operations"] = [
  { operationId: "listSalesOrders", method: "GET", path: "/sales/orders", summary: "List sales orders", tags: ["orders"], sourceId: "spec" },
  { operationId: "createSalesOrder", method: "POST", path: "/sales/orders", summary: "Create a sales order", tags: ["orders"], sourceId: "spec" },
  { operationId: "listCustomers", method: "GET", path: "/customers", summary: "List customers", tags: ["customers"], sourceId: "spec" },
];

const CHUNKS: ApiReferenceIndex["chunks"] = [
  { id: "doc-1:0", sourceId: "doc-1", heading: "Creating orders", text: "Post the order, then add lines to it." },
  { id: "doc-1:1", sourceId: "doc-1", heading: "Customers", text: "An order needs a customer id before it can be created." },
  { id: "doc-1:2", sourceId: "doc-1", heading: "Rate limits", text: "Sixty requests a minute." },
];

interface Seed {
  operations?: ApiReferenceIndex["operations"];
  chunks?: ApiReferenceIndex["chunks"];
  /** Write `spec.json` too (the detail tool's source). */
  spec?: unknown;
}

/** A temp session directory, optionally seeded with an api-reference bundle. */
function withSession(seed: Seed | null, body: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), "skill-recorder-apitools-"));
  try {
    if (seed) {
      const api = path.join(dir, "api-reference");
      mkdirSync(api, { recursive: true });
      const index: ApiReferenceIndex = {
        version: 1,
        operations: seed.operations ?? [],
        chunks: seed.chunks ?? [],
        updatedAt: 1,
      };
      writeFileSync(path.join(api, "index.json"), JSON.stringify(index));
      if (seed.spec !== undefined) writeFileSync(path.join(api, "spec.json"), JSON.stringify(seed.spec));
    }
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function byName(tools: Tool[], name: string): Tool {
  const tool = tools.find((t) => t.name === name);
  assert.ok(tool, `expected a ${name} tool`);
  return tool;
}

/** Run a tool and return its text plus whether it answered as a failure. */
function call(tools: Tool[], name: string, args: unknown): { text: string; failed: boolean } {
  const result = byName(tools, name).handler(args);
  assert.ok(!(result instanceof Promise), "these handlers are synchronous");
  if (typeof result === "string") return { text: result, failed: false };
  const object = result as ToolResultObject;
  return { text: object.textResultForLlm, failed: object.resultType === "failure" };
}

test("no reference attached means no tools at all", () => {
  withSession(null, (dir) => {
    assert.deepEqual(createApiReferenceTools({ sessionDir: dir }), []);
  });
});

test("the documentation search is registered only when there are chunks", () => {
  withSession({ operations: OPERATIONS, spec: SPEC }, (dir) => {
    assert.deepEqual(createApiReferenceTools({ sessionDir: dir }).map((t) => t.name), [
      "list_api_operations",
      "get_api_operation",
    ]);
  });
  withSession({ operations: OPERATIONS, chunks: CHUNKS, spec: SPEC }, (dir) => {
    assert.deepEqual(createApiReferenceTools({ sessionDir: dir }).map((t) => t.name), [
      "list_api_operations",
      "get_api_operation",
      "search_api_docs",
    ]);
  });
});

test("list_api_operations renders compact rows and narrows by filter and tag", () => {
  withSession({ operations: OPERATIONS, spec: SPEC }, (dir) => {
    const tools = createApiReferenceTools({ sessionDir: dir });

    const all = call(tools, "list_api_operations", {});
    assert.match(all.text, /^3 operation\(s\) in the attached API reference:/);
    assert.match(all.text, /createSalesOrder {2}POST \/sales\/orders — Create a sales order \[orders\]/);

    // The filter spans id, method, path, summary and tags…
    const filtered = call(tools, "list_api_operations", { filter: "customer" });
    assert.match(filtered.text, /listCustomers/);
    assert.ok(!filtered.text.includes("createSalesOrder"));

    // …and the tag is an exact, case-insensitive match.
    const tagged = call(tools, "list_api_operations", { tag: "ORDERS" });
    assert.match(tagged.text, /2 operation\(s\)/);
    assert.ok(!tagged.text.includes("listCustomers"));

    const none = call(tools, "list_api_operations", { filter: "invoices" });
    assert.match(none.text, /No operation matches filter "invoices"/);
    assert.equal(none.failed, false); // an empty result is an answer, not a tool failure
  });
});

test("a long operation list is capped and says how to narrow it", () => {
  const many = Array.from({ length: MAX_LISTED_OPERATIONS + 7 }, (_, n) => ({
    operationId: `getThing${n}`,
    method: "GET",
    path: `/things/${n}`,
    summary: "",
    tags: [],
    sourceId: "spec",
  }));
  withSession({ operations: many, spec: SPEC }, (dir) => {
    const tools = createApiReferenceTools({ sessionDir: dir });
    const listed = call(tools, "list_api_operations", {});
    const rows = listed.text.split("\n").filter((l) => l.startsWith("getThing"));
    assert.equal(rows.length, MAX_LISTED_OPERATIONS);
    assert.ok(listed.text.endsWith("… 7 more — narrow with filter."));
  });
});

test("get_api_operation returns the resolved detail, and scheme names only", () => {
  withSession({ operations: OPERATIONS, spec: SPEC }, (dir) => {
    const tools = createApiReferenceTools({ sessionDir: dir });
    const detail = JSON.parse(call(tools, "get_api_operation", { operationId: "createSalesOrder" }).text);

    assert.equal(detail.method, "POST");
    assert.equal(detail.path, "/sales/orders");
    assert.equal(detail.summary, "Create a sales order");
    assert.equal(detail.requestBody.contentType, "application/json");
    assert.equal(detail.requestBody.required, true);
    assert.deepEqual(
      detail.requestBody.fields.map((f: { name: string; required: boolean }) => [f.name, f.required]),
      [["id", false], ["customerId", true], ["total", false]],
    );
    assert.equal(detail.response.status, "201");
    // The scheme NAME travels; nothing that could carry a credential does.
    assert.deepEqual(detail.security, ["apiKeyAuth"]);
    assert.ok(!JSON.stringify(detail).includes("X-Api-Key"));

    // A route, with or without the api: prefix, resolves to the same operation.
    assert.equal(JSON.parse(call(tools, "get_api_operation", { operationId: "api:GET /sales/orders" }).text).operationId, "listSalesOrders");
  });
});

test("an unknown operationId fails with the near-misses that let the model self-correct", () => {
  withSession({ operations: OPERATIONS, spec: SPEC }, (dir) => {
    const tools = createApiReferenceTools({ sessionDir: dir });

    const typo = call(tools, "get_api_operation", { operationId: "createSalesOrders" });
    assert.equal(typo.failed, true);
    assert.match(typo.text, /There is no operation "createSalesOrders"/);
    assert.match(typo.text, /Did you mean/);
    assert.match(typo.text, /createSalesOrder {2}POST \/sales\/orders/);

    // A guess that resembles the domain still surfaces the real operations…
    assert.match(call(tools, "get_api_operation", { operationId: "makeSalesOrder" }).text, /createSalesOrder/);
    // …and one that resembles nothing points back at the list rather than guessing.
    const wild = call(tools, "get_api_operation", { operationId: "zzz" });
    assert.equal(wild.failed, true);
    assert.match(wild.text, /Call list_api_operations/);
  });
});

test("get_api_operation degrades to the indexed row when the spec is unreadable", () => {
  withSession({ operations: OPERATIONS }, (dir) => {
    const tools = createApiReferenceTools({ sessionDir: dir });
    const answer = call(tools, "get_api_operation", { operationId: "createSalesOrder" });
    assert.equal(answer.failed, false);
    assert.match(answer.text, /Only the indexed summary/);
    assert.match(answer.text, /createSalesOrder {2}POST \/sales\/orders/);
  });
});

test("search_api_docs ranks by relevance, honors the limit, and cites its source", () => {
  withSession({ operations: OPERATIONS, chunks: CHUNKS, spec: SPEC }, (dir) => {
    const tools = createApiReferenceTools({ sessionDir: dir });

    const hits = call(tools, "search_api_docs", { query: "customer" });
    assert.match(hits.text, /^\[doc-1 › Customers\]\n/);
    assert.ok(!hits.text.includes("Rate limits"));

    const limited = call(tools, "search_api_docs", { query: "order", limit: 1 });
    assert.equal(limited.text.split("\n\n").length, 1);
    // An out-of-range limit is clamped, not rejected.
    assert.ok(call(tools, "search_api_docs", { query: "order", limit: 99 }).text.length > 0);

    const empty = call(tools, "search_api_docs", { query: "invoices" });
    assert.match(empty.text, /Nothing in the attached documentation matches "invoices"/);
    assert.equal(call(tools, "search_api_docs", { query: "  " }).failed, true);
  });
});

test("the system-prompt brief states the convention, the credential rule, and the target's payoff", () => {
  const reference = {
    name: "Sales API",
    sources: [
      { id: "spec", kind: "openapi" as const, name: "sales.json", bytes: 10, operationCount: 3, chunkCount: 0 },
      { id: "doc-1", kind: "docs" as const, name: "guide.md", bytes: 4, operationCount: 0, chunkCount: 3 },
    ],
    operationCount: 3,
    chunkCount: 3,
    updatedAt: 1,
  };

  const app = renderApiReferenceBrief({ reference, architecture: "app", kind: "skill" });
  assert.match(app, /Sales API/);
  assert.match(app, /sales\.json \(spec\), guide\.md \(docs\)/);
  assert.match(app, /3 operation\(s\) and 3 documentation section\(s\)/);
  assert.match(app, /api:<operationId>/);
  assert.match(app, /Never write credentials/);
  assert.match(app, /allowedTools/);
  assert.match(app, /this app's runner/);

  const studio = renderApiReferenceBrief({ reference, architecture: "copilot-studio", kind: "skill" });
  assert.match(studio, /custom connector/);
  assert.match(studio, /SalesAPI\.createSalesOrder/);

  // Automations have no allowed-tools list, so that instruction must not appear there.
  const automation = renderApiReferenceBrief({ reference, architecture: "app", kind: "automation" });
  assert.ok(!automation.includes("allowedTools"));
  assert.match(automation, /step prompt's `tool`/);

  // Without documentation the search tool isn't offered, so the brief must not name it.
  const specOnly = renderApiReferenceBrief({
    reference: { ...reference, chunkCount: 0 },
    architecture: "app",
    kind: "skill",
  });
  assert.ok(!specOnly.includes("search_api_docs"));
});
