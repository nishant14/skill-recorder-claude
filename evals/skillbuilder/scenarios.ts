// Skill builder eval scenarios.
//
// Two fixed, approved analyses chosen to exercise the SkillBuilder's richer plan
// shape end to end:
//
//   • price-tracker — a recurring read-from-one-page-then-record task. It should
//     yield a **fixed** input (the canonical page URL), calculation steps (read the
//     figure, compute the change) and an action step (append the row), reaching for
//     web_fetch + the .xlsx file rather than driving the browser + a spreadsheet UI.
//   • github-issue-triage — the gh-vs-browser case, as a skill. It should generalize
//     to the `gh` CLI (never the browser), split "decide which issues qualify"
//     (calculation) from "comment + label" (action), and gate the mutating action
//     with a confirmation pause because it posts on the user's behalf.
//
// Together they assert the whole new contract: input `source` vocabulary, typed
// calculation/action steps, native-tool choice, and confirmation on the risky step.
//
// Both target this app's own library (`app`), whose agent has a shell, files, and web.
//
// A further four `app` scenarios are the **API-grounded** group. All four share ONE
// approved analysis — ordinary UI work in a sales portal — and differ only in the
// documentation attached to the session, so the group measures *documentation level*
// rather than four unrelated tasks:
//
//   • api-sales-order          L1  full spec, real operationIds → api:createSalesOrder
//   • api-sales-order-minimal  L2  spec with no operationIds    → api:postOrders (synthesized)
//   • api-sales-order-docs     L3  prose guide only             → endpoints in prose, NO api: ref
//   • api-sales-order-partial  L4  customers/products only      → grounded lookup + honest fallback
//
// L1/L2 forbid the UI vocabulary outright. L3 forbids `api:` itself — with no operations
// indexed, any such ref is fabricated grounding. L4 forbids only the order-create ids the
// spec doesn't define, because falling back to the UI there is the *correct* answer.
// L2–L4 attach the real files from `tools/testbed/docs/`, which document the runnable
// testbed app (`tools/testbed/server.mjs`) used for the matching manual experiment.
//
// A third group targets the **copilot-studio** catalogue — a hosted agent with NO
// shell, NO filesystem, and NO browser, only connector actions. These three cover the
// surfaces a maker actually wires up (Teams, Outlook mail, Calendar) and each asserts
// the right `Connector.Action` is reached for, while the browser (playwright/click and
// the *.office.com / teams.microsoft.com hosts) AND any device-shell command are
// forbidden — a Copilot Studio agent cannot run `gh`, `bash`, or read `~/…`.

import { readFileSync } from "node:fs";

import type { AnalysisSubmission } from "../../common/analysis";
import type { SkillBuilderScenario } from "./scenario";

/** The fixture spec attached to the API-grounded scenario, parsed once per run. */
const salesApiSpec = JSON.parse(
  readFileSync(new URL("../mocks/openapi-sales.json", import.meta.url), "utf8"),
) as object;

/**
 * The three **documentation-level** variants attach the real files from
 * `tools/testbed/docs/`, rather than copies. That folder documents the testbed app
 * (`tools/testbed/server.mjs`) a human records by hand for the manual experiment, so
 * reading the same bytes here is what stops the scored eval and the manual protocol
 * from drifting into describing two different APIs. The harness is plain Node, so a
 * synchronous read at module load is all it takes.
 */
function testbedDoc(name: string): string {
  return readFileSync(new URL(`../../tools/testbed/docs/${name}`, import.meta.url), "utf8");
}

/** Read one canonical page, compute a delta, append a dated row to a tracker sheet. */
const priceTracker: SkillBuilderScenario = {
  id: "price-tracker-skill",
  title: "Track a plan price over time in a spreadsheet",
  architecture: "app",
  platform: "darwin",
  truth:
    "Every Monday the user opens the SAME public Acme pricing page in Chrome, reads the Pro " +
    "plan's monthly price, works out how much it changed since the last recorded figure, and " +
    "appends a new dated row (date, price, change) to their Pricing Tracker spreadsheet. " +
    "Generalized on a headless device the right tools are web_fetch (read the fixed public page) " +
    "and writing the .xlsx tracker as a file (append the row) — the page URL is a fixed input, " +
    "the change is a calculation, and appending the row is the one action.",
  analysis: {
    title: "Record the weekly Pro plan price",
    intent:
      "Every week, read the Pro plan's current monthly price from the public Acme pricing page, " +
      "compute how much it changed since the last recorded value, and append a new dated row " +
      "(date, price, change vs last week) to the Pricing Tracker spreadsheet.",
    intentConfidence: "high",
    intentRationale:
      "The browser opened the same Acme pricing page URL; the Pro plan monthly price ($49 / month) " +
      "was read and a new dated row was added below the previous week's row in a Numbers sheet " +
      "titled 'Pricing Tracker'.",
    steps: [
      {
        id: "s1",
        title: "Open the Acme pricing page",
        detail:
          "Navigated in Chrome to the public Acme pricing page — the same canonical URL used every " +
          "week — to read the Pro plan's current monthly price.",
        apps: ["Google Chrome"],
        evidence: ["browser.url https://acme.example/pricing", "title 'Pricing — Acme'"],
        confidence: "high",
      },
      {
        id: "s2",
        title: "Read the Pro plan's monthly price",
        detail: "Read the Pro plan's monthly price ($49 / month) from the pricing table.",
        apps: ["Google Chrome"],
        evidence: ["clipboard '$49 / month'"],
        confidence: "high",
      },
      {
        id: "s3",
        title: "Work out the change since last week",
        detail:
          "Compared this week's price against the previous row's price in the tracker to work out " +
          "the change (this week $49 vs last week $45, so +$4).",
        apps: ["Numbers"],
        evidence: ["app Numbers 'Pricing Tracker — Numbers'"],
        confidence: "medium",
      },
      {
        id: "s4",
        title: "Append a dated row to the Pricing Tracker",
        detail:
          "Added a new row to the Pricing Tracker spreadsheet with today's date, the price, and the " +
          "change versus the previous week.",
        apps: ["Numbers"],
        evidence: ["app Numbers 'Pricing Tracker — Numbers'"],
        confidence: "medium",
      },
    ],
  },
  rubric: {
    mustUseAny: [["web_fetch", "fetch"], ["xlsx", "spreadsheet", "sheet", "csv"]],
    forbidden: [],
    minValues: 1,
    minCalculations: 1,
    minActions: 1,
  },
};

/** Triage bug issues recorded in the browser — should generalize to the gh CLI, and gate the mutating step. */
const githubIssueTriage: SkillBuilderScenario = {
  id: "github-issue-triage-skill",
  title: "Triage new bug issues on GitHub",
  architecture: "app",
  platform: "darwin",
  truth:
    "In Chrome the user opened the acme/api repo's open issues filtered to label:bug with no " +
    "assignee, read a new report, posted a comment asking the reporter for exact reproduction " +
    "steps and their version, and applied the 'needs-info' label — a triage pass they repeat for " +
    "every new unassigned bug. The right generalization drives GitHub with the gh CLI (gh issue " +
    "list / gh issue comment / gh issue edit --add-label), not the browser UI; deciding which " +
    "issues qualify is a calculation, while commenting + labelling is a mutating action that " +
    "should pause for the user's confirmation because it posts on their behalf.",
  analysis: {
    title: "Triage new bug issues",
    intent:
      "Triage newly reported, unassigned bug issues in the acme/api GitHub repository: for each " +
      "open issue labeled 'bug' with no assignee, post a comment asking the reporter for exact " +
      "reproduction steps and their version, then add the 'needs-info' label.",
    intentConfidence: "high",
    intentRationale:
      "The browser stayed on github.com/acme/api issue pages throughout; the same comment text " +
      "and the same 'needs-info' label were applied to a bug issue.",
    steps: [
      {
        id: "s1",
        title: "Open the repo's open bug issues on GitHub",
        detail:
          "Navigated in Chrome to the acme/api issues list filtered to open bug issues with no " +
          "assignee to find reports that still need triage.",
        apps: ["Google Chrome"],
        evidence: [
          "browser.url https://github.com/acme/api/issues?q=is%3Aissue+is%3Aopen+label%3Abug+no%3Aassignee",
          "title 'Issues · acme/api'",
        ],
        confidence: "high",
      },
      {
        id: "s2",
        title: "Open a new bug report to read it",
        detail: "Opened issue #214 in Chrome to read the reported bug before triaging it.",
        apps: ["Google Chrome"],
        evidence: ["browser.url https://github.com/acme/api/issues/214"],
        confidence: "high",
      },
      {
        id: "s3",
        title: "Comment asking for reproduction steps",
        detail:
          "Typed a comment into the issue's comment box and submitted it, asking the reporter for " +
          "exact reproduction steps and the version they are on.",
        apps: ["Google Chrome"],
        evidence: [
          "clipboard 'Thanks for the report! Could you share exact reproduction steps and the version you're on?'",
          "browser.url https://github.com/acme/api/issues/214",
        ],
        confidence: "high",
      },
      {
        id: "s4",
        title: "Apply the needs-info label",
        detail:
          "Opened the Labels sidebar on the issue and applied the 'needs-info' label to mark it as " +
          "waiting on the reporter.",
        apps: ["Google Chrome"],
        evidence: ["browser.url https://github.com/acme/api/issues/214", "label 'needs-info'"],
        confidence: "medium",
      },
    ],
  },
  rubric: {
    mustUseAny: [["gh "], ["gh issue", "gh api"]],
    forbidden: ["playwright", "browser_", "click", "navigate to github", "github.com/acme"],
    minValues: 1,
    minCalculations: 1,
    minActions: 1,
  },
};

/* --- API-grounded scenarios ------------------------------------------------ */

/**
 * The one approved analysis every API-grounded variant is built on: pure UI work in a
 * sales portal (open the new-order form, find the customer, add two line items, submit).
 * It is shared verbatim so the **only** thing that differs across the four variants is
 * the documentation attached to the recording — which is what makes the group a
 * controlled comparison of *documentation level* rather than four unrelated evals.
 */
const salesOrderAnalysis: AnalysisSubmission = {
  title: "Create a sales order for a customer",
  intent:
    "Place a sales order in the Northwind sales portal for a named customer: find the customer's " +
    "account, add each product line (SKU and quantity) to a new order, and submit it.",
  intentConfidence: "high",
  intentRationale:
    "The browser stayed on the Northwind sales portal's New order form; the customer 'Contoso Ltd' " +
    "was searched for and selected, two SKUs with quantities were entered as line items, and the " +
    "order was submitted, landing on the confirmation page for order SO-10482.",
  steps: [
    {
      id: "s1",
      title: "Open the portal's new order form",
      detail:
        "Navigated in Chrome to the Northwind sales portal and started a new sales order from the " +
        "Orders page.",
      apps: ["Google Chrome"],
      evidence: [
        "browser.url https://sales.northwind.example/orders/new",
        "title 'New order — Northwind Sales'",
      ],
      confidence: "high",
    },
    {
      id: "s2",
      title: "Find the customer account",
      detail:
        "Typed the customer's name into the account picker, waited for the matches, and selected " +
        "the 'Contoso Ltd' account the order is for.",
      apps: ["Google Chrome"],
      evidence: [
        "clipboard 'Contoso Ltd'",
        "browser.url https://sales.northwind.example/orders/new",
      ],
      confidence: "high",
    },
    {
      id: "s3",
      title: "Add the line items",
      detail:
        "Added two line items to the order — SKU NW-1140 × 12 and SKU NW-2207 × 3 — entering each " +
        "product code and its quantity in the form's item rows.",
      apps: ["Google Chrome"],
      evidence: ["clipboard 'NW-1140 qty 12'", "clipboard 'NW-2207 qty 3'"],
      confidence: "high",
    },
    {
      id: "s4",
      title: "Submit the order",
      detail:
        "Submitted the completed order and landed on the confirmation page showing the new order " +
        "number SO-10482.",
      apps: ["Google Chrome"],
      evidence: [
        "browser.url https://sales.northwind.example/orders/SO-10482",
        "title 'Order SO-10482 — Northwind Sales'",
      ],
      confidence: "medium",
    },
  ],
};

/**
 * **L1 — a full spec.** The whole point of Workstream J: the recording is pure UI work,
 * but the session has the portal's OpenAPI spec attached — so the right generalization
 * drops the UI entirely and names the operations that do the same job. The fixture
 * deliberately carries decoys (products, invoices, an order *list*), so reaching for
 * `createSalesOrder` + a customer lookup is a real choice, not the only one.
 */
const apiSalesOrder: SkillBuilderScenario = {
  id: "api-sales-order",
  title: "Create a sales order in the Northwind portal (spec attached)",
  architecture: "app",
  platform: "darwin",
  truth:
    "In Chrome the user opens the Northwind sales portal, starts a new order, searches the customer " +
    "account by name, picks it, adds two line items (SKU + quantity), and submits the order. The " +
    "Northwind Sales API spec is attached to the recording, so the right generalization is not a UI " +
    "replay: resolve the customer with listCustomers (or getCustomer once the id is known) and place " +
    "the order with createSalesOrder, passing customerId + items. Clicking through the portal, " +
    "driving a browser, or navigating to the orders page is the wrong answer here.",
  analysis: salesOrderAnalysis,
  apiReference: { spec: salesApiSpec },
  rubric: {
    mustUseAny: [["api:createSalesOrder"], ["api:listCustomers", "api:getCustomer"]],
    forbidden: ["click", "browser", "navigate to"],
    minCalculations: 1,
    minActions: 1,
  },
};

/**
 * **L2 — a spec with no operationIds.** The same nine operations, written the way a
 * hand-maintained spec usually is: one-line summaries, inline schemas, and not a single
 * `operationId`. Grounding must still be exact, but every ref has to use an id
 * *synthesized* from the method and the path (`synthesizeOperationId` in
 * `common/api-reference.ts`: `POST /orders` → `postOrders`) — or the route form the same
 * module accepts, `api:POST /orders`. Both are resolvable; a plan that invents
 * `createSalesOrder` here would be rejected at propose time, because no such id exists.
 */
const apiSalesOrderMinimal: SkillBuilderScenario = {
  id: "api-sales-order-minimal",
  title: "Create a sales order (minimal spec — synthesized operation ids)",
  architecture: "app",
  platform: "darwin",
  truth:
    "The same portal recording, but the attached spec (tools/testbed/docs/openapi-minimal.json) " +
    "declares no operationIds. The indexer synthesizes them from method + path, so the grounded " +
    "answer names api:postOrders for placing the order and api:getCustomers (or " +
    "api:getCustomersByCustomerId) for resolving the account — equivalently the route form, " +
    "api:POST /orders. Replaying the UI is still the wrong answer; so is quoting a friendly " +
    "operation name like createSalesOrder, which this spec never defines.",
  analysis: salesOrderAnalysis,
  apiReference: { spec: JSON.parse(testbedDoc("openapi-minimal.json")) as object },
  rubric: {
    // Each group holds the two forms that actually resolve against this index; the
    // scorer's match is a case-insensitive substring, so "api:POST /orders" satisfies
    // "api:post /orders", and "api:getCustomersByCustomerId" satisfies "api:getCustomers".
    mustUseAny: [
      ["api:postOrders", "api:post /orders"],
      ["api:getCustomers", "api:get /customers"],
    ],
    forbidden: ["click", "browser", "navigate to"],
    minCalculations: 1,
    minActions: 1,
  },
};

/**
 * **L3 — prose documentation only.** No spec at all: the session carries the hand-written
 * guide, which indexes into searchable *chunks* and zero operations. The builder gets
 * `search_api_docs` and nothing to resolve an `api:` ref against, so the honest plan
 * quotes the endpoint it read (`POST /api/v1/orders`) in the step text while leaving the
 * step's tool ungrounded. `api:` is therefore **forbidden**: any such ref here is
 * fabricated grounding, which is the exact failure this variant exists to catch.
 */
const apiSalesOrderDocs: SkillBuilderScenario = {
  id: "api-sales-order-docs",
  title: "Create a sales order (prose docs only — no grounded operations)",
  architecture: "app",
  platform: "darwin",
  truth:
    "The same portal recording with only prose documentation attached " +
    "(tools/testbed/docs/api-guide.md). It describes the endpoints in text — POST /api/v1/orders " +
    "with a customerId and items, GET /api/v1/customers to resolve the account, the X-Api-Key " +
    "header — but carries no machine-readable operations. The right plan names those endpoints " +
    "from what it read and still avoids replaying the UI, while emitting NO `api:` operation " +
    "reference: there is no index for one to resolve against, so an `api:` ref would be invented.",
  analysis: salesOrderAnalysis,
  apiReference: { docs: [{ name: "api-guide.md", text: testbedDoc("api-guide.md") }] },
  rubric: {
    // "}/orders" and "/orders" cover the (desirable) pattern where the model hoists the
    // API base URL into a {{value}} and writes the endpoint as {{base}}/orders — the
    // literal /api/v1 prefix then lives in the value, which the rubric doesn't scan.
    mustUseAny: [["/api/v1/orders", "/orders", "POST /api", "create order endpoint", "createSalesOrder"]],
    // "api:" is safe to forbid *because of the colon*: "/api/v1/orders" and "X-Api-Key"
    // both contain "api" but neither contains "api:". The one shape that would trip it
    // falsely is prose punctuation ("the API: POST /api/v1/orders"), which is rare enough
    // to be worth the check — a fabricated `api:` ref is the failure we're buying.
    forbidden: ["api:", "click", "browser", "navigate to"],
    minCalculations: 1,
    minActions: 1,
  },
};

/**
 * **L4 — a partial spec.** Customers and products are documented to L1 standard; the
 * orders endpoints are absent entirely, as happens when a spec is generated from only
 * the services that were in scope. The interesting behaviour is *mixed*: ground the
 * lookups that can be grounded, and stay honest about the order step by describing the
 * app's own flow instead of inventing an operation for it. `propose_plan` already
 * hard-rejects unresolved `api:` refs, so this rubric names the two ids a model would
 * most plausibly reach for and checks the fallback is a real one.
 */
const apiSalesOrderPartial: SkillBuilderScenario = {
  id: "api-sales-order-partial",
  title: "Create a sales order (partial spec — orders undocumented)",
  architecture: "app",
  platform: "darwin",
  truth:
    "The same portal recording with a partial spec attached " +
    "(tools/testbed/docs/openapi-partial.json): listCustomers, getCustomer, createCustomer and " +
    "listProducts are fully documented, and nothing about orders is. The right plan grounds the " +
    "customer lookup on api:listCustomers (or api:getCustomer once the id is known), grounds the " +
    "SKU lookup on api:listProducts if it needs one, and then says plainly that placing the order " +
    "goes through the app's own New order form because the reference does not describe an order " +
    "endpoint. Claiming api:createSalesOrder — an operation this spec never defines — is the " +
    "failure this variant exists to catch.",
  analysis: salesOrderAnalysis,
  apiReference: { spec: JSON.parse(testbedDoc("openapi-partial.json")) as object },
  rubric: {
    mustUseAny: [
      ["api:listCustomers", "api:getCustomer"],
      // The order step must land somewhere real. Any of these is an honest answer: the
      // app's form, its page, or a web step — none of them claims a documented operation.
      ["order form", "/orders", "submit the order", "web"],
    ],
    // No UI vocabulary is forbidden here: falling back to the UI for the one undocumented
    // step is the CORRECT behaviour at this documentation level, not a regression.
    forbidden: ["api:createSalesOrder", "api:createOrder"],
    minCalculations: 1,
    minActions: 1,
  },
};

/* --- Copilot Studio scenarios --------------------------------------------- */

/** Read a Teams channel in the web app, summarize, post a digest — must use the Teams connector, never a browser. */
const studioTeamsDigest: SkillBuilderScenario = {
  id: "copilot-studio-teams-digest",
  title: "Post a morning digest to the leads Teams channel",
  architecture: "copilot-studio",
  platform: "darwin",
  truth:
    "Every morning the user opens the 'Eng — Announcements' channel in the Teams web app, reads " +
    "the overnight messages, writes a short 3-bullet digest, and posts it to the 'Leads' channel. " +
    "A Copilot Studio agent has no browser and no shell, so the right generalization reads the " +
    "source channel with Teams.GetMessages and posts with Teams.PostMessageToChannel — summarizing " +
    "is a calculation and posting is the one mutating action, which the maker sees called out " +
    "because it posts on the user's behalf. Driving teams.microsoft.com in a browser is wrong.",
  analysis: {
    title: "Post a morning digest to the leads channel",
    intent:
      "Each morning, read the overnight messages in the Eng Announcements Teams channel, summarize " +
      "them into a short digest, and post that digest to the Leads channel for the leads to skim.",
    intentConfidence: "high",
    intentRationale:
      "The Teams web app stayed on the Eng Announcements channel while messages were read, and the " +
      "same digest text was then posted into the Leads channel.",
    steps: [
      {
        id: "s1",
        title: "Open the Eng Announcements channel",
        detail:
          "Opened the 'Eng — Announcements' channel in the Teams web app to read the messages posted " +
          "overnight.",
        apps: ["Microsoft Teams"],
        evidence: [
          "browser.url https://teams.microsoft.com/l/channel/19%3Aeng-announcements/Announcements",
          "title 'Eng — Announcements | Microsoft Teams'",
        ],
        confidence: "high",
      },
      {
        id: "s2",
        title: "Read the overnight messages",
        detail: "Read the overnight posts in the channel to capture what happened.",
        apps: ["Microsoft Teams"],
        evidence: ["clipboard 'Deploy 4.2 shipped; incident #88 resolved; on-call rotates to Priya'"],
        confidence: "high",
      },
      {
        id: "s3",
        title: "Write a 3-bullet digest",
        detail:
          "Condensed the overnight messages into a short three-bullet digest of what the leads need " +
          "to know.",
        apps: ["Microsoft Teams"],
        evidence: ["clipboard '• Deploy 4.2 shipped • Incident #88 resolved • On-call: Priya'"],
        confidence: "medium",
      },
      {
        id: "s4",
        title: "Post the digest to the Leads channel",
        detail: "Posted the three-bullet digest into the 'Leads' channel.",
        apps: ["Microsoft Teams"],
        evidence: [
          "browser.url https://teams.microsoft.com/l/channel/19%3Aleads/Leads",
          "clipboard '• Deploy 4.2 shipped • Incident #88 resolved • On-call: Priya'",
        ],
        confidence: "medium",
      },
    ],
  },
  rubric: {
    mustUseAny: [["teams."], ["postmessagetochannel", "postmessage", "replytomessage"]],
    forbidden: ["playwright", "browser_", "click", "teams.microsoft.com", "bash", "gh "],
    minCalculations: 1,
    minActions: 1,
  },
};

/** Triage unread mail in Outlook web and reply — must use the Outlook connector, never a browser. */
const studioOutlookReply: SkillBuilderScenario = {
  id: "copilot-studio-outlook-reply",
  title: "Acknowledge unread support emails",
  architecture: "copilot-studio",
  platform: "darwin",
  truth:
    "The user triages the Support mailbox in Outlook on the web: for each unread customer email " +
    "they send a short acknowledgement reply. A Copilot Studio agent can't drive a browser, so the " +
    "right tools are Outlook.GetEmails + Outlook.GetEmail to read the unread mail and " +
    "Outlook.ReplyToEmail (or Outlook.SendEmail) to send the acknowledgement — deciding which " +
    "messages qualify is a calculation, and sending the reply is the mutating action the maker " +
    "must see. Replaying outlook.office.com in a browser is wrong.",
  analysis: {
    title: "Acknowledge unread support emails",
    intent:
      "Triage the Support mailbox: for each unread customer email, send a short acknowledgement " +
      "reply letting them know their request was received and will be followed up.",
    intentConfidence: "high",
    intentRationale:
      "Outlook on the web stayed in the Support inbox; an unread customer email was opened and the " +
      "same acknowledgement text was sent as a reply.",
    steps: [
      {
        id: "s1",
        title: "Open the Support inbox",
        detail: "Opened the Support shared mailbox in Outlook on the web and filtered to unread mail.",
        apps: ["Microsoft Outlook"],
        evidence: ["browser.url https://outlook.office.com/mail/support/", "title 'Inbox — Support'"],
        confidence: "high",
      },
      {
        id: "s2",
        title: "Read an unread customer email",
        detail: "Opened an unread customer email to read the request before acknowledging it.",
        apps: ["Microsoft Outlook"],
        evidence: ["clipboard 'Order #5512 still hasn't arrived — can you check?'"],
        confidence: "high",
      },
      {
        id: "s3",
        title: "Decide it needs an acknowledgement",
        detail:
          "Judged that the unread customer email is a new request that should get an acknowledgement " +
          "reply.",
        apps: ["Microsoft Outlook"],
        evidence: ["clipboard 'Order #5512 still hasn't arrived — can you check?'"],
        confidence: "medium",
      },
      {
        id: "s4",
        title: "Send the acknowledgement reply",
        detail: "Replied to the customer with a short acknowledgement that their request was received.",
        apps: ["Microsoft Outlook"],
        evidence: [
          "clipboard 'Thanks — we've received your request and will follow up within one business day.'",
          "browser.url https://outlook.office.com/mail/support/",
        ],
        confidence: "medium",
      },
    ],
  },
  rubric: {
    mustUseAny: [["outlook."], ["replytoemail", "sendemail", "replyall"]],
    forbidden: [
      "playwright",
      "browser_",
      "click",
      "outlook.office.com",
      "outlook.office365.com",
      "bash",
      "gh ",
    ],
    minCalculations: 1,
    minActions: 1,
  },
};

/** Find a slot everyone can make and book a follow-up — must use the Outlook calendar actions, never a browser. */
const studioCalendarSchedule: SkillBuilderScenario = {
  id: "copilot-studio-calendar-schedule",
  title: "Book a follow-up meeting with the call attendees",
  architecture: "copilot-studio",
  platform: "darwin",
  truth:
    "After a customer call the user opens Outlook Calendar in the browser, checks the two attendees' " +
    "availability next week, and books a 30-minute follow-up. A Copilot Studio agent has no browser, " +
    "so the right tools are Outlook.FindMeetingTimes (find a slot everyone can make) and " +
    "Outlook.CreateEvent (book it) — resolving the slot is a calculation and creating the event is " +
    "the mutating action the maker must see, because it invites people. Driving the " +
    "outlook.office.com calendar UI is wrong.",
  analysis: {
    title: "Book a follow-up meeting with the attendees",
    intent:
      "Schedule a 30-minute follow-up meeting with the two attendees from the call by finding a time " +
      "that works for everyone next week and creating the calendar event.",
    intentConfidence: "high",
    intentRationale:
      "Outlook Calendar on the web was used to inspect Priya and Sam's availability next week, and a " +
      "new 30-minute follow-up event was created with both as attendees.",
    steps: [
      {
        id: "s1",
        title: "Open Outlook Calendar",
        detail: "Opened Outlook Calendar on the web to look at next week for a follow-up slot.",
        apps: ["Microsoft Outlook"],
        evidence: ["browser.url https://outlook.office.com/calendar/view/week", "title 'Calendar — Outlook'"],
        confidence: "high",
      },
      {
        id: "s2",
        title: "Check the attendees' availability next week",
        detail: "Compared Priya and Sam's free/busy next week to find a 30-minute slot they can both make.",
        apps: ["Microsoft Outlook"],
        evidence: ["clipboard 'Priya free Tue 2pm, Wed 10am; Sam free Tue 2pm'"],
        confidence: "high",
      },
      {
        id: "s3",
        title: "Pick a slot everyone can make",
        detail: "Chose Tuesday 2:00pm as the slot both attendees are free for.",
        apps: ["Microsoft Outlook"],
        evidence: ["clipboard 'Tue 2:00pm works for both'"],
        confidence: "medium",
      },
      {
        id: "s4",
        title: "Create the 30-minute follow-up event",
        detail: "Created a 30-minute 'Follow-up' calendar event at the chosen slot and invited both attendees.",
        apps: ["Microsoft Outlook"],
        evidence: [
          "browser.url https://outlook.office.com/calendar/deeplink/compose",
          "clipboard 'Follow-up — 30 min — Priya, Sam'",
        ],
        confidence: "medium",
      },
    ],
  },
  rubric: {
    mustUseAny: [
      ["outlook."],
      ["findmeetingtimes", "getcalendarview", "getevents", "getschedule"],
      ["createevent"],
    ],
    forbidden: ["playwright", "browser_", "click", "outlook.office.com", "bash", "gh "],
    minCalculations: 1,
    minActions: 1,
  },
};

export const skillScenarios: SkillBuilderScenario[] = [
  priceTracker,
  githubIssueTriage,
  apiSalesOrder,
  apiSalesOrderMinimal,
  apiSalesOrderDocs,
  apiSalesOrderPartial,
  studioTeamsDigest,
  studioOutlookReply,
  studioCalendarSchedule,
];