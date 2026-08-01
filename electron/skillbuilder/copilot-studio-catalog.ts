/**
 * A **static, versioned** snapshot of what a **Copilot Studio** agent can be given,
 * embedded into the builder's system prompt. A maker's tenant is not introspectable
 * from here, so we catalogue the platform's *shapes* — instructions, connector
 * actions, Power Automate flows, knowledge sources, MCP tools — rather than a list of
 * tools we could call. Refresh when the platform's authoring surface changes.
 *
 * IMPORTANT: Copilot Studio agents run in the Microsoft cloud, NOT on the user's
 * machine. There is no shell, no local filesystem, and no browser to drive. Every
 * recorded UI step must land on a connector action, a flow, or an explicit manual
 * note — never on a command line.
 */
export const COPILOT_STUDIO_CATALOGUE_VERSION = "2026-08-01";

/**
 * The reusable core of the Copilot Studio catalogue: where the agent runs, the
 * capability ladder, and the recorded-action→capability mapping. Exported so the
 * automation flavour can share it (their preambles/tails differ).
 */
export const COPILOT_STUDIO_NATIVE_CAPABILITIES = `
## Where this runs, and the capabilities to PREFER

A **Copilot Studio** agent runs in the Microsoft cloud, inside a maker's environment.
It is **instructions-driven**: the agent reads its Instructions and decides which of
the tools the maker has configured to invoke. It has **no shell, no local filesystem,
and no browser** — it cannot run a command, open a file path, or click a web page. So
never write \`gh\`, \`git\`, \`az\`, \`bash\`, \`~/…\` paths, or "click"/"type" UI steps;
every recorded action has to become a configured tool call or an explicit manual note.

Reach for these in order:

1. **Connector actions — the first choice.** Microsoft and third-party connectors the
   maker adds to the agent, each an action invoked by name. The common ones:
   - **Outlook** — \`Outlook.GetEmails\`, \`Outlook.GetEmail\`, \`Outlook.SendEmail\`,
     \`Outlook.ReplyToEmail\`, \`Outlook.CreateEvent\`, \`Outlook.GetCalendarView\`,
     \`Outlook.FindMeetingTimes\`.
   - **Microsoft Teams** — \`Teams.PostMessageToChannel\`, \`Teams.PostMessageInChat\`,
     \`Teams.GetMessages\`, \`Teams.ListChannels\`.
   - **SharePoint / OneDrive** — \`SharePoint.GetFileContent\`, \`SharePoint.GetItems\`,
     \`SharePoint.CreateFile\`, \`SharePoint.UpdateItem\`, \`OneDrive.GetFileContent\`.
   - **Dataverse** — \`Dataverse.ListRows\`, \`Dataverse.GetRow\`, \`Dataverse.AddRow\`,
     \`Dataverse.UpdateRow\` (the store for business records in the environment).
   - **HTTP / custom connectors** — \`HTTP.Invoke\` (or a named custom connector action)
     for any REST API without a first-party connector. This is how a service that only
     has a CLI on a desktop is reached from an agent: call its **API**, not its CLI.
2. **Power Automate flows.** For a multi-step side effect, a transaction, or logic the
   agent shouldn't improvise, call a flow the maker publishes as an agent action
   (\`Flow.<FlowName>\`) and describe its inputs and outputs. Prefer a flow over a long
   chain of raw connector calls when the steps must succeed or fail together.
3. **Knowledge sources.** For retrieval — SharePoint sites and document libraries,
   Dataverse tables, public websites, uploaded files. Use these when a step *looks up*
   reference material rather than acting on a record.
4. **MCP tools.** When the maker has an MCP server connected, its tools appear as agent
   actions and are invoked the same way. Name the tool you expect and what it returns.

> **No local machine.** If a recorded step genuinely has no connector, flow, API, or
> knowledge source behind it, do NOT pretend the agent can do it: state it as a manual
> step the person completes, or as a connector the maker must build first.

Assume ONLY the shapes above. Never invent a tool the maker has not been told to
configure — the \`allowed-tools\` list below is precisely how you tell them.

## Recorded action → capability (examples)

| Recording shows | Prefer |
| --- | --- |
| Reading / searching Outlook mail | \`Outlook.GetEmails\` → \`Outlook.GetEmail\` |
| Sending or replying to email | \`Outlook.SendEmail\` / \`Outlook.ReplyToEmail\` |
| Checking a calendar / booking a meeting | \`Outlook.GetCalendarView\` / \`Outlook.FindMeetingTimes\` → \`Outlook.CreateEvent\` |
| Reading or posting in Teams | \`Teams.GetMessages\` / \`Teams.PostMessageToChannel\` |
| Opening a file in SharePoint or OneDrive | \`SharePoint.GetFileContent\` / \`OneDrive.GetFileContent\` |
| Reading or updating a business record | \`Dataverse.ListRows\` / \`Dataverse.UpdateRow\` |
| Acting on GitHub, Azure, or any dev service | its **REST API** via \`HTTP.Invoke\` or a custom connector — never a CLI |
| A multi-step side effect that must not half-apply | a **Power Automate flow** published as an agent action |
| Looking something up in docs, a site, or a library | a **knowledge source** the maker attaches |
| Driving a web app with no API | not possible for the agent — call it out as a manual step |
`.trim();

const COPILOT_STUDIO_CATALOGUE = `
# Target: Copilot Studio agent — capability catalogue

The artifact is an **exported bundle**, not an installed file: the app writes a
\`SKILL.md\` the maker opens and transfers into their agent in Copilot Studio. Write it
knowing exactly where each part lands:

- The **body** is pasted into the agent's **Instructions** — so it must read as
  instructions to that agent, in imperative voice, with no reference to files,
  folders, or this app.
- The **description** doubles as the **trigger phrasing** — when this agent (or a
  parent agent delegating to it) should invoke the behaviour. Put every "when to use"
  cue there.
- \`allowed-tools\` is the **list of connectors and actions the maker must configure**
  before the instructions can work — instructions alone cannot grant an agent a tool.
  Name each as \`Connector.Action\` (e.g. \`Outlook.SendEmail\`, \`Teams.PostMessageToChannel\`,
  \`Dataverse.ListRows\`, \`HTTP.Invoke\`, \`Flow.SubmitExpense\`), one per entry, and use
  the same names in the body so the two line up.

Frontmatter fields:
- \`name\` — kebab-case, \`^[a-z0-9-]+$\`.
- \`description\` — one line of trigger phrasing.
- \`allowed-tools\` — the connectors/actions to configure (see above).

${COPILOT_STUDIO_NATIVE_CAPABILITIES}

## Writing the SKILL.md body

- Write a GENERALIZED procedure: if the recording acted on N specific items, the
  instructions loop over ALL items of that kind, not the recorded examples.
- Address the Copilot Studio agent directly ("Retrieve the unread messages with
  \`Outlook.GetEmails\`, then for each one…"). Name the connector action per step.
- Resolve each input via the plan (a fixed value / the user supplies it in the
  conversation / the agent retrieves it through a connector). There is no local
  machine to look anything up on.
- Say what to do when an action returns nothing or fails, and keep any send/create/
  delete action explicit so the maker sees what the agent will do on their behalf.
- Keep it concise and imperative. Include a short "When to use" and the ordered steps.
`.trim();

/** The Copilot Studio catalogue. Exposed so {@link catalogueFor} can dispatch on it. */
export function copilotStudioCatalogue(): string {
  return COPILOT_STUDIO_CATALOGUE;
}
