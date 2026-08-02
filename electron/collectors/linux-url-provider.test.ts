import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ATSPI_SCRIPT,
  LinuxUrlProvider,
  linuxUrlSupport,
  resetLinuxUrlProbe,
} from "./linux-url-provider";
import { normalizeUrl } from "./url-normalize";
import { browserUrlProviderKind } from "./url-provider";

/**
 * The fake hosts below stand in for `python3 -u <script>` via the constructor's
 * command override, so every protocol case runs offline, without an X server and
 * without pyatspi. Each writes its pid to `process.argv[1]` first, which is how the
 * tests observe recycling and killing.
 */
const PID_LINE = `require("node:fs").appendFileSync(process.argv[1], process.pid + "\\n");`;

/** READY, then one echoing response per request line. */
const REPLY_HOST = `${PID_LINE}
process.stdout.write("READY\\n");
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    process.stdout.write("https://example.com/" + encodeURIComponent(line) + String.fromCharCode(30) + "  Example Domain  \\n");
  }
});`;

/**
 * A protocol-2 host: `READY 2`, then `<kind><SEP><url><SEP><title>`. The reply is fixed
 * per host, so each read state gets its own one-liner.
 */
function replyHost(kind: string, url = "", title = ""): string {
  const line = [kind, url, title].join(String.fromCharCode(30));
  return `${PID_LINE}
process.stdout.write("READY 2\\n");
process.stdin.on("data", () => process.stdout.write(${JSON.stringify(line)} + "\\n"));`;
}

/** READY, then a response that is not a URL at all. */
const GARBAGE_HOST = `${PID_LINE}
process.stdout.write("READY\\n");
process.stdin.on("data", () => process.stdout.write("what are you even asking\\n"));`;

/** Dies before the handshake — what a missing `import pyatspi` looks like. */
const DEAD_HOST = `${PID_LINE}
process.stdout.write("Traceback: ModuleNotFoundError: No module named 'pyatspi'\\n");
process.exit(1);`;

/** READY, then never answers. */
const HANG_HOST = `${PID_LINE}
process.stdout.write("READY\\n");
setInterval(() => {}, 1000);`;

interface Fake {
  provider: LinuxUrlProvider;
  /** Pids of every host process this provider has started, in order. */
  pids: () => number[];
  cleanup: () => void;
}

function fakeHost(script: string): Fake {
  const root = mkdtempSync(path.join(tmpdir(), "skr-atspi-test-"));
  const pidFile = path.join(root, "pids");
  writeFileSync(pidFile, "");
  const provider = new LinuxUrlProvider({
    command: process.execPath,
    args: ["-e", script, pidFile],
  });
  return {
    provider,
    pids: () =>
      readFileSync(pidFile, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((p) => Number.parseInt(p, 10)),
    cleanup: () => {
      provider.dispose();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** The provider's own scratch dirs, so a test can watch one appear and go away. */
function hostTmpDirs(): string[] {
  return readdirSync(tmpdir())
    .filter(
      (entry) =>
        entry.startsWith("skr-atspi-") &&
        !entry.startsWith("skr-atspi-test-") &&
        !entry.startsWith("skr-atspi-compile-"),
    )
    .map((entry) => path.join(tmpdir(), entry));
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForExit(pid: number): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await delay(25);
  }
  return false;
}

/** Collects `console.warn` output — the electron logger writes straight to it. */
async function captureWarnings(body: () => Promise<void>): Promise<string[]> {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    await body();
  } finally {
    console.warn = original;
  }
  return warnings;
}

test("LinuxUrlProvider reads a url and title from the host's reply", async () => {
  const fake = fakeHost(REPLY_HOST);
  try {
    const result = await fake.provider.get("firefox");
    // The echo proves the request line's exact shape: `get <wmClassToken>`.
    assert.deepEqual(result, { url: "https://example.com/get%20firefox", title: "Example Domain" });
  } finally {
    fake.cleanup();
  }
});

test("LinuxUrlProvider parses a url<SEP>title reply and drops an empty title", async () => {
  const fake = fakeHost(`${PID_LINE}
process.stdout.write("READY\\n");
process.stdin.on("data", () => process.stdout.write("github.com/anthropics" + String.fromCharCode(30) + "\\n"));`);
  try {
    const result = await fake.provider.get("Google-chrome");
    // Scheme-less omnibox values are normalized, exactly as on Windows.
    assert.deepEqual(result, { url: "https://github.com/anthropics", title: undefined });
  } finally {
    fake.cleanup();
  }
});

test("getReadState tells a blank address bar from an unreachable one", async () => {
  // The whole point of protocol 2. Chrome on its new tab page is readable with nothing
  // to read (`empty`); a confined browser answers nothing at all (`none`). Reporting the
  // second for the first is what sent a deb-Chrome user chasing snap confinement.
  const title = "Example Domain - Google Chrome";
  const readable = fakeHost(replyHost("url", "https://example.com", title));
  try {
    assert.deepEqual(await readable.provider.getReadState("google-chrome"), {
      kind: "url",
      url: "https://example.com",
      title,
    });
    assert.deepEqual(await readable.provider.get("google-chrome"), {
      url: "https://example.com",
      title,
    });
  } finally {
    readable.cleanup();
  }

  for (const [kind, expected] of [
    ["empty", { kind: "empty" }],
    ["none", { kind: "unreachable" }],
  ] as const) {
    const fake = fakeHost(replyHost(kind));
    try {
      assert.deepEqual(await fake.provider.getReadState("google-chrome"), expected);
      // The recording path is unchanged by the split: anything but a URL is null.
      assert.equal(await fake.provider.get("google-chrome"), null);
    } finally {
      fake.cleanup();
    }
  }
});

test("getReadState never invents an empty state from a protocol-1 host", async () => {
  // A host from a build that answered `<url><SEP><title>` announces a bare READY. Its
  // first field is a URL, not a kind — parsing it as one would read "https://…" as an
  // unknown kind, or worse, read a title as a URL.
  const fake = fakeHost(REPLY_HOST);
  try {
    assert.deepEqual(await fake.provider.getReadState("firefox"), {
      kind: "url",
      url: "https://example.com/get%20firefox",
      title: "Example Domain",
    });
  } finally {
    fake.cleanup();
  }

  const silent = fakeHost(`${PID_LINE}
process.stdout.write("READY\\n");
process.stdin.on("data", () => process.stdout.write("\\n"));`);
  try {
    // Protocol 1 could not say which kind of "no URL" this was, so it claims the least.
    assert.deepEqual(await silent.provider.getReadState("firefox"), { kind: "unreachable" });
  } finally {
    silent.cleanup();
  }
});

test("a host that answers with an unknown kind is unreachable, not a URL", async () => {
  const fake = fakeHost(replyHost("teapot", "https://example.com"));
  try {
    assert.deepEqual(await fake.provider.getReadState("firefox"), { kind: "unreachable" });
    assert.equal(await fake.provider.get("firefox"), null);
  } finally {
    fake.cleanup();
  }
});

test("a url the normalizer rejects reads as an empty address bar", async () => {
  // A search phrase typed in the omnibox: the bar is live and there is no page to
  // verify, which is exactly the "open a website" case, not a blocked read.
  const fake = fakeHost(replyHost("url", "how tall is the eiffel tower", "Search"));
  try {
    assert.deepEqual(await fake.provider.getReadState("firefox"), { kind: "empty" });
  } finally {
    fake.cleanup();
  }
});

test("LinuxUrlProvider resolves null when the host answers with garbage", async () => {
  const fake = fakeHost(GARBAGE_HOST);
  try {
    assert.equal(await fake.provider.get("firefox"), null);
  } finally {
    fake.cleanup();
  }
});

test("LinuxUrlProvider warns once and stops respawning when the host dies before READY", async () => {
  const fake = fakeHost(DEAD_HOST);
  try {
    const warnings = await captureWarnings(async () => {
      assert.equal(await fake.provider.get("firefox"), null);
      assert.equal(await fake.provider.get("firefox"), null);
    });
    const relevant = warnings.filter((w) => w.includes("python3-pyatspi"));
    assert.equal(relevant.length, 1, `expected one warning, got ${JSON.stringify(warnings)}`);
    assert.match(relevant[0], /sudo apt install python3-pyatspi/);
    // A host that can't load its bindings never will: exactly one spawn attempt.
    assert.equal(fake.pids().length, 1);
  } finally {
    fake.cleanup();
  }
});

test("LinuxUrlProvider times out a hung host and recycles it for the next read", async () => {
  const fake = fakeHost(HANG_HOST);
  try {
    const startedAt = Date.now();
    assert.equal(await fake.provider.get("firefox"), null);
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed >= 1900, `expected the 2s deadline, took ${elapsed}ms`);

    const firstPids = fake.pids();
    assert.equal(firstPids.length, 1);
    assert.equal(await waitForExit(firstPids[0]), true, "the hung host should have been killed");

    // The next read gets a brand-new host rather than a dead one.
    assert.equal(await fake.provider.get("firefox"), null);
    const pids = fake.pids();
    assert.equal(pids.length, 2);
    assert.notEqual(pids[0], pids[1]);
  } finally {
    fake.cleanup();
  }
});

test("LinuxUrlProvider dispose kills the host, cleans its tmpdir, and stays closed", async () => {
  const before = new Set(hostTmpDirs());
  const fake = fakeHost(REPLY_HOST);
  try {
    assert.ok(await fake.provider.get("firefox"));
    const created = hostTmpDirs().filter((dir) => !before.has(dir));
    assert.equal(created.length, 1, "the host should own exactly one scratch dir");
    assert.ok(existsSync(path.join(created[0], "atspi-url.py")));

    const [pid] = fake.pids();
    fake.provider.dispose();
    assert.equal(await waitForExit(pid), true, "dispose should kill the host");
    assert.equal(existsSync(created[0]), false, "dispose should remove the scratch dir");

    // Disposed is terminal: no resurrection on a later poll.
    assert.equal(await fake.provider.get("firefox"), null);
    assert.equal(fake.pids().length, 1);
  } finally {
    fake.cleanup();
  }
});

test("LinuxUrlProvider ignores apps it does not support without spawning a host", async () => {
  const fake = fakeHost(REPLY_HOST);
  try {
    assert.equal(await fake.provider.get("xfce4-terminal"), null);
    assert.equal(fake.pids().length, 0);
  } finally {
    fake.cleanup();
  }
});

test("supports() recognizes browsers by their WM_CLASS spelling", () => {
  const provider = new LinuxUrlProvider();
  try {
    for (const app of [
      "firefox",
      "Navigator", // Firefox's WM_CLASS instance name
      "firefox-esr",
      "Google-chrome",
      "Chromium-browser",
      "chromium",
      "Microsoft-edge",
      "brave-browser",
      "Opera",
      "Vivaldi-stable",
    ]) {
      assert.equal(provider.supports(app), true, `${app} should be a browser`);
    }
    for (const app of ["xfce4-terminal", "gnome-terminal-server", "Code", "Nautilus", "unknown"]) {
      assert.equal(provider.supports(app), false, `${app} should not be a browser`);
    }
  } finally {
    provider.dispose();
  }
});

test("normalizeUrl restores a dropped scheme and rejects searches", () => {
  assert.equal(normalizeUrl("https://example.com/a?b=c"), "https://example.com/a?b=c");
  assert.equal(normalizeUrl("  http://example.com  "), "http://example.com");
  assert.equal(normalizeUrl("about:blank"), null); // no "://" and no dot
  assert.equal(normalizeUrl("file:///home/u/x.txt"), "file:///home/u/x.txt");
  assert.equal(normalizeUrl("github.com/anthropics"), "https://github.com/anthropics");
  assert.equal(normalizeUrl("how tall is the eiffel tower"), null);
  assert.equal(normalizeUrl("localhost"), null); // no dot: a search, not a host
  assert.equal(normalizeUrl(""), null);
  assert.equal(normalizeUrl("   "), null);
});

test("browserUrlProviderKind names AT-SPI on Linux", () => {
  assert.equal(browserUrlProviderKind("linux"), "atspi");
  assert.equal(browserUrlProviderKind("darwin"), "applescript");
  assert.equal(browserUrlProviderKind("win32"), "uia");
  assert.equal(browserUrlProviderKind("freebsd"), "none");
});

test("linuxUrlSupport caches the probe and names the apt package when it fails", () => {
  try {
    resetLinuxUrlProbe();
    let calls = 0;
    const support = linuxUrlSupport(() => {
      calls++;
      return false;
    });
    assert.equal(support.ok, false);
    assert.match(support.reason ?? "", /python3-pyatspi/);
    // Cached: the doctor re-runs on every HUD paint and must not shell out again.
    linuxUrlSupport(() => {
      throw new Error("probe should have been cached");
    });
    assert.equal(calls, 1);

    resetLinuxUrlProbe();
    assert.deepEqual(
      linuxUrlSupport(() => true),
      { ok: true },
    );
  } finally {
    resetLinuxUrlProbe();
  }
});

test("the embedded pyatspi script compiles", (t) => {
  let python: string | null = "python3";
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore", timeout: 5000 });
  } catch {
    python = null;
  }
  if (!python) {
    t.skip("python3 is not installed on this machine");
    return;
  }
  const dir = mkdtempSync(path.join(tmpdir(), "skr-atspi-compile-"));
  try {
    const file = path.join(dir, "atspi-url.py");
    writeFileSync(file, ATSPI_SCRIPT, "utf8");
    // Syntax only — `import pyatspi` is not executed, so this passes on CI too.
    execFileSync(python, ["-m", "py_compile", file], { stdio: "pipe", timeout: 20000 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
