import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { resetLinuxCaptureProbe } from "./collectors/linux-active-window";
import { runDoctor } from "./doctor";

const ENV_KEYS = [
  "XDG_SESSION_TYPE",
  "WAYLAND_DISPLAY",
  "DISPLAY",
  "SKILL_RECORDER_CONFIG_DIR",
  "SKILL_RECORDER_SESSIONS_DIR",
] as const;

/**
 * Runs `body` as if this were the given platform and session. The doctor reads
 * `process.platform` and the X11 environment directly, and its Foundry half reads the
 * user's real config dir — so both are redirected and restored around every case.
 */
function asPlatform(
  platform: NodeJS.Platform,
  env: Partial<Record<(typeof ENV_KEYS)[number], string>>,
  toolsPresent: boolean,
  body: () => void,
): void {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  const saved = ENV_KEYS.map((key) => [key, process.env[key]] as const);
  const root = mkdtempSync(path.join(tmpdir(), "skill-recorder-doctor-"));
  try {
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.SKILL_RECORDER_CONFIG_DIR = path.join(root, "config");
    process.env.SKILL_RECORDER_SESSIONS_DIR = path.join(root, "sessions");
    for (const [key, value] of Object.entries(env)) process.env[key] = value;
    resetLinuxCaptureProbe(toolsPresent);
    body();
  } finally {
    if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetLinuxCaptureProbe();
    rmSync(root, { recursive: true, force: true });
  }
}

const source = (report: ReturnType<typeof runDoctor>, key: string) =>
  report.activeSources.find((s) => s.key === key);

test("doctor reports a working X11 session as fully supported for window capture", () => {
  asPlatform("linux", { XDG_SESSION_TYPE: "x11", DISPLAY: ":0" }, true, () => {
    const report = runDoctor();
    assert.equal(report.activeWindow.provider, "x11");
    assert.equal(report.activeWindow.ok, true);
    assert.equal(report.activeWindow.note, undefined);
    // The in-repo reader has no module to point at — `path` is honestly null.
    assert.equal(report.activeWindow.path, null);
    assert.equal(source(report, "appActivity")?.supported, true);
    assert.equal(source(report, "windowTitles")?.supported, true);
  });
});

test("doctor marks app + title capture unsupported on Wayland, with the fix", () => {
  asPlatform(
    "linux",
    { XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" },
    true,
    () => {
      const report = runDoctor();
      assert.equal(report.activeWindow.ok, false);
      assert.equal(report.activeWindow.provider, "x11");
      assert.match(report.activeWindow.note ?? "", /Wayland/);

      for (const key of ["appActivity", "windowTitles"]) {
        const entry = source(report, key);
        assert.equal(entry?.supported, false, `${key} should be unsupported`);
        assert.equal(entry?.note, report.activeWindow.note);
      }
      // Sources that don't depend on the window reader stay supported.
      assert.equal(source(report, "clipboard")?.supported, true);
      assert.equal(source(report, "video")?.supported, true);
    },
  );
});

test("doctor points at x11-utils when the X11 tools are missing", () => {
  asPlatform("linux", { XDG_SESSION_TYPE: "x11", DISPLAY: ":0" }, false, () => {
    const report = runDoctor();
    assert.equal(report.activeWindow.ok, false);
    assert.match(report.activeWindow.note ?? "", /x11-utils/);
    assert.equal(source(report, "appActivity")?.note, report.activeWindow.note);
  });
});

test("doctor reports Linux browser URLs as unsupported without inventing a provider", () => {
  asPlatform("linux", { XDG_SESSION_TYPE: "x11", DISPLAY: ":0" }, true, () => {
    const report = runDoctor();
    assert.equal(report.browserUrl.kind, "none");
    assert.equal(report.browserUrl.supported, false);
    assert.equal(source(report, "browserUrls")?.supported, false);
  });
});
