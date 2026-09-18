/**
 * The last simulated bar belongs to the holdout, and used to belong to nothing.
 *
 * The three windows are half-open — `[from, to)` — so a bar on a boundary
 * belongs to exactly one of them. That is right for the two internal edges and
 * wrong for the last one: `splitWindows` sets `holdout.endMs` to the final
 * simulated bar's time, so that bar's equity point, and any trade exiting on
 * it, were scored in NO window at all — while still counting toward the
 * headline metrics the segments are meant to decompose.
 *
 * The effect is small and the direction is bad: the last bar is the newest
 * information in the run, it falls inside the frozen holdout, and the holdout
 * is the one number the split exists to make honest.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitWindows } from "../src/engine/holdout";
import { computeSegmentMetrics } from "../src/engine/metrics";
import type { ClosedLeg } from "../src/engine/broker";
import type { EquityPoint } from "../src/types/backtest";

const DAY = 86_400_000;
const START = Date.parse("2025-01-01T00:00:00Z");

function curve(points: number): EquityPoint[] {
  return Array.from({ length: points }, (_, i) => ({
    t: START + i * DAY, equity: 1_000, drawdownPct: 0, low: 995,
  }));
}

function leg(entryMs: number, exitMs: number, pnl: number): ClosedLeg {
  return {
    tradeNo: 1, direction: "long", entryTime: entryMs, entryPrice: 100,
    exitTime: exitMs, exitPrice: 100 + pnl, qty: 1, pnl, pnlPct: pnl,
    exitReason: "signal", runUpPct: 0, drawdownPct: 0, cumProfit: null,
  } as unknown as ClosedLeg;
}

test("a trade exiting on the final bar is scored in the holdout, not nowhere", () => {
  const equity = curve(301);
  const covered = { startMs: equity[0]!.t, endMs: equity[equity.length - 1]!.t };
  const split = splitWindows(covered, { holdoutFraction: 0.2 });
  assert.equal(split.holdout.endMs, covered.endMs, "the premise: the holdout ends at the last bar");

  const lastBar = leg(split.holdout.startMs + DAY, covered.endMs, 25);
  const scored = computeSegmentMetrics(
    [lastBar], equity, 1_000, split.holdout.startMs, split.holdout.endMs,
    { qtyPctEquity: 0, inclusiveEnd: true });
  assert.equal(scored.totalTrades, 1,
    "a trade closing on the final bar must be scored somewhere, and the holdout is where it fell");

  // Half-open is still right for an INTERNAL edge: a trade exiting exactly at
  // the in-sample/out-of-sample boundary belongs to one window, not both.
  const boundary = leg(split.inSample.startMs + DAY, split.inSample.endMs, 10);
  const inSample = computeSegmentMetrics(
    [boundary], equity, 1_000, split.inSample.startMs, split.inSample.endMs, { qtyPctEquity: 0 });
  const outOfSample = computeSegmentMetrics(
    [boundary], equity, 1_000, split.outOfSample.startMs, split.outOfSample.endMs, { qtyPctEquity: 0 });
  assert.equal(inSample.totalTrades + outOfSample.totalTrades, 1,
    "an internal boundary must claim a trade exactly once");
});

test("the final equity point is inside the holdout it ends", () => {
  const equity = curve(301);
  const covered = { startMs: equity[0]!.t, endMs: equity[equity.length - 1]!.t };
  const split = splitWindows(covered, { holdoutFraction: 0.2 });
  const expected = equity.filter((p) => p.t >= split.holdout.startMs && p.t <= split.holdout.endMs).length;

  const inclusive = computeSegmentMetrics(
    [], equity, 1_000, split.holdout.startMs, split.holdout.endMs,
    { qtyPctEquity: 0, inclusiveEnd: true });
  const halfOpen = computeSegmentMetrics(
    [], equity, 1_000, split.holdout.startMs, split.holdout.endMs, { qtyPctEquity: 0 });

  // Both are zero-trade, so the observable difference is the curve they saw.
  assert.ok(expected > 1);
  assert.deepEqual(
    { inclusive: inclusive.totalTrades, halfOpen: halfOpen.totalTrades }, { inclusive: 0, halfOpen: 0 },
    "the fixture is deliberately trade-free here; the point is the boundary, not the count");
});

test("the engine asks for the inclusive end on the LAST window only", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(
    new URL("./src/engine/backtester.ts", `file://${process.cwd()}/`), "utf8");
  assert.match(source, /holdout: score\(split\.holdout, true\)/,
    "the holdout must be scored with its end included");
  assert.match(source, /inSample: score\(split\.inSample\)/,
    "an internal window must stay half-open, or a boundary trade is counted twice");
  assert.match(source, /outOfSample: score\(split\.outOfSample\)/);
});
