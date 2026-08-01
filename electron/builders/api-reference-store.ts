import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  ApiReferenceIndexSchema,
  ApiReferenceManifestSchema,
  chunkDocs,
  extractOperations,
  stripHtml,
  summarizeReference,
  type ApiDocChunk,
  type ApiOperation,
  type ApiReferenceIndex,
  type ApiReferenceManifest,
  type ApiReferenceSource,
  type ApiReferenceSummary,
} from "../../common/api-reference";
import { createLogger } from "../logger";
import { sessionDir } from "../recorder/session-store";

/**
 * On-disk owner of a session's attached **API reference**. One folder per session:
 *
 *   <session>/api-reference/manifest.json   what is attached, in attach order
 *   <session>/api-reference/spec.json       the OpenAPI spec, verbatim (at most one)
 *   <session>/api-reference/docs/<id>.txt   plain text extracted from each doc source
 *   <session>/api-reference/index.json      derived: operations + doc chunks
 *
 * `index.json` is *derived* and rebuilt from the sources on every mutation, so a
 * partially-written attach can never leave the builders reading a stale operation
 * list. The pure indexing lives in `common/api-reference.ts`; this module is the
 * filesystem, the download, and the limits.
 *
 * Every refusal here is written for the user: these strings reach the library's error
 * line verbatim. Nothing downloaded is executed or evaluated, and no credential ever
 * enters the bundle — the reference is a *description* of an API, not access to one.
 */

const log = createLogger("api-reference");

const API_DIR = "api-reference";
const DOCS_DIR = "docs";
const MANIFEST_FILE = "manifest.json";
const SPEC_FILE = "spec.json";
const INDEX_FILE = "index.json";

/** Per-file ceiling. Big enough for real portal specs, small enough to index fast. */
export const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
/** One spec (it is the grounded path) plus a handful of best-effort documents. */
export const MAX_DOC_SOURCES = 8;
/** Above this an operation list stops being something a plan can reason over. */
export const MAX_OPERATIONS = 2000;
/** Retrieval stays honest (and cheap) well below this; past it, ask for an excerpt. */
export const MAX_CHUNKS = 3000;
/** Download deadline — the user is watching an attach, not a background job. */
export const DOWNLOAD_TIMEOUT_MS = 15_000;

/**
 * YAML is the other half of the OpenAPI world, and parsing it would mean a new npm
 * dependency for a zero-dependency `common/`. Refuse honestly and name the escape
 * hatch instead of failing with a parse error the user can't act on.
 */
export const YAML_REFUSAL =
  "OpenAPI YAML isn't supported yet — export the spec as JSON (most API portals offer both), " +
  "or attach it as docs for best-effort matching.";

/* --- Paths + persistence ---------------------------------------------------- */

function apiDir(dir: string): string {
  return path.join(dir, API_DIR);
}

function readManifest(dir: string): ApiReferenceManifest {
  const file = path.join(apiDir(dir), MANIFEST_FILE);
  if (!existsSync(file)) return { version: 1, sources: [], updatedAt: 0 };
  try {
    return ApiReferenceManifestSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch (err) {
    // A corrupt manifest is recoverable: treat the reference as absent rather than
    // wedging every build for this session behind a parse error.
    log.warn("unreadable api-reference manifest:", err instanceof Error ? err.message : String(err));
    return { version: 1, sources: [], updatedAt: 0 };
  }
}

/** The derived index for a session, or null when nothing is attached. */
export function loadIndex(dir: string): ApiReferenceIndex | null {
  const file = path.join(apiDir(dir), INDEX_FILE);
  if (!existsSync(file)) return null;
  try {
    const index = ApiReferenceIndexSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    return index.operations.length === 0 && index.chunks.length === 0 ? null : index;
  } catch (err) {
    log.warn("unreadable api-reference index:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

/** The renderer-facing summary of what is attached, or null when nothing is. */
export function loadReference(dir: string): ApiReferenceSummary | null {
  const manifest = readManifest(dir);
  if (manifest.sources.length === 0) return null;
  const index = loadIndex(dir) ?? { version: 1 as const, operations: [], chunks: [], updatedAt: 0 };
  return summarizeReference(manifest, index);
}

/** Absolute path of the stored spec, for the export step that copies it (J3). */
export function specPath(dir: string): string | null {
  const file = path.join(apiDir(dir), SPEC_FILE);
  return existsSync(file) ? file : null;
}

/* --- Classification --------------------------------------------------------- */

interface ClassifiedSpec {
  kind: "openapi";
  /** The spec text exactly as attached (we store what the user gave us). */
  text: string;
  spec: unknown;
  title?: string;
  apiVersion?: string;
}

interface ClassifiedDocs {
  kind: "docs";
  /** Plain text — HTML has already been stripped. */
  text: string;
}

type Classified = ClassifiedSpec | ClassifiedDocs;

function extensionOf(name: string): string {
  return path.extname(name).toLowerCase();
}

function looksLikeYaml(ext: string, text: string): boolean {
  if (ext === ".yaml" || ext === ".yml") return true;
  // A YAML spec saved as .txt still can't be indexed; catch the document-level keys.
  return /^\s*(openapi|swagger)\s*:\s*["']?\d/m.test(text.slice(0, 2000));
}

/**
 * Decide what an attachment *is*. A JSON document declaring `openapi`/`swagger` plus
 * a `paths` object is the grounded path; everything else — including JSON that isn't
 * a spec — is indexed as documentation.
 */
function classify(name: string, text: string, contentType = ""): Classified {
  const ext = extensionOf(name);
  if (looksLikeYaml(ext, text)) throw new Error(YAML_REFUSAL);

  const trimmed = text.trimStart();
  const jsonish = ext === ".json" || contentType.includes("json") || trimmed.startsWith("{") || trimmed.startsWith("[");
  if (jsonish) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      if (ext === ".json") {
        throw new Error(
          "That file isn't valid JSON. Export the spec as JSON, or attach the documentation as a .md, .txt or .html file.",
        );
      }
      parsed = null;
    }
    const obj = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    const versioned = typeof obj?.openapi === "string" || typeof obj?.swagger === "string";
    const paths = obj?.paths && typeof obj.paths === "object";
    if (obj && versioned && paths) {
      const info = (obj.info && typeof obj.info === "object" ? obj.info : {}) as Record<string, unknown>;
      return {
        kind: "openapi",
        text,
        spec: obj,
        ...(typeof info.title === "string" && info.title ? { title: info.title } : {}),
        ...(typeof info.version === "string" && info.version ? { apiVersion: info.version } : {}),
      };
    }
  }

  const html = ext === ".html" || ext === ".htm" || contentType.includes("html") || /<html[\s>]|<!doctype html/i.test(trimmed.slice(0, 500));
  return { kind: "docs", text: html ? stripHtml(text) : text };
}

/* --- Index rebuild ---------------------------------------------------------- */

function rebuildIndex(dir: string, manifest: ApiReferenceManifest): ApiReferenceIndex {
  const operations: ApiOperation[] = [];
  const chunks: ApiDocChunk[] = [];
  for (const source of manifest.sources) {
    if (source.kind === "openapi") {
      const file = path.join(apiDir(dir), SPEC_FILE);
      if (!existsSync(file)) continue;
      try {
        operations.push(...extractOperations(JSON.parse(readFileSync(file, "utf8")), source.id));
      } catch (err) {
        log.warn("could not index the attached spec:", err instanceof Error ? err.message : String(err));
      }
      continue;
    }
    const file = path.join(apiDir(dir), DOCS_DIR, `${source.id}.txt`);
    if (!existsSync(file)) continue;
    chunks.push(...chunkDocs(readFileSync(file, "utf8"), source.id));
  }
  const index: ApiReferenceIndex = { version: 1, operations, chunks, updatedAt: Date.now() };
  writeFileSync(path.join(apiDir(dir), INDEX_FILE), JSON.stringify(index, null, 2));
  return index;
}

function commit(dir: string, manifest: ApiReferenceManifest): ApiReferenceSummary {
  manifest.updatedAt = Date.now();
  writeFileSync(path.join(apiDir(dir), MANIFEST_FILE), JSON.stringify(manifest, null, 2));
  const index = rebuildIndex(dir, manifest);
  return summarizeReference(manifest, index);
}

/* --- Attach ----------------------------------------------------------------- */

interface Incoming {
  name: string;
  origin: ApiReferenceSource["origin"];
  location: string;
  text: string;
  bytes: number;
  contentType?: string;
}

/** Next free `doc-<n>` slot; ids are stable for the life of the source. */
function nextDocId(manifest: ApiReferenceManifest): string {
  const used = new Set(manifest.sources.map((s) => s.id));
  for (let n = 1; n <= MAX_DOC_SOURCES; n++) {
    if (!used.has(`doc-${n}`)) return `doc-${n}`;
  }
  // Unreachable: the doc-count limit is checked before we get here.
  throw new Error(`You can attach up to ${MAX_DOC_SOURCES} documentation files.`);
}

function attachClassified(sessionId: string, incoming: Incoming): ApiReferenceSummary {
  const dir = sessionDir(sessionId);
  if (!existsSync(dir)) throw new Error("Unknown session.");
  if (incoming.bytes === 0) throw new Error("That file is empty — there's nothing to index.");
  if (incoming.bytes > MAX_SOURCE_BYTES) {
    throw new Error(
      `That file is ${Math.round(incoming.bytes / (1024 * 1024))} MB — the limit is 10 MB per attachment. ` +
        "Attach a trimmed spec, or just the part of the documentation this task needs.",
    );
  }

  const classified = classify(incoming.name, incoming.text, incoming.contentType ?? "");
  const manifest = readManifest(dir);

  // Validate against the caps *before* touching disk, so a refused attach leaves the
  // existing reference exactly as it was.
  if (classified.kind === "openapi") {
    const operations = extractOperations(classified.spec, "spec");
    if (operations.length === 0) {
      throw new Error("That spec has no operations under `paths` — check you exported the whole file.");
    }
    if (operations.length > MAX_OPERATIONS) {
      throw new Error(
        `That spec describes ${operations.length} operations — more than the ${MAX_OPERATIONS} this app can index. ` +
          "Attach a spec trimmed to the operations this task needs.",
      );
    }
  } else {
    const existingDocs = manifest.sources.filter((s) => s.kind === "docs");
    if (existingDocs.length >= MAX_DOC_SOURCES) {
      throw new Error(
        `You can attach up to ${MAX_DOC_SOURCES} documentation files. Remove one before attaching another.`,
      );
    }
    const chunks = chunkDocs(classified.text, "candidate");
    if (chunks.length === 0) {
      throw new Error("There was no readable text in that document.");
    }
    const existingChunks = loadIndex(dir)?.chunks.length ?? 0;
    if (existingChunks + chunks.length > MAX_CHUNKS) {
      throw new Error(
        `That document is too long to index (the limit is ${MAX_CHUNKS} sections across all attachments). ` +
          "Attach a shorter excerpt covering the operations this task needs.",
      );
    }
  }

  mkdirSync(path.join(apiDir(dir), DOCS_DIR), { recursive: true });
  const source: ApiReferenceSource = {
    id: classified.kind === "openapi" ? "spec" : nextDocId(manifest),
    kind: classified.kind,
    name: incoming.name,
    origin: incoming.origin,
    location: incoming.location,
    bytes: incoming.bytes,
    ...(classified.kind === "openapi" && classified.title ? { title: classified.title } : {}),
    ...(classified.kind === "openapi" && classified.apiVersion ? { apiVersion: classified.apiVersion } : {}),
    attachedAt: Date.now(),
  };

  if (source.kind === "openapi") {
    // At most one spec: a second one would make `api:` refs ambiguous across specs.
    // Re-attaching replaces, which is also how the user fixes a wrong or stale export.
    writeFileSync(path.join(apiDir(dir), SPEC_FILE), classified.text);
    manifest.sources = [source, ...manifest.sources.filter((s) => s.kind !== "openapi")];
  } else {
    writeFileSync(path.join(apiDir(dir), DOCS_DIR, `${source.id}.txt`), classified.text);
    manifest.sources = [...manifest.sources, source];
  }
  return commit(dir, manifest);
}

/** Attach a file the user picked in the open dialog. */
export async function attachFromFile(sessionId: string, filePath: string): Promise<ApiReferenceSummary> {
  if (!filePath) throw new Error("No file was selected.");
  let bytes: number;
  try {
    bytes = statSync(filePath).size;
  } catch {
    throw new Error("Couldn't read that file — it may have been moved or renamed.");
  }
  // Check the size before reading so a huge file never lands in memory.
  if (bytes > MAX_SOURCE_BYTES) {
    throw new Error(
      `That file is ${Math.round(bytes / (1024 * 1024))} MB — the limit is 10 MB per attachment. ` +
        "Attach a trimmed spec, or just the part of the documentation this task needs.",
    );
  }
  const text = readFileSync(filePath, "utf8");
  return attachClassified(sessionId, {
    name: path.basename(filePath),
    origin: "file",
    location: filePath,
    text,
    bytes,
  });
}

/** Name a downloaded reference after its last path segment, else its host. */
function nameFromUrl(url: URL): string {
  const last = url.pathname.split("/").filter(Boolean).pop();
  return last || url.hostname;
}

/**
 * Attach a reference published at a URL. Main-process only, `http(s)` only, with a
 * hard deadline and a size cap enforced *while streaming* — a server that answers
 * with an endless body must never be able to fill memory.
 */
export async function attachFromUrl(sessionId: string, url: string): Promise<ApiReferenceSummary> {
  let parsed: URL;
  try {
    parsed = new URL(String(url ?? "").trim());
  } catch {
    throw new Error("That doesn't look like a URL. Paste the full address of the spec or docs page.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http:// and https:// addresses can be attached.");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  let text: string;
  let contentType: string;
  try {
    let response: Response;
    try {
      response = await fetch(parsed.toString(), { signal: controller.signal, redirect: "follow" });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error("That address took too long to answer (15 seconds). Download the file and attach it instead.");
      }
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`Couldn't download that reference: ${detail}`);
    }
    if (!response.ok) {
      throw new Error(
        `Couldn't download that reference — the server answered ${response.status}. ` +
          "Check the address, or download the file and attach it instead.",
      );
    }
    contentType = response.headers.get("content-type") ?? "";
    text = await readCapped(response);
  } finally {
    clearTimeout(timer);
  }

  return attachClassified(sessionId, {
    name: nameFromUrl(parsed),
    origin: "url",
    location: parsed.toString(),
    text,
    bytes: Buffer.byteLength(text),
    contentType,
  });
}

/** Read a response body, refusing as soon as it crosses the cap. */
async function readCapped(response: Response): Promise<string> {
  const tooBig = new Error(
    "That reference is larger than the 10 MB limit. Attach a trimmed spec, or just the part of the documentation this task needs.",
  );
  const body = response.body;
  if (!body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_SOURCE_BYTES) throw tooBig;
    return text;
  }
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_SOURCE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw tooBig;
    }
    parts.push(value);
  }
  return Buffer.concat(parts.map((p) => Buffer.from(p))).toString("utf8");
}

/* --- Remove ----------------------------------------------------------------- */

/**
 * Detach one source, or the whole reference when `sourceId` is omitted. Removing the
 * last source deletes the folder, so "no reference attached" is a single condition
 * everywhere downstream (an empty `api-reference/` never lingers).
 */
export function removeSource(sessionId: string, sourceId?: string): ApiReferenceSummary | null {
  const dir = sessionDir(sessionId);
  if (!existsSync(apiDir(dir))) return null;
  const manifest = readManifest(dir);

  if (!sourceId) {
    rmSync(apiDir(dir), { recursive: true, force: true });
    return null;
  }
  const source = manifest.sources.find((s) => s.id === sourceId);
  // Idempotent: a source the user already removed isn't an error worth a banner.
  if (!source) return manifest.sources.length ? loadReference(dir) : null;

  const file =
    source.kind === "openapi"
      ? path.join(apiDir(dir), SPEC_FILE)
      : path.join(apiDir(dir), DOCS_DIR, `${source.id}.txt`);
  rmSync(file, { force: true });
  manifest.sources = manifest.sources.filter((s) => s.id !== sourceId);
  if (manifest.sources.length === 0) {
    rmSync(apiDir(dir), { recursive: true, force: true });
    return null;
  }
  return commit(dir, manifest);
}
