# Phase 1d in detail — Workstream D: retarget outputs to Copilot Studio + the app

Parent plan: [`foundry-codex-migration.md`](./foundry-codex-migration.md) (Workstream D) · Tracker: [`progress.md`](./progress.md)
Status: **implemented — gate G3(D) passed live 3/3 (2026-08-01)**

## Scope and definition of done

Generated skills/automations stop targeting Scout/Cowork (Copilot-family agents) and
target **(a) Copilot Studio agents** (export-only bundles) and **(b) this app's own
library** (installed; executed by Workstream H's runner later). Persisted artifacts from
the Scout/Cowork era keep loading via schema migration. The per-automation `model` field
becomes engine-owned (audit gap). Done = typecheck/`typecheck:evals` 0; `npm test` green
including the new migration tests (these complete gate **G3** alongside C's manual
checklist); acceptance greps below; one live builder round per architecture (gate G3(D)
live check).

## D1. `common/skill.ts` — architectures, targets, migration

- `SkillArchitecture = z.enum(["app", "copilot-studio"])` wrapped in `z.preprocess`
  mapping persisted `"scout" → "app"` and `"cowork" → "copilot-studio"` (string-level,
  before enum validation; non-strings pass through untouched). Applies automatically
  everywhere the enum is referenced (`SkillPlanSchema`, `BuiltSkillSchema`,
  `common/automation.ts` schemas).
- `ARCHITECTURES`: `app` — label **"Skill Recorder (this app)"**, note "Runs from this
  app's own skill library. Execution engine ships in a later release."; `copilot-studio`
  — label **"Copilot Studio"**, note "Export a bundle you add to a Copilot Studio agent."
  Both `enabled: true`; the greyed "coming soon" card disappears.
- `TARGETS` (4 cards, all enabled, in this order):
  1. `skill`/`app` — "App skill" — on-demand skill installed into this app's library.
  2. `automation`/`app` — "App automation" — scheduled procedure saved to this app's
     library.
  3. `skill`/`copilot-studio` — "Copilot Studio skill" — exported bundle (download only).
  4. `automation`/`copilot-studio` — "Copilot Studio automation" — exported trigger
     bundle (download only).
- Comment sweep: `slugifySkillName`/`renderSkillMarkdown` docs say "the target agent",
  not Scout. **No change to the SKILL.md rendering itself** — frontmatter + body stays
  the format for both targets in Phase 1 (Workstream G upgrades Copilot Studio to
  declarative-agent bundles in Phase 2).

## D2. Roots and placement

- `electron/skillbuilder/builder.ts` `skillsRoot()` → `~/.skill-recorder/skills`
  (`SKILL_RECORDER_SKILLS_DIR` override kept) — doc comment: the app's own library,
  loaded by the Workstream H runner.
- `electron/automationbuilder/builder.ts` `automationsRoot()` →
  `~/.skill-recorder/automations` (`SKILL_RECORDER_AUTOMATIONS_DIR` kept).
- Placement rule (enforced in `SkillBuilder.create`): `"install"` valid only for
  `architecture === "app"`; a copilot-studio install request degrades to the export flow
  (defensive — the UI never offers it).

## D3. Capability catalogs (replace the three Scout/Cowork files)

Delete `electron/skillbuilder/scout-catalog.ts`, `cowork-catalog.ts`,
`electron/automationbuilder/scout-automation-catalog.ts`. Create:

- **`electron/skillbuilder/app-catalog.ts`** — `APP_CATALOGUE_VERSION` dated; describes
  the in-app agent: runs on the **user's own machine** (macOS/Windows/Ubuntu) with a
  real shell (`gh`, `git`, cloud CLIs), file read/write, and web fetch — carry over the
  Scout catalog's native-tool-first ladder minus WorkIQ/Scout-built-ins (no M365-native
  tools in Phase 1; M365 tasks go through web UIs or CLIs until the runner grows
  connectors). States plainly: skills are stored in the app's library; the execution
  engine arrives in a later release, so instructions must be self-contained prose an
  agent with shell+web can follow.
- **`electron/skillbuilder/copilot-studio-catalog.ts`** — describes a Copilot Studio
  agent's surface: instructions-driven orchestration; **connector actions first**
  (Outlook, Teams, SharePoint/OneDrive, Dataverse, HTTP/custom connectors), Power
  Automate flows for multi-step side effects, knowledge sources for retrieval, MCP
  tools; no local shell/filesystem — steps must never assume a local machine. The
  SKILL.md body is written to be pasted into the agent's **Instructions**; the
  `description` doubles as the trigger phrasing; `allowed-tools` lists the **connectors
  to configure** (named connector/action, e.g. `Outlook.SendEmail`, `HTTP.Invoke`) since
  instructions alone cannot grant tools.
- **`electron/automationbuilder/app-automation-catalog.ts`** and
  **`copilot-studio-automation-catalog.ts`** — automation flavors: `app` mirrors today's
  Scout automation guidance (schedule + NL prompt-steps, run by the app's scheduler with
  the runner, later phase); `copilot-studio` maps the trigger to a Copilot Studio
  **scheduled/event trigger** the maker recreates, steps as agent instructions,
  connector-first.
- `catalogueFor()` / `automationCatalogueFor()` switch on the new enum; unknown → null
  (unchanged error path, message updated: "Choose the app or Copilot Studio.").

## D4. Engine-owned automation `model` (audit gap)

- `electron/automationbuilder/tools.ts` — remove the `model` property from the
  `propose_automation_plan` parameters schema.
- `electron/automationbuilder/instructions.ts` — remove the model-override mention
  (~:104).
- `common/automation.ts` — keep `model` in all zod schemas (backward compat: persisted
  plans still parse); doc comment defines semantics per target: **omitted** for
  `copilot-studio` (`toAutomationImport` already skips falsy); for `app`, an optional
  Foundry **deployment name** reserved for the Workstream H runner. `renderAutomationJson`
  unchanged. De-Scout the module comments (`scheduleToScout` → keep function, rename
  comment to "the import schedule shape"; renaming the function itself is optional —
  prefer `scheduleToImport` with no behavior change).

## D5. Renderer

`src/Library.tsx` (all conditionals currently keyed on `"scout"`/`"cowork"` — ~:496,
:964-966, :1127-1161, :1403):
- Default chosen architecture → `"app"`.
- Placement: `architecture === "copilot-studio"` ⇒ export-only (the old cowork path);
  `"app"` ⇒ install default with export option (the old scout path).
- Done-screen copy: install → "Added to your skill library" (+ path); copilot-studio
  export → "Skill exported — add it to your Copilot Studio agent: paste the body into
  the agent's Instructions and configure the listed connectors."
- Automation done copy (:1403) → Copilot Studio: "Recreate this as a scheduled trigger
  in Copilot Studio using the steps in automation.json"; app: "Saved to your automation
  library."
- Target cards render from `TARGETS` (verify no hardcoded Scout/Cowork strings remain);
  `src/plan-edit.tsx` has no architecture strings (verified earlier) — confirm with grep.

## D6. Prompt/comment sweep (backend-neutral wording)

- `electron/skillbuilder/instructions.ts` (~:67 "Scout runs on the…") — architecture-
  neutral phrasing ("the target agent runs…" — the catalog supplies specifics).
- `electron/describer/instructions.ts` ×2 "Copilot CLI" self-references → "the agent" /
  current runtime wording (prompt-affecting: keep edits minimal and meaning-preserving).
- `electron/foundry/agent.ts` ×2 lineage comments ("mirrors the Copilot SDK's") → keep
  the historical note but phrase as past lineage, not present dependency.
- After D: `rg -i "scout|cowork" electron/ src/ common/ evals/` → zero hits;
  `rg -i "copilot" electron/ src/ common/` → only `copilot-studio` product-domain usage.

## D7. Evals

- `evals/builder/scenarios.ts`, `evals/skillbuilder/scenarios.ts`: `architecture: "app"`.
- `evals/builder/native-tool-scenarios.ts` + score rubrics: confirm they reward `gh`-CLI
  mapping (app catalog preserves that guidance); update any Scout-specific tool-name
  expectations.
- `evals/README.md` references updated.

## D8. Tests (new; append to the explicit `test` list)

**`common/skill.test.ts`** — migration: `"scout"` parses to `"app"` and `"cowork"` to
`"copilot-studio"` through `SkillPlanSchema` + `BuiltSkillSchema` (fixture JSON from the
old era); new values pass through; invalid strings still fail; `TARGETS`/`ARCHITECTURES`
integrity (4 enabled targets, ids ∈ enum); `renderSkillMarkdown` byte-stable for a fixture
(format unchanged).
**`common/automation.test.ts`** — same migration through `AutomationPlanSchema` +
`BuiltAutomationSchema`; `planToAutomationSubmission` with a legacy-architecture plan;
`toAutomationImport` omits falsy `model`.

## Gate G3(D)

- **CI-able:** the migration tests above + full suite green.
- **Live (this machine, credentialed):** one `npm run eval:skill -- --only=<slug>` and one
  `npm run eval:builder -- --only=<slug>` round against the codex deployment — proves the
  new catalogs produce plans (scored, not just parsed). Then G3 as a whole closes with
  C's manual checklist (the connection-form items were already exercised live on this box
  during the Linux work; the user confirms formally).

## Explicitly not in D

Declarative-agent bundles (Phase 2 G); the in-app runner (H); dependency/packaging
removal and README/marketing copy (E); `~/.copilot/*` legacy-dir cleanup on user machines
(never — we stop writing there, we don't delete).
