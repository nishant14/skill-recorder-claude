// Scenario: create a sales order by filling and submitting a web form.
//
// This is the regression test for a structural describer miss the user reproduced
// twice on the testbed: the event stream for "clicked an existing order row" and for
// "filled in the new-order form and submitted it" is **identical** — `/orders` then
// `/orders/<id>`, because the create is a POST/redirect/GET. Filling the form emits
// nothing at all (no title change, no URL change, no clipboard), so the recording has
// a ~40s hole with zero events in it. The only evidence that an order was *created*
// is on screen, in the 1 fps captured frames.
//
// So the events here are deliberately impoverished and the frames carry the task.
// A describer that reasons from the event stream alone reproduces the user's miss
// verbatim ("selected order SO-4471 to open its detail page") and fails the rubric;
// only an analysis that called `get_frames` across the sparse transition can name the
// customer (Contoso Ltd) and the line items (NW-1140, NW-2207), which appear nowhere
// but the pixels.
//
// It is also the first scenario in the suite to exercise the vision path at all.

import { recorder, visit, type Scenario } from "../scenario";

const FIREFOX = "firefox_firefox";
const BASE = "http://127.0.0.1:8787";
const HOME_TITLE = "Northwind Testbed";
const ORDERS_TITLE = "Orders — Northwind Testbed";
const DETAIL_TITLE = "Order SO-4471 — Northwind Testbed";

export const formSubmitFrames: Scenario = {
  id: "form-submit-frames",
  platform: "linux",
  title: "Create a sales order by filling and submitting a web form",
  truth:
    "The user opened the Northwind Testbed in Firefox, went to the Orders page and clicked " +
    "New order. Over roughly forty seconds — during which the recording captured no events " +
    "at all, because typing into a form produces none — they filled the new-order form in: " +
    "customer Contoso Ltd, line item NW-1140 (Chai Tea Chest) qty 12, then line item NW-2207 " +
    "(Cajun Seasoning) qty 3, for a total of $282.00. They pressed Submit order, and the app " +
    "redirected to the detail page of the order it had just created, SO-4471. SO-4471 did not " +
    "exist before this recording: the user CREATED it. It was never selected from the list.",
  build: () => [
    recorder(0),
    ...visit(1500, FIREFOX, `${BASE}/`, HOME_TITLE),
    ...visit(6000, FIREFOX, `${BASE}/orders`, ORDERS_TITLE),
    // --- 42 seconds of complete event silence: the form is being filled in. ---
    ...visit(48000, FIREFOX, `${BASE}/orders/SO-4471`, DETAIL_TITLE),
    recorder(52000),
  ],
  // Everything that distinguishes "created" from "opened" lives in these four screens,
  // all of them inside the silent stretch.
  frames: [
    {
      atMs: 9000,
      title: ORDERS_TITLE,
      lines: [
        "Orders",
        "SO-10001   Fabrikam Inc      $1,204.00   shipped",
        "SO-10002   Adventure Works     $318.50   pending",
        "SO-10003   Litware Inc         $942.75   shipped",
        "[ + New order ]",
      ],
    },
    {
      atMs: 21000,
      title: "New order - Northwind Testbed",
      lines: [
        "New order",
        "Customer:  Contoso Ltd",
        "Line items",
        "NW-1140   Chai Tea Chest   qty 12",
        "(empty row - add another line item)",
      ],
    },
    {
      atMs: 36000,
      title: "New order - Northwind Testbed",
      lines: [
        "New order",
        "Customer:  Contoso Ltd",
        "Line items",
        "NW-1140   Chai Tea Chest      qty 12",
        "NW-2207   Cajun Seasoning     qty 3",
        "Order total:  $282.00",
        "[ Submit order ]   (pointer here)",
      ],
    },
    {
      atMs: 47000,
      title: DETAIL_TITLE,
      lines: [
        "Order SO-4471 - submitted",
        "Customer:  Contoso Ltd",
        "NW-1140   Chai Tea Chest      qty 12",
        "NW-2207   Cajun Seasoning     qty 3",
        "Total $282.00",
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
      // Calibration (measured): the uncalibrated baseline let a frames-blind reading
      // score 12/15 = exactly the 0.8 pass threshold. Splitting the product group and
      // pinning the total ("282" — pixels-only, no collision with SO-4471 or times)
      // puts blind or bookend-only readings well under threshold.
      ["contoso"],
      ["nw-1140", "chai"],
      ["nw-2207", "cajun"],
      ["282"],
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
