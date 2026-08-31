import { test } from "node:test";
import assert from "node:assert/strict";
import { assertNoInternalCandleGaps } from "../src/data/candleSeries";
import { INTERVAL_MS, type Candle, type Interval } from "../src/types/market";

function candles(interval: Interval, count: number, startOpen = 0): Candle[] {
  const step = INTERVAL_MS[interval];
  return Array.from({ length: count }, (_, i) => {
    const openTime = startOpen + i * step;
    return {
      symbol: "NEWUSDT",
      interval,
      openTime,
      open: 100 + i,
      high: 101 + i,
      low: 99 + i,
      close: 100.5 + i,
      volume: 10,
      closeTime: openTime + step - 1,
    } satisfies Candle;
  });
}

test("backtest loading fails closed on a real internal missing candle", () => {
  const complete = candles("15m", 8, INTERVAL_MS["15m"] * 1000);
  const gapped = [...complete.slice(0, 3), ...complete.slice(4)];
  assert.throws(
    () => assertNoInternalCandleGaps(gapped, "15m", "NEWUSDT 15m"),
    (err: unknown) => {
      assert.match((err as Error).message, /internal candle gap in NEWUSDT 15m/);
      assert.match((err as Error).message, /1 15m bar\(s\) missing/);
      assert.match((err as Error).message, /Refusing to compress time/);
      return true;
    }
  );
});

test("partial requested, warmup, and listing boundaries remain valid", () => {
  const complete = candles("1h", 12, INTERVAL_MS["1h"] * 1000);

  // These rows can represent a pair listed after the requested warmup began,
  // or a requested window whose exact boundary falls between candle opens.
  // Missing expectations outside the returned range are not internal gaps.
  const startsInsideWarmup = complete.slice(4);
  const endsBeforeRequestedEdge = complete.slice(0, 9);
  const interiorWindow = complete.slice(3, 9);

  assert.doesNotThrow(() => assertNoInternalCandleGaps(startsInsideWarmup, "1h"));
  assert.doesNotThrow(() => assertNoInternalCandleGaps(endsBeforeRequestedEdge, "1h"));
  assert.doesNotThrow(() => assertNoInternalCandleGaps(interiorWindow, "1h"));
  assert.doesNotThrow(() => assertNoInternalCandleGaps([], "1h"));
});
