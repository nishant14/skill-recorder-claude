// Eval harness: runs the multi-turn describer against each fixed scenario and
// scores the resulting analysis against its rubric.
//
// For every scenario it: materializes a synthetic session (session.json +
// events.jsonl) into a temp sessions root, runs the real post-stop pipeline
// (processSession → bundle.json + description.md), invokes the real
// Describer.analyze (the same agent the app uses), then scores the analysis.
//
// With `--repeat=N` each scenario runs N times end to end — a fresh session id, a
// fresh materialization and a fresh agent conversation per rep — and the harness
// records the tokens each rep billed. That is what makes a results file comparable
// across deployments: see `evals/compare.ts`.
//
// Run:
//   node --experimental-transform-types --import ./evals/register.mjs evals/run.ts [flags]
// Flags:
//   --only=slug,slug   run a subset of scenarios
//   --judge            also run the optional semantic LLM judge
//   --keep             print the temp sessions dir (artifacts kept for inspection)
//   --model=<id>       override the describer model (else auto vision model)
//   --repeat=N         run every scenario N times (default 1) for mean score/cost

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Analysis } from "../common/analysis";
import { processSession } from "../electron/pipeline";
import { Describer } from "../electron/describer/describer";
import { summarize, type Means, type RunRow } from "./compare-lib";
import { judgeAnalysis, type JudgeResult } from "./judge";
import { makeSessionMeta, materializeEvents, type Scenario } from "./scenario";
import { scenarios } from "./scenarios/index";
import { scoreAnalysis, type ScoreResult } from "./scoring";

interface Flags {
  only: Set<string> | null;
  judge: boolean;
  keep: boolean;
  model?: string;
  repeat: number;
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { only: null, judge: false, keep: false, repeat: 1 };
  for (const arg of argv) {
    if (arg.startsWith("--only=")) flags.only = new Set(arg.slice(7).split(",").map((s) => s.trim()).filter(Boolean));
    else if (arg === "--judge") flags.judge = true;
    else if (arg === "--keep") flags.keep = true;
    else if (arg.startsWith("--model=")) flags.model = arg.slice(8);
    else if (arg.startsWith("--repeat=")) {
      const n = Number(arg.slice(9));
      if (!Number.isInteger(n) || n < 1) {
        console.error(`--repeat must be a positive integer (got "${arg.slice(9)}").`);
        process.exit(2);
      }
      flags.repeat = n;
    }
  }
  return flags;
}

/** One end-to-end describer run: its verdict, its latency and what it billed. */
interface RunResult {
  rep: number;
  sessionId: string;
  ok: boolean;
  error?: string;
  durationMs: number;
  stepCount?: number;
  intent?: string;
  score?: ScoreResult;
  judge?: JudgeResult;
  /** Describer tokens only — the optional judge runs on its own session. */
  inputTokens: number;
  outputTokens: number;
  requests: number;
}

/**
 * A scenario's result. The top-level verdict fields mirror the **first** rep so a
 * single-run results file keeps exactly the shape it has always had; `runs` and
 * `means` are the additions that make repeated runs comparable.
 */
interface ScenarioResult {
  id: string;
  title: string;
  /** True only when every rep passed. */
  ok: boolean;
  error?: string;
  durationMs: number;
  stepCount?: number;
  intent?: string;
  score?: ScoreResult;
  judge?: JudgeResult;
  runs: RunResult[];
  means: Means;
}

function materialize(root: string, scenario: Scenario, sessionId: string): string {
  const startedAt = Date.now();
  const raw = scenario.build();
  const durationMs = Math.max(0, ...raw.map((e) => e.atMs)) + 1000;
  const events = materializeEvents(raw, startedAt);
  const meta = makeSessionMeta(sessionId, startedAt, durationMs, scenario.platform ?? "darwin");

  const dir = path.join(root, sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "session.json"), JSON.stringify(meta, null, 2));
  writeFileSync(
    path.join(dir, "events.jsonl"),
    events.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
  return dir;
}

const bar = "─".repeat(64);

const tokens = (v: number) => Math.round(v).toLocaleString("en-US");

/**
 * One rep, start to finish. Each rep gets its own session id, so the reps never share
 * a sessions directory, and the describer's conversation is dropped afterwards — the
 * agent must reconstruct the recording from scratch every time, or a rep would be
 * scoring a cheaper follow-up turn instead of a first analysis. Usage is read *before*
 * that disposal, because dropping the conversation drops its counters with it.
 */
async function runOnce(
  describer: Describer,
  scenario: Scenario,
  sessionId: string,
  rep: number,
  root: string,
  flags: Flags,
): Promise<RunResult> {
  const started = Date.now();
  const run: RunResult = {
    rep,
    sessionId,
    ok: false,
    durationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    requests: 0,
  };
  try {
    const dir = materialize(root, scenario, sessionId);
    await processSession(dir);
    const analysis: Analysis = await describer.analyze(sessionId);
    run.stepCount = analysis.steps.length;
    run.intent = analysis.intent;
    run.score = scoreAnalysis(analysis, scenario.rubric);
    run.ok = run.score.pass;
    if (flags.judge) {
      try {
        run.judge = await judgeAnalysis(scenario, analysis, flags.model);
      } catch (err) {
        console.error(`   judge failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    run.error = err instanceof Error ? err.message : String(err);
  } finally {
    const usage = describer.usageFor(sessionId);
    if (usage) {
      run.inputTokens = usage.inputTokens;
      run.outputTokens = usage.outputTokens;
      run.requests = usage.requests;
    }
    await describer.forget(sessionId).catch(() => undefined);
    run.durationMs = Date.now() - started;
  }
  return run;
}

const toRunRow = (r: RunResult): RunRow => ({
  score: r.score?.score ?? 0,
  pass: r.ok,
  durationMs: r.durationMs,
  inputTokens: r.inputTokens,
  outputTokens: r.outputTokens,
});

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.model) process.env.SKILL_RECORDER_MODEL = flags.model;
  // Recorded in the results file so a comparison can name what it compared. An
  // externally exported env var counts too; "default" means the configured deployment.
  const model = process.env.SKILL_RECORDER_MODEL || "default";

  // Sessions root: honor an external override, else an isolated temp dir.
  let root = process.env.SKILL_RECORDER_SESSIONS_DIR;
  if (!root) {
    root = mkdtempSync(path.join(os.tmpdir(), "sr-evals-"));
    process.env.SKILL_RECORDER_SESSIONS_DIR = root;
  }

  const selected = scenarios.filter((s) => !flags.only || flags.only.has(s.id));
  if (selected.length === 0) {
    console.error("No scenarios matched", flags.only ? [...flags.only] : "");
    process.exit(2);
  }

  console.error(`\nSkill Recorder — describer evals`);
  console.error(`${selected.length} scenario(s) · sessions root: ${root}`);
  if (flags.repeat > 1) console.error(`model: ${model} · ${flags.repeat} runs per scenario`);
  if (flags.judge) console.error("semantic judge: ON");
  console.error(bar);

  const describer = new Describer((p) => {
    if (p.message) process.stderr.write(`   · [${p.sessionId}] ${p.message}\n`);
  });

  const results: ScenarioResult[] = [];
  for (const scenario of selected) {
    console.error(`\n▶ ${scenario.id} — ${scenario.title}`);
    const runs: RunResult[] = [];
    for (let rep = 1; rep <= flags.repeat; rep++) {
      // A suffix only when repeating, so a plain run keeps using the scenario slug.
      const sessionId = flags.repeat === 1 ? scenario.id : `${scenario.id}-r${rep}`;
      const run = await runOnce(describer, scenario, sessionId, rep, root, flags);
      runs.push(run);
      printRun(run, flags.repeat);
    }
    const first = runs[0];
    const res: ScenarioResult = {
      id: scenario.id,
      title: scenario.title,
      ok: runs.every((r) => r.ok),
      error: first.error,
      durationMs: first.durationMs,
      stepCount: first.stepCount,
      intent: first.intent,
      score: first.score,
      judge: first.judge,
      runs,
      means: summarize(runs.map(toRunRow)),
    };
    if (flags.repeat > 1) printMeans(res.means);
    results.push(res);
  }

  await describer.dispose();

  // Persist + summarize.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outFile = path.join(process.cwd(), "evals", "results", `${stamp}.json`);
  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(
    outFile,
    JSON.stringify({ at: stamp, model, repeat: flags.repeat, root, results }, null, 2),
  );

  console.error(`\n${bar}\nSummary`);
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) {
    const scored = r.runs.some((run) => run.score);
    const pct = scored ? `${Math.round(r.means.score * 100)}%` : "  — ";
    const status = r.error ? "ERROR" : r.ok ? "PASS " : "FAIL ";
    const cost =
      flags.repeat > 1
        ? `  · in ${tokens(r.means.inputTokens)} / out ${tokens(r.means.outputTokens)} · ${(r.means.durationMs / 1000).toFixed(1)}s`
        : "";
    console.error(`  ${status}  ${pct.padStart(4)}  ${r.id}${r.error ? `  (${r.error})` : ""}${cost}`);
  }
  const suffix = flags.repeat > 1 ? ` (all ${flags.repeat} runs)` : "";
  console.error(`\n  ${passed}/${results.length} scenarios passed${suffix}`);
  if (flags.keep) console.error(`  artifacts: ${root}`);
  console.error(`  results:   ${path.relative(process.cwd(), outFile)}\n`);

  process.exit(passed === results.length ? 0 : 1);
}

function printRun(r: RunResult, repeat: number): void {
  if (repeat > 1) {
    if (r.error) {
      console.error(`   rep ${r.rep} ✗ error: ${r.error}`);
      return;
    }
    console.error(
      `   rep ${r.rep} · score ${Math.round((r.score?.score ?? 0) * 100)}% · ${r.ok ? "PASS" : "FAIL"} · ` +
        `steps ${r.stepCount} · ${(r.durationMs / 1000).toFixed(1)}s · ` +
        `tokens in ${tokens(r.inputTokens)} / out ${tokens(r.outputTokens)} (${r.requests} req)`,
    );
    for (const c of r.score?.checks ?? []) {
      if (!c.pass) console.error(`     ✗ ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
    }
    if (r.judge) console.error(`     judge: ${r.judge.score}/5 — ${r.judge.verdict}`);
    return;
  }

  if (r.error) {
    console.error(`   ✗ error: ${r.error}`);
    return;
  }
  console.error(`   intent: ${r.intent}`);
  console.error(`   steps: ${r.stepCount} · score: ${Math.round((r.score?.score ?? 0) * 100)}% · ${r.ok ? "PASS" : "FAIL"} · ${(r.durationMs / 1000).toFixed(1)}s`);
  for (const c of r.score?.checks ?? []) {
    if (!c.pass) console.error(`     ✗ ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
  }
  if (r.judge) console.error(`   judge: ${r.judge.score}/5 — ${r.judge.verdict}`);
}

/** The line a model comparison actually reads: means, plus how much the score moved. */
function printMeans(m: Means): void {
  const spread =
    m.runs > 1
      ? ` (min ${Math.round(m.scoreMin * 100)}% – max ${Math.round(m.scoreMax * 100)}%)`
      : "";
  console.error(
    `   mean score ${Math.round(m.score * 100)}%${spread} · mean ${(m.durationMs / 1000).toFixed(1)}s · ` +
      `mean tokens in ${tokens(m.inputTokens)} / out ${tokens(m.outputTokens)} · ` +
      `${Math.round(m.passRate * 100)}% of runs passed`,
  );
}

main().catch((err) => {
  console.error("Harness crashed:", err);
  process.exit(3);
});
