/**
 * A finished run says where its development data ends — and refuses to when
 * the division would mean nothing.
 *
 * `engine/holdout.ts` and `computeSegmentMetrics` had been in this engine,
 * tested, since the `OPT-01` work, and nothing in production called either. So
 * a backtest was one contiguous number: no surface could show a user which
 * part of it the strategy was developed on and which part it had not seen, and
 * the owner's recollection of "about nine months, then about three" could not
 * be found in the product because the product never displayed a split.
 *
 * Two things are pinned here, and the second matters more than the first:
 *
 *  1. a fixed-cash run divides into in-sample, out-of-sample and a FROZEN
 *     holdout taken from the end, over the window actually simulated;
 *  2. a compounding run REFUSES to divide, in words, rather than returning a
 *     plausible-looking number. Under percent-of-equity sizing a later
 *     window's outcomes depend on how the earlier one performed, so rebasing
 *     each window to the initial capital produces a figure with no
 *     interpretation — and a meaningless out-of-sample figure is precisely
 *     what selection then optimises against.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitWindows } from "../src/engine/holdout";
import { computeSegmentMetrics } from "../src/engine/metrics";
import type { ClosedLeg } from "../src/engine/broker";
import type { EquityPoint } from "../src/types/backtest";

const DAY = 86_400_000;
const START = Date.parse("2025-01-01T00:00:00Z");
const END = START + 300 * DAY;

/** A flat curve with an intrabar low, which is what a segment drawdown reads. */
function curve(fromMs: number, toMs: number, stepMs = DAY): EquityPoint[] {
  const out: EquityPoint[] = [];
  for (let t = fromMs; t <= toMs; t += stepMs) {
    out.push({ t, equity: 1_000, drawdownPct: 0, low: 995 });
  }
  return out;
}

function leg(entryMs: number, exitMs: number, pnl: number): ClosedLeg {
  return {
    tradeNo: 1, direction: "long", entryTime: entryMs, entryPrice: 100,
    exitTime: exitMs, exitPrice: 100 + pnl, qty: 1, pnl, pnlPct: pnl,
    exitReason: "signal", runUpPct: 0, drawdownPct: 0, cumProfit: null,
  } as unknown as ClosedLeg;
}

test("the split covers the whole window, in order, with the holdout last", () => {
  const split = splitWindows({ startMs: START, endMs: END }, { holdoutFraction: 0.2 });

  assert.equal(split.inSample.startMs, START, "in-sample must start at the beginning");
  assert.equal(split.holdout.endMs, END, "the holdout must run to the end");
  assert.equal(split.inSample.endMs, split.outOfSample.startMs, "no gap, and no overlap");
  assert.equal(split.outOfSample.endMs, split.holdout.startMs, "no gap, and no overlap");

  // A fifth of the range, frozen, taken from the end — the only portion whose
  // price action cannot have influenced anything already selected.
  const total = END - START;
  assert.ok(Math.abs((split.holdout.endMs - split.holdout.startMs) / total - 0.2) < 0.01,
    "the frozen holdout must be the fraction that was asked for");
});

test("the fraction is a parameter, and an impossible one is refused", () => {
  // The figure is a research-policy decision, which is the whole reason it is
  // not a constant. A caller who wants a third can have a third.
  const third = splitWindows({ startMs: START, endMs: END }, { holdoutFraction: 1 / 3 });
  const total = END - START;
  assert.ok(Math.abs((third.holdout.endMs - third.holdout.startMs) / total - 1 / 3) < 0.01);

  for (const bad of [0, 1, -0.5, 1.5, Number.NaN]) {
    assert.throws(() => splitWindows({ startMs: START, endMs: END }, { holdoutFraction: bad }),
      /holdoutFraction must be strictly between 0 and 1/,
      `a holdout fraction of ${bad} must be refused, not clamped`);
  }
});

test("a segment is scored over its own window, and a trade is placed by its EXIT", () => {
  const split = splitWindows({ startMs: START, endMs: END }, { holdoutFraction: 0.2 });
  const equity = curve(START, END);

  // A trade opened on the last in-sample day and closed well inside the
  // out-of-sample window belongs to the window that resolved it: its
  // out-of-sample price action is the thing the split exists to hold back.
  const straddler = leg(split.inSample.endMs - DAY, split.outOfSample.startMs + 10 * DAY, 50);
  const inSample = computeSegmentMetrics(
    [straddler], equity, 1_000, split.inSample.startMs, split.inSample.endMs, { qtyPctEquity: 0 });
  const outOfSample = computeSegmentMetrics(
    [straddler], equity, 1_000, split.outOfSample.startMs, split.outOfSample.endMs, { qtyPctEquity: 0 });

  assert.equal(inSample.totalTrades, 0,
    "a trade the in-sample window did not resolve must not be scored as in-sample");
  assert.equal(outOfSample.totalTrades, 1,
    "the window that resolved the trade is the window that owns it");
});

test("a compounding run refuses to be divided, rather than being divided wrongly", () => {
  const split = splitWindows({ startMs: START, endMs: END }, { holdoutFraction: 0.2 });
  assert.throws(
    () => computeSegmentMetrics(
      [leg(START + DAY, START + 2 * DAY, 10)], curve(START, END), 1_000,
      split.inSample.startMs, split.inSample.endMs, { qtyPctEquity: 100 }),
    /valid only under fixed-cash sizing/,
    "segment metrics from a compounding run have no interpretation and must not be produced",
  );
});

test("the engine records the refusal in words a reader can act on", async () => {
  // The product must not simply omit the segments when it cannot compute them:
  // a missing block reads as "not implemented", and the real answer is "this
  // run's sizing makes the question meaningless, and here is what to change".
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(
    new URL("./src/engine/backtester.ts", `file://${process.cwd()}/`), "utf8");
  assert.match(source, /available: false/, "a run that cannot split must say so explicitly");
  assert.match(source, /fixed cash size/,
    "the refusal must name the change that would answer the question");
  assert.match(source, /covered/,
    "the split must be taken over the window that was simulated, not the one requested");
});
