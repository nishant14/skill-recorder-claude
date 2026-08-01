# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Model economy

You are running on Fable 5, which is quota-constrained. Your job is
planning, root-cause analysis, and architecture — not implementation.

- Delegate ALL code edits, test fixes, lint fixes, refactors, and
  file-by-file changes to subagents via the Agent tool.
- Delegate all codebase search and file reading to the Explore agent.
- Do the work yourself only when: the task is a single trivial edit
  where delegation overhead exceeds the work, or delegation has already
  failed twice on this task.
- Write delegation prompts with full context. Subagents start from a
  fresh context window and see nothing from this conversation.

## What this project is

**Skill Recorder** — an Electron desktop app that records a real work session on the
user's screen (app switches, clipboard, window titles, browser URLs, low-fps video +
keyframes, optional spoken narration), reconstructs *what the user did* as an intent
plus ordered steps, and turns that single run into a reusable **skill** (`SKILL.md`) or
**automation** (scheduled/triggered procedure) for an AI agent.

The pipeline is three agentic stages over one recording:

1. **Describer** (`electron/describer/`) — multi-turn agent with sandboxed tools
   (`get_timeline`, `get_events`, `get_narration`, `list_frames`, `get_frames`,
   `submit_analysis`) that reconstructs intent + steps. `get_frames` returns JPEGs
   **inline** so the model can see the screen; this stage needs a vision model.
2. **SkillBuilder** / **AutomationBuilder** (`electron/skillbuilder/`,
   `electron/automationbuilder/`) — plan → user refines → create. Shared pooling
   lives in `electron/builders/agent-builder.ts`; shared read tools in
   `electron/builders/read-tools.ts`.
3. **Evals** (`evals/`) — scored harnesses over fixed scenarios, plus an optional
   LLM judge.

Narration transcription is **local** (Whisper via `@huggingface/transformers` +
onnxruntime) — no cloud call, and unaffected by backend changes.

## Architecture map

| Path | Role |
|---|---|
| `electron/` | Main process: capture, pipeline, agents, IPC. Entry `electron/main.ts`. |
| `src/` | React renderer. `Recorder.tsx` (capture HUD), `Library.tsx` (sessions + build flows), `plan-edit.tsx` (plan review tiles). |
| `common/` | Shared main ⇄ renderer contracts. **zod schemas + types only — no Node or Electron imports.** |
| `common/ipc.ts` | Single source of truth for IPC channel names + the `SkillRecorderApi` surface. |
| `electron/preload.cjs` | Context-bridge; must stay in sync with `common/ipc.ts`. CommonJS, copied verbatim by `vite.config.ts`. |
| `docs/plans/` | Approved implementation plans. Read before starting planned work. |

Data contracts worth knowing before changing anything downstream:
`common/analysis.ts` (describer output), `common/skill.ts` (skill plan + built skill,
`SkillArchitecture`), `common/automation.ts` (automation plan + export JSON),
`common/values.ts` (`{{id}}` token substitution), `common/bundle.ts` (the deterministic
timeline the agents read).

## Commands

```bash
npm run dev              # Vite + Electron in watch mode
npm start                # run the built app
npm run typecheck        # tsc --noEmit  (src, common, electron)
npm run typecheck:evals  # tsc --noEmit -p evals/tsconfig.json
npm test                 # node:test over an EXPLICIT file list (see below)
npm run eval             # describer eval        (needs live model credentials)
npm run eval:builder     # automation builder eval
npm run eval:skill       # skill builder eval
npm run compliance:test  # license/compliance policy tests
npm run dist             # packaged build via electron-builder
```

There is **no linter or formatter** in this repo. Match surrounding style by hand.

## Testing

- Runner is `node:test` with `--experimental-transform-types`; TypeScript executes
  directly, no build step. `evals/register.mjs` installs resolution hooks that
  (a) stub the `electron` module and (b) resolve extensionless relative imports.
- **A new test file does not run until you add it to the `test` script's file list in
  `package.json`.** The list is explicit — there is no glob. This is the single most
  common way a new test silently never runs here.
- Because the eval harness loads app TypeScript outside Electron, any module the evals
  reach (pipeline, describer, builders, and anything they import) **must not import
  `electron`** at module scope. `electron/logger.ts` is deliberately Electron-free for
  this reason.
- Unit tests must not hit the network. Fake `globalThis.fetch` and restore it in a
  `finally`/`afterEach`. Tests touching config must isolate via a `mkdtempSync` dir and
  save/restore every environment variable they read.
- Live, credentialed checks (evals, contract smokes) are run by a human — never wired
  into `npm test` or CI.

## Conventions

- TypeScript ESM throughout; **extensionless relative imports** (`from "../logger"`).
- `strict` and `noUnusedLocals` are on. `common/` stays dependency-free apart from zod.
- Comments explain *why* and pin down constraints — read `electron/describer/describer.ts`
  or `electron/foundry/agent.ts` for the house voice. Block JSDoc above a module or class
  explains its role and non-goals; inline comments mark non-obvious invariants. Don't
  narrate what the code already says.
- Validate every agent submission with zod at the boundary (see the `submit_*` tool
  handlers); the engine — not the model — owns identity fields like architecture and
  frontmatter.
- Error messages thrown from main-process features can surface **verbatim** in renderer
  banners. Write them for the user, and never include secrets.
- IPC changes touch four places together: `common/ipc.ts`, `electron/ipc.ts`,
  `electron/preload.cjs`, and the calling component in `src/`.

## In-flight work: Foundry Codex migration

The app is migrating off the GitHub Copilot CLI backend (`@github/copilot-sdk`) onto a
**GPT-5.3 Codex deployment on Azure AI Foundry**, and retargeting generated skills to
**Copilot Studio agents** and the **app's own library**.

- Plans are authoritative and live in `docs/plans/`:
  `foundry-codex-migration.md` (workstreams A–H, the G0–G5 test gate ladder) and
  `foundry-codex-migration-phase1a.md` (the runtime spec).
- **Workstream A is merged**: `common/foundry.ts`, `electron/foundry/config.ts`,
  `electron/foundry/agent.ts` (`FoundryClient` / `FoundrySession` — a dependency-free
  `fetch` chat-completions tool loop), tests, and `scripts/foundry-smoke.ts`.
- It is **inert**: nothing imports it yet, so the shipping app still runs on the Copilot
  CLI. Workstream B is the swap.
- `electron/foundry/agent.ts` re-declares the `Tool` contract as a drop-in for the SDK's,
  so migrating a `tools.ts` file means changing its import line only.
- Gate **G1** (`scripts/foundry-smoke.ts`, live + credentialed) must pass before
  Workstream B starts. Wire-contract surprises get fixed inside `agent.ts` alone.

## Gotchas

- **Privacy is a product feature.** Recordings contain screen video, clipboard contents,
  visited URLs, and voice. Anything that transmits or bundles session data needs an
  explicit user-facing warning — see `src/WhatsRecorded.tsx`,
  `src/RecordingPrivacyWarning.tsx`, and the debug-bundle confirm sheet in `Library.tsx`.
  Changing *where* recording data is sent is a disclosure change, not a copy tweak.
- Native/binary deps (`sharp`, `koffi`, `get-windows`, `onnxruntime-node`,
  `@huggingface/transformers`, `archiver`) are **externalized** in `vite.config.ts` and
  `asarUnpack`-ed in `package.json`. Adding one means updating both, plus the compliance
  policy in `third_party/`.
- Packaging is compliance-gated: `scripts/compliance.mjs` pins reviewed versions and
  license overrides. Dependency changes require regenerating `THIRD-PARTY-NOTICES.md`
  (`npm run compliance:licenses`).
- Sessions live under `sessionsRoot()`; always gate session ids through
  `isValidSessionId` (`electron/recorder/session-store.ts`) before touching paths.
- macOS is the primary target; Windows 11 x64/ARM64 is supported (see
  `WINDOWS-VALIDATION.md`, `docs/windows-capture.md`). Capture providers differ per
  platform — check `electron/collectors/`.
- Sandbox/CI note: the committed `package-lock.json` pins tarballs to a Microsoft npm
  mirror that some networks can't reach, and Electron's postinstall download is slow.
  `ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci` works for typecheck/test runs; **never commit
  a rewritten lockfile** as a workaround.
