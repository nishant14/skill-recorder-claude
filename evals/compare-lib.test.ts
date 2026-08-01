import assert from "node:assert/strict";
import test from "node:test";

import {
  compareResults,
  costPerAnalysis,
  costPerScorePoint,
  mean,
  normalizeResults,
  summarize,
  type RunRow,
} from "./compare-lib";

/**
 * Unit tests for the model-comparison arithmetic. Pure functions only: nothing here
 * touches the filesystem, the network or a model — that is the whole reason the math
 * lives in `compare-lib.ts` instead of inside the two CLIs.
 */

const run = (score: number, inputTokens: number, outputTokens: number, durationMs = 1_000): RunRow => ({
  score,
  pass: score >= 0.8,
  durationMs,
  inputTokens,
  outputTokens,
});

// --- means ------------------------------------------------------------------

test("mean of nothing is zero, not NaN", () => {
  assert.equal(mean([]), 0);
  assert.equal(mean([2, 4, 9]), 5);
});

test("summarize reports the mean, the spread and the pass rate", () => {
  const m = summarize([run(1, 10_000, 800, 12_000), run(0.9, 12_000, 900, 10_000), run(0.6, 14_000, 1_300, 8_000)]);
  assert.equal(m.runs, 3);
  assert.equal(Number(m.score.toFixed(4)), 0.8333);
  assert.equal(m.scoreMin, 0.6);
  assert.equal(m.scoreMax, 1);
  assert.equal(Number(m.passRate.toFixed(4)), 0.6667, "two of three runs cleared the rubric");
  assert.equal(m.durationMs, 10_000);
  assert.equal(m.inputTokens, 12_000);
  assert.equal(m.outputTokens, 1_000);
});

test("summarize of no runs is empty rather than a divide-by-zero", () => {
  assert.deepEqual(summarize([]), {
    runs: 0,
    score: 0,
    scoreMin: 0,
    scoreMax: 0,
    passRate: 0,
    durationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
  });
});

// --- cost -------------------------------------------------------------------

test("cost per analysis prices input and output separately, per million tokens", () => {
  const cost = costPerAnalysis(
    { inputTokens: 500_000, outputTokens: 100_000 },
    { inputPerMillion: 2, outputPerMillion: 10 },
  );
  assert.equal(cost, 2); // 0.5 × $2 + 0.1 × $10
  assert.equal(
    costPerAnalysis({ inputTokens: 0, outputTokens: 0 }, { inputPerMillion: 99, outputPerMillion: 99 }),
    0,
  );
});

test("cost per score point divides by percent of rubric, and is null at zero quality", () => {
  assert.equal(costPerScorePoint(2, 1), 0.02, "a perfect score costs cost/100 per point");
  assert.equal(costPerScorePoint(1, 0.5), 0.02, "half the quality doubles the price per point");
  assert.equal(costPerScorePoint(1, 0), null, "no quality has no price per point");
});

// --- results files ----------------------------------------------------------

const resultsFile = (model: string, results: unknown[]) => ({ at: "2026-08-01", model, repeat: 2, results });

const scenarioEntry = (id: string, runs: { score: number; ok: boolean; inputTokens: number; outputTokens: number }[]) => ({
  id,
  title: `${id} title`,
  ok: runs.every((r) => r.ok),
  runs: runs.map((r, i) => ({
    rep: i + 1,
    sessionId: `${id}-r${i + 1}`,
    ok: r.ok,
    durationMs: 10_000,
    score: { score: r.score, pass: r.ok, checks: [] },
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
  })),
});

test("normalizeResults reads per-rep rows out of a repeated run", () => {
  const file = normalizeResults(
    resultsFile("gpt-5.6", [
      scenarioEntry("web-to-spreadsheet", [
        { score: 1, ok: true, inputTokens: 10_000, outputTokens: 500 },
        { score: 0.8, ok: true, inputTokens: 12_000, outputTokens: 700 },
      ]),
    ]),
  );
  assert.equal(file.model, "gpt-5.6");
  assert.equal(file.repeat, 2);
  assert.equal(file.scenarios.length, 1);
  assert.deepEqual(file.scenarios[0].runs, [
    { score: 1, pass: true, durationMs: 10_000, inputTokens: 10_000, outputTokens: 500 },
    { score: 0.8, pass: true, durationMs: 10_000, inputTokens: 12_000, outputTokens: 700 },
  ]);
});

test("a pre-repeat results file still compares, as one run with unknown tokens", () => {
  // Exactly the shape the harness wrote before --repeat existed: no runs, no model,
  // no token counts. It must degrade, not throw — old baselines stay usable.
  const file = normalizeResults({
    at: "2026-07-30",
    results: [
      { id: "invoice-extract", title: "Invoices", ok: true, durationMs: 9_000, score: { score: 0.9, pass: true, checks: [] } },
    ],
  });
  assert.equal(file.model, "unknown");
  assert.equal(file.repeat, 1);
  assert.deepEqual(file.scenarios[0].runs, [
    { score: 0.9, pass: true, durationMs: 9_000, inputTokens: 0, outputTokens: 0 },
  ]);
});

test("a file that is not eval results is rejected with a message about the path", () => {
  assert.throws(() => normalizeResults({ hello: "world" }), /expected a JSON object with a `results` array/);
  assert.throws(() => normalizeResults([1, 2, 3]), /expected a JSON object with a `results` array/);
  assert.throws(() => normalizeResults({ results: [] }), /no scenario results/);
});

// --- comparison -------------------------------------------------------------

test("compareResults pairs shared scenarios and pools only those into the overall", () => {
  const a = normalizeResults(
    resultsFile("model-a", [
      scenarioEntry("shared", [
        { score: 1, ok: true, inputTokens: 10_000, outputTokens: 1_000 },
        { score: 1, ok: true, inputTokens: 10_000, outputTokens: 1_000 },
      ]),
      scenarioEntry("only-a", [{ score: 0.2, ok: false, inputTokens: 90_000, outputTokens: 9_000 }]),
    ]),
  );
  const b = normalizeResults(
    resultsFile("model-b", [
      scenarioEntry("shared", [
        { score: 0.8, ok: true, inputTokens: 4_000, outputTokens: 400 },
        { score: 0.6, ok: false, inputTokens: 6_000, outputTokens: 600 },
      ]),
      scenarioEntry("only-b", [{ score: 1, ok: true, inputTokens: 1_000, outputTokens: 100 }]),
    ]),
  );

  const { rows, overallA, overallB, onlyInA, onlyInB } = compareResults(a, b);
  assert.deepEqual(rows.map((r) => r.id), ["shared", "only-a", "only-b"]);
  assert.deepEqual(onlyInA, ["only-a"]);
  assert.deepEqual(onlyInB, ["only-b"]);

  // A scenario missing from one side has no means on that side — nothing to compare.
  assert.equal(rows[1].b, null);
  assert.equal(rows[2].a, null);

  // The overall covers `shared` only; the lopsided `only-*` runs must not skew it.
  assert.equal(overallA.runs, 2);
  assert.equal(overallA.score, 1);
  assert.equal(overallA.inputTokens, 10_000);
  assert.equal(overallB.runs, 2);
  assert.equal(Number(overallB.score.toFixed(2)), 0.7);
  assert.equal(overallB.inputTokens, 5_000);
  assert.equal(overallB.passRate, 0.5);
});
