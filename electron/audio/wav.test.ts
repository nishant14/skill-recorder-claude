import assert from "node:assert/strict";
import test from "node:test";

import { encodeWav, wavByteLength, wavDurationMs } from "./wav";

/**
 * The WAV writer is the only thing standing between decoded narration samples and
 * the transcription endpoint, so these tests read the bytes it produces field by
 * field rather than round-tripping through our own reader.
 */

const view = (wav: Uint8Array) => new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
const ascii = (wav: Uint8Array, offset: number, length: number) =>
  Buffer.from(wav.subarray(offset, offset + length)).toString("latin1");

test("encodeWav writes a canonical 16-bit mono PCM header", () => {
  const wav = encodeWav(new Float32Array(8), 16_000);
  const data = view(wav);

  assert.equal(ascii(wav, 0, 4), "RIFF");
  assert.equal(ascii(wav, 8, 4), "WAVE");
  assert.equal(ascii(wav, 12, 4), "fmt ");
  assert.equal(ascii(wav, 36, 4), "data");

  assert.equal(data.getUint32(4, true), 36 + 16); // RIFF size = everything after it
  assert.equal(data.getUint32(16, true), 16); // PCM fmt chunk
  assert.equal(data.getUint16(20, true), 1); // format tag: PCM
  assert.equal(data.getUint16(22, true), 1); // mono
  assert.equal(data.getUint32(24, true), 16_000); // sample rate
  assert.equal(data.getUint32(28, true), 32_000); // byte rate = rate * 2
  assert.equal(data.getUint16(32, true), 2); // block align
  assert.equal(data.getUint16(34, true), 16); // bits per sample
  assert.equal(data.getUint32(40, true), 16); // data size = samples * 2

  assert.equal(wav.byteLength, wavByteLength(8));
  assert.equal(wavByteLength(0), 44);
});

test("samples are scaled to 16-bit and clipped instead of wrapping", () => {
  const wav = encodeWav(new Float32Array([0, 1, -1, 0.5, -0.5, 4, -4]), 16_000);
  const data = view(wav);
  const at = (i: number) => data.getInt16(44 + i * 2, true);

  assert.equal(at(0), 0); // digital silence stays exactly zero
  assert.equal(at(1), 32_767);
  assert.equal(at(2), -32_768);
  assert.equal(at(3), 16_383);
  assert.equal(at(4), -16_384);
  // Out-of-range input clips like analog gear; integer wrap would invert the sign
  // and turn a hot microphone into loud noise.
  assert.equal(at(5), 32_767);
  assert.equal(at(6), -32_768);
});

test("encodeWav refuses a nonsensical sample rate", () => {
  assert.throws(() => encodeWav(new Float32Array(4), 0), {
    message: "Cannot encode WAV audio at a 0 Hz sample rate.",
  });
  assert.throws(() => encodeWav(new Float32Array(4), Number.NaN), /sample rate/);
});

test("wavDurationMs measures what encodeWav wrote", () => {
  assert.equal(wavDurationMs(encodeWav(new Float32Array(16_000), 16_000)), 1_000);
  assert.equal(wavDurationMs(encodeWav(new Float32Array(24_000), 16_000)), 1_500);
  assert.equal(wavDurationMs(encodeWav(new Float32Array(0), 16_000)), 0);
});

test("wavDurationMs walks past extra chunks and never throws on junk", () => {
  // A LIST chunk with an odd body (word-aligned by a pad byte) sitting between
  // `fmt ` and `data` — common in files we did not write ourselves.
  const pcm = encodeWav(new Float32Array(16_000), 16_000);
  const listBody = 5;
  const list = new Uint8Array(8 + listBody + 1);
  new DataView(list.buffer).setUint32(4, listBody, true);
  list.set(Buffer.from("LIST", "latin1"), 0);

  const padded = new Uint8Array(pcm.byteLength + list.byteLength);
  padded.set(pcm.subarray(0, 36), 0);
  padded.set(list, 36);
  padded.set(pcm.subarray(36), 36 + list.byteLength);
  new DataView(padded.buffer).setUint32(4, padded.byteLength - 8, true);
  assert.equal(wavDurationMs(padded), 1_000);

  // Not a WAV, truncated, or empty: "unknown", never an exception.
  assert.equal(wavDurationMs(new Uint8Array(0)), 0);
  assert.equal(wavDurationMs(new Uint8Array(64)), 0);
  assert.equal(wavDurationMs(pcm.subarray(0, 20)), 0);

  // A `data` header that claims more bytes than the file holds: trust the bytes.
  assert.equal(wavDurationMs(pcm.subarray(0, 44 + 16_000)), 500);
});
