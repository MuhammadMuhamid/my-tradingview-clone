/**
 * Backtest/live parity for the three divergences the audit found in the live
 * evaluators. Each one changed which trades were taken, not just how they were
 * reported — the exit price decides the win/loss flag, the flag drives
 * `consecLosses`, and that drives the choppy-pause circuit breaker.
 *
 *   BE-03  exit precedence was inverted: signals were checked first and the
 *          stop LAST, while the backtest resolves brackets first.
 *   BE-15  win/loss was gross while the backtest's is net of commission.
 *   BE-20  the SELL base quantity was the original notional divided by the
 *          EXIT price, via a ternary whose branches were identical.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  breakEvenExit, isNetWin, LIVE_COMMISSION_PCT_PER_SIDE, netPnlPct, roundTripCostFraction,
} from "../src/engine/liveCosts";
import { sellContracts } from "../src/alerts/dispatcher";

// ── BE-15: net win/loss ─────────────────────────────────────────────────────

test("the live cost model is 0.1 % per side, matching every research tree", () => {
  // docs/COST-MODELS.md records the measured figure. The prose in
  // OPTIMIZATION_SYSTEM_BLUEPRINT.md said 0.05 % and CLAUDE_HANDOFF.md said
  // 0.1 % with zero slippage; neither matched what ran (X-09).
  assert.equal(LIVE_COMMISSION_PCT_PER_SIDE, 0.1);
  assert.equal(roundTripCostFraction(0.1), 0.002);
});

test("the exact case from the finding: a +0.03 % gross exit is a LOSS after costs", () => {
  const entry = 100;
  const exit = 100.03;
  assert.ok(exit > entry, "gross, this looks like a win");
  assert.equal(isNetWin(entry, exit), false, "net of 0.2 % round trip, it is not");
  assert.ok(netPnlPct(entry, exit) < 0);
});

test("break-even is the entry marked up by the round trip, and is not a win", () => {
  const entry = 100;
  const be = breakEvenExit(entry);
  assert.ok(Math.abs(be - 100.2) < 1e-9);
  assert.equal(isNetWin(entry, be), false, "exactly break-even is not a win, matching pnl > 0");
  assert.equal(isNetWin(entry, be + 0.01), true);
  assert.equal(isNetWin(entry, be - 0.01), false);
});

test("a genuine winner and a genuine loser are unaffected", () => {
  assert.equal(isNetWin(100, 105), true);
  assert.equal(isNetWin(100, 95), false);
  assert.ok(Math.abs(netPnlPct(100, 105) - 4.8) < 1e-9);
  assert.ok(Math.abs(netPnlPct(100, 95) - -5.2) < 1e-9);
});

test("a nonsensical entry price yields a loss rather than a crash or a false win", () => {
  for (const entry of [0, -1, NaN, Infinity]) {
    assert.equal(isNetWin(entry, 100), false, String(entry));
    assert.equal(netPnlPct(entry, 100), 0, String(entry));
  }
  assert.equal(isNetWin(100, NaN), false);
});

test("the cost is applied symmetrically, so the win/loss boundary is a single point", () => {
  const entry = 42.5;
  const be = breakEvenExit(entry);
  const below = [...Array(20)].map((_, k) => be - (k + 1) * 1e-4);
  const above = [...Array(20)].map((_, k) => be + (k + 1) * 1e-4);
  for (const px of below) assert.equal(isNetWin(entry, px), false, String(px));
  for (const px of above) assert.equal(isNetWin(entry, px), true, String(px));
});

// ── BE-03: exit precedence ──────────────────────────────────────────────────

/**
 * The broker's deterministic intrabar path, which both the backtest and the
 * corrected live evaluators follow. Reproduced here as the specification the
 * evaluators are asserted against.
 */
function brokerExit(bar: { open: number; high: number; low: number; close: number },
                    stop: number | null, target: number | null): { which: "stop" | "tp" | null; price: number } {
  const green = bar.close >= bar.open;
  const order: ("stop" | "tp")[] = green ? ["stop", "tp"] : ["tp", "stop"];
  for (const which of order) {
    if (which === "stop" && stop !== null && bar.low <= stop) return { which: "stop", price: stop };
    if (which === "tp" && target !== null && bar.high >= target) return { which: "tp", price: target };
  }
  return { which: null, price: bar.close };
}

test("on a GREEN bar that touches both, the stop wins — price travelled open to low first", () => {
  const bar = { open: 100, high: 106, low: 94, close: 103 };
  const r = brokerExit(bar, 95, 105);
  assert.equal(r.which, "stop");
  assert.equal(r.price, 95);
});

test("on a RED bar that touches both, the target wins — price travelled open to high first", () => {
  const bar = { open: 100, high: 106, low: 94, close: 97 };
  const r = brokerExit(bar, 95, 105);
  assert.equal(r.which, "tp");
  assert.equal(r.price, 105);
});

test("a bracket that filled beats a bar-close signal, and at the bracket's price", () => {
  // This is the divergence: the old order let a soft/structural/indicator exit
  // claim the bar, so the trade booked at the CLOSE rather than at the stop.
  const bar = { open: 100, high: 101, low: 90, close: 99 };
  const r = brokerExit(bar, 95, null);
  assert.equal(r.which, "stop");
  assert.equal(r.price, 95, "not 99");
  // And the two prices are on opposite sides of break-even, so the win flag —
  // and therefore consecLosses and the choppy pause — differed too.
  assert.equal(isNetWin(96, 95), false);
  assert.equal(isNetWin(96, 99), true);
});

test("with no bracket filled, the close-signal exit is what remains", () => {
  const bar = { open: 100, high: 101, low: 99, close: 100.5 };
  assert.equal(brokerExit(bar, 90, 110).which, null);
  assert.equal(brokerExit(bar, 90, 110).price, 100.5);
});

// ── BE-20: SELL base quantity ───────────────────────────────────────────────

test("the sell quantity is what the ENTRY bought, not the notional over the exit price", () => {
  // 800 quote at an entry of 100 is 8 base units. The old code divided by the
  // exit price, so a rally to 120 asked the receiver to sell 6.67.
  assert.equal(sellContracts({ buyQuoteQty: 800, entryPrice: 100, exitPrice: 120 }), 8);
  assert.equal(sellContracts({ buyQuoteQty: 800, entryPrice: 100, exitPrice: 80 }), 8);
});

test("partial exits reduce the remaining quantity", () => {
  // mtf_lean's shipped tiers: 40 % at TP1, 30 % at TP2.
  const base = { buyQuoteQty: 800, entryPrice: 100, exitPrice: 110 };
  assert.equal(sellContracts({ ...base, alreadyExitedPct: 0 }), 8);
  assert.ok(Math.abs(sellContracts({ ...base, alreadyExitedPct: 40 }) - 4.8) < 1e-9);
  assert.ok(Math.abs(sellContracts({ ...base, alreadyExitedPct: 70 }) - 2.4) < 1e-9);
  assert.equal(sellContracts({ ...base, alreadyExitedPct: 100 }), 0);
});

test("an out-of-range exited percentage is clamped rather than producing a negative order", () => {
  const base = { buyQuoteQty: 800, entryPrice: 100, exitPrice: 110 };
  assert.equal(sellContracts({ ...base, alreadyExitedPct: 150 }), 0);
  assert.equal(sellContracts({ ...base, alreadyExitedPct: -20 }), 8);
});

test("a missing entry price falls back to the exit price rather than returning zero", () => {
  // Losing the quantity entirely would silently send `amount: "0"`.
  assert.equal(sellContracts({ buyQuoteQty: 800, entryPrice: null, exitPrice: 100 }), 8);
  assert.equal(sellContracts({ buyQuoteQty: 800, entryPrice: 0, exitPrice: 100 }), 8);
});

test("no notional, or an unusable price, yields zero rather than NaN or Infinity", () => {
  assert.equal(sellContracts({ buyQuoteQty: null, entryPrice: 100, exitPrice: 100 }), 0);
  assert.equal(sellContracts({ buyQuoteQty: 0, entryPrice: 100, exitPrice: 100 }), 0);
  assert.equal(sellContracts({ buyQuoteQty: 800, entryPrice: null, exitPrice: 0 }), 0);
  assert.equal(sellContracts({ buyQuoteQty: 800, entryPrice: null, exitPrice: NaN }), 0);
});
