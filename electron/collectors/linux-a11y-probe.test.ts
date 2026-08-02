import assert from "node:assert/strict";
import test from "node:test";

import type { BrowserA11yProbeResult } from "../../common/compatibility";
import type { DoctorReport } from "../../common/ipc";
import {
  A11Y_APPS_SCRIPT,
  matchBrowsers,
  probeAccessibleBrowsers,
  shouldProbeBrowserA11y,
  type LinuxProbeExec,
  type LinuxProbeReaderFactory,
  type LinuxProbeUrlReader,
} from "./linux-a11y-probe";
import type { LinuxUrlReadState } from "./linux-url-provider";

/** The probe is platform-gated, so every case declares which platform it is. */
function asPlatform(platform: NodeJS.Platform, body: () => Promise<void>): Promise<void> {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  return body().finally(() => {
    if (descriptor) Object.defineProperty(process, "platform", descriptor);
  });
}

function fakeExec(response: string | Error): { exec: LinuxProbeExec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: LinuxProbeExec = async (file, args) => {
    calls.push([file, ...args]);
    if (response instanceof Error) throw response;
    return response;
  };
  return { exec, calls };
}

/**
 * A stand-in for {@link LinuxUrlProvider}. Unit tests never spawn python3 or touch an
 * accessibility bus, so the reader is injected: `reads` maps the app token the probe
 * asks for to the state the read returns — a URL string, `"empty"` (readable browser,
 * no page open) or `"unreachable"` (the snap-Firefox case: enumerable on the registry,
 * denied on the tree). An app with no entry is unreachable.
 */
function fakeReader(reads: Record<string, string>): {
  create: LinuxProbeReaderFactory;
  asked: string[];
  created: number;
  disposed: number;
} {
  const state = { asked: [] as string[], created: 0, disposed: 0 };
  const create: LinuxProbeReaderFactory = () => {
    state.created += 1;
    const reader: LinuxProbeUrlReader = {
      async getReadState(app): Promise<LinuxUrlReadState> {
        state.asked.push(app);
        const read = reads[app];
        if (read === "empty") return { kind: "empty" };
        if (!read || read === "unreachable") return { kind: "unreachable" };
        return { kind: "url", url: read };
      },
      dispose() {
        state.disposed += 1;
      },
    };
    return reader;
  };
  return {
    create,
    get asked() {
      return state.asked;
    },
    get created() {
      return state.created;
    },
    get disposed() {
      return state.disposed;
    },
  };
}

const DESKTOP = [
  "gnome-shell",
  "Firefox",
  "Files",
  "gnome-terminal-server",
  "",
  "Skill Recorder",
].join("\n");

/** Nothing in these tests may touch /proc, so both resolvers are always injected. */
const noProc = () => null;
const noExe = () => null;

/** The expected result, with the buckets a case doesn't care about spelled out once. */
function probed(partial: Partial<BrowserA11yProbeResult> = {}): BrowserA11yProbeResult {
  return {
    checked: true,
    accessibleBrowsers: [],
    noPageOpen: [],
    presentButUnreadable: [],
    snapBrowsers: [],
    ...partial,
  };
}

/** `{ name, snap:false }` for each — the shape most cases expect. */
function unconfined(...names: string[]) {
  return names.map((name) => ({ name, snap: false }));
}

test("matchBrowsers keeps only known browser apps, lowercased and deduped", () => {
  assert.deepEqual(matchBrowsers(DESKTOP, noProc, noExe), unconfined("firefox"));
  assert.deepEqual(
    matchBrowsers("Chromium\nchromium\nGoogle-chrome\n", noProc, noExe),
    unconfined("chromium", "google-chrome"),
  );
  assert.deepEqual(
    matchBrowsers("Microsoft Edge\n  Brave-browser  \n", noProc, noExe),
    unconfined("microsoft edge", "brave-browser"),
  );
  assert.deepEqual(matchBrowsers("", noProc, noExe), []);
  assert.deepEqual(matchBrowsers("gnome-shell\nFiles\n", noProc, noExe), []);
});

test("matchBrowsers reads the pid column when the app name is readable", () => {
  const lines = ["3068\tcode", "13388\txfce4-terminal", "160836\tFirefox"].join("\n");
  assert.deepEqual(matchBrowsers(lines, noProc, noExe), unconfined("firefox"));
});

test("a confined browser with no readable name is found through its process", () => {
  // Live finding: snap Firefox's AT-SPI name comes back empty because the cache fetch
  // behind it is denied, while the registry still knows its pid. Reporting "no browser
  // is running" to someone looking at Firefox is its own untruth.
  const proc = (pid: number) => (pid === 160836 ? "firefox" : "gnome-shell");
  assert.deepEqual(matchBrowsers("3068\tcode\n160836\t\n", proc, noExe), unconfined("firefox"));
  // A pid that isn't a browser stays out, and a dead/unreadable pid is simply skipped.
  assert.deepEqual(matchBrowsers("3068\t\n", proc, noExe), []);
  assert.deepEqual(matchBrowsers("160836\t\n", () => null, noExe), []);
  // Only digits ever reach the /proc path.
  assert.deepEqual(
    matchBrowsers("../../etc\t\n", () => "firefox", noExe),
    [],
  );
});

test("matchBrowsers tags a snap build from its executable, and only a snap", () => {
  // The two live cases, verbatim: snap Firefox mounts under /snap/, and deb Chrome
  // (which reads perfectly) lives in /opt. Blaming confinement for the second is the
  // defect this tag exists to prevent.
  const exe = (pid: number) =>
    pid === 160836 ? "/snap/firefox/8702/usr/lib/firefox/firefox" : "/opt/google/chrome/chrome";
  assert.deepEqual(matchBrowsers("160836\tFirefox\n288481\tGoogle Chrome\n", noProc, exe), [
    { name: "firefox", snap: true },
    { name: "google chrome", snap: false },
  ]);
  // A pid whose executable can't be read is not evidence of confinement.
  assert.deepEqual(matchBrowsers("160836\tFirefox\n", noProc, noExe), unconfined("firefox"));
  // Two windows of one browser are one entry, and one snap sighting settles it.
  assert.deepEqual(
    matchBrowsers("160836\tFirefox\n160840\tFirefox\n", noProc, (pid) =>
      pid === 160840 ? "/snap/firefox/8702/usr/lib/firefox/firefox" : null,
    ),
    [{ name: "firefox", snap: true }],
  );
});

test("probeAccessibleBrowsers enumerates, then proves the URL with a real read", async () => {
  await asPlatform("linux", async () => {
    const { exec, calls } = fakeExec(DESKTOP);
    const reader = fakeReader({ firefox: "https://example.test/orders" });
    const result = await probeAccessibleBrowsers(exec, reader.create);
    assert.deepEqual(result, probed({ accessibleBrowsers: ["firefox"] }));
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "python3");
    assert.equal(calls[0][1], "-c");
    assert.equal(calls[0][2], A11Y_APPS_SCRIPT);
    // Step 2 asked the provider about exactly the browser step 1 found, then let go.
    assert.deepEqual(reader.asked, ["firefox"]);
    assert.equal(reader.created, 1);
    assert.equal(reader.disposed, 1);
  });
});

test("a browser that enumerates but won't read is present-but-unreadable, not accessible", async () => {
  await asPlatform("linux", async () => {
    // The live snap-Firefox finding: AppArmor lets the name onto the registry and
    // denies `org.a11y.atspi.Cache GetItems`, so the read comes back empty. Calling
    // that "accessible" is the bug this probe was rewritten to stop telling.
    const { exec } = fakeExec(DESKTOP);
    const reader = fakeReader({ firefox: "unreachable" });
    assert.deepEqual(
      await probeAccessibleBrowsers(exec, reader.create),
      probed({ presentButUnreadable: ["firefox"] }),
    );
    assert.equal(reader.disposed, 1);
  });
});

test("a readable browser with an empty address bar lands in noPageOpen, not unreadable", async () => {
  await asPlatform("linux", async () => {
    // Measured on deb Chrome sitting on the new tab page: the whole tree walks, the
    // address bar is found by role and name, and it is genuinely blank. Nothing about
    // that machine is broken, so it must not be reported as blocked reads.
    const { exec } = fakeExec("Google Chrome\n");
    const reader = fakeReader({ "google chrome": "empty" });
    assert.deepEqual(
      await probeAccessibleBrowsers(exec, reader.create),
      probed({ noPageOpen: ["google chrome"] }),
    );
  });
});

test("each running browser is graded on its own read, and snaps are carried through", async () => {
  await asPlatform("linux", async () => {
    const { exec } = fakeExec("160836\tFirefox\n288481\tGoogle Chrome\n2000\tChromium\n");
    const reader = fakeReader({
      firefox: "unreachable",
      "google chrome": "empty",
      chromium: "https://example.test/",
    });
    const exe = (pid: number) =>
      pid === 160836 ? "/snap/firefox/8702/usr/lib/firefox/firefox" : "/usr/bin/chromium";
    const result = await probeAccessibleBrowsers(exec, reader.create, noProc, exe);
    assert.deepEqual(
      result,
      probed({
        accessibleBrowsers: ["chromium"],
        noPageOpen: ["google chrome"],
        presentButUnreadable: ["firefox"],
        // The tag travels with the browser, not with the bucket: the report needs it to
        // pick a remedy for the one browser that didn't answer.
        snapBrowsers: ["firefox"],
      }),
    );
    assert.deepEqual(reader.asked, ["firefox", "google chrome", "chromium"]);
    // One provider for the whole probe — the host process is expensive to start.
    assert.equal(reader.created, 1);
  });
});

test("a read that throws or a provider that won't start grades down, never throws", async () => {
  await asPlatform("linux", async () => {
    const { exec } = fakeExec(DESKTOP);
    let disposed = 0;
    const throwingRead: LinuxProbeReaderFactory = () => ({
      getReadState: () => Promise.reject(new Error("host died")),
      dispose: () => {
        disposed += 1;
      },
    });
    assert.deepEqual(
      await probeAccessibleBrowsers(exec, throwingRead),
      probed({ presentButUnreadable: ["firefox"] }),
    );
    assert.equal(disposed, 1);

    const noHost: LinuxProbeReaderFactory = () => {
      throw new Error("spawn python3 ENOENT");
    };
    assert.deepEqual(
      await probeAccessibleBrowsers(fakeExec(DESKTOP).exec, noHost),
      probed({ presentButUnreadable: ["firefox"] }),
    );
  });
});

test("a desktop with no browser at all skips the read phase entirely", async () => {
  await asPlatform("linux", async () => {
    const { exec } = fakeExec("gnome-shell\nFiles\n");
    const reader = fakeReader({});
    // Distinct from `checked:false`: we asked, and the honest answer is "none".
    assert.deepEqual(await probeAccessibleBrowsers(exec, reader.create), probed());
    // No browser means no host process — the expensive half is never paid for.
    assert.equal(reader.created, 0);
  });
});

test("a failure or timeout resolves checked:false instead of throwing", async () => {
  await asPlatform("linux", async () => {
    for (const failure of [
      new Error("spawn python3 ENOENT"),
      Object.assign(new Error("Command failed"), { killed: true, signal: "SIGTERM" }),
      new Error("Command failed: python3 -c ... (exit 1)"),
    ]) {
      const { exec } = fakeExec(failure);
      const reader = fakeReader({ firefox: "https://example.test/" });
      assert.deepEqual(
        await probeAccessibleBrowsers(exec, reader.create),
        probed({ checked: false }),
      );
      assert.equal(reader.created, 0);
    }
  });
});

test("the probe never runs off Linux", async () => {
  for (const platform of ["darwin", "win32"] as const) {
    await asPlatform(platform, async () => {
      const { exec, calls } = fakeExec(DESKTOP);
      const reader = fakeReader({ firefox: "https://example.test/" });
      assert.deepEqual(
        await probeAccessibleBrowsers(exec, reader.create),
        probed({ checked: false }),
      );
      assert.equal(calls.length, 0);
      assert.equal(reader.created, 0);
    });
  }
});

/* --- The guard ------------------------------------------------------------- */

function doctor(overrides: Partial<DoctorReport> = {}): DoctorReport {
  return {
    platform: "linux",
    foundry: {
      configured: false,
      endpoint: null,
      deployment: null,
      source: null,
      describerDeployment: null,
      transcriptionDeployment: null,
    },
    activeWindow: { ok: true, provider: "x11", path: null },
    browserUrl: { kind: "atspi", supported: true },
    sessionsDir: "/tmp/sessions",
    activeSources: [],
    ...overrides,
  };
}

test("the probe is only worth running on X11 Linux with working pyatspi", () => {
  assert.equal(shouldProbeBrowserA11y(doctor()), true);
  // Wayland (or missing x11-utils) — the doctor reports it as no window tracking.
  assert.equal(
    shouldProbeBrowserA11y(
      doctor({ activeWindow: { ok: false, provider: "x11", path: null, note: "Wayland session" } }),
    ),
    false,
  );
  assert.equal(
    shouldProbeBrowserA11y(doctor({ browserUrl: { kind: "atspi", supported: false } })),
    false,
  );
  assert.equal(
    shouldProbeBrowserA11y(
      doctor({
        platform: "darwin",
        activeWindow: { ok: true, provider: "get-windows", path: "/x" },
        browserUrl: { kind: "applescript", supported: true },
      }),
    ),
    false,
  );
});
