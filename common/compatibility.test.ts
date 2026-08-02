import assert from "node:assert/strict";
import test from "node:test";

import {
  FIXES,
  gradeCompatibility,
  renderCompatibilityText,
  type CompatibilityProbes,
  type CompatibilityReport,
  type CompatibilitySignal,
} from "./compatibility";
import { DEFAULT_FOUNDRY_TRANSCRIPTION_DEPLOYMENT } from "./foundry";
import type { DoctorReport } from "./ipc";

/** A machine where everything works, so each case can degrade exactly one thing. */
function doctorReport(overrides: Partial<DoctorReport> = {}): DoctorReport {
  return {
    platform: "linux",
    foundry: {
      configured: true,
      endpoint: "https://contoso.openai.azure.com",
      deployment: "gpt-5.3-codex",
      source: "file",
      describerDeployment: "gpt-5.2",
      transcriptionDeployment: "gpt-4o-transcribe",
    },
    activeWindow: { ok: true, provider: "x11", path: null },
    browserUrl: { kind: "atspi", supported: true },
    sessionsDir: "/tmp/sessions",
    activeSources: [],
    ...overrides,
  };
}

const AT = 1_754_000_000_000;

function grade(
  overrides: Partial<DoctorReport> = {},
  probes: CompatibilityProbes = {},
): CompatibilityReport {
  return gradeCompatibility(doctorReport(overrides), probes, AT);
}

function signal(report: CompatibilityReport, key: string): CompatibilitySignal {
  const found = report.signals.find((s) => s.key === key);
  assert.ok(found, `expected a "${key}" signal`);
  return found;
}

const LIVE_FIREFOX: CompatibilityProbes = {
  browserA11y: { checked: true, accessibleBrowsers: ["firefox"] },
};

/* --- Level rubric ---------------------------------------------------------- */

test("Full needs window tracking plus a browser that is live-accessible", () => {
  const report = grade({}, LIVE_FIREFOX);
  assert.equal(report.level, "full");
  assert.equal(report.headline, "Full capture");
  assert.match(report.expectation, /richest analyses/);
  assert.equal(signal(report, "browserUrls").ok, true);
  assert.equal(signal(report, "browserUrls").detail, "Firefox is exposing accessibility ✓");
  assert.equal(signal(report, "browserUrls").fix, undefined);
  assert.equal(report.checkedAt, AT);
});

test("several accessible browsers are named together", () => {
  const report = grade(
    {},
    { browserA11y: { checked: true, accessibleBrowsers: ["firefox", "chromium"] } },
  );
  assert.equal(signal(report, "browserUrls").detail, "Firefox, Chromium are exposing accessibility ✓");
  assert.equal(report.level, "full");
});

test("URLs unavailable grades Good, never Reduced", () => {
  const report = grade(
    { browserUrl: { kind: "atspi", supported: false, note: "no bindings" } },
    LIVE_FIREFOX,
  );
  assert.equal(report.level, "good");
  assert.equal(report.headline, "Good capture");
  assert.match(report.expectation, /window titles and screen frames/);
  // Window tracking is untouched by a URL failure.
  assert.equal(signal(report, "windowTracking").ok, true);
});

test("Wayland grades Reduced even when the X11 tools are installed", () => {
  const report = grade(
    {
      activeWindow: {
        ok: false,
        provider: "x11",
        path: null,
        note: "Wayland session — app and window tracking needs X11. Log out and pick “Ubuntu on Xorg” at the login screen.",
      },
    },
    LIVE_FIREFOX,
  );
  assert.equal(report.level, "reduced");
  assert.equal(report.headline, "Reduced capture");
  assert.match(report.expectation, /screen video, clipboard and narration/);
  assert.equal(signal(report, "windowTracking").fix, FIXES.wayland);
});

test("missing x11-utils grades Reduced with the apt command", () => {
  const report = grade({
    activeWindow: {
      ok: false,
      provider: "x11",
      path: null,
      note: "Missing X11 tools — install them with: sudo apt install x11-utils",
    },
  });
  assert.equal(report.level, "reduced");
  assert.equal(signal(report, "windowTracking").fix, FIXES.x11Utils);
});

test("a window-tracking failure with no user-applicable remedy ships no fix", () => {
  const report = grade({
    platform: "win32",
    activeWindow: { ok: false, provider: "missing", path: null, error: "koffi not found" },
    browserUrl: { kind: "uia", supported: true },
  });
  assert.equal(report.level, "reduced");
  assert.equal(signal(report, "windowTracking").detail, "koffi not found");
  assert.equal(signal(report, "windowTracking").fix, undefined);
});

/* --- The Linux live probe -------------------------------------------------- */

test("missing pyatspi ships the apt command and grades Good", () => {
  const report = grade({
    browserUrl: {
      kind: "atspi",
      supported: false,
      note: "Browser URL capture needs python3-pyatspi (sudo apt install python3-pyatspi).",
    },
  });
  assert.equal(report.level, "good");
  assert.equal(signal(report, "browserUrls").fix, FIXES.pyatspi);
});

test("pyatspi present but no accessible browser grades Good with the restart commands", () => {
  const report = grade({}, { browserA11y: { checked: true, accessibleBrowsers: [] } });
  assert.equal(report.level, "good");
  assert.equal(
    signal(report, "browserUrls").detail,
    "No running browser is currently accessible — start one with:",
  );
  assert.equal(signal(report, "browserUrls").fix, FIXES.browserAccessibility);
});

test("an unrun probe never claims Full — it grades from the static signals only", () => {
  // linux + X11 + pyatspi importable, but nothing could be verified live. Whether a
  // browser exposes its address bar is per-launch state, so Full would be a guess.
  for (const probes of [{}, { browserA11y: { checked: false, accessibleBrowsers: [] } }]) {
    const report = grade({}, probes);
    assert.equal(report.level, "good");
    assert.match(signal(report, "browserUrls").detail, /could not verify a running browser/);
    assert.equal(signal(report, "browserUrls").fix, FIXES.browserAccessibility);
  }
});

test("a probe result is ignored off Linux", () => {
  // A stale or bogus probe must never downgrade a platform that doesn't use it.
  const report = grade(
    { platform: "darwin", browserUrl: { kind: "applescript", supported: true } },
    { browserA11y: { checked: true, accessibleBrowsers: [] } },
  );
  assert.equal(report.level, "full");
  assert.equal(signal(report, "browserUrls").ok, true);
});

/* --- macOS / Windows ------------------------------------------------------- */

test("macOS with AppleScript URLs reaches Full and asks for nothing", () => {
  const report = grade({
    platform: "darwin",
    activeWindow: { ok: true, provider: "get-windows", path: "/x" },
    browserUrl: { kind: "applescript", supported: true },
  });
  assert.equal(report.level, "full");
  assert.equal(signal(report, "browserUrls").fix, undefined);
});

test("macOS surfaces the Automation grant path when the doctor reports a problem", () => {
  const withNote = grade({
    platform: "darwin",
    activeWindow: { ok: true, provider: "get-windows", path: "/x" },
    browserUrl: { kind: "applescript", supported: true, note: "Automation access was declined." },
  });
  assert.equal(withNote.level, "full");
  assert.equal(signal(withNote, "browserUrls").fix, FIXES.macAutomation);

  const unsupported = grade({
    platform: "darwin",
    activeWindow: { ok: true, provider: "get-windows", path: "/x" },
    browserUrl: { kind: "none", supported: false, note: "No supported browser." },
  });
  assert.equal(unsupported.level, "good");
  assert.equal(signal(unsupported, "browserUrls").fix, FIXES.macAutomation);
});

test("Windows without URL support grades Good and offers no Linux/macOS remedy", () => {
  const report = grade({
    platform: "win32",
    activeWindow: { ok: true, provider: "koffi", path: "/x" },
    browserUrl: { kind: "none", supported: false, note: "Not available on this platform" },
  });
  assert.equal(report.level, "good");
  assert.equal(signal(report, "browserUrls").fix, undefined);
});

/* --- Video ----------------------------------------------------------------- */

test("video is always captured, and the Wayland portal note is informational", () => {
  const plain = grade({}, LIVE_FIREFOX);
  assert.equal(signal(plain, "video").ok, true);
  assert.ok(!signal(plain, "video").detail.includes(FIXES.waylandVideo));

  const wayland = grade({
    activeWindow: { ok: false, provider: "x11", path: null, note: "Wayland session — needs X11." },
  });
  assert.equal(signal(wayland, "video").ok, true);
  // No command to run: the note travels in the detail, not as a copyable fix.
  assert.ok(signal(wayland, "video").detail.includes(FIXES.waylandVideo));
  assert.equal(signal(wayland, "video").fix, undefined);
});

/* --- AI + narration -------------------------------------------------------- */

test("the AI line names all three resolved deployments and points at Test connection", () => {
  const report = grade({}, LIVE_FIREFOX);
  const ai = signal(report, "ai");
  assert.equal(report.aiReady, true);
  assert.equal(ai.ok, true);
  assert.match(ai.detail, /contoso\.openai\.azure\.com/);
  assert.match(ai.detail, /builders gpt-5\.3-codex/);
  assert.match(ai.detail, /describer gpt-5\.2/);
  assert.match(ai.detail, /narration gpt-4o-transcribe/);
  // The check is offline by design, so it says so rather than spending a model call.
  assert.match(ai.detail, /not tested live/);
  assert.equal(ai.fix, FIXES.aiConnection);
});

test("an unconfigured connection clears aiReady without touching the capture level", () => {
  const report = grade(
    {
      foundry: {
        configured: false,
        endpoint: null,
        deployment: null,
        source: null,
        describerDeployment: null,
        transcriptionDeployment: null,
      },
    },
    LIVE_FIREFOX,
  );
  assert.equal(report.aiReady, false);
  assert.equal(report.level, "full");
  assert.equal(signal(report, "ai").ok, false);
  assert.equal(signal(report, "ai").fix, FIXES.aiConnection);
  assert.equal(signal(report, "narration").fix, FIXES.aiConnection);
});

test("narration keys on the resolved transcription deployment", () => {
  const ready = grade({}, LIVE_FIREFOX);
  assert.equal(signal(ready, "narration").ok, true);
  assert.match(signal(ready, "narration").detail, /gpt-4o-transcribe/);

  const unresolved = grade({
    foundry: {
      configured: true,
      endpoint: "https://contoso.openai.azure.com",
      deployment: "gpt-5.3-codex",
      source: "file",
      describerDeployment: "gpt-5.2",
      transcriptionDeployment: null,
    },
  });
  assert.equal(signal(unresolved, "narration").ok, false);
  assert.equal(signal(unresolved, "narration").fix, FIXES.transcriptionDeployment);
  assert.match(FIXES.transcriptionDeployment, new RegExp(DEFAULT_FOUNDRY_TRANSCRIPTION_DEPLOYMENT));
});

test("a denied microphone shows the OS settings path for the platform", () => {
  const mac = gradeCompatibility(
    doctorReport({ platform: "darwin", browserUrl: { kind: "applescript", supported: true } }),
    { microphonePermission: "denied" },
    AT,
  );
  assert.equal(signal(mac, "narration").ok, false);
  assert.equal(signal(mac, "narration").fix, FIXES.micMac);

  const win = gradeCompatibility(
    doctorReport({
      platform: "win32",
      activeWindow: { ok: true, provider: "koffi", path: "/x" },
      browserUrl: { kind: "uia", supported: true },
    }),
    { microphonePermission: "denied" },
    AT,
  );
  assert.equal(signal(win, "narration").fix, FIXES.micWindows);

  // A permission the OS hasn't been asked about is not a problem to report.
  const unknown = grade({ platform: "linux" }, { microphonePermission: "unknown" });
  assert.equal(signal(unknown, "narration").ok, true);
});

/* --- The fix catalog ------------------------------------------------------- */

test("every fix string is pinned exactly as the docs quote it", () => {
  assert.deepEqual(FIXES, {
    x11Utils: "sudo apt install x11-utils",
    wayland: "Log out and choose “Ubuntu on Xorg” at the login screen",
    pyatspi: "sudo apt install python3-pyatspi",
    browserAccessibility:
      "Firefox: GNOME_ACCESSIBILITY=1 firefox & (quit it fully first — snap is single-instance) · Chrome/Chromium/Edge: google-chrome --force-renderer-accessibility &",
    macAutomation:
      "System Settings → Privacy & Security → Automation → allow Skill Recorder for your browser",
    micMac: "System Settings → Privacy & Security → Microphone → allow Skill Recorder",
    micWindows:
      "Settings → Privacy & security → Microphone → allow desktop apps to access your microphone",
    transcriptionDeployment:
      "add your transcription deployment in the connection form (default gpt-4o-transcribe)",
    aiConnection: "open the connection form (Analyze → form) and use Test connection",
    waylandVideo: "the desktop portal will ask you to pick a screen when recording starts",
  });
});

/* --- The copied report ----------------------------------------------------- */

test("renderCompatibilityText carries the level, the expectation and every fix", () => {
  const report = grade({
    activeWindow: {
      ok: false,
      provider: "x11",
      path: null,
      note: "Missing X11 tools — install them with: sudo apt install x11-utils",
    },
    browserUrl: { kind: "atspi", supported: false, note: "needs python3-pyatspi" },
    foundry: {
      configured: false,
      endpoint: null,
      deployment: null,
      source: null,
      describerDeployment: null,
      transcriptionDeployment: null,
    },
  });
  const text = renderCompatibilityText(report);

  assert.match(text, /^Skill Recorder — compatibility check\n/);
  assert.match(text, /Level: Reduced capture/);
  assert.ok(text.includes(report.expectation));
  assert.ok(text.includes(new Date(AT).toISOString()));
  // A pasted report doubles as a remediation checklist: the fixes travel verbatim.
  for (const fix of report.signals.flatMap((s) => (s.fix ? [s.fix] : []))) {
    assert.ok(text.includes(`Fix: ${fix}`), `expected the copied report to include: ${fix}`);
  }
  assert.ok(text.includes(FIXES.x11Utils));
  assert.ok(text.includes(FIXES.pyatspi));
  assert.ok(text.includes(FIXES.aiConnection));
  // Healthy lines are marked too, so a support reader sees what *did* work.
  assert.match(text, /\[ok\] Screen video:/);
  assert.match(text, /\[!!\] Browser URLs:/);
});

test("renderCompatibilityText of a healthy machine names no fixes it doesn't have", () => {
  const text = renderCompatibilityText(grade({}, LIVE_FIREFOX));
  assert.match(text, /Level: Full capture/);
  assert.ok(!text.includes(FIXES.browserAccessibility));
  assert.ok(!text.includes(FIXES.x11Utils));
  assert.ok(!text.includes(FIXES.wayland));
});
