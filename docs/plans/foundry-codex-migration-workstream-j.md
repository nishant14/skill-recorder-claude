# Workstream J — API-grounded skills

## Context

User-validated concept: once a recording's analysis captures *semantic intent* ("created
a sales order for customer X"), supplying the target application's **API reference**
lets the SkillBuilder map UI-level action steps to concrete **API operations** — a skill
an agent executes via APIs instead of UI replay. This extends the product's existing
native-tool-first principle: today the static capability catalog steers "GitHub web UI →
`gh` CLI"; this feature adds *per-application, user-supplied* capability material.
Mapping happens at the **plan stage** (propose → review tiles → create), never post-hoc
— UI-field↔API-field matching is fallible and the review UI is the human checkpoint.
User decisions: **OpenAPI (JSON) is the first-class grounded path; unstructured docs
(md/txt/html) are best-effort fallback**; implemented **strictly after Workstream D**
(same files). Zero new npm dependencies (YAML specs refused with an honest
export-as-JSON message; PDFs out of scope).

Per-target payoff: **copilot-studio** — the spec imports directly as a custom connector;
plan steps name its operations; `allowed-tools` lists the connector actions to
configure. **app** — the Workstream H runner will execute/validate HTTP calls against
the stored spec (this workstream persists the artifact H consumes). Credentials are a
runner/connector concern — never captured into the reference bundle, values, or
SKILL.md; the operation-detail tool returns security *scheme names* only.

Three phases; implementation delegated to subagents per CLAUDE.md.

## Phase J1 — Reference attach, indexing, persistence

- **New `common/api-reference.ts`** (pure, dependency-free): `ApiReferenceManifestSchema`
  (version, sources[{id, kind: "openapi"|"docs", name, origin file|url, bytes,
  title?, apiVersion?}]), `ApiReferenceIndexSchema` (operations[{operationId (synthesized
  when absent), method, path, summary, tags, deprecated?, sourceId}], chunks[{id,
  sourceId, heading, text}]), `ApiReferenceSummary` (renderer-facing). Pure functions:
  `extractOperations` (paths×methods walk, dedupe), `resolveOperationDetail` (local-$ref
  only, visited-set cycle guard, depth cap 6), `chunkDocs` (heading-first, else ~1500
  chars/200 overlap), `stripHtml` (naive), `scoreChunks` (term-frequency + heading
  boost, no embeddings), `normalizeApiRef`/`unresolvedApiOperations`/`collectApiRefs`
  (the lint core; accepts `api:<operationId>` and `api:METHOD /path`).
- **New `electron/builders/api-reference-store.ts`** (fs, beside read-tools.ts):
  `attachFromFile`, `attachFromUrl` (main-process fetch, http/https only, 15s timeout,
  size cap), `loadReference`, `loadIndex`, `removeSource`. Kind detection: JSON with
  `openapi|swagger`+`paths` → spec (one max, re-attach replaces); else docs. Rebuilds
  `index.json` per mutation. Limits: 10 MB/file, 1 spec + 8 docs, 2000 ops, 3000 chunks.
  Layout: `<session>/api-reference/{manifest.json, spec.json, docs/<id>.txt, index.json}`.
  YAML → user-facing refusal naming the JSON-export escape hatch.
- **IPC (four places)**: channels `api-reference:attach|get|remove`;
  `attachApiReference(sessionId, {kind:"file"}|{kind:"url",url})` /
  `getApiReference` / `removeApiReference`; attach uses the existing
  `dialog.showOpenDialog` pattern (filters json/md/txt/html; dismissed ⇒ canceled);
  **attach/remove call `builder.forget` + `automationBuilder.forget`** so the next
  `createLive` rebuilds tools (handles attach-after-plan cleanly).
- **`src/Library.tsx`**: attach row on the target-picker sheet (before any live
  conversation exists — the builder panel auto-fires build on open), source list +
  remove, URL input; status chip in both builder panel headers.
- **Tests** (append to explicit list): `common/api-reference.test.ts` (extraction,
  synthesized ids, $ref guards, chunking, scoring, normalization, schema round-trips);
  `electron/builders/api-reference-store.test.ts` (temp sessions dir, YAML refusal,
  limits, index rebuild, replace semantics).

## Phase J2 — Builder/automation integration, prompts, lint

- **New `electron/builders/api-reference-tools.ts`** (mirrors read-tools.ts;
  `createApiReferenceTools({sessionDir, onProgress?})` → `[]` when no index):
  `list_api_operations {filter?, tag?}` (compact table, 100-row cap + narrow hint);
  `get_api_operation {operationId}` (params/flattened requestBody/2xx shape/security
  scheme names; unknown id → failure with near-miss suggestions);
  `search_api_docs {query, limit≤10}` (registered only when chunks exist).
- **`electron/skillbuilder/builder.ts`**: append the tools in `createLive`; when
  attached, append a generated API-reference block to the system content (sources +
  op count, the `api:` step-tool convention, the credentials rule, one per-architecture
  paragraph — app: runner executes `api:` steps against the stored spec, list used ops
  in allowedTools; copilot-studio: spec imports as a custom connector, allowed-tools =
  connector actions e.g. `SalesAPI.createSalesOrder`). `create()`: grounding lint beside
  `unresolvedTokens` — **warn**, not fail (user-edited plan is authoritative).
- **`electron/skillbuilder/tools.ts`**: `SkillToolContext.apiIndex?`; `propose_plan`
  **hard-rejects** unresolved `api:` refs (failure return, agent self-repairs); step
  `tool` description gains the convention sentence.
- **`electron/skillbuilder/instructions.ts`**: one static paragraph (map action steps to
  operations when reference tools are present).
- **Automation parity**: `common/automation.ts` `AutomationStepDraftSchema` gains
  `tool: z.string().default("")` (never emitted into the import JSON —
  `toAutomationImport` unchanged); mirror tools/prompt/reject/warn in
  `electron/automationbuilder/{tools,builder,instructions}.ts`.
- **Tests**: `electron/builders/api-reference-tools.test.ts` (filter/cap/near-miss/
  search/absent-without-reference); extend `common/api-reference.test.ts` (lint cases)
  and D8's `common/automation.test.ts` (tool field default + import omission).

## Phase J3 — Outputs, eval, docs

- **`common/skill.ts`**: `BuiltSkillSchema.apiReference: {operations: string[],
  specFile: string} | null` (engine-owned; the pointer Workstream H reads).
- **`electron/skillbuilder/builder.ts`** export paths: when `api:` refs exist + spec
  attached, copy `spec.json` → `<skillDir>/api/openapi.json` and `index.json` →
  `<skillDir>/api/index.json` (installed skills self-contained after session deletion;
  copilot-studio exports carry the spec for connector import); set `apiReference`.
  Automation copilot-studio export bundle also gets `api/openapi.json`.
- **`src/Library.tsx`** done copy: copilot-studio+API → "import api/openapi.json as a
  custom connector and configure the listed actions"; app+API → "API operations run
  against the stored spec when the runner ships."
- **Eval**: `evals/lib/seed.ts` gains `apiReference?: {spec, docs?}` seeding via the
  store's indexer; new `evals/mocks/openapi-sales.json` fixture + scenario
  `api-sales-order` (architecture `app`, rubric `mustUseAny` on
  `api:createSalesOrder` etc., `forbidden: ["click","browser","navigate to"]` — rubric
  schema already scans step tool, no change). `evals/README.md` + tracker updated.

## Gate GJ

CI-able: full `npm test` green incl. the three new test files. Live (credentialed):
`npm run eval:skill -- --only=api-sales-order` passes scored.

## Sequencing

**Strictly D → J1 → J2 → J3** (D rewrites the same builders/instructions/Library.tsx
lines and the architecture enum J's prompts key on). E can interleave. H later consumes
`apiReference` + `api/index.json`.

## Key reuse

`dialog.showOpenDialog` pattern (electron/ipc.ts export flow), `unresolvedTokens` lint
posture (skillbuilder/builder.ts:170), `read-tools.ts` structure, FoundrySession `Tool`
contract, `session-store.ts` helpers, eval `seedScenario` single seeding path,
existing rubric `mustUseAny` scanning.

## Risks

Hallucinated operationIds → propose-time hard reject + near-miss hints + create warn +
H revalidates at execution. Huge specs → attach caps, row caps, $ref guards, detail
on demand. YAML → honest refusal + docs fallback. Credential leakage → scheme names
only + prompt rule + review tiles. D-file collisions → strict ordering.

## Verification

Per phase: typecheck + typecheck:evals + npm test (files added to the explicit list).
J1 manual: attach/remove round-trip in the app. J2 manual: live build with spec shows
`api:`-tagged steps in review tiles. GJ: the scored eval above on this machine.
