import test from "node:test";
import assert from "node:assert/strict";
import { footprintBars, rangeBars, tradesThroughHorizon } from "../lib/tradeChartTransforms";
import { resolvePriceTick } from "../lib/priceTick";

test("footprint preserves bid/ask levels, totals, delta and deduplicates executions", () => {
  const bars = footprintBars([
    { id: 2, timestamp: 61_000, price: 100.01, quantity: 2, aggressor: "sell" },
    { id: 1, timestamp: 60_000, price: 100.00, quantity: 3, aggressor: "buy" },
    { id: 2, timestamp: 61_000, price: 100.01, quantity: 2, aggressor: "sell" },
    { id: 3, timestamp: 62_000, price: 100.00, quantity: 1, aggressor: "sell" },
  ], 60_000, 0.01);
  assert.equal(bars.length, 1);
  assert.equal(bars[0]!.totalVolume, 6);
  assert.equal(bars[0]!.delta, 0);
  assert.deepEqual(bars[0]!.levels, [
    { price: 100, buyVolume: 3, sellVolume: 1, totalVolume: 4, delta: 2 },
    { price: 100.01, buyVolume: 0, sellVolume: 2, totalVolume: 2, delta: -2 },
  ]);
});

test("range bars honour a sub-cent provider tick", () => {
  const bars = rangeBars([
    { timestamp: 1, price: 1.0001, quantity: 1, aggressor: "buy" },
    { timestamp: 2, price: 1.0003, quantity: 1, aggressor: "sell" },
  ], 0.0002, 0.0001);
  assert.equal(bars.length, 1);
  assert.equal(bars[0]!.high, 1.0003);
});

test("canonical instrument resolves provider tick by canonical id or compact symbol", () => {
  const canonical = "instrument:v1:COINBASE:spot:BTC:USD:USD:spot";
  assert.equal(resolvePriceTick([
    { symbol: "BTCUSD", canonicalId: canonical, priceTick: 0.01 },
  ], canonical), 0.01);
  assert.equal(resolvePriceTick([
    { symbol: "BTCUSDT", canonicalId: null, priceTick: 0.0001 },
  ], "BTCUSDT"), 0.0001);
  assert.equal(resolvePriceTick([{ symbol: "X", canonicalId: null, priceTick: null }], "X"), null);
});

test("replay footprint clips future executions at the horizon", () => {
  const trades = [
    { id: 1, timestamp: 1000, price: 10, quantity: 1, aggressor: "buy" as const },
    { id: 2, timestamp: 2000, price: 11, quantity: 2, aggressor: "sell" as const },
  ];
  assert.deepEqual(tradesThroughHorizon(trades, 1500).map((t) => t.id), [1]);
  assert.deepEqual(footprintBars(tradesThroughHorizon(trades, 1500), 1000, 1).flatMap((b) => b.levels).map((l) => l.price), [10]);
});
