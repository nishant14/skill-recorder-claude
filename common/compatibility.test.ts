import assert from "node:assert/strict";
import test from "node:test";

import {
  FIXES,
  gradeCompatibility,
  renderCompatibilityText,
  type BrowserA11yProbeResult,
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

/**
 * A probe result with every bucket present, so each case fills in only the one it is
 * about. The buckets are exclusive: a browser lands in exactly one of read / no page
 * open / unreadable, and `snapBrowsers` tags whichever of those are snaps.
 */
function a11y(partial: Partial<BrowserA11yProbeResult> = {}): BrowserA11yProbeResult {
  return {
    checked: true,
    accessibleBrowsers: [],
    noPageOpen: [],
    presentButUnreadable: [],
    snapBrowsers: [],
    ...partial,
  };
}

const LIVE_FIREFOX: CompatibilityProbes = {
  browserA11y: a11y({ accessibleBrowsers: ["firefox"] }),
};

/* --- Level rubric ---------------------------------------------------------- */

test("Full needs window tracking plus a browser whose URL was actually read", () => {
  const report = grade({}, LIVE_FIREFOX);
  assert.equal(report.level, "full");
  assert.equal(report.headline, "Full capture");
  assert.match(report.expectation, /richest analyses/);
  assert.equal(signal(report, "browserUrls").ok, true);
  // Not "is exposing accessibility": the registry can say yes while every read fails.
  assert.equal(
    signal(report, "browserUrls").detail,
    "Firefox — URLs verified by a live read ✓",
  );
  assert.equal(signal(report, "browserUrls").fix, undefined);
  assert.equal(report.checkedAt, AT);
});

test("several accessible browsers are named together", () => {
  const report = grade({}, { browserA11y: a11y({ accessibleBrowsers: ["firefox", "chromium"] }) });
  assert.equal(
    signal(report, "browserUrls").detail,
    "Firefox, Chromium — URLs verified by a live read ✓",
  );
  assert.equal(report.level, "full");
});

test("a multi-word browser name is title-cased, not sentence-cased", () => {
  // The probe lowercases AT-SPI's "Google Chrome" so its matching is case-blind; the
  // user's report then read "Google chrome — URLs verified by a live read ✓".
  const report = grade({}, { browserA11y: a11y({ accessibleBrowsers: ["google chrome"] }) });
  assert.equal(
    signal(report, "browserUrls").detail,
    "Google Chrome — URLs verified by a live read ✓",
  );
  const blocked = grade({}, { browserA11y: a11y({ noPageOpen: ["google chrome"] }) });
  assert.match(signal(blocked, "browserUrls").detail, /^Google Chrome is running/);
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
  const report = grade({}, { browserA11y: a11y() });
  assert.equal(report.level, "good");
  assert.equal(
    signal(report, "browserUrls").detail,
    "No running browser is currently accessible — start one with:",
  );
  assert.equal(signal(report, "browserUrls").fix, FIXES.browserAccessibility);
});

test("a confined snap that enumerates but can't be read grades Good, and says why", () => {
  // The snap-Firefox truthfulness bug: AppArmor lets the name onto the AT-SPI registry
  // and denies the tree reads, so a presence-only probe reported Full while the
  // recording captured zero browser.url events. Presence is not readability.
  const report = grade(
    {},
    { browserA11y: a11y({ presentButUnreadable: ["firefox"], snapBrowsers: ["firefox"] }) },
  );
  assert.equal(report.level, "good");
  assert.equal(signal(report, "browserUrls").ok, false);
  assert.equal(
    signal(report, "browserUrls").detail,
    "Firefox is running and accessibility is enabled, but its snap confinement blocks accessibility reads.",
  );
  // The launch-flag fix would send the user round a loop that can't end in URLs.
  assert.equal(signal(report, "browserUrls").fix, FIXES.confinedBrowser);
});

test("several blocked snaps are named together, in the plural", () => {
  const report = grade(
    {},
    {
      browserA11y: a11y({
        presentButUnreadable: ["firefox", "chromium"],
        snapBrowsers: ["firefox", "chromium"],
      }),
    },
  );
  assert.equal(
    signal(report, "browserUrls").detail,
    "Firefox, Chromium are running and accessibility is enabled, but their snap confinement blocks accessibility reads.",
  );
});

test("a non-snap browser with no reachable address bar is not blamed on confinement", () => {
  // The live regression: a deb Chrome (`/opt/google/chrome/chrome`) that reads fine was
  // told its "snap confinement" was the problem. Nothing here is confined, and unlike a
  // snap this one *does* have a launch-flag remedy.
  const report = grade({}, { browserA11y: a11y({ presentButUnreadable: ["google chrome"] }) });
  assert.equal(report.level, "good");
  assert.equal(
    signal(report, "browserUrls").detail,
    "Google Chrome is running, but accessibility reads found no address bar.",
  );
  assert.equal(signal(report, "browserUrls").fix, FIXES.browserAddressBar);
  assert.ok(!signal(report, "browserUrls").detail.includes("snap"));
});

test("a blocked snap and a blocked deb build each keep their own sentence and remedy", () => {
  const report = grade(
    {},
    {
      browserA11y: a11y({
        presentButUnreadable: ["firefox", "google chrome"],
        snapBrowsers: ["firefox"],
      }),
    },
  );
  assert.equal(
    signal(report, "browserUrls").detail,
    "Firefox is running and accessibility is enabled, but its snap confinement blocks accessibility reads. " +
      "Google Chrome is running, but accessibility reads found no address bar.",
  );
  assert.equal(
    signal(report, "browserUrls").fix,
    `${FIXES.confinedBrowser} · ${FIXES.browserAddressBar}`,
  );
});

test("one readable browser carries Full even when another is blocked or idle", () => {
  // Evidence of a working read is what the level is about; the blocked sibling is not
  // a reason to withhold a capability we just watched work.
  const report = grade(
    {},
    {
      browserA11y: a11y({
        accessibleBrowsers: ["chromium"],
        noPageOpen: ["google chrome"],
        presentButUnreadable: ["firefox"],
        snapBrowsers: ["firefox"],
      }),
    },
  );
  assert.equal(report.level, "full");
  assert.equal(signal(report, "browserUrls").detail, "Chromium — URLs verified by a live read ✓");
  assert.equal(signal(report, "browserUrls").fix, undefined);
});

/* --- Nothing open to read -------------------------------------------------- */

test("an accessible browser with no page open grades Good and asks for a website", () => {
  // Measured: deb Chrome on the new tab page — 266 a11y nodes, address bar found by
  // role and name, and genuinely empty. Readable, no page, nothing to fix but the tab.
  const report = grade({}, { browserA11y: a11y({ noPageOpen: ["google chrome"] }) });
  assert.equal(report.level, "good");
  assert.equal(signal(report, "browserUrls").ok, false);
  assert.equal(
    signal(report, "browserUrls").detail,
    "Google Chrome is running and accessible, but no web page was open to verify a URL read.",
  );
  assert.equal(signal(report, "browserUrls").fix, FIXES.noPageOpen);
});

test("no page open leads the detail over a blocked browser, and both are named", () => {
  // Precedence: the browser that is one page load away from Full is the one to talk to
  // first — but a user with a confined Firefox still needs to know why it never answers.
  const report = grade(
    {},
    {
      browserA11y: a11y({
        noPageOpen: ["google chrome"],
        presentButUnreadable: ["firefox"],
        snapBrowsers: ["firefox"],
      }),
    },
  );
  assert.equal(report.level, "good");
  assert.equal(
    signal(report, "browserUrls").detail,
    "Google Chrome is running and accessible, but no web page was open to verify a URL read. " +
      "Firefox is running and accessibility is enabled, but its snap confinement blocks accessibility reads.",
  );
  assert.equal(signal(report, "browserUrls").fix, FIXES.noPageOpen);
});

test("an unrun probe never claims Full — it grades from the static signals only", () => {
  // linux + X11 + pyatspi importable, but nothing could be verified live. Whether a
  // browser exposes its address bar is per-launch state, so Full would be a guess.
  for (const probes of [{}, { browserA11y: a11y({ checked: false }) }]) {
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
    { browserA11y: a11y({ presentButUnreadable: ["firefox"], snapBrowsers: ["firefox"] }) },
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
    confinedBrowser:
      "use a non-snap Firefox (Mozilla deb/tar build) or a Chromium-family browser started with --force-renderer-accessibility; titles + frames still identify pages",
    browserAddressBar:
      "quit the browser completely (every window), then relaunch it — Chrome/Chromium/Edge: google-chrome --force-renderer-accessibility & · Firefox: GNOME_ACCESSIBILITY=1 firefox & — and run this check again",
    noPageOpen:
      "open any website in the browser, then run the compatibility check again — URLs verify only against a live page",
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
  assert.ok(!text.includes(FIXES.confinedBrowser));
  assert.ok(!text.includes(FIXES.x11Utils));
  assert.ok(!text.includes(FIXES.wayland));
});

test("a copied report of a confined browser carries the confinement remedy", () => {
  const text = renderCompatibilityText(
    grade(
      {},
      { browserA11y: a11y({ presentButUnreadable: ["firefox"], snapBrowsers: ["firefox"] }) },
    ),
  );
  assert.match(text, /Level: Good capture/);
  assert.match(text, /\[!!\] Browser URLs: Firefox is running and accessibility is enabled/);
  assert.ok(text.includes(`Fix: ${FIXES.confinedBrowser}`));
  assert.ok(!text.includes(FIXES.browserAccessibility));
});

test("a copied report of an idle browser carries the open-a-website remedy", () => {
  const text = renderCompatibilityText(
    grade({}, { browserA11y: a11y({ noPageOpen: ["google chrome"] }) }),
  );
  assert.match(text, /Level: Good capture/);
  assert.match(text, /\[!!\] Browser URLs: Google Chrome is running and accessible/);
  assert.ok(text.includes(`Fix: ${FIXES.noPageOpen}`));
  // Neither of the other two remedies applies, and printing them would be noise.
  assert.ok(!text.includes(FIXES.confinedBrowser));
  assert.ok(!text.includes(FIXES.browserAddressBar));
});
