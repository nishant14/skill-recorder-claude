import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { foundryConfigFile, loadFoundryConfig } from "../electron/foundry/config";
import { SkillRunner, type RunProgress } from "../electron/runner/runner";
import { API_KEY, createServer, createState } from "../tools/testbed/server.mjs";

/**
 * Gate GH ② — the live end-to-end skill run.
 *
 * This is the product's whole thesis in one script: an installed, API-grounded skill is
 * executed by the app's own runner, and the sales order it was asked for **actually
 * appears in the target application's state**. Nothing is mocked except the user: the
 * testbed is the real server (in this process, on an ephemeral port), `call_api` makes
 * real HTTP calls with the fixture's `runner.json` credentials, and the assertion reads
 * the server's own state rather than the model's report of it — a model that says "I
 * created SO-10003" and did nothing must fail here.
 *
 * Manual and credentialed — never wired into CI or `npm test`:
 *
 *   node --experimental-transform-types --no-warnings --import ./evals/register.mjs \
 *     scripts/runner-smoke.ts
 *
 * The fixture at `evals/fixtures/runner-sales-skill/` is committed whole, including the
 * generated `api/openapi.json` + `api/index.json`, so this script needs no build step.
 * To regenerate those two after `tools/testbed/docs/openapi-full.json` changes, run
 * `writeReference(<tmp>, { spec })` from `electron/builders/api-reference-store.ts` and
 * copy its `api-reference/spec.json` → `api/openapi.json` and `api-reference/index.json`
 * → `api/index.json`.
 *
 * Exits non-zero if any check fails. The temp skill library and run transcript are left
 * on disk on purpose — the transcript is what you read when this fails.
 */

const ENV_VARS = [
  "AZURE_OPENAI_ENDPOINT (or FOUNDRY_ENDPOINT)",
  "AZURE_OPENAI_API_KEY (or FOUNDRY_API_KEY)",
  "AZURE_OPENAI_DEPLOYMENT (optional)",
];

/** The skill folder as installed, and the name the run asks for. */
const SKILL_NAME = "runner-sales-order-demo";
const FIXTURE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "evals",
  "fixtures",
  "runner-sales-skill",
);

/** What the user types into the run panel. Deliberately conversational, not a schema. */
const RUN_INPUT = "Create an order for Contoso: 2x NW-1140 and 1x NW-2207";

/** What must exist in the testbed afterwards. */
const EXPECTED_CUSTOMER = "Contoso";
const EXPECTED_LINES: { sku: string; quantity: number }[] = [
  { sku: "NW-1140", quantity: 2 },
  { sku: "NW-2207", quantity: 1 },
];

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

function assert(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new Error(detail);
}

interface TestbedOrder {
  orderId: string;
  customerId: string;
  customerName: string;
  total: number;
  items: { sku: string; quantity: number }[];
}

interface TestbedState {
  customers: { customerId: string; name: string }[];
  orders: TestbedOrder[];
}

/** Start the testbed on a free port and hand back the port plus a stop function. */
async function startTestbed(state: TestbedState): Promise<{ port: number; stop: () => Promise<void> }> {
  const server = createServer(state);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    port: address.port,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Copy the fixture into a temp library and point its `runner.json` at the live port. */
function installFixture(port: number): { skillsDir: string; runsDir: string } {
  const root = mkdtempSync(path.join(tmpdir(), "runner-smoke-"));
  const skillsDir = path.join(root, "skills");
  const runsDir = path.join(root, "runs");
  const dir = path.join(skillsDir, SKILL_NAME);
  cpSync(FIXTURE_DIR, dir, { recursive: true });

  const configFile = path.join(dir, "runner.json");
  const config = JSON.parse(readFileSync(configFile, "utf8")) as Record<string, unknown>;
  config.apiBase = `http://127.0.0.1:${port}/api/v1`;
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);

  process.env.SKILL_RECORDER_SKILLS_DIR = skillsDir;
  process.env.SKILL_RECORDER_RUNS_DIR = runsDir;
  return { skillsDir, runsDir };
}

/**
 * The assertion that matters: the order exists in the testbed's own state, for the right
 * customer, with the lines the user asked for. Read off `state`, never off the run's
 * report — the report is what we are checking, not the evidence.
 */
function assertOrderLanded(state: TestbedState, before: Set<string>): TestbedOrder {
  const customer = state.customers.find((c) => c.name.toLowerCase().includes(EXPECTED_CUSTOMER.toLowerCase()));
  assert(customer, `the testbed has no customer matching "${EXPECTED_CUSTOMER}"`);

  const created = state.orders.filter((o) => !before.has(o.orderId));
  assert(created.length > 0, "no new order was created in the testbed");
  assert(created.length === 1, `${created.length} orders were created; exactly one was asked for`);

  const [order] = created;
  assert(
    order.customerId === customer.customerId,
    `the order was placed for ${order.customerId}, not ${customer.customerId} (${customer.name})`,
  );
  for (const expected of EXPECTED_LINES) {
    const line = order.items.find((l) => l.sku === expected.sku);
    assert(line, `the order has no line for ${expected.sku} (lines: ${order.items.map((l) => l.sku).join(", ")})`);
    assert(
      line.quantity === expected.quantity,
      `${expected.sku} was ordered ${line.quantity}× instead of ${expected.quantity}×`,
    );
  }
  assert(
    order.items.length === EXPECTED_LINES.length,
    `the order carries ${order.items.length} lines; ${EXPECTED_LINES.length} were asked for`,
  );
  return order;
}

async function main(): Promise<void> {
  const loaded = loadFoundryConfig();
  if (!loaded) {
    console.error("Azure AI Foundry is not configured, so the runner smoke cannot run.");
    console.error("Set these environment variables:");
    for (const name of ENV_VARS) console.error(`  ${name}`);
    console.error(`Or save a connection to: ${foundryConfigFile()}`);
    process.exit(1);
  }

  const state = createState() as TestbedState;
  const before = new Set(state.orders.map((o) => o.orderId));
  const testbed = await startTestbed(state);
  const { skillsDir, runsDir } = installFixture(testbed.port);

  console.log(
    `Runner smoke · ${loaded.config.endpoint} · deployment ${loaded.config.deployment} (from ${loaded.source})`,
  );
  console.log(`  testbed   http://127.0.0.1:${testbed.port}/api/v1 (key ${API_KEY})`);
  console.log(`  library   ${skillsDir}`);
  console.log(`  runs      ${runsDir}`);
  console.log(`  input     ${RUN_INPUT}\n`);

  const runner = new SkillRunner((progress: RunProgress) => {
    const line = progress.entry
      ? `${progress.entry.type}${progress.entry.name ? `:${progress.entry.name}` : ""} ${progress.message}`
      : progress.message;
    console.log(`  · ${line.replace(/\s+/g, " ").slice(0, 200)}`);
  });

  let transcriptFile = "(no transcript)";
  let failure: string | null = null;
  try {
    // auto-approve: nobody is watching, and the confirmation UI is the manual half of GH.
    const result = await runner.run({ name: SKILL_NAME, input: RUN_INPUT, policy: "auto-approve" });
    transcriptFile = result.transcriptFile;
    console.log(`\n  report    ${result.summary.replace(/\s+/g, " ")}`);
    const order = assertOrderLanded(state, before);
    console.log(`  order     ${order.orderId} for ${order.customerName} · $${order.total}`);
  } catch (err) {
    failure = message(err);
  } finally {
    await runner.dispose().catch(() => undefined);
    await testbed.stop();
  }

  console.log("");
  if (failure) {
    console.error(`FAIL sales order created through the runner`);
    console.error(`  error: ${failure}`);
    console.error(`  transcript: ${transcriptFile}`);
    console.error(`  the testbed state and the run transcript are still on disk under ${path.dirname(runsDir)}`);
    process.exitCode = 1;
    return;
  }
  console.log("PASS sales order created through the runner");
  console.log(`  transcript: ${transcriptFile}`);
}

main().catch((err: unknown) => {
  console.error(`FAIL runner smoke aborted\n  error: ${message(err)}`);
  process.exitCode = 1;
});
