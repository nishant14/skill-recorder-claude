import { z } from "zod";

import { slugifySkillName, type BuiltSkill } from "./skill";
import { renderValues, tokenIds, type Value } from "./values";

/**
 * Deterministic renderers that turn a {@link BuiltSkill} into the files a **Copilot
 * Studio declarative agent** bundle is made of: `declarativeAgent.json`, the Teams /
 * M365 app `manifest.json`, and the `connectors.md` wiring checklist. No agent turn is
 * involved — the built skill already holds everything, so the same input always renders
 * the same bytes (the export test relies on that, and so does re-exporting a skill).
 *
 * Renderer-safe on purpose: zod + pure functions only, no Node imports. The zip and the
 * icons are the main process's job (`electron/skillbuilder/builder.ts`); this module
 * owns the *content*.
 *
 * Non-goals (per the migration plan): API-plugin / OpenAPI action definitions inside the
 * manifest, and topic YAML. A custom connector stays a manual import, called out in
 * `connectors.md`.
 */

/**
 * The pinned platform contract — **the entire compatibility surface of this feature**.
 * Gate GG ③ is a real import into Copilot Studio / the M365 Agents Toolkit; if the
 * platform rejects the bundle's schema, bumping these two constants (and re-running the
 * import) is the whole upgrade. Nothing else here encodes a platform version.
 */
export const DECLARATIVE_AGENT_SCHEMA_VERSION = "v1.2";
/** M365 app manifest version carrying `copilotAgents.declarativeAgents`. */
export const TEAMS_MANIFEST_VERSION = "1.19";

/** `$schema` URLs derived from the pins above, so the two can never drift apart. */
export const DECLARATIVE_AGENT_SCHEMA_URL =
  `https://developer.microsoft.com/json-schemas/copilot/declarative-agent/${DECLARATIVE_AGENT_SCHEMA_VERSION}/schema.json`;
export const TEAMS_MANIFEST_SCHEMA_URL =
  `https://developer.microsoft.com/en-us/json-schemas/teams/v${TEAMS_MANIFEST_VERSION}/MicrosoftTeams.schema.json`;

/** Platform limits the render clamps to (a rejected bundle is worse than a clipped one). */
export const MAX_INSTRUCTIONS_CHARS = 8000;
export const MAX_NAME_CHARS = 100;
export const MAX_DESCRIPTION_CHARS = 1000;
export const MAX_CONVERSATION_STARTERS = 4;

/** Manifest-side limits (shorter than the agent's; clamped silently — same text, cut). */
const MAX_MANIFEST_SHORT_NAME = 30;
const MAX_MANIFEST_FULL_NAME = 100;
const MAX_MANIFEST_SHORT_DESCRIPTION = 80;
const MAX_MANIFEST_FULL_DESCRIPTION = 4000;

/** Icon file names referenced by the manifest and packed into the zip. */
export const AGENT_COLOR_ICON = "color.png";
export const AGENT_OUTLINE_ICON = "outline.png";
export const AGENT_COLOR_ICON_SIZE = 192;
export const AGENT_OUTLINE_ICON_SIZE = 32;
/** The declarative agent file the manifest points at. */
export const DECLARATIVE_AGENT_FILE = "declarativeAgent.json";
export const TEAMS_MANIFEST_FILE = "manifest.json";
export const CONNECTORS_DOC_FILE = "connectors.md";

/** Exactly the entries the importable zip carries, in this order. */
export const AGENT_ZIP_ENTRIES = [
  TEAMS_MANIFEST_FILE,
  DECLARATIVE_AGENT_FILE,
  AGENT_COLOR_ICON,
  AGENT_OUTLINE_ICON,
] as const;

/** `<slug>-agent.zip` — the file the maker imports. */
export function agentZipName(skill: BuiltSkill): string {
  return `${slugifySkillName(skill.name)}-agent.zip`;
}

/**
 * The two capabilities v1 maps automatically. Everything else a maker scopes by hand:
 * we cannot know their tenant's sites, connections, or data sources from a recording,
 * and a wrong capability is a support call, not a convenience.
 */
export const AgentCapabilityName = z.enum(["WebSearch", "OneDriveAndSharePoint"]);
export type AgentCapabilityName = z.infer<typeof AgentCapabilityName>;

export const DeclarativeAgentSchema = z.object({
  $schema: z.string(),
  version: z.string(),
  name: z.string().max(MAX_NAME_CHARS),
  description: z.string().max(MAX_DESCRIPTION_CHARS),
  instructions: z.string().max(MAX_INSTRUCTIONS_CHARS),
  conversation_starters: z
    .array(z.object({ title: z.string(), text: z.string() }))
    .max(MAX_CONVERSATION_STARTERS),
  capabilities: z.array(z.object({ name: AgentCapabilityName })),
});
export type DeclarativeAgentJson = z.infer<typeof DeclarativeAgentSchema>;

export const TeamsManifestSchema = z.object({
  $schema: z.string(),
  manifestVersion: z.string(),
  version: z.string(),
  id: z.string(),
  packageName: z.string(),
  developer: z.object({
    name: z.string(),
    websiteUrl: z.string(),
    privacyUrl: z.string(),
    termsOfUseUrl: z.string(),
  }),
  name: z.object({ short: z.string(), full: z.string() }),
  description: z.object({ short: z.string(), full: z.string() }),
  icons: z.object({ color: z.string(), outline: z.string() }),
  accentColor: z.string(),
  copilotAgents: z.object({
    declarativeAgents: z.array(z.object({ id: z.string(), file: z.string() })),
  }),
});
export type TeamsManifestJson = z.infer<typeof TeamsManifestSchema>;

// --- declarativeAgent.json ---------------------------------------------------

/**
 * Render the declarative agent definition. `warnings` carries everything the maker
 * should know about what the render had to change (clamps, truncation); the export
 * writes them into `connectors.md` under "Notes" and streams them as progress.
 */
export function renderDeclarativeAgent(skill: BuiltSkill): {
  agent: DeclarativeAgentJson;
  warnings: string[];
} {
  const warnings: string[] = [];
  const name = clamp(agentName(skill), MAX_NAME_CHARS, "The agent name", warnings);
  const description = clamp(
    skill.description.trim(),
    MAX_DESCRIPTION_CHARS,
    "The agent description",
    warnings,
  );
  const instructions = truncateInstructions(renderInstructions(skill, name, description), warnings);
  const agent = DeclarativeAgentSchema.parse({
    $schema: DECLARATIVE_AGENT_SCHEMA_URL,
    version: DECLARATIVE_AGENT_SCHEMA_VERSION,
    name,
    description,
    instructions,
    conversation_starters: conversationStarters(skill, description),
    capabilities: capabilitiesFor(skill).map((n) => ({ name: n })),
  });
  return { agent, warnings };
}

/** Display name for the agent: the plan's human title when there is one, else the slug. */
function agentName(skill: BuiltSkill): string {
  const title = skill.plan?.title?.trim();
  return title || skill.name;
}

/**
 * The Instructions the maker's agent runs on: a short preamble naming its purpose, then
 * the SKILL.md body with every `{{value}}` token substituted — exactly the substitution
 * `renderSkillMarkdown` performs, so the pasted instructions and the shipped SKILL.md
 * never disagree about a literal.
 */
function renderInstructions(skill: BuiltSkill, name: string, description: string): string {
  const purpose = description ? ` ${description}` : "";
  const preamble =
    `You are the "${name}" agent.${purpose}\n\n` +
    "Follow the procedure below. Use only the actions your maker has configured for you; " +
    "if one is missing or returns nothing, say so plainly instead of improvising.";
  return `${preamble}\n\n${renderValues(skill.body, skill.values).trim()}`.trim();
}

/** Notice appended *inside* the limit when instructions are cut (never mid-sentence). */
const TRUNCATION_NOTICE =
  "\n\n_Instructions were truncated to fit the Copilot Studio limit — the full procedure is in SKILL.md._";

/**
 * Clip long instructions at a **step boundary**: the last markdown heading or paragraph
 * break that still leaves room for the notice. Cutting mid-sentence would hand the agent
 * half a step, which is worse than handing it fewer whole steps.
 */
function truncateInstructions(text: string, warnings: string[]): string {
  if (text.length <= MAX_INSTRUCTIONS_CHARS) return text;
  const budget = MAX_INSTRUCTIONS_CHARS - TRUNCATION_NOTICE.length;
  const head = text.slice(0, budget);
  const boundary = Math.max(head.lastIndexOf("\n\n"), head.lastIndexOf("\n#"));
  // A boundary can land right after a heading whose body didn't fit; a dangling heading
  // promises a step we are not shipping, so drop it too.
  const kept = (boundary > 0 ? head.slice(0, boundary) : head)
    .trimEnd()
    .replace(/\n#{1,6}[^\n]*$/, "")
    .trimEnd();
  warnings.push(
    `The instructions were longer than ${MAX_INSTRUCTIONS_CHARS} characters and were truncated at a step boundary. ` +
      "Paste the missing steps from SKILL.md into the agent's Instructions, or split the skill.",
  );
  return `${kept}${TRUNCATION_NOTICE}`;
}

/**
 * Starters are derived, never invented: one from the description (which *is* the trigger
 * phrasing), then one per leading action step — the risky, visible things this agent does.
 * Calculation steps are skipped; nobody opens an agent to ask it to format a number.
 */
function conversationStarters(
  skill: BuiltSkill,
  description: string,
): { title: string; text: string }[] {
  const starters: { title: string; text: string }[] = [];
  const push = (title: string, text: string): void => {
    const t = clip(title.trim(), MAX_NAME_CHARS);
    const body = clip(text.trim(), MAX_DESCRIPTION_CHARS);
    if (!t || !body) return;
    if (starters.some((s) => s.title.toLowerCase() === t.toLowerCase())) return;
    starters.push({ title: t, text: body });
  };
  push(agentName(skill), description);
  for (const step of skill.plan?.steps ?? []) {
    if (step.kind !== "action") continue;
    push(step.title, renderValues(step.text, skill.values));
  }
  return starters.slice(0, MAX_CONVERSATION_STARTERS);
}

/** Web-read vocabulary → `WebSearch`. Deliberately literal: pinned by unit test. */
const WEB_KEYWORDS = ["web_fetch", "web access", "http", "fetch", "url", "search the web"];
/** Microsoft file-store vocabulary → `OneDriveAndSharePoint` (case-insensitive). */
const FILE_STORE_KEYWORDS = ["sharepoint", "onedrive"];

/**
 * Keyword-map the steps and `allowed-tools` onto agent capabilities. Conservative by
 * design: only these two, no URLs or site scoping (the maker owns that), and nothing
 * inferred from prose beyond the vocabularies above.
 */
export function capabilitiesFor(skill: BuiltSkill): AgentCapabilityName[] {
  const haystack = [
    ...(skill.plan?.steps ?? []).flatMap((s) => [s.title, s.text, s.tool]),
    ...skill.allowedTools,
  ]
    .join("\n")
    .toLowerCase();
  const names: AgentCapabilityName[] = [];
  if (WEB_KEYWORDS.some((k) => haystack.includes(k))) names.push("WebSearch");
  if (FILE_STORE_KEYWORDS.some((k) => haystack.includes(k))) names.push("OneDriveAndSharePoint");
  return names;
}

// --- manifest.json -----------------------------------------------------------

/**
 * Minimal M365 app manifest wrapping the declarative agent. The developer block is a
 * placeholder the maker replaces before publishing — `connectors.md` says so.
 */
export function renderTeamsManifest(skill: BuiltSkill): TeamsManifestJson {
  const slug = slugifySkillName(skill.name);
  const name = agentName(skill);
  const description = skill.description.trim() || name;
  return TeamsManifestSchema.parse({
    $schema: TEAMS_MANIFEST_SCHEMA_URL,
    manifestVersion: TEAMS_MANIFEST_VERSION,
    version: "1.0.0",
    id: stableAgentId(slug),
    packageName: `com.skillrecorder.${slug.replace(/-/g, "")}`,
    developer: {
      name: "Skill Recorder",
      websiteUrl: "https://example.com/skill-recorder",
      privacyUrl: "https://example.com/skill-recorder/privacy",
      termsOfUseUrl: "https://example.com/skill-recorder/terms",
    },
    name: { short: clip(name, MAX_MANIFEST_SHORT_NAME), full: clip(name, MAX_MANIFEST_FULL_NAME) },
    description: {
      short: clip(description, MAX_MANIFEST_SHORT_DESCRIPTION),
      full: clip(description, MAX_MANIFEST_FULL_DESCRIPTION),
    },
    icons: { color: AGENT_COLOR_ICON, outline: AGENT_OUTLINE_ICON },
    accentColor: "#0F6CBD",
    copilotAgents: {
      declarativeAgents: [{ id: "declarativeAgent", file: DECLARATIVE_AGENT_FILE }],
    },
  });
}

/**
 * A UUID-*shaped*, deterministic app id derived from the skill slug: re-exporting the
 * same skill must produce the same id, or the maker ends up with duplicate apps in their
 * tenant. Built from four FNV-1a passes over salted copies of the slug, then stamped with
 * the version/variant nibbles so it parses as a UUID.
 *
 * This is an **identifier, not cryptography** — FNV-1a is not collision-resistant and is
 * not meant to be. `node:crypto` is off the table (this module is renderer-safe) and
 * randomness is off the table (determinism is the point, per the repo's conventions).
 */
export function stableAgentId(slug: string): string {
  const hex = ["0", "1", "2", "3"].map((salt) => fnv1a(`${salt}:${slug}`)).join("");
  const chars = hex.split("");
  chars[12] = "5"; // version nibble: "name-based", which is what this is
  chars[16] = "8"; // RFC 4122 variant
  const s = chars.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

/** 32-bit FNV-1a over UTF-16 code units, byte by byte; returns 8 lowercase hex chars. */
function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    h = Math.imul(h ^ (code & 0xff), 0x01000193) >>> 0;
    h = Math.imul(h ^ ((code >>> 8) & 0xff), 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// --- connectors.md -----------------------------------------------------------

/** One `Connector.Action` entry from `allowed-tools`, with everything the maker needs. */
interface ConnectorRow {
  connector: string;
  action: string;
  entry: string;
  /** 1-based step numbers whose `tool` names this entry (or whose text mentions it). */
  steps: string[];
  values: Value[];
}

/**
 * The manual-wiring checklist. Instructions alone never grant an agent a tool, so this
 * is the file that turns an imported bundle into a working agent: which connector
 * actions to add, which steps use them, and which literals they will be fed.
 *
 * `warnings` are the render notes from {@link renderDeclarativeAgent}; the export passes
 * them through so the maker sees a clamp or truncation where they will act on it.
 */
export function renderConnectorsMd(skill: BuiltSkill, warnings: readonly string[] = []): string {
  const slug = slugifySkillName(skill.name);
  const { rows, apiEntries, others } = classifyTools(skill);
  const out: string[] = [
    `# Actions to configure — ${agentName(skill)}`,
    "",
    `Import \`${agentZipName(skill)}\` in Copilot Studio (or the Microsoft 365 Agents Toolkit),`,
    "then wire the actions below. The instructions in `declarativeAgent.json` name each",
    "action, but only you can grant the agent access to it.",
    "",
    "Before publishing, replace the placeholder `developer` block in `manifest.json`",
    "(name, website, privacy, and terms URLs) with your own.",
    "",
    "## Connector actions",
    "",
  ];
  if (rows.length) {
    out.push(
      "| Connector | Action | Used by | Values it is given |",
      "| --- | --- | --- | --- |",
    );
    for (const row of rows) {
      const steps = row.steps.length ? row.steps.join("; ") : "the instructions";
      const values = row.values.length
        ? row.values.map((v) => `${v.name || v.id}: \`${v.value}\``).join("; ")
        : "—";
      out.push(`| ${row.connector} | ${row.action} | ${steps} | ${values} |`);
    }
    out.push(
      "",
      "Those values are fixed literals baked into the instructions — keep secrets out of",
      "them and configure credentials on the connection itself.",
    );
  } else {
    out.push(
      "This skill declared no `Connector.Action` tools. Check the instructions for actions",
      "the agent will need, and add them to the agent in Copilot Studio.",
    );
  }
  if (skill.apiReference) {
    out.push(
      "",
      "## Custom connector",
      "",
      "This skill calls an API directly, so wire it up first:",
      "",
      `1. Import \`api/openapi.json\` (next to this file) as a **custom connector** in Power Apps / Power Automate.`,
      "2. Add the connector to the agent and enable these actions:",
      "",
    );
    const ops = apiEntries.length ? apiEntries : skill.apiReference.operations;
    for (const op of ops) out.push(`   - \`${op}\``);
    if (!ops.length) out.push("   - (the operations the instructions name)");
  }
  if (others.length) {
    out.push("", "## Other declared tools", "");
    out.push("Not `Connector.Action`-shaped — decide per entry whether it is a flow, a", "knowledge source, or a manual step:", "");
    for (const t of others) out.push(`- \`${t}\``);
  }
  if (warnings.length) {
    out.push("", "## Notes", "");
    for (const w of warnings) out.push(`- ${w}`);
  }
  out.push("", `Generated from the \`${slug}\` skill. Re-exporting the skill regenerates this file.`, "");
  return out.join("\n");
}

/**
 * Split `allowed-tools` three ways: dot-shaped `Connector.Action` entries become rows,
 * `api:` entries belong to the custom-connector section (Workstream J owns the spec),
 * and anything else is listed for the maker to judge — we never guess what it is.
 */
function classifyTools(skill: BuiltSkill): {
  rows: ConnectorRow[];
  apiEntries: string[];
  others: string[];
} {
  const rows: ConnectorRow[] = [];
  const apiEntries: string[] = [];
  const others: string[] = [];
  for (const raw of skill.allowedTools) {
    const entry = raw.trim();
    if (!entry) continue;
    if (/^api:/i.test(entry)) {
      const op = entry.slice(4).trim();
      if (op && !apiEntries.includes(op)) apiEntries.push(op);
      continue;
    }
    const dot = entry.indexOf(".");
    // `Connector.Action` only: a dot inside brackets (`Bash(git *)`) or no dot at all is
    // not a Copilot Studio action, and listing it as one would send the maker hunting.
    if (dot <= 0 || dot === entry.length - 1 || /[()\s]/.test(entry)) {
      if (!others.includes(entry)) others.push(entry);
      continue;
    }
    if (rows.some((r) => r.entry.toLowerCase() === entry.toLowerCase())) continue;
    rows.push({
      connector: entry.slice(0, dot),
      action: entry.slice(dot + 1),
      entry,
      ...stepsUsing(skill, entry),
    });
  }
  return { rows, apiEntries, others };
}

/** The steps that name an entry (by `tool` or by mention) and the values they carry. */
function stepsUsing(skill: BuiltSkill, entry: string): { steps: string[]; values: Value[] } {
  const needle = entry.toLowerCase();
  const steps: string[] = [];
  const values: Value[] = [];
  (skill.plan?.steps ?? []).forEach((step, idx) => {
    const tool = step.tool.trim().toLowerCase();
    const mentions = `${step.title}\n${step.text}`.toLowerCase().includes(needle);
    if (tool !== needle && !mentions) return;
    steps.push(`${idx + 1}. ${step.title.trim() || step.text.trim().slice(0, 60)}`);
    for (const id of tokenIds(`${step.title}\n${step.text}`)) {
      const value = skill.values.find((v) => v.id === id);
      if (value && !values.some((v) => v.id === value.id)) values.push(value);
    }
  });
  return { steps, values };
}

// --- shared helpers ----------------------------------------------------------

/** Hard cut, no warning — used where the platform limit is tighter than the agent's. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max).trimEnd();
}

/** Cut to `max` and tell the maker we did; a rejected bundle is worse than a clipped one. */
function clamp(text: string, max: number, label: string, warnings: string[]): string {
  if (text.length <= max) return text;
  warnings.push(`${label} was longer than ${max} characters and was shortened for Copilot Studio.`);
  return clip(text, max);
}
