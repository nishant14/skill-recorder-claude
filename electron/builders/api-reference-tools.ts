import { readFileSync } from "node:fs";

import {
  findOperation,
  normalizeApiRef,
  resolveOperationDetail,
  scoreChunks,
  type ApiOperation,
  type ApiReferenceSummary,
} from "../../common/api-reference";
import type { SkillArchitecture } from "../../common/skill";
import type { Tool } from "../foundry/agent";
import { loadIndex, specPath } from "./api-reference-store";

/**
 * The agent-facing view of a session's attached **API reference** — the tools a builder
 * uses to map an action step onto a concrete API operation instead of replaying a UI,
 * plus the system-prompt block that teaches the `api:` step-tool convention.
 *
 * Shaped after `read-tools.ts`: a factory bound to one session, returning plain
 * {@link Tool}s. The whole set is **absent** when nothing is attached — a builder with
 * no reference must not see tools that can only answer "nothing here", and the
 * documentation search is likewise absent when only a spec was attached.
 *
 * The index (operations + doc chunks) is read once, at build time; the spec itself is
 * read **lazily**, only when the model actually asks for an operation's detail, because
 * a portal spec can be megabytes and most turns never open one. Nothing here returns a
 * credential: {@link resolveOperationDetail} yields security *scheme names* only, and the
 * prompt block below states the rule the plan must follow.
 */

/** Rows one `list_api_operations` answer may carry before it stops being readable. */
export const MAX_LISTED_OPERATIONS = 100;
/** Ceiling on `search_api_docs`'s `limit`, whatever the model asks for. */
export const MAX_SEARCH_RESULTS = 10;
/** How many "did you mean" operations an unknown-id failure offers. */
const MAX_NEAR_MISSES = 8;

export interface ApiReferenceToolsContext {
  /** The session directory (the same one `loadIndex`/`specPath` take). */
  sessionDir: string;
  /** Streamed to the UI as the agent works. */
  onProgress?: (message: string) => void;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** `operationId  METHOD /path — summary [tags]`, the compact table row. */
function row(op: ApiOperation): string {
  let line = `${op.operationId}  ${op.method} ${op.path}`;
  if (op.summary) line += ` — ${op.summary}`;
  if (op.tags.length) line += ` [${op.tags.join(", ")}]`;
  if (op.deprecated) line += " (deprecated)";
  return line;
}

/** Split a requested id into comparable words: `makeSalesOrder` → make, sales, order. */
function words(raw: string): string[] {
  return raw
    .replace(/^api:/i, "")
    .split(/[^A-Za-z0-9]+|(?=[A-Z])/)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length >= 3);
}

/**
 * Resolve what the model asked for. Both `api:` conventions are accepted, and so are
 * the bare forms (`createSalesOrder`, `POST /sales/orders`) — the model writing the id
 * with or without the prefix is not a mistake worth a failure turn.
 */
function lookup(operations: readonly ApiOperation[], requested: string): ApiOperation | null {
  const text = requested.trim();
  if (!text) return null;
  const ref = normalizeApiRef(text) ?? normalizeApiRef(`api:${text}`);
  return ref ? findOperation(operations, ref) : null;
}

/**
 * Operations that look like what was asked for. The point is self-correction: a model
 * that guessed `createSalesOrders` should see `createSalesOrder` in the failure and fix
 * itself, instead of listing every operation again.
 */
function nearMisses(operations: readonly ApiOperation[], requested: string): ApiOperation[] {
  const needle = requested.trim().toLowerCase().replace(/^api:/, "").trim();
  const terms = words(requested);
  const scored: { op: ApiOperation; score: number }[] = [];
  for (const op of operations) {
    const hay = `${op.operationId} ${op.method} ${op.path} ${op.summary}`.toLowerCase();
    let score = 0;
    if (needle && (hay.includes(needle) || needle.includes(op.operationId.toLowerCase()))) score += 5;
    for (const term of terms) if (hay.includes(term)) score += 1;
    if (score > 0) scored.push({ op, score });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_NEAR_MISSES)
    .map((s) => s.op);
}

/**
 * The API-reference tools for one builder session, or `[]` when this session has no
 * reference attached (no `api-reference/index.json`).
 */
export function createApiReferenceTools(ctx: ApiReferenceToolsContext): Tool[] {
  const index = loadIndex(ctx.sessionDir);
  if (!index) return [];
  const progress = (m: string) => ctx.onProgress?.(m);

  // Read the spec at most once per build, and only if an operation detail is asked for.
  let spec: unknown = null;
  let specRead = false;
  const readSpec = (): unknown => {
    if (specRead) return spec;
    specRead = true;
    try {
      const file = specPath(ctx.sessionDir);
      spec = file ? JSON.parse(readFileSync(file, "utf8")) : null;
    } catch {
      spec = null; // an unreadable spec degrades to the indexed summary, never a crash
    }
    return spec;
  };

  const listOperations: Tool = {
    name: "list_api_operations",
    description:
      "List the operations of the API reference attached to this recording (operationId, method, path, summary, tags). " +
      "Ground EVERY action step that touches this application in one of these operations rather than describing UI clicks: " +
      "find the operation here, read its detail with get_api_operation, then name it on the step as \"api:<operationId>\". " +
      "Filter or narrow by tag when the list is long.",
    parameters: {
      type: "object",
      properties: {
        filter: {
          type: "string",
          description:
            "Case-insensitive substring matched against the operationId, method, path, summary and tags, e.g. \"order\".",
        },
        tag: { type: "string", description: "Keep only operations carrying this tag (exact, case-insensitive)." },
      },
      additionalProperties: false,
    },
    handler: (raw) => {
      const args = (raw ?? {}) as Record<string, unknown>;
      const filter = str(args.filter).trim().toLowerCase();
      const tag = str(args.tag).trim().toLowerCase();
      progress("Listing the API operations…");

      let matches = index.operations;
      if (tag) matches = matches.filter((o) => o.tags.some((t) => t.toLowerCase() === tag));
      if (filter) {
        matches = matches.filter((o) =>
          `${o.operationId} ${o.method} ${o.path} ${o.summary} ${o.tags.join(" ")}`.toLowerCase().includes(filter),
        );
      }

      const scope = [filter ? `filter "${filter}"` : "", tag ? `tag "${tag}"` : ""].filter(Boolean).join(" + ");
      if (matches.length === 0) {
        return `No operation matches ${scope || "that query"}. Call list_api_operations with no arguments to see every operation.`;
      }
      const shown = matches.slice(0, MAX_LISTED_OPERATIONS);
      const lines = [
        `${matches.length} operation(s)${scope ? ` matching ${scope}` : ""} in the attached API reference:`,
        ...shown.map(row),
      ];
      if (matches.length > shown.length) {
        lines.push(`… ${matches.length - shown.length} more — narrow with filter.`);
      }
      return lines.join("\n");
    },
  };

  const getOperation: Tool = {
    name: "get_api_operation",
    description:
      "Return the full detail of ONE operation from the attached API reference: its method and path, parameters, the " +
      "flattened request-body fields (with which are required), the success-response shape, and the names of the security " +
      "schemes it needs. Read this before you name an operation on a step, so the step describes the right inputs.",
    parameters: {
      type: "object",
      properties: {
        operationId: {
          type: "string",
          description:
            "The operationId exactly as list_api_operations spells it (\"createSalesOrder\"); a \"METHOD /path\" route also works.",
        },
      },
      required: ["operationId"],
      additionalProperties: false,
    },
    handler: (raw) => {
      const requested = str((raw as Record<string, unknown> | null)?.operationId).trim();
      progress(`Reading the API operation ${requested || "(unnamed)"}…`);
      const op = requested ? lookup(index.operations, requested) : null;
      if (!op) {
        const suggestions = requested ? nearMisses(index.operations, requested) : [];
        const lines = [
          `There is no operation "${requested}" in the attached API reference.`,
          suggestions.length
            ? "Did you mean one of these?\n" + suggestions.map((s) => `- ${row(s)}`).join("\n")
            : "Call list_api_operations to see what is actually available.",
        ];
        return { textResultForLlm: lines.join("\n"), resultType: "failure" };
      }

      const detail = resolveOperationDetail(readSpec(), op.operationId);
      if (!detail) {
        // The spec is gone or unreadable; the index row is still true and useful.
        return (
          `Only the indexed summary is available for this operation:\n${row(op)}\n` +
          "Describe the request from the documentation (search_api_docs) or the step's evidence."
        );
      }
      return JSON.stringify(detail, null, 2);
    },
  };

  const tools = [listOperations, getOperation];
  if (index.chunks.length === 0) return tools;

  const searchDocs: Tool = {
    name: "search_api_docs",
    description:
      "Search the unstructured documentation attached alongside the spec (term-frequency ranked, best effort). Use it for " +
      "what a spec does not say — which operation to use for a task, required field conventions, workflow order. The spec " +
      "and get_api_operation remain the authority on the actual request shape.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words to look for, e.g. \"create sales order lines\"." },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MAX_SEARCH_RESULTS,
          description: `How many sections to return (1–${MAX_SEARCH_RESULTS}; default 5).`,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    handler: (raw) => {
      const args = (raw ?? {}) as Record<string, unknown>;
      const query = str(args.query).trim();
      const asked = typeof args.limit === "number" && Number.isFinite(args.limit) ? Math.trunc(args.limit) : 5;
      const limit = Math.min(Math.max(asked, 1), MAX_SEARCH_RESULTS);
      progress(`Searching the API documentation for "${query}"…`);
      if (!query) {
        return { textResultForLlm: "search_api_docs needs a non-empty query.", resultType: "failure" };
      }
      const hits = scoreChunks(index.chunks, query, limit);
      if (hits.length === 0) {
        return `Nothing in the attached documentation matches "${query}". Try other words, or use list_api_operations.`;
      }
      return hits
        .map((h) => `[${h.chunk.sourceId}${h.chunk.heading ? ` › ${h.chunk.heading}` : ""}]\n${h.chunk.text}`)
        .join("\n\n");
    },
  };
  return [...tools, searchDocs];
}

/* --- The system-prompt block ------------------------------------------------ */

export interface ApiReferenceBriefOptions {
  /** What is attached (names + counts), as the store summarizes it. */
  reference: ApiReferenceSummary;
  architecture: SkillArchitecture;
  /** Skill plans carry `allowedTools`; automation plans do not — the copy differs. */
  kind: "skill" | "automation";
}

/**
 * The generated block appended to a builder's system content when a reference is
 * attached — after the capability catalogue, because it *narrows* the catalogue for one
 * application rather than replacing it. Three things it must land: what is attached, the
 * `api:` step-tool convention the lint enforces, and that credentials never travel here.
 */
export function renderApiReferenceBrief(options: ApiReferenceBriefOptions): string {
  const { reference, architecture, kind } = options;
  const names = reference.sources.map((s) => `${s.name} (${s.kind === "openapi" ? "spec" : "docs"})`).join(", ");
  const docsOnly = reference.operationCount === 0 && reference.chunkCount > 0;
  const tools = docsOnly
    ? ["search_api_docs"]
    : ["list_api_operations", "get_api_operation", ...(reference.chunkCount ? ["search_api_docs"] : [])];
  const stepWord = kind === "skill" ? "step" : "step prompt";

  const lines = [
    `## Attached API reference — ${reference.name}`,
    "",
    `The user attached this application's API reference to the recording: ${names} — ` +
      `${reference.operationCount} operation(s)` +
      (reference.chunkCount ? ` and ${reference.chunkCount} documentation section(s).` : "."),
    "",
  ];

  if (docsOnly) {
    // Unstructured docs yield searchable sections but no machine-resolvable operation
    // index, so `api:` grounding is impossible — without this branch the operation-first
    // wording below reads as "nothing to ground in, guessing is rejected" and the model
    // rationally falls back to UI replay, ignoring the docs entirely (observed live).
    lines.push(
      `These are unstructured docs — there is no operation index, so do NOT use \`api:\` refs. Instead, search the`,
      `docs with **search_api_docs** and prefer the documented HTTP endpoints over UI replay: write each action`,
      `${stepWord} against the documented request (name the method and path, e.g. "POST /api/v1/orders", and which`,
      "fields carry which values), exactly as the docs describe it. Fall back to the UI only for actions the docs",
      "do not cover. Steps that do NOT touch this application keep using the catalogue's capabilities as usual.",
      "",
    );
  } else {
    lines.push(
      `Read it with **${tools.join("**, **")}**. Every action step that touches this application must be grounded in a`,
      "concrete operation from this reference instead of UI replay — look the operation up, then name it on the",
      `${stepWord}'s \`tool\` as \`api:<operationId>\` (or \`api:METHOD /path\`). A step naming an operation that isn't in`,
      "the reference is rejected, so never guess an id — look it up first. If an action has NO matching operation",
      "in the reference (the API may cover only part of the app), leave that step un-grounded: write it against the",
      "catalogue's normal capabilities (web/UI) with no `api:` ref at all — never force or invent one. Steps that do",
      "NOT touch this application keep using the catalogue's capabilities as usual.",
      "",
    );
  }

  lines.push(
    "**Never write credentials.** API keys, tokens, and Authorization headers are configured once in the runner or",
    "connector — never in a value, a step, or a request body. The reference exposes security *scheme names* only, and",
    "naming the scheme is all a step should ever do.",
    "",
  );

  if (architecture === "app") {
    lines.push(
      kind === "skill"
        ? "Steps naming `api:<operationId>` will be executed as HTTP calls by this app's runner against the stored spec, " +
            "so describe the request in the step's text (which fields carry which values) and list each operation you use " +
            "in `allowedTools` as `api:<operationId>`."
        : "Steps naming `api:<operationId>` will be executed as HTTP calls by this app's runner against the stored spec, " +
            "so the step's prompt must say which fields carry which values — the runner has the operation, not your intent.",
    );
  } else {
    lines.push(
      kind === "skill"
        ? "The spec imports into Copilot Studio as a **custom connector**; name its operations in your steps, and list them " +
            "in `allowed-tools` as the connector actions the maker must configure (e.g. `SalesAPI.createSalesOrder`)."
        : "The spec imports into Copilot Studio as a **custom connector**; name its operations in your step prompts so the " +
            "maker knows which connector actions to configure (e.g. `SalesAPI.createSalesOrder`).",
    );
  }
  return lines.join("\n");
}
