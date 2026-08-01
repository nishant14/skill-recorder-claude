# Phase 1c in detail — Workstream C: Foundry connection UX (auth/config/IPC)

Parent plan: [`foundry-codex-migration.md`](./foundry-codex-migration.md) · Tracker: [`progress.md`](./progress.md)
Status: **implemented — G3(C) manual UI checklist pending with the user**

## Scope and definition of done

Replace the GitHub sign-in flow end-to-end with Foundry connection management: an in-app
connection form (the renderer affordance the `FOUNDRY_NOT_CONFIGURED_ERROR` contract has
pointed at since Workstream A), a truthful doctor tile, and the deletion of the last two
Copilot plumbing files. After C, **no source file imports `@github/copilot-sdk`** (the
dependency itself leaves in E) and every runtime user-facing "where your data goes"
string is truthful. IPC changes follow the repo's four-places rule: `common/ipc.ts`,
`electron/ipc.ts`, `electron/preload.cjs`, and the calling component together.

Done = typecheck + `typecheck:evals` 0; `npm test` green (125 + any added); acceptance
greps below; the G3(C) manual checklist items runnable by a human.

## C1. `common/ipc.ts` — types + channels

Remove: `CopilotInfo`, `CopilotSignInResult`, `COPILOT_SIGNED_OUT_ERROR`,
`isCopilotSignedOutError`, channel `copilotSignIn: "copilot:sign-in"`, and
`SkillRecorderApi.copilotSignIn()`.

Add (import types from `common/foundry.ts` — it is renderer-safe by construction):

```ts
/** Input from the connection form. The API key is write-only: it goes main-ward in
 *  this payload and never comes back in any renderer-facing shape. */
export interface FoundryConnectionInput {
  endpoint: string;
  apiKey: string;
  /** Optional overrides; blank = keep the release defaults. */
  deployment?: string;            // builders (default gpt-5.3-codex)
  describerDeployment?: string;   // describer (default gpt-5.2)
  transcriptionDeployment?: string; // narration  (default gpt-4o-transcribe)
}

export interface FoundryConnectionResult {
  ok: boolean;
  info: FoundryConnectionInfo;    // key-free, always returned (post-save state)
  error?: string;                 // save/validation failure, verbatim from main
}

/** Result of a live "test connection" round-trip against the main deployment. */
export interface FoundryTestResult {
  ok: boolean;
  /** e.g. "Connected — gpt-5.3-codex answered in 1.2s". */
  message: string;
}
```

`DoctorReport.copilotCli: CopilotInfo` → `foundry: FoundryDoctorInfo` where

```ts
export interface FoundryDoctorInfo extends FoundryConnectionInfo {
  /** The three resolved deployments (release defaults applied). */
  describerDeployment: string | null;
  transcriptionDeployment: string | null;
}
```

Channels: `foundryGetConnection: "foundry:get-connection"`,
`foundrySaveConnection: "foundry:save-connection"`,
`foundryTestConnection: "foundry:test-connection"`. API surface:
`getFoundryConnection(): Promise<FoundryConnectionInfo>`,
`saveFoundryConnection(input: FoundryConnectionInput): Promise<FoundryConnectionResult>`,
`testFoundryConnection(): Promise<FoundryTestResult>`.

## C2. `electron/ipc.ts` + `electron/preload.cjs`

- `get` → `foundryConnectionInfo()` (already key-free).
- `save` → `saveFoundryConfig(input)` in try/catch; validation messages surface verbatim
  in `error`; always return fresh `foundryConnectionInfo()`.
- `test` → build a throwaway `FoundryClient`, `createSession({ instructions: "Reply with
  the single word: ok" — or equivalent minimal prompt })`, `sendAndWait` with a **15s**
  timeout; map success to the friendly message + elapsed time, failure to the runtime's
  taxonomy message (already user-facing). Never include the key. Guard against concurrent
  tests (return "A test is already running." rather than stacking).
- Remove the `openCopilotSignIn` import + handler. Preload mirrors the three channels.

## C3. `electron/doctor.ts`

`checkCopilot()`/`which("copilot")` deleted → `checkFoundry(): FoundryDoctorInfo` from
`loadFoundryConfig()` (offline — the doctor never touches the network; the live probe is
the form's Test button). Remove the `resolveCopilotCliPath` import.

## C4. Renderer

- **`src/Library.tsx`** — `AnalysisError` becomes `FoundryConnectionError`: when
  `isFoundryNotConfiguredError(error)` (import from `common/foundry`), render the
  **connection form**: endpoint (placeholder `https://<resource>.services.ai.azure.com`),
  API key (`type="password"`), and a collapsed "Deployments" details section with the
  three name fields pre-filled from the current info/defaults. Buttons: **Save**
  (→ `saveFoundryConnection`, show `result.error` verbatim on failure), **Test
  connection** (enabled once configured → `testFoundryConnection`, show `message`),
  and the existing retry affordance ("saved — try Analyze again"). Mention
  `~/.skill-recorder/foundry.json` as the manual fallback path. All other error strings
  keep rendering as today.
- **`src/Recorder.tsx`** — doctor tile label "GitHub Copilot" → "Azure AI Foundry";
  status good = configured (note = endpoint host), bad = "not configured".
- **Truthful-copy sweep (runtime UI only; README/docs stay with E):** every remaining
  renderer string claiming analysis goes to "GitHub Copilot" / "GitHub's cloud service"
  (`Library.tsx` "What gets sent…" section, `WhatsRecorded.tsx` analysis paragraph,
  `RecordingPrivacyWarning.tsx` if any Copilot mention survived Workstream I) now says
  the recording's signals are sent to **your Azure AI Foundry deployment** for analysis.
  Grep-verify: `rg -i "copilot" src/` → zero hits afterward.

## C5. Deletions + dead-code sweep

Delete `electron/copilot-cli-path.ts` and `electron/copilot-signin.ts` (nothing imports
them after C2/C3). Acceptance greps:
- `rg "@github/copilot-sdk" --files-with-matches` → only `package.json` /
  `package-lock.json` / compliance policy + notices (all Workstream E's list)
- `rg -i "copilot" electron/ src/ common/` → only product-domain text that is *about*
  target platforms (Copilot Studio catalogs, `~/.copilot/skills` export roots — both
  Workstream D's scope), never about the app's own backend/auth

## Gate G3(C) — manual checklist (human, on a desktop build)

1. Fresh machine (`SKILL_RECORDER_CONFIG_DIR` pointed at an empty dir), `npm run dev` →
   Analyze → the connection form appears (not a bare banner).
2. Save with a bad endpoint → inline validation message; with a bad key → Test button
   shows the 401 taxonomy message; with real values → Test shows "Connected…".
3. Analyze end-to-end succeeds; doctor tile shows "Azure AI Foundry · configured".
4. No UI string anywhere claims GitHub/Copilot handles the app's data.

The C half of G3 can be checked ahead of D; G3 closes as a gate only after D's schema
migration tests also land (per the ladder).

## Explicitly not in C

Dependency/packaging removal, README/INSTALL/SECURITY copy, compliance regeneration
(→ E). Output retargeting and catalog text (→ D). No new deps, no schema changes to
persisted artifacts.
