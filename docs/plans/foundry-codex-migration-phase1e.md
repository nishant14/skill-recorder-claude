# Phase 1e in detail — Workstream E: dependency purge, packaging, compliance

Parent plan: [`foundry-codex-migration.md`](./foundry-codex-migration.md) · Tracker: [`progress.md`](./progress.md)
Status: **approved — implementing**

## Scope and definition of done

Remove everything the migration made dead: the Copilot SDK + bundled CLI and the local-ML
stack (`@huggingface/transformers`, and with it transitive `onnxruntime-node`) leave
dependencies, packaging, installers, compliance, CI, and docs. No runtime behavior
changes — every removed artifact is already unreferenced by live code (verified by the
B/C/I acceptance greps). Done = typecheck/`typecheck:evals` 0; `npm test` green;
`npm run compliance:test` green; the acceptance greps below; **gate G4** = a packaged
build whose artifact contains no `@github/copilot*`, `@huggingface/*`, or
`onnxruntime*` payload — enforced by the (updated) Windows verifier and the existing
Linux verifier's conditional manifest, run in CI (`package-linux` job; Windows workflow).

## E1. Dependencies and bundler

- `package.json` `dependencies`: remove `@github/copilot-sdk` and
  `@huggingface/transformers` (`onnxruntime-node` is transitive through transformers and
  leaves with it — verify nothing else pulls it via `npm ls onnxruntime-node` after).
- **Lockfile discipline:** update via `npm uninstall @github/copilot-sdk
  @huggingface/transformers` so `package-lock.json` changes are *removals only* — the
  surviving entries' `resolved` URLs (the MS feed) must not be rewritten to another
  registry. Verify with `git diff package-lock.json | grep '^+.*resolved' | wc -l` ≈ 0.
- `package.json` `asarUnpack`: remove the `@github/copilot-*`,
  `@huggingface/transformers`, and `onnxruntime-node` globs.
- `vite.config.ts` rolldown `external`: remove the same three.

## E2. Installers

- `install.sh`: remove the copilot package from the required-file manifest and license
  list (~:185-208), `copilot_executable()` + executable/sha256 verification (~:219-244),
  and the sha recording (~:309-344 region). The Node/Electron/compliance machinery stays.
- `install.ps1`: mirror — copilot.exe path/manifest/sha blocks (~:511, :646-710).
- `scripts/install-windows.test.ps1`: update expectations accordingly (it is exercised
  by `windows.yml`; edit carefully — it is the installer's unit test, not runnable here).

## E3. Compliance

- `third_party/compliance-policy.json`: remove the `copilotCli` / `copilotSdk` keys and
  any transformers/onnxruntime review entries.
- `scripts/compliance.mjs`: remove `assertInstalledVersion(... "@github/copilot-sdk")`
  (~:705), `assertReviewedCopilotCliVersions` (~:706, :737-751), the SDK license
  override (~:804-812), and the onnxruntime/transformers license-override and relinking
  entries that exist solely for those packages (:732, :818-824, :979 — read carefully;
  keep anything shared with surviving deps like sharp/libvips).
- Delete `third_party/package-licenses/github-copilot-sdk-MIT.txt` and the
  onnxruntime override file if nothing else references it.
- `scripts/compliance.test.mjs`: update expectations.
- Regenerate `THIRD-PARTY-NOTICES.md`: `npm run compliance:licenses` after the
  uninstall (the copilot/transformers/onnx entries drop out).

## E4. Package verifiers + CI

- `scripts/verify-windows-package.mjs`: **invert** — drop the copilot + onnxruntime
  `expectedPayloads` entries and their PE checks; add forbidden-payload assertions for
  `@github/copilot*`, `@huggingface/*`, `onnxruntime*` at any arch (mirroring the
  Linux verifier's forbidden direction). This is gate G4's Windows enforcement point.
- `scripts/verify-linux-package.mjs`: no edit — its manifest derives from
  `package.json` at verify time and flips required→forbidden automatically; **verify**
  that behavior against the new package.json (its own smoke already tested this
  direction).
- `.github/workflows/windows.yml`: the native-load smoke drops
  `require('onnxruntime-node')` (~:77); check for other copilot/onnx references.
- `.github/workflows/non-windows.yml`: check for copilot/onnx references (the
  install.sh license assertions changed in E2).

## E5. Docs (flip the "until Workstream E" annotations)

`WINDOWS-VALIDATION.md` + `LINUX-VALIDATION.md` (component rows → removed),
`INSTALL.md` (drop the bundled-but-unused note + copilot hash mechanics prose),
`RELEASING.md` (drop the review row), `docs/windows-capture.md` +
`docs/linux-capture.md` packaging paragraphs, `README.md` if any vestige remains.
Also fix the pre-existing garbled sentence in `evals/README.md` (~:269, the
copilot-studio coverage paragraph) while in there.

## Gate G4

- **Local (this machine):** `npm run compliance:test` green; full suite green;
  acceptance greps: `rg "@github/copilot|@huggingface|onnxruntime" --files-with-matches`
  → only docs/plans historical text and `package-lock.json` absence-verification;
  `npm ls @github/copilot-sdk @huggingface/transformers onnxruntime-node` → all empty.
  Attempt `npm run dist:linux:x64 && node scripts/verify-linux-package.mjs x64`
  locally (needs the real Electron download — best-effort; CI is authoritative).
- **CI (authoritative):** `package-linux` job green on push; Windows workflow green
  (its packaging + verify steps enforce the forbidden payloads).

## After E: gate G5 (the migration's final rung)

Full sweeps against the live deployments, absolute thresholds (no Copilot-era numeric
baseline exists): `npm run eval -- --judge`, `npm run eval:builder`,
`npm run eval:skill` — all scenarios PASS expected. Recorded in the tracker; passing
formally completes Phase 1 of the migration.

## Explicitly not in E

`~/.copilot/*` cleanup on user machines (never); Phase 2 G/H; the Linux GL live
checklist items (user's).
