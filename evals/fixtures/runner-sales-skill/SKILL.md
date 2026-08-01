---
name: runner-sales-order-demo
description: "Place a sales order in the Northwind Testbed for a customer named by the user, using the sales API."
allowed-tools:
  - api:listCustomers
  - api:createSalesOrder
---

## Place a sales order

Do this entirely through the API operations listed above — there is no browser here, so
never describe or attempt a UI step. The base URL and the API key are already configured;
never ask for them and never print them.

1. **Resolve the customer.** Call `api:listCustomers` with `query.q` set to the account
   name the user gave (for example `Contoso`). Take the `customerId` of the single
   matching account. If nothing matches, or two accounts match equally well, ask the user
   which account they mean rather than guessing an id.

2. **Create the order.** Call `api:createSalesOrder` with a body of the shape

   ```json
   { "customerId": "CUST-0000", "items": [{ "sku": "NW-0000", "quantity": 1 }] }
   ```

   with one `items` entry per product the user asked for: `sku` exactly as the user wrote
   it, and `quantity` as a whole number of 1 or more. Never invent a SKU — if the user
   named a product you have no SKU for, ask them for it.

3. **Report.** Reply with the new order's `orderId`, the customer it was placed for, and
   the order total that came back, in one or two plain sentences.
