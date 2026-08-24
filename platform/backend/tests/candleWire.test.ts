/**
 * The compact candle wire format.
 *
 * Measured on the chart's default 10,000-bar 15m request
 * (`scripts/bench_candles.ts`): 2,487,844 -> 674,250 bytes, 249 -> 67 per bar,
 * and 11.1 -> 4.2 ms to `JSON.parse`. That parse is on the browser's main
 * thread before anything can be drawn, and it repeats on every symbol and
 * timeframe switch.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fromCompact, isCompact, toCompact } from "../src/data/candleWire";
import { INTERVALS, INTERVAL_MS, type Candle, type Interval } from "../src/types/market";

function series(interval: Interval, count: number): Candle[] {
  const step = INTERVAL_MS[interval];
  return Array.from({ length: count }, (_, i) => {
    const openTime = i * step;
    const price = 100 + i * 0.01;
    return {
      symbol: "APTUSDT", interval, openTime,
      open: price, high: price + 0.5, low: price - 0.5, close: price + 0.2,
      volume: 1000 + i, quoteVolume: (1000 + i) * price, tradeCount: 42,
      closeTime: openTime + step - 1,
    } satisfies Candle;
  });
}

test("a compact round trip preserves every value to Binance's tick precision", () => {
  /*
   * The comparison is to 8 decimal places, not bit-exact, and that is the
   * intended behaviour rather than a tolerance being papered over. Binance
   * sends prices as decimal strings with at most 8 places; `parseFloat` yields
   * a double whose shortest representation sometimes carries printing noise.
   * This fixture's own `100 + i * 0.01` produces `100.21000000000001` for a
   * value that means `100.21`, and the round trip returns `100.21` — closer to
   * what the exchange sent than what went in. The next test asserts that
   * directly.
   */
  const at8 = (n: number): number => Number(n.toFixed(8));
  for (const interval of INTERVALS) {
    const original = series(interval, 50);
    const back = fromCompact(toCompact(original, "APTUSDT", interval));
    assert.equal(back.length, original.length, interval);
    for (let i = 0; i < original.length; i++) {
      const a = original[i]!, b = back[i]!;
      assert.equal(b.openTime, a.openTime, interval);
      assert.equal(b.closeTime, a.closeTime, `${interval}: closeTime must be derivable`);
      assert.equal(b.open, at8(a.open), interval);
      assert.equal(b.high, at8(a.high), interval);
      assert.equal(b.low, at8(a.low), interval);
      assert.equal(b.close, at8(a.close), interval);
      assert.equal(b.volume, at8(a.volume), interval);
      assert.equal(b.symbol, a.symbol, interval);
      assert.equal(b.interval, a.interval, interval);
      // And the difference is never material: at most one part in 1e8.
      assert.ok(Math.abs(b.open - a.open) <= Math.max(1e-8, Math.abs(a.open) * 1e-9), interval);
    }
  }
});

test("the payload is materially smaller — that is the whole point", () => {
  const original = series("15m", 2000);
  const verbose = Buffer.byteLength(JSON.stringify(original), "utf8");
  const compact = Buffer.byteLength(JSON.stringify(toCompact(original, "APTUSDT", "15m")), "utf8");
  assert.ok(compact < verbose * 0.45, `${compact} vs ${verbose} — expected well under half`);
});

test("rounding recovers the value Binance sent, rather than its float noise", () => {
  // Binance sends prices as decimal strings with at most 8 places. `parseFloat`
  // then yields a double whose shortest representation sometimes carries
  // printing noise, and that noise costs bytes on every bar.
  const noisy: Candle[] = [{
    symbol: "APTUSDT", interval: "15m", openTime: 0,
    open: 0.1 + 0.2,            // 0.30000000000000004
    high: 100.3 * 3,            // 300.90000000000003
    low: 1, close: 2, volume: 3,
    closeTime: 899_999,
  }];
  const [bar] = toCompact(noisy, "APTUSDT", "15m").bars;
  assert.equal(bar![1], 0.3);
  assert.equal(bar![2], 300.9);
});

test("eight decimal places survive — Binance's maximum tick precision", () => {
  const precise: Candle[] = [{
    symbol: "SHIBUSDT", interval: "1m", openTime: 0,
    open: 0.00001234, high: 0.00001299, low: 0.00001201, close: 0.00001250,
    volume: 123456789.12345678, closeTime: 59_999,
  }];
  const back = fromCompact(toCompact(precise, "SHIBUSDT", "1m"));
  assert.equal(back[0]!.open, 0.00001234);
  assert.equal(back[0]!.high, 0.00001299);
  assert.equal(back[0]!.close, 0.00001250);
});

test("the envelope carries the step, so closeTime needs no lookup table", () => {
  const payload = toCompact(series("4h", 3), "APTUSDT", "4h");
  assert.equal(payload.stepMs, INTERVAL_MS["4h"]);
  assert.equal(payload.count, 3);
  assert.equal(payload.format, "compact-v1");
});

test("each bar is exactly six positional values", () => {
  for (const bar of toCompact(series("1h", 10), "APTUSDT", "1h").bars) {
    assert.equal(bar.length, 6);
    for (const v of bar) assert.equal(typeof v, "number");
  }
});

test("an empty series produces an empty, well-formed envelope", () => {
  const payload = toCompact([], "APTUSDT", "15m");
  assert.deepEqual(payload.bars, []);
  assert.equal(payload.count, 0);
  assert.deepEqual(fromCompact(payload), []);
});

test("isCompact distinguishes the envelope from a plain candle array", () => {
  assert.equal(isCompact(toCompact(series("15m", 2), "APTUSDT", "15m")), true);
  assert.equal(isCompact(series("15m", 2)), false);
  assert.equal(isCompact(null), false);
  assert.equal(isCompact({ format: "something-else" }), false);
});

test("a non-finite price becomes 0 rather than `null` in the JSON", () => {
  // `JSON.stringify(NaN)` is `null`, which would expand back to a null price
  // and break every downstream arithmetic silently.
  const broken: Candle[] = [{
    symbol: "X", interval: "15m", openTime: 0,
    open: NaN, high: Infinity, low: 1, close: 2, volume: 3, closeTime: 899_999,
  }];
  const [bar] = toCompact(broken, "X", "15m").bars;
  assert.equal(bar![1], 0);
  assert.equal(bar![2], 0);
  assert.ok(!JSON.stringify(toCompact(broken, "X", "15m")).includes("null"));
});
