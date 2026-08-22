import { test } from "node:test";
import assert from "node:assert/strict";
import { Broker } from "../src/engine/broker";
import type { Bars } from "../src/engine/mtf";

const approx = (a: number, b: number, eps = 1e-9): void => {
  assert.ok(Math.abs(a - b) < eps, `expected ${a} ≈ ${b}`);
};

function makeBars(rows: [number, number, number, number][]): Bars {
  const n = rows.length;
  return {
    symbol: "TESTUSDT",
    interval: "5m",
    time: rows.map((_, i) => i * 300_000),
    open: rows.map((r) => r[0]),
    high: rows.map((r) => r[1]),
    low: rows.map((r) => r[2]),
    close: rows.map((r) => r[3]),
    volume: rows.map(() => 1000),
    closeTime: rows.map((_, i) => (i + 1) * 300_000 - 1),
    length: n,
  };
}

const OPTS = {
  initialCapital: 1000,
  commissionPct: 0.05,
  slippageTicks: 2,
  tickSize: 0.01,
  qtyCash: 930,
};
const REASONS = { tp: { RR1: "TP1", RR2: "TP2", RR3: "TP", "RR X": "TP" }, sl: "SL" };

test("market entry fills at next bar open + slippage, cash sizing, commission", () => {
  const bars = makeBars([
    [100, 101, 99, 100.5],
    [100.6, 101, 100, 100.8],
  ]);
  const b = new Broker(OPTS);
  b.queueEntry("entry");         // placed at close of bar 0
  b.processOpen(bars, 1);        // fills at bar 1 open
  const expectedFill = 100.6 + 2 * 0.01;
  approx(b.avgPrice, expectedFill);
  approx(b.positionQty, 930 / expectedFill);
  approx(b.commissionPaid, expectedFill * (930 / expectedFill) * 0.0005);
});

test("stop fills at stop - slippage; green bar hits stop before limit", () => {
  const bars = makeBars([
    [100, 100, 100, 100],
    [100, 100, 100, 100],  // entry fills here at 100.02
    [100, 106, 94, 105],   // green bar: BOTH stop (95) and limit (105) inside range
  ]);
  const b = new Broker(OPTS);
  b.queueEntry("entry");
  b.processOpen(bars, 1);
  b.setExitLeg("RR X", null, 105, 95, 1); // issued at close of bar 1
  b.processIntrabar(bars, 2, REASONS);
  assert.equal(b.closed.length, 1);
  const trade = b.closed[0]!;
  assert.equal(trade.exitReason, "SL");   // green bar → open→low first
  approx(trade.exitPrice!, 95 - 0.02);
  assert.ok(b.isFlat);
});

test("red bar hits limit before stop", () => {
  const bars = makeBars([
    [100, 100, 100, 100],
    [100, 100, 100, 100],
    [100, 106, 94, 95],    // red bar (close < open): open→high first
  ]);
  const b = new Broker(OPTS);
  b.queueEntry("entry");
  b.processOpen(bars, 1);
  b.setExitLeg("RR X", null, 105, 95, 1);
  b.processIntrabar(bars, 2, REASONS);
  assert.equal(b.closed[0]!.exitReason, "TP");
  approx(b.closed[0]!.exitPrice!, 105);   // limit fills at limit, no slippage
});

test("gap down opens below stop: fills at open - slippage", () => {
  const bars = makeBars([
    [100, 100, 100, 100],
    [100, 100, 100, 100],
    [90, 92, 89, 91],      // gaps below the 95 stop
  ]);
  const b = new Broker(OPTS);
  b.queueEntry("entry");
  b.processOpen(bars, 1);
  b.setExitLeg("RR X", null, 105, 95, 1);
  b.processIntrabar(bars, 2, REASONS);
  approx(b.closed[0]!.exitPrice!, 90 - 0.02);
});

test("partial legs: TP1 fills its qty, runner + stop protect the rest", () => {
  const bars = makeBars([
    [100, 100, 100, 100],
    [100, 100, 100, 100],  // entry ~100.02
    [100, 103, 99, 102.5], // green: hits TP1 at 102, stop 95 untouched
    [102, 102, 94, 94.5],  // stop 95 hit → remaining legs stop out
  ]);
  const b = new Broker(OPTS);
  b.queueEntry("entry");
  b.processOpen(bars, 1);
  const qty = b.positionQty;
  b.setExitLeg("RR1", qty * 0.4, 102, 95, 1);
  b.setExitLeg("RR3", null, 110, 95, 1);
  b.processIntrabar(bars, 2, REASONS);
  assert.equal(b.closed.length, 1);
  assert.equal(b.closed[0]!.exitReason, "TP1");
  approx(b.closed[0]!.qty, qty * 0.4);
  approx(b.positionQty, qty * 0.6);
  // next bar: stop takes the rest
  b.setExitLeg("RR3", null, 110, 95, 2);
  b.processIntrabar(bars, 3, REASONS);
  assert.equal(b.closed.length, 2);
  assert.equal(b.closed[1]!.exitReason, "SL");
  assert.ok(b.isFlat);
});

test("legs are inactive on their issue bar (TV order timing)", () => {
  const bars = makeBars([
    [100, 100, 100, 100],
    [100, 106, 94, 100],   // stop+limit range but leg issued THIS bar → no fill
    [100, 100, 100, 100],
  ]);
  const b = new Broker(OPTS);
  b.queueEntry("entry");
  b.processOpen(bars, 1);
  b.setExitLeg("RR X", null, 105, 95, 1);
  b.processIntrabar(bars, 1, REASONS);   // same bar as issue → inactive
  assert.equal(b.closed.length, 0);
  assert.ok(!b.isFlat);
});

test("market close fills at open - slippage and cancels legs", () => {
  const bars = makeBars([
    [100, 100, 100, 100],
    [100, 100, 100, 100],
    [101, 106, 94, 100],   // close order fills at open before intrabar levels
  ]);
  const b = new Broker(OPTS);
  b.queueEntry("entry");
  b.processOpen(bars, 1);
  b.setExitLeg("RR X", null, 105, 95, 1);
  b.queueClose("HL Break");
  b.processOpen(bars, 2);
  assert.equal(b.closed.length, 1);
  assert.equal(b.closed[0]!.exitReason, "HL Break");
  approx(b.closed[0]!.exitPrice!, 101 - 0.02);
  b.processIntrabar(bars, 2, REASONS);   // legs must be gone
  assert.equal(b.closed.length, 1);
});

test("per-leg pnl is net of exit commission + pro-rata entry commission", () => {
  const bars = makeBars([
    [100, 100, 100, 100],
    [100, 100, 100, 100],
    [100, 111, 100, 110],
  ]);
  const b = new Broker(OPTS);
  b.queueEntry("entry");
  b.processOpen(bars, 1);
  const entryPx = b.avgPrice;
  const qty = b.positionQty;
  const entryComm = entryPx * qty * 0.0005;
  b.setExitLeg("RR X", null, 110, 90, 1);
  b.processIntrabar(bars, 2, REASONS);
  const t = b.closed[0]!;
  const exitComm = 110 * qty * 0.0005;
  approx(t.pnl!, (110 - entryPx) * qty - exitComm - entryComm);
  // realizedNet must equal the sum of trade pnls when fully closed
  approx(b.realizedNet, t.pnl!);
});
