import { COPILOT_STUDIO_NATIVE_CAPABILITIES } from "../skillbuilder/copilot-studio-catalog";

/**
 * The Automation Builder's **Copilot Studio** catalogue. Reuses the shared capability
 * snapshot ({@link COPILOT_STUDIO_NATIVE_CAPABILITIES}) but frames it as a **trigger +
 * steps** the maker recreates in Copilot Studio: the exported bundle is a
 * specification, not something the app can install, so the trigger has to map onto a
 * scheduled or event trigger the maker configures themselves.
 */
export const COPILOT_STUDIO_AUTOMATION_CATALOGUE_VERSION = "2026-08-01";

const COPILOT_STUDIO_AUTOMATION_CATALOGUE = `
# Target: Copilot Studio agent — automation catalogue

The artifact is an **exported bundle** (\`automation.json\`) the maker uses to recreate
the behaviour in Copilot Studio. Nothing is installed automatically, so write the plan
as a specification a maker can follow: a **trigger** they configure and ordered
**steps** they paste into the agent's Instructions (or wire into a flow).

## Trigger — what the maker recreates

The trigger you propose maps onto a Copilot Studio **scheduled or event trigger**:
- **schedule** (default) — a recurrence the maker sets on the agent's trigger (or on a
  Power Automate flow that starts the agent). Express it as natural language such as
  "every weekday at 9am" or "every 30 minutes", plus the structured fields. The three
  shapes are **single** (one time of day), **interval** (every N minutes, N dividing
  1440 evenly, from an anchor), and **multi** (several fixed times a day).
- **condition** — an **event** trigger: something arrives or changes (a new email, a
  new SharePoint item, a Dataverse row update) and the agent runs. Use it only when the
  recording clearly implies an event, and name the connector event you mean so the
  maker knows which trigger to pick.

A recording captures ONE run and has NO "when to run" signal, so PROPOSE a sensible
default, state the assumption, and let the user correct it in plain language.

## Steps — instructions for the agent

- Each step has a short **label** and a **prompt** — an imperative instruction to the
  **Copilot Studio agent**, naming the connector action it should invoke.
- The agent runs unattended on the trigger, so every prompt must be self-resolving:
  reference a genuinely fixed literal by its \`{{id}}\` value token and have the agent
  retrieve everything else through a connector. Never depend on someone typing a value.
- Keep send/create/delete actions in their own explicit step so the maker sees exactly
  what the agent will do on their behalf before they publish it.
- Keep it to a few ordered steps (roughly 2–6); each prompt tight and imperative.

${COPILOT_STUDIO_NATIVE_CAPABILITIES}

## Writing the automation

- Propose the trigger (a schedule by default) and 2–6 generalized, connector-first steps.
- Name the connector action in each step so the \`description\` and the steps together
  tell the maker which connectors and flows to configure before publishing.
- Give the automation a clear \`description\` of what it does and when it runs.
`.trim();

/** The Copilot Studio automation catalogue. Exposed for {@link automationCatalogueFor}. */
export function copilotStudioAutomationCatalogue(): string {
  return COPILOT_STUDIO_AUTOMATION_CATALOGUE;
}
