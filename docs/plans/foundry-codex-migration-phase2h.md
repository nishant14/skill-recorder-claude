# Phase 2H in detail — Workstream H: the in-app skill runner

Parent plan: [`foundry-codex-migration.md`](./foundry-codex-migration.md) (Workstream H) · Tracker: [`progress.md`](./progress.md)
Status: **approved — implementing**

## Scope and definition of done

The app executes its own installed skills: a **SkillRunner** drives one `FoundrySession`
per run over an **execution toolset** (shell, files, web, `call_api`, ask-user), with
`allowed-tools` **enforced** (not advisory), every side effect gated by a visible
confirmation, secrets never reaching the model or transcript, and a persisted run
transcript. API-grounded skills execute their `api:<operationId>` steps as real HTTP
calls validated against the skill's stored spec — closing the loop Workstream J opened.
V1 is **manual Run only** (automation scheduling is H2, explicitly deferred); one active
run at a time, app-architecture skills only.

Done = unit suite green; gate **GH** = ① offline runner tests, ② a **live end-to-end
smoke**: a fixture API-grounded skill runs headlessly against `tools/testbed` and the
sales order *actually appears in the testbed's API state* — recording → skill → runner →
API, the product's whole thesis in one test; ③ the manual UI run checklist (user).

## H1. Skill library loading — `electron/runner/library.ts`

- Scan `skillsRoot()` (`~/.skill-recorder/skills`, env-overridable — reuse the existing
  helper from `electron/skillbuilder/builder.ts`; export it rather than duplicating) for
  `*/SKILL.md`.
- **Minimal frontmatter parser** for exactly what `renderSkillMarkdown` emits (`name`,
  double-quoted `description`, optional `allowed-tools` dash-list), tolerant of hand
  edits; no YAML dependency. Installed bodies already have `{{value}}` literals
  substituted at export — the runner performs **no** token substitution.
- Detect `api/openapi.json` + `api/index.json` (Workstream J artifacts) and an optional
  **`runner.json`** beside the SKILL.md (user-authored per-skill config: `{ "apiBase"?:
  string, "headers"?: { ... } }` — where API credentials live; never written by us,
  documented in H6).
- `listInstalledSkills(): SkillListEntry[]` — `{ name, description, dir, hasApi,
  mtimeMs }`.

## H2. Runner core — `electron/runner/runner.ts`

- `SkillRunner` follows the `Describer`/`AgentBuilder` register: shared `FoundryClient`,
  progress callback, abort. **One active run globally** (second `run()` throws "A skill
  is already running.").
- A run = one `FoundrySession` turn: instructions = `RUNNER_INSTRUCTIONS` (execute the
  skill on the user's machine; follow its steps in order; use only the provided tools;
  side effects need user approval — a denial is an instruction, not an error; finish
  with a short report of what was done) + the SKILL.md body; kickoff prompt = "Run this
  skill now." + optional user-supplied input text. Model = the main deployment
  (`gpt-5.3-codex` — agentic execution is codex's task shape).
- **`electron/foundry/agent.ts` gains one option**: `SessionOptions.maxRoundsPerTurn?`
  (default stays 32; the runner passes 64). Tiny, additive, one new unit test; nothing
  else in the runtime changes.
- Turn timeout **15 min**. Interactive waits (confirmations, `ask_user`) have their own
  **3-min UI timeout** that resolves *in-band* ("The user did not respond — skip this
  action or finish up.") so a walked-away user degrades the run instead of burning it.
- **Transcript**: every event (`model`, `tool-call`, `tool-result`, `confirm-request`,
  `confirm-decision`, `user-input`, `error`, `done`) appended to
  `~/.skill-recorder/runs/<skill>/<timestamp>.json` and streamed to the UI. Secrets
  redaction applies before persistence (H4).
- `run(opts: { name, input?, policy: "interactive" | "auto-approve" })` — the
  `auto-approve` policy exists **only** for the smoke/eval path; the IPC layer always
  passes `interactive`.

## H3. Execution tools — `electron/runner/tools.ts`

All handlers return the existing `Tool` contract. Shared guards: paths must resolve
inside `os.homedir()`; `~/.skill-recorder/foundry.json` (and the whole
`~/.skill-recorder/runs` transcript dir) are **deny-listed** for reads and writes; child
process env is **scrubbed** of `AZURE_OPENAI_*`/`FOUNDRY_*` variables.

- `run_shell { command, cwd? }` — gated by the compiled allowlist (H4) **and**
  confirmation; `bash -lc` (win32: `cmd /c`), default cwd `os.homedir()`, per-command
  timeout 120s, stdout+stderr capped at 20k chars (tail-truncated with a marker).
- `read_file { path }` — 200 KB inline cap (larger → size + head).
- `write_file { path, content }` — confirmation-gated; 1 MB cap; parent dirs created.
- `fetch_url { url, method?, headers?, body? }` — http/https only, 30s timeout, 200 KB
  response cap; no credential injection.
- `call_api { operationId, pathParams?, query?, body? }` — **registered only when the
  skill has `api/index.json`**: resolves the operation from the index (unknown id →
  in-band failure listing near-matches — reuse `findOperation`/near-miss logic from
  `electron/builders/api-reference-tools.ts`), builds the URL from `runner.json.apiBase`
  → else the spec's `servers[0]`, merges `runner.json.headers` (the credential path),
  executes via fetch (30s, 200 KB cap). Non-GET operations are confirmation-gated.
  When the frontmatter lists `api:<op>` entries, `call_api` is restricted to those.
- `ask_user { question }` — relays to the UI, resolves with the user's text (3-min
  timeout in-band).

## H4. Enforcement + safety model

- **Allowlist compilation** (`electron/runner/allowlist.ts`, pure + unit-tested):
  frontmatter `allowed-tools` entries map to capabilities — `Bash(<glob>)` patterns
  gate `run_shell` (glob against the trimmed command; multiple patterns OR); bare
  `web_fetch` → `fetch_url`; `api:<op>` → `call_api` op set; `Read`/`Write` → file
  tools. Rules: if **any** `Bash(...)` pattern exists, non-matching commands are
  **refused in-band** (the model is told which patterns exist). If the skill declares
  **no** `allowed-tools` at all: nothing is outright refused, but **always-allow is
  disabled** — every side effect needs an individual approval, and the run panel labels
  the skill "unrestricted".
- **Confirmation harness**: `run_shell`, `write_file`, and non-GET `call_api` emit a
  confirm request (kind, one-line summary, full detail) and await the decision:
  Approve / Deny (in-band "The user declined this action.") / **Always allow for this
  run** (per kind+pattern, never persisted). `auto-approve` policy bypasses prompts but
  still logs each decision to the transcript.
- **Redaction**: values of `runner.json.headers` are replaced with `«redacted»` in every
  tool-call transcript entry, progress event, and model-visible echo. The Foundry key
  never enters the child env or any tool result.

## H5. IPC + UI (four-places rule)

- `common/ipc.ts`: `SkillListEntry`, `RunProgress { runId, skillName, phase:
  "start"|"working"|"confirm"|"done"|"error", message, entry? }`, `RunConfirmRequest
  { runId, callId, kind, summary, detail, allowAlways: boolean }`, `RunRespondInput
  { runId, callId, approved?: boolean, alwaysAllow?: boolean, text?: string }`;
  channels `skills:list`, `skill:run`, `skill:run-cancel`, `skill:run-respond`,
  events `skill:run-progress`, `skill:run-confirm`; API `listInstalledSkills()`,
  `runSkill({name, input?})`, `cancelRun(runId)`, `respondToRun(input)`, plus the two
  `on*` subscriptions. `electron/ipc.ts` + `preload.cjs` wire them; runner instantiated
  in `main.ts` beside the builders (disposed on quit).
- **`src/Library.tsx`**: a **Skills** panel listing installed skills (name, description,
  API badge, "unrestricted" badge) with Run. The run view: optional input box → Start;
  streaming transcript (reuse the progress-list styling); inline confirmation cards
  (Approve / Deny / Always allow this run) and `ask_user` text prompts; Cancel; final
  summary with the transcript file path. Reuse existing classes; minimal new CSS.

## H6. Fixture + gate GH — `scripts/runner-smoke.ts`

- Committed fixture at `evals/fixtures/runner-sales-skill/` — a realistic API-grounded
  SKILL.md (created from the `api-sales-order` shape: resolve customer via
  `api:listCustomers`, create order via `api:createSalesOrder`), its `api/openapi.json`
  + `api/index.json` (built from `tools/testbed/docs/openapi-full.json` via
  `writeReference`/the store's indexer), and a `runner.json` with the testbed's
  `apiBase` + `X-Api-Key: demo-key-123`.
- The smoke: start the testbed on an ephemeral port (import `createServer` — same
  process), copy the fixture into a temp `SKILL_RECORDER_SKILLS_DIR`, patch
  `runner.json.apiBase` to the port, `run()` with `policy: "auto-approve"` and input
  naming a customer + items, then **assert against the testbed's API state**: a new
  order exists for the resolved customerId with the requested lines. Print
  PASS/FAIL + the transcript path; nonzero exit on FAIL. Live + credentialed
  (uses the codex deployment), human-run — never in `npm test`/CI.
- Manual UI half of GH: run the same fixture skill from the Skills panel with
  confirmations on; approve the create-order call; verify the confirm card, transcript,
  and result. (User's checklist, documented in the tracker.)

## H7. Tests (offline; append to the explicit `test` list)

`electron/runner/library.test.ts` (frontmatter parse incl. hand-edited variants, api/
runner.json detection, listing); `electron/runner/allowlist.test.ts` (Bash glob
matrix, api op sets, no-allowed-tools ⇒ unrestricted mode flags); `electron/runner/
tools.test.ts` (path scoping + deny-list, env scrubbing, output caps, call_api against
a fixture index — unknown op, apiBase/server resolution, header redaction, injected
fetch/spawn fakes); `electron/runner/runner.test.ts` (scripted `fetch` fake driving a
2-tool run end-to-end: transcript entries, confirmation approve/deny/timeout paths via
injected waiters, single-active-run guard, cancel). Plus the `maxRoundsPerTurn` test in
`agent.test.ts`.

## Sequencing for implementation (three subagent stages)

**H-a** core: agent.ts option, `library.ts`, `allowlist.ts`, `tools.ts` (minus
`call_api`), `runner.ts` headless, all H7 tests except call_api. **H-b** API execution:
`call_api`, `runner.json`, redaction, fixture + `runner-smoke.ts`; parent runs the live
smoke (GH ②). **H-c** IPC + UI + docs (README capability line, tracker, CLAUDE.md).

## Explicitly not in H (v1)

Automation scheduling (H2, later); parallel runs; persisted always-allow / trusted
skills; Windows/macOS runner smoke (unit-covered; live smoke is Linux-local);
non-`app`-architecture skills (Copilot Studio skills never execute locally).
