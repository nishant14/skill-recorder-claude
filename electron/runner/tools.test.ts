import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { Tool, ToolResult } from "../foundry/agent";
import { compileAllowlist } from "./allowlist";
import {
  createExecutionTools,
  DECLINED_MESSAGE,
  NO_RESPONSE_MESSAGE,
  scrubbedEnv,
  type ConfirmDecision,
  type ShellSpec,
} from "./tools";

/**
 * The guards, one at a time. Every case runs against a temp directory standing in for
 * the home folder, with the shell, `fetch`, and both interactive gates injected — so
 * nothing here spawns a process, opens a socket, or waits on a human.
 *
 * These are the tests that have to be paranoid: this is the only module in the app
 * that turns model output into a side effect on a real machine.
 */

const ENV_VARS = ["SKILL_RECORDER_CONFIG_DIR", "SKILL_RECORDER_RUNS_DIR"];

interface Harness {
  /** The temp directory the tools are scoped to. */
  home: string;
  tool(name: string): Tool;
  call(name: string, args: unknown): Promise<ToolResult>;
  /** Text of a tool result, whether it came back as a string or an object. */
  text(result: ToolResult): string;
  /** Every shell invocation the tools attempted. */
  shells: ShellSpec[];
  /** Every confirmation the tools asked for, as `kind|summary`. */
  confirms: { kind: string; summary: string; detail: string }[];
  /** Every `fetch` the tools attempted. */
  fetches: { url: string; init: RequestInit }[];
}

interface Options {
  allowedTools?: string[];
  /** Decision the confirm gate returns (default: approve). */
  decision?: ConfirmDecision;
  /** What the fake shell reports back. */
  shell?: { code?: number; stdout?: string; stderr?: string; timedOut?: boolean };
  /** What the fake fetch answers with. */
  respond?: (url: string, init: RequestInit) => Response;
  /** What `ask_user` resolves with (null = the user never answered). */
  answer?: string | null;
}

async function withTools(options: Options, body: (h: Harness) => Promise<void>): Promise<void> {
  const home = mkdtempSync(path.join(tmpdir(), "sr-runner-tools-"));
  const saved = new Map(ENV_VARS.map((name) => [name, process.env[name]]));
  // Point the app's own config + transcript locations inside the fake home, so the
  // deny-list cases are testing the real paths rather than a coincidence.
  process.env.SKILL_RECORDER_CONFIG_DIR = path.join(home, ".skill-recorder");
  process.env.SKILL_RECORDER_RUNS_DIR = path.join(home, ".skill-recorder", "runs");

  const shells: Harness["shells"] = [];
  const confirms: Harness["confirms"] = [];
  const fetches: Harness["fetches"] = [];

  const tools = createExecutionTools({
    allowlist: compileAllowlist(options.allowedTools),
    confirm: {
      request: async (kind, summary, detail) => {
        confirms.push({ kind, summary, detail });
        return options.decision ?? "approve";
      },
    },
    ask: { ask: async () => (options.answer === undefined ? "sure" : options.answer) },
    homeDir: home,
    runShell: async (spec) => {
      shells.push(spec);
      return {
        code: options.shell?.code ?? 0,
        stdout: options.shell?.stdout ?? "",
        stderr: options.shell?.stderr ?? "",
        timedOut: options.shell?.timedOut ?? false,
      };
    },
    fetchImpl: (async (input: unknown, init: RequestInit = {}) => {
      fetches.push({ url: String(input), init });
      return options.respond?.(String(input), init) ?? new Response("ok", { status: 200 });
    }) as unknown as typeof fetch,
  });

  const byName = new Map(tools.map((t) => [t.name, t]));
  const text = (result: ToolResult) =>
    typeof result === "string" ? result : result.textResultForLlm ?? "";

  try {
    await body({
      home,
      shells,
      confirms,
      fetches,
      text,
      tool: (name) => {
        const tool = byName.get(name);
        assert.ok(tool, `no tool named ${name}`);
        return tool;
      },
      async call(name, args) {
        const tool = byName.get(name);
        assert.ok(tool, `no tool named ${name}`);
        return tool.handler(args);
      },
    });
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(home, { recursive: true, force: true });
  }
}

// --- surface ----------------------------------------------------------------

test("the toolset is the five execution tools (call_api arrives with H-b)", async () => {
  await withTools({}, async (h) => {
    for (const name of ["run_shell", "read_file", "write_file", "fetch_url", "ask_user"]) {
      assert.equal(h.tool(name).name, name);
    }
  });
});

// --- path scoping + deny-list -----------------------------------------------

test("paths outside the home folder are refused, for reads and writes alike", async () => {
  await withTools({}, async (h) => {
    const outside = path.join(tmpdir(), "sr-runner-outside.txt");
    writeFileSync(outside, "secret");
    try {
      assert.match(h.text(await h.call("read_file", { path: outside })), /may only touch files inside/);
      assert.match(h.text(await h.call("read_file", { path: "../../../etc/passwd" })), /may only touch files inside/);
      assert.match(
        h.text(await h.call("write_file", { path: outside, content: "x" })),
        /may only touch files inside/,
      );
      assert.equal(readFileSync(outside, "utf8"), "secret", "the refused write never happened");
      assert.deepEqual(h.confirms, [], "a refused path never reaches the user as a prompt");
    } finally {
      rmSync(outside, { force: true });
    }
  });
});

test("relative paths resolve inside the home folder, and ~ expands to it", async () => {
  await withTools({}, async (h) => {
    assert.match(h.text(await h.call("write_file", { path: "notes/today.txt", content: "hi" })), /^Wrote 2 bytes/);
    assert.equal(readFileSync(path.join(h.home, "notes", "today.txt"), "utf8"), "hi", "parent dirs are created");
    assert.equal(h.text(await h.call("read_file", { path: "~/notes/today.txt" })), "hi");
  });
});

test("the app's own connection settings and run transcripts are denied, read and write", async () => {
  await withTools({}, async (h) => {
    const config = path.join(h.home, ".skill-recorder", "foundry.json");
    mkdirSync(path.dirname(config), { recursive: true });
    writeFileSync(config, JSON.stringify({ apiKey: "super-secret" }));
    const transcript = path.join(h.home, ".skill-recorder", "runs", "some-skill", "run.json");
    mkdirSync(path.dirname(transcript), { recursive: true });
    writeFileSync(transcript, "[]");

    for (const target of [config, transcript, path.join(h.home, ".skill-recorder", "runs")]) {
      assert.match(h.text(await h.call("read_file", { path: target })), /may never read or write/);
      assert.match(h.text(await h.call("write_file", { path: target, content: "x" })), /may never read or write/);
    }
    assert.match(readFileSync(config, "utf8"), /super-secret/, "the config is untouched");
    assert.deepEqual(h.confirms, [], "a denied path is refused before the user is asked");
  });
});

// --- allowlist enforcement --------------------------------------------------

test("a command outside the skill's Bash patterns is refused in band, naming the patterns", async () => {
  await withTools({ allowedTools: ["Bash(gh *)"] }, async (h) => {
    const refused = h.text(await h.call("run_shell", { command: "rm -rf ~/projects" }));
    assert.match(refused, /Bash\(gh \*\)/);
    assert.deepEqual(h.shells, [], "nothing ran");
    assert.deepEqual(h.confirms, [], "the user is never asked to approve a refused command");

    await h.call("run_shell", { command: "gh pr list" });
    assert.equal(h.shells.length, 1, "a matching command runs");
  });
});

test("file and web tools are refused when the skill's allowed-tools never named them", async () => {
  await withTools({ allowedTools: ["Bash(gh *)"] }, async (h) => {
    assert.match(h.text(await h.call("read_file", { path: "x.txt" })), /do not include read_file/);
    assert.match(h.text(await h.call("write_file", { path: "x.txt", content: "y" })), /do not include write_file/);
    assert.match(h.text(await h.call("fetch_url", { url: "https://example.test/" })), /do not include fetch_url/);
    assert.deepEqual(h.fetches, []);
  });
});

// --- confirmation -----------------------------------------------------------

test("run_shell and write_file are confirmation-gated; deny and timeout answer in band", async () => {
  await withTools({ decision: "deny" }, async (h) => {
    assert.equal(h.text(await h.call("run_shell", { command: "echo hi" })), DECLINED_MESSAGE);
    assert.equal(h.text(await h.call("write_file", { path: "a.txt", content: "x" })), DECLINED_MESSAGE);
    assert.deepEqual(h.shells, [], "a denied command never spawns");
    assert.deepEqual(h.confirms.map((c) => c.kind), ["run_shell", "write_file"]);
    assert.match(h.confirms[0].summary, /^Run: echo hi$/);
    assert.match(h.confirms[0].detail, /Working directory: /);
  });

  await withTools({ decision: "timeout" }, async (h) => {
    assert.equal(h.text(await h.call("run_shell", { command: "echo hi" })), NO_RESPONSE_MESSAGE);
    assert.equal(h.text(await h.call("write_file", { path: "a.txt", content: "x" })), NO_RESPONSE_MESSAGE);
  });
});

test("read_file and fetch_url are not confirmation-gated (they change nothing)", async () => {
  await withTools({ decision: "deny" }, async (h) => {
    writeFileSync(path.join(h.home, "readable.txt"), "contents");
    assert.equal(h.text(await h.call("read_file", { path: "readable.txt" })), "contents");
    assert.match(h.text(await h.call("fetch_url", { url: "https://example.test/x" })), /HTTP 200/);
    assert.deepEqual(h.confirms, []);
  });
});

// --- the shell --------------------------------------------------------------

test("commands run through the platform shell with the Foundry credentials scrubbed out", async () => {
  const saved = process.env.AZURE_OPENAI_API_KEY;
  const savedFoundry = process.env.FOUNDRY_ENDPOINT;
  process.env.AZURE_OPENAI_API_KEY = "must-not-leak";
  process.env.FOUNDRY_ENDPOINT = "https://must-not-leak.invalid";
  try {
    await withTools({ shell: { stdout: "done\n" } }, async (h) => {
      await h.call("run_shell", { command: "echo hi" });
      const [spec] = h.shells;
      if (process.platform === "win32") {
        assert.equal(spec.file, "cmd");
        assert.deepEqual(spec.args, ["/c", "echo hi"]);
      } else {
        assert.equal(spec.file, "bash");
        assert.deepEqual(spec.args, ["-lc", "echo hi"]);
      }
      assert.equal(spec.cwd, h.home, "the default cwd is the home folder");
      assert.equal(spec.timeoutMs, 120_000);
      assert.equal(spec.env.AZURE_OPENAI_API_KEY, undefined);
      assert.equal(spec.env.FOUNDRY_ENDPOINT, undefined);
      assert.ok(Object.keys(spec.env).length > 0, "the rest of the environment is inherited");
    });
  } finally {
    if (saved === undefined) delete process.env.AZURE_OPENAI_API_KEY;
    else process.env.AZURE_OPENAI_API_KEY = saved;
    if (savedFoundry === undefined) delete process.env.FOUNDRY_ENDPOINT;
    else process.env.FOUNDRY_ENDPOINT = savedFoundry;
  }
});

test("scrubbedEnv drops only the Foundry variables", () => {
  const env = scrubbedEnv({
    PATH: "/usr/bin",
    AZURE_OPENAI_API_KEY: "k",
    azure_openai_endpoint: "e",
    FOUNDRY_API_KEY: "k",
    SKILL_RECORDER_SKILLS_DIR: "/tmp/skills",
  });
  assert.deepEqual(env, { PATH: "/usr/bin", SKILL_RECORDER_SKILLS_DIR: "/tmp/skills" });
});

test("a non-existent cwd is reported instead of spawning", async () => {
  await withTools({}, async (h) => {
    const result = h.text(await h.call("run_shell", { command: "ls", cwd: "no/such/dir" }));
    assert.match(result, /working directory does not exist/);
    assert.deepEqual(h.shells, []);
  });
});

test("shell output is capped with a marker, and failures are marked as failures", async () => {
  await withTools({ shell: { stdout: "x".repeat(50_000) } }, async (h) => {
    const result = await h.call("run_shell", { command: "echo big" });
    const text = h.text(result);
    assert.ok(text.length < 25_000, `output should be capped, got ${text.length} chars`);
    assert.match(text, /…\[truncated: \d+ more characters\]$/);
  });

  await withTools({ shell: { code: 2, stderr: "boom" } }, async (h) => {
    const result = await h.call("run_shell", { command: "false" });
    assert.equal(typeof result === "string" ? undefined : result.resultType, "failure");
    assert.match(h.text(result), /exit code 2/);
    assert.match(h.text(result), /stderr:\nboom/);
  });

  await withTools({ shell: { timedOut: true } }, async (h) => {
    const result = await h.call("run_shell", { command: "sleep 999" });
    assert.match(h.text(result), /stopped after 120s \(timeout\)/);
  });
});

// --- files ------------------------------------------------------------------

test("a file over the read cap reports its size plus the head", async () => {
  await withTools({}, async (h) => {
    const big = path.join(h.home, "big.txt");
    writeFileSync(big, "y".repeat(300 * 1024));
    const text = h.text(await h.call("read_file", { path: "big.txt" }));
    assert.match(text, /is 307200 bytes — larger than the 200 KB inline limit/);
    assert.ok(text.length < 300 * 1024, "only the head comes back");
  });
});

test("read_file reports a missing file and a folder honestly", async () => {
  await withTools({}, async (h) => {
    assert.match(h.text(await h.call("read_file", { path: "nope.txt" })), /^No such file: /);
    assert.match(h.text(await h.call("read_file", { path: "." })), /is a folder, not a file/);
    assert.match(h.text(await h.call("read_file", {})), /Pass a `path`/);
  });
});

test("a write over 1 MB is refused before the user is asked", async () => {
  await withTools({}, async (h) => {
    const result = h.text(await h.call("write_file", { path: "huge.bin", content: "z".repeat(1024 * 1024 + 1) }));
    assert.match(result, /the limit is 1024 KB per write/);
    assert.deepEqual(h.confirms, []);
  });
});

// --- the web ----------------------------------------------------------------

test("fetch_url passes method, headers and body through and caps the response", async () => {
  await withTools(
    { respond: () => new Response("R".repeat(300 * 1024), { status: 201, statusText: "Created" }) },
    async (h) => {
      const text = h.text(
        await h.call("fetch_url", {
          url: "https://example.test/orders",
          method: "post",
          headers: { "X-Api-Key": "k", nope: 7 },
          body: '{"a":1}',
        }),
      );
      assert.match(text, /^HTTP 201 Created/);
      assert.match(text, /…\[truncated: \d+ more characters\]$/);

      const [request] = h.fetches;
      assert.equal(request.url, "https://example.test/orders");
      assert.equal(request.init.method, "POST");
      assert.deepEqual(request.init.headers, { "X-Api-Key": "k" }, "non-string headers are dropped");
      assert.equal(request.init.body, '{"a":1}');
    },
  );
});

test("fetch_url refuses anything that isn't http(s)", async () => {
  await withTools({}, async (h) => {
    assert.match(h.text(await h.call("fetch_url", { url: "file:///etc/passwd" })), /Only http:\/\/ and https:\/\//);
    assert.match(h.text(await h.call("fetch_url", { url: "not a url" })), /isn't a URL/);
    assert.deepEqual(h.fetches, []);
  });
});

// --- ask_user ---------------------------------------------------------------

test("ask_user relays the answer, and an unanswered prompt resolves in band", async () => {
  await withTools({ answer: "the blue one" }, async (h) => {
    assert.equal(h.text(await h.call("ask_user", { question: "Which order?" })), "The user answered: the blue one");
  });
  await withTools({ answer: null }, async (h) => {
    assert.equal(h.text(await h.call("ask_user", { question: "Which order?" })), NO_RESPONSE_MESSAGE);
  });
  await withTools({}, async (h) => {
    assert.match(h.text(await h.call("ask_user", {})), /Pass a `question`/);
  });
});
