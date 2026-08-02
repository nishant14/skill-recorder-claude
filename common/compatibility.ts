import { DEFAULT_FOUNDRY_TRANSCRIPTION_DEPLOYMENT } from "./foundry";
import type { DoctorReport, MicrophonePermissionState } from "./ipc";

/**
 * The compatibility check: one honest, graded answer to "what will my recordings
 * actually contain on this machine, and what do I type to make them better?".
 *
 * Renderer-safe by construction — no `node:*`, no `electron`, no I/O. Everything here
 * is a pure function of a {@link DoctorReport} plus whatever live probes the main
 * process managed to run, so the whole rubric is unit-testable and the fix strings
 * can't drift between the UI, the copied report, and the docs.
 *
 * Non-goals: this never touches the network (the AI line points at the existing
 * **Test connection** button rather than spending a model call) and it never claims a
 * capability it has no evidence for — an unrun probe grades *down*, not up.
 */

export type CompatibilityLevel = "full" | "good" | "reduced";

/** One graded line of the report. `fix` is the copyable remedy, when one exists. */
export interface CompatibilitySignal {
  key: string;
  label: string;
  ok: boolean;
  /** One sentence, written for the user; safe to render verbatim. */
  detail: string;
  /** The exact command or settings path that repairs this signal. */
  fix?: string;
}

export interface CompatibilityReport {
  level: CompatibilityLevel;
  headline: string;
  /** What to expect from recordings at this level, in one sentence. */
  expectation: string;
  signals: CompatibilitySignal[];
  /** True when a Foundry connection is stored — analysis/building can be attempted. */
  aiReady: boolean;
  /** Epoch ms; supplied by the caller so grading stays pure. */
  checkedAt: number;
}

/** What the live, best-effort probe found. Absent or `checked:false` grades down. */
export interface BrowserA11yProbeResult {
  /** False when the probe could not run at all (wrong platform, no python3, timeout). */
  checked: boolean;
  /**
   * Browsers whose URL the probe **actually read** through the real provider. Being
   * listed on the AT-SPI registry is not enough: snap Firefox publishes its name there
   * and then has its tree reads denied by AppArmor.
   */
  accessibleBrowsers: string[];
  /**
   * Running, readable, and with no page open to read: the address bar was reached and
   * held nothing. Nothing is wrong with the machine — there is just no URL to verify
   * against, which is a Good result with a one-step remedy, not a confinement report.
   */
  noPageOpen: string[];
  /** Running and enumerable, but no address bar was reachable — confined or blocked. */
  presentButUnreadable: string[];
  /**
   * Of the browsers above, those running from a snap (`/proc/<pid>/exe` under `/snap/`).
   * A blocked snap has no fix but a different browser; a blocked deb build usually just
   * needs relaunching with accessibility on, so the two must never share a remedy.
   */
  snapBrowsers: string[];
}

/** Live evidence the main process gathered alongside the doctor report. */
export interface CompatibilityProbes {
  browserA11y?: BrowserA11yProbeResult;
  /** From the shared microphone settings; `unknown` means the OS hasn't been asked. */
  microphonePermission?: MicrophonePermissionState;
}

/* --- The fix catalog ------------------------------------------------------ */

/**
 * Every remedy the report can show, in one place. These strings are pinned by
 * `common/compatibility.test.ts` and quoted in the user guide — changing one is a
 * documentation change, not a copy tweak.
 */
export const FIXES = {
  /** Linux window tracking: the `xprop`/`xwininfo` binaries are absent. */
  x11Utils: "sudo apt install x11-utils",
  /** Linux window tracking: a Wayland compositor exposes no active-window hint. */
  wayland: "Log out and choose “Ubuntu on Xorg” at the login screen",
  /** Linux browser URLs: the AT-SPI Python bindings are absent. */
  pyatspi: "sudo apt install python3-pyatspi",
  /**
   * Linux browser URLs: the bindings work, but no running browser exposes an
   * accessibility tree. Snap Firefox is single-instance, so a plain relaunch keeps
   * the old process alive and the flag has no effect — hence the parenthetical.
   */
  browserAccessibility:
    "Firefox: GNOME_ACCESSIBILITY=1 firefox & (quit it fully first — snap is single-instance) · Chrome/Chromium/Edge: google-chrome --force-renderer-accessibility &",
  /**
   * Linux browser URLs: the browser is running with accessibility on and is visible on
   * the AT-SPI registry, but its reads are denied — snap Firefox's AppArmor profile
   * (`snap.firefox.firefox (enforce)`) allows the name and blocks the tree. No launch
   * flag fixes that, so the remedy is a different build, and the honest consolation is
   * that the recording is still perfectly usable without URLs.
   */
  confinedBrowser:
    "use a non-snap Firefox (Mozilla deb/tar build) or a Chromium-family browser started with --force-renderer-accessibility; titles + frames still identify pages",
  /**
   * Linux browser URLs: an unconfined browser is running and nothing address-bar-like
   * answered. Unlike the snap case this *is* a launch-flag problem — but only a full
   * quit applies it, since a second `google-chrome` joins the running instance and
   * silently drops the flag.
   */
  browserAddressBar:
    "quit the browser completely (every window), then relaunch it — Chrome/Chromium/Edge: google-chrome --force-renderer-accessibility & · Firefox: GNOME_ACCESSIBILITY=1 firefox & — and run this check again",
  /**
   * Linux browser URLs: reads work and the address bar is empty. Nothing to install and
   * nothing to relaunch — a URL can only be verified against a page that is loaded.
   */
  noPageOpen:
    "open any website in the browser, then run the compatibility check again — URLs verify only against a live page",
  /** macOS browser URLs: the per-browser Automation grant was never given or was declined. */
  macAutomation:
    "System Settings → Privacy & Security → Automation → allow Skill Recorder for your browser",
  /** Narration on macOS: the microphone grant. */
  micMac: "System Settings → Privacy & Security → Microphone → allow Skill Recorder",
  /** Narration on Windows: the microphone grant. */
  micWindows:
    "Settings → Privacy & security → Microphone → allow desktop apps to access your microphone",
  /** Narration: a connection exists but names no speech-to-text deployment. */
  transcriptionDeployment: `add your transcription deployment in the connection form (default ${DEFAULT_FOUNDRY_TRANSCRIPTION_DEPLOYMENT})`,
  /** AI: no stored connection, or one that has never been proven to answer. */
  aiConnection: "open the connection form (Analyze → form) and use Test connection",
  /** Video on Wayland: informational — there is nothing for the user to install. */
  waylandVideo: "the desktop portal will ask you to pick a screen when recording starts",
} as const;

export type CompatibilityFixKey = keyof typeof FIXES;

/* --- Level phrasing -------------------------------------------------------- */

const HEADLINES: Record<CompatibilityLevel, string> = {
  full: "Full capture",
  good: "Good capture",
  reduced: "Reduced capture",
};

const EXPECTATIONS: Record<CompatibilityLevel, string> = {
  full: "Expect the richest analyses: app switches, window titles, browser URLs and screen frames.",
  good: "Expect good analyses: pages are identified by window titles and screen frames rather than by URL.",
  reduced:
    "Expect weak analyses of app and web work: only screen video, clipboard and narration are captured.",
};

/* --- Grading --------------------------------------------------------------- */

/**
 * Whether the doctor's window-tracking failure is a Wayland session. The reason
 * string is the only carrier the report has — `linuxCaptureSupport()` writes it and
 * the doctor passes it through untouched — so the match is deliberately loose.
 */
function isWaylandFailure(doctor: DoctorReport): boolean {
  if (doctor.platform !== "linux" || doctor.activeWindow.ok) return false;
  return /wayland/i.test(doctor.activeWindow.note ?? doctor.activeWindow.error ?? "");
}

function windowTrackingSignal(doctor: DoctorReport): CompatibilitySignal {
  const { activeWindow } = doctor;
  if (activeWindow.ok) {
    return {
      key: "windowTracking",
      label: "App & window tracking",
      ok: true,
      detail: `Foreground app and window titles are tracked (${activeWindow.provider}).`,
    };
  }
  const reason = activeWindow.note ?? activeWindow.error ?? "Window tracking is unavailable.";
  const fix = windowTrackingFix(doctor, reason);
  return {
    key: "windowTracking",
    label: "App & window tracking",
    ok: false,
    detail: reason,
    ...(fix ? { fix } : {}),
  };
}

/**
 * Only Linux has a user-applicable remedy: on macOS and Windows a missing provider is
 * a packaging fault, and telling the user to install something would be a lie.
 */
function windowTrackingFix(doctor: DoctorReport, reason: string): string | undefined {
  if (doctor.platform !== "linux") return undefined;
  if (isWaylandFailure(doctor)) return FIXES.wayland;
  if (/x11-utils/i.test(reason)) return FIXES.x11Utils;
  return undefined;
}

/**
 * `firefox` → `Firefox`, `google chrome` → `Google Chrome`. The probe lowercases what
 * AT-SPI and `/proc/<pid>/comm` report so the matching is case-blind, which left
 * multi-word product names reading as "Google chrome" in the user's report.
 */
function displayBrowser(name: string): string {
  return name.replace(/\S+/g, (word) => word[0].toUpperCase() + word.slice(1));
}

/** "Firefox, Chromium" plus the verb and possessive that match the count. */
function browserPhrase(names: readonly string[]): { names: string; is: string; its: string } {
  return {
    names: names.map(displayBrowser).join(", "),
    is: names.length === 1 ? "is" : "are",
    its: names.length === 1 ? "its" : "their",
  };
}

/**
 * The browser-URL line, and the only place the live probe is consulted.
 *
 * The probe is Linux-only: on macOS and Windows the provider's own support flag is the
 * whole answer. On Linux, `supported` means "the pyatspi bindings import" — which says
 * nothing about whether a *browser* is currently exposing its address bar. That is
 * per-launch state (snap Firefox exposes nothing unless started with
 * `GNOME_ACCESSIBILITY=1`), so **Full** requires live evidence: an unrun probe leaves
 * the level at Good with the restart command attached.
 *
 * "Live evidence" means a URL the probe actually **read**, not a browser it merely saw
 * on the AT-SPI registry. Snap Firefox is enumerable and unreadable at the same time
 * (AppArmor allows the name, denies the tree), and grading that as Full is exactly the
 * lie this signal exists to prevent.
 *
 * Below Full the report has to say *which* of three things happened, because the
 * remedies don't overlap: no page open (load one), a confined snap (no flag will help),
 * or an unconfined browser exposing no address bar (quit it fully and relaunch with
 * accessibility on). Guessing "snap confinement" for all three — which the first
 * version did — is wrong for two users out of three.
 */
function browserUrlSignal(
  doctor: DoctorReport,
  probes: CompatibilityProbes,
): CompatibilitySignal {
  const label = "Browser URLs";
  const { browserUrl } = doctor;

  if (doctor.platform !== "linux") {
    if (!browserUrl.supported) {
      return {
        key: "browserUrls",
        label,
        ok: false,
        detail: browserUrl.note ?? "Active-tab URLs are not available on this platform.",
        ...(doctor.platform === "darwin" ? { fix: FIXES.macAutomation } : {}),
      };
    }
    // Supported, but the doctor attached a caveat: on macOS that is the per-browser
    // Automation grant, which the user can repair without losing the capability.
    return {
      key: "browserUrls",
      label,
      ok: true,
      detail: browserUrl.note ?? `Active-tab URLs are read via ${browserUrl.kind}.`,
      ...(browserUrl.note && doctor.platform === "darwin" ? { fix: FIXES.macAutomation } : {}),
    };
  }

  if (!browserUrl.supported) {
    return {
      key: "browserUrls",
      label,
      ok: false,
      detail: browserUrl.note ?? "Browser URL capture needs python3-pyatspi.",
      fix: FIXES.pyatspi,
    };
  }

  const probe = probes.browserA11y;
  if (!probe?.checked) {
    return {
      key: "browserUrls",
      label,
      ok: false,
      detail:
        "python3-pyatspi is installed, but this check could not verify a running browser — start one with:",
      fix: FIXES.browserAccessibility,
    };
  }
  // One browser that answered is the whole case for Full: a sibling that didn't is no
  // reason to withhold a capability we just watched work.
  if (probe.accessibleBrowsers.length > 0) {
    return {
      key: "browserUrls",
      label,
      ok: true,
      detail: `${browserPhrase(probe.accessibleBrowsers).names} — URLs verified by a live read ✓`,
    };
  }

  const idle = probe.noPageOpen ?? [];
  const blocked = probe.presentButUnreadable ?? [];
  if (idle.length === 0 && blocked.length === 0) {
    return {
      key: "browserUrls",
      label,
      ok: false,
      detail: "No running browser is currently accessible — start one with:",
      fix: FIXES.browserAccessibility,
    };
  }

  // Three failures, three remedies. A blank address bar is not confinement, and an
  // unconfined browser that exposes no address bar at all is not confinement either —
  // the first report conflated all of it into a snap message and told a deb Chrome user
  // its "snap confinement" was to blame while the very same provider read its URL fine.
  const snaps = new Set(probe.snapBrowsers ?? []);
  const confined = blocked.filter((name) => snaps.has(name));
  const unexposed = blocked.filter((name) => !snaps.has(name));
  const clauses: string[] = [];
  const fixes: string[] = [];
  if (idle.length > 0) {
    const { names, is } = browserPhrase(idle);
    clauses.push(
      `${names} ${is} running and accessible, but no web page was open to verify a URL read.`,
    );
    // The nearest thing to Full on this machine: one page load away. So it leads the
    // detail and is the *only* remedy offered — the browsers below are still named, but
    // sending someone to relaunch a browser when opening a tab would do is noise.
    fixes.push(FIXES.noPageOpen);
  }
  if (confined.length > 0) {
    const { names, is, its } = browserPhrase(confined);
    clauses.push(
      `${names} ${is} running and accessibility is enabled, but ${its} snap confinement blocks accessibility reads.`,
    );
    if (idle.length === 0) fixes.push(FIXES.confinedBrowser);
  }
  if (unexposed.length > 0) {
    const { names, is } = browserPhrase(unexposed);
    clauses.push(`${names} ${is} running, but accessibility reads found no address bar.`);
    if (idle.length === 0) fixes.push(FIXES.browserAddressBar);
  }
  return {
    key: "browserUrls",
    label,
    ok: false,
    detail: clauses.join(" "),
    fix: fixes.join(" · "),
  };
}

/**
 * Video always works; the Wayland note is informational, so it lives in the detail
 * rather than in `fix` — there is no command to run, and rendering prose as a copyable
 * command would misrepresent it.
 */
function videoSignal(doctor: DoctorReport): CompatibilitySignal {
  const waylandNote = isWaylandFailure(doctor) ? ` — ${FIXES.waylandVideo}` : "";
  return {
    key: "video",
    label: "Screen video",
    ok: true,
    detail: `Low-fps screen video with keyframes is captured${waylandNote}.`,
  };
}

/** The resource host — the part of an endpoint a user recognizes. Never throws. */
function endpointHost(endpoint: string | null): string {
  if (!endpoint) return "configured";
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}

function aiSignal(doctor: DoctorReport): CompatibilitySignal {
  const { foundry } = doctor;
  if (!foundry.configured) {
    return {
      key: "ai",
      label: "AI connection",
      ok: false,
      detail: "No Azure AI Foundry connection — analysis and skill building are unavailable.",
      fix: FIXES.aiConnection,
    };
  }
  const deployments = [
    `builders ${foundry.deployment ?? "—"}`,
    `describer ${foundry.describerDeployment ?? "—"}`,
    `narration ${foundry.transcriptionDeployment ?? "—"}`,
  ].join(" · ");
  return {
    key: "ai",
    label: "AI connection",
    ok: true,
    // Deliberately not proven here: this check never spends a model call.
    detail: `${endpointHost(foundry.endpoint)} · ${deployments} — not tested live by this check.`,
    fix: FIXES.aiConnection,
  };
}

function narrationSignal(
  doctor: DoctorReport,
  probes: CompatibilityProbes,
): CompatibilitySignal {
  const label = "Voice narration";
  if (probes.microphonePermission === "denied") {
    return {
      key: "narration",
      label,
      ok: false,
      detail: "The microphone is blocked for this app, so narration would record silence.",
      ...(doctor.platform === "win32" ? { fix: FIXES.micWindows } : { fix: FIXES.micMac }),
    };
  }
  const { foundry } = doctor;
  if (!foundry.configured) {
    return {
      key: "narration",
      label,
      ok: false,
      detail: "Narration is transcribed by your Foundry deployment, and none is connected.",
      fix: FIXES.aiConnection,
    };
  }
  if (!foundry.transcriptionDeployment) {
    return {
      key: "narration",
      label,
      ok: false,
      detail: "The connection names no speech-to-text deployment, so narration can't be transcribed.",
      fix: FIXES.transcriptionDeployment,
    };
  }
  return {
    key: "narration",
    label,
    ok: true,
    detail: `Narration is transcribed by ${foundry.transcriptionDeployment}.`,
  };
}

/**
 * Grade this machine. Deterministic and side-effect free — `now` is injected so the
 * whole report, timestamp included, is reproducible in tests.
 *
 * The rubric, in one place:
 * - no window tracking ⇒ **reduced** (app/web work can't be reconstructed at all);
 * - window tracking but no live browser URLs ⇒ **good** (titles + frames still carry it);
 * - both ⇒ **full**.
 *
 * The AI and narration lines never move the capture level: they are about *analysis*,
 * and a machine with no connection still records perfectly.
 */
export function gradeCompatibility(
  doctor: DoctorReport,
  probes: CompatibilityProbes = {},
  now: number = Date.now(),
): CompatibilityReport {
  const windowTracking = windowTrackingSignal(doctor);
  const browserUrls = browserUrlSignal(doctor, probes);
  const signals: CompatibilitySignal[] = [
    windowTracking,
    browserUrls,
    videoSignal(doctor),
    aiSignal(doctor),
    narrationSignal(doctor, probes),
  ];

  const level: CompatibilityLevel = !windowTracking.ok
    ? "reduced"
    : browserUrls.ok
      ? "full"
      : "good";

  return {
    level,
    headline: HEADLINES[level],
    expectation: EXPECTATIONS[level],
    signals,
    aiReady: doctor.foundry.configured,
    checkedAt: now,
  };
}

/**
 * The **Copy report** payload: a self-contained remediation checklist. Every fix is
 * reproduced verbatim, so a report pasted into a bug thread tells the reader both what
 * is degraded and exactly what to type.
 */
export function renderCompatibilityText(report: CompatibilityReport): string {
  const lines: string[] = [
    "Skill Recorder — compatibility check",
    `Level: ${report.headline}`,
    report.expectation,
    `Checked: ${new Date(report.checkedAt).toISOString()}`,
    "",
  ];
  for (const signal of report.signals) {
    lines.push(`[${signal.ok ? "ok" : "!!"}] ${signal.label}: ${signal.detail}`);
    if (signal.fix) lines.push(`     Fix: ${signal.fix}`);
  }
  return lines.join("\n");
}
