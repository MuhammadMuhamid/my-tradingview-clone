import { test } from "node:test";
import assert from "node:assert/strict";
import { Broker } from "../src/engine/broker";
import type { Bars } from "../src/engine/mtf";

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
  commissionPct: 0,
  slippageTicks: 0,
  tickSize: 0.01,
  qtyCash: 1000,
  fillOnBarClose: true,
};
const REASONS = { tp: { "Long X": "TP" }, sl: "SL" };

test("workingLegs exposes the live stop/target of an open position", () => {
  const bars = makeBars([
    [100, 101, 99, 100],
    [100, 102, 99, 101],
    [101, 103, 100, 102],
  ]);
  const b = new Broker(OPTS);
  b.queueEntry("entry");
  b.setExitLeg("Long X", null, 110, 95, 0);
  b.processClose(bars, 0);

  assert.equal(b.positionQty > 0, true);
  assert.equal(b.avgPrice, 100);
  const legs = b.workingLegs;
  assert.equal(legs.length, 1);
  assert.equal(legs[0]!.stop, 95);
  assert.equal(legs[0]!.limit, 110);
});

test("workingLegs is empty once the position closes", () => {
  const bars = makeBars([
    [100, 101, 99, 100],
    [100, 102, 94, 96],   // low 94 ≤ stop 95 → SL fills
  ]);
  const b = new Broker(OPTS);
  b.queueEntry("entry");
  b.setExitLeg("Long X", null, 110, 95, 0);
  b.processClose(bars, 0);
  b.processIntrabar(bars, 1, REASONS);

  assert.equal(b.isFlat, true);
  assert.equal(b.workingLegs.length, 0);
  assert.equal(b.closed.length, 1);
  assert.equal(b.closed[0]!.exitReason, "SL");
});

test("reading workingLegs does not disturb fills", () => {
  const bars = makeBars([
    [100, 101, 99, 100],
    [100, 112, 99, 111],  // high 112 ≥ target 110 → TP fills
  ]);
  const run = (peek: boolean): Broker => {
    const b = new Broker(OPTS);
    b.queueEntry("entry");
    b.setExitLeg("Long X", null, 110, 95, 0);
    b.processClose(bars, 0);
    if (peek) void b.workingLegs;
    b.processIntrabar(bars, 1, REASONS);
    if (peek) void b.workingLegs;
    return b;
  };
  const a = run(false), c = run(true);
  assert.equal(a.closed.length, c.closed.length);
  assert.equal(a.closed[0]!.exitPrice, c.closed[0]!.exitPrice);
  assert.equal(a.closed[0]!.pnl, c.closed[0]!.pnl);
  assert.equal(a.realizedNet, c.realizedNet);
});

test("an open position is excluded from realized results", () => {
  const bars = makeBars([
    [100, 101, 99, 100],
    [100, 102, 99, 101],
  ]);
  const b = new Broker(OPTS);
  b.queueEntry("entry");
  b.setExitLeg("Long X", null, 110, 95, 0);
  b.processClose(bars, 0);
  // Nothing realized while the trade runs, but equity marks to market.
  assert.equal(b.closed.length, 0);
  assert.equal(b.equityAt(101) > 1000, true);
});
