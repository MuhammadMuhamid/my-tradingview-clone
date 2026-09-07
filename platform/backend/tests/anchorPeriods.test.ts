/**
 * Weekly and monthly pivot anchors.
 *
 * These are derived from daily candles by CALENDAR rather than added to
 * `INTERVALS`, and the two reasons are worth pinning because both failures
 * would be silent:
 *
 *  - a month has no fixed length, and `INTERVAL_MS` is a constant relied on in
 *    sixty places for gap detection and fetch windows;
 *  - `floor(t / WEEK) * WEEK` puts week boundaries on THURSDAYS, because
 *    1970-01-01 was a Thursday. Binance's weekly bar opens Monday.
 *
 * A pivot level from a Thursday-to-Thursday window is a level no chart drew.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DAILY_BARS_FOR, completedPeriodFromDaily, isDerivedAnchor, periodKey,
} from "../src/engine/anchorPeriods";
import { INTERVALS } from "../src/types/market";
import { PIVOT_ANCHORS } from "../src/types/maAlerts";

const DAY = 86_400_000;
/** Daily candles from a UTC date, ascending. */
const daily = (fromIso: string, n: number, price: (i: number) => number) => {
  const start = Date.parse(`${fromIso}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) => ({
    symbol: "BTCUSDT", interval: "1d" as const,
    openTime: start + i * DAY, closeTime: start + (i + 1) * DAY - 1,
    open: price(i), high: price(i) + 1, low: price(i) - 1,
    close: price(i), volume: 1,
  }));
};

test("weeks start on Monday, and Sunday belongs to the week before it", () => {
  // 2026-09-07 is a Monday. Sunday the 13th must still key to that Monday —
  // the off-by-one a naive `day - 1` introduces every seventh day, because
  // getUTCDay() returns 0 for Sunday.
  const monday = Date.parse("2026-09-07T00:00:00Z");
  for (let i = 0; i < 7; i++) {
    assert.equal(
      periodKey(monday + i * DAY, "1w"), "2026-09-07",
      `day +${i} should key to the Monday that starts its week`
    );
  }
  assert.equal(periodKey(monday + 7 * DAY, "1w"), "2026-09-14", "the next Monday starts a new week");
});

test("the epoch-bucketing bug this avoids: floor(t / WEEK) lands on a Thursday", () => {
  // Stated as a fact about the alternative, so the reason for the calendar
  // arithmetic survives someone later thinking a divide would do.
  const WEEK = 7 * DAY;
  const bucketStart = Math.floor(Date.parse("2026-09-09T00:00:00Z") / WEEK) * WEEK;
  assert.equal(new Date(bucketStart).getUTCDay(), 4, "epoch bucketing starts weeks on Thursday");
  assert.notEqual(new Date(bucketStart).toISOString().slice(0, 10), "2026-09-07");
});

test("months are calendar months, not a fixed number of days", () => {
  assert.equal(periodKey(Date.parse("2026-02-28T00:00:00Z"), "1M"), "2026-02");
  assert.equal(periodKey(Date.parse("2026-03-01T00:00:00Z"), "1M"), "2026-03");
  // 30- and 31-day months key correctly at both ends, which no constant would.
  assert.equal(periodKey(Date.parse("2026-04-30T00:00:00Z"), "1M"), "2026-04");
  assert.equal(periodKey(Date.parse("2026-05-31T00:00:00Z"), "1M"), "2026-05");
});

test("the completed week is the one before the week in progress", () => {
  // Two full weeks from Monday 2026-09-07, prices 0..13.
  const bars = daily("2026-09-07", 14, (i) => 100 + i);
  const period = completedPeriodFromDaily(bars, "1w");
  assert.ok(period);
  // The FIRST week is the completed one; the second is still forming.
  assert.equal(period.open, 100, "open is the first day of that week");
  assert.equal(period.close, 106, "close is its last day");
  assert.equal(period.high, 107, "high is the week's high, not the day's");
  assert.equal(period.low, 99);
});

test("a period still forming is never returned — the level would move under the alert", () => {
  // One week only: nothing is known to be finished.
  assert.equal(completedPeriodFromDaily(daily("2026-09-07", 5, () => 100), "1w"), undefined);
  assert.equal(completedPeriodFromDaily([], "1w"), undefined);
  // One month only, likewise.
  assert.equal(completedPeriodFromDaily(daily("2026-09-01", 20, () => 100), "1M"), undefined);
});

test("the completed month aggregates every day in it", () => {
  // All of April (30 days) then part of May.
  const bars = [...daily("2026-04-01", 30, (i) => 100 + i), ...daily("2026-05-01", 5, () => 50)];
  const period = completedPeriodFromDaily(bars, "1M");
  assert.ok(period);
  assert.equal(period.open, 100, "April's first open");
  assert.equal(period.close, 129, "April's last close");
  assert.equal(period.high, 130);
  assert.equal(period.low, 99);
});

// ── the vocabulary ─────────────────────────────────────────────────────────

test("weekly and monthly are pivot anchors but NOT chart intervals", () => {
  for (const a of ["1w", "1M"]) {
    assert.ok(isDerivedAnchor(a), `${a} must be derived`);
    assert.ok((PIVOT_ANCHORS as readonly string[]).includes(a), `${a} must be offered as an anchor`);
    assert.equal(
      (INTERVALS as readonly string[]).includes(a), false,
      `${a} must NOT be an interval — INTERVAL_MS is a constant and a month is not`
    );
  }
  // And the interval-based anchors are still intervals, so the runner can
  // subscribe to them directly.
  for (const a of ["4h", "6h", "12h", "1d"]) {
    assert.equal(isDerivedAnchor(a), false, a);
    assert.ok((INTERVALS as readonly string[]).includes(a), a);
  }
});

test("enough daily bars are fetched to see two complete groups", () => {
  // Under-fetching is the dangerous direction: the anchor never resolves and
  // the alert silently never fires.
  assert.ok(DAILY_BARS_FOR("1w") >= 14, "two weeks at minimum");
  assert.ok(DAILY_BARS_FOR("1M") >= 62, "two long months at minimum");
});

// ── arming one alert across many symbols ───────────────────────────────────

/**
 * `symbols` on the create route.
 *
 * "The same 15m support alert on every coin in my watchlist" is one decision.
 * Doing it client-side would be one request per coin per timeframe — two
 * hundred round trips for a fifty-coin watchlist over four timeframes, each
 * re-validating the same condition, and a failure halfway leaving the user
 * unable to tell which half was armed.
 */
test("every symbol is validated before anything is written", async () => {
  const { readCondition } = await import("../src/alerts/alertRequest");
  // The condition is read once and reused for every symbol, so a bad condition
  // fails the whole request rather than arming a prefix of the watchlist.
  const bad = readCondition("pivot_level", {
    pivotType: "Fibonacci", levelName: "S1", anchor: "3d", mode: "near_above",
  });
  assert.ok("error" in bad, "an unsupported anchor must refuse the request");
  assert.match(bad.error, /anchor must be one of/);
});

test("the anchor vocabulary is what the dialog offers, in both directions", async () => {
  const { readCondition } = await import("../src/alerts/alertRequest");
  for (const anchor of PIVOT_ANCHORS) {
    const r = readCondition("pivot_level", {
      pivotType: "Fibonacci", levelName: "S1", anchor, mode: "near_above",
    });
    assert.ok("condition" in r, `${anchor} should be accepted`);
  }
  // And anything else is refused — including plausible-looking intervals the
  // platform does not store, which would otherwise arm an alert that can never
  // resolve its anchor and so never fires.
  for (const anchor of ["3d", "1y", "2h", "15m", ""]) {
    assert.ok(
      "error" in readCondition("pivot_level", {
        pivotType: "Fibonacci", levelName: "S1", anchor, mode: "near_above",
      }),
      `${anchor || "(empty)"} should be refused`
    );
  }
});
