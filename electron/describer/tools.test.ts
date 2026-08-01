import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import {
  CAPTURED_FRAME_MANIFEST_VERSION,
  type CapturedFrameManifest,
  type FrameRecord,
} from "../../common/frames";
import { FrameExtractor } from "../frames/extractor";
import { createDescriberTools } from "./tools";

const STARTED_AT = 1_700_000_000_000;

interface ListFramesResult {
  hasVideo: boolean;
  capturedFrameCount: number;
  capturedRangeMs: { fromMs: number; toMs: number } | null;
  frames: { file: string; atMs: number; source: string; reason?: string }[];
}

async function session(t: TestContext): Promise<{ dir: string; framesDir: string; manifestPath: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "skill-recorder-tools-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sourceDir = path.join(dir, "video-frames");
  const framesDir = path.join(dir, "frames");
  await Promise.all([
    mkdir(sourceDir, { recursive: true }),
    mkdir(framesDir, { recursive: true }),
  ]);

  const frames = [1000, 2000, 3000].map((offsetMs) => ({
    file: `video-frames/f_${offsetMs}.jpg`,
    tMs: STARTED_AT + offsetMs,
    offsetMs,
    width: 1280,
    height: 720,
  }));
  await Promise.all(
    frames.map((frame) => writeFile(path.join(dir, frame.file), "not-a-real-jpeg")),
  );
  const manifest: CapturedFrameManifest = {
    version: CAPTURED_FRAME_MANIFEST_VERSION,
    format: "jpeg",
    heartbeatMs: 1000,
    frames,
  };
  const manifestPath = path.join(dir, "video-frames.json");
  await writeFile(manifestPath, JSON.stringify(manifest));
  return { dir, framesDir, manifestPath };
}

function listFrames(sessionDir: string, extractor: FrameExtractor | null): ListFramesResult {
  const tools = createDescriberTools({
    sessionDir,
    startedAt: STARTED_AT,
    extractor,
    onSubmit: () => {},
  });
  const tool = tools.find((t) => t.name === "list_frames");
  assert.ok(tool, "list_frames must be registered");
  const result = tool.handler({});
  assert.equal(typeof result, "string");
  return JSON.parse(result as string) as ListFramesResult;
}

test("list_frames reports captured screenshots even when nothing has been retained", async (t) => {
  const { dir, framesDir, manifestPath } = await session(t);
  const extractor = new FrameExtractor({
    capturedFramesPath: manifestPath,
    capturedFramesExpected: true,
    framesDir,
    anchorEpochMs: STARTED_AT,
  });

  const result = listFrames(dir, extractor);
  assert.equal(result.hasVideo, true);
  // The retention pass has not run yet — an empty `frames` here used to be the only
  // signal the describer got, so it never asked to look at the session at all.
  assert.deepEqual(result.frames, []);
  assert.equal(result.capturedFrameCount, 3);
  assert.deepEqual(result.capturedRangeMs, { fromMs: 1000, toMs: 3000 });
});

test("list_frames lists retained frames alongside the captured inventory", async (t) => {
  const { dir, framesDir, manifestPath } = await session(t);
  const retained: FrameRecord[] = [
    {
      file: "event_2000_f_2000.jpg",
      tMs: STARTED_AT + 2000,
      offsetSec: 2,
      source: "event",
      phash: "0123456789abcdef",
      reason: "app.activate",
    },
  ];
  await writeFile(path.join(framesDir, "frames.json"), JSON.stringify(retained));

  const result = listFrames(
    dir,
    new FrameExtractor({
      capturedFramesPath: manifestPath,
      capturedFramesExpected: true,
      framesDir,
      anchorEpochMs: STARTED_AT,
    }),
  );
  assert.equal(result.capturedFrameCount, 3);
  assert.deepEqual(result.frames, [
    { file: "event_2000_f_2000.jpg", atMs: 2000, source: "event", reason: "app.activate" },
  ]);
});

test("list_frames reports an empty captured inventory for a session with no video", async (t) => {
  const { dir, framesDir } = await session(t);

  const withoutVideo = listFrames(dir, null);
  assert.deepEqual(withoutVideo, {
    hasVideo: false,
    capturedFrameCount: 0,
    capturedRangeMs: null,
    frames: [],
  });

  // A session whose manifest is missing entirely must not claim a range either.
  const empty = listFrames(
    dir,
    new FrameExtractor({
      capturedFramesPath: path.join(dir, "nope.json"),
      capturedFramesExpected: true,
      framesDir,
      anchorEpochMs: STARTED_AT,
    }),
  );
  assert.equal(empty.hasVideo, true);
  assert.equal(empty.capturedFrameCount, 0);
  assert.equal(empty.capturedRangeMs, null);
});

test("list_frames tells the model that captured frames are viewable via get_frames", () => {
  const tools = createDescriberTools({
    sessionDir: tmpdir(),
    startedAt: STARTED_AT,
    extractor: null,
    onSubmit: () => {},
  });
  const description = tools.find((t) => t.name === "list_frames")?.description ?? "";
  assert.match(description, /get_frames/);
  assert.match(description, /capturedFrameCount/);
});
