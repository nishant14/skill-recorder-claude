// Renders the *captured source frames* half of a synthetic recording.
//
// Most describer scenarios are event-rich: everything the agent needs is in
// events.jsonl. Some flows are not — filling a form emits no events at all, so the
// only evidence that the user *created* something rather than *opened* it lives on
// screen. Those scenarios need the vision path, which means the fixture has to lay
// down exactly the artifacts `FrameExtractor` consumes:
//
//   video.json          — the anchor (startEpoch) + framesVersion/framesFile
//   video-frames.json   — the versioned CapturedFrameManifest
//   video-frames/*.jpg  — the snapshots themselves
//   frames/             — the (empty) directory the extractor copies retained frames into
//
// There is deliberately **no video.webm**: `buildExtractor` (describer.ts) and the
// pipeline's frame stage both accept captured frames alone, and `capturedFramesExpected`
// suppresses the legacy system-FFmpeg path — so a fixture never needs a real container.
//
// Frames are drawn with sharp from an SVG composite. They are not screenshots of a real
// browser and don't pretend to be: they are large, high-contrast page mock-ups, because
// the only thing under test is whether the describer *looks* and *reads*. Rendering is
// pure with respect to time — the caller supplies `startEpoch`, so a materialized
// scenario is reproducible.

import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import {
  CAPTURED_FRAME_MANIFEST_VERSION,
  type CapturedFrameManifest,
} from "../../common/frames";

const require = createRequire(import.meta.url);

type Sharp = typeof import("sharp");

/** One page mock-up to render, positioned on the recording's timeline. */
export interface FrameFixture {
  /** Milliseconds since the user pressed Start (same clock as RawEvent.atMs). */
  atMs: number;
  /** Window/title-bar text. */
  title: string;
  /** Body text; the first line is drawn as the page heading. */
  lines: string[];
}

export interface FrameFixtureOptions {
  /** Wall-clock anchor: the epoch the recording started (frames get startEpoch + atMs). */
  startEpoch: number;
  /** Recording length, written to video.json so the extractor can bound its windows. */
  durationMs: number;
  width?: number;
  height?: number;
}

/** The relative directory the JPEGs are written to, mirroring a real recording. */
const FRAMES_DIR = "video-frames";
const MANIFEST_FILE = "video-frames.json";
/** The recorder's snapshot cadence; recorded in the manifest for fidelity only. */
const HEARTBEAT_MS = 1000;

const BASE_WIDTH = 1280;
const BASE_HEIGHT = 720;
const FONTS = "DejaVu Sans, Liberation Sans, Helvetica, Arial, sans-serif";

/**
 * Write `video.json`, the captured-frame manifest and one JPEG per fixture into a
 * materialized session directory. Returns the manifest exactly as it was persisted.
 */
export async function renderFrameFixtures(
  dir: string,
  frames: FrameFixture[],
  opts: FrameFixtureOptions,
): Promise<CapturedFrameManifest> {
  const width = opts.width ?? BASE_WIDTH;
  const height = opts.height ?? BASE_HEIGHT;
  const framesDir = path.join(dir, FRAMES_DIR);
  mkdirSync(framesDir, { recursive: true });
  // The extractor copies retained frames into `frames/`, which a real session gets from
  // the session store. A materialized one has no store, so create it here or every
  // retention would fail with ENOENT.
  mkdirSync(path.join(dir, "frames"), { recursive: true });

  const sorted = [...frames].sort((a, b) => a.atMs - b.atMs);
  const image = require("sharp") as Sharp;
  const entries: CapturedFrameManifest["frames"] = [];

  for (let index = 0; index < sorted.length; index++) {
    const fixture = sorted[index];
    const name = `frame_${String(index + 1).padStart(6, "0")}.jpg`;
    await image(Buffer.from(renderSvg(fixture, width, height)))
      .jpeg({ quality: 82 })
      .toFile(path.join(framesDir, name));
    entries.push({
      file: `${FRAMES_DIR}/${name}`,
      tMs: opts.startEpoch + fixture.atMs,
      offsetMs: fixture.atMs,
      width,
      height,
    });
  }

  const manifest: CapturedFrameManifest = {
    version: CAPTURED_FRAME_MANIFEST_VERSION,
    format: "jpeg",
    heartbeatMs: HEARTBEAT_MS,
    frames: entries,
  };
  writeFileSync(path.join(dir, MANIFEST_FILE), JSON.stringify(manifest, null, 2));
  writeFileSync(
    path.join(dir, "video.json"),
    JSON.stringify(
      {
        // Named but never written: captured frames alone satisfy both consumers, and
        // `framesVersion` tells them not to fall back to FFmpeg looking for it.
        file: "video.webm",
        startEpoch: opts.startEpoch,
        stopEpoch: opts.startEpoch + opts.durationMs,
        durationMs: opts.durationMs,
        bytes: 0,
        fps: 1,
        framesVersion: CAPTURED_FRAME_MANIFEST_VERSION,
        framesFile: MANIFEST_FILE,
        frameCount: entries.length,
      },
      null,
      2,
    ),
  );
  return manifest;
}

/** XML text escaping — fixture copy contains ampersands, quotes and angle brackets. */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * A deliberately blocky page mock-up: dark window bar, heading, one banded row per
 * line, `[bracketed]` lines drawn as buttons.
 *
 * The blockiness is load-bearing, not decoration. `FrameExtractor` drops near-duplicate
 * frames by 64-bit dHash — a 9x8 grayscale reduction — and two states of the same form
 * rendered as plain dark text on white reduce to nearly the same hash, so the retention
 * pass would silently throw away the very frame the scenario depends on. Every visible
 * block here is therefore derived from the content: the rows share out the whole page
 * height, so a half-filled form and a completed one put their bands at entirely
 * different heights; band width tracks the line's length; and buttons are solid fills.
 * Different page states then differ at the coarse scale the hash actually samples.
 */
function renderSvg(fixture: FrameFixture, width: number, height: number): string {
  const s = width / BASE_WIDTH;
  const barH = 84 * s;
  const titleSize = 32 * s;
  const headingSize = 44 * s;
  const left = 56 * s;
  const contentW = width - left * 2;
  const headingY = barH + 92 * s;
  const rowsTop = headingY + 46 * s;

  const [heading = "", ...rows] = fixture.lines;
  // Clamped so an absurdly short page (or a very long one) still yields drawable rects.
  const rowH = Math.max(4 * s, (height - rowsTop - 28 * s) / Math.max(1, rows.length));
  const bandH = Math.max(1, rowH - 10 * s);
  const bodySize = Math.min(30 * s, rowH * 0.4);
  const parts: string[] = [
    `<rect width="${width}" height="${height}" fill="#f6f7f9"/>`,
    `<rect width="${width}" height="${barH}" fill="#1f2937"/>`,
    `<text x="${left}" y="${barH * 0.63}" font-size="${titleSize}" fill="#f9fafb" font-family="${FONTS}">${escapeXml(fixture.title)}</text>`,
    // Accent rule; its length tracks the row count so the *top* of the page carries a
    // signal too — the dHash samples only eight vertical bands and two states of one
    // form would otherwise be identical across the upper half.
    `<rect x="${left}" y="${barH + 28 * s}" width="${contentW * Math.min(1, 0.3 + rows.length * 0.11)}" height="${8 * s}" fill="#2563eb"/>`,
    `<text x="${left}" y="${headingY}" font-size="${headingSize}" font-weight="bold" fill="#111827" font-family="${FONTS}">${escapeXml(heading)}</text>`,
  ];

  rows.forEach((line, index) => {
    const y = rowsTop + index * rowH;
    const isButton = line.trim().startsWith("[");
    // Band width tracks how much text the row carries, so a half-filled form and a
    // completed one have visibly different silhouettes — and a button's fill stays
    // under its own (white) label.
    const bandW = contentW * Math.min(1, Math.max(0.3, line.length / 52));
    parts.push(
      isButton
        ? `<rect x="${left}" y="${y}" width="${bandW}" height="${bandH}" rx="${6 * s}" fill="#1d4ed8"/>`
        : `<rect x="${left}" y="${y}" width="${bandW}" height="${bandH}" fill="${index % 2 === 0 ? "#ffffff" : "#d8dee7"}"/>`,
      `<text x="${left + 20 * s}" y="${y + rowH * 0.6}" font-size="${bodySize}" fill="${isButton ? "#ffffff" : "#111827"}" font-family="${FONTS}">${escapeXml(line)}</text>`,
    );
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${parts.join("")}</svg>`;
}
