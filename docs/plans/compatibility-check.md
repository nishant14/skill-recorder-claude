# Compatibility check — clickable, graded "what to expect" report

## Context

Testing exposed the gap: capture capability varies by platform, session type (X11 vs
Wayland), installed tools (`x11-utils`, `python3-pyatspi`), and **per-launch browser
state** (snap Firefox exposes no AT-SPI tree unless started with
`GNOME_ACCESSIBILITY=1` — which cost a recording's URL trail and degraded an analysis).
Today the app only shows passive warning rows when something is wrong, and nothing
checks the live browser state at all. The feature: a **"Check compatibility" button**
in the Recorder that runs the existing doctor plus a few live local probes and returns
a **graded level with expected-outcome phrasing and exact fixes**. Reuses: `runDoctor()`
(`electron/doctor.ts`), `linuxCaptureSupport()` (`electron/collectors/
linux-active-window.ts`), the pyatspi probe (`linuxUrlSupport` in
`linux-url-provider.ts`), the `Row` UI components + `CaptureHealthRows`
(`src/Recorder.tsx`), and the four-places IPC rule.

## Grading model (deterministic, honest)

Capture level (about recordings), AI-readiness listed separately (about analysis):

| Level | Condition | "What to expect" phrasing |
|---|---|---|
| **Full** | window tracking ok **and** browser URLs live-available | richest analyses: apps, titles, URLs, frames |
| **Good** | window tracking ok, URLs unavailable (platform, missing pyatspi, or **no currently-accessible browser**) | pages identified by window titles + screen frames; the fix hint names the exact command (`GNOME_ACCESSIBILITY=1 firefox`, `--force-renderer-accessibility`, or `apt install python3-pyatspi`) |
| **Reduced** | no window tracking (Wayland session, or `x11-utils` missing) | video + clipboard + narration only; analyses of app/web work will be weak; fix = "log in with Ubuntu on Xorg" / install command |

Separate lines: **AI connection** (configured + which three deployments; points at the
existing Test connection button rather than auto-spending a model call), **narration**
(transcription deployment resolved), **video** (Wayland portal note when relevant).
macOS/Windows grade Full/Good from the same signals.

## The fix catalog (every degraded signal ships its remedy, copyable)

All fix strings live in ONE place — `common/compatibility.ts` — and are unit-pinned so
they can't drift from the docs. Each degraded signal renders its fix as copyable
`code` in the report:

| Degraded signal | Fix shown to the user |
|---|---|
| Window tracking: `xprop`/`xwininfo` missing (Linux) | `sudo apt install x11-utils` |
| Window tracking: Wayland session (Linux) | "Log out and choose **Ubuntu on Xorg** at the login screen" |
| Browser URLs: `python3-pyatspi` missing (Linux) | `sudo apt install python3-pyatspi` |
| Browser URLs: pyatspi present but **no running browser exposes accessibility** (the live-probe finding) | Firefox: `GNOME_ACCESSIBILITY=1 firefox &` (quit it fully first — snap is single-instance) · Chrome/Chromium/Edge: `google-chrome --force-renderer-accessibility &` |
| Browser URLs: browser running *without* the flag detected | same commands, phrased "restart your browser with:" |
| Browser URLs (macOS): Automation grant missing/declined | "System Settings → Privacy &amp; Security → Automation → allow Skill Recorder for your browser" |
| Narration: mic permission (macOS/Windows) | the OS settings path per platform |
| Narration: transcription deployment unresolved | "add your transcription deployment in the connection form (default `gpt-4o-transcribe`)" |
| AI connection: not configured / untested | "open the connection form (Analyze → form) and use **Test connection**" |
| Video (Wayland) | note: "the desktop portal will ask you to pick a screen when recording starts" — informational, no action |

The **Copy report** output includes the fixes verbatim, so a pasted report doubles as a
self-contained remediation checklist.

## Implementation

1. **`common/compatibility.ts`** (new, pure): `CompatibilityLevel = "full" | "good" |
   "reduced"`, `CompatibilitySignal { key, label, ok, detail, fix? }`,
   `CompatibilityReport { level, headline, expectation, signals[], aiReady,
   checkedAt }`, and `gradeCompatibility(doctor: DoctorReport, probes: { browserA11y?:
   { checked: boolean; accessibleBrowsers: string[] } }): CompatibilityReport` — pure,
   fully unit-tested, single source of the level rubric and every fix string.
2. **Live browser-accessibility probe (Linux, X11 + pyatspi only)** — new
   `electron/collectors/linux-a11y-probe.ts`: one-shot `python3 -c` (pyatspi) listing
   desktop app names, matched against `LINUX_BROWSER_TOKENS` (exported by
   `linux-url-provider.ts`); 2s timeout; injectable exec seam like
   `linux-active-window.ts`; failure ⇒ `{ checked: false }` (grade falls back to
   static signals — never blocks the report). This is the check that would have caught
   the snap-Firefox miss *before* recording.
3. **IPC (four places)**: channel `compatibility:check`, API
   `checkCompatibility(): Promise<CompatibilityReport>` — handler = `runDoctor()` +
   the probe (linux only) + `gradeCompatibility(...)`. The passive doctor tile is
   untouched.
4. **`src/Recorder.tsx`**: a **Check compatibility** affordance in the readiness panel →
   on click, an expandable report: level badge (Full/Good/Reduced with color), the
   expectation sentence, per-signal rows (reuse `Row` styling) with fix hints rendered
   as copyable `code`, the live-browser line ("Firefox is exposing accessibility ✓" /
   "no running browser is currently accessible — start one with: …"), and a
   **Copy report** button (plain-text version to clipboard, for support/bug reports).
   Re-runnable; shows `checkedAt`.
5. **Docs**: user-guide §3 gains one line ("click Check compatibility to see the level
   to expect and the exact fixes"); testbed guide Part 0 adds "run Check compatibility
   — proceed when it reports Full (or Good if you're accepting the no-URL path)";
   tracker note in `progress.md`.
6. **Tests** (append to the explicit list): `common/compatibility.test.ts` — grading
   matrix across platform/session/tool/probe combinations, exact fix strings, level
   boundaries (URL-unavailable ⇒ Good not Reduced; Wayland ⇒ Reduced even if xprop
   exists); `electron/collectors/linux-a11y-probe.test.ts` — output parsing, token
   matching, timeout/failure ⇒ `{checked:false}`, exec-seam injected.

## Sequencing

One subagent stage (core + probe + IPC + UI + tests), then docs + tracker close-out.
No collisions with pending work (Workstream P hasn't started).

## Verification

Offline: full suite green with the two new files. Live on this machine (X11): click the
check with plain Firefox running → **Good** with the `GNOME_ACCESSIBILITY=1` fix hint;
relaunch Firefox with the flag → re-run → **Full** with "Firefox is exposing
accessibility" (this doubles as the GL2 snap-Firefox experiment). If a Wayland session
is available: expect **Reduced** with the Xorg hint. macOS/Windows behavior is
unit-covered by the grading matrix; no regression to the passive doctor tile.
