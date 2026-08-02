import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";

import type { CapturedVideoFrame } from "../../common/frames";
import { FrameExtractor, nearestCapturedFrame, sampleCapturedFrames } from "./extractor";

const frame = (file: string, tMs: number): CapturedVideoFrame => ({
  file,
  tMs,
  offsetMs: tMs - 1000,
  width: 1280,
  height: 720,
});

test("nearestCapturedFrame chooses the closest source and prefers the earlier tie", () => {
  const frames = [frame("a.jpg", 1000), frame("b.jpg", 2000), frame("c.jpg", 3000)];
  assert.equal(nearestCapturedFrame(frames, 1750)?.file, "b.jpg");
  assert.equal(nearestCapturedFrame(frames, 2500)?.file, "b.jpg");
  assert.equal(nearestCapturedFrame(frames, 500)?.file, "a.jpg");
  assert.equal(nearestCapturedFrame(frames, 5000)?.file, "c.jpg");
});

test("sampleCapturedFrames never duplicates a 1 fps source when asked for 6 fps", () => {
  const frames = [
    frame("a.jpg", 1000),
    frame("b.jpg", 2000),
    frame("c.jpg", 3000),
    frame("d.jpg", 4000),
  ];
  const samples = sampleCapturedFrames(frames, 1000, 4000, 6, 24);
  assert.deepEqual(samples.map((sample) => sample.frame.file), [
    "a.jpg",
    "b.jpg",
    "c.jpg",
    "d.jpg",
  ]);
  assert.equal(new Set(samples.map((sample) => sample.frame.file)).size, samples.length);
});

test("sampleCapturedFrames returns the nearest static heartbeat for an empty window", () => {
  const samples = sampleCapturedFrames([frame("only.jpg", 1000)], 5000, 6000, 1, 4);
  assert.equal(samples.length, 1);
  assert.equal(samples[0].frame.file, "only.jpg");
  assert.equal(samples[0].targetMs, 5000);
});

test("FrameExtractor safely reuses one portable source snapshot for multiple events", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "skill-recorder-frames-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceDir = path.join(root, "video-frames");
  const framesDir = path.join(root, "frames");
  await Promise.all([
    mkdir(sourceDir, { recursive: true }),
    mkdir(framesDir, { recursive: true }),
  ]);
  await writeFile(path.join(sourceDir, "source.jpg"), "test frame");
  const manifestPath = path.join(root, "video-frames.json");
  await writeFile(
    manifestPath,
    JSON.stringify({
      version: 1,
      format: "jpeg",
      heartbeatMs: 5000,
      frames: [
        null,
        {
          file: "video-frames\\source.jpg",
          tMs: 1600,
          offsetMs: 600,
          width: 1280,
          height: 720,
        },
      ],
    }),
  );

  const extractor = new FrameExtractor({
    capturedFramesPath: manifestPath,
    framesDir,
    anchorEpochMs: 1000,
  });
  const added = await extractor.extractAtEpochs([{ tMs: 1500 }, { tMs: 2500 }]);

  assert.equal(added.length, 1);
  assert.equal(extractor.manifest.length, 1);
  assert.equal(added[0].tMs, 1600);
  assert.equal(added[0].offsetSec, 0.6);
  assert.equal(existsSync(path.join(framesDir, added[0].file)), true);
});

test("FrameExtractor drops malformed retained frame records", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "skill-recorder-retained-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, "frames.json"),
    JSON.stringify([
      null,
      {
        file: "event_500.jpg",
        tMs: 1500,
        offsetSec: 0.5,
        source: "event",
        phash: "",
      },
    ]),
  );

  const extractor = new FrameExtractor({ framesDir: root, anchorEpochMs: 1000 });
  assert.deepEqual(extractor.manifest.map((entry) => entry.file), ["event_500.jpg"]);
});

/** The extractor's own 9x8 dHash, restated so a test can assert on the fixture it built. */
async function dhash(file: string): Promise<string> {
  const buffer = await sharp(file).grayscale().resize(9, 8, { fit: "fill" }).raw().toBuffer();
  let bits = "";
  for (let row = 0; row < 8; row++) {
    for (let column = 0; column < 8; column++) {
      bits += buffer[row * 9 + column] < buffer[row * 9 + column + 1] ? "1" : "0";
    }
  }
  let hex = "";
  for (let index = 0; index < 64; index += 4) {
    hex += parseInt(bits.slice(index, index + 4), 2).toString(16);
  }
  return hex;
}

function hamming(a: string, b: string): number {
  let distance = 0;
  for (let index = 0; index < a.length; index++) {
    let value = parseInt(a[index], 16) ^ parseInt(b[index], 16);
    while (value) {
      distance += value & 1;
      value >>= 1;
    }
  }
  return distance;
}

/** A form mock-up; `filled` adds the one short line that a user typing produces. */
function formPage(filled: boolean): string {
  const rows = [
    `<rect x="40" y="120" width="560" height="40" fill="#e5e7eb"/>`,
    `<rect x="40" y="180" width="480" height="40" fill="#e5e7eb"/>`,
    `<rect x="40" y="240" width="520" height="40" fill="#e5e7eb"/>`,
  ].join("");
  const typed = filled
    ? `<text x="56" y="208" font-size="18" fill="#111827">Contoso Ltd (CUST-1001)</text>`
    : "";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">` +
    `<rect width="640" height="360" fill="#f6f7f9"/>` +
    `<rect width="640" height="56" fill="#1f2937"/>` +
    rows +
    typed +
    `<rect x="40" y="300" width="160" height="36" rx="6" fill="#1d4ed8"/>` +
    `</svg>`
  );
}

// The bug this pins down: `get_frames` is an explicit look-request, and the two states of
// a form that is being filled in are sub-threshold under the 9x8 dHash — so perceptual
// dedupe on the probe path silently withheld the only evidence that a record was being
// *created* rather than read. Probes must dedupe by source-frame identity instead.
test("FrameExtractor serves probe frames the perceptual dedupe would have eaten", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "skill-recorder-probe-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceDir = path.join(root, "video-frames");
  const framesDir = path.join(root, "frames");
  await Promise.all([
    mkdir(sourceDir, { recursive: true }),
    mkdir(framesDir, { recursive: true }),
  ]);
  for (const [name, filled] of [["empty.jpg", false], ["filled.jpg", true]] as const) {
    await sharp(Buffer.from(formPage(filled))).jpeg({ quality: 82 }).toFile(path.join(sourceDir, name));
  }

  // The fixture is only meaningful if the two states really do collide, so measure it
  // rather than assume it: one filled field is invisible at 9x8 grayscale.
  const distance = hamming(
    await dhash(path.join(sourceDir, "empty.jpg")),
    await dhash(path.join(sourceDir, "filled.jpg")),
  );
  assert.ok(distance <= 8, `expected a sub-threshold pair, got Hamming ${distance}`);

  const manifestPath = path.join(root, "video-frames.json");
  await writeFile(
    manifestPath,
    JSON.stringify({
      version: 1,
      format: "jpeg",
      heartbeatMs: 5000,
      frames: [
        { file: "video-frames/empty.jpg", tMs: 5000, offsetMs: 4000, width: 640, height: 360 },
        { file: "video-frames/filled.jpg", tMs: 10000, offsetMs: 9000, width: 640, height: 360 },
      ],
    }),
  );

  const extractor = new FrameExtractor({
    capturedFramesPath: manifestPath,
    framesDir,
    anchorEpochMs: 1000,
  });
  // Event seeding stays opportunistic: one anchor, one retained frame.
  assert.equal((await extractor.extractAtEpochs([{ tMs: 5000 }])).length, 1);

  const added = await extractor.extractWindow({ startMs: 4000, endMs: 11000, reason: "probe:test" });
  assert.deepEqual(
    extractor.manifest.map((entry) => entry.offsetSec),
    [4, 9],
    "an explicitly requested window must return the near-duplicate too",
  );
  assert.deepEqual(added.map((entry) => entry.source), ["probe"]);
  assert.ok(added[0].phash.length > 0, "the phash is still recorded, just not acted on");
  for (const entry of extractor.manifest) {
    assert.equal(existsSync(path.join(framesDir, entry.file)), true);
  }

  // Identity dedupe: looking again writes nothing new, and the frames stay in the
  // manifest slice `get_frames` composes its reply from.
  const before = (await readdir(framesDir)).sort();
  assert.equal((await extractor.extractWindow({ startMs: 4000, endMs: 11000 })).length, 0);
  assert.equal(extractor.manifest.length, 2);
  assert.deepEqual((await readdir(framesDir)).sort(), before);
});

test("FrameExtractor deduplicates identical source JPEGs without deleting retained files", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "skill-recorder-dedupe-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceDir = path.join(root, "video-frames");
  const framesDir = path.join(root, "frames");
  await Promise.all([
    mkdir(sourceDir, { recursive: true }),
    mkdir(framesDir, { recursive: true }),
  ]);
  const jpeg = await sharp({
    create: {
      width: 32,
      height: 32,
      channels: 3,
      background: { r: 30, g: 90, b: 150 },
    },
  })
    .jpeg()
    .toBuffer();
  await Promise.all([
    writeFile(path.join(sourceDir, "one.jpg"), jpeg),
    writeFile(path.join(sourceDir, "two.jpg"), jpeg),
  ]);
  const manifestPath = path.join(root, "video-frames.json");
  await writeFile(
    manifestPath,
    JSON.stringify({
      version: 1,
      format: "jpeg",
      heartbeatMs: 5000,
      frames: [
        { file: "video-frames/one.jpg", tMs: 1600, offsetMs: 600, width: 32, height: 32 },
        { file: "video-frames/two.jpg", tMs: 3600, offsetMs: 2600, width: 32, height: 32 },
      ],
    }),
  );
  const options = {
    capturedFramesPath: manifestPath,
    framesDir,
    anchorEpochMs: 1000,
  };
  const events = [{ tMs: 1600 }, { tMs: 3600 }];
  const extractor = new FrameExtractor(options);

  assert.equal((await extractor.extractAtEpochs(events)).length, 1);
  assert.equal(extractor.manifest.length, 1);
  assert.equal(existsSync(path.join(framesDir, extractor.manifest[0].file)), true);
  assert.equal((await extractor.extractAtEpochs(events)).length, 0);

  const reloaded = new FrameExtractor(options);
  assert.equal((await reloaded.extractAtEpochs(events)).length, 0);
  assert.equal(reloaded.manifest.length, 1);
  assert.equal(existsSync(path.join(framesDir, reloaded.manifest[0].file)), true);
});
