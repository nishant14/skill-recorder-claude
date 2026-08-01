/**
 * A minimal, dependency-free WAV codec: enough to hand decoded narration samples to
 * a cloud transcription endpoint and to read back how long the result is.
 *
 * Pure and Electron-free on purpose — `electron/narration` encodes with it and
 * `electron/foundry/transcribe.ts` measures with it, and both are unit-tested
 * without a window, a network, or a temp file.
 *
 * Only the one format the transcription API needs is produced: 16-bit signed PCM,
 * mono, little-endian (RIFF/WAVE, canonical 44-byte header). Reading is deliberately
 * more tolerant than writing — it walks the chunk list rather than assuming a
 * canonical layout, because we may be measuring a file we did not write.
 */

const HEADER_BYTES = 44;
const BITS_PER_SAMPLE = 16;
const CHANNELS = 1;
/** PCM. */
const FORMAT_TAG = 1;

const ascii = (view: DataView, offset: number, length: number): string => {
  let out = "";
  for (let i = 0; i < length; i++) out += String.fromCharCode(view.getUint8(offset + i));
  return out;
};

const writeAscii = (view: DataView, offset: number, text: string): void => {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
};

/**
 * Encode mono float samples (nominally −1…1) as a 16-bit PCM WAV file.
 *
 * Samples outside the nominal range are clamped rather than allowed to wrap, so a
 * hot microphone clips like analog gear instead of producing the loud noise that
 * integer overflow would. The asymmetric scale (32767 up, 32768 down) is the usual
 * two's-complement mapping and keeps digital silence at exactly zero.
 */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error(`Cannot encode WAV audio at a ${sampleRate} Hz sample rate.`);
  }
  const rate = Math.round(sampleRate);
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(HEADER_BYTES + dataBytes);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true); // everything after this field
  writeAscii(view, 8, "WAVE");

  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); // PCM fmt chunk length
  view.setUint16(20, FORMAT_TAG, true);
  view.setUint16(22, CHANNELS, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, (rate * CHANNELS * BITS_PER_SAMPLE) / 8, true); // byte rate
  view.setUint16(32, (CHANNELS * BITS_PER_SAMPLE) / 8, true); // block align
  view.setUint16(34, BITS_PER_SAMPLE, true);

  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);

  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i] || 0));
    view.setInt16(HEADER_BYTES + i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return new Uint8Array(buffer);
}

/** Bytes a `encodeWav` file will occupy for `sampleCount` samples. */
export function wavByteLength(sampleCount: number): number {
  return HEADER_BYTES + sampleCount * 2;
}

/**
 * Duration of a PCM WAV file in milliseconds, or 0 when the bytes are not a WAV we
 * can measure. Never throws: this only ever refines a timestamp, so an unreadable
 * header degrades to "unknown" instead of failing a transcription.
 */
export function wavDurationMs(wav: Uint8Array): number {
  if (wav.byteLength < 12) return 0;
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  if (ascii(view, 0, 4) !== "RIFF" || ascii(view, 8, 4) !== "WAVE") return 0;

  let byteRate = 0;
  let offset = 12;
  while (offset + 8 <= wav.byteLength) {
    const id = ascii(view, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      // A truncated `fmt ` cannot be read past its end — treat it as unmeasurable.
      if (size < 16 || body + 16 > wav.byteLength) return 0;
      byteRate = view.getUint32(body + 8, true);
    } else if (id === "data") {
      if (byteRate <= 0) return 0;
      // A truncated file reports more `data` than it carries; trust the bytes.
      const bytes = Math.min(size, wav.byteLength - body);
      return Math.max(0, Math.round((bytes / byteRate) * 1000));
    }
    // Chunks are word-aligned: an odd length is followed by a pad byte.
    offset = body + size + (size % 2);
  }
  return 0;
}
