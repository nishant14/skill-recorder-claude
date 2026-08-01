# Phase 1a in detail — Workstream A: the Foundry runtime

Parent plan: [`foundry-codex-migration.md`](./foundry-codex-migration.md)
Status: **implemented — gate G1 passed 3/3 (2026-08-01)**

> **G1 outcome — transport is the Responses API, not chat completions.** The live smoke
> against the real `gpt-5.3-codex` deployment (`*.services.ai.azure.com`) returned
> HTTP 400 "The requested operation is unsupported" for every `/openai/v1/chat/completions`
> request: codex deployments are Responses-API-only. Per the contained-fix rule, only
> `electron/foundry/agent.ts` (+ its test fixtures) changed: requests now go to
> `POST {endpoint}/openai/v1/responses` with `store: false` (history stays local, so the
> rollback design and privacy posture are unchanged), flat function tools, item-based
> history (`message` / `function_call` / `function_call_output`), reasoning items echoed
> verbatim with `include: ["reasoning.encrypted_content"]`, and the image bridge as
> `input_image` data-URI parts. The chat-completions wire text in section A3 below is
> retained as the original spec; where they differ, **the code and its tests are the
> contract.** After the port, the smoke passed 3/3 (completion, tool round-trip, image
> round-trip). Everything in Workstreams B–F consumes only the unchanged public surface.

## Scope and definition of done

Three new source files + two new test files, **zero changes to existing code** except
adding the test files to `package.json`'s explicit `test` file list. Nothing imports the
new modules yet (Workstream B does that), so this commit is standalone and must leave
`npm run typecheck` and `npm test` green. No new npm dependencies — the client is built on
Node's global `fetch`.

```
common/foundry.ts                  shared types, constants, error contract (renderer-safe)
electron/foundry/config.ts        connection resolution: env → file (Electron-free)
electron/foundry/agent.ts         FoundryClient / FoundrySession + tool loop
electron/foundry/config.test.ts   unit tests (node:test)
electron/foundry/agent.test.ts    unit tests (node:test, faked fetch)
scripts/foundry-smoke.ts          live contract smoke (gate G1 — manual, credentialed)
```

Module-purity constraints (both enforced by the eval harness, which loads app TS outside
Electron): `common/foundry.ts` imports nothing from `node:*` or `electron`;
`electron/foundry/*.ts` may use `node:*` and `./logger` (verified Electron-free) but must
not import `electron`.

## A1. `common/foundry.ts`

```ts
export const DEFAULT_FOUNDRY_DEPLOYMENT = "gpt-5.3-codex";

export interface FoundryConfig {
  endpoint: string;      // "https://<resource>.openai.azure.com" (origin only)
  apiKey: string;
  deployment: string;    // model deployment name
  apiVersion?: string;   // set ⇒ legacy data-plane route (escape hatch)
}

export type FoundryConfigSource = "env" | "file";

/** Key-free view — the only shape the renderer ever sees. */
export interface FoundryConnectionInfo {
  configured: boolean;
  endpoint: string | null;
  deployment: string | null;
  source: FoundryConfigSource | null;
}

export const FOUNDRY_NOT_CONFIGURED_ERROR =
  "Azure AI Foundry isn't configured on this computer yet. Add your endpoint and API key below, then try again.";

export function isFoundryNotConfiguredError(error?: string | null): boolean;
// substring match on "isn't configured on this computer" — same mechanism as today's
// isCopilotSignedOutError, which Workstream C's renderer form keys off.

export function normalizeFoundryEndpoint(raw: string): string;
```

`normalizeFoundryEndpoint` behavior (users paste full target URIs from the portal):
trim → strip trailing `/`s → if it matches `^(https:\/\/[^/]+)` keep only that origin.

| input | output |
|---|---|
| `https://res.openai.azure.com/` | `https://res.openai.azure.com` |
| `https://res.openai.azure.com/openai/deployments/gpt-5.3-codex/chat/completions?api-version=…` | `https://res.openai.azure.com` |
| `https://res.cognitiveservices.azure.com/` | `https://res.cognitiveservices.azure.com` |
| ` https://res.services.ai.azure.com/api/projects/p ` | `https://res.services.ai.azure.com` |
| `res.openai.azure.com` (no scheme) | returned as-is after trim; `saveFoundryConfig` rejects it with the https error |

## A2. `electron/foundry/config.ts`

Resolution precedence: **env → file**. `SKILL_RECORDER_MODEL` overrides the deployment
from *either* source (the evals' `--model` flag sets it and must keep working).

```ts
function configDir(): string;          // SKILL_RECORDER_CONFIG_DIR || ~/.skill-recorder
export function foundryConfigFile(): string;  // <configDir>/foundry.json (shown in UI as manual fallback)

export function loadFoundryConfig():
  { config: FoundryConfig; source: FoundryConfigSource } | null;

export function saveFoundryConfig(input: {
  endpoint: string; apiKey: string; deployment?: string; apiVersion?: string;
}): FoundryConfig;

export function foundryConnectionInfo(): FoundryConnectionInfo;
```

- `fromEnv()`: endpoint `AZURE_OPENAI_ENDPOINT || FOUNDRY_ENDPOINT`, key
  `AZURE_OPENAI_API_KEY || FOUNDRY_API_KEY` — **both required** or env is skipped
  entirely; deployment `SKILL_RECORDER_MODEL || AZURE_OPENAI_DEPLOYMENT || default`;
  apiVersion `AZURE_OPENAI_API_VERSION`.
- `fromFile()`: parse `foundry.json`; require `endpoint` + `apiKey` else null; unparseable
  file logs a warning (tag `FoundryConfig`) and returns null — never throws on read.
  Deployment: `SKILL_RECORDER_MODEL || file.deployment || default`.
- `saveFoundryConfig()`: normalizes the endpoint, then validates — endpoint must start
  with `https://` ("The endpoint must be an https:// URL from your Azure AI Foundry
  resource."), key must be non-empty after trim ("An API key is required."). Defaults
  deployment; drops blank apiVersion. `mkdir -p` the config dir; write pretty JSON with
  `{ mode: 0o600 }` (mode is a no-op on Windows — acceptable: the file sits in the user
  profile). Returns the saved config.
- `foundryConnectionInfo()`: `loadFoundryConfig()` minus the key.

## A3. `electron/foundry/agent.ts`

### Tool contract (drop-in for the SDK's)

Identical to what the four existing `tools.ts` files already produce, so Workstream B
changes only their import line:

```ts
export interface ToolBinaryResult {
  type: "image";
  data: string;        // base64, no data: prefix
  mimeType: string;    // "image/jpeg"
  description?: string;
}
export interface ToolResultObject {
  textResultForLlm: string;
  binaryResultsForLlm?: ToolBinaryResult[];
  resultType?: "success" | "failure";
}
export type ToolResult = string | ToolResultObject;
export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;   // plain JSON Schema (already true today)
  handler: (args: unknown) => ToolResult | Promise<ToolResult>;
}
```

### Public surface

```ts
export interface SessionOptions {
  instructions?: string;   // system message
  tools?: Tool[];
  model?: string;          // deployment override; default config.deployment
}

export class FoundryClient {
  async start(): Promise<void>;        // loadFoundryConfig() or throw FOUNDRY_NOT_CONFIGURED_ERROR
  get deployment(): string;            // active deployment (started clients only)
  async createSession(options: SessionOptions): Promise<FoundrySession>;  // auto-starts
  async stop(): Promise<void>;         // clears config; kept for call-site symmetry
}

export class FoundrySession {
  async sendAndWait(prompt: string, timeoutMs: number): Promise<string>;
  async abort(): Promise<void>;        // cancel in-flight turn (no-op when idle)
  async disconnect(): Promise<void>;   // closed forever + abort
}
```

### Request construction

- URL: default `POST {endpoint}/openai/v1/chat/completions`; when `apiVersion` is set,
  `POST {endpoint}/openai/deployments/{deployment}/chat/completions?api-version={v}`
  (deployment/apiVersion URL-encoded).
- Headers: `Content-Type: application/json`, `api-key: <key>`, and
  `Authorization: Bearer <key>` (both — the two Azure surfaces differ in which they read).
- Body: `messages`; `model: <deployment>` **only** on the v1 route (the legacy route
  encodes it in the path); when the session has tools:
  `tools: [{ type: "function", function: { name, description, parameters } }]` and
  `tool_choice: "auto"`. Nothing else — no `temperature`/`max_tokens` (codex-class
  deployments reject or ignore nonstandard sampling params; add knobs only if the live
  smoke test demands them).

### The turn loop (`sendAndWait`)

Per session state: `messages: ChatMessage[]` (seeded with the system message),
`controller: AbortController | null` (single-flight), `closed: boolean`.

1. Guards: throw if `closed` ("This agent session has been closed.") or a turn is already
   running ("A turn is already running in this session.").
2. Snapshot `historyLength = messages.length`, then push `{ role: "user", content: prompt }`.
3. Create the turn's `AbortController`; arm a timer that aborts with
   ``new Error(`The agent turn timed out after ${s}s.`)`` at `timeoutMs`.
4. Loop up to `MAX_ROUNDS_PER_TURN = 32`:
   a. POST (with retry policy below). Parse; throw mapped errors on non-2xx.
   b. Append the assistant message (content + `tool_calls` when present) verbatim —
      required so the wire history stays valid.
   c. No `tool_calls` → **return** `content ?? ""` (turn complete).
   d. Else execute every call **sequentially, in order** (handlers share mutable
      in-process state — e.g. the frame extractor — so no concurrency), appending one
      `{ role: "tool", tool_call_id, content }` per call:
      - unknown tool → `Unknown tool "<name>". Available tools: <list>.`
      - `JSON.parse(arguments)` failure → corrective message asking for valid JSON
      - handler throws → `Tool <name> failed: <message>` (also logged)
      - `resultType === "failure"` → content prefixed `Tool failed: `
      - collect any `binaryResultsForLlm` into an image batch per call
   e. **After all tool messages of the round** (the API requires a tool message for every
      `tool_call_id` before anything else follows), append one user message per batch:
      a text part — `Images returned by <tool> (in order):` + numbered `description`
      lines — followed by one `image_url` part per image with
      `url: "data:<mimeType>;base64,<data>"`. This is the vision bridge: tool messages
      are text-only, so screenshots ride in as user-message image parts the model sees in
      the same round.
5. Round cap exceeded → throw ``The agent exceeded 32 tool rounds in one turn.``
6. `catch`: if the turn's signal aborted, re-throw its `reason` (the timeout error or
   "The agent turn was canceled."); otherwise re-throw as-is.
7. `finally`: clear the timer and the single-flight controller. **On any throw, roll the
   history back to `historyLength`.** Without rollback, a timed-out round can strand an
   assistant `tool_calls` message with no tool replies, which makes every later request
   in that conversation invalid (HTTP 400) — this is what keeps
   "analyze times out → user hits feedback → same conversation" working.

Sub-`sendAndWait` behaviors preserved from the SDK for call-site compatibility:
`abort()` while idle is a silent no-op; `disconnect()` is idempotent and aborts first.

### Retry policy (inside step 4a)

On HTTP 429/502/503/504: retry the *same* request up to 3 attempts total, backoff 1s/2s
(honoring a numeric `Retry-After` header when present, capped at 30s), each wait
abortable by the turn signal. All other statuses fail fast.

### Error taxonomy (all messages are user-facing — they land in UI banners verbatim)

| condition | thrown message (prefix) |
|---|---|
| no config | `FOUNDRY_NOT_CONFIGURED_ERROR` |
| 401 / 403 | `Azure AI Foundry rejected the API key (HTTP <n>). Check the connection settings.` + server detail |
| 404 | `Azure AI Foundry could not find the "<model>" deployment (HTTP 404). Check the endpoint and deployment name.` + detail |
| 429 (after retries) | `Azure AI Foundry is rate-limiting requests (HTTP 429). Try again in a moment.` |
| other non-2xx | `Azure AI Foundry request failed (HTTP <n>): <detail>` (detail = `error.message` from the JSON body, else first 300 chars) |
| fetch network error | `Could not reach <endpoint>. Check your network and the endpoint URL.` |
| empty `choices` | `Azure AI Foundry returned no completion choices.` |

The API key must never appear in any thrown message or log line.

### Explicitly deferred (documented as non-goals in the module docstring)

Streaming (nothing consumes it — progress comes from tool callbacks); history
trimming/compaction (turns are bounded: ≤500 event rows, ≤6 images per `get_frames`,
32-round cap); parallel tool execution; Entra ID auth.

## A4. Tests

Runner: `node:test` via the repo's existing harness (`evals/register.mjs` hooks give TS +
electron-stub). **`package.json` change**: append `electron/foundry/config.test.ts
electron/foundry/agent.test.ts` to the `test` script's file list — the only edit to an
existing file in this workstream.

`config.test.ts` (isolate with `SKILL_RECORDER_CONFIG_DIR` → `fs.mkdtempSync`; save and
restore every env var touched):
1. env beats file; partial env (endpoint without key) falls through to file
2. file fallback round-trips through `saveFoundryConfig` → `loadFoundryConfig`
3. `SKILL_RECORDER_MODEL` overrides deployment from both sources
4. save validations: non-https endpoint and empty key throw their exact messages;
   deployment defaults to `gpt-5.3-codex`; endpoint normalization applied
5. corrupt `foundry.json` → `loadFoundryConfig()` returns null (no throw)
6. `foundryConnectionInfo()` never contains the key; file mode is 0600 (assert
   `stat & 0o777`, skip on win32)
7. `normalizeFoundryEndpoint` table above

`agent.test.ts` (swap `globalThis.fetch` with a scripted fake per test — it records
request bodies and returns queued responses; restore in `finally`):
1. plain turn: no tools → returns assistant text; request body has system + user messages
   and no `tools` key
2. tool round: response 1 has `tool_calls` → handler receives **parsed** args; request 2
   contains the assistant message and a `role:"tool"` message with the handler's string;
   response 2 text is returned
3. image bridge: handler returns `binaryResultsForLlm` → request 2 contains, *after* the
   tool message, a user message whose parts are `[text, image_url]` with the correct
   data URI
4. failure paths: `resultType:"failure"` prefix; throwing handler → `Tool x failed:`;
   unknown tool; malformed JSON args — each visible in the next request body
5. timeout: fake fetch that never resolves (rejects on signal abort) → `sendAndWait`
   rejects with the timeout message; **history rolled back** (a subsequent turn's request
   body contains no residue of the failed turn)
6. `abort()` mid-flight rejects with the canceled message; `abort()` while idle resolves
7. retry: 429 then 200 → succeeds with exactly 2 fetch calls; 500 → fails fast
8. round cap: fetch always returns `tool_calls` → rejects with the 32-round message
9. `FoundryClient.start()` with no config (empty `SKILL_RECORDER_CONFIG_DIR`, env
   cleared) → rejects with `FOUNDRY_NOT_CONFIGURED_ERROR`
10. single-flight: second `sendAndWait` while one is in flight throws; works again after

## A5. `scripts/foundry-smoke.ts` — live contract smoke (gate G1)

The unit tests above verify our loop against **our assumptions** about the wire contract;
this script verifies the assumptions themselves against the real deployment — the one
risk mocks cannot see, and the reason this gate sits at the end of Workstream A instead
of the end of Phase 1. Run manually with credentials
(`node --experimental-transform-types --import ./evals/register.mjs scripts/foundry-smoke.ts`);
never wired into CI or `npm test`.

Three checks, each printing PASS/FAIL and the raw response on failure:
1. **Plain completion** — `sendAndWait` with no tools returns non-empty text.
2. **Tool round-trip** — one `echo_args` tool; assert the model calls it and the final
   text reflects the tool's result (proves `tools`/`tool_choice`/`role:"tool"` are
   honored by this deployment).
3. **Image round-trip** — a tool returns a tiny generated JPEG (solid color + a word) as
   `binaryResultsForLlm`; assert the final text identifies the color/word (proves the
   data-URI `image_url` user-message bridge works on this deployment).

Exit non-zero on any failure. **Follow-up rule:** the captured request/response bodies
from the first passing run become the fixtures for `agent.test.ts`'s fakes, so the unit
suite mirrors observed reality rather than imagination; any contract deviation discovered
here is fixed inside `electron/foundry/agent.ts` only (route, params, image shape), then
the smoke re-runs.

## Acceptance checklist

- [ ] `npm run typecheck` green (new files compile; no existing file touched but
      `package.json`)
- [ ] `npm test` green including the two new files
- [ ] `rg "@github/copilot-sdk" electron/foundry common/foundry.ts` → no hits
- [ ] `rg "from \"electron\"" electron/foundry` → no hits
- [ ] No new entries in `package.json` `dependencies`
- [ ] Gate G1: `scripts/foundry-smoke.ts` passes all three checks against the real
      deployment (manual, credentialed — blocks the start of Workstream B, not the commit)
- [ ] Commit message: `Add Foundry runtime: config resolution + chat tool loop (Workstream A)`
