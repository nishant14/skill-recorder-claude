# Migration plan: GitHub Copilot CLI → GPT-5.3 Codex on Azure AI Foundry

Status: **approved, not yet implemented**
Branch: `claude/gpt-5.6-codex-foundry-migration-u1csnc`

## Locked decisions

1. **Model/runtime**: every agentic feature moves to a single **GPT-5.3 Codex deployment on
   Azure AI Foundry** (vision-capable — accepts image + text, so the frame-reading describer
   keeps working on the same deployment).
2. **Auth**: endpoint + API key (+ deployment name), entered in an in-app connection form or
   via environment variables. No Entra ID flow in this phase.
3. **Output targets**: built skills/automations target **(a) Copilot Studio agents** and
   **(b) the app's own library** ("app" architecture). For the app target this phase is
   **library-only** — skills/automations are saved into the app's own folders and shown in
   the UI; an in-app execution runtime is a later phase.

## Current state (what we're replacing)

The only AI backend is the GitHub Copilot CLI, driven via `@github/copilot-sdk` from four
places: `Describer` (analysis with vision tools), `SkillBuilder` + `AutomationBuilder` (via
the shared `AgentBuilder`), and the eval judge (`evals/judge.ts`). The SDK provides: a
spawned CLI process (shipped in `node_modules/@github/copilot-<platform>-<arch>`), GitHub
auth, session management, a multi-turn tool-calling loop (`sendAndWait`), and in-process
tool dispatch where handlers return
`string | { textResultForLlm, binaryResultsForLlm?, resultType }` — including **inline JPEG
screenshots** from `get_frames`. Outputs currently target Scout/Cowork agents and install
into `~/.copilot/skills` / export to `~/.copilot/automations`.

Not affected: narration transcription (local Whisper via `@huggingface/transformers` +
onnxruntime), all capture/recorder/frames code, the zod analysis/skill/automation formats.

## Workstream A — New Foundry runtime (new code, no new npm dependencies)

### A1. `common/foundry.ts` (shared main + renderer)

- `DEFAULT_FOUNDRY_DEPLOYMENT = "gpt-5.3-codex"`
- `interface FoundryConfig { endpoint: string; apiKey: string; deployment: string; apiVersion?: string }`
- `interface FoundryConnectionInfo { configured: boolean; endpoint: string | null; deployment: string | null; source: "env" | "file" | null }`
  — never carries the key, safe to hand to the renderer
- `FOUNDRY_NOT_CONFIGURED_ERROR` + `isFoundryNotConfiguredError()` — exact analog of today's
  `COPILOT_SIGNED_OUT_ERROR` contract the renderer string-matches to show the connection
  form instead of a bare error
- `normalizeFoundryEndpoint()` — users paste full target URIs from the Foundry portal; keep
  only the `https://…` origin (the client appends its own route)

### A2. `electron/foundry/config.ts` — config resolution

Precedence: **env → file**.

- Env: `AZURE_OPENAI_ENDPOINT`/`FOUNDRY_ENDPOINT`, `AZURE_OPENAI_API_KEY`/`FOUNDRY_API_KEY`;
  deployment from `SKILL_RECORDER_MODEL` (kept — the evals' `--model` flag sets it) →
  `AZURE_OPENAI_DEPLOYMENT` → default; optional `AZURE_OPENAI_API_VERSION`.
- File: `~/.skill-recorder/foundry.json`, written mode 0600; directory overridable via
  `SKILL_RECORDER_CONFIG_DIR` so evals/tests never touch the real home dir.
- No Electron imports (the eval harness loads this module outside Electron).
- API: `loadFoundryConfig(): { config, source } | null`,
  `saveFoundryConfig(input)` (validates https endpoint + non-empty key),
  `foundryConnectionInfo(): FoundryConnectionInfo`, `foundryConfigFile(): string`.

### A3. `electron/foundry/agent.ts` — the agent loop

Implemented with plain `fetch` (Node ≥ 18) — **zero new npm dependencies**, which keeps
packaging, asarUnpack, and the compliance pipeline simple.

- Re-declare `Tool`, `ToolResult`, `ToolBinaryResult` with the **same handler contract** the
  four `tools.ts` files already use
  (`handler(args) => string | { textResultForLlm, binaryResultsForLlm?, resultType }`), so
  those files change only their import line.
- `FoundryClient`: `start()` (resolves config or throws `FOUNDRY_NOT_CONFIGURED_ERROR`),
  `createSession({ instructions, tools, model? })`, `stop()` — mirrors the old
  `CopilotClient` surface so call-site churn stays minimal. Dropped session options with no
  HTTP equivalent: `approveAll`/`onPermissionRequest`, `workingDirectory`,
  `enableHostGitOperations`, `infiniteSessions`, `availableTools` (the runtime has no
  default toolset — sessions can only ever call the in-process tools we pass).
- `FoundrySession`: holds message history across `sendAndWait` calls (preserves the app's
  plan → refine → create single-conversation design), `sendAndWait(prompt, timeoutMs)`,
  `abort()`, `disconnect()`.
- **Request shape**: default route `POST {endpoint}/openai/v1/chat/completions` with
  `model: <deployment>` in the body; when `apiVersion` is set, use the legacy
  `/openai/deployments/{deployment}/chat/completions?api-version=…` route instead (escape
  hatch if the resource doesn't serve the v1 surface). Send both `api-key` and
  `Authorization: Bearer` headers. Map 401/403 ("key rejected — check connection settings")
  and 404 ("deployment not found — check endpoint/deployment name") to actionable errors.
- **Loop**: append user message → completion → if the assistant returns `tool_calls`, run
  each in-process handler, append `role:"tool"` results (prefix "Tool failed: " when
  `resultType === "failure"`; malformed JSON args get a corrective tool message), repeat
  until a reply without tool calls. Hard cap ~32 rounds per turn. One `AbortController` per
  turn drives both the timeout and `abort()`.
- **Inline-screenshot bridge** (the one genuinely tricky part): chat-API tool messages are
  text-only, so when a handler returns `binaryResultsForLlm`, append the images as
  `image_url` **data-URI parts in a user message immediately after that round's tool
  results**, with a text part naming the tool and per-image labels (timestamp/source).
  GPT-5.3 Codex accepts image + text, so the describer keeps full vision.

## Workstream B — Migrate the four agent flows

| File | Change |
|---|---|
| `electron/builders/agent-builder.ts` | `CopilotClient/CopilotSession` → `FoundryClient/FoundrySession`; `BaseLive.copilot` → `agent`; `ensureClient()` loses CLI startup/auth-status checks, keeps the `SKILL_RECORDER_MODEL` override |
| `electron/describer/describer.ts` | Same swap; `createSession` options become `{ instructions, tools, model? }`; **delete `pickVisionModel()` / `listModels`** — the single Codex deployment is the vision model |
| `electron/skillbuilder/builder.ts` | Same swap; docs/copy updated |
| `electron/automationbuilder/builder.ts` | Same swap |
| `evals/judge.ts` | Same swap |
| `electron/describer/tools.ts`, `electron/skillbuilder/tools.ts`, `electron/automationbuilder/tools.ts`, `electron/builders/read-tools.ts` | Import `Tool` from the foundry module instead of `@github/copilot-sdk` — no other change |
| **Delete** | `electron/copilot-cli-path.ts` |

## Workstream C — Auth/config UX (replaces GitHub sign-in end-to-end)

- **Delete** `electron/copilot-signin.ts` (the open-a-terminal login flow).
- `common/ipc.ts`: replace `CopilotInfo` / `CopilotSignInResult` /
  `COPILOT_SIGNED_OUT_ERROR` / `isCopilotSignedOutError` with `FoundryConnectionInfo`-based
  types + a `FoundryConfigResult`; `DoctorReport.copilotCli` → `foundry`; IPC channel
  `copilot:sign-in` → `foundry:get-connection` + `foundry:save-connection`;
  `SkillRecorderApi.copilotSignIn()` → `getFoundryConnection()` /
  `saveFoundryConnection({ endpoint, apiKey, deployment? })`.
- `electron/ipc.ts` + `electron/preload.cjs`: wire the two new channels (save calls
  `saveFoundryConfig`, returns key-free info; errors surfaced in the result object).
- `electron/doctor.ts`: `checkCopilot()` → `checkFoundry()` returning connection info.
- `src/Library.tsx`: `AnalysisError` becomes a **connection form** — when
  `isFoundryNotConfiguredError(error)`, render endpoint / API key / deployment (pre-filled
  `gpt-5.3-codex`) fields + Save, then "try again".
- `src/Recorder.tsx`: doctor tile "GitHub Copilot" → "Azure AI Foundry"
  (configured / not configured).

## Workstream D — Retarget outputs: Copilot Studio + in-app library

- **`common/skill.ts`**: `SkillArchitecture` → `z.enum(["app", "copilot-studio"])` wrapped
  in a `z.preprocess` migrating persisted `"scout" → "app"` and
  `"cowork" → "copilot-studio"` (old `skill.json` / plan artifacts keep loading). New
  `ARCHITECTURES` + 4-card `TARGETS`, all enabled:
  1. App skill — installs into the app's library
  2. App automation — saved into the app's automations folder
  3. Copilot Studio skill — export-only bundle
  4. Copilot Studio automation — export-only bundle
- **Roots**: `skillsRoot()` → `~/.skill-recorder/skills`; `automationsRoot()` →
  `~/.skill-recorder/automations` (env overrides `SKILL_RECORDER_SKILLS_DIR` /
  `SKILL_RECORDER_AUTOMATIONS_DIR` kept). `"install"` placement is app-architecture-only;
  Copilot Studio reuses the existing export-only UI path in `Library.tsx` (today's
  `architecture === "cowork"` conditionals; also update "Added to Scout" and the automation
  import-instructions copy around `Library.tsx:1127-1161,1403`).
- **New catalogs** (replace `scout-catalog.ts`, `cowork-catalog.ts`,
  `scout-automation-catalog.ts`):
  - `electron/skillbuilder/copilot-studio-catalog.ts` (+ automation flavor in
    `electron/automationbuilder/`): steps become **agent instructions**; prefer **connector
    actions/tools** (Outlook, Teams, SharePoint, Dataverse, HTTP/custom connectors, Power
    Automate flows, MCP tools) over UI replay; automations map to Copilot Studio
    **triggers** (scheduled/event). Exported bundle = `SKILL.md` (body pastes into the
    agent's Instructions; description doubles as the trigger phrase) / `automation.json`
    (schedule + step prompts to recreate as a trigger).
  - `electron/skillbuilder/app-catalog.ts` (+ automation flavor): the in-app agent (this
    app's own Foundry Codex runtime — **library-only this phase**) runs on the user's
    machine with shell/CLI (`gh`, `git`), file, and web access — the existing
    native-tool-first guidance from the Scout catalog carries over largely intact.
- `electron/skillbuilder/instructions.ts` (Scout mention at line 67) → architecture-neutral.
- `evals/builder/scenarios.ts`, `evals/skillbuilder/scenarios.ts`: `architecture: "app"`.
- `common/automation.ts`: de-Scout the comments/doc; keep the schedule/import JSON shape
  (generic enough for both targets).

## Workstream E — Packaging, install scripts, compliance, docs

- `package.json`: drop `@github/copilot-sdk` dependency; remove `@github/copilot-*` from
  `asarUnpack`.
- `vite.config.ts`: remove `@github/copilot-sdk` from rolldown `external`.
- `install.sh` / `install.ps1`: remove Copilot CLI binary path + sha256 verification blocks
  and the copilot license-file expectations.
- Compliance: remove `copilotCli`/`copilotSdk` from `third_party/compliance-policy.json`;
  remove `assertReviewedCopilotCliVersions` + the SDK version assertion + the
  `github-copilot-sdk-MIT.txt` license override handling from `scripts/compliance.mjs`
  (and the override file); regenerate `THIRD-PARTY-NOTICES.md` via
  `npm run compliance:licenses`; update `scripts/compliance.test.mjs` expectations.
- Privacy/marketing copy (a real disclosure change, not just branding):
  `src/WhatsRecorded.tsx`, `src/RecordingPrivacyWarning.tsx`, `Library.tsx` "What gets sent
  to GitHub Copilot" → "…to your Azure AI Foundry deployment"; `README.md`, `INSTALL.md`,
  `SECURITY.md`, `evals/README.md`.

## Workstream F — Verification

1. `npm install` → `npm run typecheck` + `npm run typecheck:evals` (tests/evals import the
   real builder code, so this catches every missed call site).
2. `npm test` (unit tests don't hit the network) + `npm run compliance:test`.
3. New unit test for the loop: fake `fetch` returning a tool-call round then a final
   message; assert tool dispatch, image-message injection, timeout/abort behavior, and the
   not-configured error path.
4. Live smoke against a real deployment (run by a human with credentials):
   `AZURE_OPENAI_ENDPOINT=… AZURE_OPENAI_API_KEY=… npm run eval -- --only=<one-scenario>`.

## Sequencing

A → B → C → D → E → F, one commit per workstream on the branch above.

## Risks / notes

1. **GPT-5.3/5.6 Codex is newer than the authoring model's knowledge cutoff.** The
   implementation targets the stable Azure chat-completions contract with the `apiVersion`
   escape hatch; the live smoke test is the real gate. If the deployment rejects any
   default parameter, the fix is confined to `electron/foundry/agent.ts`.
2. **Copilot Studio can't auto-install skills** — its outputs are export bundles with
   import instructions; the catalog copy makes that explicit to the user.
3. **In-app runtime is intentionally out of scope** this phase (library-only), per product
   decision.
