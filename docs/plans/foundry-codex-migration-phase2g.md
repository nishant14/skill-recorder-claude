# Phase 2G in detail — Workstream G: Copilot Studio declarative agent bundles

Parent plan: [`foundry-codex-migration.md`](./foundry-codex-migration.md) (Workstream G) · Tracker: [`progress.md`](./progress.md)
Status: **approved — implementing**

## Scope and definition of done

Copilot Studio skill exports stop being instruction prose alone: alongside the readable
`SKILL.md` (and Workstream J's `api/` folder), the export writes a **declarative agent
bundle** — `declarativeAgent.json`, a Teams/M365 app `manifest.json`, icons, a
`connectors.md` actions-to-configure checklist, and a ready-to-import
**`<name>-agent.zip`**. Rendering is **deterministic** (engine-rendered from the built
skill; no extra agent turn). Done = unit suite green; gate **GG** = ① offline tests,
② local bundle validation (structure, limits, zip contents), ③ a **real import into
Copilot Studio** (user-run — the acceptance test the decision log demands; a schema
rejection there is fixed by bumping one pinned constant).

Explicitly still out (per the parent plan): API-plugin/OpenAPI *action definitions*
inside the manifest and topic YAML — the custom-connector path remains "import
`api/openapi.json` manually", listed in `connectors.md`. Automations get `connectors.md`
only (declarative-agent manifests carry no triggers; the existing recreate-as-trigger
copy stands).

## G1. `common/declarative-agent.ts` (new; zod + pure, renderer-safe)

- **Pinned schema constants** (the single place a Copilot Studio rejection gets fixed):
  `DECLARATIVE_AGENT_SCHEMA_VERSION = "v1.2"` (conservative GA pin; `$schema` URL derived
  from it), `MAX_INSTRUCTIONS_CHARS = 8000`, `MAX_NAME_CHARS = 100`,
  `MAX_DESCRIPTION_CHARS = 1000`, `MAX_CONVERSATION_STARTERS = 4`. A why-comment states
  gate GG ③'s import test validates the pin and that bumping it is the whole upgrade.
- `renderDeclarativeAgent(skill: BuiltSkill): { agent: DeclarativeAgentJson;
  warnings: string[] }`:
  - `name`/`description` from the built skill (clamped, warning on clamp).
  - `instructions`: the SKILL.md body (values already substituted at export time) with a
    short preamble naming the agent's purpose; clamped to 8000 with a **step-boundary**
    truncation + warning (never mid-sentence).
  - `conversation_starters`: derived deterministically — one from the skill description
    (trigger phrasing), one per leading action-step title, capped at 4.
  - `capabilities`: keyword-mapped from steps/allowedTools — any web-read vocabulary →
    `WebSearch`; SharePoint/OneDrive mentions → `OneDriveAndSharePoint` (no URLs — the
    maker scopes it); nothing else auto-mapped in v1.
- `renderConnectorsMd(skill): string` — the manual-wiring checklist: one row per
  `Connector.Action` entry in `allowedTools` (connector, action, the step(s) using it,
  the `{{value}}`-derived literals feeding it); when `skill.apiReference` is set, a
  **Custom connector** section: import `api/openapi.json` first, then wire the listed
  `api:<operationId>` actions.
- `renderTeamsManifest(skill): TeamsManifestJson` — minimal M365 app manifest
  (`manifestVersion` pinned beside the agent schema pin, `copilotAgents.declarativeAgents
  [{ id, file: "declarativeAgent.json" }]`, generated stable `id` (UUID v5-style from the
  skill name — deterministic, no randomness per CLAUDE conventions), placeholder
  developer block naming the app, icon file references `color.png`/`outline.png`).

## G2. Export wiring — `electron/skillbuilder/builder.ts`

When `architecture === "copilot-studio"`, `exportSkill`/`exportSkillTo` additionally
write into the skill folder: `declarativeAgent.json`, `manifest.json`, `connectors.md`,
`color.png` (192×192) + `outline.png` (32×32) — both produced from `build/icon.png` via
**sharp** (already a dependency, already used in main) — then a `<slug>-agent.zip`
containing exactly `manifest.json`, `declarativeAgent.json`, `color.png`, `outline.png`
via **archiver** (already a dependency; mirror `debug-bundle.ts`'s usage). Render
warnings surface through the existing progress emitter and are appended to
`connectors.md` under "Notes". `SKILL.md` and the `api/` folder are unchanged;
`BuiltSkill` schema is unchanged (the bundle is derived output). App-architecture
exports are untouched.

## G3. Done-screen copy — `src/Library.tsx`

Copilot Studio skill done view: name the zip ("Import `<slug>-agent.zip` in Copilot
Studio (or the Microsoft 365 Agents Toolkit), then configure the actions in
`connectors.md`"); when API-grounded, prepend the custom-connector import step. Keep
edits surgical on the existing branch from D/J3.

## G4. Catalog nudge — `electron/skillbuilder/copilot-studio-catalog.ts`

One short paragraph: name web/SharePoint knowledge needs explicitly in steps (they map
to agent *capabilities* in the exported manifest) and keep `allowed-tools` strictly
`Connector.Action`-shaped — the export renders both deterministically. No other prompt
changes.

## G5. Tests (offline; append to the explicit `test` list)

**`common/declarative-agent.test.ts`** — limits + clamp warnings, step-boundary
truncation, starter derivation + cap, capability keyword mapping (web / SharePoint /
neither), connectors.md rows from `Connector.Action` entries, the custom-connector
section keyed on `apiReference`, deterministic manifest id (same input ⇒ same id),
schema-pin constants exported. **Extend `electron/skillbuilder/export.test.ts`** —
copilot-studio export writes all five bundle files + the zip; zip entries verified with
`adm-zip` (already a devDependency); app-architecture export writes none of them; a
skill with `apiReference` gets the custom-connector section. Icon generation may be
seam-stubbed if sharp is heavy in tests (assert the calls, not the pixels).

## Gate GG

① Unit suite green. ② Local: a scripted end-to-end export of the fixture-built skill
(inside the export test) — bundle structure, JSON parse, limits, zip listing. ③ **User:**
import the produced `<slug>-agent.zip` into Copilot Studio / M365 Agents Toolkit; if the
platform rejects the schema version, bump `DECLARATIVE_AGENT_SCHEMA_VERSION` (+ manifest
pin) — that constant is the entire compatibility surface, by design.

## Sequencing

One subagent stage (G is compact); then tracker/docs close-out. After G, every
workstream on the board is implemented; remaining items are exclusively user-run gates.
