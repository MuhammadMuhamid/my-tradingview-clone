/**
 * Characterization tests for the candle-series contract every timeframe relies
 * on: ascending order, one bar per interval slot, aligned open times,
 * closeTime = openTime + interval - 1, and closed-vs-open state.
 *
 * These lock in what the engine already assumes. `ensureCandles` does NOT
 * enforce them today (BE-14) — the assertions here describe the contract that
 * the live path is made to honour in a later phase.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  barOpenTime, checkSeries, dedupeByOpenTime, isAlignedOpenTime, isBarClosed,
  isContiguous, missingBarCount,
} from "../src/data/candleSeries";
import { INTERVALS, INTERVAL_MS, type Candle, type Interval } from "../src/types/market";

function series(interval: Interval, count: number, startOpen = 0): Candle[] {
  const step = INTERVAL_MS[interval];
  return Array.from({ length: count }, (_, i) => {
    const openTime = startOpen + i * step;
    return {
      symbol: "TESTUSDT", interval, openTime,
      open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i,
      volume: 10, closeTime: openTime + step - 1,
    } satisfies Candle;
  });
}

test("a well-formed series passes every structural check, on every supported timeframe", () => {
  for (const interval of INTERVALS) {
    const bars = series(interval, 50);
    const check = checkSeries(bars, interval);
    assert.equal(check.ok, true, `${interval} should be clean`);
    assert.equal(check.bars, 50);
    assert.equal(isContiguous(bars, interval), true, interval);
    assert.equal(missingBarCount(bars, interval), 0, interval);
  }
});

test("a gap is reported with its exact size, not tolerated", () => {
  const bars = series("15m", 10);
  // Drop bars 4 and 5 — the shape `ensureCandles`' 1.5 % heuristic lets through.
  const gapped = [...bars.slice(0, 4), ...bars.slice(6)];
  const check = checkSeries(gapped, "15m");
  assert.equal(check.ok, false);
  assert.equal(check.gaps.length, 1);
  assert.equal(check.gaps[0]!.missingBars, 2);
  assert.equal(check.gaps[0]!.afterOpenTime, bars[3]!.openTime);
  assert.equal(check.gaps[0]!.beforeOpenTime, bars[6]!.openTime);
  assert.equal(missingBarCount(gapped, "15m"), 2);
  assert.equal(isContiguous(gapped, "15m"), false);
});

test("out-of-order bars are reported and not mistaken for a gap", () => {
  const bars = series("1h", 5);
  const swapped = [bars[0]!, bars[2]!, bars[1]!, bars[3]!, bars[4]!];
  const check = checkSeries(swapped, "1h");
  assert.equal(check.ok, false);
  assert.deepEqual(check.outOfOrder, [bars[1]!.openTime]);
});

test("a repeated open time is a duplicate, not a gap", () => {
  const bars = series("5m", 4);
  const dup = [bars[0]!, bars[1]!, bars[1]!, bars[2]!, bars[3]!];
  const check = checkSeries(dup, "5m");
  assert.equal(check.ok, false);
  assert.deepEqual(check.duplicates, [bars[1]!.openTime]);
});

test("dedupeByOpenTime keeps the newest row per slot and re-sorts ascending — the DB upsert rule", () => {
  const bars = series("5m", 3);
  const updated = { ...bars[1]!, close: 999 };
  const merged = dedupeByOpenTime([bars[2]!, bars[0]!, bars[1]!, updated]);
  assert.deepEqual(merged.map((c) => c.openTime), bars.map((c) => c.openTime));
  assert.equal(merged[1]!.close, 999);
});

test("open times must sit on the interval grid", () => {
  assert.equal(isAlignedOpenTime(1_700_000_100_000, "1m"), true);
  assert.equal(isAlignedOpenTime(1_700_000_100_001, "1m"), false);
  const bad = series("15m", 3).map((c, i) => (i === 1 ? { ...c, openTime: c.openTime + 1 } : c));
  assert.equal(checkSeries(bad, "15m").misaligned.length, 1);
});

test("closeTime is the last millisecond of the bar, for every timeframe", () => {
  for (const interval of INTERVALS) {
    const [bar] = series(interval, 1, INTERVAL_MS[interval] * 1000);
    assert.equal(bar!.closeTime - bar!.openTime + 1, INTERVAL_MS[interval], interval);
  }
  const wrong = series("1h", 2).map((c, i) => (i === 0 ? { ...c, closeTime: c.openTime + 3_600_000 } : c));
  assert.deepEqual(checkSeries(wrong, "1h").badCloseTime, [wrong[0]!.openTime]);
});

test("barOpenTime floors any timestamp onto its bar", () => {
  const open = barOpenTime(1_700_000_123_456, "15m");
  assert.equal(open % INTERVAL_MS["15m"], 0);
  assert.ok(open <= 1_700_000_123_456);
  assert.ok(open + INTERVAL_MS["15m"] > 1_700_000_123_456);
});

test("a bar is open until wall-clock passes its final millisecond", () => {
  const [bar] = series("1m", 1, 1_700_000_000_000);
  assert.equal(isBarClosed(bar!, bar!.closeTime - 1), false);
  assert.equal(isBarClosed(bar!, bar!.closeTime), false, "the final ms still belongs to the bar");
  assert.equal(isBarClosed(bar!, bar!.closeTime + 1), true);
});

/**
 * Phase 2: a bar that closes early is a short bucket, not a corrupt row.
 *
 * Binance's `closeTime` is the end of the DATA in the bucket. On a day the
 * exchange only ran for part of, it is genuinely earlier than the grid's last
 * millisecond. BTCUSDT 2018-02-08 is exactly that: `closeTime` 00:28:14.788,
 * one hourly bar for the whole day, and a daily bar whose OHLCV equals that
 * hour's exactly — the row is right, and it is the only one like it in eight
 * years of BTCUSDT dailies.
 *
 * The old rule condemned any closeTime that was not `openTime + step - 1`, and
 * `inspectCandleIntegrity` treats that verdict as fatal, so every BTCUSDT and
 * ETHUSDT daily request deep enough to reach 2018 answered 502 and drew no
 * chart at all. The rule that matters is whether the closeTime is INSIDE the
 * bar it claims to be: a closeTime at or past the next bar's open means the
 * row is not this bar, and that is still fatal.
 */
test("a closeTime inside the bar is a short bucket; one outside it is corruption", () => {
  const step = INTERVAL_MS["1d"];
  const [first, second] = series("1d", 2, step * 100);

  // The real shape: BTCUSDT 2018-02-08 — 28 minutes into its own day.
  const short = [{ ...first!, closeTime: first!.openTime + 28 * 60_000 }, second!];
  const shortCheck = checkSeries(short, "1d");
  assert.deepEqual(shortCheck.shortCloseTime, [first!.openTime]);
  assert.deepEqual(shortCheck.badCloseTime, []);
  assert.equal(shortCheck.ok, true, "a short bucket must not condemn the series");

  // A bar that closes exactly at its own open is still inside itself.
  const instant = [{ ...first!, closeTime: first!.openTime }, second!];
  assert.deepEqual(checkSeries(instant, "1d").badCloseTime, []);
  assert.deepEqual(checkSeries(instant, "1d").shortCloseTime, [first!.openTime]);

  // At the next bar's open, and beyond it: not this bar.
  for (const closeTime of [first!.openTime + step, first!.openTime + step * 2]) {
    const over = [{ ...first!, closeTime }, second!];
    const check = checkSeries(over, "1d");
    assert.deepEqual(check.badCloseTime, [first!.openTime], String(closeTime));
    assert.deepEqual(check.shortCloseTime, []);
    assert.equal(check.ok, false);
  }

  // Before its own open is impossible, and stays fatal.
  const before = [{ ...first!, closeTime: first!.openTime - 1 }, second!];
  assert.deepEqual(checkSeries(before, "1d").badCloseTime, [first!.openTime]);
  assert.equal(checkSeries(before, "1d").ok, false);

  // The ordinary case is neither.
  const clean = checkSeries(series("1d", 5), "1d");
  assert.deepEqual(clean.badCloseTime, []);
  assert.deepEqual(clean.shortCloseTime, []);
});
