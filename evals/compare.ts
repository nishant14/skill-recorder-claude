// Offline A/B comparison of two describer eval runs — the decision instrument for
// "which general GPT deployment gives the best cost-vs-quality for the Describer".
//
// Reads two `evals/results/*.json` files (write them with `npm run eval --
// --model=<deployment> --repeat=3`) and prints, per scenario and overall: mean score,
// mean tokens, mean latency for each file, and the deltas. Give it the four price
// flags and it also prints mean cost per analysis and cost per score point.
//
// Run:
//   node --experimental-transform-types --no-warnings --import ./evals/register.mjs \
//     evals/compare.ts <a.json> <b.json> \
//     [--price-in-a=<$ per 1M> --price-out-a=… --price-in-b=… --price-out-b=…]
//
// **There are no default prices, and none are hardcoded.** Model rates change and are
// not knowable from inside this repo; read them off the Azure AI Foundry pricing page
// for the two deployments you actually created and pass them in. Without the flags the
// tool prints the tokens-only comparison and says so.
//
// Pure file reading + arithmetic (the math lives in `compare-lib.ts`): no network, no
// model calls, no new dependencies. Safe to run any number of times.

import { readFileSync } from "node:fs";

import {
  compareResults,
  costPerAnalysis,
  costPerScorePoint,
  normalizeResults,
  type Comparison,
  type ComparisonRow,
  type Means,
  type Prices,
  type ResultsFile,
} from "./compare-lib";

const USAGE = `Usage:
  node --experimental-transform-types --no-warnings --import ./evals/register.mjs \\
    evals/compare.ts <a.json> <b.json> \\
    [--price-in-a=<$ per 1M tokens> --price-out-a=… --price-in-b=… --price-out-b=…]`;

interface Flags {
  files: string[];
  prices: { a: Prices; b: Prices } | null;
}

function parsePrice(arg: string, value: string): number {
  const parsed = Number(value.replace(/[$,\s]/g, ""));
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${arg} must be a non-negative number of dollars per 1M tokens (got "${value}").`);
  }
  return parsed;
}

const PRICE_FLAGS = ["--price-in-a", "--price-out-a", "--price-in-b", "--price-out-b"] as const;

function parseFlags(argv: string[]): Flags {
  const files: string[] = [];
  const prices = new Map<string, number>();
  for (const arg of argv) {
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if ((PRICE_FLAGS as readonly string[]).includes(name)) {
      if (eq === -1) throw new Error(`${name} needs a value, e.g. ${name}=1.25`);
      prices.set(name, parsePrice(name, arg.slice(eq + 1)));
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`Unknown flag ${name}.\n\n${USAGE}`);
    files.push(arg);
  }
  if (files.length !== 2) throw new Error(`Expected exactly two results files.\n\n${USAGE}`);

  // All four or none: pricing one side only would print a comparison that isn't one.
  const given = PRICE_FLAGS.filter((f) => prices.has(f));
  if (given.length !== 0 && given.length !== PRICE_FLAGS.length) {
    throw new Error(
      `Pricing needs all four flags (missing ${PRICE_FLAGS.filter((f) => !prices.has(f)).join(", ")}). ` +
        `Take the rates from the Azure AI Foundry pricing page for each deployment.`,
    );
  }
  return {
    files,
    prices:
      given.length === PRICE_FLAGS.length
        ? {
            a: {
              inputPerMillion: prices.get("--price-in-a") ?? 0,
              outputPerMillion: prices.get("--price-out-a") ?? 0,
            },
            b: {
              inputPerMillion: prices.get("--price-in-b") ?? 0,
              outputPerMillion: prices.get("--price-out-b") ?? 0,
            },
          }
        : null,
  };
}

function load(file: string): ResultsFile {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`Could not read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    return normalizeResults(raw);
  } catch (err) {
    throw new Error(`${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// --- formatting -------------------------------------------------------------

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const pp = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}pp`;
const tokens = (v: number) => Math.round(v).toLocaleString("en-US");
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const signed = (v: number, format: (n: number) => string) =>
  `${v >= 0 ? "+" : "-"}${format(Math.abs(v))}`;

/** Enough decimals that a fraction of a cent per analysis is still legible. */
function money(v: number): string {
  const digits = v !== 0 && Math.abs(v) < 0.01 ? 5 : Math.abs(v) < 1 ? 4 : 2;
  return `$${v.toFixed(digits)}`;
}

/** A left-aligned first column and right-aligned numbers, sized to the content. */
function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, i) => (i === 0 ? cell.padEnd(widths[i]) : cell.padStart(widths[i])))
      .join("  ")
      .trimEnd();
  console.log(line(headers));
  console.log(widths.map((w) => "─".repeat(w)).join("  "));
  for (const row of rows) console.log(line(row));
}

// --- report -----------------------------------------------------------------

/** Zero runs is as uncomparable as a missing scenario — print dashes, not 0.0%. */
const measured = (m: Means | null): Means | null => (m && m.runs > 0 ? m : null);

function qualityRows(comparison: Comparison): string[][] {
  const row = (label: string, means: Means | null, other: Means | null): string[] => {
    const a = measured(means);
    const b = measured(other);
    if (!a || !b) {
      return [label, a ? pct(a.score) : "—", b ? pct(b.score) : "—", "n/a", "—", "—", "n/a", "—", "—"];
    }
    return [
      label,
      pct(a.score),
      pct(b.score),
      pp(b.score - a.score),
      tokens(a.inputTokens + a.outputTokens),
      tokens(b.inputTokens + b.outputTokens),
      signed(b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens), tokens),
      secs(a.durationMs),
      secs(b.durationMs),
    ];
  };
  return [
    ...comparison.rows.map((r: ComparisonRow) => row(r.id, r.a, r.b)),
    row("OVERALL", comparison.overallA, comparison.overallB),
  ];
}

function costRows(comparison: Comparison, prices: { a: Prices; b: Prices }): string[][] {
  const row = (label: string, means: Means | null, other: Means | null): string[] => {
    const a = measured(means);
    const b = measured(other);
    if (!a || !b) return [label, "—", "—", "n/a", "—", "—"];
    const costA = costPerAnalysis(a, prices.a);
    const costB = costPerAnalysis(b, prices.b);
    const pointA = costPerScorePoint(costA, a.score);
    const pointB = costPerScorePoint(costB, b.score);
    return [
      label,
      money(costA),
      money(costB),
      signed(costB - costA, money),
      pointA === null ? "n/a" : money(pointA),
      pointB === null ? "n/a" : money(pointB),
    ];
  };
  return [
    ...comparison.rows.map((r) => row(r.id, r.a, r.b)),
    row("OVERALL", comparison.overallA, comparison.overallB),
  ];
}

function spread(means: Means): string {
  if (means.runs <= 1) return "";
  return ` · score ${pct(means.scoreMin)}–${pct(means.scoreMax)} over ${means.runs} runs`;
}

function main(): void {
  const flags = parseFlags(process.argv.slice(2));
  const [fileA, fileB] = flags.files;
  const a = load(fileA);
  const b = load(fileB);
  const comparison = compareResults(a, b);

  console.log(`\nDescriber eval comparison — A vs B\n`);
  console.log(`  A  ${a.model}  ·  repeat ${a.repeat}  ·  ${a.at}  ·  ${fileA}${spread(comparison.overallA)}`);
  console.log(`  B  ${b.model}  ·  repeat ${b.repeat}  ·  ${b.at}  ·  ${fileB}${spread(comparison.overallB)}`);
  console.log("");

  printTable(
    ["scenario", "score A", "score B", "Δ score", "tokens A", "tokens B", "Δ tokens", "time A", "time B"],
    qualityRows(comparison),
  );

  console.log("");
  if (flags.prices) {
    console.log(
      `Cost at the rates you supplied — ` +
        `A: $${flags.prices.a.inputPerMillion}/1M in, $${flags.prices.a.outputPerMillion}/1M out · ` +
        `B: $${flags.prices.b.inputPerMillion}/1M in, $${flags.prices.b.outputPerMillion}/1M out. ` +
        `A score point is 1% of the rubric.`,
    );
    console.log("");
    printTable(
      ["scenario", "$/analysis A", "$/analysis B", "Δ $/analysis", "$/score-pt A", "$/score-pt B"],
      costRows(comparison, flags.prices),
    );
  } else {
    console.log(
      "Cost columns need prices: pass --price-in-a, --price-out-a, --price-in-b and\n" +
        "--price-out-b (dollars per 1M tokens, from the Azure AI Foundry pricing page for\n" +
        "each deployment). Without them this is a tokens-only comparison.",
    );
  }

  if (comparison.overallA.runs === 0) {
    console.log(
      "\nNote: the two files share no scenario, so there is nothing to compare. Run both\n" +
        "models over the same scenario set (same --only, if any).",
    );
  }
  const missing = [...comparison.onlyInA, ...comparison.onlyInB];
  if (missing.length) {
    console.log(
      `\nNote: ${missing.join(", ")} ran in only one of the files; those scenarios are ` +
        `excluded from OVERALL.`,
    );
  }
  console.log("");
}

try {
  main();
} catch (err) {
  console.error(`\n${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
}
