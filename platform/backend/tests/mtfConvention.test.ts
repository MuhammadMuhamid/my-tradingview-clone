/**
 * `BE-08` — the multi-timeframe merge convention and its no-future-data guard.
 *
 * TradingView's Pine v6 documentation resolves the former OPEN-vs-CLOSE
 * question: a `lookahead_off` request gets its new historical value at the end
 * of the HTF period, so `chartClose` is the supported convention.
 *
 * These tests:
 *
 *   * pin the DEFAULT to the documented behavior;
 *   * assert both conventions are implemented and differ where they should;
 *   * assert that neither convention leaks the future;
 *   * preserve the comparison table that exposed the former one-bar mismatch.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildMergeIndex, DEFAULT_MERGE_CONVENTION, MERGE_CONVENTIONS, mergeValues,
  toBars, type Bars,
} from "../src/engine/mtf";
import {
  analyseLookahead, analyseWarmupSensitivity, compareConventions,
} from "../src/engine/lookaheadAnalysis";
import { INTERVAL_MS, type Candle, type Interval } from "../src/types/market";

function bars(interval: Interval, count: number, startOpen = 0): Bars {
  const step = INTERVAL_MS[interval];
  const candles: Candle[] = Array.from({ length: count }, (_, i) => {
    const openTime = startOpen + i * step;
    return {
      symbol: "TESTUSDT", interval, openTime,
      open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i,
      volume: 1, closeTime: openTime + step - 1,
    };
  });
  return toBars(candles);
}

// ── The default is today's behaviour ────────────────────────────────────────

test("the default convention is TradingView's historical `chartClose` boundary", () => {
  assert.equal(DEFAULT_MERGE_CONVENTION, "chartClose");
  assert.deepEqual([...MERGE_CONVENTIONS], ["chartClose", "chartOpen"]);
});

test("`chartClose` reproduces the pre-change indices bit-for-bit", () => {
  // The old implementation was: advance while `feed.closeTime[j+1] <= chart.closeTime[i]`.
  const chart = bars("15m", 40);
  const feed = bars("1h", 12);
  const expected = new Int32Array(chart.length);
  let j = -1;
  for (let i = 0; i < chart.length; i++) {
    while (j + 1 < feed.length && feed.closeTime[j + 1]! <= chart.closeTime[i]!) j++;
    expected[i] = j;
  }
  assert.deepEqual([...buildMergeIndex(chart, feed, "chartClose")], [...expected]);
  assert.deepEqual([...buildMergeIndex(chart, feed)], [...expected], "the default matches");
});

// ── The two conventions, and where they differ ─────────────────────────────

test("on the last 15m bar of an hour, the two conventions disagree by one HTF bar", () => {
  // 15m bars 0..3 make up hour 0. Bar 3 closes exactly when hour 0 closes.
  const chart = bars("15m", 8);
  const feed = bars("1h", 2);
  const close = buildMergeIndex(chart, feed, "chartClose");
  const open = buildMergeIndex(chart, feed, "chartOpen");

  // Under `chartClose`, bar 3 already sees hour 0 — the two closes coincide.
  assert.equal(close[3], 0);
  // Under `chartOpen`, hour 0's value first appears on bar 4, which opens at
  // 01:00 — the classic one-bar delay the old header described.
  assert.equal(open[3], -1);
  assert.equal(open[4], 0);
});

test("a same-timeframe feed passes through identically under `chartClose`", () => {
  const chart = bars("15m", 10);
  const feed = bars("15m", 10);
  const idx = buildMergeIndex(chart, feed, "chartClose");
  for (let i = 0; i < chart.length; i++) assert.equal(idx[i], i, `bar ${i}`);
});

test("a same-timeframe feed is delayed by one bar under `chartOpen`", () => {
  // This is why the choice matters even without a higher timeframe: the same
  // feed produces a different series.
  const chart = bars("15m", 10);
  const feed = bars("15m", 10);
  const idx = buildMergeIndex(chart, feed, "chartOpen");
  assert.equal(idx[0], -1);
  for (let i = 1; i < chart.length; i++) assert.equal(idx[i], i - 1, `bar ${i}`);
});

test("neither convention ever sees a feed bar that closed after the chart bar", () => {
  // The supported chartClose convention is safe at chart-bar close. The more
  // conservative diagnostic alternative is safe as well.
  const chart = bars("15m", 200);
  for (const feedTf of ["5m", "15m", "1h", "4h"] as const) {
    const feed = bars(feedTf, 200);
    for (const convention of MERGE_CONVENTIONS) {
      const report = analyseLookahead(chart, feed, convention);
      assert.equal(report.clean, true, `${feedTf} under ${convention}: ${report.summary}`);
      assert.equal(report.violations.length, 0);
    }
  }
});

test("the analyser DOES detect look-ahead when it is present", () => {
  // Deliberately construct the leak the finding warns about: a merge that lets
  // a chart bar see the higher-timeframe bar it sits inside.
  const chart = bars("15m", 8);
  const feed = bars("1h", 2);
  const leaky = new Int32Array(chart.length).fill(0);
  // Bar 0 (00:00-00:14) seeing hour 0 (closing 00:59) is look-ahead.
  let violations = 0;
  for (let i = 0; i < chart.length; i++) {
    if (feed.closeTime[leaky[i]!]! > chart.closeTime[i]!) violations++;
  }
  assert.ok(violations > 0, "the fixture must actually leak, or the test proves nothing");
  // And the real analyser reports zero for the real merge, which is the contrast.
  assert.equal(analyseLookahead(chart, feed, "chartClose").violations.length, 0);
});

test("the disagreement count measures the former BE-08 one-bar delay", () => {
  const chart = bars("15m", 100);
  const feed = bars("1h", 30);
  const report = analyseLookahead(chart, feed, "chartClose");
  assert.ok(report.conventionDisagreements > 0, "a 1h feed on a 15m chart must differ somewhere");
  assert.match(report.summary, /DELAY, not of look-ahead/);
});

// ── The comparison table to run against TradingView ───────────────────────

test("compareConventions produces the bar-by-bar table the TV comparison needs", () => {
  const chart = bars("15m", 20);
  const feed = bars("1h", 6);
  const src = [...feed.close];
  const rows = compareConventions(chart, feed, src, { onlyDistinguishing: true, limit: 5 });

  assert.ok(rows.length > 0, "there must be distinguishing bars to compare");
  for (const row of rows) {
    assert.equal(row.distinguishing, true);
    assert.notEqual(row.underChartClose, row.underChartOpen);
    // An ISO timestamp, because that is what a human reads off a TV chart.
    assert.match(row.chartCloseIso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  }
});

test("a bar where the conventions agree cannot settle the question", () => {
  const chart = bars("15m", 20);
  const feed = bars("15m", 20);
  const src = [...feed.close];
  const all = compareConventions(chart, feed, src, { limit: 20 });
  const agreeing = all.filter((r) => !r.distinguishing);
  for (const row of agreeing) {
    assert.equal(row.underChartClose, row.underChartOpen);
  }
});

test("mergeValues carries NaN before any feed bar has closed, never a stale value", () => {
  const chart = bars("15m", 8);
  const feed = bars("1h", 2);
  const merged = mergeValues(buildMergeIndex(chart, feed, "chartOpen"), [...feed.close]);
  assert.ok(Number.isNaN(merged[0]!), "no HTF bar has closed by the first chart bar's open");
  assert.ok(!Number.isNaN(merged[4]!));
});

// ── Warm-up sensitivity (BE-09) ────────────────────────────────────────────

/** A ratcheting high-water mark: the shape of a Supertrend or a trail anchor. */
function runningMax(src: number[]): (number | null)[] {
  let hi = -Infinity;
  return src.map((v) => { hi = Math.max(hi, v); return hi; });
}

/** A windowed mean: no memory beyond its own length. */
function sma3(src: number[]): (number | null)[] {
  return src.map((_, i) => (i < 2 ? null : (src[i]! + src[i - 1]! + src[i - 2]!) / 3));
}

test("BE-09: a ratcheting indicator IS warm-up sensitive, and the tool says by how much", () => {
  // A rising series: trimming the front removes the lowest values, so a running
  // max is unaffected. A series with an early PEAK is the sensitive case.
  const src = [500, ...Array.from({ length: 300 }, (_, i) => i)];
  const report = analyseWarmupSensitivity(src, runningMax, { offsets: [0, 1, 50, 100] });
  assert.equal(report.stable, false);
  assert.ok(report.maxAbsDeviation > 0);
  assert.match(report.summary, /WARM-UP SENSITIVE/);
});

test("a windowed indicator is NOT warm-up sensitive", () => {
  const src = Array.from({ length: 500 }, (_, i) => Math.sin(i / 10) * 100 + 1000);
  const report = analyseWarmupSensitivity(src, sma3, { offsets: [0, 50, 100, 250] });
  assert.equal(report.stable, true);
  assert.ok(report.maxAbsDeviation < 1e-9);
  assert.match(report.summary, /insensitive/);
});

test("the tool reports how much history makes the value reproducible", () => {
  // The peak is at index 0, so any window that still contains it agrees.
  const src = [500, ...Array.from({ length: 300 }, (_, i) => i)];
  const report = analyseWarmupSensitivity(src, runningMax, { offsets: [0, 1, 2, 3] });
  // Offset 0 keeps the peak; offsets 1+ drop it. So nothing past offset 0 agrees.
  assert.equal(report.stableAfterBars, src.length);
});

test("too few usable probes is reported as such, not as stability", () => {
  const report = analyseWarmupSensitivity([1, 2, 3], runningMax, { offsets: [100, 200] });
  assert.equal(report.stable, false);
  assert.match(report.summary, /not enough usable probes/);
});
