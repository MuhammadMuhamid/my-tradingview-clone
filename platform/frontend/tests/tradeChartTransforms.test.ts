import test from "node:test";
import assert from "node:assert/strict";
import { footprintBars, rangeBarSize, rangeBars, tradesThroughHorizon } from "../lib/tradeChartTransforms";
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

test("range splits multi-range upward and downward jumps without oversize bars", () => {
  const up = rangeBars([
    { id: 1, timestamp: 1, price: 100, quantity: 1, aggressor: "buy" },
    { id: 2, timestamp: 2, price: 135, quantity: 2, aggressor: "buy" },
  ], 10, 1);
  assert.deepEqual(up.map((b) => [b.open, b.close]), [[100, 110], [110, 120], [120, 130], [130, 135]]);
  assert.ok(up.every((b) => b.high - b.low <= 10));
  const down = rangeBars([
    { id: 1, timestamp: 1, price: 100, quantity: 1, aggressor: "sell" },
    { id: 2, timestamp: 2, price: 65, quantity: 2, aggressor: "sell" },
  ], 10, 1);
  assert.deepEqual(down.map((b) => [b.open, b.close]), [[100, 90], [90, 80], [80, 70], [70, 65]]);
  assert.ok(down.every((b) => b.high - b.low <= 10));
});

test("range replay prefixes are deterministic at exact and sub-cent boundaries", () => {
  const trades = [
    { id: 1, timestamp: 1, price: 1.0000, quantity: 1, aggressor: "buy" as const },
    { id: 2, timestamp: 2, price: 1.0005, quantity: 1, aggressor: "buy" as const },
    { id: 3, timestamp: 3, price: 1.0013, quantity: 1, aggressor: "sell" as const },
  ];
  const batch = rangeBars(trades, 0.0005, 0.0001);
  assert.deepEqual(batch.map((b) => [Number(b.open.toFixed(4)), Number(b.close.toFixed(4))]), [[1, 1.0005], [1.0005, 1.001], [1.001, 1.0013]]);
  assert.deepEqual(rangeBars(tradesThroughHorizon(trades, 2), 0.0005, 0.0001)
    .map((b) => [b.open, b.close]), [[1, 1.0005]]);
  assert.ok(batch.every((b) => b.high - b.low <= 0.0005 + 1e-9));
});

test("range exact-boundary transitions preserve a continuous forming origin", () => {
  const cases: Array<[string, number[], number[][]]> = [
    ["up", [100, 110, 115], [[100, 110], [110, 115]]],
    ["down", [100, 90, 85], [[100, 90], [90, 85]]],
    ["same price", [100, 110, 110], [[100, 110], [110, 110]]],
    ["sequential", [100, 110, 120], [[100, 110], [110, 120]]],
    ["reversal", [100, 110, 105], [[100, 110], [110, 105]]],
  ];
  for (const [name, prices, expected] of cases) {
    const bars = rangeBars(prices.map((price, i) => ({ id: i + 1, timestamp: i + 1, price, quantity: 1, aggressor: "buy" as const })), 10, 1);
    assert.deepEqual(bars.map((bar) => [bar.open, bar.close]), expected, name);
  }
});

test("range multi-boundary jumps remain bounded and continuous through continuation/reversal", () => {
  const scenarios: Array<[number[], number[][]]> = [
    [[100, 135], [[100, 110], [110, 120], [120, 130], [130, 135]]],
    [[100, 65], [[100, 90], [90, 80], [80, 70], [70, 65]]],
    [[100, 135, 138], [[100, 110], [110, 120], [120, 130], [130, 138]]],
    [[100, 135, 127], [[100, 110], [110, 120], [120, 130], [130, 127]]],
  ];
  for (const [prices, expected] of scenarios) {
    const bars = rangeBars(prices.map((price, i) => ({ id: i + 1, timestamp: i + 1, price, quantity: 1, aggressor: "buy" as const })), 10, 1);
    assert.deepEqual(bars.map((bar) => [bar.open, bar.close]), expected);
    for (let i = 1; i < bars.length; i += 1) assert.equal(bars[i - 1]!.close, bars[i]!.open);
    for (const bar of bars.slice(0, -1)) assert.equal(Math.abs(bar.close - bar.open), 10);
  }
});

test("range quantizes floating-point-hostile ticks and repeated equal executions", () => {
  const bars = rangeBars([
    { id: 1, timestamp: 1, price: 0.3, quantity: 1, aggressor: "buy" as const },
    { id: 2, timestamp: 2, price: 0.3, quantity: 1, aggressor: "buy" as const },
    { id: 3, timestamp: 3, price: 0.5, quantity: 1, aggressor: "sell" as const },
  ], 0.1, 0.1);
  assert.deepEqual(bars.map((bar) => [Number(bar.open.toFixed(1)), Number(bar.close.toFixed(1))]), [[0.3, 0.4], [0.4, 0.5]]);
  assert.ok(bars.every((bar) => bar.high - bar.low <= 0.1 + 1e-9));
});

test("F-1 — range bars ascend strictly, and keep their real market time", () => {
  /*
   * Range was the one bar producer here with no monotonic guard: it emitted
   * the raw execution timestamp, so one trade crossing three boundaries
   * emitted three bars carrying that one timestamp. The PRODUCTION
   * `lightweight-charts` bundle does not assert ascending order — only the
   * development build does — so `setData` accepted the duplicates, indexed all
   * but one to 0, and every subsequent bar-colour lookup failed
   * `ensureNotNull(findBar(...))`. That is the `Value is null` thrown 36 times
   * on Range and zero times on any other chart type.
   *
   * Renko, Kagi, Point & Figure and Line break all space their bars and keep
   * the honest time beside the key. Range does both now.
   */
  const bars = rangeBars([
    { id: 1, timestamp: 1_700_000_000_123, price: 100.00, quantity: 1, aggressor: "buy" },
    { id: 2, timestamp: 1_700_000_001_456, price: 101.00, quantity: 1, aggressor: "buy" },
    { id: 3, timestamp: 1_700_000_002_789, price: 100.50, quantity: 1, aggressor: "sell" },
  ], 0.20, 0.01);

  assert.ok(bars.length > 3, "one execution crossing several ranges must complete several bars");
  for (let i = 1; i < bars.length; i += 1) {
    assert.ok(bars[i]!.openTime > bars[i - 1]!.openTime,
      `bar ${i} does not follow bar ${i - 1}: ${bars[i]!.openTime} <= ${bars[i - 1]!.openTime}`);
  }
  // The series key is `openTime / 1000` and the renderer's time points are
  // integers, so a whole second is the spacing — the same reason Renko spaces
  // its bricks by 1000ms rather than by 1.
  for (const bar of bars) {
    assert.ok(Number.isInteger(bar.openTime / 1000),
      `a fractional time point reaches the series: ${bar.openTime}`);
  }
  // The ordering key may be invented. The market time may not.
  assert.deepEqual(
    [...new Set(bars.map((b) => b.sourceOpenTime))].sort((a, b) => a - b),
    [1_700_000_000_123, 1_700_000_001_456, 1_700_000_002_789],
    "every bar must carry the timestamp of the execution that completed it",
  );
  for (const bar of bars) {
    assert.ok(bar.sourceOpenTime <= bar.openTime + 1_000 * bars.length,
      "the ordering key must stay in the neighbourhood of the real time");
  }
});

test("F-1 — the default range size follows the instrument's price", () => {
  /*
   * Twenty ticks is $0.20 on a $76,000 instrument — 0.00026% of price — and a
   * sensible bar on a $3 one. A fixed tick count cannot be right for both, so
   * the control stays absolute and the default is relative.
   */
  const btc = rangeBarSize(0.01, 20, true, 76_000);
  const doge = rangeBarSize(0.00001, 20, true, 0.24);
  assert.ok(btc > 20, `an automatic BTC bar must not be twenty ticks: ${btc}`);
  assert.ok(Math.abs(btc / 76_000 - 0.0005) < 1e-6, `five basis points of price: ${btc}`);
  assert.ok(Math.abs(doge / 0.24 - 0.0005) < 1e-4, `five basis points of price: ${doge}`);

  // An explicit number is a decision, and a decision is kept.
  assert.equal(rangeBarSize(0.01, 20, false, 76_000), 0.2);
  // And it degrades to the absolute size rather than to nothing.
  assert.equal(rangeBarSize(0.01, 20, true, null), 0.2);
  assert.equal(rangeBarSize(0.01, 20, true, 0), 0.2);
  assert.equal(rangeBarSize(0, 20, true, 76_000), 0, "no tick size means no bar size");
  assert.ok(rangeBarSize(0.01, 20, true, 0.005) >= 0.01, "never below one tick");
});
