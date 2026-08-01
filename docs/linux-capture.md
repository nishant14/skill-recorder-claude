# Linux event capture

Skill Recorder is cross platform (macOS + Windows + Ubuntu Linux). The core (recorder
controller, event bus, session store, collector host, capture tiers, describer, skill
builder) is platform agnostic. This doc covers the parts that are OS specific: how each
event source behaves on Linux, how to set it up, and a live smoke test to run before
trusting a Linux build.

Scope is **Ubuntu on an X11 session**. See
[`LINUX-VALIDATION.md`](../LINUX-VALIDATION.md) for the validated matrix and the
Wayland story.

## What captures what on Linux

| Source | Mechanism on Linux | Parity vs macOS | Permission |
|--------|--------------------|-----------------|------------|
| App switches | `xprop -root _NET_ACTIVE_WINDOW` → `xprop -id` (`x11-utils`) | Full on X11; none on Wayland | None |
| Window titles | `xprop -id` (`_NET_WM_NAME` → `WM_NAME`) | Full on X11; none on Wayland | None |
| Window bounds | `xwininfo -id` (`x11-utils`) | Full on X11 | None |
| Browser URLs | AT-SPI2 accessibility tree via a persistent `python3` + `pyatspi` host | Best effort, not byte exact | Browser accessibility must be on |
| Clipboard | Electron clipboard | Full | None |
| Screen video + frames | `desktopCapturer` + Chromium snapshots + Sharp | Full on X11 | None on X11; portal prompt on Wayland |
| Voice narration (opt-in) | hidden-window `getUserMedia` + `MediaRecorder`; Chromium decode, then the Azure AI Foundry transcription deployment | Full | Microphone |

Notes:

- **App switches and window titles** come from the in-repo provider
  `electron/collectors/linux-active-window.ts`, not from `get-windows`. That package's
  Linux path is itself pure JavaScript shelling out to `xprop`, but it compiles a
  native macOS binding at install time, so on Linux it silently failed to install and
  capture produced nothing. `owner.name` is the **last** `WM_CLASS` string (e.g.
  `Xfce4-terminal`, `firefox_firefox`, `Code`), which is the raw X11 truth and does not
  match macOS display names. The process id comes from `_NET_WM_PID` and the executable
  path from `/proc/<pid>/exe`. Every exec has an ~800 ms timeout; any failure resolves
  `undefined` and never throws.
- **Browser URLs** read the address bar out of the **AT-SPI2** accessibility tree
  (`electron/collectors/linux-url-provider.ts`), not the exact active tab URL the macOS
  AppleScript provider gets — the same best-effort contract as the Windows UI
  Automation provider. The host is a persistent `python3 -u` process running an
  embedded `pyatspi` script (Ubuntu's stock `python3-pyatspi`; **zero npm
  dependencies**). It answers one request line per read with a 2000 ms timeout, after
  which the host is killed and recycled. No `pyatspi`, no host, no URLs — never a
  crash. Values that look like a search term are dropped rather than emitted as noise.
- **Wayland** is detected via `XDG_SESSION_TYPE` / `WAYLAND_DISPLAY` (not `DISPLAY`,
  which XWayland also sets) and reported as unsupported for window tracking.

## Prerequisites

1. **`x11-utils` (required).** Provides `xprop` and `xwininfo`. Without them there are
   no app or window events at all.

   ```sh
   sudo apt install x11-utils
   ```

   `install.sh` fails with this message rather than installing a build that cannot
   capture.
2. **`python3-pyatspi` (optional, for browser URLs).**

   ```sh
   sudo apt install python3-pyatspi at-spi2-core
   ```

   Without it, URL capture is disabled and the doctor says so; everything else works.
   `install.sh` warns rather than failing.
3. **An X11 session.** Log out and choose **Ubuntu on Xorg** at the login screen if the
   doctor reports a Wayland session.
4. **Browser accessibility.** Snap Firefox needs `GNOME_ACCESSIBILITY=1` set *at
   launch*; Chromium needs `--force-renderer-accessibility`.
5. **An Azure AI Foundry connection** (endpoint + API key + deployments) for the
   describer, the builders, and narration transcription. Configured in the app or in
   `~/.skill-recorder/foundry.json`; nothing is installed on `PATH`.
6. No system media package is needed for new recordings.

## Doctor signals

Open the recorder HUD and read the doctor rows (or call `doctor()` over IPC). On
Linux, confirm:

- **window tracking** = `x11` (not `provider missing`). When it is not ok, the row's
  note is one of:
  - "Wayland session — app and window tracking needs X11. Log out and pick “Ubuntu on
    Xorg” at the login screen."
  - "No X11 display found (DISPLAY is not set)."
  - "Missing X11 tools — install them with: sudo apt install x11-utils"
- **browser URLs** = `atspi` when the capture level includes URLs. If `python3-pyatspi`
  is missing, the note names the apt package.

Unsupported or degraded sources are rendered as capability rows in the HUD; you should
never have to read a log to find out a source is dead.

## Live smoke test

Run a real recording on Ubuntu (X11) and verify each source lands in the session's
`events.jsonl`. Set the capture level to **Full** first so every source is on.

1. **Start** capture from the HUD (or `Ctrl+Shift+R`). If the shortcut does not
   register, check the main-process log for the Wayland warning.
2. **App switches / titles.** Alt-Tab between two apps (e.g. Firefox and a terminal).
   Expect `app.activate` events whose `owner.name` is the `WM_CLASS` token
   (`firefox_firefox`, `Xfce4-terminal`, `Code`, …) and `app.title-change` as titles
   change. Confirm `owner.path` resolves to something like `/usr/bin/xfce4-terminal`.
3. **Browser URLs.** In Firefox, navigate to three different sites. Expect
   `browser.url` events with the address bar URL and `host`. Typing a partial URL or a
   search term should not emit a bogus event. Repeat in Chromium started with
   `--force-renderer-accessibility`.
4. **Host recovery.** `pkill -f atspi` (or kill the `python3` helper) mid-recording,
   then navigate again. A new URL must appear within a few seconds; the recording must
   not stop.
5. **Clipboard.** Copy some text. Expect a `clipboard.change` event with a preview and
   hash.
6. **Video.** Confirm `video.webm`, `video-frames.json`, snapshots under
   `video-frames/`, and retained images under `frames/`. The floating controls bar
   **will** be visible in these — see the limitation below.
7. **Voice narration.** Turn on **Narrate**, grant microphone access, and select an
   input. Speak before and after switching inputs, then confirm `audio.json` contains
   separate version-2 segments with `narrationLanguage`. Confirm `narration.json`
   records the chosen language with `atMs` offsets.
8. **Stop and analyze.** The recording should show up in the library as `recorded`, and
   analysis should produce a coherent intent plus ordered steps naming the apps, titles,
   and URLs from steps 2 and 3.

If a source produces nothing, check its doctor row first, then the main process log for
the one-time warnings (e.g. the persistent-`undefined` watchdog, which prints the
`linuxCaptureSupport()` reason after roughly ten empty polls).

## Packaging

`package.json` configures electron-builder for macOS, Windows NSIS, and a Linux
AppImage. Native modules (`koffi`, `@koromix/*`, `sharp`, `@img/*`) are listed under
`asarUnpack` so their binaries load from disk rather than from inside the asar archive.
`build.linux.files` additionally excludes `node_modules/get-windows/**`, which Linux does
not use. No speech model ships or downloads: narration is transcribed by the user's Azure
AI Foundry deployment, and `scripts/verify-linux-package.mjs` derives its payload
manifest from `package.json`, so a reintroduced `@github/copilot*`, `@huggingface/*`, or
`onnxruntime*` payload fails the build.

Build the AppImage on a native x64 Linux machine or CI runner so npm selects the
correct optional packages:

```sh
npm ci
npm run dist:linux:x64
node scripts/verify-linux-package.mjs x64
```

The `package-linux` job in `.github/workflows/non-windows.yml` runs exactly this on
`ubuntu-latest` and verifies the ELF architecture and packaged native payloads. ARM64
Linux packaging is deferred.

## Known limitations

- Wayland window tracking is not supported and is reported as such; there is no
  partial-XWayland mode.
- The recording controls HUD appears in captured video and frames: Electron's
  `setContentProtection` is a no-op on Linux.
- Browser URLs are best-effort accessibility strings, not the exact tab URL, and they
  depend on browser accessibility being enabled (`GNOME_ACCESSIBILITY=1` for snap
  Firefox, `--force-renderer-accessibility` for Chromium).
- `WM_CLASS` tokens are not display names. Events keep the raw value; there is no
  normalization layer.
- Terminal capture is not currently implemented; a recorded-terminal (PTY) approach is
  tracked in issue #7.
- Semantic UI events (focus/invoke/value) are not implemented on any platform yet.
- Narration transcription is a network call to the user's Azure AI Foundry deployment, so
  it needs no local model, no compiler, and no offline path.
- A standalone system FFmpeg is consulted only for frame extraction from recordings
  created before `video-frames.json` existed. It is never bundled or downloaded;
  Electron's standard LGPL `libffmpeg.so` codec component remains in the runtime.
- The Linux paths are also validated by typecheck, unit tests for the X11 and AT-SPI
  providers, a `python3 -m py_compile` of the AT-SPI helper script, and a `linux`
  describer eval (`evals/scenarios/linux-deploy.ts`).
