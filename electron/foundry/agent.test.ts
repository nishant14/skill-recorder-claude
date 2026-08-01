import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { FOUNDRY_NOT_CONFIGURED_ERROR, type FoundryConfig } from "../../common/foundry";
import { FoundryClient, FoundrySession, type Tool } from "./agent";

/**
 * Unit tests for the Foundry tool loop. Every test swaps `globalThis.fetch` for a
 * scripted fake that records what we sent and replays queued responses, so the whole
 * file runs offline: nothing here ever opens a socket.
 *
 * The wire is the **Responses API** (`/openai/v1/responses`): a system prompt is
 * top-level `instructions`, the conversation is an `input` item array, tool replies are
 * `function_call_output` items, and — because `store: false` makes each request
 * stateless — every output item the model returned must reappear in the next request.
 *
 * The assertions are deliberately about the **next request body** rather than about
 * internal state — the wire history is the contract the API validates, and a loop bug
 * (a missing tool reply, an image part in the wrong position, a failed turn left in
 * the history) is only visible there.
 */

const API_KEY = "test-key";

const CONFIG: FoundryConfig = {
  endpoint: "https://unit.test.invalid",
  apiKey: API_KEY,
  deployment: "gpt-5.3-codex",
};

const RESPONSES_URL = "https://unit.test.invalid/openai/v1/responses";

// --- fetch faking -----------------------------------------------------------

interface WireItem {
  type?: string;
  role?: string;
  content?: unknown;
  call_id?: string;
  name?: string;
  arguments?: string;
  output?: string;
  [key: string]: unknown;
}

interface WireTool {
  type: string;
  name: string;
  description: string;
  parameters: unknown;
  strict?: boolean;
}

interface WireBody {
  model?: string;
  instructions?: string;
  input: WireItem[];
  store?: boolean;
  tools?: WireTool[];
  tool_choice?: string;
  parallel_tool_calls?: boolean;
  include?: string[];
}

interface RecordedRequest {
  url: string;
  headers: Record<string, string>;
  body: WireBody;
  signal: AbortSignal;
}

type Responder = (request: RecordedRequest, index: number) => Response | Promise<Response>;

type Reply = Response | (() => Response | Promise<Response>);

/** Install a scripted fetch for the duration of `run`, then always restore the real one. */
async function withFetch<T>(
  respond: Responder,
  run: (ctx: { requests: RecordedRequest[] }) => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  const requests: RecordedRequest[] = [];
  globalThis.fetch = (async (input: unknown, init: Record<string, unknown> = {}) => {
    const record: RecordedRequest = {
      url: String(input),
      headers: (init.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init.body ?? "{}")) as WireBody,
      signal: init.signal as AbortSignal,
    };
    requests.push(record);
    return respond(record, requests.length - 1);
  }) as unknown as typeof fetch;
  try {
    return await run({ requests });
  } finally {
    globalThis.fetch = original;
  }
}

/** Replay one reply per call, in order; an unscripted extra call is a test failure. */
function queue(...replies: Reply[]): Responder {
  return (_request, index) => {
    const reply = replies[index];
    if (!reply) throw new Error(`unexpected fetch call #${index + 1}`);
    return typeof reply === "function" ? reply() : reply;
  };
}

/** A request that only settles when the turn's signal aborts (timeout / cancel tests). */
const hang: Responder = (request) =>
  new Promise<Response>((_resolve, reject) => {
    request.signal.addEventListener(
      "abort",
      () => reject(new Error("fetch aborted by signal")),
      { once: true },
    );
  });

const okJson = (payload: unknown): Response =>
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/** A terminal turn: one assistant message item, no function calls. */
const textReply = (content: string): Response =>
  okJson({
    status: "completed",
    output: [
      { type: "message", role: "assistant", content: [{ type: "output_text", text: content }] },
    ],
  });

/** A tool round: the output carries `function_call` items (plus anything else given). */
const toolReply = (...items: WireItem[]): Response =>
  okJson({ status: "completed", output: items });

/** The same replies, but carrying a `usage` object of whatever shape the test needs. */
const textReplyWithUsage = (content: string, usage: unknown): Response =>
  okJson({
    status: "completed",
    usage,
    output: [
      { type: "message", role: "assistant", content: [{ type: "output_text", text: content }] },
    ],
  });

const toolReplyWithUsage = (usage: unknown, ...items: WireItem[]): Response =>
  okJson({ status: "completed", usage, output: items });

/** What the deployment actually sends: snake_case counts plus a derived total. */
const usage = (input: number, output: number) => ({
  input_tokens: input,
  output_tokens: output,
  total_tokens: input + output,
});

const call = (callId: string, name: string, args: unknown): WireItem => ({
  type: "function_call",
  id: `fc_${callId}`,
  call_id: callId,
  name,
  arguments: typeof args === "string" ? args : JSON.stringify(args),
});

/** An opaque reasoning item — carried verbatim, never interpreted. */
const reasoning = (id: string): WireItem => ({
  type: "reasoning",
  id,
  summary: [],
  encrypted_content: `enc-${id}`,
});

const userItem = (text: string): WireItem => ({
  type: "message",
  role: "user",
  content: [{ type: "input_text", text }],
});

const assistantItem = (text: string): WireItem => ({
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text }],
});

const errorReply = (status: number, body = "", headers: Record<string, string> = {}): Response =>
  new Response(body, { status, headers });

// --- shared fixtures --------------------------------------------------------

/** An `echo` tool plus the args its handler last received (parsed, not raw JSON). */
function echoTool(): { tool: Tool; seen: unknown[] } {
  const seen: unknown[] = [];
  const tool: Tool = {
    name: "echo",
    description: "Echo the message back.",
    parameters: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
      additionalProperties: false,
    },
    handler: (args) => {
      seen.push(args);
      return `echoed: ${(args as { message?: string })?.message ?? ""}`;
    },
  };
  return { tool, seen };
}

/** Output of the single `function_call_output` item in a request body. */
function toolOutput(body: WireBody): string {
  const item = body.input.find((i) => i.type === "function_call_output");
  assert.ok(item, "request should carry a function_call_output reply");
  return String(item.output);
}

/** Run a one-round tool turn and hand back the request body the loop sent afterwards. */
async function toolRoundRequestBody(
  tool: Tool,
  toolCall: WireItem,
  session = new FoundrySession(CONFIG, { tools: [tool] }),
): Promise<WireBody> {
  return withFetch(queue(toolReply(toolCall), textReply("done")), async ({ requests }) => {
    assert.equal(await session.sendAndWait("go", 5_000), "done");
    assert.equal(requests.length, 2);
    return requests[1].body;
  });
}

// --- 1. plain turn ----------------------------------------------------------

test("plain turn returns the assistant text and sends no tools", async () => {
  const session = new FoundrySession(CONFIG, { instructions: "You are a test." });

  await withFetch(queue(textReply("ready")), async ({ requests }) => {
    assert.equal(await session.sendAndWait("hello", 5_000), "ready");

    assert.equal(requests.length, 1);
    const [request] = requests;
    assert.equal(request.url, RESPONSES_URL);
    assert.equal(request.headers["api-key"], API_KEY);
    assert.equal(request.headers.Authorization, `Bearer ${API_KEY}`);
    assert.equal(request.headers["Content-Type"], "application/json");

    assert.equal(request.body.model, "gpt-5.3-codex");
    assert.equal(request.body.instructions, "You are a test.");
    assert.equal(request.body.store, false, "history stays local — nothing is stored server-side");
    assert.deepEqual(request.body.include, ["reasoning.encrypted_content"]);
    assert.deepEqual(request.body.input, [userItem("hello")]);
    assert.ok(!("tools" in request.body), "no tools key when the session has no tools");
    assert.ok(!("tool_choice" in request.body), "no tool_choice when the session has no tools");
  });
});

// --- 2. tool round ----------------------------------------------------------

test("tool round parses arguments, replies in band, and returns the follow-up text", async () => {
  const { tool, seen } = echoTool();
  const session = new FoundrySession(CONFIG, {
    instructions: "You are a test.",
    tools: [tool],
  });
  const toolCall = call("call_1", "echo", { message: "hi" });

  await withFetch(queue(toolReply(toolCall), textReply("all done")), async ({ requests }) => {
    assert.equal(await session.sendAndWait("turn 1", 5_000), "all done");

    // The tool advertisement rides on every request of the turn — flat, not nested.
    assert.deepEqual(requests[0].body.tools, [
      {
        type: "function",
        name: "echo",
        description: "Echo the message back.",
        parameters: tool.parameters,
        strict: false,
      },
    ]);
    assert.equal(requests[0].body.tool_choice, "auto");
    assert.equal(requests[0].body.parallel_tool_calls, false);

    // The handler sees parsed arguments, never the raw JSON string.
    assert.deepEqual(seen, [{ message: "hi" }]);

    assert.equal(requests.length, 2);
    assert.equal(requests[1].body.instructions, "You are a test.");
    assert.deepEqual(requests[1].body.input, [
      userItem("turn 1"),
      // The function_call item is echoed back verbatim…
      toolCall,
      // …and answered by a function_call_output carrying the same call_id.
      { type: "function_call_output", call_id: "call_1", output: "echoed: hi" },
    ]);
  });
});

// --- 3. image bridge --------------------------------------------------------

test("images returned by a tool ride in as a user message after the tool replies", async () => {
  const data = "AAECAwQF";
  const tool: Tool = {
    name: "get_shot",
    description: "Return a screenshot.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    handler: () => ({
      textResultForLlm: "1 image attached",
      binaryResultsForLlm: [
        { type: "image", data, mimeType: "image/jpeg", description: "the login screen" },
      ],
    }),
  };

  const body = await toolRoundRequestBody(tool, call("call_img", "get_shot", {}));
  const types = body.input.map((i) => `${i.type}${i.role ? `:${i.role}` : ""}`);
  assert.deepEqual(types, [
    "message:user",
    "function_call",
    "function_call_output",
    "message:user",
  ]);

  const image = body.input[3];
  const parts = image.content as { type: string; text?: string; image_url?: unknown }[];
  assert.equal(parts.length, 2);
  assert.equal(parts[0].type, "input_text");
  assert.equal(parts[0].text, "Images returned by get_shot (in order):\n1. the login screen");
  assert.equal(parts[1].type, "input_image");
  // `image_url` is a plain data-URI STRING on this API, not an object.
  assert.equal(parts[1].image_url, `data:image/jpeg;base64,${data}`);
});

// --- 4. failure paths -------------------------------------------------------

test("a failing tool result is prefixed so the model can tell success from failure", async () => {
  const tool: Tool = {
    name: "save",
    description: "Save something.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    handler: () => ({ textResultForLlm: "the disk is full", resultType: "failure" }),
  };

  const body = await toolRoundRequestBody(tool, call("call_fail", "save", {}));
  assert.equal(toolOutput(body), "Tool failed: the disk is full");
});

test("a throwing handler answers in band instead of breaking the conversation", async () => {
  const tool: Tool = {
    name: "boom",
    description: "Always throws.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    handler: () => {
      throw new Error("kaboom");
    },
  };

  const body = await toolRoundRequestBody(tool, call("call_boom", "boom", {}));
  assert.equal(toolOutput(body), "Tool boom failed: kaboom");
});

test("an unknown tool name is answered with the list of available tools", async () => {
  const { tool } = echoTool();
  const body = await toolRoundRequestBody(tool, call("call_unknown", "nope", {}));
  assert.equal(toolOutput(body), 'Unknown tool "nope". Available tools: echo.');
});

test("malformed tool arguments get a corrective reply asking for valid JSON", async () => {
  const { tool, seen } = echoTool();
  const body = await toolRoundRequestBody(tool, call("call_bad", "echo", "{not json"));

  assert.deepEqual(seen, [], "the handler must not run on unparseable arguments");
  const output = toolOutput(body);
  assert.match(output, /^Could not parse the arguments for echo as JSON \(/);
  assert.match(output, /Call echo again with a valid JSON object as its arguments\.$/);
});

// --- 5. timeout + history rollback -----------------------------------------

test("a timed-out turn rejects and leaves no residue in the conversation", async () => {
  const { tool } = echoTool();
  const session = new FoundrySession(CONFIG, {
    instructions: "You are a test.",
    tools: [tool],
  });

  // Round 1 succeeds with a reasoning item plus a tool call; round 2 hangs until the
  // deadline aborts it. That is the dangerous shape: the echoed function_call, its
  // reasoning item and the function_call_output are all in the history when the turn dies.
  const respond: Responder = (request, index) =>
    index === 0
      ? toolReply(reasoning("rs_doomed"), call("call_1", "echo", { message: "hi" }))
      : hang(request, index);

  await withFetch(respond, async ({ requests }) => {
    await assert.rejects(
      () => session.sendAndWait("doomed", 500),
      (err: Error) => {
        assert.equal(err.message, "The agent turn timed out after 1s.");
        return true;
      },
    );
    assert.equal(requests.length, 2);
  });

  await withFetch(queue(textReply("recovered")), async ({ requests }) => {
    assert.equal(await session.sendAndWait("second", 5_000), "recovered");
    assert.deepEqual(
      requests[0].body.input,
      [userItem("second")],
      "the failed turn's user, reasoning, function_call and function_call_output items must all be rolled back",
    );
    assert.equal(requests[0].body.instructions, "You are a test.");
  });
});

// --- 6. abort ---------------------------------------------------------------

test("abort() cancels an in-flight turn and is a silent no-op when idle", async () => {
  const session = new FoundrySession(CONFIG, {});

  // Idle: resolves, throws nothing.
  await session.abort();

  await withFetch(hang, async () => {
    const pending = session.sendAndWait("hello", 30_000);
    setTimeout(() => void session.abort(), 10);
    await assert.rejects(
      () => pending,
      (err: Error) => {
        assert.equal(err.message, "The agent turn was canceled.");
        return true;
      },
    );
  });

  // Idle again afterwards.
  await session.abort();
});

// --- 7. retry policy --------------------------------------------------------

test("a 429 with Retry-After is retried once and then succeeds", async () => {
  const session = new FoundrySession(CONFIG, {});

  await withFetch(
    queue(errorReply(429, "slow down", { "retry-after": "0" }), textReply("ok")),
    async ({ requests }) => {
      assert.equal(await session.sendAndWait("hello", 10_000), "ok");
      assert.equal(requests.length, 2, "exactly one retry");
    },
  );
});

test("a retryable status without Retry-After waits the fixed backoff, then succeeds", async () => {
  const session = new FoundrySession(CONFIG, {});
  const started = Date.now();

  await withFetch(queue(errorReply(503, "unavailable"), textReply("ok")), async ({ requests }) => {
    assert.equal(await session.sendAndWait("hello", 10_000), "ok");
    assert.equal(requests.length, 2);
  });

  assert.ok(Date.now() - started >= 900, "the first backoff step is ~1s");
});

test("a 429 that never clears reports rate limiting after the attempt budget", async () => {
  const session = new FoundrySession(CONFIG, {});
  const throttled = () => errorReply(429, "slow down", { "retry-after": "0" });

  await withFetch(queue(throttled, throttled, throttled), async ({ requests }) => {
    await assert.rejects(
      () => session.sendAndWait("hello", 10_000),
      (err: Error) => {
        assert.equal(
          err.message,
          "Azure AI Foundry is rate-limiting requests (HTTP 429). Try again in a moment.",
        );
        return true;
      },
    );
    assert.equal(requests.length, 3, "1 initial attempt + 2 retries");
  });
});

test("a 500 fails fast without retrying", async () => {
  const session = new FoundrySession(CONFIG, {});

  await withFetch(
    queue(errorReply(500, JSON.stringify({ error: { message: "internal boom" } }))),
    async ({ requests }) => {
      await assert.rejects(
        () => session.sendAndWait("hello", 10_000),
        /^Error: Azure AI Foundry request failed \(HTTP 500\): internal boom$/,
      );
      assert.equal(requests.length, 1, "non-retryable statuses fail on the first attempt");
    },
  );
});

test("the API key never leaks into a thrown error message", async () => {
  const rejected = new FoundrySession(CONFIG, {});
  await withFetch(
    queue(errorReply(401, JSON.stringify({ error: { message: "Access denied." } }))),
    async () => {
      await assert.rejects(
        () => rejected.sendAndWait("hello", 10_000),
        (err: Error) => {
          assert.match(err.message, /rejected the API key \(HTTP 401\)/);
          assert.ok(!err.message.includes(API_KEY), "the key must not appear in the banner");
          return true;
        },
      );
    },
  );

  const unreachable = new FoundrySession(CONFIG, {});
  await withFetch(
    () => {
      throw new TypeError("fetch failed");
    },
    async () => {
      await assert.rejects(
        () => unreachable.sendAndWait("hello", 10_000),
        (err: Error) => {
          assert.equal(
            err.message,
            "Could not reach https://unit.test.invalid. Check your network and the endpoint URL.",
          );
          assert.ok(!err.message.includes(API_KEY));
          return true;
        },
      );
    },
  );
});

// --- 8. empty output --------------------------------------------------------

test("a response with no output items is reported instead of returning empty text", async () => {
  const session = new FoundrySession(CONFIG, {});

  await withFetch(queue(okJson({ status: "completed", output: [] })), async () => {
    await assert.rejects(
      () => session.sendAndWait("hello", 10_000),
      (err: Error) => {
        assert.equal(err.message, "Azure AI Foundry returned no output.");
        return true;
      },
    );
  });
});

test("a 400 that rejects the reasoning include is resent without it, once, for good", async () => {
  const session = new FoundrySession(CONFIG, {});
  const rejectsInclude = errorReply(
    400,
    JSON.stringify({ error: { message: "Unknown parameter: 'include[0]'." } }),
  );

  await withFetch(queue(rejectsInclude, textReply("ok"), textReply("ok again")), async ({ requests }) => {
    assert.equal(await session.sendAndWait("hello", 10_000), "ok");
    assert.equal(requests.length, 2, "the resend does not consume a retry attempt");
    assert.deepEqual(requests[0].body.include, ["reasoning.encrypted_content"]);
    assert.ok(!("include" in requests[1].body), "the include is dropped on the resend");

    // Remembered for the session — the next turn never asks for it again.
    assert.equal(await session.sendAndWait("again", 10_000), "ok again");
    assert.ok(!("include" in requests[2].body));
  });
});

test("an unrelated 400 still surfaces the server's own message", async () => {
  const session = new FoundrySession(CONFIG, {});

  await withFetch(
    queue(errorReply(400, JSON.stringify({ error: { message: "bad request" } }))),
    async ({ requests }) => {
      await assert.rejects(
        () => session.sendAndWait("hello", 10_000),
        /^Error: Azure AI Foundry request failed \(HTTP 400\): bad request$/,
      );
      assert.equal(requests.length, 1);
    },
  );
});

// --- 9. reasoning items -----------------------------------------------------

test("reasoning items are echoed back verbatim on the next request", async () => {
  const { tool } = echoTool();
  const session = new FoundrySession(CONFIG, { tools: [tool] });
  const thought = reasoning("rs_1");
  const toolCall = call("call_1", "echo", { message: "hi" });

  await withFetch(
    queue(toolReply(thought, toolCall), textReply("done")),
    async ({ requests }) => {
      assert.equal(await session.sendAndWait("think", 5_000), "done");
      assert.equal(requests.length, 2);
      // `store: false` means the model only sees its own reasoning if we resend it —
      // deep-equal, so nothing in the opaque item may be dropped or rewritten.
      assert.deepEqual(requests[1].body.input, [
        userItem("think"),
        thought,
        toolCall,
        { type: "function_call_output", call_id: "call_1", output: "echoed: hi" },
      ]);
    },
  );
});

// --- 10. round cap ----------------------------------------------------------

test("a model that only ever calls tools is stopped by the round cap", async () => {
  const { tool } = echoTool();
  const session = new FoundrySession(CONFIG, { tools: [tool] });
  const alwaysCalls: Responder = (_request, index) =>
    toolReply(call(`call_${index}`, "echo", { message: `round ${index}` }));

  await withFetch(alwaysCalls, async ({ requests }) => {
    await assert.rejects(
      () => session.sendAndWait("loop forever", 20_000),
      (err: Error) => {
        const match = /^The agent exceeded (\d+) tool rounds in one turn\.$/.exec(err.message);
        assert.ok(match, `unexpected message: ${err.message}`);
        // The number in the user-facing message must be the cap we actually enforced.
        assert.equal(Number(match[1]), requests.length);
        assert.equal(requests.length, 32);
        return true;
      },
    );
  });
});

// --- 11. unconfigured client ------------------------------------------------

const CONFIG_ENV_VARS = [
  "SKILL_RECORDER_CONFIG_DIR",
  "SKILL_RECORDER_MODEL",
  "AZURE_OPENAI_ENDPOINT",
  "FOUNDRY_ENDPOINT",
  "AZURE_OPENAI_API_KEY",
  "FOUNDRY_API_KEY",
  "AZURE_OPENAI_DEPLOYMENT",
  "AZURE_OPENAI_API_VERSION",
];

/** Point the config loader at an empty temp dir with every relevant env var cleared. */
async function withIsolatedConfigDir(run: (dir: string) => Promise<void>): Promise<void> {
  const saved = new Map(CONFIG_ENV_VARS.map((name) => [name, process.env[name]]));
  const dir = await mkdtemp(path.join(tmpdir(), "foundry-agent-"));
  for (const name of CONFIG_ENV_VARS) delete process.env[name];
  process.env.SKILL_RECORDER_CONFIG_DIR = dir;
  try {
    await run(dir);
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

test("FoundryClient.start() without a stored connection throws the contract error", async () => {
  await withIsolatedConfigDir(async () => {
    const client = new FoundryClient();
    await assert.rejects(
      () => client.start(),
      (err: Error) => {
        assert.equal(err.message, FOUNDRY_NOT_CONFIGURED_ERROR);
        return true;
      },
    );
    assert.throws(() => client.deployment, /has not been started/);
  });
});

test("FoundryClient.createSession auto-starts from the stored connection", async () => {
  await withIsolatedConfigDir(async (dir) => {
    await writeFile(
      path.join(dir, "foundry.json"),
      JSON.stringify({
        endpoint: CONFIG.endpoint,
        apiKey: CONFIG.apiKey,
        deployment: CONFIG.deployment,
      }),
    );

    const client = new FoundryClient();
    const session = await client.createSession({ instructions: "You are a test." });
    assert.equal(client.deployment, "gpt-5.3-codex");

    await withFetch(queue(textReply("ready")), async ({ requests }) => {
      assert.equal(await session.sendAndWait("hello", 5_000), "ready");
      assert.equal(requests[0].url, RESPONSES_URL);
      assert.equal(requests[0].body.model, "gpt-5.3-codex");
    });

    await session.disconnect();
    await assert.rejects(() => session.sendAndWait("again", 5_000), /session has been closed/);
    await client.stop();
  });
});

// --- 12. token usage --------------------------------------------------------

test("usage sums every request of a multi-round turn, and across turns", async () => {
  const { tool } = echoTool();
  const session = new FoundrySession(CONFIG, { tools: [tool] });

  assert.deepEqual(session.usage, { inputTokens: 0, outputTokens: 0, requests: 0 });

  // One turn, three requests: two tool rounds plus the final answer.
  await withFetch(
    queue(
      toolReplyWithUsage(usage(100, 10), call("call_1", "echo", { message: "a" })),
      toolReplyWithUsage(usage(200, 20), call("call_2", "echo", { message: "b" })),
      textReplyWithUsage("done", usage(300, 30)),
    ),
    async ({ requests }) => {
      assert.equal(await session.sendAndWait("go", 5_000), "done");
      assert.equal(requests.length, 3);
    },
  );
  assert.deepEqual(session.usage, { inputTokens: 600, outputTokens: 60, requests: 3 });

  // A second turn keeps accumulating — the counters are per session, not per turn.
  await withFetch(queue(textReplyWithUsage("again", usage(7, 3))), async () => {
    assert.equal(await session.sendAndWait("more", 5_000), "again");
  });
  assert.deepEqual(session.usage, { inputTokens: 607, outputTokens: 63, requests: 4 });

  // The getter hands back a snapshot: mutating it must not touch the session.
  const snapshot = session.usage;
  snapshot.inputTokens = 999_999;
  assert.equal(session.usage.inputTokens, 607);
});

test("a response with missing, partial or junk usage is tolerated, not fatal", async () => {
  const session = new FoundrySession(CONFIG, {});

  // No usage key at all — the request is still counted, the tokens are simply unknown.
  await withFetch(queue(textReply("no usage")), async () => {
    assert.equal(await session.sendAndWait("one", 5_000), "no usage");
  });
  assert.deepEqual(session.usage, { inputTokens: 0, outputTokens: 0, requests: 1 });

  // Partial (output missing) and unknown extra fields alongside the counts.
  await withFetch(
    queue(
      textReplyWithUsage("partial", { input_tokens: 40, input_tokens_details: { cached: 5 } }),
    ),
    async () => {
      assert.equal(await session.sendAndWait("two", 5_000), "partial");
    },
  );
  assert.deepEqual(session.usage, { inputTokens: 40, outputTokens: 0, requests: 2 });

  // Wrong types and a non-object usage contribute nothing and throw nothing.
  await withFetch(
    queue(
      textReplyWithUsage("junk", { input_tokens: "lots", output_tokens: null }),
      textReplyWithUsage("stringly", "42"),
    ),
    async () => {
      assert.equal(await session.sendAndWait("three", 5_000), "junk");
      assert.equal(await session.sendAndWait("four", 5_000), "stringly");
    },
  );
  assert.deepEqual(session.usage, { inputTokens: 40, outputTokens: 0, requests: 4 });
});

test("usage survives a failed turn — the history rolls back, the spend does not", async () => {
  const { tool } = echoTool();
  const session = new FoundrySession(CONFIG, { tools: [tool] });

  // Round 1 is billed and then the turn dies on the deadline: the items it added are
  // rolled back, but those tokens were charged all the same.
  const respond: Responder = (request, index) =>
    index === 0
      ? toolReplyWithUsage(usage(500, 50), call("call_1", "echo", { message: "hi" }))
      : hang(request, index);

  await withFetch(respond, async () => {
    await assert.rejects(() => session.sendAndWait("doomed", 500), /timed out after 1s/);
  });
  // Only the round that came back is counted — the aborted one never produced a body.
  assert.deepEqual(session.usage, { inputTokens: 500, outputTokens: 50, requests: 1 });

  await withFetch(queue(textReplyWithUsage("recovered", usage(11, 1))), async ({ requests }) => {
    assert.equal(await session.sendAndWait("second", 5_000), "recovered");
    assert.deepEqual(requests[0].body.input, [userItem("second")], "history still rolls back");
  });
  assert.deepEqual(session.usage, { inputTokens: 511, outputTokens: 51, requests: 2 });
});

// --- 13. single flight ------------------------------------------------------

test("a second turn while one is in flight is refused, and later turns still work", async () => {
  const session = new FoundrySession(CONFIG, {});
  let release: ((response: Response) => void) | undefined;
  const gate = new Promise<Response>((resolve) => {
    release = resolve;
  });

  await withFetch(
    (_request, index) => (index === 0 ? gate : textReply("third")),
    async ({ requests }) => {
      const first = session.sendAndWait("one", 10_000);

      await assert.rejects(
        () => session.sendAndWait("two", 10_000),
        (err: Error) => {
          assert.equal(err.message, "A turn is already running in this session.");
          return true;
        },
      );

      release?.(textReply("first"));
      assert.equal(await first, "first");

      // The latch clears, so the session is usable again.
      assert.equal(await session.sendAndWait("three", 10_000), "third");
      assert.equal(requests.length, 2, "the refused turn never reached the network");
      assert.deepEqual(requests[1].body.input, [
        userItem("one"),
        assistantItem("first"),
        userItem("three"),
      ]);
    },
  );
});
