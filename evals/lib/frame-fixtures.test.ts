import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CAPTURED_FRAME_MANIFEST_VERSION } from "../../common/frames";
import { escapeXml, renderFrameFixtures } from "./frame-fixtures";

/**
 * Unit tests for the captured-frame fixture writer. What matters here is the *contract*
 * with `FrameExtractor.loadSourceFrames`: manifest version/format, per-frame file paths
 * that resolve relative to the manifest, and an epoch that is the caller's anchor plus
 * the offset. Rendering is real sharp at a tiny size — no network, milliseconds — because
 * a stubbed renderer would not prove the JPEG the extractor later reads exists.
 */

const START_EPOCH = 1_700_000_000_000;

function withTempDir(run: (dir: string) => Promise<void> | void): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "sr-frame-fixtures-"));
    try {
      await run(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

const FIXTURES = [
  { atMs: 4000, title: "Orders", lines: ["Orders", "SO-1 <Fabrikam & Co> \"prime\"", "SO-2"] },
  { atMs: 1000, title: "Home", lines: ["Northwind", "Welcome"] },
];

test(
  "writes a manifest the extractor can load, ordered by time",
  withTempDir(async (dir) => {
    const manifest = await renderFrameFixtures(dir, FIXTURES, {
      startEpoch: START_EPOCH,
      durationMs: 6000,
      width: 64,
      height: 36,
    });

    assert.equal(manifest.version, CAPTURED_FRAME_MANIFEST_VERSION);
    assert.equal(manifest.format, "jpeg");
    assert.deepEqual(
      manifest.frames.map((f) => f.file),
      ["video-frames/frame_000001.jpg", "video-frames/frame_000002.jpg"],
    );
    // Sorted by atMs, not by authoring order: the extractor binary-searches by tMs.
    assert.deepEqual(
      manifest.frames.map((f) => f.offsetMs),
      [1000, 4000],
    );
    assert.deepEqual(
      manifest.frames.map((f) => f.tMs),
      [START_EPOCH + 1000, START_EPOCH + 4000],
    );
    for (const frame of manifest.frames) {
      assert.equal(frame.width, 64);
      assert.equal(frame.height, 36);
      assert.ok(existsSync(path.join(dir, frame.file)), `${frame.file} rendered`);
    }

    const onDisk = JSON.parse(readFileSync(path.join(dir, "video-frames.json"), "utf8"));
    assert.deepEqual(onDisk, manifest);
    assert.deepEqual(readdirSync(path.join(dir, "video-frames")).sort(), [
      "frame_000001.jpg",
      "frame_000002.jpg",
    ]);
    // The extractor copies retained frames into `frames/`; a real session gets it from
    // the session store, a materialized one from here.
    assert.ok(existsSync(path.join(dir, "frames")));
  }),
);

test(
  "video.json anchors the frames and points at the manifest, with no webm on disk",
  withTempDir(async (dir) => {
    await renderFrameFixtures(dir, FIXTURES, {
      startEpoch: START_EPOCH,
      durationMs: 6000,
      width: 64,
      height: 36,
    });

    const video = JSON.parse(readFileSync(path.join(dir, "video.json"), "utf8"));
    assert.equal(video.startEpoch, START_EPOCH);
    assert.equal(video.durationMs, 6000);
    assert.equal(video.stopEpoch, START_EPOCH + 6000);
    assert.equal(video.framesVersion, CAPTURED_FRAME_MANIFEST_VERSION);
    assert.equal(video.framesFile, "video-frames.json");
    assert.equal(video.frameCount, 2);
    // Captured frames alone satisfy both consumers — buildExtractor and the pipeline's
    // frame stage — so the fixture deliberately never writes the container it names.
    assert.equal(video.file, "video.webm");
    assert.equal(existsSync(path.join(dir, "video.webm")), false);
  }),
);

test(
  "renders JPEGs at the requested dimensions",
  withTempDir(async (dir) => {
    await renderFrameFixtures(dir, [FIXTURES[0]], {
      startEpoch: START_EPOCH,
      durationMs: 5000,
      width: 96,
      height: 54,
    });
    const file = path.join(dir, "video-frames", "frame_000001.jpg");
    const bytes = readFileSync(file);
    assert.equal(bytes[0], 0xff);
    assert.equal(bytes[1], 0xd8); // JPEG SOI

    const sharp = createRequire(import.meta.url)("sharp") as typeof import("sharp");
    const meta = await sharp(file).metadata();
    assert.equal(meta.format, "jpeg");
    assert.equal(meta.width, 96);
    assert.equal(meta.height, 54);
  }),
);

test("escapes XML-significant characters in fixture copy", () => {
  assert.equal(
    escapeXml(`Fabrikam & <Sons> "Ltd" 'x'`),
    "Fabrikam &amp; &lt;Sons&gt; &quot;Ltd&quot; &apos;x&apos;",
  );
  assert.equal(escapeXml("plain"), "plain");
});
