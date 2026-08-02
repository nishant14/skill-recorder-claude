# Foundry Codex migration — progress tracker

Per-phase status and evidence for the plans in
[`foundry-codex-migration.md`](./foundry-codex-migration.md) (workstreams A–J, the G0–G6 +
GJ gate ladder), its per-phase specs (`phase1a`–`phase1d`, `phase1i`), and
[`foundry-codex-migration-workstream-j.md`](./foundry-codex-migration-workstream-j.md)
(API-grounded skills). This file tracks *where we are*; the plans stay
authoritative for *what to build*.

## ▶ RESUME HERE

- **Position (2026-08-01, night): PHASE 1 IS COMPLETE.** Workstreams **A, B, C, D, E, I
  and J are all implemented on `main`** (`…5d89ecc`, G4-preview fixes `939def1`/`e713a4d`,
  G5 fixes `4b64eaf`). Every LLM call and narration transcription runs on the Foundry
  runtime against the **three required deployments** (`gpt-5.3-codex` builders + judge,
  `gpt-5.2` describer, `gpt-4o-transcribe` narration). The Copilot SDK, bundled CLI,
  `@huggingface/transformers`, and `onnxruntime-node` are **fully purged** from
  dependencies, packaging, installers, and compliance.
- **Gates:** G0 **green** (tests 247/247, typecheck/typecheck:evals/compliance all 0/green);
  G1 **3/3**; G2 **100%**; G3(D) **live 3/3 at 100%** + migration tests; G4 **passed
  locally** (first-ever Linux AppImage built + `verify-linux-package` end to end); G5
  **PASSED** (describer 10/10 with judge, builder 10/10, skill 9/9, clean single state);
  G6 **4/4**; GJ **passed** incl. all four documentation levels.
- **Outstanding, all user-owned:** ① **GitHub Actions has zero runs on this repo —
  apparently disabled** (Settings → Actions). Until enabled, every "CI-able" gate claim is
  latent: the `package-linux` job, the Windows packaging verify (so **Windows packaging is
  unverified** post-purge), and the lockfile guards have never executed. ② G3(C) manual UI
  checklist. ③ Linux GL1/GL2 live checklist + snap-Firefox `GNOME_ACCESSIBILITY=1`
  experiment; GL3 clean-VM install.
- **EVERY WORKSTREAM IS IMPLEMENTED (2026-08-02): A–E, I, J, H, G, plus Linux L1–L3.**
  The app records, analyzes, and builds on Foundry; runs its own skills with enforced
  allowlists and confirmation-gated side effects (GH live: order SO-10003 created through
  `api:` calls); and exports ready-to-import Copilot Studio declarative agent bundles.
  Nothing is left to build on the current board — the remaining items are exclusively
  **user-run gates**: enable GitHub Actions; G3(C) UI checklist; GH ③ (Skills-panel run
  of the fixture skill); GG ③ (import `<slug>-agent.zip` into Copilot Studio); Linux
  GL1/GL2 (+ snap-Firefox experiment) and GL3 clean-VM install.
- **Workstream J (added after the original plan, sequenced between D and E; own plan
  [`workstream-j`](./foundry-codex-migration-workstream-j.md)):** a recording can carry an
  attached API reference — OpenAPI JSON first-class, unstructured docs a fallback — and the
  builders ground steps as `api:<operationId>` via `list_api_operations` /
  `get_api_operation` / `search_api_docs`, hard-rejecting unknown ids at propose time and
  warning at create time. `BuiltSkill.apiReference` + `api/openapi.json` ship inside every
  install/export, so Copilot Studio imports the spec as a custom connector and Workstream
  H's runner can execute against it.
- **`tools/testbed` (new):** a dependency-free CRUD sales app (`npm run testbed`,
  `127.0.0.1:8787`) whose HTML UI is deliberately decoupled from its `X-Api-Key` JSON API,
  plus four descriptions of that API (full / minimal / prose / partial) and four scored
  eval scenarios that attach the same files. **Live 4-level result: all 100%** — after two
  real findings, below.
- **Describer-model comparison: MEASURED and DECIDED — the describer runs on `gpt-5.2`.** Run
  2026-08-01, 9 scenarios × 3 reps per model, deterministic rubric, judge off, prices
  user-supplied (`gpt-5.6-sol` $5/$30 per 1M in/out; `gpt-5.2` $1.75/$14):
  `gpt-5.6-sol` mean score 99.6% (spread 88.9–100%), 24,226 tokens in, 13.0s, **$0.141
  /analysis**; `gpt-5.2` mean score **100.0%** (spread 100–100%), 23,086 in, 11.4s,
  **$0.049/analysis** — 2.9× cheaper at equal-or-better quality; `gpt-5.2` dominates
  every axis. Results files `evals/results/2026-08-01T10-16-41-414Z.json` (A) and
  `…T10-22-26-582Z.json` (B); rerun via "Model cost/quality comparison" in
  `evals/README.md`. Costs are uncached-rate upper bounds. **DECIDED 2026-08-01 (user):
  `gpt-5.2` for the describer** — wired as `describerDeployment`
  (env `AZURE_OPENAI_DESCRIBER_DEPLOYMENT`, file field, default `gpt-5.2`;
  `SKILL_RECORDER_MODEL` still overrides for evals). Live-verified: a no-flag eval run
  logs `describer deployment gpt-5.2` and scores 100%. Builders stay `gpt-5.3-codex`;
  transcription stays `gpt-4o-transcribe`. The resource now hosts three required
  deployments.
- **Parallel initiative — Linux support (own plan: [`linux-support.md`](./linux-support.md)):
  phases L1–L3 all implemented** (X11 capture provider replacing get-windows, AT-SPI URL
  provider, packaging/CI/validation parity). Live on this X11 box: `readLinuxActiveWindow`
  returns real windows, and the AT-SPI host reports READY in 92 ms. Known limitation,
  documented rather than worked around: snap Firefox does not export AT-SPI unless
  accessibility is enabled at launch — and (2026-08-02 finding, see the AppArmor entry
  above) even then the snap's confinement blocks URL reads; the compat check now grades
  this honestly as Good via a live read. Human-pending: GL1/GL2 live checklist on a
  desktop (X11 recording run, Wayland degradation check, snap-Firefox
  `GNOME_ACCESSIBILITY=1` experiment) and GL3's clean-VM install test. The automated half
  was proven **locally** (G4: AppImage + `verify-linux-package` end to end); the
  `package-linux` CI job takes over once Actions is enabled.
- **Standing constraints:** delegate implementation to subagents (see CLAUDE.md "Model
  economy"); live/credentialed gates are human-run, never wired into `npm test` or CI;
  never commit credentials (they live only in `~/.skill-recorder/foundry.json`) or a
  rewritten `package-lock.json`.

- **Workstream P — production readiness (approved 2026-08-02; plan
  [`production-phase.md`](./production-phase.md)):** the ship-to-org-users roadmap.
  Sequenced P4 (enable CI) → **P1 (keep the API key away from the solution — Entra ID +
  org key-broker option space; opens with its own detailed phase plan before any code)**
  → P2 (signing/notarization) → P3 (updates) → P5 (execution-surface security review) →
  P6 (RELEASE-QA from the human gate backlog) → P7 (ops polish). Phase exit: a signed,
  org-distributed build with **no raw Foundry key on disk**, passing release QA on all
  three platforms.

- **2026-08-02 — describer fix: form interactions hidden by page transitions (user-found,
  twice-reproduced).** The testbed order-creation recording analyzed as pure browsing at
  both Good and Full capture: form filling emits zero events, the PRG redirect makes
  select-vs-create identical in the URL trail, and the model sampled only a quiet gap's
  endpoint frames (even citing a frame captioned "submitted" while writing "review").
  Fix, measured fail-before/pass-after: the suite's first vision-forcing eval scenario
  (`form-submit-frames`, sharp-rendered frame fixtures; uncalibrated baseline scored the
  blind reading at exactly the 80% threshold — calibrated to fail at 76%) + three prompt
  rules (page transitions hide actions → sample the MIDDLE of quiet gaps; carry on-screen
  values into step details verbatim; examining a gap ≠ keeping it — first attempt
  regressed `irrelevant-detour` to 77% by dignifying the detour). Final: 11/11 describer
  scenarios at 100%, offline suite 365/365. Fixture lesson pinned in code: the frame
  extractor's dHash dedupe nearly ate the decisive frame — fixture renderers must derive
  layout from content.

- **2026-08-02 — describer fix ITERATION 2 (user reproduced a THIRD time, recording
  `20260802-132458-cd74061c`): the bug moved from the prompt to the pipeline.** Two
  measurements re-aimed it. ① The fixture was upgraded to reality (12 frames at the real
  5s-heartbeat offsets, a decoy order matching the created one on customer/lines/total,
  two dropdown-open mid-pick frames, 38s event silence) and the CURRENT prompt passed it
  at 100% — the prompt is adequate when frames are served; the two extra prompt rules
  drafted for this iteration were dropped as unmeasured. ② The extractor was deleting the
  evidence: `keepOrDrop` ran its 9x8-dHash Hamming ≤8 dedupe on **probe frames the
  describer explicitly requested** via `get_frames`, and over the real session's 12
  frames only 6 survived — the deleted included the decisive dropdown-open frame (d=6)
  and two frames at **d=0** (a form gaining one field is invisible at that hash size; no
  threshold fixes d=0). **Fix: `extractWindow` never perceptually dedupes** — probe
  outputs are named deterministically from the captured source frame and deduped by
  source-file identity only (repeat probes add nothing); event-anchored seeding keeps its
  perceptual dedupe. Measured: real-session replay probe over the form gap recovered
  **0 → 2** frames (`get_frames` in-window 1 → 3, incl. the ~39s decisive frame); a new
  extractor unit test pins the mechanism with a measured-≤8 near-identical pair (FAILs on
  the old code); the eval fixture's form states now collide under dHash like reality
  (min off-diagonal 10 → 2, layout-group support in `frame-fixtures.ts` with a guard
  test). Sweep: 10/11 + `irrelevant-detour` (no code path from these changes reaches it)
  re-measured **3/3 at 100%** — green; `form-submit-frames` 100% every run; offline
  **376/376**, typecheck/typecheck:evals 0. NOTE: an eval FAIL-before was NOT reproducible
  (old extractor still passed — the fixture's dropdown frames survive dedupe and one
  filled-form frame suffices); the fail-before evidence is the real-session replay plus
  the unit test, recorded here instead of overclaiming.

- **2026-08-02 — Linux URL capture: snap Firefox's AppArmor confinement blocks AT-SPI
  reads, and the compatibility check now verifies URLs by a LIVE read.** User-found (they
  correctly rejected my relaunch-without-flag theory with a timestamped compat report):
  with `GNOME_ACCESSIBILITY=1` snap Firefox, the compat check said "Firefox is exposing
  accessibility ✓" yet the recording had **zero `browser.url` events**. Root cause,
  reproduced live: the snap's enforced AppArmor profile lets Firefox's *presence* be
  enumerated on the a11y bus but denies deep tree traversal
  (`org.a11y.atspi.Cache GetItems` → "An AppArmor policy prevents this sender…",
  destination `snap.firefox.firefox (enforce)`) — presence ≠ readability, so the probe
  overclaimed Full. **Fix: the browser probe is end-to-end** — it instantiates a real
  `LinuxUrlProvider` and asks for an actual URL per running browser (3s budget);
  `accessibleBrowsers` now means "URL actually read", new `presentButUnreadable` grades
  **Good** with an honest fix string (non-snap Firefox deb/tar, or Chromium-family with
  `--force-renderer-accessibility`; titles + frames still identify pages). Second live
  finding: the snap denies even the app **name** on the bus, so browser matching falls
  back to `/proc/<pid>/comm`. Live-verified on this box:
  `{checked:true, accessibleBrowsers:[], presentButUnreadable:["firefox"]}` → Good with
  the confinement message. Both HTML guides updated (Good-on-snap is a *correct verified
  outcome*, deb-Firefox/Chromium is the true path to Full). Consequence for the describer:
  snap-Firefox recordings are titles+frames-only by OS design — which iteration 2 above
  makes workable.
  **Follow-up (same day, user-found):** deb Chrome + flag on the New Tab Page still graded
  Good with the snap message — the omnibox is genuinely EMPTY on the NTP (live: address-bar
  node found in 0.1s, no text; with example.com open the provider read the URL in 129ms).
  Fixed: the AT-SPI host protocol is versioned tri-state (`url`/`empty`/`none`; `get()`
  unchanged for recording), the probe buckets `accessibleBrowsers` / `noPageOpen` /
  `presentButUnreadable` + `snapBrowsers` (snap = `/proc/<pid>/exe` under `/snap/`), and
  grading gives each failure its own remedy: no page open → "open any website and re-run";
  unreachable snap → confinement message (unchanged); unreachable non-snap → full-quit and
  relaunch with the flag. Live-verified all three states on this box (Chrome example.com →
  **Full** "URLs verified by a live read ✓"; Chrome NTP → Good/no-page-open; live snap
  Firefox pid → snap-tagged confinement message). Tests 388/388.

## Workstream status

| WS | Scope | Status | Gate | Evidence |
|---|---|---|---|---|
| A | Foundry runtime (`common/foundry.ts`, `electron/foundry/*`, smoke script) | **done, merged** (`6b9acc4`…`4c5a538`) | G1 — **passed** | smoke 3/3 live vs `gpt-5.3-codex` 2026-08-01; `npm test` 87/87; `npm run typecheck` exit 0; `npm run typecheck:evals` exit 0 |
| B | Swap Describer / SkillBuilder / AutomationBuilder / evals-judge onto the runtime | **done** (`94b810d`; spec [`phase1b`](./foundry-codex-migration-phase1b.md)) | G2 — **passed** | live eval `--only=directory-lookup` 2026-08-01: PASS, score 100%, 5 steps, 11.3s vs `gpt-5.3-codex`; typecheck/typecheck:evals 0; tests 111/111 |
| C | Auth/config UX + IPC (replaces GitHub sign-in) | **implemented** (`a884963`; spec [`phase1c`](./foundry-codex-migration-phase1c.md)) | G3(C) — **awaiting the user's manual UI checklist** (spec §G3(C); tile note = endpoint host) | typecheck/typecheck:evals 0; tests 125/125; `rg -i copilot src/` = 0 hits; no source file imports the SDK; `copilot-cli-path.ts` + `copilot-signin.ts` deleted |
| D | Retarget outputs to `copilot-studio` + `app` architectures | **done** (`418181c` + rubric fix `592c02e`; spec [`phase1d`](./foundry-codex-migration-phase1d.md)) | G3(D) — **passed** (live rounds); G3 closes with C's manual checklist | migration tests green (no legacy id survives parsing); live 2026-08-01: `github-issue-triage-skill` 100%, `copilot-studio-teams-digest` 100% (connector-annotated steps), `directory-lookup` automation 100% after rubric-vocabulary fix; tests 168/168 at commit |
| E | Packaging, install scripts, compliance, privacy copy | **done** (`5d89ecc` + G4-preview fixes `939def1`/`e713a4d`; spec [`phase1e`](./foundry-codex-migration-phase1e.md)); carried I4's `@huggingface/transformers` + `onnxruntime-node` removals | G4 — **passed locally**; CI authoritative on push | lockfile removals-only (0 resolved-URL rewrites); compliance tests 12/12; first-ever Linux AppImage built + `verify-linux-package` passed end to end after three real findings (per-platform Electron notices pins at two check sites; AppImage `x86_64` arch naming) |
| F | The gate ladder itself (verification strategy) | **complete for Phase 1** — every automated gate exercised; CI legs latent until Actions is enabled | G0–G5, G6, GJ | see gate ledger below |
| I | Cloud transcription on Foundry (retires local Whisper) — Phase 1, parallelizable after A | **done** (`0b38fab` + audio-route fix; spec [`phase1i`](./foundry-codex-migration-phase1i.md)) | G6 — **passed 4/4** | smoke 4/4 on 2026-08-01 vs `gpt-4o-transcribe`: known phrase round-tripped exactly ("Skill recorder test phrase."), `verbose_json→json` downgrade fired as designed; tests 124/124 |
| G | Phase 2 — Copilot Studio declarative agent bundles (spec [`phase2g`](./foundry-codex-migration-phase2g.md)) | **done** (`84c24c3`) | GG — ①② **passed** (unit + local bundle validation incl. real-sharp icons and zip listing); ③ real Copilot Studio import **pending (user)** — a schema rejection is fixed by bumping the two pinned version constants in `common/declarative-agent.ts` | tests 334/334; exports now carry declarativeAgent.json (v1.2 pin), Teams manifest (1.19 pin), icons, connectors.md, <slug>-agent.zip |
| H | Phase 2 — in-app skill runner on the Foundry deployment (spec [`phase2h`](./foundry-codex-migration-phase2h.md)) | **H-a + H-b + H-c done** (`8c06716`, `a3f7e76`, H-c uncommitted): IPC wire shapes in `common/ipc.ts`, one `SkillRunner` in `main.ts` with the confirm/ask gates bridged over IPC (`electron/runner/ipc-bridge.ts`), Skills panel + run view in `src/Library.tsx` | GH — ② live smoke **PASSED**; ③ manual UI run **pending (user)** | tests 319/319 (H-c adds `electron/runner/ipc-bridge.test.ts`, 9); typecheck + typecheck:evals exit 0; live 2026-08-01: fixture skill on `gpt-5.3-codex` resolved Contoso via `api:listCustomers`, confirmation-gated `api:createSalesOrder` → HTTP 201, order SO-10003 verified in the testbed API state; credentials redacted (zero `demo-key-123` occurrences in the transcript) |
| J | API-grounded skills (attach an OpenAPI spec / docs → plan steps name `api:` operations) — plan [`workstream-j`](./foundry-codex-migration-workstream-j.md) | **done (J1+J2+J3)** + `tools/testbed` (`c8416f0`) and the docs-only brief fix (`5090f44`) | GJ — **passed (both halves)** | tests 248/248; live 2026-08-01: `api-sales-order` PASS 100%, 15.0s — plan grounded in `api:listCustomers` → `api:createSalesOrder` with input validation and ambiguity handling, zero UI-replay steps; the full documentation-level matrix (full / minimal / prose / partial) then passed **4/4 at 100%** |

## Gate ledger

| Gate | Runs | State | Who runs it |
|---|---|---|---|
| G0 | `npm run typecheck` + `npm run typecheck:evals` + `npm test`, every commit | **green as of `5090f44`**: typecheck exit 0, typecheck:evals exit 0, tests **248/248** | CI-able (no credentials) |
| G1 | Phase 1a unit matrix + live contract smoke `scripts/foundry-smoke.ts` (plain completion, tool round-trip, image round-trip) | **PASSED 3/3, 2026-08-01**, endpoint `https://skills-recorder-resource.services.ai.azure.com`, deployment `gpt-5.3-codex`: completion → `"ready"`; tool round-trip → `"The token is alpha7-confirmed"`; image round-trip → `"red"` | human + credentials |
| G2 | one live describer eval, `npm run eval -- --only=<slug>` | **PASSED 2026-08-01**: `directory-lookup` PASS, score 100%, 5 steps, 11.3s, full tool loop (`get_timeline` + `get_events` → `submit_analysis`) vs `gpt-5.3-codex` | human + credentials |
| G3 | manual UI checklist (configure, bad-key path, analyze, build, install/export) + unit tests for the `scout→app` / `cowork→copilot-studio` schema migration | **D half passed 2026-08-01** (migration tests green; live builder rounds 3/3 at 100% — one per architecture + automation); **C half awaits the user's formal UI checklist** (substance already exercised live during the Linux debugging session) | human for the UI half; migration tests CI-able |
| G4 | `npm run compliance:test` + a packaged build; artifact contains no `@github/copilot*` / `@huggingface/*` / `onnxruntime*` | **passed locally 2026-08-01**: compliance 12/12; `dist:linux:x64` built the first-ever Linux AppImage and `verify-linux-package` passed end to end (after three findings: per-platform Electron notices pins at two check sites, AppImage `x86_64` naming). **CI legs latent — Actions disabled on the repo**, so the Windows packaging verify has never run post-purge | CI-able once Actions is enabled; local run counts for Linux |
| G6 | transcription contract smoke — `scripts/foundry-smoke.ts` check 4: known-phrase clip round-trip (espeak-ng-generated), assert phrase + segment timestamps | **PASSED 4/4, 2026-08-01** after the audio-route fix: the v1 audio route 404s (`DeploymentNotFound`) on this resource class — audio lives on the legacy route (`/openai/deployments/{d}/audio/transcriptions?api-version=2024-10-21`, probe-confirmed on three api-versions); transcript = "Skill recorder test phrase.", `verbose_json→json` downgrade exercised live | human + credentials |
| GJ | CI half: full `npm test` green incl. `common/api-reference.test.ts`, `electron/builders/api-reference-{store,tools}.test.ts`, `electron/skillbuilder/export.test.ts`. Live half: `npm run eval:skill -- --only=api-sales-order` passes scored (plan must name `api:createSalesOrder` + a customer lookup, and avoid click/browser/navigate-to), then the documentation-level matrix `-minimal,-docs,-partial` | **PASSED both halves, 2026-08-01.** CI: typecheck 0, typecheck:evals 0, tests 248/248. Live: `api-sales-order` 100%, and after the two findings below the full matrix scores **100% at all four documentation levels** — full spec, spec without `operationId`s (synthesized ids), prose-only guide (endpoint named in step text, no fabricated `api:` refs), and partial spec (grounds the lookup, falls back honestly for the undocumented order step) | CI-able half is CI-able; the evals are human + credentials |
| GH | ① offline runner tests (`electron/runner/{library,allowlist,tools,call-api,runner,ipc-bridge}.test.ts`); ② live end-to-end smoke `node --experimental-transform-types --import ./evals/register.mjs scripts/runner-smoke.ts` — fixture skill runs headlessly against `tools/testbed` and the order must appear in the testbed's API state; ③ manual UI run from the Skills panel with confirmations on | ① **green** (tests 319/319 with H-c). ② **PASSED 2026-08-01** — `gpt-5.3-codex` resolved Contoso via `api:listCustomers`, gated `api:createSalesOrder` → HTTP 201, SO-10003 verified in the testbed state, zero credential occurrences in the transcript. ③ **pending — user**: run the same fixture skill from the Skills panel (Skills tab → pick the skill → optional input → Run), approve the create-order card, and check the confirm card's detail, the streamed transcript, the final report and the transcript path in the footer | ① CI-able; ② + ③ human (② needs credentials) |
| G5 | full eval suites + judge (`eval`, `eval:builder`, `eval:skill`) vs. the Copilot-era baseline, else absolute rubric thresholds | **PASSED 2026-08-01 (evening)** — clean-state runs: describer **10/10** with judge on (incl. `linux-deploy`), builder **10/10**, skill **9/9** (all four documentation levels + both architectures). First pass surfaced one real prompt gap (partial-spec brief could dead-end propose; un-covered actions now stay un-grounded) and five rubric-vocabulary misses (correct plans naming capabilities — "GitHub CLI", "sheet" — vs literal tokens); fixed and rerun green in one state | human + credentials |

Standing rule: a measured result is recorded here **with its number and how it was
obtained**. A confident summary of an unverified result is worse than no summary.

## Decision log

- **2026-08-01 — transport ported from chat completions to the Responses API**
  (`4c5a538`). G1 first ran 0/3: every `POST /openai/v1/chat/completions` returned HTTP 400
  "The requested operation is unsupported" — codex deployments serve the Responses API
  only. Per the contained-fix rule the change stayed inside `electron/foundry/agent.ts`
  (+ fixtures): `POST {endpoint}/openai/v1/responses`, flat function tools, item-based
  history (`message` / `function_call` / `function_call_output`), reasoning items echoed
  verbatim with `include: ["reasoning.encrypted_content"]`, images as `input_image`
  data-URI parts. The public surface Workstreams B–F consume is unchanged.
- **2026-08-01 — `store: false` on every request.** Conversation history is kept in-process,
  so the per-turn history rollback that keeps "analyze times out → user retries in the same
  conversation" working still applies, and no recording-derived content is retained
  server-side. Privacy is a product feature here, not a setting.
- **2026-08-01 — `~/.skill-recorder/foundry.json` is the single credential location**
  (user decision). No project-local credentials file and no `.env`; env vars remain a
  higher-precedence override for evals/CI, and `SKILL_RECORDER_CONFIG_DIR` redirects the
  file for tests. Credentials never enter the repo.
- **2026-08-01 — LLM-call audit: all five inference call sites are accounted for** by
  Workstream B (`describer.ts`, both `builder.ts` files, their shared `agent-builder.ts`,
  and `evals/judge.ts`). Two
  stragglers were folded into the plans rather than left to discovery: the per-automation
  `model` override the AutomationBuilder tool schema still invites (→ D) and
  `scripts/verify-windows-package.mjs`'s assertions that the artifact *contains*
  `@github/copilot*` (→ E, where it becomes G4's Windows enforcement point).
- **Outputs retarget to `copilot-studio` + `app`** (user decision): Scout/Cowork are
  replaced by Copilot Studio agent bundles and the app's own library, with a `z.preprocess`
  migration so persisted `scout` / `cowork` artifacts keep loading (Workstream D).
- **2026-08-01 — narration transcription moves to a Foundry cloud deployment** (user
  decision, new Workstream I). Org security policy: runtime-downloaded open-source model
  weights from huggingface.co cannot currently be security-verified, while Foundry-hosted
  models fall under the org's cloud trust boundary. This **supersedes the "keep Whisper
  local / not affected" position** in the plans and in CLAUDE.md; voice audio now leaves the
  machine, so the privacy disclosures must change with it. Local Whisper ships until I lands.
- **2026-08-01 — API-grounded skills approved (new Workstream J, user decision).** A user
  may attach the target application's API reference to a recording; the builders then map
  UI action steps onto concrete operations (`api:<operationId>` on the step's `tool`) at
  **plan** time, where the review tiles are the human checkpoint — never post-hoc.
  **OpenAPI JSON is the first-class grounded path; unstructured docs (md/txt/html) are a
  best-effort fallback** (term-frequency retrieval, no embeddings); YAML is refused with an
  export-as-JSON message rather than adding a parser dependency. Sequenced **strictly after
  Workstream D** — it rewrites the same builders/instructions/`Library.tsx` lines and keys
  on D's architecture enum. Credentials are a runner/connector concern: the tools return
  security *scheme names* only. J3 persists what Workstream H will consume:
  `BuiltSkill.apiReference` plus a copy of the spec at `api/openapi.json` inside every
  exported/installed skill (and copilot-studio automation bundle), so an installed skill
  survives deleting the recording and a maker can import the spec as a custom connector.
- **2026-08-01 — the testbed's documentation-level matrix found two real things** (
  `tools/testbed`, four live builds over one approved analysis). (1) **Docs-only references
  got the operation-grounding brief**, which tells the model to name `api:<operationId>`
  steps; with prose-only documentation there are no operation ids to name, so the model
  rationally concluded the reference was unusable and fell back to UI replay. Fixed by
  branching the brief: a docs-only reference now gets a **search-first** brief that tells
  the builder to retrieve endpoints from the chunks and name them in the step text
  (`5090f44`). The failure was in *our* prompt, not the model's judgment — worth
  remembering the next time a level "just doesn't ground". (2) **The model hoists API base
  URLs into `{{values}}`**, which is correct generalization, so a rubric that expects a
  literal `https://host/api/v1/orders` in the step text fails a *better* plan; rubrics must
  accept value-factored endpoints. Both fixes landed before the matrix scored 100% at all
  four levels — the numbers are post-fix.
- **In-app execution deferred to Phase 2 (Workstream H).** Phase 1 ships the `app` target
  as library-only so the backend migration isn't blocked on shell-execution safety UX.
- **2026-08-01 (night) — Workstream E findings, first-ever Linux package build.** The
  Electron notices pin failed on Linux: `LICENSES.chromium.html` legitimately differs per
  platform distribution, but the policy held one flat hash recorded from a mac/windows
  zip. Fixed with `noticesByPlatform` pins at both check sites (`prepareElectronNotices`
  and `verifyComplianceDirectory`), extracted from an archive whose own SHA-256 matches
  the already-reviewed `linux-x64` pin — trust chain preserved. Also: electron-builder
  names AppImages `x86_64`, not `x64`; the Linux verifier accepts both.
- **2026-08-01 (night) — G5 lessons.** The recurring failure class of the day is named:
  **rubric-vocabulary misses** — correct plans naming capabilities ("GitHub CLI",
  "sheet") fail literal-token rubrics; five more fixed at G5 without weakening the
  anti-UI-replay intent. One real prompt gap: a partially-documented API could dead-end
  the propose turn (grounding demanded for every action while unknown ids are rejected);
  the reference brief now says un-covered actions stay un-grounded. The app automation
  catalog now steers prompts to concrete commands (`gh pr list --repo …`), which is
  better at execution time and keeps rubrics honest.
- **2026-08-01 (night) — GitHub Actions is disabled on this repo (zero runs ever).** All
  "CI-able" gate wiring (package-linux, Windows packaging verify, lockfile guards) is
  latent until the user enables Actions; Windows packaging is unverified post-purge.
