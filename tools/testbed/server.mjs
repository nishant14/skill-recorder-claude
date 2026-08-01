#!/usr/bin/env node
// Northwind Testbed — a tiny sales-order web app you can actually record.
//
// This exists for ONE experiment: the API-grounded-skills feature (Workstream J).
// Record yourself creating a sales order through the HTML UI, analyze the recording,
// then attach one of `tools/testbed/docs/*` and watch how far the SkillBuilder can
// ground the plan in real API operations. The four documentation variants describe
// THIS server, at four honesty levels, so "what did the documentation buy us?" is a
// controlled comparison rather than an anecdote.
//
// Two deliberate design choices make the experiment mean something:
//
//   • The HTML UI does NOT call the JSON API. Form posts mutate `state` directly, so
//     the recording carries no API traffic whatsoever. Any UI→API mapping in the plan
//     is the builder *inferring* it from the attached reference — which is the thing
//     under test. If the UI proxied the API, the recording would leak the answer.
//   • The API lives under a path prefix (`/api/v1`) that shares no route with the UI
//     (`/orders` vs `/api/v1/orders`), so a plan that names `/api/v1/orders` provably
//     came from the documentation and not from a URL the recorder captured.
//
// Zero dependencies (`node:http` only — the repo forbids adding npm packages for this),
// all state in memory, reset on every restart. Nothing here is production code: there
// is no persistence, no CSRF protection, and the API key is a constant in the source.
//
// Run:   npm run testbed          (or: node tools/testbed/server.mjs)
// Port:  8787, or $PORT.

import http from "node:http";
import { fileURLToPath } from "node:url";

/** The only credential the API accepts. A constant on purpose: it is a testbed. */
export const API_KEY = "demo-key-123";

/** Header the API reads the key from — mirrored by every doc variant's securityScheme. */
export const API_KEY_HEADER = "x-api-key";

const BRAND = "Northwind Testbed";

/* --- State ------------------------------------------------------------------ */

/**
 * A fresh, fully-seeded world: 4 customers, 6 products, 2 orders. Every caller gets
 * its own object, so a unit test can drive {@link createHandler} without touching the
 * state the running server mutates.
 */
export function createState() {
  const products = [
    { sku: "NW-1140", name: "Chai Tea Chest", listPrice: 18, inStock: 120, category: "Beverages" },
    { sku: "NW-1215", name: "Aniseed Syrup", listPrice: 12.5, inStock: 64, category: "Condiments" },
    { sku: "NW-2207", name: "Cajun Seasoning", listPrice: 22, inStock: 40, category: "Condiments" },
    { sku: "NW-3310", name: "Boysenberry Spread", listPrice: 25, inStock: 18, category: "Condiments" },
    { sku: "NW-4102", name: "Cranberry Sauce", listPrice: 40, inStock: 6, category: "Condiments" },
    { sku: "NW-5588", name: "Kobe Beef Selection", listPrice: 97, inStock: 3, category: "Meat" },
  ];
  const customers = [
    { customerId: "CUST-1001", name: "Contoso Ltd", email: "orders@contoso.example", city: "Seattle", country: "US" },
    { customerId: "CUST-1002", name: "Fabrikam Inc", email: "purchasing@fabrikam.example", city: "Portland", country: "US" },
    { customerId: "CUST-1003", name: "Adventure Works", email: "ap@adventure-works.example", city: "Austin", country: "US" },
    { customerId: "CUST-1004", name: "Tailspin Toys", email: "buyer@tailspintoys.example", city: "Denver", country: "US" },
  ];
  const state = { customers, products, orders: [], nextOrderNumber: 10001, nextCustomerNumber: 1005 };
  seedOrder(state, "CUST-1001", [{ sku: "NW-1140", quantity: 12 }, { sku: "NW-2207", quantity: 3 }], "submitted");
  seedOrder(state, "CUST-1003", [{ sku: "NW-3310", quantity: 5 }], "shipped");
  return state;
}

function seedOrder(state, customerId, items, status) {
  const order = buildOrder(state, customerId, items);
  order.status = status;
  state.orders.push(order);
  return order;
}

/** Money the app prints and returns: 2dp, so 12.5 × 3 never shows up as 37.500000001. */
function money(value) {
  return Math.round(value * 100) / 100;
}

/**
 * Price a set of `{sku, quantity}` lines against the catalog and mint an order.
 * The caller has already validated the customer and the SKUs — this only computes,
 * so the UI path and the API path can never disagree about a total.
 */
function buildOrder(state, customerId, items) {
  const customer = state.customers.find((c) => c.customerId === customerId);
  const lines = items.map((item) => {
    const product = state.products.find((p) => p.sku === item.sku);
    const quantity = Number(item.quantity);
    return {
      sku: product.sku,
      name: product.name,
      quantity,
      unitPrice: product.listPrice,
      lineTotal: money(product.listPrice * quantity),
    };
  });
  const orderId = `SO-${state.nextOrderNumber++}`;
  return {
    orderId,
    customerId,
    customerName: customer ? customer.name : "",
    status: "submitted",
    items: lines,
    total: money(lines.reduce((sum, l) => sum + l.lineTotal, 0)),
    createdAt: new Date().toISOString(),
  };
}

/** The order statuses the API and the UI both accept. */
const STATUSES = ["draft", "submitted", "shipped", "cancelled"];

/**
 * Validate an incoming order payload against the catalog. Returns `{error}` with a
 * message written for whoever sees it (an API client or the UI's red banner), or
 * `{customerId, items}` ready for {@link buildOrder}.
 */
function validateOrder(state, payload) {
  const customerId = String(payload?.customerId ?? "").trim();
  if (!customerId) return { error: "customerId is required." };
  if (!state.customers.some((c) => c.customerId === customerId)) {
    return { error: `Unknown customer ${customerId}.` };
  }
  const raw = Array.isArray(payload?.items) ? payload.items : [];
  const items = [];
  for (const entry of raw) {
    const sku = String(entry?.sku ?? "").trim();
    if (!sku) continue;
    const quantity = Number(entry?.quantity);
    if (!Number.isInteger(quantity) || quantity < 1) {
      return { error: `Quantity for ${sku} must be a whole number of 1 or more.` };
    }
    if (!state.products.some((p) => p.sku === sku)) return { error: `Unknown SKU ${sku}.` };
    items.push({ sku, quantity });
  }
  if (items.length === 0) return { error: "An order needs at least one line item." };
  return { customerId, items };
}

/* --- Tiny response helpers -------------------------------------------------- */

function json(status, body) {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: `${JSON.stringify(body, null, 2)}\n`,
  };
}

function redirect(location) {
  // 303 so the browser re-issues the follow-up as a GET: plain post/redirect/get, which
  // is what keeps a reload from re-submitting an order during a recording.
  return { status: 303, headers: { location, "content-type": "text/plain; charset=utf-8" }, body: "" };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const STYLE = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; font: 15px/1.5 -apple-system, "Segoe UI", system-ui, sans-serif; color: #1c2230; background: #f4f6fa; }
header { background: #1f3a5f; color: #fff; padding: 14px 28px; }
header a { color: #cfe0f5; text-decoration: none; margin-right: 18px; font-weight: 600; }
header a:hover { color: #fff; text-decoration: underline; }
header .brand { color: #fff; font-weight: 700; margin-right: 28px; }
main { max-width: 940px; margin: 0 auto; padding: 26px 28px 60px; }
h1 { font-size: 24px; margin: 0 0 6px; }
h2 { font-size: 17px; margin: 30px 0 10px; }
p.lede { color: #58627a; margin: 0 0 22px; }
table { border-collapse: collapse; width: 100%; background: #fff; border: 1px solid #dfe4ee; }
th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid #eef1f6; }
th { background: #eef2f8; font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: #46506a; }
tr:last-child td { border-bottom: 0; }
form { background: #fff; border: 1px solid #dfe4ee; padding: 18px; margin-top: 12px; }
label { display: block; font-size: 13px; font-weight: 600; margin: 12px 0 4px; color: #46506a; }
input, select { padding: 7px 9px; border: 1px solid #c6cede; background: #fff; font: inherit; min-width: 240px; }
input[type="number"] { min-width: 90px; }
button { margin-top: 18px; padding: 9px 20px; border: 0; background: #1f3a5f; color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
button:hover { background: #2b5286; }
.row { display: flex; gap: 14px; flex-wrap: wrap; align-items: flex-end; }
.error { background: #fdecec; border: 1px solid #e5a3a3; color: #8c2020; padding: 10px 14px; margin-bottom: 16px; }
.pill { display: inline-block; padding: 2px 9px; border-radius: 10px; background: #e3ebf7; font-size: 12px; font-weight: 600; }
.total { font-weight: 700; }
a.card { display: block; background: #fff; border: 1px solid #dfe4ee; padding: 16px 18px; margin-bottom: 10px; text-decoration: none; color: inherit; }
a.card:hover { border-color: #1f3a5f; }
a.card strong { display: block; font-size: 16px; margin-bottom: 3px; }
a.card span { color: #58627a; font-size: 14px; }
`;

/**
 * Every page's title is `<Page> — Northwind Testbed`. The recorder identifies pages by
 * their window title, so a distinct, human-readable title per page is what makes the
 * captured steps legible ("Orders — Northwind Testbed" → "Order SO-10003 — …").
 */
function page(title, bodyHtml) {
  return {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    body: `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — ${BRAND}</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <a class="brand" href="/">${BRAND}</a>
  <a href="/orders">Orders</a>
  <a href="/customers">Customers</a>
  <a href="/products">Products</a>
</header>
<main>
${bodyHtml}
</main>
</body>
</html>
`,
  };
}

function notFoundHtml() {
  return { ...page("Not found", `<h1>Not found</h1><p class="lede">No such page. <a href="/">Back to the home page</a>.</p>`), status: 404 };
}

/* --- Request body parsing --------------------------------------------------- */

/** `sku=A&sku=B` → `{sku: ["A","B"]}`; a single occurrence stays a string. */
function parseForm(raw) {
  const params = new URLSearchParams(raw ?? "");
  const out = {};
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    out[key] = values.length > 1 ? values : values[0];
  }
  return out;
}

function asArray(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/* --- The handler ------------------------------------------------------------ */

/**
 * Build the request handler over a given world. Transport-free by design: it takes a
 * plain `{method, url, headers, body}` object and returns `{status, headers, body}`,
 * so `server.test.mjs` drives every route — including the form posts that mutate
 * state — without opening a socket or picking a port.
 */
export function createHandler(state) {
  return function handle(request) {
    const method = String(request?.method ?? "GET").toUpperCase();
    const headers = normalizeHeaders(request?.headers);
    const url = new URL(String(request?.url ?? "/"), "http://127.0.0.1");
    const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
    const body = typeof request?.body === "string" ? request.body : "";

    if (pathname === "/api/v1" || pathname.startsWith("/api/v1/")) {
      return handleApi(state, method, pathname.slice("/api/v1".length) || "/", url, headers, body);
    }
    return handleUi(state, method, pathname, url, body);
  };
}

function normalizeHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return out;
}

/* --- JSON API (/api/v1) ----------------------------------------------------- */

function handleApi(state, method, route, url, headers, rawBody) {
  if (headers[API_KEY_HEADER] !== API_KEY) {
    return json(401, {
      error: "unauthorized",
      message: `Send the API key in the ${API_KEY_HEADER} header.`,
    });
  }

  let payload = null;
  if (method === "POST" || method === "PATCH" || method === "PUT") {
    if (rawBody.trim()) {
      try {
        payload = JSON.parse(rawBody);
      } catch {
        return json(400, { error: "invalid_json", message: "The request body is not valid JSON." });
      }
    } else {
      payload = {};
    }
  }

  if (route === "/customers") {
    if (method === "GET") {
      const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
      const matches = q
        ? state.customers.filter((c) => c.name.toLowerCase().includes(q) || c.customerId.toLowerCase().includes(q))
        : state.customers;
      return json(200, matches);
    }
    if (method === "POST") {
      const name = String(payload?.name ?? "").trim();
      if (!name) return json(400, { error: "invalid_request", message: "name is required." });
      const customer = {
        customerId: `CUST-${state.nextCustomerNumber++}`,
        name,
        email: String(payload?.email ?? "").trim(),
        city: String(payload?.city ?? "").trim(),
        country: String(payload?.country ?? "").trim(),
      };
      state.customers.push(customer);
      return json(201, customer);
    }
    return methodNotAllowed(["GET", "POST"]);
  }

  const customerMatch = /^\/customers\/([^/]+)$/.exec(route);
  if (customerMatch) {
    if (method !== "GET") return methodNotAllowed(["GET"]);
    const customer = state.customers.find((c) => c.customerId === decodeURIComponent(customerMatch[1]));
    return customer ? json(200, customer) : json(404, { error: "not_found", message: "No such customer." });
  }

  if (route === "/products") {
    if (method !== "GET") return methodNotAllowed(["GET"]);
    const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
    const matches = q
      ? state.products.filter((p) => p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q))
      : state.products;
    return json(200, matches);
  }

  if (route === "/orders") {
    if (method === "GET") {
      const customerId = (url.searchParams.get("customerId") ?? "").trim();
      const status = (url.searchParams.get("status") ?? "").trim();
      const matches = state.orders.filter(
        (o) => (!customerId || o.customerId === customerId) && (!status || o.status === status),
      );
      return json(200, matches);
    }
    if (method === "POST") {
      const validated = validateOrder(state, payload);
      if (validated.error) return json(400, { error: "invalid_request", message: validated.error });
      const order = buildOrder(state, validated.customerId, validated.items);
      if (payload?.purchaseOrderRef) order.purchaseOrderRef = String(payload.purchaseOrderRef);
      if (payload?.notes) order.notes = String(payload.notes);
      state.orders.push(order);
      return { ...json(201, order), headers: { "content-type": "application/json; charset=utf-8", location: `/api/v1/orders/${order.orderId}` } };
    }
    return methodNotAllowed(["GET", "POST"]);
  }

  const orderMatch = /^\/orders\/([^/]+)$/.exec(route);
  if (orderMatch) {
    const orderId = decodeURIComponent(orderMatch[1]);
    const index = state.orders.findIndex((o) => o.orderId === orderId);
    if (index === -1) return json(404, { error: "not_found", message: "No such order." });
    if (method === "GET") return json(200, state.orders[index]);
    if (method === "PATCH") {
      const order = state.orders[index];
      if (payload?.status !== undefined) {
        const status = String(payload.status);
        if (!STATUSES.includes(status)) {
          return json(400, { error: "invalid_request", message: `status must be one of ${STATUSES.join(", ")}.` });
        }
        order.status = status;
      }
      if (payload?.notes !== undefined) order.notes = String(payload.notes);
      if (payload?.purchaseOrderRef !== undefined) order.purchaseOrderRef = String(payload.purchaseOrderRef);
      return json(200, order);
    }
    if (method === "DELETE") {
      state.orders.splice(index, 1);
      return { status: 204, headers: {}, body: "" };
    }
    return methodNotAllowed(["GET", "PATCH", "DELETE"]);
  }

  return json(404, { error: "not_found", message: `No API route ${route}.` });
}

function methodNotAllowed(allowed) {
  return {
    ...json(405, { error: "method_not_allowed", message: `Allowed: ${allowed.join(", ")}.` }),
    headers: { "content-type": "application/json; charset=utf-8", allow: allowed.join(", ") },
  };
}

/* --- HTML UI ---------------------------------------------------------------- */

function handleUi(state, method, pathname, url, rawBody) {
  if (pathname === "/") {
    if (method !== "GET") return notFoundHtml();
    return page(
      "Home",
      `<h1>Northwind Testbed</h1>
<p class="lede">A tiny sales-order app for recording a real piece of work. All data is in memory and resets when the server restarts.</p>
<a class="card" href="/orders"><strong>Orders</strong><span>${state.orders.length} order(s) — browse them, or place a new one.</span></a>
<a class="card" href="/customers"><strong>Customers</strong><span>${state.customers.length} account(s) — browse them, or add one.</span></a>
<a class="card" href="/products"><strong>Products</strong><span>${state.products.length} catalog item(s) with list prices.</span></a>`,
    );
  }

  if (pathname === "/customers") {
    if (method === "GET") return customersPage(state, url.searchParams.get("error"));
    if (method === "POST") {
      const form = parseForm(rawBody);
      const name = String(form.name ?? "").trim();
      if (!name) return redirect("/customers?error=A+customer+needs+a+name.");
      state.customers.push({
        customerId: `CUST-${state.nextCustomerNumber++}`,
        name,
        email: String(form.email ?? "").trim(),
        city: String(form.city ?? "").trim(),
        country: String(form.country ?? "").trim(),
      });
      return redirect("/customers");
    }
    return notFoundHtml();
  }

  if (pathname === "/products") {
    if (method !== "GET") return notFoundHtml();
    return page(
      "Products",
      `<h1>Products</h1>
<p class="lede">The catalog the order form prices line items against.</p>
<table>
  <tr><th>SKU</th><th>Name</th><th>Category</th><th>List price</th><th>In stock</th></tr>
  ${state.products
    .map(
      (p) =>
        `<tr><td>${escapeHtml(p.sku)}</td><td>${escapeHtml(p.name)}</td><td>${escapeHtml(p.category)}</td><td>$${p.listPrice.toFixed(2)}</td><td>${p.inStock}</td></tr>`,
    )
    .join("\n  ")}
</table>`,
    );
  }

  if (pathname === "/orders") {
    if (method === "GET") return ordersPage(state, url.searchParams.get("error"));
    if (method === "POST") {
      const form = parseForm(rawBody);
      const skus = asArray(form.sku);
      const quantities = asArray(form.quantity);
      const items = skus
        .map((sku, i) => ({ sku: String(sku ?? "").trim(), quantity: Number(quantities[i] ?? 0) }))
        .filter((item) => item.sku);
      const validated = validateOrder(state, { customerId: form.customerId, items });
      if (validated.error) return redirect(`/orders?error=${encodeURIComponent(validated.error)}`);
      const order = buildOrder(state, validated.customerId, validated.items);
      state.orders.push(order);
      return redirect(`/orders/${order.orderId}`);
    }
    return notFoundHtml();
  }

  const orderMatch = /^\/orders\/([^/]+)$/.exec(pathname);
  if (orderMatch) {
    if (method !== "GET") return notFoundHtml();
    const order = state.orders.find((o) => o.orderId === decodeURIComponent(orderMatch[1]));
    if (!order) return notFoundHtml();
    return page(
      `Order ${order.orderId}`,
      `<h1>Order ${escapeHtml(order.orderId)}</h1>
<p class="lede">${escapeHtml(order.customerName)} (${escapeHtml(order.customerId)}) · <span class="pill">${escapeHtml(order.status)}</span> · placed ${escapeHtml(order.createdAt)}</p>
<table>
  <tr><th>SKU</th><th>Product</th><th>Qty</th><th>Unit price</th><th>Line total</th></tr>
  ${order.items
    .map(
      (l) =>
        `<tr><td>${escapeHtml(l.sku)}</td><td>${escapeHtml(l.name)}</td><td>${l.quantity}</td><td>$${l.unitPrice.toFixed(2)}</td><td>$${l.lineTotal.toFixed(2)}</td></tr>`,
    )
    .join("\n  ")}
  <tr><td colspan="4" class="total">Order total</td><td class="total">$${order.total.toFixed(2)}</td></tr>
</table>
<p><a href="/orders">Back to all orders</a></p>`,
    );
  }

  return notFoundHtml();
}

function customersPage(state, error) {
  return page(
    "Customers",
    `<h1>Customers</h1>
<p class="lede">Every account an order can be placed for.</p>
${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
<table>
  <tr><th>Account id</th><th>Name</th><th>Email</th><th>City</th><th>Country</th></tr>
  ${state.customers
    .map(
      (c) =>
        `<tr><td>${escapeHtml(c.customerId)}</td><td>${escapeHtml(c.name)}</td><td>${escapeHtml(c.email)}</td><td>${escapeHtml(c.city)}</td><td>${escapeHtml(c.country)}</td></tr>`,
    )
    .join("\n  ")}
</table>
<h2>Add a customer</h2>
<form method="post" action="/customers">
  <div class="row">
    <div><label for="name">Account name</label><input id="name" name="name" required></div>
    <div><label for="email">Email</label><input id="email" name="email" type="email"></div>
  </div>
  <div class="row">
    <div><label for="city">City</label><input id="city" name="city"></div>
    <div><label for="country">Country</label><input id="country" name="country"></div>
  </div>
  <button type="submit">Add customer</button>
</form>`,
  );
}

function ordersPage(state, error) {
  const rows = [0, 1, 2]
    .map(
      (i) => `  <div class="row">
    <div><label for="sku${i}">Product</label>
      <select id="sku${i}" name="sku">
        <option value="">— none —</option>
        ${state.products.map((p) => `<option value="${escapeHtml(p.sku)}">${escapeHtml(p.sku)} · ${escapeHtml(p.name)} ($${p.listPrice.toFixed(2)})</option>`).join("\n        ")}
      </select>
    </div>
    <div><label for="qty${i}">Quantity</label><input id="qty${i}" name="quantity" type="number" min="1" value="${i === 0 ? 1 : ""}"></div>
  </div>`,
    )
    .join("\n");

  return page(
    "Orders",
    `<h1>Orders</h1>
<p class="lede">Every sales order placed since the server started.</p>
${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
<table>
  <tr><th>Order</th><th>Customer</th><th>Status</th><th>Lines</th><th>Total</th></tr>
  ${state.orders
    .map(
      (o) =>
        `<tr><td><a href="/orders/${escapeHtml(o.orderId)}">${escapeHtml(o.orderId)}</a></td><td>${escapeHtml(o.customerName)}</td><td><span class="pill">${escapeHtml(o.status)}</span></td><td>${o.items.length}</td><td>$${o.total.toFixed(2)}</td></tr>`,
    )
    .join("\n  ")}
</table>
<h2>New order</h2>
<form method="post" action="/orders">
  <label for="customerId">Customer</label>
  <select id="customerId" name="customerId" required>
    <option value="">— choose an account —</option>
    ${state.customers.map((c) => `<option value="${escapeHtml(c.customerId)}">${escapeHtml(c.name)} (${escapeHtml(c.customerId)})</option>`).join("\n    ")}
  </select>
${rows}
  <button type="submit">Submit order</button>
</form>`,
  );
}

/* --- Server ----------------------------------------------------------------- */

/** Adapt the transport-free handler onto `node:http`. */
export function createServer(state = createState()) {
  const handle = createHandler(state);
  return http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      let result;
      try {
        result = handle({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      } catch (err) {
        result = json(500, { error: "internal_error", message: err instanceof Error ? err.message : String(err) });
      }
      res.writeHead(result.status, result.headers);
      res.end(result.body);
    });
  });
}

// Listen only when this file IS the program — importing it (the unit test does) must
// never bind a port.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT ?? 8787);
  createServer().listen(port, "127.0.0.1", () => {
    console.log(`${BRAND} listening on http://127.0.0.1:${port}`);
    console.log(`  UI   http://127.0.0.1:${port}/orders`);
    console.log(`  API  http://127.0.0.1:${port}/api/v1/orders   (header ${API_KEY_HEADER}: ${API_KEY})`);
  });
}
