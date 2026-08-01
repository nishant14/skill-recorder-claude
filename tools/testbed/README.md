# Northwind Testbed — the manual API-grounding experiment

A runnable sales-order web app plus four descriptions of its API, for answering one
question by hand: **how much does the attached documentation actually buy the
SkillBuilder?** (Workstream J — `docs/plans/foundry-codex-migration-workstream-j.md`.)

You record yourself creating an order through the app's HTML UI, approve the analysis,
then build the same skill four times — once per documentation level — and compare the
plans. The scored eval counterparts live in `evals/skillbuilder/scenarios.ts`
(`api-sales-order`, `-minimal`, `-docs`, `-partial`) and attach *these same files*, so the
two never describe different APIs.

## Why the app is built the way it is

Two properties make the experiment mean something, and both are easy to break:

- **The HTML UI never calls the JSON API.** Form posts mutate the in-memory store
  directly. The recording therefore contains zero API traffic — any UI→API mapping in a
  plan is the builder *inferring* it from the attached reference, which is the thing under
  test. If the UI proxied the API, the recording would leak the answer.
- **The API lives under a path prefix the UI never uses.** `/orders` is a page;
  `/api/v1/orders` is the endpoint. A plan that names `/api/v1/orders` provably read it in
  the documentation rather than from a URL the recorder captured.

Everything is in memory and re-seeds on restart (4 customers, 6 products, 2 orders), so
you can run the experiment as many times as you like from an identical starting state.

## Files

| File | What it is |
|---|---|
| `server.mjs` | The app. Dependency-free `node:http`; `createHandler(state)` is exported so `server.test.mjs` drives every route without a socket. |
| `docs/openapi-full.json` | **L1** — OpenAPI 3.0, real `operationId`s, `components` + `$ref` schemas, descriptions, apiKey scheme. |
| `docs/openapi-minimal.json` | **L2** — same paths and methods, **no** `operationId`s, one-line summaries, loose inline schemas. |
| `docs/api-guide.md` | **L3** — prose only. Endpoints, the auth header, `curl` examples and JSON bodies; no OpenAPI structure. |
| `docs/openapi-partial.json` | **L4** — L1 quality, but only customers + products. The orders endpoints are absent entirely. |
| `server.test.mjs` | The socket-free unit test (in `npm test`). Guards the contract the four docs describe. |

All four describe **the same server**. If you change a route, a field, or a status code in
`server.mjs`, change all four (and the test) in the same commit — a doc that has drifted
from the app turns this experiment into noise.

## 1. Start the app

```bash
npm run testbed          # → http://127.0.0.1:8787   (PORT=9000 npm run testbed to move it)
```

Sanity-check both surfaces before you start recording:

```bash
curl -s http://127.0.0.1:8787/api/v1/orders                              # 401, JSON
curl -s -H "X-Api-Key: demo-key-123" http://127.0.0.1:8787/api/v1/orders # the two seeded orders
```

## 2. Record creating an order

Start the recorder, then do exactly this in a browser and nothing else:

1. Open `http://127.0.0.1:8787/` — the home page (**Home — Northwind Testbed**).
2. Click **Customers**. Read the list; note that *Contoso Ltd* is `CUST-1001`.
   (**Customers — Northwind Testbed**)
3. Click **Products**. Note `NW-1140` (Chai Tea Chest, $18.00) and `NW-2207`
   (Cajun Seasoning, $22.00). (**Products — Northwind Testbed**)
4. Click **Orders** (**Orders — Northwind Testbed**), scroll to **New order**.
5. Choose customer **Contoso Ltd (CUST-1001)**.
6. Row 1: product `NW-1140 · Chai Tea Chest`, quantity **12**.
7. Row 2: product `NW-2207 · Cajun Seasoning`, quantity **3**.
8. Leave row 3 empty and press **Submit order**. You land on the order detail page
   (**Order SO-10003 — Northwind Testbed**), total **$282.00**.
9. Stop the recording.

Every page has its own descriptive `<title>` because the recorder identifies pages by
window title — that is what makes the captured steps legible.

Then **Analyze**. Check the approved analysis before going further: it should describe
finding the customer, adding two SKU+quantity lines, and submitting — the *semantic*
intent, not a click log. Reuse this one approved analysis for all four builds so the
documentation is the only thing that changes.

## 3. Build once per documentation level

For each level, on the session's **target picker sheet**: attach the file, pick the **App**
target, and let the builder panel build. Read the proposed plan in the review tiles.

> **Attaching or removing a reference resets the builder conversation** — the app calls
> `builder.forget` / `automationBuilder.forget` so the next build rebuilds its tools. That
> is by design, and it is also what keeps the four runs independent: always attach the
> next file *before* opening the builder panel, and remove the previous one first.

### L1 · `docs/openapi-full.json`

The best case. Expect action steps whose `tool` is a real operation ref:

- `api:createSalesOrder` for placing the order,
- `api:listCustomers` (or `api:getCustomer`) for resolving *Contoso Ltd* → `CUST-1001`,
- possibly `api:listProducts` for the SKUs,
- `allowed-tools` listing the operations the plan uses.

No `click`, no `browser`, no "navigate to". The plan should mention `customerId` and an
`items` array of `{sku, quantity}` — fields it can only have got from the spec.

### L2 · `docs/openapi-minimal.json`

Same paths, no `operationId`s, so the indexer synthesizes ids
(`synthesizeOperationId` in `common/api-reference.ts`). Expect exactly these:

| Route | Synthesized id |
|---|---|
| `GET /customers` | `getCustomers` |
| `POST /customers` | `postCustomers` |
| `GET /customers/{customerId}` | `getCustomersByCustomerId` |
| `GET /products` | `getProducts` |
| `GET /orders` | `getOrders` |
| `POST /orders` | `postOrders` |
| `GET /orders/{orderId}` | `getOrdersByOrderId` |
| `PATCH /orders/{orderId}` | `patchOrdersByOrderId` |
| `DELETE /orders/{orderId}` | `deleteOrdersByOrderId` |

So the order step should read `api:postOrders` (or the equally valid route form,
`api:POST /orders`), and the lookup `api:getCustomers`. A plan that says
`api:createSalesOrder` here is a hallucination — and `propose_plan` should have
**hard-rejected** it before you ever saw it, so if one reaches the tiles, that is a
finding worth writing down.

### L3 · `docs/api-guide.md`

Unstructured prose. Indexing yields **chunks only, no operations** — so the builder gets
`search_api_docs` but `list_api_operations` has nothing to list, and **no `api:` ref can
resolve at all**. This is the level that tests honesty:

- **Expected**: the endpoints named in the step *text* — `POST /api/v1/orders` with
  `customerId` + `items`, `GET /api/v1/customers` for the lookup — and the `X-Api-Key`
  header mentioned as a requirement. Still no UI replay.
- **Failure to look for**: any `api:<something>` on a step's `tool`. There is nothing for
  it to point at; it would be invented grounding. (The propose-time lint should reject it.)

### L4 · `docs/openapi-partial.json`

Customers and products documented properly, orders missing entirely. The interesting
behaviour is *mixed*:

- **Expected**: `api:listCustomers` / `api:getCustomer` for the account, `api:listProducts`
  for the SKUs — and then an **honest** order step that says placing the order goes through
  the app's own New order form, because the reference describes no order endpoint.
- **Failure to look for**: `api:createSalesOrder`, `api:createOrder`, `api:POST /orders` —
  any operation this spec does not define. Silently inventing the missing half is the
  regression this level exists to catch.

## Credentials — what you should and should not see

The API key is `demo-key-123`. The plan is allowed to say the request needs the
`apiKeyAuth` scheme, or the `X-Api-Key` header; it must **never** contain the value. The
operation-detail tool returns security *scheme names* only, and credentials are a
runner/connector concern. If `demo-key-123` shows up anywhere in a plan, a value, a
`SKILL.md`, or an export bundle, that is a leak — record it and stop.

## What to write down

Per level: the step `tool`s the plan emitted, whether `allowed-tools` listed operations,
whether the UI vocabulary survived, and anything the builder invented. The comparison
across the four rows is the result; a single plan on its own says very little.

## Keeping this honest

- `npm test` runs `server.test.mjs`, which pins the seeded data, the totals, the 401, the
  page titles and the UI form posts.
- `evals/skillbuilder/scenarios.ts` reads `docs/*` from this folder directly, so the scored
  variants and this protocol cannot drift apart.
- Run the scored group with
  `npm run eval:skill -- --only=api-sales-order,api-sales-order-minimal,api-sales-order-docs,api-sales-order-partial`
  (live, credentialed — a human runs it; it is never wired into `npm test`).
