import assert from "node:assert/strict";
import test from "node:test";

import type { FoundryConfig } from "../../common/foundry";
import type { SilenceSpan } from "./audio-analysis";
import {
  isMeaningfulNarrationText,
  isMostlySilent,
  maxChunkSamples,
  narrationModelId,
  planNarrationChunks,
  transcribeSamples,
} from "./transcribe";

/**
 * The narration stage: how long audio is split for upload, and how each chunk's
 * cloud timestamps are merged back onto the recording clock.
 *
 * The chunk planner is pure, so it is tested directly. The merge is tested through
 * `transcribeSamples` with a scripted `globalThis.fetch` (restored in a `finally`),
 * because the offset arithmetic is only meaningful against what the transcription
 * endpoint actually returns: per-chunk timestamps that start again at zero.
 */

const SAMPLE_RATE = 16_000;

const CONFIG: FoundryConfig = {
  endpoint: "https://unit.test.invalid",
  apiKey: "test-key",
  deployment: "gpt-5.3-codex",
  transcriptionDeployment: "gpt-4o-transcribe",
};

/** Speech everywhere except the given silent second-ranges. */
function samplesWithSilences(totalSec: number, silent: Array<[number, number]>): Float32Array {
  const samples = new Float32Array(Math.round(totalSec * SAMPLE_RATE)).fill(0.2);
  for (const [from, to] of silent) {
    samples.fill(0, Math.round(from * SAMPLE_RATE), Math.round(to * SAMPLE_RATE));
  }
  return samples;
}

/** A `verbose_json` body whose times are relative to the chunk, as the API returns. */
const chunkReply = (segments: Array<{ start: number; end: number; text: string }>): Response =>
  new Response(JSON.stringify({ text: segments.map((s) => s.text).join(" "), segments }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/** Install a scripted fetch, recording each chunk's uploaded byte length. */
async function withFetch<T>(
  replies: Response[],
  run: (uploads: number[]) => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  const uploads: number[] = [];
  globalThis.fetch = (async (_url: unknown, init: Record<string, unknown> = {}) => {
    const form = init.body as FormData;
    const file = form.get("file");
    assert.ok(file instanceof Blob);
    uploads.push(file.size);
    const reply = replies[uploads.length - 1];
    if (!reply) throw new Error(`unexpected upload #${uploads.length}`);
    return reply;
  }) as unknown as typeof fetch;
  try {
    return await run(uploads);
  } finally {
    globalThis.fetch = original;
  }
}

// --- chunk planning ---------------------------------------------------------

test("audio within the upload limit is a single chunk", () => {
  assert.deepEqual(planNarrationChunks(1_000, [], SAMPLE_RATE, 5_000), [{ start: 0, end: 1_000 }]);
  assert.deepEqual(planNarrationChunks(5_000, [], SAMPLE_RATE, 5_000), [{ start: 0, end: 5_000 }]);
  assert.deepEqual(planNarrationChunks(0, [], SAMPLE_RATE, 5_000), []);
});

test("the upload limit is bounded by both duration and size", () => {
  // At 16 kHz 16-bit mono, 8 minutes is ~15.36 MB — just inside the 15 MiB ceiling,
  // so duration is what binds at the app's rate. Both bounds must always hold.
  const limit = maxChunkSamples(SAMPLE_RATE);
  assert.ok(limit <= 8 * 60 * SAMPLE_RATE);
  assert.ok(limit * 2 + 44 <= 15 * 1024 * 1024);
  // A very low rate makes the duration bound the binding one instead.
  assert.equal(maxChunkSamples(100), 8 * 60 * 100);
});

test("a long recording is cut at the latest pause inside the allowed span", () => {
  // Limit 10s: the cut may land anywhere in [5s, 10s], and the latest qualifying
  // pause wins so each chunk carries as much audio as it can.
  const silences: SilenceSpan[] = [
    { start: 2, end: 3 }, // too early — before the halfway mark
    { start: 6, end: 6.4 }, // eligible, midpoint 6.2s
    { start: 8.8, end: 9.2 }, // eligible and later, midpoint 9.0s → the cut
    { start: 12, end: 13 }, // beyond the limit
  ];
  const chunks = planNarrationChunks(25 * SAMPLE_RATE, silences, SAMPLE_RATE, 10 * SAMPLE_RATE);
  assert.deepEqual(chunks, [
    { start: 0, end: 9 * SAMPLE_RATE },
    { start: 9 * SAMPLE_RATE, end: 19 * SAMPLE_RATE }, // no pause in [14s, 19s] → hard cut
    { start: 19 * SAMPLE_RATE, end: 25 * SAMPLE_RATE },
  ]);
  // Every chunk is uploadable, and together they cover the recording exactly once.
  assert.equal(chunks[0].start, 0);
  assert.equal(chunks.at(-1)?.end, 25 * SAMPLE_RATE);
  for (const chunk of chunks) assert.ok(chunk.end - chunk.start <= 10 * SAMPLE_RATE);
});

test("with no detected pauses the split is a hard one at the limit", () => {
  assert.deepEqual(planNarrationChunks(12_000, [], SAMPLE_RATE, 5_000), [
    { start: 0, end: 5_000 },
    { start: 5_000, end: 10_000 },
    { start: 10_000, end: 12_000 },
  ]);
});

// --- chunk-offset merge -----------------------------------------------------

test("each chunk's timestamps are shifted back onto the recording clock", async () => {
  // 12s of speech with a pause at 5–6s; a 8s limit forces two chunks, and the pause
  // midpoint (5.5s) is the cut, so chunk 2 starts at 5.5s of the audio.
  const samples = samplesWithSilences(12, [[5, 6]]);
  const anchorDeltaMs = 2_000; // this audio segment started 2s into the recording

  const result = await withFetch(
    [
      chunkReply([
        { start: 0.5, end: 2, text: "first thing" },
        { start: 3, end: 4.5, text: "second thing" },
      ]),
      // Chunk 2's own clock restarts at zero — 1s here is 6.5s of the audio.
      chunkReply([{ start: 1, end: 3, text: "third thing" }]),
    ],
    async (uploads) => {
      const transcript = await transcribeSamples(
        samples,
        anchorDeltaMs,
        12_000,
        "en",
        CONFIG,
        { chunkSamples: 8 * SAMPLE_RATE },
      );
      assert.equal(uploads.length, 2, "12s at an 8s limit must upload two chunks");
      // 5.5s and 6.5s of 16-bit mono audio, plus a 44-byte header each.
      assert.deepEqual(uploads, [5.5 * SAMPLE_RATE * 2 + 44, 6.5 * SAMPLE_RATE * 2 + 44]);
      return transcript;
    },
  );

  assert.equal(result.model, "gpt-4o-transcribe");
  assert.deepEqual(result.segments, [
    { atMs: 2_500, endMs: 4_000, text: "first thing" },
    { atMs: 5_000, endMs: 6_500, text: "second thing" },
    // 5.5s chunk offset + 1s in-chunk + 2s anchor delta.
    { atMs: 8_500, endMs: 10_500, text: "third thing" },
  ]);
});

test("segments stay sorted and recording-relative across chunks and sources", async () => {
  const samples = samplesWithSilences(12, [[5, 6]]);
  const result = await withFetch(
    [
      chunkReply([{ start: 4, end: 5, text: "late in chunk one" }]),
      chunkReply([{ start: 0.2, end: 1, text: "early in chunk two" }]),
    ],
    () =>
      transcribeSamples(samples, 0, 12_000, "en", CONFIG, { chunkSamples: 8 * SAMPLE_RATE }),
  );
  assert.deepEqual(
    result.segments.map((s) => s.atMs),
    [4_000, 5_700],
  );
  assert.ok(result.segments.every((s) => s.endMs >= s.atMs));
});

test("a chunk with no usable end time is closed at the chunk boundary", async () => {
  // What a `response_format: "json"` downgrade produces: one segment spanning the
  // chunk, with no end. It must not run past the chunk it came from.
  const samples = samplesWithSilences(12, [[5, 6]]);
  const result = await withFetch(
    [
      chunkReply([{ start: 0, end: 0, text: "whole first chunk" }]),
      chunkReply([{ start: 0, end: 0, text: "whole second chunk" }]),
    ],
    () =>
      transcribeSamples(samples, 0, 12_000, "en", CONFIG, { chunkSamples: 8 * SAMPLE_RATE }),
  );
  assert.deepEqual(result.segments, [
    { atMs: 0, endMs: 2_000, text: "whole first chunk" },
    { atMs: 5_500, endMs: 7_500, text: "whole second chunk" },
  ]);
});

test("silence hallucinations and boilerplate are dropped after the offset is applied", async () => {
  // 10s: speech only in 0–2s, silence from 2s on. A segment placed over the silent
  // tail is a hallucination and must not reach the transcript, and it is only
  // recognizable as one once its timestamps are recording-relative.
  const samples = samplesWithSilences(10, [[2, 10]]);
  const result = await withFetch(
    [
      chunkReply([
        { start: 0, end: 1.8, text: "real narration here" },
        { start: 4, end: 8, text: "Thanks for watching!" },
        { start: 4, end: 8, text: "invented over silence" },
      ]),
    ],
    () => transcribeSamples(samples, 0, 10_000, "en", CONFIG),
  );
  assert.deepEqual(result.segments, [{ atMs: 0, endMs: 1_800, text: "real narration here" }]);
});

test("an un-timestamped whole-chunk answer survives a mostly quiet recording", async () => {
  // The `response_format: "json"` downgrade returns one segment spanning the chunk.
  // Here 90% of the audio is silence, so the hallucination filter would drop it —
  // but this segment carries the only speech there was, so it must be kept.
  const samples = samplesWithSilences(10, [[1, 10]]);
  const result = await withFetch(
    [
      new Response(JSON.stringify({ text: "one short remark", segments: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ],
    () => transcribeSamples(samples, 0, 10_000, "en", CONFIG),
  );
  assert.deepEqual(result.segments, [{ atMs: 0, endMs: 10_000, text: "one short remark" }]);
});

test("the transcript is tagged with the transcription deployment, not the chat one", () => {
  assert.equal(narrationModelId(CONFIG), "gpt-4o-transcribe");
  assert.equal(narrationModelId({ ...CONFIG, transcriptionDeployment: "whisper-1" }), "whisper-1");
});

// --- text filtering (unchanged behavior, now over cloud segments) ------------

test("narration filtering accepts Unicode letters", () => {
  assert.equal(isMeaningfulNarrationText("È già pronto"), true);
  assert.equal(isMeaningfulNarrationText("日本語の説明"), true);
  assert.equal(isMeaningfulNarrationText("123 ..."), false);
});

test("narration filtering removes localized transcription boilerplate", () => {
  assert.equal(isMeaningfulNarrationText("Merci d'avoir regardé !"), false);
  assert.equal(isMeaningfulNarrationText("Gracias por ver."), false);
  assert.equal(isMeaningfulNarrationText("Grazie per aver guardato"), false);
});

test("keeps a long real-speech chunk that is only ~44% silent", () => {
  // Regression: the old midpoint test dropped this 16.18s chunk purely because its
  // center (8.09s) landed inside the 7.14-9.44s mid-sentence pause. Natural pauses
  // add up to ~44% of the span, but the majority is speech, so it must be kept.
  const silences: SilenceSpan[] = [
    { start: 1.0, end: 2.4 },
    { start: 7.14, end: 9.44 },
    { start: 11.0, end: 12.5 },
    { start: 14.0, end: 16.0 },
  ];
  assert.equal(isMostlySilent(0, 16.18, silences), false);
});

test("drops a chunk whose span is essentially all silence", () => {
  // A silence span that fully covers (and overruns) the chunk: clipped coverage
  // is 100%, so it's a hallucination over silence and gets dropped.
  assert.equal(isMostlySilent(10, 20, [{ start: 9, end: 21 }]), true);
});

test("uses 0.85 as the drop threshold", () => {
  assert.equal(isMostlySilent(0, 10, [{ start: 0, end: 9 }]), true); // 0.90 -> drop
  assert.equal(isMostlySilent(0, 10, [{ start: 0, end: 8 }]), false); // 0.80 -> keep
});

test("degenerates to a point-in-silence test for a zero-length span", () => {
  assert.equal(isMostlySilent(5, 5, [{ start: 4, end: 6 }]), true);
  assert.equal(isMostlySilent(5, 5, [{ start: 10, end: 12 }]), false);
});

test("treats a negative span defensively via the start point", () => {
  assert.equal(isMostlySilent(8, 5, [{ start: 7, end: 9 }]), true);
  assert.equal(isMostlySilent(8, 5, [{ start: 1, end: 2 }]), false);
});

test("keeps a chunk with no overlapping silence", () => {
  assert.equal(isMostlySilent(0, 10, [{ start: 20, end: 25 }, { start: 30, end: 35 }]), false);
  assert.equal(isMostlySilent(0, 10, []), false);
});
