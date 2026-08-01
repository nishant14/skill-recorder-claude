import { z } from "zod";

/**
 * The **API reference** a user attaches to a recording: an OpenAPI (JSON) spec and/or
 * unstructured documentation (md/txt/html), indexed once at attach time so the
 * builders can map UI-level action steps onto concrete API operations. A plan step
 * names an operation with the `api:` tool convention — `api:<operationId>` or
 * `api:METHOD /path` — and this module owns both the index those refs resolve
 * against and the lint that decides whether a ref resolves at all.
 *
 * Everything here is pure and dependency-free (zod only, per `common/`'s rule): the
 * filesystem, `fetch`, and the attach limits live in
 * `electron/builders/api-reference-store.ts`, and the agent-facing tools built on top
 * of this index live in `electron/builders/`.
 *
 * Non-goals, all deliberate: **no YAML** (a parser would be a new dependency — the
 * store refuses YAML with an export-as-JSON message), **no PDF**, **no embeddings**
 * (retrieval is term frequency, which is honest about being a fallback for
 * unstructured docs), **no external `$ref` following** (only local `#/…` pointers,
 * so indexing never reaches the network), and **no credentials**:
 * {@link resolveOperationDetail} returns security *scheme names* only, never keys,
 * tokens, or example values that might carry one.
 */

/* --- Persisted shapes ------------------------------------------------------ */

/** An OpenAPI spec (the grounded path) or free-form documentation (best effort). */
export const ApiSourceKind = z.enum(["openapi", "docs"]);
export type ApiSourceKind = z.infer<typeof ApiSourceKind>;

/** Where the bytes came from — a file the user picked or a URL we downloaded. */
export const ApiSourceOrigin = z.enum(["file", "url"]);
export type ApiSourceOrigin = z.infer<typeof ApiSourceOrigin>;

export const ApiReferenceSourceSchema = z.object({
  /** Stable id; for docs it is also the filename stem (`docs/<id>.txt`). */
  id: z.string(),
  kind: ApiSourceKind,
  /** Display name — the file's basename, or the URL's last path segment. */
  name: z.string().default(""),
  origin: ApiSourceOrigin,
  /** The absolute file path or the source URL, shown so the user can tell two apart. */
  location: z.string().default(""),
  bytes: z.number().default(0),
  /** `info.title` of an OpenAPI spec, when it declares one. */
  title: z.string().optional(),
  /** `info.version` of an OpenAPI spec, when it declares one. */
  apiVersion: z.string().optional(),
  attachedAt: z.number().default(0),
});
export type ApiReferenceSource = z.infer<typeof ApiReferenceSourceSchema>;

/** What is attached to a session, in attach order. */
export const ApiReferenceManifestSchema = z.object({
  version: z.literal(1),
  sources: z.array(ApiReferenceSourceSchema).default([]),
  updatedAt: z.number().default(0),
});
export type ApiReferenceManifest = z.infer<typeof ApiReferenceManifestSchema>;

/** One callable operation, flattened out of `paths` × methods. */
export const ApiOperationSchema = z.object({
  /** Declared `operationId`, or one synthesized from method + path when absent. */
  operationId: z.string(),
  /** Upper-case HTTP method. */
  method: z.string(),
  /** Templated path exactly as the spec writes it, e.g. `/pets/{petId}`. */
  path: z.string(),
  summary: z.string().default(""),
  tags: z.array(z.string()).default([]),
  deprecated: z.boolean().optional(),
  sourceId: z.string(),
});
export type ApiOperation = z.infer<typeof ApiOperationSchema>;

/** One retrievable slice of unstructured documentation. */
export const ApiDocChunkSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  /** Nearest enclosing heading, or "" when the document had none. */
  heading: z.string().default(""),
  text: z.string(),
});
export type ApiDocChunk = z.infer<typeof ApiDocChunkSchema>;

/** The derived, rebuilt-on-every-mutation index the builder tools read. */
export const ApiReferenceIndexSchema = z.object({
  version: z.literal(1),
  operations: z.array(ApiOperationSchema).default([]),
  chunks: z.array(ApiDocChunkSchema).default([]),
  updatedAt: z.number().default(0),
});
export type ApiReferenceIndex = z.infer<typeof ApiReferenceIndexSchema>;

/* --- Renderer-facing summary ----------------------------------------------- */

export interface ApiReferenceSourceSummary {
  id: string;
  kind: ApiSourceKind;
  name: string;
  bytes: number;
  /** Operations extracted from this source (specs only). */
  operationCount: number;
  /** Doc chunks indexed from this source (docs only). */
  chunkCount: number;
}

/** What the library shows for an attached reference — never any of the raw bytes. */
export interface ApiReferenceSummary {
  /** What to call it in the UI: the spec's title, else the first source's name. */
  name: string;
  sources: ApiReferenceSourceSummary[];
  operationCount: number;
  chunkCount: number;
  updatedAt: number;
}

/** Fold a manifest + its index into the shape the renderer renders. */
export function summarizeReference(
  manifest: ApiReferenceManifest,
  index: ApiReferenceIndex,
): ApiReferenceSummary {
  const sources = manifest.sources.map((s) => ({
    id: s.id,
    kind: s.kind,
    name: s.name,
    bytes: s.bytes,
    operationCount: index.operations.filter((o) => o.sourceId === s.id).length,
    chunkCount: index.chunks.filter((c) => c.sourceId === s.id).length,
  }));
  const spec = manifest.sources.find((s) => s.kind === "openapi");
  return {
    name: spec?.title || spec?.name || manifest.sources[0]?.name || "API reference",
    sources,
    operationCount: index.operations.length,
    chunkCount: index.chunks.length,
    updatedAt: manifest.updatedAt,
  };
}

/* --- Spec extraction -------------------------------------------------------- */

/** The operation keys a path item may carry; anything else there is metadata. */
const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;

/** Longest summary we keep inline; the detail tool serves the full text on demand. */
const SUMMARY_CHARS = 200;

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** First line of a summary/description, trimmed to something a table row can hold. */
function firstLine(text: string): string {
  const line = text.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return line.length > SUMMARY_CHARS ? `${line.slice(0, SUMMARY_CHARS - 1)}…` : line;
}

/** `get` + `/pets/{petId}/toys` → `getPetsByPetIdToys`. */
export function synthesizeOperationId(method: string, route: string): string {
  const parts = route
    .split("/")
    .map((seg) => seg.trim())
    .filter(Boolean)
    .map((seg) => {
      const param = /^\{(.+)\}$/.exec(seg);
      return param ? `By${pascal(param[1])}` : pascal(seg);
    });
  const tail = parts.join("");
  return `${method.toLowerCase()}${tail || "Root"}`;
}

function pascal(raw: string): string {
  return raw
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join("");
}

/**
 * Walk `paths` × methods into a flat operation list. Missing `operationId`s are
 * synthesized (a spec without them is common, and every downstream `api:` ref needs
 * a name to point at), and collisions get a numeric suffix — two operations sharing
 * one id would make an `api:` ref ambiguous, which the lint could never catch.
 */
export function extractOperations(spec: unknown, sourceId = "spec"): ApiOperation[] {
  const paths = asRecord(asRecord(spec)?.paths);
  if (!paths) return [];
  const out: ApiOperation[] = [];
  const taken = new Set<string>();
  for (const [route, itemRaw] of Object.entries(paths)) {
    const item = asRecord(itemRaw);
    if (!item) continue;
    for (const method of HTTP_METHODS) {
      const op = asRecord(item[method]);
      if (!op) continue;
      const base = str(op.operationId).trim() || synthesizeOperationId(method, route);
      let operationId = base;
      for (let n = 2; taken.has(operationId.toLowerCase()); n++) operationId = `${base}_${n}`;
      taken.add(operationId.toLowerCase());
      const deprecated = op.deprecated === true;
      out.push({
        operationId,
        method: method.toUpperCase(),
        path: route,
        summary: firstLine(str(op.summary) || str(op.description)),
        tags: strArray(op.tags),
        ...(deprecated ? { deprecated: true } : {}),
        sourceId,
      });
    }
  }
  return out;
}

/* --- Operation detail (local $ref only) ------------------------------------- */

/** How many `$ref` hops / nesting levels we follow before giving up. */
export const REF_DEPTH_CAP = 6;

/** Fields we flatten out of one schema; enough to fill a form, short enough to read. */
const FIELD_CAP = 60;

export interface ApiField {
  /** Dotted path for nested objects, e.g. `customer.id`; `[]` marks an array element. */
  name: string;
  /** JSON-schema type, or `enum(a|b)` / `object` / `array<string>`. */
  type: string;
  required: boolean;
  description: string;
}

export interface ApiParameter extends ApiField {
  /** `path` | `query` | `header` | `cookie`. */
  in: string;
}

export interface ApiOperationDetail {
  operationId: string;
  method: string;
  path: string;
  summary: string;
  description: string;
  deprecated: boolean;
  tags: string[];
  parameters: ApiParameter[];
  requestBody: { contentType: string; required: boolean; fields: ApiField[] } | null;
  /** The first 2xx response's shape (what a caller gets back). */
  response: { status: string; contentType: string; fields: ApiField[] } | null;
  /**
   * Security **scheme names** only (`apiKeyAuth`, `oauth2`). The values behind them
   * are a runner/connector concern and must never enter a plan, a skill, or a bundle.
   */
  security: string[];
}

/**
 * Follow `$ref` chains to a concrete node. Only local `#/…` pointers resolve:
 * anything else (an http(s) URL, a sibling file) would mean fetching at index time,
 * which this module never does. A visited set breaks self-referential schemas and
 * `depth` caps how deep a legal chain may go.
 */
function deref(root: unknown, node: unknown, visited: Set<string>, depth: number): unknown {
  let current = node;
  for (let hops = 0; hops <= REF_DEPTH_CAP; hops++) {
    const rec = asRecord(current);
    const ref = rec ? str(rec.$ref) : "";
    if (!ref) return current;
    if (!ref.startsWith("#/")) return null; // external refs are out of scope
    if (visited.has(ref)) return null; // cycle
    if (depth + hops >= REF_DEPTH_CAP) return null;
    visited.add(ref);
    current = pointer(root, ref);
    if (current === undefined) return null;
  }
  return null;
}

/** Resolve a JSON pointer fragment (`#/components/schemas/Pet`) against the spec. */
function pointer(root: unknown, ref: string): unknown {
  let node: unknown = root;
  for (const rawSeg of ref.slice(2).split("/")) {
    const seg = rawSeg.replace(/~1/g, "/").replace(/~0/g, "~");
    const rec = asRecord(node);
    if (rec && seg in rec) node = rec[seg];
    else if (Array.isArray(node)) node = node[Number(seg)];
    else return undefined;
  }
  return node;
}

/** Merge `allOf` members and collapse `oneOf`/`anyOf` to their first branch. */
function effectiveSchema(root: unknown, raw: unknown, visited: Set<string>, depth: number): Record<string, unknown> | null {
  const node = asRecord(deref(root, raw, visited, depth));
  if (!node) return null;
  const merged: Record<string, unknown> = { ...node };
  const allOf = Array.isArray(node.allOf) ? node.allOf : [];
  if (allOf.length) {
    const properties: Record<string, unknown> = { ...(asRecord(node.properties) ?? {}) };
    const required = new Set(strArray(node.required));
    for (const member of allOf) {
      const sub = effectiveSchema(root, member, new Set(visited), depth + 1);
      if (!sub) continue;
      Object.assign(properties, asRecord(sub.properties) ?? {});
      for (const r of strArray(sub.required)) required.add(r);
      if (!merged.type && sub.type) merged.type = sub.type;
    }
    merged.properties = properties;
    merged.required = [...required];
    if (!merged.type) merged.type = "object";
    delete merged.allOf;
  }
  if (!merged.properties && !merged.type) {
    const branch = Array.isArray(node.oneOf) ? node.oneOf[0] : Array.isArray(node.anyOf) ? node.anyOf[0] : null;
    if (branch) return effectiveSchema(root, branch, new Set(visited), depth + 1);
  }
  return merged;
}

/** One-word type label for a resolved schema node. */
function typeLabel(schema: Record<string, unknown>): string {
  const values = Array.isArray(schema.enum) ? schema.enum : null;
  if (values?.length) return `enum(${values.slice(0, 6).map(String).join("|")})`;
  const type = str(schema.type) || (schema.properties ? "object" : "");
  if (type === "array") {
    const items = asRecord(schema.items);
    return `array<${items ? str(items.type) || "object" : "any"}>`;
  }
  const format = str(schema.format);
  return format ? `${type || "string"}<${format}>` : type || "any";
}

/** Flatten an object schema into dotted fields, honoring the depth + field caps. */
function flattenSchema(
  root: unknown,
  raw: unknown,
  out: ApiField[],
  prefix: string,
  depth: number,
  visited: Set<string>,
): void {
  if (depth >= REF_DEPTH_CAP || out.length >= FIELD_CAP) return;
  const schema = effectiveSchema(root, raw, visited, depth);
  if (!schema) return;
  const items = str(schema.type) === "array" ? schema.items : null;
  if (items) {
    flattenSchema(root, items, out, prefix ? `${prefix}[]` : "[]", depth + 1, new Set(visited));
    return;
  }
  const properties = asRecord(schema.properties);
  if (!properties) {
    if (prefix) out.push({ name: prefix, type: typeLabel(schema), required: false, description: firstLine(str(schema.description)) });
    return;
  }
  const required = new Set(strArray(schema.required));
  for (const [key, valueRaw] of Object.entries(properties)) {
    if (out.length >= FIELD_CAP) return;
    const child = effectiveSchema(root, valueRaw, new Set(visited), depth + 1);
    if (!child) continue;
    const name = prefix ? `${prefix}.${key}` : key;
    out.push({
      name,
      type: typeLabel(child),
      required: required.has(key),
      description: firstLine(str(child.description)),
    });
    if (child.properties || str(child.type) === "array") {
      flattenSchema(root, child, out, name, depth + 1, new Set(visited));
    }
  }
}

/** Pick the JSON content type when the operation offers one, else whatever is first. */
function pickContent(content: Record<string, unknown> | null): { contentType: string; schema: unknown } | null {
  if (!content) return null;
  const keys = Object.keys(content);
  if (keys.length === 0) return null;
  const key = keys.find((k) => k.includes("json")) ?? keys[0];
  return { contentType: key, schema: asRecord(content[key])?.schema ?? null };
}

/**
 * The full detail for one operation, resolved on demand: parameters (path-level ones
 * merged in), the flattened request body, the first 2xx response shape, and the
 * security *scheme names*. Returns null for an unknown id — the caller turns that
 * into a near-miss hint rather than guessing.
 */
export function resolveOperationDetail(spec: unknown, operationId: string): ApiOperationDetail | null {
  const wanted = operationId.trim().toLowerCase();
  if (!wanted) return null;
  const summary = extractOperations(spec).find((o) => o.operationId.toLowerCase() === wanted);
  if (!summary) return null;
  const root = spec;
  const item = asRecord(asRecord(asRecord(root)?.paths)?.[summary.path]);
  const op = asRecord(item?.[summary.method.toLowerCase()]);
  if (!item || !op) return null;

  const parameters: ApiParameter[] = [];
  const rawParams = [
    ...(Array.isArray(item.parameters) ? item.parameters : []),
    ...(Array.isArray(op.parameters) ? op.parameters : []),
  ];
  for (const rawParam of rawParams) {
    const param = asRecord(deref(root, rawParam, new Set(), 0));
    if (!param) continue;
    const schema = effectiveSchema(root, param.schema ?? {}, new Set(), 0) ?? {};
    parameters.push({
      name: str(param.name),
      in: str(param.in),
      required: param.required === true || str(param.in) === "path",
      type: typeLabel(schema),
      description: firstLine(str(param.description)),
    });
  }

  let requestBody: ApiOperationDetail["requestBody"] = null;
  const body = asRecord(deref(root, op.requestBody, new Set(), 0));
  if (body) {
    const content = pickContent(asRecord(body.content));
    if (content) {
      const fields: ApiField[] = [];
      flattenSchema(root, content.schema, fields, "", 0, new Set());
      requestBody = { contentType: content.contentType, required: body.required === true, fields };
    }
  }

  let response: ApiOperationDetail["response"] = null;
  const responses = asRecord(op.responses);
  if (responses) {
    const status = Object.keys(responses).find((k) => /^2\d\d$/.test(k)) ?? (responses.default ? "default" : null);
    const picked = status ? asRecord(deref(root, responses[status], new Set(), 0)) : null;
    if (status && picked) {
      const content = pickContent(asRecord(picked.content));
      const fields: ApiField[] = [];
      if (content) flattenSchema(root, content.schema, fields, "", 0, new Set());
      response = { status, contentType: content?.contentType ?? "", fields };
    }
  }

  const securityRaw = Array.isArray(op.security)
    ? op.security
    : Array.isArray(asRecord(root)?.security)
      ? (asRecord(root)!.security as unknown[])
      : [];
  const security: string[] = [];
  for (const entry of securityRaw) {
    for (const name of Object.keys(asRecord(entry) ?? {})) {
      if (!security.includes(name)) security.push(name);
    }
  }

  return {
    operationId: summary.operationId,
    method: summary.method,
    path: summary.path,
    summary: summary.summary,
    description: str(op.description).trim(),
    deprecated: summary.deprecated === true,
    tags: summary.tags,
    parameters,
    requestBody,
    response,
    security,
  };
}

/* --- Documentation chunking + retrieval ------------------------------------- */

/** Target chunk size, in characters, when a document has no headings to split on. */
export const CHUNK_CHARS = 1500;
/** Overlap between adjacent character chunks, so a sentence on the seam survives. */
export const CHUNK_OVERLAP = 200;

/**
 * Split documentation into retrievable chunks. Headings win when the document has
 * them (a heading is a real semantic boundary and doubles as the chunk's label);
 * otherwise we fall back to fixed-size windows with overlap. Over-long sections are
 * windowed too, keeping their heading.
 */
export function chunkDocs(text: string, sourceId: string): ApiDocChunk[] {
  const normalized = text.replace(/\r\n?/g, "\n");
  const chunks: ApiDocChunk[] = [];
  const push = (heading: string, body: string) => {
    const trimmed = body.trim();
    if (!trimmed) return;
    chunks.push({ id: `${sourceId}:${chunks.length}`, sourceId, heading, text: trimmed });
  };
  const windowed = (heading: string, body: string) => {
    if (body.trim().length <= CHUNK_CHARS) {
      push(heading, body);
      return;
    }
    const step = CHUNK_CHARS - CHUNK_OVERLAP;
    for (let at = 0; at < body.length; at += step) {
      push(heading, body.slice(at, at + CHUNK_CHARS));
      if (at + CHUNK_CHARS >= body.length) break;
    }
  };

  const headingRe = /^(#{1,6})[ \t]+(.+)$/gm;
  const marks = [...normalized.matchAll(headingRe)];
  if (marks.length === 0) {
    windowed("", normalized);
    return chunks;
  }
  const preamble = normalized.slice(0, marks[0].index ?? 0);
  windowed("", preamble);
  for (let i = 0; i < marks.length; i++) {
    const mark = marks[i];
    const start = (mark.index ?? 0) + mark[0].length;
    const end = i + 1 < marks.length ? marks[i + 1].index ?? normalized.length : normalized.length;
    windowed(mark[2].trim(), normalized.slice(start, end));
  }
  return chunks;
}

/** Named entities worth decoding; anything else numeric is handled below. */
const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
};

/**
 * Naive HTML → text. Not a parser: script/style blocks are dropped, block-level tags
 * become newlines, every other tag is deleted, and the common entities are decoded.
 * Good enough to retrieve prose out of a docs page, and honest about being fallback
 * material — the grounded path is the JSON spec.
 */
export function stripHtml(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|table)\s*>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, name: string) => {
      const key = name.toLowerCase();
      if (ENTITIES[key] !== undefined) return ENTITIES[key];
      const numeric = /^#x([0-9a-f]+)$/i.exec(name) ?? /^#(\d+)$/.exec(name);
      if (!numeric) return whole;
      const code = /^#x/i.test(name) ? parseInt(numeric[1], 16) : Number(numeric[1]);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface ScoredChunk {
  chunk: ApiDocChunk;
  score: number;
}

/** A hit in the heading counts this much more than a hit in the body. */
const HEADING_BOOST = 4;

/**
 * Rank chunks for a query by term frequency, with a heading boost. Deliberately not
 * embeddings: no model call, no index build, no dependency — and for "which page
 * mentions createSalesOrder" a term count is what the agent actually needs.
 */
export function scoreChunks(chunks: readonly ApiDocChunk[], query: string, limit = 5): ScoredChunk[] {
  const terms = [...new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2))];
  if (terms.length === 0) return [];
  const scored: ScoredChunk[] = [];
  for (const chunk of chunks) {
    const body = chunk.text.toLowerCase();
    const heading = chunk.heading.toLowerCase();
    let score = 0;
    for (const term of terms) {
      score += count(body, term) + HEADING_BOOST * count(heading, term);
    }
    if (score > 0) scored.push({ chunk, score });
  }
  // Ties break on document order, so repeated searches return a stable list.
  return scored.sort((a, b) => b.score - a.score).slice(0, Math.max(0, limit));
}

function count(haystack: string, needle: string): number {
  let n = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) n++;
  return n;
}

/* --- The `api:` step-tool convention (the lint core) ------------------------ */

/** A parsed `api:` reference: either an operation id or a method + path route. */
export type ApiRef =
  | { kind: "operation"; operationId: string; raw: string }
  | { kind: "route"; method: string; path: string; raw: string };

/** The prefix that marks a plan step's tool (or an allowed-tools entry) as an API call. */
export const API_REF_PREFIX = "api:";

/**
 * Parse the `api:` step-tool convention. Both forms the prompt teaches are accepted:
 * `api:createSalesOrder` (an operationId) and `api:POST /sales/orders` (a route, for
 * specs whose operations have no ids worth quoting). Anything that isn't an `api:`
 * ref — an empty tool, `Bash(git *)`, `web_fetch` — returns null, which is how
 * callers tell "not an API step" from "a broken API step".
 */
export function normalizeApiRef(raw: unknown): ApiRef | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text.toLowerCase().startsWith(API_REF_PREFIX)) return null;
  const body = text.slice(API_REF_PREFIX.length).trim();
  if (!body) return null;
  const route = /^([A-Za-z]+)\s+(\/\S*)$/.exec(body);
  if (route) {
    const method = route[1].toUpperCase();
    if ((HTTP_METHODS as readonly string[]).includes(method.toLowerCase())) {
      return { kind: "route", method, path: normalizePath(route[2]), raw: text };
    }
  }
  return { kind: "operation", operationId: body, raw: text };
}

/** Trailing slashes are noise; `/orders/` and `/orders` are the same route. */
function normalizePath(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/** The operation an `api:` ref points at, or null when nothing in the index matches. */
export function findOperation(
  operations: readonly ApiOperation[],
  ref: ApiRef,
): ApiOperation | null {
  if (ref.kind === "operation") {
    const wanted = ref.operationId.toLowerCase();
    return operations.find((o) => o.operationId.toLowerCase() === wanted) ?? null;
  }
  return (
    operations.find(
      (o) => o.method === ref.method && normalizePath(o.path) === ref.path,
    ) ?? null
  );
}

/* --- Asking for an operation by name (shared by the builder tools + the runner) --- */

/** How many "did you mean" operations an unknown-id failure offers. */
export const MAX_NEAR_MISSES = 8;

/** `operationId  METHOD /path — summary [tags]`, the compact table row. */
export function operationRow(op: ApiOperation): string {
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
 * Resolve what a model asked for. Both `api:` conventions are accepted, and so are
 * the bare forms (`createSalesOrder`, `POST /sales/orders`) — the model writing the id
 * with or without the prefix is not a mistake worth a failure turn.
 */
export function lookupOperation(
  operations: readonly ApiOperation[],
  requested: string,
): ApiOperation | null {
  const text = requested.trim();
  if (!text) return null;
  const ref = normalizeApiRef(text) ?? normalizeApiRef(`api:${text}`);
  return ref ? findOperation(operations, ref) : null;
}

/**
 * Operations that look like what was asked for. The point is self-correction: a caller
 * that guessed `createSalesOrders` should see `createSalesOrder` in the failure and fix
 * itself, instead of listing every operation again.
 */
export function nearMissOperations(
  operations: readonly ApiOperation[],
  requested: string,
): ApiOperation[] {
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
 * Every distinct `api:` ref a plan makes, in first-seen order: step tools first, then
 * anything the plan listed in `allowed-tools`. Steps are typed loosely on purpose —
 * skill plans and automation plans have different step shapes but the same `tool` field.
 */
export function collectApiRefs(
  steps: readonly { tool?: string }[],
  allowedTools: readonly string[] = [],
): string[] {
  const refs: string[] = [];
  const add = (candidate: unknown) => {
    const ref = normalizeApiRef(candidate);
    if (ref && !refs.includes(ref.raw)) refs.push(ref.raw);
  };
  for (const step of steps) add(step?.tool);
  for (const tool of allowedTools) add(tool);
  return refs;
}

/**
 * The `api:` refs that resolve against nothing in the index — the lint's answer.
 * Returned verbatim (as written) so the message can quote what the user or the agent
 * actually typed. An empty operation list means "no spec attached", in which case
 * every ref is unresolved.
 */
export function unresolvedApiOperations(
  refs: readonly string[],
  operations: readonly ApiOperation[],
): string[] {
  const bad: string[] = [];
  for (const raw of refs) {
    const ref = normalizeApiRef(raw);
    if (!ref) continue;
    if (!findOperation(operations, ref) && !bad.includes(raw)) bad.push(raw);
  }
  return bad;
}
