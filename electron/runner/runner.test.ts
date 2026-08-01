import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { SkillRunner, type RunProgress, type RunTranscript } from "./runner";
import type { AskGate, ConfirmDecision, ConfirmGate, ShellSpec } from "./tools";

/**
 * End-to-end runner tests with a **scripted model**: `globalThis.fetch` is swapped for
 * a fake that replays queued Responses-API payloads (the same style as
 * `electron/foundry/agent.test.ts`), the shell and the interactive gates are injected,
 * and the skill library + transcript directory are temp dirs. Nothing here opens a
 * socket, spawns a process, or waits on a human.
 *
 * What is being defended is the runner's contract with the rest of the app: the
 * **transcript is the record of what happened to the machine** (so its entry sequence
 * is asserted literally), a **denial is an instruction** rather than a failure, only
 * **one run exists at a time**, and **cancel actually stops the turn**.
 */

const ENV_VARS = [
  "SKILL_RECORDER_SKILLS_DIR",
  "SKILL_RECORDER_RUNS_DIR",
  "SKILL_RECORDER_CONFIG_DIR",
  "SKILL_RECORDER_MODEL",
  "AZURE_OPENAI_ENDPOINT",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_DEPLOYMENT",
  "AZURE_OPENAI_API_VERSION",
  "FOUNDRY_ENDPOINT",
  "FOUNDRY_API_KEY",
];

const SKILL_BODY = "## Steps\n\n1. List the open PRs.\n2. Write them to a report.";

interface WireItem {
  type: string;
  [key: string]: unknown;
}

interface RecordedRequest {
  body: { instructions?: string; model?: string; input: WireItem[] };
  /** The turn's abort signal — what the hanging responder waits on. */
  signal?: AbortSignal;
}

type Responder = (request: RecordedRequest, index: number) => Response | Promise<Response>;

const okJson = (payload: unknown): Response =>
  new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });

const textReply = (content: string): Response =>
  okJson({
    status: "completed",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: content }] }],
  });

const toolReply = (callId: string, name: string, args: unknown): Response =>
  okJson({
    status: "completed",
    output: [{ type: "function_call", id: `fc_${callId}`, call_id: callId, name, arguments: JSON.stringify(args) }],
  });

/** Replay one reply per model call, in order. */
function queue(...replies: (Response | (() => Response | Promise<Response>))[]): Responder {
  return (_request, index) => {
    const reply = replies[index];
    if (!reply) throw new Error(`unexpected model call #${index + 1}`);
    return typeof reply === "function" ? reply() : reply;
  };
}

/** A model call that only settles when the turn's signal aborts. */
const hang: Responder = (request) =>
  new Promise<Response>((_resolve, reject) => {
    request.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });

interface Harness {
  runner: SkillRunner;
  progress: RunProgress[];
  requests: RecordedRequest[];
  shells: ShellSpec[];
  runsDir: string;
  /** The directory standing in for the user's home folder. */
  home: string;
  /** The single transcript written under the runs dir. */
  transcript(): RunTranscript;
}

interface Options {
  allowedTools?: string[];
  confirm?: ConfirmGate;
  ask?: AskGate;
  /** Written beside the SKILL.md as `runner.json` (where API credentials live). */
  runnerConfig?: unknown;
  /** Shorten the runner's own interactive-wait deadline (real one is 3 min). */
  interactiveTimeoutMs?: number;
}

/**
 * Install a temp skill library + runs dir + Foundry connection, a scripted model, and a
 * SkillRunner wired to injected gates. Everything is restored afterwards.
 */
async function withRunner(
  respond: Responder,
  options: Options,
  body: (h: Harness) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), "sr-runner-"));
  const saved = new Map(ENV_VARS.map((name) => [name, process.env[name]]));
  for (const name of ENV_VARS) delete process.env[name];

  const skillsDir = path.join(root, "skills");
  const runsDir = path.join(root, "runs");
  mkdirSync(path.join(skillsDir, "pr-report"), { recursive: true });
  const frontmatter = ["---", "name: pr-report", 'description: "Report open PRs."'];
  if (options.allowedTools?.length) {
    frontmatter.push("allowed-tools:", ...options.allowedTools.map((t) => `  - ${t}`));
  }
  writeFileSync(
    path.join(skillsDir, "pr-report", "SKILL.md"),
    `${[...frontmatter, "---", ""].join("\n")}\n${SKILL_BODY}\n`,
  );

  if (options.runnerConfig !== undefined) {
    writeFileSync(path.join(skillsDir, "pr-report", "runner.json"), JSON.stringify(options.runnerConfig));
  }

  process.env.SKILL_RECORDER_SKILLS_DIR = skillsDir;
  process.env.SKILL_RECORDER_RUNS_DIR = runsDir;
  process.env.SKILL_RECORDER_CONFIG_DIR = path.join(root, "config");
  process.env.AZURE_OPENAI_ENDPOINT = "https://unit.test.invalid";
  process.env.AZURE_OPENAI_API_KEY = "test-key";
  process.env.AZURE_OPENAI_DEPLOYMENT = "gpt-5.3-codex";

  const requests: RecordedRequest[] = [];
  const progress: RunProgress[] = [];
  const shells: ShellSpec[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: unknown, init: Record<string, unknown> = {}) => {
    const record: RecordedRequest = {
      body: JSON.parse(String(init.body ?? "{}")),
      signal: init.signal as AbortSignal | undefined,
    };
    requests.push(record);
    return respond(record, requests.length - 1);
  }) as unknown as typeof fetch;

  const runner = new SkillRunner((p) => progress.push(p), {
    gates: () => ({
      confirm: options.confirm ?? { request: async () => "approve" as ConfirmDecision },
      ask: options.ask ?? { ask: async () => null },
    }),
    tools: {
      homeDir: root,
      runShell: async (spec) => {
        shells.push(spec);
        return { code: 0, stdout: "#12 Fix the thing\n", stderr: "", timedOut: false };
      },
      fetchImpl: (async () => new Response("unused")) as unknown as typeof fetch,
    },
    ...(options.interactiveTimeoutMs === undefined
      ? {}
      : { interactiveTimeoutMs: options.interactiveTimeoutMs }),
  });

  try {
    await body({
      runner,
      progress,
      requests,
      shells,
      runsDir,
      home: root,
      transcript() {
        const dir = path.join(runsDir, "pr-report");
        assert.ok(existsSync(dir), "the run should have written a transcript folder");
        const files = readdirSync(dir).sort();
        assert.equal(files.length, 1, "one run, one transcript file");
        return JSON.parse(readFileSync(path.join(dir, files[0]), "utf8")) as RunTranscript;
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
    await runner.dispose().catch(() => undefined);
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

const types = (t: RunTranscript) => t.entries.map((e) => `${e.type}${e.name ? `:${e.name}` : ""}`);

// --- 1. a two-tool run, end to end -------------------------------------------

test("a two-tool run records the whole sequence and reports the model's summary", async () => {
  const script = queue(
    toolReply("c1", "run_shell", { command: "gh pr list" }),
    toolReply("c2", "write_file", { path: "report.txt", content: "#12 Fix the thing" }),
    textReply("Listed the open PRs and wrote report.txt."),
  );

  await withRunner(script, { allowedTools: ["Bash(gh *)", "Write"] }, async (h) => {
    const result = await h.runner.run({ name: "pr-report", input: "only open ones", policy: "auto-approve" });

    assert.equal(result.skillName, "pr-report");
    assert.equal(result.summary, "Listed the open PRs and wrote report.txt.");
    assert.ok(existsSync(result.transcriptFile), "the transcript path is real");

    // The instructions carry the runner brief *and* the skill body verbatim.
    assert.match(String(h.requests[0].body.instructions), /executing an installed skill/);
    assert.ok(String(h.requests[0].body.instructions).includes(SKILL_BODY));
    assert.equal(h.requests[0].body.model, "gpt-5.3-codex", "the main deployment runs skills");
    const kickoff = JSON.stringify(h.requests[0].body.input);
    assert.match(kickoff, /Run this skill now\./);
    assert.match(kickoff, /only open ones/, "the user's input rides on the kickoff prompt");

    assert.equal(h.shells.length, 1);
    assert.deepEqual(h.shells[0].args.slice(-1), ["gh pr list"]);

    const doc = h.transcript();
    assert.equal(doc.status, "done");
    assert.ok(doc.finishedAt && doc.finishedAt >= doc.startedAt);
    assert.equal(doc.policy, "auto-approve");
    assert.deepEqual(types(doc), [
      "tool-call:run_shell",
      "confirm-request:run_shell",
      "confirm-decision:run_shell",
      "tool-result:run_shell",
      "tool-call:write_file",
      "confirm-request:write_file",
      "confirm-decision:write_file",
      "tool-result:write_file",
      "model",
      "done",
    ]);
    // auto-approve still records what it decided — an unattended run stays auditable.
    assert.deepEqual(
      doc.entries.filter((e) => e.type === "confirm-decision").map((e) => e.decision),
      ["approve", "approve"],
    );
    assert.match(String(doc.entries[3].text), /#12 Fix the thing/);
    // The write really happened, inside the home folder the tools were scoped to.
    assert.equal(readFileSync(path.join(h.home, "report.txt"), "utf8"), "#12 Fix the thing");

    // Progress streams the same story: one start, then every entry.
    assert.equal(h.progress[0].phase, "start");
    assert.equal(h.progress.at(-1)?.phase, "done");
    assert.equal(h.progress.filter((p) => p.entry).length, doc.entries.length);
    assert.equal(h.runner.isRunning(), false);
  });
});

// --- 2. denial + timeout are instructions, not failures -----------------------

test("a denied side effect answers in band and the run still finishes", async () => {
  const script = queue(
    toolReply("c1", "run_shell", { command: "gh pr list" }),
    textReply("The user declined the command, so nothing was changed."),
  );

  await withRunner(
    script,
    { allowedTools: ["Bash(gh *)"], confirm: { request: async () => "deny" } },
    async (h) => {
      const result = await h.runner.run({ name: "pr-report", policy: "interactive" });
      assert.match(result.summary, /declined/);
      assert.deepEqual(h.shells, [], "a denied command never spawned");

      const doc = h.transcript();
      assert.equal(doc.status, "done");
      assert.equal(doc.entries.find((e) => e.type === "confirm-decision")?.decision, "deny");
      assert.equal(
        doc.entries.find((e) => e.type === "tool-result")?.text,
        "The user declined this action.",
      );
    },
  );
});

test("an unanswered confirmation resolves in band so a walked-away user degrades the run", async () => {
  const script = queue(
    toolReply("c1", "run_shell", { command: "gh pr list" }),
    textReply("Nobody answered, so I stopped."),
  );

  await withRunner(
    script,
    { allowedTools: ["Bash(gh *)"], confirm: { request: async () => "timeout" } },
    async (h) => {
      await h.runner.run({ name: "pr-report", policy: "interactive" });
      const doc = h.transcript();
      assert.equal(doc.entries.find((e) => e.type === "confirm-decision")?.decision, "timeout");
      assert.equal(
        doc.entries.find((e) => e.type === "tool-result")?.text,
        "The user did not respond — skip this action or finish up.",
      );
    },
  );
});

test("a confirmation nobody ever answers times out in band on the runner's own deadline", async () => {
  const script = queue(
    toolReply("c1", "run_shell", { command: "gh pr list" }),
    textReply("Nobody was there, so I stopped."),
  );

  await withRunner(
    script,
    {
      allowedTools: ["Bash(gh *)"],
      // A gate that never settles — a renderer that died, or a user who walked away.
      confirm: { request: () => new Promise(() => undefined) },
      interactiveTimeoutMs: 30,
    },
    async (h) => {
      await h.runner.run({ name: "pr-report", policy: "interactive" });
      const doc = h.transcript();
      assert.equal(doc.entries.find((e) => e.type === "confirm-decision")?.decision, "timeout");
      assert.equal(
        doc.entries.find((e) => e.type === "tool-result")?.text,
        "The user did not respond — skip this action or finish up.",
      );
      assert.deepEqual(h.shells, [], "an unanswered prompt never runs the command");
    },
  );
});

test("ask_user's question and answer both land in the transcript", async () => {
  const script = queue(
    toolReply("c1", "ask_user", { question: "Which repository?" }),
    textReply("Used the repository the user named."),
  );

  await withRunner(script, { ask: { ask: async () => "microsoft/skill-recorder" } }, async (h) => {
    await h.runner.run({ name: "pr-report", policy: "interactive" });
    const doc = h.transcript();
    assert.deepEqual(types(doc), [
      "tool-call:ask_user",
      "user-input:question",
      "user-input:answer",
      "tool-result:ask_user",
      "model",
      "done",
    ]);
    assert.equal(doc.entries[2].text, "microsoft/skill-recorder");
    assert.match(String(doc.entries[3].text), /The user answered: microsoft\/skill-recorder/);
  });
});

// --- 3. redaction -------------------------------------------------------------

test("credentials from runner.json never reach the transcript or a progress event", async () => {
  const script = queue(
    toolReply("c1", "fetch_url", {
      url: "https://api.test/orders",
      headers: { "X-Api-Key": "demo-key-123" },
    }),
    textReply("Fetched the orders."),
  );

  await withRunner(
    script,
    { allowedTools: ["web_fetch"], runnerConfig: { apiBase: "https://api.test", headers: { "X-Api-Key": "demo-key-123" } } },
    async (h) => {
      await h.runner.run({ name: "pr-report", policy: "auto-approve" });

      const doc = h.transcript();
      const raw = JSON.stringify(doc);
      assert.ok(!raw.includes("demo-key-123"), "the key must not be anywhere in the persisted run");
      assert.match(raw, /«redacted»/);
      assert.ok(
        !JSON.stringify(h.progress).includes("demo-key-123"),
        "nor in anything streamed to the renderer",
      );
    },
  );
});

// --- 4. one run at a time -----------------------------------------------------

test("a second run while one is in flight is refused", async () => {
  let release: ((response: Response) => void) | undefined;
  const gate = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const script: Responder = (_request, index) => (index === 0 ? gate : textReply("second"));

  await withRunner(script, {}, async (h) => {
    const first = h.runner.run({ name: "pr-report", policy: "auto-approve" });
    await delay(20);
    assert.equal(h.runner.isRunning(), true);

    await assert.rejects(
      () => h.runner.run({ name: "pr-report", policy: "auto-approve" }),
      (err: Error) => {
        assert.equal(err.message, "A skill is already running.");
        return true;
      },
    );

    release?.(textReply("all done"));
    assert.equal((await first).summary, "all done");
    assert.equal(h.runner.isRunning(), false);

    // The latch clears: the runner is usable again.
    assert.equal((await h.runner.run({ name: "pr-report", policy: "auto-approve" })).summary, "second");
  });
});

test("an unknown skill is refused with a message the user can act on", async () => {
  await withRunner(queue(), {}, async (h) => {
    await assert.rejects(
      () => h.runner.run({ name: "does-not-exist", policy: "auto-approve" }),
      (err: Error) => {
        assert.equal(err.message, 'No installed skill named "does-not-exist".');
        return true;
      },
    );
    assert.equal(h.runner.isRunning(), false);
  });
});

// --- 5. cancel ----------------------------------------------------------------

test("cancel stops the turn and the transcript says the run was canceled", async () => {
  await withRunner(hang, {}, async (h) => {
    const pending = h.runner.run({ name: "pr-report", policy: "auto-approve" });
    await delay(20);
    const runId = h.progress[0]?.runId;
    assert.ok(runId, "the start event carries the run id the UI cancels with");

    // A stale id from an older run must not cancel this one.
    await h.runner.cancel("some-other-run");
    assert.equal(h.runner.isRunning(), true);

    await h.runner.cancel(runId);
    await assert.rejects(
      () => pending,
      (err: Error) => {
        assert.equal(err.message, "The skill run was canceled.");
        return true;
      },
    );

    const doc = h.transcript();
    assert.equal(doc.status, "canceled");
    assert.equal(doc.entries.at(-1)?.type, "error");
    assert.equal(h.progress.at(-1)?.phase, "error");
    assert.equal(h.runner.isRunning(), false);
  });

  // Cancelling when nothing is running is a silent no-op.
  const idle = new SkillRunner(() => undefined);
  await idle.cancel();
  await idle.dispose();
});
