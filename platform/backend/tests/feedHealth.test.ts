/**
 * BE-14: `ensureCandles` accepted a feed as covered at 98.5 % of expected bars,
 * with no contiguity check, no padding and no log line — 31 absent bars in a
 * 2100-bar 15m warmup, nearly eight hours — and `toBars` then packed whatever
 * rows existed into a contiguous array, so every rolling indicator computed
 * over a silently compressed timeline.
 *
 * FE-09 / BE-14: the websocket exposed an `isConnected()` that nothing called,
 * so a connection that stayed OPEN while delivering nothing produced no signal
 * at all.
 *
 * These tests pin the two questions that matter: is this feed live, and may a
 * strategy be evaluated on it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assessFeed, assessForEvaluation, MAX_BARS_BEHIND_LIVE,
  newestClosedBarOpenTime, worstFeedState, WS_SILENCE_TIMEOUT_MS,
} from "../src/data/feedHealth";
import { INTERVAL_MS, INTERVALS, type Candle, type Interval } from "../src/types/market";

function series(interval: Interval, count: number, endOpen: number): Candle[] {
  const step = INTERVAL_MS[interval];
  return Array.from({ length: count }, (_, i) => {
    const openTime = endOpen - (count - 1 - i) * step;
    return {
      symbol: "TESTUSDT", interval, openTime,
      open: 100, high: 101, low: 99, close: 100.5, volume: 10,
      closeTime: openTime + step - 1,
    } satisfies Candle;
  });
}

const NOW = 1_700_000_100_000;

/** An open time on the interval grid. Binance emits only aligned open times,
 *  and `checkSeries` rejects anything else — so a test fixture has to align. */
const alignedBar = (interval: Interval, approx = 1_700_000_000_000): number =>
  Math.floor(approx / INTERVAL_MS[interval]) * INTERVAL_MS[interval];

// ── Liveness ────────────────────────────────────────────────────────────────

test("the newest closed bar is the one BEFORE the bar containing now", () => {
  for (const interval of INTERVALS) {
    const step = INTERVAL_MS[interval];
    const newest = newestClosedBarOpenTime(interval, NOW);
    assert.equal(newest % step, 0, interval);
    assert.ok(newest + step <= NOW, `${interval}: the newest closed bar must have finished`);
    assert.ok(newest + 2 * step > NOW, `${interval}: and it must be the most recent such bar`);
  }
});

test("a contiguous, current feed is live and evaluable", () => {
  for (const interval of INTERVALS) {
    const newest = newestClosedBarOpenTime(interval, NOW);
    const a = assessFeed(series(interval, 50, newest), interval, { now: NOW });
    assert.equal(a.state, "live", `${interval}: ${a.detail}`);
    assert.equal(a.evaluable, true, interval);
    assert.equal(a.missingBars, 0, interval);
  }
});

test("a feed whose newest bar is stale is DELAYED, not live", () => {
  const step = INTERVAL_MS["15m"];
  const newest = newestClosedBarOpenTime("15m", NOW);
  // One bar behind is tolerated: a bar close, its websocket message and this
  // check all happen within a bar of each other.
  const oneBehind = assessFeed(series("15m", 20, newest - step), "15m", { now: NOW });
  assert.equal(oneBehind.barsBehind, MAX_BARS_BEHIND_LIVE);
  assert.equal(oneBehind.state, "live");

  const twoBehind = assessFeed(series("15m", 20, newest - 2 * step), "15m", { now: NOW });
  assert.equal(twoBehind.state, "delayed");
  assert.equal(twoBehind.evaluable, false);
  assert.equal(twoBehind.barsBehind, 2);
  assert.match(twoBehind.detail, /behind/);
});

test("a gap is reported as `gap` with its exact size, never tolerated", () => {
  const newest = newestClosedBarOpenTime("15m", NOW);
  const bars = series("15m", 20, newest);
  // Drop bars 5..7 — three absent bars, well inside the old 1.5 % tolerance
  // for a long warmup window.
  const gapped = [...bars.slice(0, 5), ...bars.slice(8)];
  const a = assessFeed(gapped, "15m", { now: NOW });
  assert.equal(a.state, "gap");
  assert.equal(a.evaluable, false);
  assert.equal(a.missingBars, 3);
  assert.match(a.detail, /3 bar\(s\) missing/);
});

test("a structural defect outranks lateness — a malformed series is an error", () => {
  const newest = newestClosedBarOpenTime("1h", NOW);
  const bars = series("1h", 10, newest);
  const swapped = [bars[0]!, bars[2]!, bars[1]!, ...bars.slice(3)];
  const a = assessFeed(swapped, "1h", { now: NOW });
  assert.equal(a.state, "error");
  assert.equal(a.evaluable, false);
  assert.match(a.detail, /out of order/);
});

test("a perfect series over a dead socket is RECONNECTING, not live", () => {
  const newest = newestClosedBarOpenTime("5m", NOW);
  const bars = series("5m", 30, newest);
  const up = assessFeed(bars, "5m", { now: NOW });
  assert.equal(up.state, "live");
  const down = assessFeed(bars, "5m", { now: NOW, transportDown: true });
  assert.equal(down.state, "reconnecting");
  assert.equal(down.evaluable, false);
  assert.match(down.detail, /not connected/);
});

test("an empty feed is an error, or reconnecting when the transport is known down", () => {
  assert.equal(assessFeed([], "15m", { now: NOW }).state, "error");
  assert.equal(assessFeed([], "15m", { now: NOW, transportDown: true }).state, "reconnecting");
  assert.equal(assessFeed([], "15m", { now: NOW }).evaluable, false);
});

test("no assessment other than `live` is ever evaluable", () => {
  const newest = newestClosedBarOpenTime("15m", NOW);
  const bars = series("15m", 20, newest);
  const cases = [
    assessFeed(bars, "15m", { now: NOW }),
    assessFeed(bars, "15m", { now: NOW, transportDown: true }),
    assessFeed([...bars.slice(0, 5), ...bars.slice(7)], "15m", { now: NOW }),
    assessFeed([], "15m", { now: NOW }),
    assessFeed(series("15m", 20, newest - 5 * INTERVAL_MS["15m"]), "15m", { now: NOW }),
  ];
  for (const a of cases) {
    assert.equal(a.evaluable, a.state === "live", `${a.state}: ${a.detail}`);
  }
});

// ── Evaluation gate ─────────────────────────────────────────────────────────

test("evaluation is refused on a gapped warmup window, whatever the wall clock says", () => {
  const barTime = alignedBar("15m");
  const bars = series("15m", 100, barTime);
  const gapped = [...bars.slice(0, 40), ...bars.slice(43)];
  const a = assessForEvaluation(gapped, "15m", barTime);
  assert.equal(a.evaluable, false);
  assert.equal(a.state, "gap");
  assert.equal(a.missingBars, 3);
  assert.match(a.detail, /refusing to evaluate/);
});

test("evaluation is allowed on a contiguous window through the signal bar", () => {
  const barTime = alignedBar("15m");
  const a = assessForEvaluation(series("15m", 2100, barTime), "15m", barTime);
  assert.equal(a.evaluable, true);
  assert.equal(a.state, "live");
});

test("evaluation is refused when the newest bar is behind the signal bar", () => {
  const barTime = alignedBar("15m");
  const step = INTERVAL_MS["15m"];
  const a = assessForEvaluation(series("15m", 50, barTime - step), "15m", barTime);
  assert.equal(a.evaluable, false);
  assert.equal(a.state, "delayed");
  assert.equal(a.barsBehind, 1);
});

test("evaluation is allowed when the feed is AHEAD of the signal bar", () => {
  // A higher-timeframe feed read up to the chart bar's close can legitimately
  // hold a bar that opened after the chart bar did.
  const barTime = alignedBar("5m");
  const a = assessForEvaluation(series("5m", 50, barTime + 2 * INTERVAL_MS["5m"]), "5m", barTime);
  assert.equal(a.evaluable, true);
});

test("evaluation is refused on an empty feed", () => {
  assert.equal(assessForEvaluation([], "15m", alignedBar("15m")).evaluable, false);
});

test("the old 1.5 % coverage heuristic would have passed a window this gate refuses", () => {
  // The exact shape of BE-14: a 2100-bar 15m warmup missing 31 bars is 98.52 %
  // coverage, which `ensureCandles` treated as covered.
  const barTime = alignedBar("15m");
  const bars = series("15m", 2100, barTime);
  const gapped = [...bars.slice(0, 1000), ...bars.slice(1031)];
  assert.ok(gapped.length >= 2100 * 0.985, "this window passes the old heuristic");
  const a = assessForEvaluation(gapped, "15m", barTime);
  assert.equal(a.evaluable, false, "and is refused now");
  assert.equal(a.missingBars, 31);
});

// ── Aggregation ─────────────────────────────────────────────────────────────

test("a single badge shows the worst state across the feeds", () => {
  assert.equal(worstFeedState(["live", "live"]), "live");
  assert.equal(worstFeedState(["live", "unknown"]), "unknown");
  assert.equal(worstFeedState(["live", "delayed"]), "delayed");
  assert.equal(worstFeedState(["delayed", "reconnecting"]), "reconnecting");
  assert.equal(worstFeedState(["reconnecting", "gap"]), "gap");
  assert.equal(worstFeedState(["gap", "error"]), "error");
  assert.equal(worstFeedState([]), "live");
});

test("the websocket silence timeout is longer than a plausible quiet period", () => {
  // Binance updates an active kline stream about once a second and pings every
  // three minutes. The timeout has to clear the former comfortably without
  // waiting for the latter.
  assert.ok(WS_SILENCE_TIMEOUT_MS >= 30_000, "must not flap on a brief lull");
  assert.ok(WS_SILENCE_TIMEOUT_MS <= 180_000, "must fire before a ping interval elapses twice");
});
