/**
 * The headline and every window can be read in ONE population.
 *
 * Measured on a default quick run before this existed: the headline said 242
 * trades at a 17.4 % win rate — exit LEGS, from `computeMetrics` — and the
 * windows beneath it said 68 / 148 / 26 trades (legs again) at win rates
 * computed over 60 / 128 / 20 ENTRIES, because `computeSegmentMetrics`
 * overwrote the rate and left the count. No row on the page shared one
 * denominator.
 *
 * `winRatePct` keeps its leg meaning on the headline (walk-forward selection
 * reads it, `OPT-04`), so what is pinned here is that both the headline and
 * every window now carry the ENTRY figures under their own names, and that the
 * two agree when they describe the same legs.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { ClosedLeg } from "../src/engine/broker";
import { computeMetrics, computeSegmentMetrics, entryFigures } from "../src/engine/metrics";
import type { EquityPoint } from "../src/types/backtest";

const DAY = 86_400_000;
const T0 = Date.parse("2025-01-01T00:00:00Z");

function leg(entryBar: number, exitBar: number, pnl: number, reason: string, qty = 1): ClosedLeg {
  return {
    tradeNo: 1, direction: "long",
    entryTime: T0 + entryBar * DAY, entryPrice: 100,
    exitTime: T0 + exitBar * DAY, exitPrice: 100 + pnl / qty,
    qty, pnl, pnlPct: pnl, exitReason: reason,
    runUpPct: 0, drawdownPct: 0, cumProfit: null,
    entryBar, exitBar, commission: 0,
  } as ClosedLeg;
}

/*
 * Three entries closed as six legs, partial take-profits on:
 *   A  TP1 +10, SL -3        → +7, a winning entry with one losing leg
 *   B  SL -5                 → -5
 *   C  TP1 +2, TP2 +2, SL -6 → -2, a LOSING entry with two winning legs
 * Legs: 3 of 6 win (50 %). Entries: 1 of 3 win (33.3 %).
 */
const LEGS: ClosedLeg[] = [
  leg(0, 2, 10, "TP1", 0.5), leg(0, 4, -3, "SL", 0.5),
  leg(10, 11, -5, "SL"),
  leg(20, 21, 2, "TP1", 0.4), leg(20, 22, 2, "TP2", 0.3), leg(20, 25, -6, "SL", 0.3),
];
const EQUITY: EquityPoint[] = Array.from({ length: 40 }, (_, i) => ({
  t: T0 + i * DAY, equity: 1_000, drawdownPct: 0, low: 1_000,
}));

test("entry figures count the entry, not its legs", () => {
  const e = entryFigures(LEGS);
  assert.equal(e.entries, 3);
  assert.equal(e.winningEntries, 1);
  assert.equal(e.losingEntries, 2);
  assert.ok(Math.abs(e.entryWinRatePct - 100 / 3) < 1e-9);
  assert.equal(e.entryProfitFactor, 7 / 7, "gross entry profit 7 over gross entry loss 5 + 2");
  // Bars from entry to the entry's LAST exit: 4, 1, 5.
  assert.ok(Math.abs(e.avgBarsPerEntry - 10 / 3) < 1e-9);

  const legs = computeMetrics(LEGS, EQUITY, 1_000, 0);
  assert.equal(legs.totalTrades, 6, "the leg count is unchanged");
  assert.equal(legs.winRatePct, 50, "and the leg win rate keeps its meaning");
});

test("a window and the headline say the same thing about the same legs", () => {
  // One window spanning every leg: it must agree with the headline's entry
  // figures exactly, and its own `winRatePct` must be the entry rate.
  const whole = computeSegmentMetrics(LEGS, EQUITY, 1_000, T0, T0 + 40 * DAY, {
    qtyPctEquity: 0, inclusiveEnd: true,
  });
  const headline = entryFigures(LEGS);
  for (const key of ["entries", "winningEntries", "losingEntries", "entryWinRatePct",
    "entryProfitFactor", "avgEntryPct", "avgBarsPerEntry"] as const) {
    assert.equal(whole[key], headline[key], key);
  }
  assert.equal(whole.winRatePct, whole.entryWinRatePct, "the window's rate is over entries");
  assert.equal(whole.legWinRatePct, 50, "and the leg rate is kept beside it");
  assert.equal(whole.totalTrades, 6, "totalTrades is still legs — which is why the page must not print it beside an entry rate");
});

test("the headline carries the entry figures too", () => {
  /*
   * `executeBacktest` needs the database, so the wiring is pinned at the
   * source. It is one line, and deleting it puts the page straight back to a
   * leg headline above entry windows.
   */
  const src = fs.readFileSync(path.join(process.cwd(), "src", "engine", "backtester.ts"), "utf8");
  assert.match(src, /Object\.assign\(metrics, entryFigures\(result\.broker\.closed\)\)/);
});

test("an empty window has no entries and no profit factor", () => {
  const e = entryFigures([]);
  assert.deepEqual(e, {
    entries: 0, winningEntries: 0, losingEntries: 0, entryWinRatePct: 0,
    entryProfitFactor: null, avgEntryPct: 0, avgBarsPerEntry: 0,
  });
});
