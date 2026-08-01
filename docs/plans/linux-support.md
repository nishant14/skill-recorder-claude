# Full Linux support (Ubuntu-validated) for Skill Recorder

## Context

Linux is currently an *installable* platform with silently broken capture. The G3(C)
checklist run on the user's Ubuntu X11 machine produced empty recordings and exposed the
whole gap: `get-windows` (sole Linux source of app/window events) is an optional npm dep
that silently fails to install because it compiles a native binding **Linux never uses**
(its Linux path is pure JS shelling to `xprop`); browser URLs have **no Linux provider**
(macOS uses AppleScript, Windows a persistent PowerShell UIA host); the doctor's
capability data is **never rendered** in the UI; and there is no Linux validation doc,
packaging script, package verifier, CI leg, or eval scenario (Windows has all five).
A related product bug was found live: the describer's `list_frames` tool lists only
already-extracted frames, so event-poor sessions ignore the screenshots on disk.

User-decided scope: **full capture parity on X11; honest degradation reporting on
Wayland** (no Wayland window-tracking work); **AT-SPI2 URL provider**; **Ubuntu-validated**
(install.sh's Ubuntu gate stays; other distros best-effort via AppImage). No new npm
dependencies anywhere.

Three phases, each independently landable with its own gate (project G-gate style).
Implementation is delegated to subagents per phase, per CLAUDE.md.

## Phase L1 — Capture correctness + honesty

1. **New `electron/collectors/linux-active-window.ts`** — in-repo X11 provider replacing
   `get-windows` on Linux (~120 lines; `get-windows` becomes macOS-only):
   - `readLinuxActiveWindow()`: `xprop -root _NET_ACTIVE_WINDOW` → `xprop -id` (title from
     `_NET_WM_NAME`→`WM_NAME`, `owner.name` = **last** WM_CLASS string, pid from
     `_NET_WM_PID`, path via `/proc/<pid>/exe`) + `xwininfo -id` for bounds, in parallel;
     own ~25-line octal-escape decoder; every exec ~800ms timeout; failure ⇒ `undefined`,
     never throws. Injectable exec function for offline tests.
   - `linuxCaptureSupport()`: session (`XDG_SESSION_TYPE`/`WAYLAND_DISPLAY`/`DISPLAY`) +
     cached xprop/xwininfo presence probe → `{ ok, reason }` with user-facing reasons
     ("install x11-utils…", "Wayland session — log in with 'Ubuntu on Xorg'").
2. **`electron/collectors/active-window.ts`** — add the linux branch in `readPlatform()`
   (:113-120, get-windows import becomes darwin-only); restrict the misleading
   "Reduced capture … permission" degraded-retry (:126-134) to darwin; add a
   persistent-`undefined` watchdog (one warn after ~10 empty polls, using
   `linuxCaptureSupport().reason` on Linux) closing the no-log silent path (:141-142).
3. **Doctor honesty** — `common/ipc.ts`: `ActiveWindowInfo.provider` += `"x11"`, add
   `note?`; `BrowserUrlInfo` add `note?` (types only — no new IPC channels).
   `electron/doctor.ts`: Linux `checkActiveWindow()` uses `linuxCaptureSupport()` (not
   `require.resolve("get-windows")`); `sourceSupport()` marks appActivity/windowTitles
   unsupported with notes on Wayland/missing-tools.
4. **`src/Recorder.tsx`** (:514-523) — render the capability rows that exist but are never
   shown: one row per unsupported/degraded source from `doctor.activeSources` + window
   tracking + browser URLs when not ok (reuse the existing `Row` component). All
   platforms benefit.
5. **Video** — `electron/main.ts`: on Linux append `enable-features=WebRTCPipeWireCapturer`
   before ready (inert on X11; enables portal capture on Wayland; single-line revert if
   live smoke shows issues). Wayland-aware zero-source message in
   `electron/video/recorder.ts` (:161-164). Wayland global-shortcut warn text in main.ts.
   Known limitation (docs only): `setContentProtection` no-op ⇒ HUD visible in recordings.
6. **`list_frames` fix** — `electron/frames/extractor.ts`: expose the source-frame
   inventory (loaded from `video-frames.json`); `electron/describer/tools.ts`:
   `list_frames` returns `{ hasVideo, capturedFrameCount, capturedRangeMs, frames:
   [retained…] }` + description update so the model calls `get_frames` even before any
   retention.
7. **Tests** (append to the explicit `test` list in `package.json`):
   `electron/collectors/linux-active-window.test.ts` (xprop/xwininfo parsing, escapes,
   support matrix, injected exec), `electron/doctor.test.ts` (linux branches),
   `electron/describer/tools.test.ts` (list_frames with source frames + empty manifest).

**Gate GL1** — unit+typecheck green; live on this X11 machine (record Firefox↔terminal:
`events.jsonl` has `app.activate`/`app.title-change`; doctor clean) and a Wayland session
(honest degradation rows, no misleading warns); CI's existing get-windows check gated to
macOS.

## Phase L2 — AT-SPI2 browser URL provider

1. **New `electron/collectors/linux-url-provider.ts`** — structural copy of
   `windows-url-provider.ts` (:161-286): persistent host, tmpdir script, READY handshake,
   request/response lines (SEP=ASCII 30), 2000ms timeout kills+recycles, `dispose()`.
   Deliberately not refactored into a shared base (don't destabilize Windows; note a
   future `host-provider.ts` extraction). Deltas:
   - Host = `python3 -u` + embedded **pyatspi** script (Ubuntu ships `python3-pyatspi`;
     zero npm deps). `import pyatspi` failure ⇒ exits pre-READY ⇒ all reads null.
   - Request carries the app hint (`get <wmClassToken>`): match desktop apps loosely,
     pick `STATE_ACTIVE` frame, bounded BFS ≤600 nodes depth ≤8 pruning
     `ROLE_DOCUMENT_WEB`, find `ROLE_ENTRY` with address-bar name patterns, read value.
   - `supports()` via `LINUX_BROWSER_TOKENS` (firefox, navigator, chrome, chromium,
     edge, brave, opera, vivaldi — WM_CLASS spellings).
   - Extract `normalizeUrl` from windows-url-provider (:150-159) into a shared helper;
     both providers import it.
2. **`url-provider.ts`** — `createUrlProvider()` returns the Linux provider;
   `browserUrlProviderKind` gains static kind `"atspi"` (availability is the probed
   dimension, kept separate).
3. **Doctor** — `BrowserUrlInfo.kind` += `"atspi"`; Linux `checkBrowserUrl()` runs a
   module-cached `python3 -c "import pyatspi"` probe; missing ⇒ note naming the apt
   package. Chromium's `--force-renderer-accessibility` need is a docs/doctor note, not
   forced.
4. **Tests**: `electron/collectors/linux-url-provider.test.ts` — protocol against fake
   `node -e` helper processes (READY+reply, garbage, never-READY, hang→timeout→recycle,
   dispose cleanup), token mapping, injectable helper command; `browserUrlProviderKind`
   + shared `normalizeUrl` cases; doctor probe branches.

**Gate GL2** — unit green; live on this machine: Firefox 3-site `browser.url` capture;
Chromium with/without the a11y flag (graceful null without); host-kill recovery;
pyatspi-uninstalled honest note. Full browser e2e stays human-run (repo convention).

## Phase L3 — Packaging, CI, install, validation docs

Sequencing: L1/L2 collide with nothing pending. L3's verifier must not enshrine payloads
Workstream E deletes — **derive the expected-payload manifest from package.json at verify
time** (copilot/onnx/transformers required only while still dependencies, forbidden
after). Prefer landing L3 after E; the conditional manifest makes either order safe.

1. **package.json** — `build.linux`: add `icon`, `artifactName`
   (`…-linux-${arch}.${ext}`), `maintainer`/`synopsis`/`desktop` (incl. `StartupWMClass`),
   `files` excluding `get-windows`; new `dist:linux:x64` script (+
   `scripts/assert-native-linux-arch.mjs` mirroring the Windows asserter). arm64 deferred.
2. **New `scripts/verify-linux-package.mjs`** — mirrors verify-windows-package.mjs with
   ELF `e_machine` checks (magic `\x7fELF`, offset 18 LE, 0x3e=x86-64) on the executable,
   `libffmpeg.so`, and every native payload; conditional payload manifest (sharp-linux,
   koffi prebuild, conditional onnx/copilot/transformers); wrong-arch/foreign-platform
   rejection; ffmpeg ban; notices + compliance dir; asserts `get-windows` absent.
3. **CI `non-windows.yml` ubuntu leg** — apt `x11-utils desktop-file-utils xvfb
   python3-pyatspi at-spi2-core dbus`; `desktop-file-validate` on the install.sh-generated
   entry; `xvfb-run` check that `readLinuxActiveWindow()` resolves (crash-free xprop
   round-trip; window-spawn assertion only if proven stable); `python3 -m py_compile` on
   the AT-SPI helper; new `package-linux` job: `dist:linux:x64` +
   `verify-linux-package.mjs` (mirrors windows.yml:85-95).
4. **install.sh** (Ubuntu gate stays) — require x11-utils (reuse the existing
   missing-libraries mechanism ~:330), warn-only python3-pyatspi check; `.desktop` gets
   the real app icon (copy `build/icon.png`; currently generic stock icon at :424-444) +
   `StartupWMClass` + `desktop-file-validate` when present.
5. **Docs** — new `LINUX-VALIDATION.md` (WINDOWS-VALIDATION.md structure; known
   limitations: Wayland window tracking, HUD-in-recording, Chromium a11y flag, Wayland
   shortcuts) and `docs/linux-capture.md` (windows-capture.md structure; 8-step live
   smoke tied to `events.jsonl` names); update `docs/windows-capture.md:3` scope line,
   `README.md:45-46`, `INSTALL.md`, `RELEASING.md:87-88`, CLAUDE.md platform gotcha; new
   `evals/scenarios/linux-deploy.ts` mirroring windows-deploy.ts.

**Gate GL3** — CI: AppImage builds + verifier passes + desktop-file-validate clean; live:
clean-Ubuntu install.sh run (icon/launcher correct), packaged 8-step smoke, best-effort
AppImage run on one non-Ubuntu distro (documented, non-blocking).

## Key reuse (no new patterns)

`windows-url-provider.ts` host pattern; `windows-active-window.ts` module shape;
`CollectorHost` try/catch registration; doctor `sourceSupport` notes;
`verify-windows-package.mjs` structure; `Row` component in Recorder.tsx; existing
`install.sh` verification mechanisms.

## Risks

- WM_CLASS names differ from macOS display names — keep raw truth in events; L2 token
  list handles matching; no normalization layer.
- AT-SPI heuristics vary by browser/locale — same accepted risk as the Windows UIA
  provider; bounded BFS + best-candidate fallback + live gate; contract is best-effort
  null. Plan-B: raw D-Bus via python3-gi with the same protocol.
- XWayland partial tracking — doctor reports Wayland as unsupported (honesty beats
  false precision); collector still emits what it sees.
- PipeWire flag on X11 — believed inert; verified in GL1 live; one-line revert.
- AppImage sandbox quirks on non-Ubuntu — documented, non-blocking (Ubuntu-validated
  scope).

## Verification summary

Every phase: `npm run typecheck` + `typecheck:evals` + `npm test` (new files added to the
explicit test list) offline; a live gate on this Ubuntu X11 machine (GL1/GL2) and a
Wayland session check (GL1); CI packaging gate (GL3). The user's original failing
scenario — record Firefox activity, Analyze — becomes the acceptance test: it must
produce a real analysis with app switches, titles, URLs (L2), and frames.
