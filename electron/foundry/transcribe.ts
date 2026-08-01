import {
  DEFAULT_FOUNDRY_TRANSCRIPTION_DEPLOYMENT,
  type FoundryConfig,
} from "../../common/foundry";
import { wavDurationMs } from "../audio/wav";
import { createLogger } from "../logger";
import { authHeaders, isRecord, postWithRetry } from "./http";

/**
 * Speech-to-text against the user's Azure AI Foundry transcription deployment.
 *
 * One multipart `POST {endpoint}/openai/v1/audio/transcriptions` built from Node 22
 * globals (`fetch`/`FormData`/`Blob`) — **no new npm dependency** — sharing
 * `http.ts`'s retry policy and status→message taxonomy with the agent runtime, so
 * both surfaces fail identically and neither ever puts the key in a message or a log.
 *
 * The caller owns chunking: this transcribes exactly the WAV it is given and returns
 * timestamps relative to *that* WAV's start. `electron/narration/transcribe.ts` adds
 * each chunk's offset so the persisted `atMs` stays recording-relative.
 */

const log = createLogger("Foundry/transcribe");

/** One timestamped span of speech, relative to the start of the submitted WAV. */
export interface CloudTranscriptionSegment {
  startMs: number;
  endMs: number;
  text: string;
}

export interface CloudTranscription {
  text: string;
  segments: CloudTranscriptionSegment[];
}

/**
 * Set once if the deployment rejects `verbose_json`, and remembered for the process
 * lifetime: after the first downgrade every later chunk asks for `json` directly
 * instead of paying a wasted round-trip per chunk. See {@link isFormatRejection}.
 */
let downgradedToJson = false;

/** The deployment transcription runs against — never the chat deployment. */
export function transcriptionDeployment(config: FoundryConfig): string {
  return (config.transcriptionDeployment ?? "").trim() || DEFAULT_FOUNDRY_TRANSCRIPTION_DEPLOYMENT;
}

/** Visible for tests: forget the remembered `response_format` downgrade. */
export function resetTranscriptionFormatDowngrade(): void {
  downgradedToJson = false;
}

/**
 * Transcribe one WAV file on the configured Foundry transcription deployment.
 *
 * `verbose_json` is requested because it is the only response format that carries
 * segment timestamps. A deployment that does not implement it answers HTTP 400; that
 * is tolerated exactly like the G1 `include` drift — retry once with `json` and
 * synthesize a single segment spanning the whole file, which still yields useful
 * coarse timestamps because the caller submits bounded chunks.
 */
export async function transcribeWavOnFoundry(
  config: FoundryConfig,
  wav: Uint8Array,
  opts: { language?: string; signal?: AbortSignal } = {},
): Promise<CloudTranscription> {
  const model = transcriptionDeployment(config);
  const headers = authHeaders(config);
  // `fetch` derives `Content-Type` (with the multipart boundary) from the FormData;
  // setting it by hand would produce a body the server cannot parse.
  const signal = opts.signal ?? new AbortController().signal;

  const response = await postWithRetry({
    url: transcriptionUrl(config),
    endpoint: config.endpoint,
    model,
    signal,
    // Rebuilt per attempt: a FormData body is consumed by the request it is sent
    // with, and a `response_format` downgrade must change what we resend.
    init: () => ({ headers, body: buildForm(wav, model, opts.language) }),
    onBadRequest: (detail) => {
      if (downgradedToJson || !isFormatRejection(detail)) return false;
      log.warn(
        `the "${model}" deployment rejected response_format:"verbose_json"; ` +
          "resending as json (segment timestamps come from chunking instead).",
      );
      downgradedToJson = true;
      return true;
    },
  });

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("Azure AI Foundry returned a transcription that could not be read as JSON.");
  }
  return readTranscription(body, wavDurationMs(wav));
}

// --- request ----------------------------------------------------------------

/**
 * The audio route on the modern `/openai/v1` surface. `apiVersion` stays an escape
 * hatch that pins the surface version, exactly as in `agent.ts`.
 */
function transcriptionUrl(config: FoundryConfig): string {
  const url = `${config.endpoint}/openai/v1/audio/transcriptions`;
  return config.apiVersion ? `${url}?api-version=${encodeURIComponent(config.apiVersion)}` : url;
}

function buildForm(wav: Uint8Array, model: string, language?: string): FormData {
  const form = new FormData();
  // A Blob part must be backed by a plain ArrayBuffer; `Uint8Array`'s type also
  // admits a SharedArrayBuffer, which nothing here ever produces. Re-viewing the
  // same bytes satisfies the type without copying them.
  const bytes = new Uint8Array(wav.buffer as ArrayBuffer, wav.byteOffset, wav.byteLength);
  form.append("file", new Blob([bytes], { type: "audio/wav" }), "narration.wav");
  form.append("model", model);
  // The user picked this language explicitly; it is preserved, never translated.
  if (language) form.append("language", language);
  form.append("response_format", downgradedToJson ? "json" : "verbose_json");
  return form;
}

/** Whether a 400's detail is the deployment refusing `verbose_json` specifically. */
function isFormatRejection(detail: string): boolean {
  return /response_format|verbose/i.test(detail);
}

// --- response ---------------------------------------------------------------

/**
 * Read the transcription body. Tolerant by design — the segment shape is a
 * G6-validated detail, so anything unreadable degrades to the plain text plus a
 * synthesized full-file segment rather than failing the transcription.
 */
function readTranscription(body: unknown, durationMs: number): CloudTranscription {
  if (!isRecord(body)) {
    throw new Error("Azure AI Foundry returned a transcription in an unexpected shape.");
  }
  const text = typeof body.text === "string" ? body.text.trim() : "";
  const raw = Array.isArray(body.segments) ? body.segments.filter(isRecord) : [];

  const segments: CloudTranscriptionSegment[] = [];
  for (const item of raw) {
    const segmentText = typeof item.text === "string" ? item.text.trim() : "";
    if (!segmentText) continue;
    const startMs = secondsToMs(item.start);
    const endMs = Math.max(startMs, secondsToMs(item.end));
    segments.push({ startMs, endMs, text: segmentText });
  }

  // No timestamps came back (a `json` answer, or a surface that omits them): the
  // whole file is one segment. Chunking keeps that span usefully short.
  if (segments.length === 0 && text) {
    return { text, segments: [{ startMs: 0, endMs: Math.max(0, durationMs), text }] };
  }
  return { text, segments };
}

function secondsToMs(value: unknown): number {
  const seconds = typeof value === "number" ? value : Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0;
}
