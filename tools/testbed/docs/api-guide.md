# Northwind Testbed — developer guide

Documentation level **L3**: prose only. This file describes exactly the same nine
endpoints as `openapi-full.json`, but as a hand-written guide with no machine-readable
structure — no `paths` object, no operation ids, no schemas. Attaching it gives the
builder retrievable *text* and nothing to resolve an operation reference against, which
is the honest limit the experiment is meant to show.

## Base address

Everything lives under `http://127.0.0.1:8787/api/v1`. The server keeps all of its data
in memory and starts from the same seed every time it boots, so you can experiment
freely — restart it and you are back to four customers, six products, two orders.

Note that the endpoints below are **not** the addresses of the web pages. The pages you
click through (`/orders`, `/customers`, `/products`) are server-rendered HTML and mutate
the store directly; the JSON endpoints under `/api/v1` are a separate surface that does
the same work programmatically.

## Authentication

Every JSON endpoint requires a key, sent in the `X-Api-Key` request header. A request
without it, or with the wrong value, is answered `401` with a JSON body of the form
`{"error": "unauthorized", "message": "..."}`. Ask whoever runs the server for the key —
it is per-deployment, and it should never be pasted into a document, a saved procedure,
or anything you check in.

## Customers

Customer accounts are the thing an order is placed for. An account looks like this:

```json
{
  "customerId": "CUST-1001",
  "name": "Contoso Ltd",
  "email": "orders@contoso.example",
  "city": "Seattle",
  "country": "US"
}
```

**List or search accounts** — `GET /api/v1/customers`. Pass `?q=` to match on the
account name or the account id; omit it to get everything. This is how you turn a
customer's name into the `customerId` an order needs.

```bash
curl -s "http://127.0.0.1:8787/api/v1/customers?q=contoso" \
  -H "X-Api-Key: $NORTHWIND_KEY"
```

**Fetch one account** — `GET /api/v1/customers/{customerId}`, when you already know the
id. Answers `404` if there is no such account.

**Create an account** — `POST /api/v1/customers` with a JSON body. Only `name` is
required; the server assigns the account id and returns the whole record with `201`.

```bash
curl -s -X POST "http://127.0.0.1:8787/api/v1/customers" \
  -H "X-Api-Key: $NORTHWIND_KEY" -H "Content-Type: application/json" \
  -d '{"name": "Wingtip Toys", "email": "ap@wingtip.example", "city": "Boise", "country": "US"}'
```

## Products

**List or search the catalog** — `GET /api/v1/products`, with the same optional `?q=`
matching on the product name or the SKU. Products are read-only over the API; the
catalog is fixed at boot.

```json
{ "sku": "NW-1140", "name": "Chai Tea Chest", "category": "Beverages", "listPrice": 18, "inStock": 120 }
```

You do not have to look a product up before ordering it — the server prices each line
from the catalog itself — but listing the catalog is how you find the SKU that goes with
a product name, and how you check stock before promising a quantity.

## Sales orders

An order carries the customer it is for, its priced line items, a status and a total:

```json
{
  "orderId": "SO-10001",
  "customerId": "CUST-1001",
  "customerName": "Contoso Ltd",
  "status": "submitted",
  "items": [
    { "sku": "NW-1140", "name": "Chai Tea Chest", "quantity": 12, "unitPrice": 18, "lineTotal": 216 }
  ],
  "total": 216,
  "createdAt": "2026-08-01T09:14:22.001Z"
}
```

Status is one of `draft`, `submitted`, `shipped` or `cancelled`.

**List orders** — `GET /api/v1/orders`, optionally filtered with `?customerId=` and/or
`?status=`.

**Place an order** — `POST /api/v1/orders`. The body needs the `customerId` and a
non-empty `items` array, where each entry is a catalog `sku` and a whole-number
`quantity` of one or more. You do not send prices: the server looks each SKU up in the
catalog, fills in `unitPrice` and `lineTotal` per line, sums them into `total`, assigns
the next order number and answers `201` with the finished order. `purchaseOrderRef` and
`notes` are optional free-text fields kept with the order.

```bash
curl -s -X POST "http://127.0.0.1:8787/api/v1/orders" \
  -H "X-Api-Key: $NORTHWIND_KEY" -H "Content-Type: application/json" \
  -d '{
        "customerId": "CUST-1001",
        "items": [
          { "sku": "NW-1140", "quantity": 12 },
          { "sku": "NW-2207", "quantity": 3 }
        ]
      }'
```

A body naming a customer that does not exist, a SKU that is not in the catalog, or an
empty `items` array is rejected `400` with an explanation in `message`.

**Fetch one order** — `GET /api/v1/orders/{orderId}`, using the order number the create
call returned (`SO-10001` and up). `404` when there is no such order.

**Update an order** — `PATCH /api/v1/orders/{orderId}` with any of `status`,
`purchaseOrderRef` or `notes`. Line items are frozen once the order is placed; an
unrecognised status is a `400`.

```bash
curl -s -X PATCH "http://127.0.0.1:8787/api/v1/orders/SO-10001" \
  -H "X-Api-Key: $NORTHWIND_KEY" -H "Content-Type: application/json" \
  -d '{"status": "shipped"}'
```

**Delete an order** — `DELETE /api/v1/orders/{orderId}`, answered `204` with no body.
There is no undo; the record is gone until the server restarts and re-seeds.

## Errors

Every non-2xx response is a JSON object with a machine-readable `error` code and a
human-readable `message`. The codes you will see are `unauthorized` (401),
`invalid_request` and `invalid_json` (400), `not_found` (404) and `method_not_allowed`
(405, with an `Allow` response header listing what the route does accept).
