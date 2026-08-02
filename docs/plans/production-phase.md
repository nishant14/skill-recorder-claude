# Workstream P — Production readiness (ship to internal org users)

## Context

Every feature workstream (A–J, H, G, Linux L1–L3) is implemented and gate-proven; what
remains between the current `main` and software an organization ships to its employees
is productionization. Audience decision: **internal org users** — which makes Entra ID,
an org-managed key boundary, and managed distribution the shipping lane. This plan is a
**roadmap**: items are sequenced and scoped with their rationale and option space, and
the complex items — starting with P1 — explicitly get their **own detailed phase plan
when they begin** (the established phase-doc pattern). Stored at
`docs/plans/production-phase.md` on approval; tracked in `progress.md`.

## P1 — Keep the API key away from the solution  *(first item; detailed plan at phase start)*

**Problem today:** each user holds a raw Foundry API key in
`~/.skill-recorder/foundry.json` (0600, plaintext). For a shipped org product that means
key sprawl, no per-user revocation or attribution, shared-quota abuse, and a key any
local process running as the user can read. The runner already scrubs/redacts, but the
key itself should not exist on end-user machines at all.

**Option space to be decided in the detailed plan (do not decide here):**
- **(a) Org key-broker / gateway (leading candidate):** the app signs the user in with
  **Entra ID** (device-code or system-browser flow); a small org-hosted gateway (APIM or
  a lightweight token service in front of the Foundry resource) validates the user token
  and forwards model calls — no Foundry key ever leaves the org boundary. Central
  quota/rate limits, per-user audit, instant revocation. Touch surface in-app is small
  by design: `electron/foundry/http.ts` is the single transport choke point, and
  `FoundryConfig` becomes `{ gatewayUrl }` + a token cache.
- **(b) Entra ID directly against Foundry (keyless RBAC):** no gateway to run, but
  per-user role assignments on the Azure resource and coarser quota control.
- **(c) Defense-in-depth regardless of a/b:** move any locally cached secret/token from
  plaintext JSON into **Electron `safeStorage`** (OS keychain-backed encryption), keep
  the env-var path for CI/evals only.
- Includes: migration for existing `foundry.json` users, offline/expiry UX in the
  connection panel, eval/smoke harness auth (service principal), and the runner's
  `runner.json` third-party API credentials getting the same safeStorage treatment.

**Deliverable now:** this roadmap slot + the commitment that P1 opens with its own
`production-phase-p1.md` detailed design (gateway choice, token flows, migration,
threat model) before any code.

## P2 — Signed, notarized, distributable builds

Today's macOS build uses ad-hoc identity (`identity: "-"`, `hardenedRuntime: false`) and
Windows builds are unsigned — Gatekeeper/SmartScreen would block or scare org users.
Scope: org code-signing certs (or Azure Trusted Signing), macOS notarization + hardened
runtime, Windows signing, AppImage checksums; distribution via the org's endpoint
management (Intune / Company Portal; apt-style or direct AppImage for Linux). The
source-install path (`install.sh`/`install.ps1`) remains for dev machines, demoted from
the primary end-user story.

## P3 — Update channel

No update story exists (source installs pin a commit). Scope: electron-updater (or
Intune-managed upgrades) with signed artifacts from P2, a release channel + versioned
release notes, and an in-app "update available" affordance. Requires P6's CI.

## P4 — CI/CD activation and release pipeline

GitHub Actions has **zero runs** on the repo — every CI-able gate (package-linux,
Windows packaging verify, lockfile guards) is latent, and **Windows packaging is
unverified post-purge**. Scope: enable Actions, make the existing workflows required
checks, add a tagged-release pipeline producing the signed artifacts of P2, branch
protection. Cheapest item with the highest verification payoff — do first.

## P5 — Security review of the execution surface

The runner executes shell commands and API calls from model output. Before org-wide
ship: a focused review of the allowlist/confirmation model; **prompt-injection
hardening** (recorded web pages and attached API docs are untrusted input that flows
into skill text — the reviewer should attack that path); skill provenance for sharing
(skills received from colleagues: signing or at least a first-run "review this skill"
diff view); secrets-scanning the transcript/redaction paths. Produces fixes + a
documented threat model for the org's security sign-off (the data-flow one-pager from
the user guide's privacy sections is the starting artifact).

## P6 — Close the human gate backlog as release QA

The outstanding manual gates become the release checklist, run once on release
candidates per platform: G3(C) connection-form checklist, GH ③ (Skills-panel run),
GG ③ (real Copilot Studio import — bump the two pinned schema constants if rejected),
Linux GL1/GL2 (+ snap-Firefox experiment) and GL3 clean-VM install, plus a Windows
packaged-build smoke (currently never run). Written up as `RELEASE-QA.md` with the
per-platform steps drawn from the validation docs.

## P7 — Operational polish

Opt-in diagnostics: structured logging behind the existing `createLogger` seam, a
"report a problem" flow reusing the debug-bundle export (already consent-gated),
optional crash reporting; cost visibility (per-analysis token/cost line in the library,
reusing the eval usage plumbing); support/ownership docs (SUPPORT.md refresh, admin
guide for the P1 gateway).

## Sequencing

**P4 → P1 → P2 → P3 → P5 → P6 → P7.** P4 first (activates verification everything else
rides on). P1 before P2/P3 because the auth model changes what ships. P5 before P6's
final QA. P1 and P5 each open with their own detailed phase plan (the phase-doc
pattern); P2/P3 need org inputs (certs, tenant, distribution channel) gathered during
P1.

## Verification

Per item, the established pattern: offline tests + a live/manual gate, recorded in
`progress.md` with numbers. Phase-level exit: a signed build, delivered through the org
channel, on a machine with **no raw Foundry key anywhere on disk**, passing the full
RELEASE-QA.md checklist on all three platforms.
