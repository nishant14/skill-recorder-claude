// Unit tests for the Northwind Testbed app (tools/testbed/server.mjs).
//
// Socket-free on purpose: every case drives `createHandler(state)` directly with a
// plain request object, so the suite never binds a port, never races a listener, and
// never leaks a server into the rest of `npm test`. Each test starts from its own
// `createState()`, so order of execution can't matter.
//
// What's guarded here is the contract the four documentation variants in
// `tools/testbed/docs/` describe: if a response shape drifts from what the specs say,
// the manual API-grounding experiment quietly stops testing anything.

import assert from "node:assert/strict";
import test from "node:test";

import { API_KEY, createHandler, createState } from "./server.mjs";

/** A caller with the key, for the JSON API. */
function api(handle, method, url, body) {
  const res = handle({
    method,
    url,
    headers: { "x-api-key": API_KEY, "content-type": "application/json" },
    body: body === undefined ? "" : JSON.stringify(body),
  });
  return { ...res, json: res.body ? JSON.parse(res.body) : null };
}

/** A browser: HTML in, HTML (or a redirect) out. */
function ui(handle, method, url, form) {
  return handle({
    method,
    url,
    headers: form ? { "content-type": "application/x-www-form-urlencoded" } : {},
    body: form ? new URLSearchParams(form).toString() : "",
  });
}

/** `<title>…</title>` of an HTML response. */
function titleOf(res) {
  return /<title>([^<]*)<\/title>/.exec(res.body)?.[1] ?? "";
}

function fresh() {
  return createHandler(createState());
}

/* --- Seed ------------------------------------------------------------------- */

test("seeds four customers, six products and two orders", () => {
  const handle = fresh();
  assert.equal(api(handle, "GET", "/api/v1/customers").json.length, 4);
  assert.equal(api(handle, "GET", "/api/v1/products").json.length, 6);
  assert.equal(api(handle, "GET", "/api/v1/orders").json.length, 2);
});

test("state is per-instance, so one handler's orders never leak into another", () => {
  const a = fresh();
  api(a, "POST", "/api/v1/orders", { customerId: "CUST-1001", items: [{ sku: "NW-1140", quantity: 1 }] });
  assert.equal(api(a, "GET", "/api/v1/orders").json.length, 3);
  assert.equal(api(fresh(), "GET", "/api/v1/orders").json.length, 2);
});

/* --- Auth ------------------------------------------------------------------- */

test("the API answers 401 JSON without the key", () => {
  const handle = fresh();
  const res = handle({ method: "GET", url: "/api/v1/orders", headers: {}, body: "" });
  assert.equal(res.status, 401);
  assert.match(res.headers["content-type"], /application\/json/);
  assert.equal(JSON.parse(res.body).error, "unauthorized");
});

test("a wrong key is rejected the same way", () => {
  const handle = fresh();
  const res = handle({ method: "GET", url: "/api/v1/customers", headers: { "x-api-key": "nope" }, body: "" });
  assert.equal(res.status, 401);
});

test("the HTML UI needs no key — it is a different surface entirely", () => {
  const handle = fresh();
  assert.equal(ui(handle, "GET", "/orders").status, 200);
});

/* --- Reads ------------------------------------------------------------------ */

test("customers can be searched by name, and fetched by id", () => {
  const handle = fresh();
  const found = api(handle, "GET", "/api/v1/customers?q=contoso").json;
  assert.equal(found.length, 1);
  assert.equal(found[0].customerId, "CUST-1001");
  assert.equal(api(handle, "GET", "/api/v1/customers/CUST-1001").json.name, "Contoso Ltd");
  assert.equal(api(handle, "GET", "/api/v1/customers/CUST-9999").status, 404);
});

test("products can be searched by SKU", () => {
  const handle = fresh();
  const found = api(handle, "GET", "/api/v1/products?q=NW-2207").json;
  assert.equal(found.length, 1);
  assert.equal(found[0].listPrice, 22);
});

test("orders can be filtered by customer and status", () => {
  const handle = fresh();
  assert.equal(api(handle, "GET", "/api/v1/orders?customerId=CUST-1003").json.length, 1);
  assert.equal(api(handle, "GET", "/api/v1/orders?status=shipped").json.length, 1);
  assert.equal(api(handle, "GET", "/api/v1/orders?status=draft").json.length, 0);
});

/* --- Order creation --------------------------------------------------------- */

test("creating an order prices each line from the catalog and totals them", () => {
  const handle = fresh();
  const res = api(handle, "POST", "/api/v1/orders", {
    customerId: "CUST-1002",
    items: [
      { sku: "NW-1140", quantity: 12 }, // 18.00 × 12 = 216
      { sku: "NW-1215", quantity: 3 }, //  12.50 ×  3 =  37.50
    ],
  });
  assert.equal(res.status, 201);
  assert.equal(res.json.customerId, "CUST-1002");
  assert.equal(res.json.customerName, "Fabrikam Inc");
  assert.equal(res.json.status, "submitted");
  assert.deepEqual(res.json.items.map((l) => l.lineTotal), [216, 37.5]);
  assert.equal(res.json.total, 253.5);
  assert.match(res.json.orderId, /^SO-\d+$/);
  assert.equal(api(handle, "GET", `/api/v1/orders/${res.json.orderId}`).json.total, 253.5);
});

test("optional purchaseOrderRef and notes are kept on the order", () => {
  const handle = fresh();
  const order = api(handle, "POST", "/api/v1/orders", {
    customerId: "CUST-1001",
    items: [{ sku: "NW-5588", quantity: 1 }],
    purchaseOrderRef: "PO-77",
    notes: "Leave at reception",
  }).json;
  assert.equal(order.purchaseOrderRef, "PO-77");
  assert.equal(order.notes, "Leave at reception");
});

test("an order is rejected for an unknown customer, an unknown SKU, or no lines", () => {
  const handle = fresh();
  const bad = [
    { customerId: "CUST-9999", items: [{ sku: "NW-1140", quantity: 1 }] },
    { customerId: "CUST-1001", items: [{ sku: "NOPE-1", quantity: 1 }] },
    { customerId: "CUST-1001", items: [] },
    { customerId: "CUST-1001", items: [{ sku: "NW-1140", quantity: 0 }] },
  ];
  for (const payload of bad) {
    const res = api(handle, "POST", "/api/v1/orders", payload);
    assert.equal(res.status, 400, JSON.stringify(payload));
    assert.equal(res.json.error, "invalid_request");
  }
  assert.equal(api(handle, "GET", "/api/v1/orders").json.length, 2, "nothing was created");
});

test("a malformed JSON body is a 400, not a crash", () => {
  const handle = fresh();
  const res = handle({ method: "POST", url: "/api/v1/orders", headers: { "x-api-key": API_KEY }, body: "{not json" });
  assert.equal(res.status, 400);
  assert.equal(JSON.parse(res.body).error, "invalid_json");
});

/* --- Customer creation ------------------------------------------------------ */

test("POST /customers assigns an account id", () => {
  const handle = fresh();
  const res = api(handle, "POST", "/api/v1/customers", { name: "Wingtip Toys", city: "Boise" });
  assert.equal(res.status, 201);
  assert.match(res.json.customerId, /^CUST-\d+$/);
  assert.equal(api(handle, "GET", "/api/v1/customers").json.length, 5);
  assert.equal(api(handle, "POST", "/api/v1/customers", { name: "  " }).status, 400);
});

/* --- PATCH + DELETE --------------------------------------------------------- */

test("PATCH updates status and notes, and refuses an unknown status", () => {
  const handle = fresh();
  const id = api(handle, "GET", "/api/v1/orders").json[0].orderId;
  const patched = api(handle, "PATCH", `/api/v1/orders/${id}`, { status: "shipped", notes: "Split shipment" });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.status, "shipped");
  assert.equal(patched.json.notes, "Split shipment");
  assert.equal(api(handle, "PATCH", `/api/v1/orders/${id}`, { status: "teleported" }).status, 400);
  assert.equal(api(handle, "GET", `/api/v1/orders/${id}`).json.status, "shipped", "the bad patch changed nothing");
  assert.equal(api(handle, "PATCH", "/api/v1/orders/SO-0", { status: "draft" }).status, 404);
});

test("DELETE removes the order and answers 204", () => {
  const handle = fresh();
  const id = api(handle, "GET", "/api/v1/orders").json[0].orderId;
  const res = api(handle, "DELETE", `/api/v1/orders/${id}`);
  assert.equal(res.status, 204);
  assert.equal(res.body, "");
  assert.equal(api(handle, "GET", `/api/v1/orders/${id}`).status, 404);
  assert.equal(api(handle, "GET", "/api/v1/orders").json.length, 1);
});

test("a wrong method on a known route is a 405 with an Allow header", () => {
  const handle = fresh();
  const res = api(handle, "DELETE", "/api/v1/products");
  assert.equal(res.status, 405);
  assert.equal(res.headers.allow, "GET");
});

test("an unknown API route is a JSON 404", () => {
  const handle = fresh();
  const res = api(handle, "GET", "/api/v1/invoices");
  assert.equal(res.status, 404);
  assert.equal(res.json.error, "not_found");
});

/* --- HTML pages ------------------------------------------------------------- */

test("every UI page answers 200 with its own descriptive title", () => {
  const handle = fresh();
  const expected = [
    ["/", "Home — Northwind Testbed"],
    ["/orders", "Orders — Northwind Testbed"],
    ["/customers", "Customers — Northwind Testbed"],
    ["/products", "Products — Northwind Testbed"],
    ["/orders/SO-10001", "Order SO-10001 — Northwind Testbed"],
  ];
  for (const [url, title] of expected) {
    const res = ui(handle, "GET", url);
    assert.equal(res.status, 200, url);
    assert.match(res.headers["content-type"], /text\/html/);
    assert.equal(titleOf(res), title);
  }
});

test("an unknown page is a 404 HTML page", () => {
  const handle = fresh();
  const res = ui(handle, "GET", "/orders/SO-99999");
  assert.equal(res.status, 404);
  assert.match(res.headers["content-type"], /text\/html/);
});

test("the orders page offers every customer and product in its new-order form", () => {
  const handle = fresh();
  const body = ui(handle, "GET", "/orders").body;
  assert.match(body, /<form method="post" action="\/orders">/);
  assert.match(body, /value="CUST-1004"/);
  assert.match(body, /value="NW-5588"/);
});

/* --- UI form posts mutate state (no API involved) --------------------------- */

test("submitting the new-order form creates the order and redirects to its page", () => {
  const handle = fresh();
  const res = ui(handle, "POST", "/orders", [
    ["customerId", "CUST-1004"],
    ["sku", "NW-1140"],
    ["quantity", "2"],
    ["sku", "NW-4102"],
    ["quantity", "1"],
    ["sku", ""],
    ["quantity", ""],
  ]);
  assert.equal(res.status, 303);
  const location = res.headers.location;
  assert.match(location, /^\/orders\/SO-\d+$/);

  const detail = ui(handle, "GET", location);
  assert.equal(detail.status, 200);
  assert.match(detail.body, /Tailspin Toys/);
  assert.match(detail.body, /\$76\.00/); // 18×2 + 40×1

  // The same order is visible over the API — the UI mutated the one shared store.
  const created = api(handle, "GET", `/api/v1${location}`).json;
  assert.equal(created.customerId, "CUST-1004");
  assert.equal(created.total, 76);
  assert.equal(created.items.length, 2, "blank rows are dropped");
});

test("an invalid new-order submission redirects back with an error and creates nothing", () => {
  const handle = fresh();
  const res = ui(handle, "POST", "/orders", [["customerId", "CUST-1001"], ["sku", ""], ["quantity", ""]]);
  assert.equal(res.status, 303);
  assert.match(res.headers.location, /^\/orders\?error=/);
  assert.equal(api(handle, "GET", "/api/v1/orders").json.length, 2);
  assert.match(ui(handle, "GET", res.headers.location).body, /at least one line item/);
});

test("submitting the add-customer form adds the account and redirects", () => {
  const handle = fresh();
  const res = ui(handle, "POST", "/customers", { name: "Wingtip Toys", email: "ap@wingtip.example" });
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, "/customers");
  assert.equal(api(handle, "GET", "/api/v1/customers").json.length, 5);
  assert.match(ui(handle, "GET", "/customers").body, /Wingtip Toys/);
});

test("a nameless customer submission is refused with a message", () => {
  const handle = fresh();
  const res = ui(handle, "POST", "/customers", { name: "   " });
  assert.equal(res.status, 303);
  assert.match(res.headers.location, /error=/);
  assert.equal(api(handle, "GET", "/api/v1/customers").json.length, 4);
});
