# Phase 1b in detail — Workstream B: swap the agent flows onto the Foundry runtime

Parent plan: [`foundry-codex-migration.md`](./foundry-codex-migration.md) · Tracker: [`progress.md`](./progress.md)
Status: **approved — implementing**

## Scope and definition of done

Ten files edited, **zero new files, zero deleted files, zero dependency changes**. After
this workstream the app performs every LLM call through `electron/foundry/agent.ts`
(Responses API, gate-G1-proven) and nothing at runtime instantiates the Copilot SDK.
The `@github/copilot-sdk` **dependency stays in package.json until Workstream E**; the
only remaining value-imports of it after B are `electron/copilot-cli-path.ts` and
`electron/copilot-signin.ts` (auth/doctor plumbing that Workstream C deletes — the parent
plan's B table said `copilot-cli-path.ts` is deleted in B, but `doctor.ts` and
`copilot-signin.ts` import it, so its deletion moves to C with them; recorded here as a
deliberate deviation).

Done means: `npm run typecheck` + `typecheck:evals` exit 0, `npm test` 87/87, no
`@github/copilot-sdk` import remains under `electron/describer/`, `electron/builders/`,
`electron/skillbuilder/`, `electron/automationbuilder/`, or `evals/`, and **gate G2**
(one live describer eval) passes.

## Edits

### B1. `electron/builders/agent-builder.ts` (shared base)
- `CopilotClient` → `FoundryClient`, `CopilotSession` → `FoundrySession` (import from
  `../foundry/agent`); `BaseLive.copilot` → `BaseLive.agent` (rename ripples to both
  builders).
- `ensureClient()`: `new FoundryClient(); await client.start();` — drop
  `copilotConnectionOption()`, `withStartupTimeout`, `getAuthStatus()` and the
  `COPILOT_SIGNED_OUT_ERROR` throw (`start()` itself throws
  `FOUNDRY_NOT_CONFIGURED_ERROR`). Keep `this.model = process.env.SKILL_RECORDER_MODEL
  || undefined`. Log line: deployment, never the key.
- Class doc comments: "Copilot CLI" → Foundry wording.

### B2. `electron/describer/describer.ts`
- Same client/session swap; `LiveSession.copilot` → `agent`.
- **Delete `pickVisionModel()` and the `listModels()` call** — the single codex
  deployment is the vision model; keep only the `SKILL_RECORDER_MODEL` override.
- `createSession` options collapse to `{ instructions: DESCRIBER_INSTRUCTIONS, tools,
  ...(model ? { model } : {}) }` — `systemMessage`/`approveAll`/`workingDirectory`/
  `enableHostGitOperations`/`infiniteSessions`/`availableTools` all go (the Foundry
  runtime has no default toolset, so the allowlist rationale comment goes with them).
- Remove the now-unused `COPILOT_SIGNED_OUT_ERROR` and `copilot-cli-path` imports.

### B3. `electron/skillbuilder/builder.ts` + B4. `electron/automationbuilder/builder.ts`
- Drop the `approveAll`/`CopilotSession` SDK imports; `LiveBuild.copilot` → `agent`
  (typed `FoundrySession`); `createSession` options collapse as in B2 (each keeps its own
  `instructions: <SYSTEM prompt + catalogue>`).
- Class docs: "GitHub Copilot CLI agent" → "Foundry Codex agent".

### B5. `evals/judge.ts`
- `new CopilotClient()` → `new FoundryClient(); await client.start();`
- `createSession({ instructions: JUDGE_INSTRUCTIONS, tools: [submit], ...(model ? {
  model } : {}) })`; keep `sendAndWait(…, 120_000)`, `disconnect()`, `stop()` flow.

### B6. Import-line-only files (5)
`electron/describer/tools.ts`, `electron/skillbuilder/tools.ts`,
`electron/automationbuilder/tools.ts`, `electron/builders/read-tools.ts`:
`import type { Tool } from "@github/copilot-sdk"` → `from "../foundry/agent"`
(describer/builders path depth as appropriate). Verify no other SDK symbol is used.

## Interim UX note (closed by Workstream C)
Until C ships the connection form, an unconfigured machine surfaces
`FOUNDRY_NOT_CONFIGURED_ERROR` as a **plain error banner** — the renderer's
`isCopilotSignedOutError` match no longer fires, and the old "Sign in to Copilot" button
becomes unreachable dead code (left in place; C replaces it). Acceptable: the message
itself names the fix, and C is the next workstream.

## Gate G2 (exit of B — live, credentialed)
```
npm run eval -- --only=directory-lookup --keep
```
Pass = the eval completes with a scored analysis (no transport errors); score in the
report is informative, not the gate. Run on the machine holding
`~/.skill-recorder/foundry.json`.

## Acceptance checklist
- [ ] typecheck + typecheck:evals exit 0; `npm test` 87/87
- [ ] `rg "@github/copilot-sdk" electron evals --files-with-matches` → only
      `copilot-cli-path.ts` and `copilot-signin.ts`
- [ ] `rg "copilot" electron/describer electron/builders electron/skillbuilder electron/automationbuilder evals/judge.ts -i` → no live-code hits (comments updated too)
- [ ] G2 eval completes against the live deployment
