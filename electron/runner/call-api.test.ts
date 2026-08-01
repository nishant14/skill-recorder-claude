import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { Tool, ToolResult } from "../foundry/agent";
import { compileAllowlist } from "./allowlist";
import {
  createExecutionTools,
  DECLINED_MESSAGE,
  NO_RESPONSE_MESSAGE,
  type ApiExecutionContext,
  type ConfirmDecision,
} from "./tools";

/**
 * `call_api` — the one tool that carries credentials and reaches a real API.
 *
 * Everything here runs against the **committed fixture reference**
 * (`evals/fixtures/runner-sales-skill/api/`), the same `index.json` + `openapi.json`
 * the live smoke installs, with `fetch` and the confirmation gate injected. Using the
 * real fixture rather than a hand-written index is deliberate: it means these tests
 * also fail if the fixture the gate depends on goes stale.
 *
 * The properties being defended: an operation resolves (or fails with a *useful*
 * failure), the URL is built from configuration rather than from the model, the
 * `allowed-tools` API set is enforced, a write is confirmed before it happens, and the
 * credential travels in the request and nowhere else.
 */

const FIXTURE_API = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "evals",
  "fixtures",
  "runner-sales-skill",
  "api",
);
const FIXTURE_INDEX = path.join(FIXTURE_API, "index.json");
const FIXTURE_SPEC = path.join(FIXTURE_API, "openapi.json");

/** The server the fixture spec declares — the fallback when runner.json sets no apiBase. */
const SPEC_SERVER = "http://127.0.0.1:8787/api/v1";
const KEY = "demo-key-123";

interface Harness {
  tools: Tool[];
  has(name: string): boolean;
  call(args: unknown): Promise<ToolResult>;
  text(result: ToolResult): string;
  failed(result: ToolResult): boolean;
  fetches: { url: string; init: RequestInit }[];
  confirms: { kind: string; summary: string; detail: string }[];
}

interface Options {
  allowedTools?: string[];
  /** Overrides the fixture's own api context (to test a missing/broken index). */
  api?: ApiExecutionContext | null;
  /** The parsed `runner.json`. Defaults to the fixture's shape with a live-ish base. */
  config?: { apiBase?: string; headers?: Record<string, string> } | null;
  decision?: ConfirmDecision;
  respond?: (url: string, init: RequestInit) => Response;
}

async function withApi(options: Options, body: (h: Harness) => Promise<void>): Promise<void> {
  const home = mkdtempSync(path.join(tmpdir(), "sr-call-api-"));
  const fetches: Harness["fetches"] = [];
  const confirms: Harness["confirms"] = [];

  const api =
    options.api === undefined
      ? {
          indexFile: FIXTURE_INDEX,
          specFile: FIXTURE_SPEC,
          config:
            options.config === undefined
              ? { apiBase: "https://api.test/v1", headers: { "X-Api-Key": KEY } }
              : options.config,
        }
      : options.api;

  const tools = createExecutionTools({
    allowlist: compileAllowlist(options.allowedTools ?? ["api:listCustomers", "api:createSalesOrder"]),
    confirm: {
      request: async (kind, summary, detail) => {
        confirms.push({ kind, summary, detail });
        return options.decision ?? "approve";
      },
    },
    ask: { ask: async () => null },
    homeDir: home,
    ...(api ? { api } : {}),
    fetchImpl: (async (input: unknown, init: RequestInit = {}) => {
      fetches.push({ url: String(input), init });
      return options.respond?.(String(input), init) ?? new Response("{}", { status: 200, statusText: "OK" });
    }) as unknown as typeof fetch,
  });

  const tool = tools.find((t) => t.name === "call_api");
  const text = (result: ToolResult) => (typeof result === "string" ? result : result.textResultForLlm ?? "");

  try {
    await body({
      tools,
      fetches,
      confirms,
      text,
      failed: (result) => typeof result !== "string" && result.resultType === "failure",
      has: (name) => tools.some((t) => t.name === name),
      async call(args) {
        assert.ok(tool, "call_api should be registered for this skill");
        return tool.handler(args);
      },
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// --- registration -------------------------------------------------------------

test("call_api is registered only for a skill that carries a usable operation index", async () => {
  await withApi({}, async (h) => {
    assert.equal(h.has("call_api"), true);
    // The other five are unchanged; call_api sits between the web and the user.
    assert.deepEqual(h.tools.map((t) => t.name), [
      "run_shell",
      "read_file",
      "write_file",
      "fetch_url",
      "call_api",
      "ask_user",
    ]);
  });

  await withApi({ api: null }, async (h) => {
    assert.equal(h.has("call_api"), false, "a skill with no api/ folder never sees the tool");
  });

  const dir = mkdtempSync(path.join(tmpdir(), "sr-call-api-index-"));
  try {
    const broken = path.join(dir, "index.json");
    writeFileSync(broken, "{ not json");
    await withApi({ api: { indexFile: broken } }, async (h) => {
      assert.equal(h.has("call_api"), false, "an unreadable index means no tool, not a tool that always fails");
    });
    const empty = path.join(dir, "empty.json");
    writeFileSync(empty, JSON.stringify({ version: 1, operations: [], chunks: [], updatedAt: 0 }));
    await withApi({ api: { indexFile: empty } }, async (h) => {
      assert.equal(h.has("call_api"), false);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the description names the operations this skill is actually allowed to call", async () => {
  await withApi({}, async (h) => {
    const description = h.tools.find((t) => t.name === "call_api")?.description ?? "";
    assert.match(description, /listCustomers, createSalesOrder/);
    assert.ok(!description.includes("deleteOrder"), "operations the skill never declared are not advertised");
  });
});

// --- resolution ---------------------------------------------------------------

test("an operation resolves out of the fixture index and becomes a real request", async () => {
  await withApi({ respond: () => new Response(JSON.stringify([{ customerId: "CUST-1001" }]), { status: 200 }) }, async (h) => {
    const result = await h.call({ operationId: "listCustomers", query: { q: "Contoso" } });
    assert.match(h.text(result), /^HTTP 200 .*· GET \/customers/);
    assert.match(h.text(result), /"customerId": "CUST-1001"/, "a JSON body comes back pretty-printed");

    const [request] = h.fetches;
    assert.equal(request.url, "https://api.test/v1/customers?q=Contoso");
    assert.equal(request.init.method, "GET");
    assert.deepEqual(request.init.headers, { "Content-Type": "application/json", "X-Api-Key": KEY });
    assert.equal(request.init.body, undefined);
    assert.deepEqual(h.confirms, [], "a read is not confirmation-gated");
  });
});

test("both api: spellings and the METHOD /path route form resolve to the same operation", async () => {
  await withApi({}, async (h) => {
    for (const requested of ["listCustomers", "api:listCustomers", "GET /customers"]) {
      await h.call({ operationId: requested });
    }
    assert.deepEqual(
      h.fetches.map((f) => f.url),
      ["https://api.test/v1/customers", "https://api.test/v1/customers", "https://api.test/v1/customers"],
    );
  });
});

test("an unknown operationId fails in band with near-matches, and calls nothing", async () => {
  await withApi({ allowedTools: [] }, async (h) => {
    const result = await h.call({ operationId: "createSalesOrders" });
    assert.equal(h.failed(result), true);
    assert.match(h.text(result), /There is no operation "createSalesOrders"/);
    assert.match(h.text(result), /Did you mean one of these\?/);
    assert.match(h.text(result), /createSalesOrder {2}POST \/orders/);
    assert.deepEqual(h.fetches, []);

    assert.match(h.text(await h.call({})), /Pass an `operationId`/);
  });
});

// --- the base URL --------------------------------------------------------------

test("runner.json's apiBase wins; without one the spec's first server is used", async () => {
  await withApi({ config: { apiBase: "https://tenant.example/api/v1/", headers: {} } }, async (h) => {
    await h.call({ operationId: "listCustomers" });
    assert.equal(h.fetches[0].url, "https://tenant.example/api/v1/customers", "a trailing slash doesn't double up");
  });

  await withApi({ config: { headers: { "X-Api-Key": KEY } } }, async (h) => {
    await h.call({ operationId: "listCustomers" });
    assert.equal(h.fetches[0].url, `${SPEC_SERVER}/customers`, "the spec's servers[0] is the fallback");
  });
});

test("no apiBase and no servers is an in-band failure naming runner.json", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sr-call-api-spec-"));
  try {
    const spec = path.join(dir, "openapi.json");
    writeFileSync(spec, JSON.stringify({ openapi: "3.0.3", paths: {} }));
    await withApi(
      { api: { indexFile: FIXTURE_INDEX, specFile: spec, config: null } },
      async (h) => {
        const result = await h.call({ operationId: "listCustomers" });
        assert.equal(h.failed(result), true);
        assert.match(h.text(result), /no API base URL/);
        assert.match(h.text(result), /runner\.json/);
        assert.deepEqual(h.fetches, []);
      },
    );
    // A spec file that isn't there at all degrades the same way, never throws.
    await withApi(
      { api: { indexFile: FIXTURE_INDEX, specFile: path.join(dir, "gone.json"), config: {} } },
      async (h) => {
        assert.match(h.text(await h.call({ operationId: "listCustomers" })), /no API base URL/);
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- path params + query -------------------------------------------------------

test("path placeholders are substituted and URL-encoded; a missing one is reported", async () => {
  await withApi({ allowedTools: [] }, async (h) => {
    await h.call({ operationId: "getOrder", pathParams: { orderId: "SO 10003/x" } });
    assert.equal(h.fetches[0].url, "https://api.test/v1/orders/SO%2010003%2Fx");

    const missing = await h.call({ operationId: "getOrder" });
    assert.equal(h.failed(missing), true);
    assert.match(h.text(missing), /getOrder is GET \/orders\/\{orderId\} — pass `orderId` in `pathParams`/);
    assert.equal(h.fetches.length, 1, "the incomplete call never went out");
  });
});

test("query values are appended and encoded, arrays repeat, objects are dropped", async () => {
  await withApi({ allowedTools: [] }, async (h) => {
    await h.call({
      operationId: "listOrders",
      query: { customerId: "CUST 1001", status: ["submitted", "shipped"], bad: { nested: true }, n: 2 },
    });
    const url = new URL(h.fetches[0].url);
    assert.equal(url.searchParams.get("customerId"), "CUST 1001");
    assert.deepEqual(url.searchParams.getAll("status"), ["submitted", "shipped"]);
    assert.equal(url.searchParams.get("n"), "2");
    assert.equal(url.searchParams.has("bad"), false);
    assert.match(h.fetches[0].url, /customerId=CUST\+1001/);
  });
});

// --- the allowlist -------------------------------------------------------------

test("an operation the frontmatter never declared is refused in band, naming the allowed ones", async () => {
  await withApi({ allowedTools: ["api:listCustomers", "api:createSalesOrder"] }, async (h) => {
    const refused = h.text(await h.call({ operationId: "deleteOrder", pathParams: { orderId: "SO-10001" } }));
    assert.match(refused, /do not include api:deleteOrder/);
    assert.match(refused, /api:listCustomers, api:createSalesOrder/);
    assert.deepEqual(h.fetches, [], "nothing was called");
    assert.deepEqual(h.confirms, [], "and the user was never asked to approve it");
  });
});

test("a skill that declared no api: entries at all may call any indexed operation", async () => {
  await withApi({ allowedTools: ["Read"] }, async (h) => {
    await h.call({ operationId: "listProducts" });
    assert.equal(h.fetches.length, 1);
  });
});

// --- confirmation --------------------------------------------------------------

test("a write is confirmation-gated, and the card never shows the credential", async () => {
  const body = { customerId: "CUST-1001", items: [{ sku: "NW-1140", quantity: 2 }] };
  await withApi({ respond: () => new Response(JSON.stringify({ orderId: "SO-10003" }), { status: 201, statusText: "Created" }) }, async (h) => {
    const result = await h.call({ operationId: "createSalesOrder", body });

    assert.equal(h.confirms.length, 1);
    const [card] = h.confirms;
    assert.equal(card.kind, "api");
    assert.equal(card.summary, "Call createSalesOrder (POST /v1/orders)", "the card names the real path, not the template");
    assert.match(card.detail, /^POST https:\/\/api\.test\/v1\/orders/);
    assert.match(card.detail, /"sku": "NW-1140"/, "the user sees exactly what will be sent");
    assert.match(card.detail, /Headers: Content-Type, X-Api-Key/);
    assert.ok(!card.detail.includes(KEY), "the header VALUE is never shown to anyone");

    const [request] = h.fetches;
    assert.equal(request.init.method, "POST");
    assert.equal(request.init.body, JSON.stringify(body));
    assert.match(h.text(result), /HTTP 201 Created/);
  });
});

test("denying or ignoring the confirmation answers in band and sends nothing", async () => {
  await withApi({ decision: "deny" }, async (h) => {
    assert.equal(h.text(await h.call({ operationId: "createSalesOrder", body: {} })), DECLINED_MESSAGE);
    assert.deepEqual(h.fetches, []);
  });
  await withApi({ decision: "timeout" }, async (h) => {
    assert.equal(h.text(await h.call({ operationId: "createSalesOrder", body: {} })), NO_RESPONSE_MESSAGE);
    assert.deepEqual(h.fetches, []);
  });
});

// --- the response --------------------------------------------------------------

test("a response over the cap is truncated with a marker", async () => {
  await withApi({ respond: () => new Response("R".repeat(300 * 1024), { status: 200 }) }, async (h) => {
    const text = h.text(await h.call({ operationId: "listCustomers" }));
    assert.ok(text.length < 210 * 1024, `the body should be capped, got ${text.length} chars`);
    assert.match(text, /…\[truncated: \d+ more characters\]$/);
  });
});

test("a non-2xx answer is reported as a failure with the server's own message", async () => {
  await withApi(
    {
      respond: () =>
        new Response(JSON.stringify({ error: "invalid_request", message: "Unknown SKU NW-9999." }), {
          status: 400,
          statusText: "Bad Request",
        }),
    },
    async (h) => {
      const result = await h.call({ operationId: "createSalesOrder", body: { customerId: "CUST-1001" } });
      assert.equal(h.failed(result), true);
      assert.match(h.text(result), /HTTP 400 Bad Request/);
      assert.match(h.text(result), /Unknown SKU NW-9999\./);
    },
  );
});

test("a transport error and a stopped request both answer in band", async () => {
  await withApi(
    {
      respond: () => {
        throw new Error("ECONNREFUSED 127.0.0.1:8787");
      },
    },
    async (h) => {
      const result = await h.call({ operationId: "listCustomers" });
      assert.equal(h.failed(result), true);
      assert.match(h.text(result), /Could not reach this skill's API: ECONNREFUSED/);
    },
  );
});

test("an empty body reads as empty rather than as a blank result", async () => {
  // 204 itself can't be built with `new Response`, but the empty-body path is the same.
  await withApi({ respond: () => new Response("", { status: 200, statusText: "OK" }) }, async (h) => {
    assert.match(h.text(await h.call({ operationId: "listCustomers" })), /HTTP 200 OK[\s\S]*\(empty response\)/);
  });
});
