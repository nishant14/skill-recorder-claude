import sharp from "sharp";

import { FoundryClient, type Tool } from "../electron/foundry/agent";
import { foundryConfigFile, loadFoundryConfig } from "../electron/foundry/config";

/**
 * Gate G1 — the live contract smoke for the Azure AI Foundry runtime.
 *
 * `electron/foundry/agent.test.ts` checks our tool loop against **our assumptions**
 * about the wire contract. This script checks the assumptions themselves against a
 * real deployment: that `tools`/`tool_choice`/`role:"tool"` are honored, and that a
 * base64 `image_url` data URI in a user message actually reaches the model's eyes.
 * Mocks cannot see any of that.
 *
 * Manual and credentialed — never wired into CI or `npm test`:
 *
 *   node --experimental-transform-types --no-warnings --import ./evals/register.mjs \
 *     scripts/foundry-smoke.ts
 *
 * Credentials come from the same place the app uses (env, else the saved config
 * file). Exits non-zero if any check fails.
 */

/** Generous but finite — a hung deployment must not hang the gate. */
const TURN_TIMEOUT_MS = 60_000;

const ENV_VARS = [
  "AZURE_OPENAI_ENDPOINT (or FOUNDRY_ENDPOINT)",
  "AZURE_OPENAI_API_KEY (or FOUNDRY_API_KEY)",
  "AZURE_OPENAI_DEPLOYMENT (optional)",
];

/** Anything worth seeing when a check fails: prompts, raw text, recorded tool args. */
type Context = Record<string, unknown>;

interface Check {
  name: string;
  run: (context: Context) => Promise<void>;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Readable one-liner per context entry, truncated so a huge body can't flood a terminal. */
function format(value: unknown): string {
  const text = typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? String(value));
  return text.length > 2_000 ? `${text.slice(0, 2_000)}… (truncated)` : text;
}

function assert(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new Error(detail);
}

// --- the three checks --------------------------------------------------------

/** 1. The deployment answers a plain prompt at all — route, auth, and body shape. */
function plainCompletion(client: FoundryClient): Check {
  return {
    name: "plain completion",
    run: async (context) => {
      const prompt = "Reply with the single word: ready";
      context.prompt = prompt;
      const session = await client.createSession({
        instructions: "You are a terse assistant used by an automated contract test.",
      });
      try {
        const text = await session.sendAndWait(prompt, TURN_TIMEOUT_MS);
        context.finalText = text;
        assert(text.trim().length > 0, "the model returned empty text");
      } finally {
        await session.disconnect();
      }
    },
  };
}

/**
 * 2. A full tool round-trip: the model must call our function with parsed arguments
 * and then use the `role:"tool"` reply in its answer.
 */
function toolRoundTrip(client: FoundryClient): Check {
  return {
    name: "tool round-trip",
    run: async (context) => {
      const calls: unknown[] = [];
      const echoArgs: Tool = {
        name: "echo_args",
        description: "Echo a token back. Call this to learn the confirmed form of a token.",
        parameters: {
          type: "object",
          properties: { token: { type: "string" } },
          required: ["token"],
          additionalProperties: false,
        },
        handler: (args) => {
          calls.push(args);
          const token = (args as { token?: unknown })?.token;
          return `The token is ${String(token)}-confirmed`;
        },
      };

      const prompt =
        'Call the echo_args tool with token "alpha7", then reply with exactly the ' +
        "sentence the tool returned, and nothing else.";
      context.prompt = prompt;

      const session = await client.createSession({
        instructions:
          "You are an automated contract test. Use the provided tools when the user asks you to.",
        tools: [echoArgs],
      });
      try {
        const text = await session.sendAndWait(prompt, TURN_TIMEOUT_MS);
        context.finalText = text;
        context.toolCalls = calls;

        assert(calls.length > 0, "the model never called echo_args");
        assert(
          calls.some(
            (args) =>
              typeof args === "object" &&
              args !== null &&
              (args as { token?: unknown }).token === "alpha7",
          ),
          "echo_args was called, but never with the parsed arguments { token: 'alpha7' }",
        );
        assert(text.includes("alpha7"), "the final text does not reflect the tool's result");
      } finally {
        await session.disconnect();
      }
    },
  };
}

/**
 * 3. The vision bridge: a tool returns a generated JPEG as `binaryResultsForLlm`,
 * which the loop forwards as a data-URI `image_url` part on a following user
 * message. If the model can name the color, the bridge works on this deployment.
 */
function imageRoundTrip(client: FoundryClient): Check {
  return {
    name: "image round-trip",
    run: async (context) => {
      const jpeg = await sharp({
        create: { width: 64, height: 64, channels: 3, background: { r: 220, g: 20, b: 20 } },
      })
        .jpeg()
        .toBuffer();
      context.imageBytes = jpeg.length;

      let called = false;
      const getTestImage: Tool = {
        name: "get_test_image",
        description: "Return a small test image for inspection.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        handler: () => {
          called = true;
          return {
            textResultForLlm: "1 image attached.",
            binaryResultsForLlm: [
              {
                type: "image",
                data: jpeg.toString("base64"),
                mimeType: "image/jpeg",
                description: "a 64x64 solid-color test swatch",
              },
            ],
          };
        },
      };

      const prompt =
        "Call the get_test_image tool, look at the image it returns, and reply with the " +
        "dominant color of that image as a single English color word.";
      context.prompt = prompt;

      const session = await client.createSession({
        instructions:
          "You are an automated contract test. Use the provided tools and describe what you see.",
        tools: [getTestImage],
      });
      try {
        const text = await session.sendAndWait(prompt, TURN_TIMEOUT_MS);
        context.finalText = text;
        context.toolCalled = called;

        assert(called, "the model never called get_test_image");
        assert(
          /red/i.test(text),
          "the final text does not name the image's color — the image_url bridge may not be honored",
        );
      } finally {
        await session.disconnect();
      }
    },
  };
}

// --- runner ------------------------------------------------------------------

async function main(): Promise<void> {
  const loaded = loadFoundryConfig();
  if (!loaded) {
    console.error("Azure AI Foundry is not configured, so the smoke test cannot run.");
    console.error("Set these environment variables:");
    for (const name of ENV_VARS) console.error(`  ${name}`);
    console.error(`Or save a connection to: ${foundryConfigFile()}`);
    process.exit(1);
  }

  console.log(
    `Foundry smoke · ${loaded.config.endpoint} · deployment ${loaded.config.deployment} (from ${loaded.source})`,
  );

  const client = new FoundryClient();
  await client.start();

  const checks: Check[] = [plainCompletion(client), toolRoundTrip(client), imageRoundTrip(client)];

  let failures = 0;
  for (const check of checks) {
    const context: Context = {};
    try {
      await check.run(context);
      console.log(`PASS ${check.name}`);
      if (context.finalText) console.log(`  final text: ${format(context.finalText)}`);
    } catch (err) {
      failures += 1;
      console.error(`FAIL ${check.name}`);
      console.error(`  error: ${message(err)}`);
      for (const [key, value] of Object.entries(context)) {
        if (value === undefined) continue;
        console.error(`  ${key}: ${format(value)}`);
      }
    }
  }

  await client.stop();

  const passed = checks.length - failures;
  console.log(`\n${passed}/${checks.length} checks passed.`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(`FAIL smoke run aborted\n  error: ${message(err)}`);
  process.exitCode = 1;
});
