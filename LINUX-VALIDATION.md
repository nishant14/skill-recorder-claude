# Linux validation

Skill Recorder supports **Ubuntu 22.04 LTS and 24.04 LTS on x64, running an X11
session**. The packaging gate lives in the `package-linux` job of
[`.github/workflows/non-windows.yml`](.github/workflows/non-windows.yml) and runs on
GitHub's `ubuntu-latest` image; the capture and installer checks run in the same
workflow's `ubuntu-latest` leg of the `build` job.

Other distributions are best effort: the AppImage generally runs, but only Ubuntu is
validated. ARM64 Linux packaging is deferred — no `dist:linux:arm64` script exists yet.

Wayland is explicitly **not** supported for window tracking. The app detects a Wayland
session and reports it honestly in the doctor rows instead of emitting partial data.

## Architecture-sensitive components

| Component | Linux x64 | Notes |
|---|---:|---|
| Electron 43 | Yes | Official Electron archives; ELF `e_machine` 0x3e verified |
| Electron `libffmpeg.so` codec library | Yes | LGPL-2.1+; standard Electron component and notices |
| Koffi FFI | Yes | `@koromix/koffi-linux-x64/linux_x64/koffi.node` prebuild; no compiler |
| Sharp | Yes | `@img/sharp-linux-x64/lib/sharp-linux-x64.node` |
| libvips | Yes | `@img/sharp-libvips-linux-x64/lib/libvips-cpp.so.*` |
| `get-windows` | No | Excluded from the Linux package; Linux uses the in-repo X11 provider |
| Standalone FFmpeg / `ffmpeg-static` | No | Chromium replaced all current media uses |

`scripts/verify-linux-package.mjs` derives the expected native payload set from
`package.json` **at verify time**. A payload is required while its declaring dependency
is present and forbidden once that dependency is removed. Workstream E removed
`@github/copilot-sdk`, `@huggingface/transformers`, and (transitively)
`onnxruntime-node` from `dependencies`, so their payloads are now forbidden with no
verifier edit.

`get-windows` remains an optional dependency for macOS only. Its Linux code path is
plain JavaScript shelling out to `xprop`, yet the package compiles a native macOS
binding at install time — so on Linux it silently failed to install and capture
produced nothing. `electron/collectors/linux-active-window.ts` replaces it, and
`build.linux.files` excludes `node_modules/get-windows/**` from the package.

## Window-class association

The packaged `.desktop` entry sets `StartupWMClass=skill-recorder`.

electron-builder's *default* would be the `productName` (`Skill Recorder`), because
`desktopName` is not set in `package.json`. That default is wrong here: Electron
derives its X11 `app_id` — and therefore `WM_CLASS` — from the `name` field in
`package.json`, which is `skill-recorder`. This was verified live against a running
source build:

```console
$ xprop -id <window> WM_CLASS
WM_CLASS(STRING) = "skill-recorder", "skill-recorder"
```

`install.sh` writes the same `StartupWMClass=skill-recorder` into its source-install
entry. **Re-verify with `xprop WM_CLASS` on the packaged AppImage during the manual
smoke test below**; if a future Electron or electron-builder release changes the
`app_id` derivation, the taskbar/dock grouping breaks silently and only this check
catches it.

## Automated gate

For Ubuntu, CI:

1. Installs `x11-utils desktop-file-utils xvfb python3-pyatspi at-spi2-core dbus`.
2. Runs the commit-pinned `install.sh` source installation, which now hard-requires
   `xprop`/`xwininfo`.
3. Runs `desktop-file-validate` on the `.desktop` entry `install.sh` generated, and
   asserts it carries `StartupWMClass=skill-recorder` and an icon file that exists.
4. Runs `npm ci` and generates the license inventory.
5. Runs `readLinuxActiveWindow()` under `xvfb-run` and asserts the promise settles
   without crashing (`undefined` is an acceptable answer on an empty Xvfb desktop).
6. Extracts `ATSPI_SCRIPT` from `electron/collectors/linux-url-provider.ts` and runs
   `python3 -m py_compile` on it.
7. Runs unit tests and the production build.
8. In the separate `package-linux` job: builds the AppImage with `dist:linux:x64`, then
   runs `scripts/verify-linux-package.mjs x64`, which verifies the ELF machine type of
   the executable, `libffmpeg.so`, and every expected native payload; rejects
   foreign-architecture and foreign-platform payloads; asserts `get-windows` is absent;
   bans `ffmpeg-static` and standalone `ffmpeg`; and checks the notices plus the
   packaged compliance directory.

Release publication is additionally gated on attaching the pinned LGPL source and
relinking materials listed in [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).

Local equivalents:

```sh
npm ci
npm test
npm run build
npm run dist:linux:x64
node scripts/verify-linux-package.mjs x64
```

`dist:linux:x64` rejects cross-platform and cross-architecture builds
(`scripts/assert-native-linux-arch.mjs`) instead of producing an AppImage containing
host-platform Koffi or Sharp binaries.

## Manual smoke checklist

Automated packaging cannot validate a real desktop session. Before a release, run all
three passes on a physical Ubuntu machine.

### 1. X11 full recording run (the acceptance test)

Log in to an **Ubuntu on Xorg** session and run the packaged AppImage.

1. Confirm `xprop -id <window> WM_CLASS` on the Skill Recorder window matches the
   `StartupWMClass` in the installed `.desktop` entry.
2. Open the doctor rows in the HUD. Window tracking must read `x11` with no warning
   row; browser URLs must read `atspi`.
3. Set the capture level to **Full** and follow the eight-step live smoke in
   [`docs/linux-capture.md`](docs/linux-capture.md).
4. Analyze the session. It must produce a real intent with app switches, window
   titles, browser URLs, and frames — not an empty recording.

### 2. Wayland honest-degradation run

Log in to the default Ubuntu (Wayland) session and start the same build.

1. The doctor must show window tracking as **unsupported**, with the reason naming the
   Wayland session and pointing at "Ubuntu on Xorg". App activity and window titles
   must be marked unsupported in the capability rows.
2. No misleading "Reduced capture … permission" warning may appear (that message is
   macOS-only).
3. Recording must still start and produce video; only window tracking degrades.
4. If the global shortcut fails to register, confirm the warning text names Wayland.

### 3. Snap Firefox AT-SPI caveat check

Ubuntu ships Firefox as a snap, which does not enable accessibility by default.

1. With a stock snap Firefox, confirm `browser.url` events are simply absent — no
   crash, no bogus events, and the doctor row is honest.
2. Relaunch Firefox with accessibility on:

   ```sh
   GNOME_ACCESSIBILITY=1 firefox
   ```

   Confirm `browser.url` events now appear for at least three different sites.
3. Repeat with Chromium started as `chromium --force-renderer-accessibility` and
   confirm URLs appear; without the flag, confirm they are silently absent rather than
   wrong.

Record which browsers produced URLs; the AT-SPI heuristics vary by browser and locale
and the contract is best-effort null.

### 4. Non-Ubuntu AppImage run (non-blocking)

Run the AppImage once on one non-Ubuntu distribution (e.g. Fedora) and record the
result. Failures here are documented, not release-blocking: the supported scope is
Ubuntu.

## Known limitations

- **Wayland window tracking is unsupported.** A Wayland compositor exposes no
  unprivileged equivalent of `_NET_ACTIVE_WINDOW`. The doctor reports this rather than
  emitting the partial truth XWayland would give.
- **The recording controls HUD is visible in recordings.** Electron's
  `setContentProtection` is a no-op on Linux, so the floating bar appears in captured
  video and frames. On Windows and macOS it is excluded.
- **Snap Firefox needs accessibility enabled at launch** for URL capture. Start it with
  `GNOME_ACCESSIBILITY=1` — a running Firefox cannot be switched over.
- **Chromium needs `--force-renderer-accessibility`** for its omnibox to appear in the
  AT-SPI tree. The app does not force this flag on other people's browsers; the doctor
  and these docs name it instead.
- **Global shortcuts may fail to register on Wayland.** The compositor owns keyboard
  grabs. Use the HUD buttons.
- **ARM64 Linux is not packaged.** No `dist:linux:arm64` script and no verifier arch
  row for it beyond the wrong-architecture rejection list.
- A standalone system FFmpeg is optional and legacy-only; it is never downloaded,
  bundled, or required for new recordings. Electron's standard LGPL `libffmpeg.so`
  codec library remains part of the Chromium runtime.
