// The arithmetic behind the model comparison: run means, score spread, and — only
// ever from prices the user supplies — cost per analysis and cost per score point.
//
// Deliberately pure: no filesystem, no network, no printing, no dates. `run.ts`
// imports it to summarize the reps of one run, `compare.ts` imports it to line two
// result files up against each other, and `compare-lib.test.ts` covers the math
// without either of those. Nothing here knows an Azure price — post-cutoff rates
// are unknowable to this repo, so every cost figure is a function of numbers the
// caller read off the pricing page.

/** One completed describer run: what a rep cost and how well it scored. */
export interface RunRow {
  /** Rubric score, 0..1. */
  score: number;
  pass: boolean;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
}

/** Means (plus the spread) over a set of runs — of one scenario, or of all of them. */
export interface Means {
  runs: number;
  score: number;
  scoreMin: number;
  scoreMax: number;
  /** Fraction of runs whose rubric verdict was PASS, 0..1. */
  passRate: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
}

/** Per-million-token rates, as printed on the deployment's pricing page. */
export interface Prices {
  inputPerMillion: number;
  outputPerMillion: number;
}

export const EMPTY_MEANS: Means = {
  runs: 0,
  score: 0,
  scoreMin: 0,
  scoreMax: 0,
  passRate: 0,
  durationMs: 0,
  inputTokens: 0,
  outputTokens: 0,
};

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Means over a set of runs. Zero runs is a legal, empty answer — never a throw. */
export function summarize(runs: RunRow[]): Means {
  if (runs.length === 0) return { ...EMPTY_MEANS };
  const scores = runs.map((r) => r.score);
  return {
    runs: runs.length,
    score: mean(scores),
    scoreMin: Math.min(...scores),
    scoreMax: Math.max(...scores),
    passRate: runs.filter((r) => r.pass).length / runs.length,
    durationMs: mean(runs.map((r) => r.durationMs)),
    inputTokens: mean(runs.map((r) => r.inputTokens)),
    outputTokens: mean(runs.map((r) => r.outputTokens)),
  };
}

/** Money for one analysis at the given rates. Tokens are per-analysis means. */
export function costPerAnalysis(
  tokens: { inputTokens: number; outputTokens: number },
  prices: Prices,
): number {
  return (
    (tokens.inputTokens / 1_000_000) * prices.inputPerMillion +
    (tokens.outputTokens / 1_000_000) * prices.outputPerMillion
  );
}

/**
 * Cost of one *score point*, where a point is 1% of the rubric — the number that
 * actually decides a cheaper-but-worse model, since a model that costs half as much
 * and scores half as well buys nothing. `null` when the score is zero: quality of
 * zero has no price per point, and printing ∞ would invite a false comparison.
 */
export function costPerScorePoint(cost: number, score: number): number | null {
  const points = score * 100;
  return points > 0 ? cost / points : null;
}

// --- results files ----------------------------------------------------------

/** One scenario's reps, pulled out of a results file. */
export interface ScenarioRuns {
  id: string;
  title: string;
  runs: RunRow[];
}

export interface ResultsFile {
  /** The deployment the run used, or "default" when none was named. */
  model: string;
  repeat: number;
  at: string;
  scenarios: ScenarioRuns[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

const str = (v: unknown, fallback = ""): string => (typeof v === "string" && v ? v : fallback);

/**
 * Read a `evals/results/*.json` file of unknown vintage into run rows.
 *
 * Tolerant on purpose: a file written before `--repeat` existed has no `runs` array,
 * no `model` and no token counts, and it must still compare (as a single run with
 * unknown — zero — tokens) rather than crash the tool. Anything that isn't a results
 * file at all throws a message aimed at the person who typed the path.
 */
export function normalizeResults(raw: unknown): ResultsFile {
  if (!isRecord(raw) || !Array.isArray(raw.results)) {
    throw new Error("Not an eval results file: expected a JSON object with a `results` array.");
  }
  const scenarios: ScenarioRuns[] = [];
  for (const entry of raw.results) {
    if (!isRecord(entry)) continue;
    const id = str(entry.id);
    if (!id) continue;
    const rows = Array.isArray(entry.runs)
      ? entry.runs.filter(isRecord).map(runRow)
      : [runRow(entry)];
    scenarios.push({ id, title: str(entry.title, id), runs: rows });
  }
  if (scenarios.length === 0) throw new Error("The results file contains no scenario results.");
  return {
    model: str(raw.model, "unknown"),
    repeat: num(raw.repeat) || Math.max(...scenarios.map((s) => s.runs.length)),
    at: str(raw.at, "unknown"),
    scenarios,
  };
}

/** One row from a per-rep entry (or, for a pre-`--repeat` file, from the scenario). */
function runRow(entry: Record<string, unknown>): RunRow {
  const score = isRecord(entry.score) ? num(entry.score.score) : 0;
  const pass = isRecord(entry.score) ? entry.score.pass === true : entry.ok === true;
  return {
    score,
    pass,
    durationMs: num(entry.durationMs),
    inputTokens: num(entry.inputTokens),
    outputTokens: num(entry.outputTokens),
  };
}

// --- comparison -------------------------------------------------------------

export interface ComparisonRow {
  id: string;
  title: string;
  /** Null when the scenario is absent from that file — the runs aren't comparable. */
  a: Means | null;
  b: Means | null;
}

export interface Comparison {
  rows: ComparisonRow[];
  /** Pooled over every run of every scenario the two files share. */
  overallA: Means;
  overallB: Means;
  /** Scenario ids present in only one of the files (excluded from the overall). */
  onlyInA: string[];
  onlyInB: string[];
}

/**
 * Line two results files up scenario by scenario. Scenarios present in only one file
 * still get a row (so the gap is visible) but are kept out of the pooled overall —
 * a mean over different scenario sets would not be a comparison.
 */
export function compareResults(a: ResultsFile, b: ResultsFile): Comparison {
  const byIdA = new Map(a.scenarios.map((s) => [s.id, s]));
  const byIdB = new Map(b.scenarios.map((s) => [s.id, s]));
  const ids = [...byIdA.keys(), ...[...byIdB.keys()].filter((id) => !byIdA.has(id))];

  const rows: ComparisonRow[] = [];
  const sharedA: RunRow[] = [];
  const sharedB: RunRow[] = [];
  const onlyInA: string[] = [];
  const onlyInB: string[] = [];

  for (const id of ids) {
    const inA = byIdA.get(id);
    const inB = byIdB.get(id);
    rows.push({
      id,
      title: inA?.title ?? inB?.title ?? id,
      a: inA ? summarize(inA.runs) : null,
      b: inB ? summarize(inB.runs) : null,
    });
    if (inA && inB) {
      sharedA.push(...inA.runs);
      sharedB.push(...inB.runs);
    } else if (inA) onlyInA.push(id);
    else if (inB) onlyInB.push(id);
  }

  return {
    rows,
    overallA: summarize(sharedA),
    overallB: summarize(sharedB),
    onlyInA,
    onlyInB,
  };
}
