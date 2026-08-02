import assert from "node:assert/strict";
import test from "node:test";

import {
  agentZipName,
  capabilitiesFor,
  DECLARATIVE_AGENT_SCHEMA_URL,
  DECLARATIVE_AGENT_SCHEMA_VERSION,
  MAX_CONVERSATION_STARTERS,
  MAX_DESCRIPTION_CHARS,
  MAX_INSTRUCTIONS_CHARS,
  MAX_NAME_CHARS,
  renderConnectorsMd,
  renderDeclarativeAgent,
  renderTeamsManifest,
  TEAMS_MANIFEST_VERSION,
} from "./declarative-agent";
import { BuiltSkillSchema, type BuiltSkill } from "./skill";

/**
 * The declarative agent bundle is *derived* output: same built skill in, same bytes out,
 * no agent turn. These tests pin the three things a Copilot Studio import can reject us
 * for — the schema pins, the platform limits, and the manifest id's stability — plus the
 * two judgement calls the render makes on the maker's behalf (capability mapping and the
 * connectors checklist).
 */

function skill(over: Partial<BuiltSkill> = {}): BuiltSkill {
  return BuiltSkillSchema.parse({
    version: 1,
    sessionId: "20260801-090000-abc123",
    architecture: "copilot-studio",
    name: "email-weekly-digest",
    description: "Email the weekly project digest to the leads distribution list.",
    allowedTools: ["Outlook.SendEmail", "Teams.GetMessages"],
    body: "## When to use\n\nEvery Friday.\n\n## Steps\n\n1. Collect updates from {{channel}}.\n2. Send the digest.",
    values: [{ id: "channel", name: "Updates channel", value: "Contoso/Project-Updates" }],
    plan: {
      architecture: "copilot-studio",
      name: "email-weekly-digest",
      title: "Email the weekly digest",
      description: "Email the weekly project digest to the leads distribution list.",
      values: [{ id: "channel", name: "Updates channel", value: "Contoso/Project-Updates" }],
      steps: [
        {
          kind: "calculation",
          title: "Collect updates",
          text: "Read this week's posts in {{channel}}.",
          tool: "Teams.GetMessages",
        },
        {
          kind: "action",
          title: "Send the digest",
          text: "Send the digest email to the leads list.",
          tool: "Outlook.SendEmail",
        },
      ],
      allowedTools: ["Outlook.SendEmail", "Teams.GetMessages"],
    },
    apiReference: null,
    createdAt: 1_775_000_000_000,
    ...over,
  });
}

test("the pinned schema constants are exported and drive the $schema url", () => {
  assert.equal(DECLARATIVE_AGENT_SCHEMA_VERSION, "v1.2");
  assert.equal(TEAMS_MANIFEST_VERSION, "1.19");
  assert.equal(MAX_INSTRUCTIONS_CHARS, 8000);
  assert.equal(MAX_NAME_CHARS, 100);
  assert.equal(MAX_DESCRIPTION_CHARS, 1000);
  assert.equal(MAX_CONVERSATION_STARTERS, 4);
  assert.ok(DECLARATIVE_AGENT_SCHEMA_URL.includes(`/${DECLARATIVE_AGENT_SCHEMA_VERSION}/`));
  const { agent } = renderDeclarativeAgent(skill());
  assert.equal(agent.version, DECLARATIVE_AGENT_SCHEMA_VERSION);
  assert.equal(agent.$schema, DECLARATIVE_AGENT_SCHEMA_URL);
});

test("instructions carry a preamble and the values-substituted body", () => {
  const { agent, warnings } = renderDeclarativeAgent(skill());
  assert.equal(warnings.length, 0);
  assert.ok(agent.instructions.startsWith('You are the "Email the weekly digest" agent.'));
  assert.ok(agent.instructions.includes("Collect updates from Contoso/Project-Updates."));
  // The token itself must never reach the maker's Instructions.
  assert.equal(agent.instructions.includes("{{channel}}"), false);
});

test("name and description are clamped with a warning", () => {
  const { agent, warnings } = renderDeclarativeAgent(
    skill({
      description: "d".repeat(MAX_DESCRIPTION_CHARS + 50),
      plan: { ...skill().plan!, title: "T".repeat(MAX_NAME_CHARS + 20) },
    }),
  );
  assert.equal(agent.name.length, MAX_NAME_CHARS);
  assert.equal(agent.description.length, MAX_DESCRIPTION_CHARS);
  assert.equal(warnings.length, 2);
  assert.ok(warnings.some((w) => w.startsWith("The agent name")));
  assert.ok(warnings.some((w) => w.startsWith("The agent description")));
});

test("over-long instructions are truncated at a step boundary, inside the limit", () => {
  const step = (n: number) => `## Step ${n}\n\nDo the ${n}th thing, carefully and completely.\n`;
  const body = Array.from({ length: 400 }, (_, i) => step(i + 1)).join("\n");
  const { agent, warnings } = renderDeclarativeAgent(skill({ body }));
  assert.ok(agent.instructions.length <= MAX_INSTRUCTIONS_CHARS);
  assert.ok(warnings.some((w) => w.includes("truncated at a step boundary")));
  assert.ok(agent.instructions.includes("the full procedure is in SKILL.md"));
  // Cut on a boundary: the kept text ends with a finished step, not half a sentence.
  const kept = agent.instructions.split("\n\n_Instructions were truncated")[0];
  assert.ok(kept.trimEnd().endsWith("carefully and completely."));
});

test("conversation starters come from the description then the action steps, capped", () => {
  const { agent } = renderDeclarativeAgent(skill());
  assert.deepEqual(
    agent.conversation_starters.map((s) => s.title),
    ["Email the weekly digest", "Send the digest"],
  );
  assert.equal(agent.conversation_starters[0].text, agent.description);
  // Calculation steps never become starters.
  assert.equal(
    agent.conversation_starters.some((s) => s.title === "Collect updates"),
    false,
  );

  const base = skill();
  const many = skill({
    plan: {
      ...base.plan!,
      steps: Array.from({ length: 8 }, (_, i) => ({
        kind: "action" as const,
        title: `Action ${i + 1}`,
        text: `Perform action ${i + 1}.`,
        tool: "",
      })),
    },
  });
  const capped = renderDeclarativeAgent(many).agent.conversation_starters;
  assert.equal(capped.length, MAX_CONVERSATION_STARTERS);
});

test("capabilities are keyword-mapped conservatively", () => {
  const base = skill();
  const withSteps = (tool: string, text: string, tools: string[] = []): BuiltSkill =>
    skill({
      allowedTools: tools,
      plan: { ...base.plan!, allowedTools: tools, steps: [{ kind: "action", title: "Do it", text, tool }] },
    });

  assert.deepEqual(capabilitiesFor(withSteps("web_fetch", "Look it up.")), ["WebSearch"]);
  assert.deepEqual(capabilitiesFor(withSteps("", "Search the web for the release notes.")), [
    "WebSearch",
  ]);
  assert.deepEqual(capabilitiesFor(withSteps("", "Open the URL from the ticket.")), ["WebSearch"]);
  assert.deepEqual(capabilitiesFor(withSteps("", "Read the file.", ["HTTP.Invoke"])), ["WebSearch"]);
  assert.deepEqual(capabilitiesFor(withSteps("SharePoint.GetFileContent", "Open the sheet.")), [
    "OneDriveAndSharePoint",
  ]);
  // Case-insensitive, and OneDrive counts too.
  assert.deepEqual(capabilitiesFor(withSteps("", "Save it to OneDrive.")), [
    "OneDriveAndSharePoint",
  ]);
  assert.deepEqual(capabilitiesFor(withSteps("", "Fetch the page from the intranet SHAREPOINT site.")), [
    "WebSearch",
    "OneDriveAndSharePoint",
  ]);
  // Nothing else is auto-mapped: an Outlook/Dataverse skill gets no capabilities.
  assert.deepEqual(
    capabilitiesFor(withSteps("Outlook.SendEmail", "Send the summary.", ["Dataverse.ListRows"])),
    [],
  );
  assert.deepEqual(renderDeclarativeAgent(skill()).agent.capabilities, []);
});

test("the manifest id is deterministic, UUID-shaped, and per-skill", () => {
  const a = renderTeamsManifest(skill());
  const b = renderTeamsManifest(skill({ createdAt: 1 }));
  assert.equal(a.id, b.id);
  assert.match(a.id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(a.id, renderTeamsManifest(skill({ name: "other-skill" })).id);
});

test("the manifest points at the declarative agent and the icon files", () => {
  const manifest = renderTeamsManifest(skill());
  assert.equal(manifest.manifestVersion, TEAMS_MANIFEST_VERSION);
  assert.deepEqual(manifest.copilotAgents.declarativeAgents, [
    { id: "declarativeAgent", file: "declarativeAgent.json" },
  ]);
  assert.deepEqual(manifest.icons, { color: "color.png", outline: "outline.png" });
  assert.equal(manifest.packageName, "com.skillrecorder.emailweeklydigest");
  assert.ok(manifest.name.short.length <= 30);
  assert.ok(manifest.description.short.length <= 80);
});

test("connectors.md lists one row per Connector.Action, with steps and values", () => {
  const md = renderConnectorsMd(skill());
  assert.ok(md.includes("| Connector | Action | Used by | Values it is given |"));
  assert.ok(md.includes("| Outlook | SendEmail | 2. Send the digest | — |"));
  assert.ok(
    md.includes("| Teams | GetMessages | 1. Collect updates | Updates channel: `Contoso/Project-Updates` |"),
  );
  assert.ok(md.includes("keep secrets out of"));
  assert.ok(md.includes("email-weekly-digest-agent.zip"));
  assert.equal(md.includes("## Custom connector"), false);
  assert.equal(md.includes("## Notes"), false);
});

test("connectors.md sorts non-Connector.Action entries into their own sections", () => {
  const md = renderConnectorsMd(
    skill({ allowedTools: ["Outlook.SendEmail", "api:createSalesOrder", "Bash(gh *)", "web_fetch"] }),
    ["Something was clamped."],
  );
  assert.ok(md.includes("| Outlook | SendEmail |"));
  assert.equal(md.includes("| Bash |"), false);
  assert.ok(md.includes("## Other declared tools"));
  assert.ok(md.includes("- `Bash(gh *)`"));
  assert.ok(md.includes("- `web_fetch`"));
  // No apiReference on this skill, so `api:` entries are simply not rendered as rows.
  assert.equal(md.includes("| api |"), false);
  assert.ok(md.includes("## Notes"));
  assert.ok(md.includes("- Something was clamped."));
});

test("an API-grounded skill gets the custom-connector section", () => {
  const md = renderConnectorsMd(
    skill({
      allowedTools: ["Outlook.SendEmail", "api:createSalesOrder"],
      apiReference: { operations: ["createSalesOrder"], specFile: "api/openapi.json" },
    }),
  );
  assert.ok(md.includes("## Custom connector"));
  assert.ok(md.includes("`api/openapi.json`"));
  assert.ok(md.includes("- `createSalesOrder`"));
});

test("the zip is named after the skill slug", () => {
  assert.equal(agentZipName(skill()), "email-weekly-digest-agent.zip");
  assert.equal(agentZipName(skill({ name: "Weird Name!" })), "weird-name-agent.zip");
});
