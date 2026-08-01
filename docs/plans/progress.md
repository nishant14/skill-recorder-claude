# Foundry Codex migration — progress tracker

Per-phase status and evidence for the plans in
[`foundry-codex-migration.md`](./foundry-codex-migration.md) (workstreams A–H, the G0–G5
gate ladder) and [`foundry-codex-migration-phase1a.md`](./foundry-codex-migration-phase1a.md)
(the Workstream A runtime spec). This file tracks *where we are*; the plans stay
authoritative for *what to build*.

## ▶ RESUME HERE

- **Position (2026-08-01, evening):** Workstreams **A, B, and I are implemented on
  `main`** (`4c5a538`, `94b810d`, `0b38fab`). Every LLM call — describer, both builders,
  eval judge — and narration transcription now goes through the Foundry runtime. Local
  Whisper is deleted; the Copilot SDK is unused at runtime (dependency leaves in E).
- **Gates:** G1 **passed 3/3**; G2 **passed** (live describer eval, 100%); G6 **3/4 —
  blocked on the user**: the resource has no `gpt-4o-transcribe` deployment (HTTP 404).
  Unblock: create a transcription deployment in the Foundry portal (gpt-4o-transcribe /
  gpt-4o-mini-transcribe / whisper) or set `transcriptionDeployment` in
  `~/.skill-recorder/foundry.json`, then rerun the smoke.
- **Next step: Workstream C** (auth/config UX — connection form, doctor, IPC; deletes
  `copilot-cli-path.ts` + `copilot-signin.ts`), then D. Until C ships, an unconfigured
  machine shows the Foundry not-configured message as a plain banner (known interim UX).
- **Open question (understand-first, no decision recorded):** whether the *describer*
  should run a mainline GPT-5.x deployment instead of codex (builders stay codex).
  Decide empirically via `npm run eval` with `--model=<deployment>` comparison.
- **Standing constraints:** delegate implementation to subagents (see CLAUDE.md "Model
  economy"); live/credentialed gates are human-run, never wired into `npm test` or CI;
  never commit credentials (they live only in `~/.skill-recorder/foundry.json`) or a
  rewritten `package-lock.json`.

## Workstream status

| WS | Scope | Status | Gate | Evidence |
|---|---|---|---|---|
| A | Foundry runtime (`common/foundry.ts`, `electron/foundry/*`, smoke script) | **done, merged** (`6b9acc4`…`4c5a538`) | G1 — **passed** | smoke 3/3 live vs `gpt-5.3-codex` 2026-08-01; `npm test` 87/87; `npm run typecheck` exit 0; `npm run typecheck:evals` exit 0 |
| B | Swap Describer / SkillBuilder / AutomationBuilder / evals-judge onto the runtime | **done** (`94b810d`; spec [`phase1b`](./foundry-codex-migration-phase1b.md)) | G2 — **passed** | live eval `--only=directory-lookup` 2026-08-01: PASS, score 100%, 5 steps, 11.3s vs `gpt-5.3-codex`; typecheck/typecheck:evals 0; tests 111/111 |
| C | Auth/config UX + IPC (replaces GitHub sign-in) | not started | G3 (exit of C + D) | — |
| D | Retarget outputs to `copilot-studio` + `app` architectures | not started | G3 (exit of C + D) | — |
| E | Packaging, install scripts, compliance, privacy copy | not started | G4 (exit of E) | — |
| F | The gate ladder itself (verification strategy) | ladder defined; G0/G1 in force | G0–G5, G6 | see gate ledger below |
| I | Cloud transcription on Foundry (retires local Whisper) — Phase 1, parallelizable after A | **implemented** (`0b38fab`; spec [`phase1i`](./foundry-codex-migration-phase1i.md)) | G6 — **3/4, blocked on deployment** | tests 111/111 (whisper tests out; +11 transcribe, +5 wav, +9 narration); smoke checks 1–3 PASS; check 4 → HTTP 404, no `gpt-4o-transcribe` deployment on the resource (user action) |
| G | Phase 2 — Copilot Studio declarative agent export | not started | G-phase gate TBD (real Copilot Studio import) | — |
| H | Phase 2 — in-app skill runner on the Foundry deployment | not started | G-phase gate TBD (runner eval + safety UX) | — |

## Gate ledger

| Gate | Runs | State | Who runs it |
|---|---|---|---|
| G0 | `npm run typecheck` + `npm run typecheck:evals` + `npm test`, every commit | **green as of `0b38fab`**: typecheck exit 0, typecheck:evals exit 0, tests 111/111, on Node v22.23.2 | CI-able (no credentials) |
| G1 | Phase 1a unit matrix + live contract smoke `scripts/foundry-smoke.ts` (plain completion, tool round-trip, image round-trip) | **PASSED 3/3, 2026-08-01**, endpoint `https://skills-recorder-resource.services.ai.azure.com`, deployment `gpt-5.3-codex`: completion → `"ready"`; tool round-trip → `"The token is alpha7-confirmed"`; image round-trip → `"red"` | human + credentials |
| G2 | one live describer eval, `npm run eval -- --only=<slug>` | **PASSED 2026-08-01**: `directory-lookup` PASS, score 100%, 5 steps, 11.3s, full tool loop (`get_timeline` + `get_events` → `submit_analysis`) vs `gpt-5.3-codex` | human + credentials |
| G3 | manual UI checklist (configure, bad-key path, analyze, build, install/export) + unit tests for the `scout→app` / `cowork→copilot-studio` schema migration | pending (exit of C + D) | human for the UI half; migration tests CI-able |
| G4 | `npm run compliance:test` + a `npm run dist` build; packaged artifact contains no `@github/copilot*` | pending (exit of E) | CI-able |
| G6 | transcription contract smoke — `scripts/foundry-smoke.ts` check 4: known-phrase clip round-trip (espeak-ng-generated), assert phrase + segment timestamps | **3/4 on 2026-08-01** — checks 1–3 PASS; check 4 FAIL HTTP 404: no `gpt-4o-transcribe` deployment on the resource. Blocked on a user-created transcription deployment; rerun the smoke after | human + credentials |
| G5 | full eval suites + judge (`eval`, `eval:builder`, `eval:skill`) vs. the Copilot-era baseline, else absolute rubric thresholds | pending (pre-merge) | human + credentials |

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
- **In-app execution deferred to Phase 2 (Workstream H).** Phase 1 ships the `app` target
  as library-only so the backend migration isn't blocked on shell-execution safety UX.
