import assert from "node:assert/strict";
import test from "node:test";

import type { DoctorReport } from "../../common/ipc";
import {
  A11Y_APPS_SCRIPT,
  matchBrowsers,
  probeAccessibleBrowsers,
  shouldProbeBrowserA11y,
  type LinuxProbeExec,
} from "./linux-a11y-probe";

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

const DESKTOP = [
  "gnome-shell",
  "Firefox",
  "Files",
  "gnome-terminal-server",
  "",
  "Skill Recorder",
].join("\n");

test("matchBrowsers keeps only known browser apps, lowercased and deduped", () => {
  assert.deepEqual(matchBrowsers(DESKTOP), ["firefox"]);
  assert.deepEqual(matchBrowsers("Chromium\nchromium\nGoogle-chrome\n"), [
    "chromium",
    "google-chrome",
  ]);
  assert.deepEqual(matchBrowsers("Microsoft Edge\n  Brave-browser  \n"), [
    "microsoft edge",
    "brave-browser",
  ]);
  assert.deepEqual(matchBrowsers(""), []);
  assert.deepEqual(matchBrowsers("gnome-shell\nFiles\n"), []);
});

test("probeAccessibleBrowsers runs one python3 -c and reports what it found", async () => {
  await asPlatform("linux", async () => {
    const { exec, calls } = fakeExec(DESKTOP);
    const result = await probeAccessibleBrowsers(exec);
    assert.deepEqual(result, { checked: true, accessibleBrowsers: ["firefox"] });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "python3");
    assert.equal(calls[0][1], "-c");
    assert.equal(calls[0][2], A11Y_APPS_SCRIPT);
  });
});

test("a desktop with no accessible browser is a checked, empty answer", async () => {
  await asPlatform("linux", async () => {
    const { exec } = fakeExec("gnome-shell\nFiles\n");
    // Distinct from `checked:false`: we asked, and the honest answer is "none".
    assert.deepEqual(await probeAccessibleBrowsers(exec), {
      checked: true,
      accessibleBrowsers: [],
    });
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
      assert.deepEqual(await probeAccessibleBrowsers(exec), {
        checked: false,
        accessibleBrowsers: [],
      });
    }
  });
});

test("the probe never runs off Linux", async () => {
  for (const platform of ["darwin", "win32"] as const) {
    await asPlatform(platform, async () => {
      const { exec, calls } = fakeExec(DESKTOP);
      assert.deepEqual(await probeAccessibleBrowsers(exec), {
        checked: false,
        accessibleBrowsers: [],
      });
      assert.equal(calls.length, 0);
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
