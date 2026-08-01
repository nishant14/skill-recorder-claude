import assert from "node:assert/strict";
import test from "node:test";

import {
  ApiReferenceIndexSchema,
  ApiReferenceManifestSchema,
  CHUNK_CHARS,
  CHUNK_OVERLAP,
  chunkDocs,
  collectApiRefs,
  extractOperations,
  normalizeApiRef,
  resolveOperationDetail,
  scoreChunks,
  stripHtml,
  summarizeReference,
  synthesizeOperationId,
  unresolvedApiOperations,
} from "./api-reference";

/**
 * Unit tests for the pure half of the API-reference feature. Everything here runs
 * offline by construction — this module never touches the filesystem or the network.
 *
 * The assertions worth defending are the ones a hallucinating agent or a hostile spec
 * would break: **synthesized ids** (specs without `operationId` still need something
 * an `api:` ref can name), **dedupe** (two operations sharing an id would make a ref
 * ambiguous), the **`$ref` guards** (external refs are never followed, cycles never
 * hang), and the **credentials rule** — operation detail exposes security *scheme
 * names* and nothing else.
 */

const SPEC = {
  openapi: "3.0.3",
  info: { title: "Sales API", version: "2.1" },
  security: [{ apiKeyAuth: [] }],
  paths: {
    "/sales/orders": {
      parameters: [{ name: "x-tenant", in: "header", required: true, schema: { type: "string" } }],
      get: {
        operationId: "listSalesOrders",
        summary: "List sales orders\nsecond line is dropped",
        tags: ["orders"],
        deprecated: true,
        responses: { "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/Order" } } } } },
      },
      post: {
        operationId: "createSalesOrder",
        summary: "Create a sales order",
        tags: ["orders"],
        parameters: [{ name: "dryRun", in: "query", schema: { type: "boolean" } }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/Order" } } },
        },
        responses: {
          "201": { content: { "application/json": { schema: { $ref: "#/components/schemas/Order" } } } },
        },
      },
    },
    "/sales/orders/{orderId}": {
      // No operationId on purpose: the id must be synthesized from method + path.
      get: { summary: "Get one order", responses: { "200": {} } },
    },
    "/sales/orders/{orderId}/lines": {
      // Deliberate collision with the POST above.
      delete: { operationId: "createSalesOrder", summary: "Delete the lines" },
    },
  },
  components: {
    schemas: {
      Order: {
        type: "object",
        required: ["customerId"],
        properties: {
          customerId: { type: "string", description: "Account the order belongs to" },
          total: { type: "number", format: "double" },
          customer: { $ref: "#/components/schemas/Customer" },
          externalOnly: { $ref: "https://example.invalid/schemas/Thing" },
          next: { $ref: "#/components/schemas/Order" },
        },
      },
      Customer: { type: "object", properties: { id: { type: "string" }, tier: { enum: ["gold", "silver"] } } },
    },
  },
};

test("extractOperations flattens paths × methods, synthesizing and de-duplicating ids", () => {
  const ops = extractOperations(SPEC, "spec");
  assert.deepEqual(
    ops.map((o) => `${o.method} ${o.path} ${o.operationId}`),
    [
      "GET /sales/orders listSalesOrders",
      "POST /sales/orders createSalesOrder",
      "GET /sales/orders/{orderId} getSalesOrdersByOrderId",
      "DELETE /sales/orders/{orderId}/lines createSalesOrder_2",
    ],
  );
  assert.equal(ops[0].summary, "List sales orders"); // only the first line survives
  assert.deepEqual(ops[0].tags, ["orders"]);
  assert.equal(ops[0].deprecated, true);
  assert.equal(ops[1].deprecated, undefined);
  assert.ok(ops.every((o) => o.sourceId === "spec"));
});

test("extractOperations tolerates specs with nothing to extract", () => {
  assert.deepEqual(extractOperations(null), []);
  assert.deepEqual(extractOperations({ openapi: "3.0.0" }), []);
  assert.deepEqual(extractOperations({ paths: { "/x": { summary: "not an operation" } } }), []);
});

test("synthesizeOperationId names a method + path pair readably", () => {
  assert.equal(synthesizeOperationId("get", "/sales/orders/{orderId}"), "getSalesOrdersByOrderId");
  assert.equal(synthesizeOperationId("post", "/"), "postRoot");
  assert.equal(synthesizeOperationId("put", "/v2/work-items"), "putV2WorkItems");
});

test("resolveOperationDetail flattens the body through local $refs and keeps required flags", () => {
  const detail = resolveOperationDetail(SPEC, "createSalesOrder");
  assert.ok(detail);
  assert.equal(detail.method, "POST");
  assert.equal(detail.path, "/sales/orders");
  assert.equal(detail.requestBody?.contentType, "application/json");
  assert.equal(detail.requestBody?.required, true);
  const fields = detail.requestBody?.fields ?? [];
  const customerId = fields.find((f) => f.name === "customerId");
  assert.equal(customerId?.required, true);
  assert.equal(customerId?.description, "Account the order belongs to");
  assert.equal(fields.find((f) => f.name === "total")?.type, "number<double>");
  // Nested objects flatten to dotted paths, and enums show their members.
  assert.equal(fields.find((f) => f.name === "customer.tier")?.type, "enum(gold|silver)");
  assert.equal(detail.response?.status, "201");
  // Path-level parameters are merged in with the operation's own.
  assert.deepEqual(
    detail.parameters.map((p) => `${p.in}:${p.name}:${p.required}`),
    ["header:x-tenant:true", "query:dryRun:false"],
  );
});

test("operation detail exposes security scheme names and no credential material", () => {
  const detail = resolveOperationDetail(SPEC, "createSalesOrder");
  assert.deepEqual(detail?.security, ["apiKeyAuth"]);
  assert.ok(!JSON.stringify(detail).toLowerCase().includes("bearer "));
});

test("$ref guards: external refs are never followed and cycles terminate", () => {
  const detail = resolveOperationDetail(SPEC, "createSalesOrder");
  const names = (detail?.requestBody?.fields ?? []).map((f) => f.name);
  // The https:// $ref is dropped rather than fetched — indexing never hits the network.
  assert.ok(!names.includes("externalOnly"));
  // Order.next → Order is self-referential; the visited set + depth cap stop it.
  assert.ok(names.filter((n) => n.startsWith("next")).length < 12);
  assert.ok(names.every((n) => n.split(".").length <= 6));
});

test("resolveOperationDetail matches case-insensitively and refuses unknown ids", () => {
  assert.equal(resolveOperationDetail(SPEC, "CREATESALESORDER")?.operationId, "createSalesOrder");
  assert.equal(resolveOperationDetail(SPEC, "createSalesOrde"), null);
  assert.equal(resolveOperationDetail(SPEC, ""), null);
});

test("chunkDocs splits on headings first, labelling each chunk", () => {
  const md = "Intro prose.\n\n# Orders\nCreate an order with POST.\n\n## Lines\nAdd lines to it.\n";
  const chunks = chunkDocs(md, "doc-1");
  assert.deepEqual(
    chunks.map((c) => [c.id, c.heading, c.text]),
    [
      ["doc-1:0", "", "Intro prose."],
      ["doc-1:1", "Orders", "Create an order with POST."],
      ["doc-1:2", "Lines", "Add lines to it."],
    ],
  );
  assert.ok(chunks.every((c) => c.sourceId === "doc-1"));
});

test("chunkDocs falls back to overlapping windows when there are no headings", () => {
  const body = "abcdefghij".repeat(400); // 4000 chars, no whitespace to trim
  const chunks = chunkDocs(body, "doc-2");
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].text.length, CHUNK_CHARS);
  assert.ok(chunks.every((c) => c.heading === ""));
  // Adjacent windows overlap, so a sentence lying on the seam is still retrievable.
  assert.ok(chunks[1].text.startsWith(chunks[0].text.slice(-CHUNK_OVERLAP)));
  assert.equal(new Set(chunks.map((c) => c.id)).size, chunks.length);
});

test("chunkDocs drops empty documents", () => {
  assert.deepEqual(chunkDocs("   \n\n  ", "doc-3"), []);
});

test("stripHtml drops scripts and decodes the entities docs actually use", () => {
  const html =
    "<html><head><style>b{}</style><script>alert('x')</script></head>" +
    "<body><h1>Orders&nbsp;API</h1><p>Use &lt;POST /orders&gt; &amp; check&#39;s status</p></body></html>";
  const text = stripHtml(html);
  assert.ok(!text.includes("alert"));
  assert.ok(!text.includes("b{}"));
  assert.ok(text.includes("Orders API"));
  assert.ok(text.includes("Use <POST /orders> & check's status"));
});

test("scoreChunks ranks heading hits above body hits and ignores empty queries", () => {
  const chunks = [
    { id: "a", sourceId: "d", heading: "Customers", text: "orders are mentioned once here" },
    { id: "b", sourceId: "d", heading: "Orders", text: "creating things" },
    { id: "c", sourceId: "d", heading: "Misc", text: "nothing relevant" },
  ];
  const ranked = scoreChunks(chunks, "orders");
  assert.deepEqual(ranked.map((r) => r.chunk.id), ["b", "a"]);
  assert.ok(ranked[0].score > ranked[1].score);
  assert.deepEqual(scoreChunks(chunks, "  "), []);
  assert.equal(scoreChunks(chunks, "orders", 1).length, 1);
});

test("normalizeApiRef accepts both conventions and rejects everything else", () => {
  assert.deepEqual(normalizeApiRef("api:createSalesOrder"), {
    kind: "operation",
    operationId: "createSalesOrder",
    raw: "api:createSalesOrder",
  });
  assert.deepEqual(normalizeApiRef(" api:POST /sales/orders/ "), {
    kind: "route",
    method: "POST",
    path: "/sales/orders",
    raw: "api:POST /sales/orders/",
  });
  // A lower-case method is still a route; an unknown verb is treated as an id.
  assert.equal(normalizeApiRef("api:get /sales/orders")?.kind, "route");
  assert.equal(normalizeApiRef("api:fetch /sales/orders")?.kind, "operation");
  assert.equal(normalizeApiRef("Bash(git *)"), null);
  assert.equal(normalizeApiRef("api:"), null);
  assert.equal(normalizeApiRef(""), null);
  assert.equal(normalizeApiRef(undefined), null);
});

test("collectApiRefs gathers step tools then allowed-tools, de-duplicated in order", () => {
  const steps = [
    { tool: "api:createSalesOrder" },
    { tool: "web_fetch" },
    { tool: "api:POST /sales/orders" },
    { tool: "api:createSalesOrder" },
    {},
  ];
  assert.deepEqual(collectApiRefs(steps, ["api:listSalesOrders", "api:createSalesOrder", "Bash(gh *)"]), [
    "api:createSalesOrder",
    "api:POST /sales/orders",
    "api:listSalesOrders",
  ]);
  assert.deepEqual(collectApiRefs([], []), []);
});

test("unresolvedApiOperations flags exactly the refs the index cannot resolve", () => {
  const ops = extractOperations(SPEC, "spec");
  const refs = [
    "api:createSalesOrder",
    "api:GET /sales/orders",
    "api:getSalesOrdersByOrderId",
    "api:invoiceTheCustomer",
    "api:PATCH /sales/orders",
  ];
  assert.deepEqual(unresolvedApiOperations(refs, ops), [
    "api:invoiceTheCustomer",
    "api:PATCH /sales/orders",
  ]);
  // With nothing attached every API ref is unresolved.
  assert.deepEqual(unresolvedApiOperations(["api:createSalesOrder"], []), ["api:createSalesOrder"]);
});

test("manifest and index schemas round-trip through JSON with their defaults", () => {
  const manifest = ApiReferenceManifestSchema.parse({
    version: 1,
    sources: [
      { id: "spec", kind: "openapi", name: "sales.json", origin: "file", location: "/tmp/sales.json", bytes: 12, title: "Sales API" },
      { id: "doc-1", kind: "docs", name: "guide.md", origin: "url", location: "https://example.invalid/guide.md", bytes: 4 },
    ],
    updatedAt: 5,
  });
  assert.deepEqual(ApiReferenceManifestSchema.parse(JSON.parse(JSON.stringify(manifest))), manifest);
  assert.equal(manifest.sources[1].apiVersion, undefined);

  const index = ApiReferenceIndexSchema.parse({
    version: 1,
    operations: [{ operationId: "createSalesOrder", method: "POST", path: "/sales/orders", sourceId: "spec" }],
    chunks: [{ id: "doc-1:0", sourceId: "doc-1", text: "prose" }],
  });
  assert.deepEqual(index.operations[0].tags, []);
  assert.equal(index.chunks[0].heading, "");
  assert.deepEqual(ApiReferenceIndexSchema.parse(JSON.parse(JSON.stringify(index))), index);

  const summary = summarizeReference(manifest, index);
  assert.equal(summary.name, "Sales API"); // the spec's title wins over file names
  assert.equal(summary.operationCount, 1);
  assert.equal(summary.chunkCount, 1);
  assert.deepEqual(
    summary.sources.map((s) => [s.id, s.operationCount, s.chunkCount]),
    [["spec", 1, 0], ["doc-1", 0, 1]],
  );
});
