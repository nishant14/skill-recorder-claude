// Scenario: create a sales order by filling and submitting a web form.
//
// This is the regression test for a structural describer miss the user reproduced three
// times on the testbed. The event stream for "clicked an existing order row" and for
// "filled in the new-order form and submitted it" is **identical** — `/orders` then
// `/orders/<id>`, because the create is a POST/redirect/GET. Filling the form emits
// nothing at all (no title change, no URL change, no clipboard), so the recording has a
// ~38s hole with zero events in it. The only evidence that an order was *created* is on
// screen, in the captured frames.
//
// The frames are modelled directly on the real failing recording
// (`20260802-132458-cd74061c`: 12 frames, 5s heartbeat, 46.7s), because the first cut of
// this scenario passed while reality kept failing. Three things closed that gap, and all
// three are the point of the fixture:
//
//   1. **A decoy.** The testbed's Orders page lists existing orders *directly above* the
//      New order form, and the seeded SO-4401 has the SAME customer (Contoso Ltd), the
//      same line count and the SAME total ($282.00) as the order the user is about to
//      create. A model that glances at one list frame and one detail frame sees a
//      matching row and concludes the detail page was opened from the list. That
//      coincidence is what the real recording contains, so it is what the fixture
//      contains.
//   2. **Heartbeat cadence, not curated stills.** Twelve frames at ~5s land wherever
//      they land: an empty form, a half-typed one, and two caught with a product
//      dropdown hanging open mid-pick. No frame is a tidy "here is the completed form".
//   3. **Incremental states.** Any single frame is ambiguous; only the *sequence*
//      (none → Contoso → dropdown open → one line → two lines → submit → detail) shows
//      a record being built rather than read.
//
// A describer that reasons from the event stream alone reproduces the user's miss
// verbatim ("navigated through the app and opened an order's details page") and fails
// the rubric; only an analysis that called `get_frames` across the sparse transition can
// name the customer and the line items, which appear nowhere but the pixels.
//
// It is also the only scenario in the suite that exercises the vision path at all.

import { recorder, visit, type Scenario } from "../scenario";

const FIREFOX = "firefox_firefox";
const BASE = "http://127.0.0.1:8787";
const HOME_TITLE = "Home — Northwind Testbed";
const ORDERS_TITLE = "Orders — Northwind Testbed";
const DETAIL_TITLE = "Order SO-4471 — Northwind Testbed";

/** The decoy: an existing order that matches the new one on customer, lines and total. */
const DECOY = "SO-4401   Contoso Ltd        submitted   2 lines   $282.00";
const OTHER = "SO-4402   Adventure Works    shipped     1 line    $125.00";
/**
 * Layout group for the New order page. Every frame in it renders on one silhouette, so
 * consecutive states differ only in the text of a field — which is what makes them
 * collide under the extractor's 9x8 dHash, exactly as the real recording's did.
 */
const FORM = "new-order-form";

export const formSubmitFrames: Scenario = {
  id: "form-submit-frames",
  platform: "linux",
  title: "Create a sales order by filling and submitting a web form",
  truth:
    "The user opened the Northwind Testbed in Firefox and went to the Orders page, which " +
    "lists the existing orders (including SO-4401 for Contoso Ltd, 2 lines, $282.00) above " +
    "a New order form. Over roughly forty seconds — during which the recording captured no " +
    "events at all, because typing into a form produces none — they filled that form in: " +
    "customer Contoso Ltd (CUST-1001), then line item NW-1140 (Chai Tea Chest) qty 12 and " +
    "line item NW-2207 (Cajun Seasoning) qty 3, for a total of $282.00. They pressed Submit " +
    "order, and the app redirected to the detail page of the order it had just created, " +
    "SO-4471. SO-4471 did not exist before this recording: the user CREATED it. It was " +
    "never selected from the list — SO-4401, which looks identical on customer and total, " +
    "is a different, pre-existing order.",
  build: () => [
    recorder(0),
    ...visit(1500, FIREFOX, `${BASE}/`, HOME_TITLE),
    ...visit(6000, FIREFOX, `${BASE}/orders`, ORDERS_TITLE),
    // --- 38 seconds of complete event silence: the form is being filled in. ---
    ...visit(43900, FIREFOX, `${BASE}/orders/SO-4471`, DETAIL_TITLE),
    recorder(47000),
  ],
  // Twelve frames on the recorder's 5s heartbeat, at the offsets the failing recording
  // actually produced (including its 10s/11s burst). Everything that distinguishes
  // "created" from "opened" is spread across them; no single one settles it.
  frames: [
    {
      atMs: 975,
      title: HOME_TITLE,
      lines: [
        "Northwind Testbed",
        "Orders     Customers     Products",
        "A tiny sales app for recording experiments.",
        "2 orders placed since the server started.",
      ],
    },
    {
      atMs: 4935,
      title: HOME_TITLE,
      lines: [
        "Northwind Testbed",
        "> Orders",
        "Customers",
        "Products",
        "Home — nothing entered yet",
      ],
    },
    {
      atMs: 9934,
      title: ORDERS_TITLE,
      lines: [
        "Orders",
        "Every sales order placed since the server started.",
        "ORDER     CUSTOMER           STATUS      LINES     TOTAL",
        DECOY,
        OTHER,
        "New order  (form below the list)",
      ],
    },
    {
      atMs: 11058,
      title: ORDERS_TITLE,
      layout: FORM,
      lines: [
        "New order",
        DECOY + "   (already in the list)",
        "Customer:   — none —",
        "Product 1:  — none —                  Quantity: 1",
        "Product 2:  — none —                  Quantity:",
        "Product 3:  — none —                  Quantity:",
        "[ Submit order ]",
      ],
    },
    {
      // One field gained, nothing else moved — Hamming 0 against its predecessor.
      atMs: 14934,
      title: ORDERS_TITLE,
      layout: FORM,
      lines: [
        "New order",
        DECOY + "   (already in the list)",
        "Customer:   Contoso Ltd (CUST-1001)",
        "Product 1:  — none —                  Quantity: 1",
        "Product 2:  — none —                  Quantity:",
        "Product 3:  — none —                  Quantity:",
        "[ Submit order ]",
      ],
    },
    {
      // Caught mid-pick: the product dropdown is hanging open over the form.
      atMs: 19934,
      title: ORDERS_TITLE,
      lines: [
        "New order — picking product 1",
        "Customer:  Contoso Ltd (CUST-1001)      Quantity: 12",
        "> — none —",
        "NW-1140 · Chai Tea Chest ($18.00)",
        "NW-1215 · Aniseed Syrup ($12.50)",
        "NW-2207 · Cajun Seasoning ($22.00)",
        "NW-3310 · Boysenberry Spread ($25.00)",
        "NW-4102 · Cranberry Sauce ($40.00)",
        "NW-5588 · Kobe Beef Selection ($97.00)",
      ],
    },
    {
      // One line item entered. Same page, one more filled field: also sub-threshold.
      atMs: 24934,
      title: ORDERS_TITLE,
      layout: FORM,
      lines: [
        "New order",
        DECOY + "   (already in the list)",
        "Customer:   Contoso Ltd (CUST-1001)",
        "Product 1:  NW-1140 Chai Tea Chest    Quantity: 12",
        "Product 2:  — none —                  Quantity:",
        "Product 3:  — none —                  Quantity:",
        "[ Submit order ]",
      ],
    },
    {
      // Caught mid-pick again, this time on the second line item.
      atMs: 29934,
      title: ORDERS_TITLE,
      lines: [
        "New order — picking product 2",
        "Customer:   Contoso Ltd (CUST-1001)",
        "Product 1:  NW-1140 Chai Tea Chest    Quantity: 12",
        "Product 2:  (open)                    Quantity: 3",
        "NW-1215 · Aniseed Syrup ($12.50)",
        "> NW-2207 · Cajun Seasoning ($22.00)",
        "NW-3310 · Boysenberry Spread ($25.00)",
      ],
    },
    {
      atMs: 34934,
      title: ORDERS_TITLE,
      layout: FORM,
      lines: [
        "New order",
        DECOY + "   (already in the list)",
        "Customer:   Contoso Ltd (CUST-1001)",
        "Product 1:  NW-1140 Chai Tea Chest    Quantity: 12",
        "Product 2:  NW-2207 Cajun Seasoning   Quantity: 3",
        "Product 3:  — none —                  Quantity:",
        "[ Submit order ]",
      ],
    },
    {
      atMs: 39934,
      title: ORDERS_TITLE,
      layout: FORM,
      lines: [
        "New order — ready to submit",
        DECOY + "   (already in the list)",
        "Customer:   Contoso Ltd (CUST-1001)",
        "Product 1:  NW-1140 Chai Tea Chest    Quantity: 12",
        "Product 2:  NW-2207 Cajun Seasoning   Quantity: 3",
        "Product 3:  — none —                  Quantity:",
        "[ Submit order ]   (pointer here)",
      ],
    },
    {
      atMs: 44934,
      title: DETAIL_TITLE,
      lines: [
        "Order SO-4471",
        "Contoso Ltd (CUST-1001) · submitted · placed just now",
        "SKU        PRODUCT            QTY   UNIT      LINE TOTAL",
        "NW-1140    Chai Tea Chest      12   $18.00    $216.00",
        "NW-2207    Cajun Seasoning      3   $22.00     $66.00",
        "Order total                                   $282.00",
      ],
    },
    {
      atMs: 46705,
      title: DETAIL_TITLE,
      lines: [
        "Order SO-4471 — submitted",
        "Contoso Ltd (CUST-1001)",
        "NW-1140 Chai Tea Chest · qty 12 · $216.00",
        "NW-2207 Cajun Seasoning · qty 3 · $66.00",
        "Order total $282.00",
        "Back to all orders",
      ],
    },
  ],
  rubric: {
    intentKeywordsAny: [
      // The act, not the navigation.
      ["creat", "submit", "plac", "new order", "enter", "add"],
      ["order", "so-4471"],
    ],
    minSteps: 2,
    maxSteps: 6,
    expectedApps: ["firefox"],
    orderedActions: [
      ["orders page", "order list", "orders list", "orders"],
      ["form", "fill", "filled", "new order", "line item", "contoso"],
      ["submit", "creat", "plac", "so-4471"],
    ],
    mustMentionAny: [
      ["creat", "submit", "plac", "filled", "filling", "fill in", "fill out"],
      ["order"],
      // Only ever visible on screen — proof the frames were actually consulted.
      ["contoso"],
      ["nw-1140", "nw-2207", "chai", "cajun"],
      ["so-4471"],
    ],
    // The exact framing of the user's reproduced miss. Substring, case-insensitive,
    // matched against the intent + step titles/apps only — a correct analysis says
    // "submitted the order" or "created order SO-4471", never "selected order".
    forbidden: [
      "selected order",
      "selected an existing",
      "opened an existing",
      "reviewed an existing",
      "skill recorder",
    ],
  },
};
