import { test } from "node:test";
import assert from "node:assert/strict";
import {
  inspectBackfillLiveBoundary, inspectCandleIntegrity, issueCounts,
} from "../src/data/candleIntegrity";
import { INTERVALS, INTERVAL_MS, type Candle, type Interval } from "../src/types/market";

const NOW = Date.UTC(2026, 8, 1, 12, 7, 30);

function latestClosed(interval: Interval): number {
  const step = INTERVAL_MS[interval];
  return Math.floor(NOW / step) * step - step;
}

function series(interval: Interval, count: number, endOpen = latestClosed(interval)): Candle[] {
  const step = INTERVAL_MS[interval];
  return Array.from({ length: count }, (_, i) => {
    const openTime = endOpen - (count - i - 1) * step;
    return {
      symbol: "BTCUSDT", interval, openTime,
      open: 100 + i, high: 102 + i, low: 99 + i, close: 101 + i,
      volume: 10, quoteVolume: 1_000, tradeCount: 20,
      closeTime: openTime + step - 1,
    };
  });
}

function inspect(candles: Candle[], interval: Interval, checkFreshness = true) {
  return inspectCandleIntegrity(candles, {
    symbol: "BTCUSDT", interval, now: NOW, checkFreshness,
  });
}

function codes(report: ReturnType<typeof inspectCandleIntegrity>): string[] {
  return report.issues.map((issue) => issue.code);
}

test("a valid contiguous completed series is healthy on every timeframe", () => {
  for (const interval of INTERVALS) {
    const report = inspect(series(interval, 10), interval);
    assert.equal(report.state, "healthy", `${interval}: ${codes(report).join(",")}`);
    assert.equal(report.market, "spot");
    assert.equal(report.latestCompletedBarOpenTime, latestClosed(interval));
  }
});

test("duplicate and out-of-order timestamps are explicit and never normalized away", () => {
  const bars = series("5m", 5);
  const duplicate = inspect([...bars.slice(0, 2), bars[1]!, ...bars.slice(2)], "5m");
  assert.equal(duplicate.state, "degraded");
  assert.equal(issueCounts(duplicate).duplicate_timestamp, 1);

  const outOfOrder = inspect([bars[0]!, bars[2]!, bars[1]!, ...bars.slice(3)], "5m");
  assert.equal(outOfOrder.state, "degraded");
  assert.ok(codes(outOfOrder).includes("out_of_order_timestamp"));
  assert.ok(!codes(outOfOrder).includes("missing_completed_interval"));
});

test("a genuine completed interval gap reports its exact missing count", () => {
  const bars = series("15m", 6);
  const report = inspect([...bars.slice(0, 2), ...bars.slice(3)], "15m");
  assert.equal(report.state, "degraded");
  assert.equal(issueCounts(report).missing_completed_interval, 1);
});

test("malformed OHLC, non-finite values, non-positive prices and identity mismatch are invalid", () => {
  const [bar] = series("1h", 1);
  const cases: Array<[Candle, string]> = [
    [{ ...bar!, high: bar!.open - 1 }, "malformed_ohlc"],
    [{ ...bar!, volume: Number.NaN }, "non_finite_value"],
    [{ ...bar!, low: 0 }, "non_positive_price"],
    [{ ...bar!, symbol: "ETHUSDT" }, "identity_mismatch"],
    [{ ...bar!, interval: "5m" }, "identity_mismatch"],
  ];
  for (const [candle, code] of cases) {
    const report = inspect([candle], "1h", false);
    assert.equal(report.state, "invalid", code);
    assert.ok(codes(report).includes(code), `${code}: ${codes(report).join(",")}`);
  }
});

test("staleness uses injected time and the existing one-bar close/write allowance", () => {
  const step = INTERVAL_MS["15m"];
  assert.equal(inspect(series("15m", 5, latestClosed("15m") - step), "15m").state, "healthy");
  const stale = inspect(series("15m", 5, latestClosed("15m") - 2 * step), "15m");
  assert.equal(stale.state, "degraded");
  assert.equal(issueCounts(stale).stale_latest_completed_bar, 2);
});

test("a currently-forming bar and the next not-yet-due slot are not historical gaps", () => {
  const interval = "5m" as const;
  const step = INTERVAL_MS[interval];
  const bars = series(interval, 5);
  const formingOpen = latestClosed(interval) + step;
  const forming = { ...bars.at(-1)!, openTime: formingOpen, closeTime: formingOpen + step - 1 };
  const report = inspect([...bars, forming], interval);
  assert.equal(report.state, "healthy");
  assert.equal(report.latestCompletedBarOpenTime, latestClosed(interval));
  assert.ok(!codes(report).includes("missing_completed_interval"));
});

test("a forming bar still proves a genuinely missing completed interval before it", () => {
  const interval = "5m" as const;
  const step = INTERVAL_MS[interval];
  const [base] = series(interval, 1, latestClosed(interval) - step);
  const formingOpen = latestClosed(interval) + step;
  const forming = { ...base!, openTime: formingOpen, closeTime: formingOpen + step - 1 };
  const report = inspect([base!, forming], interval, false);
  assert.equal(issueCounts(report).missing_completed_interval, 1);
});

test("backfill to live: correct next completed bar is healthy", () => {
  const [live] = series("15m", 1);
  const report = inspectBackfillLiveBoundary(live!.openTime - INTERVAL_MS["15m"], live!, {
    symbol: "BTCUSDT", interval: "15m", now: NOW,
  });
  assert.equal(report.state, "healthy");
});

test("backfill to live: overlap and reconnect replay are truthful duplicates", () => {
  const [live] = series("15m", 1);
  for (const label of ["boundary overlap", "reconnect replay"]) {
    const report = inspectBackfillLiveBoundary(live!.openTime, live!, {
      symbol: "BTCUSDT", interval: "15m", now: NOW,
    });
    assert.equal(report.state, "degraded", label);
    assert.equal(issueCounts(report).duplicate_timestamp, 1, label);
  }
});

test("backfill to live: one real missing completed interval reports discontinuity", () => {
  const [live] = series("1h", 1);
  const report = inspectBackfillLiveBoundary(live!.openTime - 2 * INTERVAL_MS["1h"], live!, {
    symbol: "BTCUSDT", interval: "1h", now: NOW,
  });
  assert.equal(issueCounts(report).missing_completed_interval, 1);
  assert.equal(issueCounts(report).backfill_live_discontinuity, 1);
});

test("backfill to live: an older completed live bar reports out of order", () => {
  const [live] = series("5m", 1);
  const report = inspectBackfillLiveBoundary(live!.openTime + INTERVAL_MS["5m"], live!, {
    symbol: "BTCUSDT", interval: "5m", now: NOW,
  });
  assert.equal(issueCounts(report).out_of_order_timestamp, 1);
});

test("backfill to live: a forming boundary candle creates no false gap", () => {
  const interval = "15m" as const;
  const step = INTERVAL_MS[interval];
  const previous = latestClosed(interval);
  const [base] = series(interval, 1);
  const forming = { ...base!, openTime: previous + step, closeTime: previous + 2 * step - 1 };
  const report = inspectBackfillLiveBoundary(previous, forming, {
    symbol: "BTCUSDT", interval, now: NOW,
  });
  assert.equal(report.state, "healthy");
  assert.ok(!codes(report).includes("missing_completed_interval"));
});
