// Shared seeding for the builder evals (automation + skill).
//
// Both builder harnesses isolate the FINAL stage by freezing the describer's
// output: they write a fixed, approved `analysis.json` (plus a minimal but
// schema-valid `bundle.json`) into a temp sessions dir, then run the real builder
// against it. This module is the single source of that seed logic so the two
// harnesses stay in lockstep (see evals/README.md).

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { toAnalysis, type Analysis, type AnalysisSubmission } from "../../common/analysis";
import { SessionBundleSchema, type SessionBundle } from "../../common/bundle";
import { writeReference } from "../../electron/builders/api-reference-store";

/** The minimum a scenario must supply to be seeded to disk. */
export interface SeedInput {
  /** Slug used as the session id (a single path segment under the sessions root). */
  id: string;
  /** The device OS the built artifact will run on (drives the seeded bundle's platform). */
  platform: NodeJS.Platform;
  /** The approved analysis fed to the builder, exactly as the describer would emit it. */
  analysis: AnalysisSubmission;
  /**
   * An API reference attached to the recording, for scenarios that measure whether the
   * builder maps UI steps onto concrete operations. `spec` is a parsed OpenAPI document;
   * `docs` are plain-text fallback material. Written through the store's own writer, so a
   * seeded session is laid out and indexed exactly like one the user attached in the app.
   */
  apiReference?: {
    spec: object;
    docs?: { name: string; text: string }[];
  };
}

/** Seed the scenario's fixed approved analysis + timeline so the builder can read them. */
export function seedScenario(root: string, scenario: SeedInput): void {
  const dir = path.join(root, scenario.id);
  mkdirSync(dir, { recursive: true });
  if (scenario.apiReference) {
    writeReference(dir, {
      spec: scenario.apiReference.spec,
      ...(scenario.apiReference.docs ? { docs: scenario.apiReference.docs } : {}),
    });
  }
  const analysis: Analysis = {
    ...toAnalysis(scenario.id, 1, scenario.analysis, [], null),
    approved: true,
    approvedAt: Date.now(),
  };
  writeFileSync(path.join(dir, "analysis.json"), JSON.stringify(analysis, null, 2));
  writeFileSync(path.join(dir, "bundle.json"), JSON.stringify(toSeedBundle(scenario), null, 2));
}

const URL_RE = /https?:\/\/\S+/g;

/**
 * A minimal but schema-valid timeline for the builder's `get_timeline` tool, built
 * from the fixed analysis. It carries the device **platform** (so the builder knows
 * it targets macOS or Windows) and each step's app + any URLs/hosts pulled from the
 * analysis evidence — the same grounding the real bundle would provide.
 */
export function toSeedBundle(scenario: SeedInput): SessionBundle {
  const now = Date.now();
  const steps = scenario.analysis.steps.map((s, i) => {
    const urls = (s.evidence.join(" ").match(URL_RE) ?? []).map((u) => u.replace(/[)"']+$/, ""));
    const hosts = [...new Set(urls.map((u) => { try { return new URL(u).host; } catch { return ""; } }).filter(Boolean))];
    const clipboardCount = s.evidence.filter((e) => e.toLowerCase().startsWith("clipboard")).length;
    return {
      index: i,
      startMs: now + i * 1000,
      endMs: now + (i + 1) * 1000,
      durationMs: 1000,
      boundary: (i === 0 ? "start" : "app-change") as SessionBundle["steps"][number]["boundary"],
      app: s.apps[0],
      titles: [],
      hosts,
      urls,
      commands: [],
      clipboardCount,
      markers: [],
      eventSeqs: [i],
      frames: [],
      summary: s.title,
    };
  });
  return SessionBundleSchema.parse({
    version: 1,
    session: {
      id: scenario.id,
      startedAt: now,
      stoppedAt: now + steps.length * 1000,
      durationMs: steps.length * 1000,
      platform: scenario.platform,
      appVersion: "eval",
    },
    steps,
    stats: {
      eventCount: steps.length,
      meaningfulEventCount: steps.length,
      stepCount: steps.length,
      frameCount: 0,
      unexplainedFrameCount: 0,
      silentEventCount: 0,
    },
  });
}
