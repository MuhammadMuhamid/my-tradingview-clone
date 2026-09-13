/**
 * A series' tail may never be asked to go backwards through `update()`.
 *
 * ── The owner-found P0 this pins ───────────────────────────────────────────
 *
 * Reproduced by the owner, and then here, on the PRODUCTION build at
 * `http://localhost:3000/chart` — SOL/USDT, 1d — by doing nothing but zooming
 * and panning:
 *
 *   Error: Cannot update oldest data, last time=…, new time=…
 *   [route error] → "This page stopped working"
 *
 * The two earlier TVP8 repairs do not cover it. `LiveTickGate` refuses a live
 * FRAME that arrives behind the drawn bar; `mainHeadRef` refuses a backwards
 * row at the MAIN series. The writer here is neither: it is the overlay sync
 * effect, and what handed it a backwards row was the planner itself.
 *
 * ── The mechanism, end to end ──────────────────────────────────────────────
 *
 * 1. A native study is computed over a window sized from the VIEWPORT
 *    (`lib/native/compute.ts::computeWindow`), not from the newest bar.
 * 2. `ChartPane` rounds that viewport to 200-bar buckets, so a zoom or a pan
 *    that crosses a bucket changes the study's window — `end` moves, while a
 *    window already anchored at bar 0 keeps its `start`.
 * 3. A study's reference LEVEL is two points at one constant value:
 *    `[{time: times[0]}, {time: times[times.length - 1]}]`. Shorten the window
 *    and the first point and the value are untouched while the last point
 *    moves back by hundreds of bars.
 * 4. `planAlignedMutation` saw an identical prefix and an equal length and
 *    answered "update" — a promise `update()` cannot keep. It can rewrite the
 *    bar the series ends on, or append one after it, and nothing else.
 * 5. lightweight-charts throws, the throw escapes the effect, and the route's
 *    error boundary replaces the whole chart page.
 *
 * So the rule under test is stated once, at the planner every writer goes
 * through: a tail that moved BACKWARDS is a replacement, not an update.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  planCandleMutation, planOhlcMutation, planSeriesMutation, type ChartPoint,
} from "../lib/chartSeries";
import { computeWindow } from "../lib/native/compute";
import type { Candle } from "../lib/types";

const DAY = 86_400_000;

const bar = (i: number, close = 100 + i): Candle => ({
  symbol: "SOLUSDT", interval: "1d",
  openTime: Date.UTC(2020, 0, 1) + i * DAY,
  closeTime: Date.UTC(2020, 0, 1) + (i + 1) * DAY - 1,
  open: close, high: close + 1, low: close - 1, close, volume: 1_000 + i,
});

/** The two points a study's reference level is, for a window of `times`. */
const level = (times: readonly number[], value = 70): ChartPoint[] =>
  times.length > 1
    ? [{ time: times[0]!, value }, { time: times[times.length - 1]!, value }]
    : [{ time: times[0]!, value }];

const secondsOf = (candles: readonly Candle[]): number[] =>
  candles.map((c) => c.openTime / 1000);

// ── The owner's exact shape ─────────────────────────────────────────────────

test("A STUDY LEVEL WHOSE WINDOW SHRANK IS A REPAINT, NOT AN UPDATE", () => {
  const candles = Array.from({ length: 2_225 }, (_, i) => bar(i));

  // Zoomed out: the whole series is in the window, so the level spans it.
  const wide = computeWindow(candles, 200, { firstVisibleIndex: 0, visibleBars: 2_400 }, false);
  // Zoomed in: the same anchor at bar 0, a shorter window. This is the state
  // the owner reached by scrolling the wheel, nothing more.
  const narrow = computeWindow(candles, 200, { firstVisibleIndex: 0, visibleBars: 1_000 }, false);

  assert.equal(wide.length, 2_225);
  assert.equal(narrow.length, 1_000);
  assert.equal(narrow[0]!.openTime, wide[0]!.openTime,
    "the fixture must keep the first bar, or it is not the shape that crashed");
  assert.ok(narrow[narrow.length - 1]!.openTime < wide[wide.length - 1]!.openTime,
    "the fixture must move the last bar backwards, or it is not the shape that crashed");

  const before = level(secondsOf(wide));
  const after = level(secondsOf(narrow));

  // Identical first point, identical value, a last point hundreds of bars
  // earlier. `update()` cannot express that; only `setData` can.
  assert.deepEqual(before[0], after[0]);
  assert.equal(planSeriesMutation(before, after), "replace");

  // And the study's own plot, which changes length as well as tail.
  const plotBefore = secondsOf(wide).map((time, i) => ({ time, value: i }));
  const plotAfter = secondsOf(narrow).map((time, i) => ({ time, value: i }));
  assert.equal(planSeriesMutation(plotBefore, plotAfter), "replace");
});

test("a tail that moved backwards is a repaint for every planner, at any length", () => {
  // Two points — the level line.
  assert.equal(planSeriesMutation(
    [{ time: 100, value: 70 }, { time: 900, value: 70 }],
    [{ time: 100, value: 70 }, { time: 500, value: 70 }],
  ), "replace");

  // Same length, identical prefix, tail one bar back.
  const points = Array.from({ length: 50 }, (_, i) => ({ time: i + 1, value: i }));
  assert.equal(planSeriesMutation(points, [...points.slice(0, -1), { time: 0.5, value: 49 }]),
    "replace");

  // Candles: the volume series is planned by this one.
  const window_ = Array.from({ length: 50 }, (_, i) => bar(i));
  const backwards = [...window_.slice(0, -1), bar(-1)];
  assert.equal(planCandleMutation(window_, backwards), "replace");

  // Transformed bars (Heikin Ashi, Renko, Kagi) the same.
  const ohlc = window_.map(({ openTime, open, high, low, close }) => ({ openTime, open, high, low, close }));
  const ohlcBack = [...ohlc.slice(0, -1),
    { openTime: -DAY, open: 1, high: 1, low: 1, close: 1 }];
  assert.equal(planOhlcMutation(ohlc, ohlcBack), "replace");
});

test("an APPEND that predates the bar the series ends on is a repaint too", () => {
  // One point longer, prefix identical, but the new point is behind the head.
  // Reachable when a late window arrives carrying a bar the chart has passed.
  const points = Array.from({ length: 20 }, (_, i) => ({ time: (i + 1) * 60, value: i }));
  assert.equal(
    planSeriesMutation(points, [...points, { time: 30, value: 99 }]),
    "replace",
  );
  // Forward by one is still the cheap path, which is the whole point of the
  // planner: this must not have become "replace everything, always".
  assert.equal(
    planSeriesMutation(points, [...points, { time: 21 * 60, value: 99 }]),
    "update",
  );
});

// ── The sequence the owner actually performed ───────────────────────────────

/**
 * A series that refuses to accept a row behind its own tail, which is exactly
 * what lightweight-charts is. Replaces the library for a deterministic test:
 * the rule is the library's documented one and is asserted from its own
 * source (`_seriesLastTimePoint` in `DataLayer._internal_updateSeriesData`).
 */
function strictSeries() {
  let rows: ChartPoint[] = [];
  let head: number | null = null;
  return {
    setData(next: ChartPoint[]) {
      rows = [...next];
      head = next.length > 0 ? next[next.length - 1]!.time : null;
    },
    update(point: ChartPoint) {
      if (head !== null && point.time < head) {
        throw new Error(`Cannot update oldest data, last time=${head}, new time=${point.time}`);
      }
      if (rows.length > 0 && rows[rows.length - 1]!.time === point.time) rows[rows.length - 1] = point;
      else rows.push(point);
      head = head === null ? point.time : Math.max(head, point.time);
    },
    rows: () => rows,
    head: () => head,
  };
}

/** The chart's write seam: plan, then apply the plan. */
function applyPoints(series: ReturnType<typeof strictSeries>, held: ChartPoint[], next: ChartPoint[]) {
  const plan = planSeriesMutation(held, next);
  if (plan === "replace") series.setData(next);
  else if (plan === "update") series.update(next[next.length - 1]!);
  return plan === "replace" ? [...next]
    : plan === "none" ? held
      : held.length > 0 && held[held.length - 1]!.time === next[next.length - 1]!.time
        ? [...held.slice(0, -1), next[next.length - 1]!]
        : [...held, next[next.length - 1]!];
}

test("HISTORY → LIVE → OLDER HISTORY → MERGE → LIVE → OLDER HISTORY → ZOOM, WITHOUT A THROW", () => {
  const candles = Array.from({ length: 2_400 }, (_, i) => bar(i));
  const series = strictSeries();
  let held: ChartPoint[] = [];

  const levelFor = (viewport: { firstVisibleIndex: number; visibleBars: number }) =>
    level(secondsOf(computeWindow(candles, 200, viewport, false)));

  // 1. Initial ordered history, zoomed out.
  held = applyPoints(series, held, levelFor({ firstVisibleIndex: 0, visibleBars: 2_400 }));
  assert.equal(series.rows().length, 2);

  // 2. The newest/current bar ticks: the level's tail is rewritten in place.
  const live = [...held.slice(0, -1), { ...held[held.length - 1]!, value: 71 }];
  held = applyPoints(series, held, live);
  assert.equal(series.head(), candles[candles.length - 1]!.openTime / 1000);

  // 3–4. The user pans back into older history: the study's window moves and
  //      shortens, and its tail goes backwards by 1,400 bars.
  held = applyPoints(series, held, levelFor({ firstVisibleIndex: 0, visibleBars: 1_000 }));
  assert.equal(series.head(), candles[999]!.openTime / 1000);

  // 5. Another live frame while the viewport is back there.
  const liveAgain = [...held.slice(0, -1), { ...held[held.length - 1]!, value: 72 }];
  held = applyPoints(series, held, liveAgain);

  // 6–7. More zooming, in and out, repeatedly, across bucket boundaries.
  for (const visibleBars of [600, 1_800, 400, 2_400, 200, 1_200, 2_400, 800]) {
    held = applyPoints(series, held, levelFor({ firstVisibleIndex: 0, visibleBars }));
    for (const firstVisibleIndex of [0, 200, 1_000, 1_800, 200, 0]) {
      held = applyPoints(series, held, levelFor({ firstVisibleIndex, visibleBars }));
    }
  }

  // 8. No exception — `applyPoints` would have thrown out of this test.
  // 9. What the series holds is still ordered, deduplicated, and is exactly
  //    what the last plan said it should be.
  const rows = series.rows();
  assert.ok(rows.length > 0);
  assert.deepEqual(rows, held, "the chart's record and the series disagree");
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i]!.time > rows[i - 1]!.time,
      `row ${i} is not after row ${i - 1}: ${rows[i - 1]!.time} → ${rows[i]!.time}`);
  }
});

test("A LATE HISTORICAL RESPONSE THAT LANDS AFTER A NEWER LIVE FRAME IS NOT AN UPDATE", () => {
  /*
   * The race the brief names: a historical request starts, a newer live frame
   * arrives and is drawn, and only then does the historical response resolve.
   * The late window ends BEFORE the live frame, and feeding it through
   * incremental semantics is precisely the throw.
   */
  const series = strictSeries();
  let held: ChartPoint[] = [];

  const history = Array.from({ length: 30 }, (_, i) => ({ time: (i + 1) * 60, value: i }));
  held = applyPoints(series, held, history);

  // A live frame appends the next bar. The series head is now 31 × 60.
  const withLive = [...history, { time: 31 * 60, value: 30 }];
  held = applyPoints(series, held, withLive);
  assert.equal(series.head(), 31 * 60);

  // The older request, started before that frame, resolves now. It carries
  // the same bars it was asked for and ends one bar behind the live frame.
  held = applyPoints(series, held, history);
  assert.equal(series.head(), 30 * 60, "the late window replaced the series, as it must");

  // And the next live frame is still an ordinary forward update.
  const settled = applyPoints(series, held, [...history, { time: 31 * 60, value: 31 }]);
  assert.equal(series.head(), 31 * 60);
  assert.deepEqual(series.rows(), settled, "the chart's record and the series disagree");
  const rows = series.rows();
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i]!.time > rows[i - 1]!.time, "the series is out of order");
  }
});
