# Third-Party Notices

Skill Recorder is licensed under the MIT License (see [`LICENSE`](./LICENSE)).

Packaged/distributed builds include third-party components that are covered by
their own license terms. This file summarizes the notable ones. Every supported
release command generates a complete, platform-specific compliance bundle under
`resources/compliance/` containing full package license texts, native notices,
copyleft license texts, corresponding source, and relinking instructions.
Electron's exact notices are retained under `resources/compliance/electron/`;
platforms that preserve Electron's root notice files carry those copies too.

The dependency tree is otherwise permissive (MIT, ISC, Apache-2.0, BSD,
BlueOak-1.0.0) and compatible with distributing this application under MIT.
Those components remain under their own terms; the generated
`THIRD-PARTY-LICENSES.txt` preserves their license and attribution text.

## Bundled runtime components

No speech model or local inference runtime ships with, or is downloaded by, Skill
Recorder. Narration is transcribed and skills are derived by the user's own Azure
AI Foundry deployment, which is not distributed with this application.

### Electron / Chromium media codecs
- License: Electron is **MIT**. Its Chromium runtime includes `ffmpeg.dll`
  (`libffmpeg.dylib` / `libffmpeg.so` on other platforms), a dynamically loaded
  codec library whose bundled notice identifies FFmpeg as **LGPL-2.1-or-later**.
  GPL portions require an explicit non-default FFmpeg build configuration.
- Electron's `LICENSE.electron.txt` and `LICENSES.chromium.html` are retained in
  every packaged application.
- The currently pinned source is Electron
  [`v43.1.1`](https://github.com/electron/electron/tree/v43.1.1), Chromium
  [`150.0.7871.114`](https://chromium.googlesource.com/chromium/src/+/150.0.7871.114),
  and Chromium FFmpeg revision
  [`ad41607c61898cf7150e0fb20fe4bbabd44922a3`](https://chromium.googlesource.com/chromium/third_party/ffmpeg/+/ad41607c61898cf7150e0fb20fe4bbabd44922a3).
  The Electron source archive and its applied FFmpeg patch queue accompany each
  release.
- Chromium records the WebM media, captures screen snapshots, and decodes
  narration audio. Skill Recorder does **not** distribute `ffmpeg-static` or a
  standalone FFmpeg executable.
- A user-installed standalone FFmpeg may be invoked only to read a recording
  created before snapshot manifests were introduced. That executable is not part
  of this app.

### Sharp / libvips — `sharp` and `@img/sharp-*`
- `sharp` is **Apache-2.0**. Its Windows native packages are
  **Apache-2.0 AND LGPL-3.0-or-later**; other platforms load the corresponding
  **LGPL-3.0-or-later** `@img/sharp-libvips-*` package.
- The currently pinned source is Sharp
  [`v0.34.5`](https://github.com/lovell/sharp/tree/v0.34.5), its reproducible
  packaging scripts
  [`sharp-libvips v1.2.4`](https://github.com/lovell/sharp-libvips/tree/v1.2.4),
  and libvips
  [`v8.17.3`](https://github.com/libvips/libvips/tree/v8.17.3). The unpacked
  native module remains replaceable in the packaged application.
- The native payload also contains libraries under MPL-2.0, MIT, BSD, ISC,
  fontconfig, FreeType, libpng, libtiff, zlib, and related permissive terms.
  The exact upstream table is distributed as
  `resources/compliance/NATIVE-THIRD-PARTY-NOTICES.md`.

### Copyleft release materials

Redistributable builds include the complete GPL-3.0, LGPL-2.1, LGPL-3.0, and
MPL-2.0 texts. They also include source archives for Electron's FFmpeg revision,
Sharp, libvips, every library embedded in the Sharp native payload, the
applicable packaging repositories, and all externally applied build patches.
`SOURCE-MANIFEST.json` records the origin, version, SHA-256, and purpose of every
file. Every remote payload is checked against a reviewed SHA-256 before use;
the FFmpeg archive is deterministically generated from its pinned Git commit.
`RELINKING.md` identifies platform-specific unpacked shared-library locations
and explains how to rebuild and replace them.

### Other native modules
- `get-windows` — MIT
- `koffi` / `@koromix/koffi-*` — MIT; used for Win32 foreground-window calls,
  including the native Windows ARM64 build.
- `sharp` — Apache-2.0; see the Sharp/libvips section for native payload terms

## Apache-2.0 components
Some dependencies (e.g. `sharp`) are Apache-2.0, which requires retaining their
copyright, license, and any `NOTICE` file contents. The release process collects
these from the exact installed dependency tree into
`resources/compliance/THIRD-PARTY-LICENSES.txt` and fails if any package lacks
reviewed license material.

## Generating a complete license manifest
To validate installed package notices without downloading corresponding source:

```sh
npm run compliance:licenses
```

All `npm run dist*` commands run the full `npm run compliance:prepare` process
automatically. Electron Builder's `afterPack` hook refuses to create an
installer if the bundle is incomplete or if a build output directory was
recursively packaged.
