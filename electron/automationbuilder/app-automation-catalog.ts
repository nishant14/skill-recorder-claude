import type { SkillArchitecture } from "../../common/skill";
import { APP_NATIVE_CAPABILITIES } from "../skillbuilder/app-catalog";
import { copilotStudioAutomationCatalogue } from "./copilot-studio-automation-catalog";

/**
 * The Automation Builder's catalogue for **this app's** automation library. Reuses the
 * shared capability snapshot ({@link APP_NATIVE_CAPABILITIES}) but frames it for
 * **automations** — a scheduled/condition trigger plus ordered steps, where each step
 * is a natural-language **prompt** to the agent (not a `SKILL.md` procedure). Refresh
 * alongside the skill catalogue when the runner (Workstream H) grows capabilities.
 */
export const APP_AUTOMATION_CATALOGUE_VERSION = "2026-08-01";

const APP_AUTOMATION_CATALOGUE = `
# Target: this app's automation library — capability catalogue

An app **automation** is a **trigger** plus an ordered list of **steps**. The app's
scheduler runs the steps in order on the trigger; each step is a natural-language
**prompt** an agent executes with the capabilities below. Automations are saved to
this app's own library (\`~/.skill-recorder/automations/<name>/automation.json\`) — the
scheduler and runner that execute them ship in a later release, so the prompts must be
self-contained enough for an agent with a shell and web access to follow unattended.

## Trigger

- **schedule** (default) — the automation runs on a clock. Express it as natural language
  such as: "every weekday at 9am", "daily at 8:30am", "every day at 9am, 2pm, and 6pm",
  "every 30 minutes", or "every hour at :15". The three shapes are:
  - **single** — one time of day (optionally only on some weekdays).
  - **interval** — every N minutes (N must divide 1440 evenly), from an anchor time.
  - **multi** — several fixed times of day.
- **condition** — the automation checks a natural-language condition on a cadence and only
  runs when it's true (e.g. "when a new CSV appears in ~/Downloads"). Use this only when the
  recording clearly implies an event trigger; otherwise prefer a schedule.

A recording captures ONE run of the task and usually has NO "when to run" signal — so you
must PROPOSE a sensible default schedule (state your assumption) and let the user correct it
in plain language.

## Steps — each is a prompt

- Break the generalized task into a few ordered steps. Each step has a short **label** and a
  **prompt** — an imperative instruction to the agent for that part of the task.
- Write prompts that GENERALIZE: if the recording acted on N specific items, the prompt tells
  the agent to handle every item of that kind, not the specific examples recorded.
- Prompts should prefer the capabilities below over UI replay, and say briefly why.
- Name the CONCRETE command or tool in the prompt, not just the tool family: "run
  \`gh pr list --repo {{repo}}\`" executes unambiguously at run time, while "use the
  GitHub CLI" leaves the agent to rediscover the invocation. Same for web reads
  (\`web_fetch\` the URL) and file writes (name the format and path).
- Self-resolving prompts: reference a genuinely fixed literal by its \`{{id}}\` value token,
  and for anything that varies tell the agent to locate it on the device or fetch it from the
  web. An unattended automation can't stop to ask a human, so never depend on a user-provided
  value — and never on a step a person has to click through.
- Keep destructive or send/create actions explicit so the user sees them in the plan.

${APP_NATIVE_CAPABILITIES}

## Writing the automation

- Propose a trigger (a schedule by default) and 2–6 generalized, capability-first steps.
- Prefer a CLI (e.g. \`gh\` for GitHub) or a direct file/web read over any UI; a step that
  genuinely needs a UI cannot run unattended, so redesign it around an API or call it out.
- Give the automation a clear \`description\` of what it does and when it runs.
`.trim();

/** The automation catalogue for a target architecture, or null if unavailable. */
export function automationCatalogueFor(architecture: SkillArchitecture): string | null {
  switch (architecture) {
    case "app":
      return APP_AUTOMATION_CATALOGUE;
    case "copilot-studio":
      return copilotStudioAutomationCatalogue();
    default:
      return null;
  }
}
