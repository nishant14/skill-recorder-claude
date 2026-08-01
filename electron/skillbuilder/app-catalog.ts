import type { SkillArchitecture } from "../../common/skill";
import { copilotStudioCatalogue } from "./copilot-studio-catalog";

/**
 * A **static, versioned** snapshot of what a skill in *this app's* library may rely
 * on, embedded into the builder's system prompt. The in-app execution engine ships in
 * a later release, so this catalogue is deliberately a contract we can honour rather
 * than an inventory of a live harness: a shell on the user's own machine, local file
 * access, and web fetch — nothing hosted, nothing Microsoft 365-native.
 *
 * IMPORTANT: baseline capabilities only. Do NOT list skills or tools a particular
 * machine might happen to have; a generated skill can only rely on what every install
 * gives it. Refresh this when the runner (Workstream H) grows real capabilities.
 */
export const APP_CATALOGUE_VERSION = "2026-08-01";

/**
 * The reusable core of the app catalogue: the capability ladder and the
 * recorded-action→capability mapping. Shared by the Skill Builder and the Automation
 * Builder (their preambles/tails differ, but both prefer these same capabilities).
 */
export const APP_NATIVE_CAPABILITIES = `
## Where this runs, and the capabilities to PREFER

The artifact is stored in **this app's own library** and executed by an agent on the
**user's own device — macOS, Windows, or Ubuntu**, not a sandbox: it has a real shell
and whatever command-line tools the user has installed (e.g. the \`gh\` GitHub CLI,
\`git\`, cloud CLIs), local file access, and web fetch. The execution engine arrives in
a later release, so what you write must be **self-contained prose** an agent with a
shell and web access can follow end to end — never lean on a built-in office skill, a
hosted connector, or a Microsoft 365 service tool, because none of those exist here.

Prefer a real API or first-class **CLI** over replaying a web UI. Reach for these in order:

1. **Files and the web (the baseline tools).** \`view\` (read a file), \`glob\` (find
   files by pattern), \`grep\` (search file contents), \`write\` / \`edit\` (author or
   update a file), \`web_fetch\` (read a URL). These are how a skill DISCOVERS its
   inputs on the local OS or the public web instead of asking the user.
2. **The device shell + installed CLIs (\`bash\`).** When a service ships a first-class
   CLI, that CLI IS its native interface — prefer it over the browser. Above all:
   **GitHub → the \`gh\` CLI** (\`gh issue\`, \`gh pr\`, \`gh release\`, \`gh repo\`,
   \`gh api\`), already signed in on the device — never drive github.com through a
   browser. Likewise \`git\`, and the cloud/service CLIs the task used (\`az\`, \`aws\`,
   \`gcloud\`, \`kubectl\`, \`npm\`, \`docker\`). Write commands for the target OS — POSIX
   shell (zsh/bash) on **macOS** and **Ubuntu**, **PowerShell** on **Windows** (mind
   path and quoting differences). Gate the shell with an \`allowed-tools\` pattern
   scoped to the tool, e.g. \`Bash(gh *)\` or \`Bash(git *)\`.
3. **Documents and spreadsheets are files, not apps.** There is no built-in
   spreadsheet/deck/doc skill here. Read and write \`.xlsx\`, \`.csv\`, \`.docx\`,
   \`.pptx\`, and \`.pdf\` **directly as files** — a short script through the shell
   (Python/Node with the usual libraries), or convert to \`.csv\`/markdown first. Say
   which file and which sheet/section. Never script the Excel / Numbers / Word GUI.
4. **A web UI — the last resort.** ONLY for a service with no API and no CLI. There is
   no guaranteed browser-automation tool on this target, so write such a step as
   explicit prose (which page, which control, what to enter) and mark it as UI-driven
   so the user knows it needs a human or a browser the runner may not have.

> **No Microsoft 365 native tools in this release.** Teams, Outlook mail, Calendar, and
> SharePoint/OneDrive work has no first-class tool here: reach for a CLI or a
> documented HTTP API if one exists, otherwise write the step as a UI-driven one and
> say so plainly. Do not invent \`workiq_*\`, \`m365_*\`, \`outlook/*\`, or connector-style
> tool names — they do not exist on this target.

Assume ONLY the capabilities listed above. Do not depend on any skill, plugin, or
service integration being installed.

## Recorded action → capability (examples)

| Recording shows | Prefer |
| --- | --- |
| Opening / reading a local file or folder | \`view\` / \`glob\` / \`grep\` |
| Writing or updating a local file | \`write\` / \`edit\` |
| Reading a public web page | \`web_fetch\` |
| Acting on GitHub — issues, PRs, releases, repos, gists, Actions | the \`gh\` CLI via \`Bash(gh *)\` (\`gh issue\`, \`gh pr\`, \`gh release\`, \`gh api\`) — never the browser |
| Running git, cloud, or package operations | the matching CLI via the shell (\`git\`, \`az\`/\`aws\`/\`gcloud\`, \`npm\`, \`docker\`) |
| Editing a spreadsheet / doc / deck / reading a PDF | open the \`.xlsx\` / \`.csv\` / \`.docx\` / \`.pptx\` / \`.pdf\` file itself via a shell script — not the desktop app |
| Reading mail, chats, or a calendar | no native tool: use a CLI or HTTP API if the service has one, else write it as an explicit UI-driven step |
| Filling a form on a web app with no API or CLI | spell the UI steps out as prose and flag the step as UI-driven |
`.trim();

const APP_CATALOGUE = `
# Target: this app's skill library — capability catalogue

An app **skill** is a \`SKILL.md\` file: optional YAML frontmatter followed by a
markdown **instructions body**. The app stores it in its own library
(\`~/.skill-recorder/skills/<name>/SKILL.md\`) and the runner shipping in a later
release loads it from there.

Frontmatter fields:
- \`name\` — kebab-case, \`^[a-z0-9-]+$\`.
- \`description\` — one line of trigger keywords (when the agent should reach for this skill).
- \`allowed-tools\` (optional) — a YAML list of tool patterns the skill may use, e.g.
  \`Bash(git *)\`, \`Read\`, \`Write\`, \`Grep\`, \`Glob\`. Omit it to allow the default set.

The body is plain instructions written TO the agent (imperative voice): when to use
the skill, the procedure to follow, and how to handle inputs and edge cases.

${APP_NATIVE_CAPABILITIES}

## Writing the SKILL.md body

- Write a GENERALIZED procedure: if the recording acted on N specific items, the body
  loops over ALL items of that kind, not the specific examples that were recorded.
- Resolve each input via the plan (a fixed value / the user provides it / the agent locates it on the device).
- Be self-contained: the runner ships later, so the body must carry every command,
  path, and decision rule the agent needs — no "use the built-in X skill" shortcuts.
- Keep it concise and imperative. Include a short "When to use" and the ordered steps.
`.trim();

/** The catalogue for a target architecture, or null if none is available yet. */
export function catalogueFor(architecture: SkillArchitecture): string | null {
  switch (architecture) {
    case "app":
      return APP_CATALOGUE;
    case "copilot-studio":
      return copilotStudioCatalogue();
    default:
      return null;
  }
}
