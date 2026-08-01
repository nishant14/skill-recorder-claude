import type { FoundryConfig } from "../../common/foundry";
import type { NarrationLanguage, NarrationSegment } from "../../common/narration";
import { decodeAudioFile } from "../audio/decode";
import { encodeWav, wavByteLength } from "../audio/wav";
import {
  transcribeWavOnFoundry,
  transcriptionDeployment,
} from "../foundry/transcribe";
import { createLogger } from "../logger";
import { detectSilence, type SilenceSpan } from "./audio-analysis";

const log = createLogger("Narration/transcribe");

/** The decoder downmixes to 16 kHz mono; the WAV we upload keeps that rate. */
const SAMPLE_RATE = 16_000;

/**
 * Upload bounds per chunk. Both are deliberately well inside the transcription
 * API's own limits (~25 MB / long-audio ceilings): a chunk that fails is re-sent
 * whole, so smaller chunks make a retry cheap, and a bounded chunk also bounds the
 * damage when a deployment answers without segment timestamps (the whole chunk
 * becomes one coarse segment).
 */
const MAX_CHUNK_SECONDS = 8 * 60;
const MAX_CHUNK_BYTES = 15 * 1024 * 1024;

/** A half-length chunk is still worth cutting at a real pause; a shorter one is not. */
const MIN_SILENCE_CUT_FRACTION = 0.5;

/** Longest span, in samples, that may be uploaded as a single chunk. */
export function maxChunkSamples(sampleRate = SAMPLE_RATE): number {
  const byTime = MAX_CHUNK_SECONDS * sampleRate;
  const bySize = Math.floor((MAX_CHUNK_BYTES - wavByteLength(0)) / 2);
  return Math.max(1, Math.min(byTime, bySize));
}

/** A half-open `[start, end)` span of samples to upload as one WAV. */
export interface NarrationChunk {
  start: number;
  end: number;
}

/**
 * Split the recording into upload-sized chunks, cutting inside a pause wherever one
 * is available.
 *
 * Cutting mid-word costs a word in both chunks, so each cut looks for the **latest**
 * detected silence whose midpoint falls in the second half of the allowed span and
 * cuts there; with no such pause it falls back to a hard split at the limit. Cuts
 * are always at or before the limit, never after, so every chunk is uploadable.
 *
 * Pure (sample arithmetic only) so the chunk boundaries — the thing every later
 * timestamp is measured from — are unit-testable without audio or a network.
 */
export function planNarrationChunks(
  totalSamples: number,
  silences: SilenceSpan[],
  sampleRate = SAMPLE_RATE,
  limit = maxChunkSamples(sampleRate),
): NarrationChunk[] {
  if (totalSamples <= 0) return [];
  const chunks: NarrationChunk[] = [];
  let start = 0;
  while (totalSamples - start > limit) {
    const hardEnd = start + limit;
    const earliest = start + Math.floor(limit * MIN_SILENCE_CUT_FRACTION);
    const cut = silenceCut(silences, sampleRate, earliest, hardEnd) ?? hardEnd;
    chunks.push({ start, end: cut });
    start = cut;
  }
  chunks.push({ start, end: totalSamples });
  return chunks;
}

/** The latest silence midpoint inside `[earliest, hardEnd]`, in samples. */
function silenceCut(
  silences: SilenceSpan[],
  sampleRate: number,
  earliest: number,
  hardEnd: number,
): number | null {
  let best: number | null = null;
  for (const silence of silences) {
    const midpoint = Math.round(((silence.start + silence.end) / 2) * sampleRate);
    if (midpoint < earliest || midpoint > hardEnd) continue;
    if (best === null || midpoint > best) best = midpoint;
  }
  return best;
}

/**
 * Transcribe one session's narration webm into session-clock segments.
 *
 * @param audioPath  absolute path to `audio.webm`
 * @param anchorDeltaMs  `audio.startEpoch - session.startedAt` — added to every
 *   audio-local timestamp so segments land on the same clock as step offsets.
 * @param durationMs  recorded narration duration, used to close the final segment.
 */
export async function transcribeNarration(
  audioPath: string,
  anchorDeltaMs: number,
  durationMs: number,
  language: NarrationLanguage,
  config: FoundryConfig,
  signal?: AbortSignal,
): Promise<{ model: string; segments: NarrationSegment[] }> {
  const samples = await decodeAudioFile(audioPath);
  if (samples.length === 0) {
    throw new Error("Narration audio decoded to zero samples.");
  }
  return transcribeSamples(samples, anchorDeltaMs, durationMs, language, config, { signal });
}

export interface TranscribeSamplesOptions {
  signal?: AbortSignal;
  /**
   * Upload chunk size in samples. Defaults to {@link maxChunkSamples}; tests pass a
   * small value to exercise the multi-chunk offset merge without eight minutes of
   * synthetic audio.
   */
  chunkSamples?: number;
}

/**
 * The cloud half of {@link transcribeNarration}, split out so the chunk → upload →
 * offset-merge path is testable from plain samples.
 *
 * Every chunk's timestamps come back relative to that chunk's own start, so the
 * chunk offset is added back before anything is kept — `atMs` stays relative to the
 * recording exactly as it was when a single local pipeline saw the whole file.
 */
export async function transcribeSamples(
  samples: Float32Array,
  anchorDeltaMs: number,
  durationMs: number,
  language: NarrationLanguage,
  config: FoundryConfig,
  options: TranscribeSamplesOptions = {},
): Promise<{ model: string; segments: NarrationSegment[] }> {
  const silences = detectSilence(samples, SAMPLE_RATE);
  const chunks = planNarrationChunks(
    samples.length,
    silences,
    SAMPLE_RATE,
    options.chunkSamples ?? maxChunkSamples(SAMPLE_RATE),
  );
  const audioSec = samples.length / SAMPLE_RATE;
  const durationSec = durationMs > 0 ? durationMs / 1000 : audioSec;

  const segments: NarrationSegment[] = [];
  let raw = 0;
  for (const chunk of chunks) {
    const wav = encodeWav(samples.subarray(chunk.start, chunk.end), SAMPLE_RATE);
    const result = await transcribeWavOnFoundry(config, wav, {
      language,
      signal: options.signal,
    });
    raw += result.segments.length;

    const offsetSec = chunk.start / SAMPLE_RATE;
    const chunkEndSec = chunk.end / SAMPLE_RATE;
    for (const segment of result.segments) {
      const text = segment.text.trim();
      if (!isMeaningfulNarrationText(text)) continue;

      const startSec = offsetSec + segment.startMs / 1000;
      // A segment with no usable end (a downgraded `json` answer, or drift) is closed
      // at the chunk's end, bounded by the recording — never left inverted.
      const rawEndSec =
        segment.endMs > segment.startMs
          ? offsetSec + segment.endMs / 1000
          : Math.min(durationSec, startSec + 2);
      const endSec = Math.max(startSec, Math.min(rawEndSec, chunkEndSec));
      // The silence test catches stock phrases hallucinated over quiet audio, which
      // is only meaningful for a segment the model actually placed. A segment that
      // spans its whole chunk is the un-timestamped fallback and carries whatever
      // real speech the chunk held, so it is never dropped for being mostly quiet.
      const spansWholeChunk = startSec <= offsetSec && endSec >= chunkEndSec;
      if (!spansWholeChunk && isMostlySilent(startSec, endSec, silences)) continue;

      segments.push({
        atMs: Math.max(0, Math.round(startSec * 1000 + anchorDeltaMs)),
        endMs: Math.max(0, Math.round(endSec * 1000 + anchorDeltaMs)),
        text,
      });
    }
  }

  segments.sort((a, b) => a.atMs - b.atMs);
  log.info(
    `transcribed ${chunks.length} chunk(s), ${raw} cloud segment(s) -> ${segments.length} narration segments`,
  );
  return { model: narrationModelId(config), segments };
}

/** The deployment name transcripts are tagged with (the `model` field on disk). */
export function narrationModelId(config: FoundryConfig): string {
  return transcriptionDeployment(config);
}

/**
 * A segment is dropped only when almost its entire span is silence, i.e. it is a
 * hallucination over near-silent audio (see `BOILERPLATE`/`isMeaningful`).
 *
 * We measure the fraction of `[startSec, endSec]` covered by detected silence and
 * treat the segment as silent at >= 0.85 coverage. The earlier midpoint test dropped
 * long real-speech segments whenever a natural mid-sentence pause happened to land
 * near the temporal center — a single 16s span of clear speech could vanish. A
 * coverage test keeps those while still catching all-silence hallucinations.
 *
 * `detectSilence` returns non-overlapping ascending spans, so summing the clipped
 * overlaps never double-counts. A zero/negative span can't have a fraction, so it
 * falls back to a point-in-silence test.
 */
export function isMostlySilent(startSec: number, endSec: number, silences: SilenceSpan[]): boolean {
  const span = endSec - startSec;
  if (span <= 0) return silences.some((s) => startSec >= s.start && startSec <= s.end);
  let covered = 0;
  for (const s of silences) {
    const lo = Math.max(startSec, s.start);
    const hi = Math.min(endSec, s.end);
    if (hi > lo) covered += hi - lo;
  }
  return covered / span >= 0.85;
}

// Speech models hallucinate stock phrases over silence/noise; drop the usual suspects
// (and anything that carries no letters) so they never reach the analysis.
const BOILERPLATE = new Set([
  "you",
  "thank you",
  "thanks",
  "thanks for watching",
  "please subscribe",
  "subtitles by the amara org community",
  "bye",
  "grazie",
  "grazie per aver guardato",
  "iscriviti al canale",
  "ciao",
  "merci",
  "merci d avoir regardé",
  "abonnez vous",
  "au revoir",
  "gracias",
  "gracias por ver",
  "suscríbete",
  "adiós",
]);

export function isMeaningfulNarrationText(text: string): boolean {
  if (text.length < 2) return false;
  if (!/\p{L}/u.test(text)) return false;
  const normalized = text
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return !BOILERPLATE.has(normalized);
}
