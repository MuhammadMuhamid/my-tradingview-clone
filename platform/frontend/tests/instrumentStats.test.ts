/**
 * The 30-day average and the performance strip, computed from daily bars.
 *
 * ── TVP8 R7b-11 ────────────────────────────────────────────────────────────
 *
 * The details block printed `Average volume (30D) —` with the tooltip
 * "computing one needs daily bars this panel does not read yet", and
 * `Performance: Not computed for this instrument.` Both sentences were honest
 * about the panel and wrong about the product: the backend has served
 * `interval=1d` the whole time. The reference shows `Average Volume (30D)
 * 16.40K` and six period tiles.
 *
 * What is tested here is the arithmetic, because a percentage that is wrong by
 * one bar is not something a screenshot catches, and because the ONE thing
 * this module must never do is return a plausible number for a period the
 * series cannot support.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PERFORMANCE_PERIODS, averageVolume30D, performance } from "../lib/instrumentStats";

const DAY = 86_400_000;
/** A fixed "now", so nothing here depends on the day it is run. */
const NOW = Date.UTC(2026, 8, 14, 9, 30);

/** `count` closed daily bars ending yesterday, with known closes and volumes. */
function series(count: number, close: (i: number) => number, volume: (i: number) => number) {
  return Array.from({ length: count }, (_, i) => ({
    // The newest bar opens exactly one day before NOW, so it is closed.
    openTime: NOW - DAY - (count - 1 - i) * DAY,
    close: close(i),
    volume: volume(i),
  }));
}

test("R7b-11 — the 30-day average is the mean of the last thirty CLOSED bars", () => {
  // 1..40, so the last thirty are 11..40 and their mean is 25.5.
  const bars = series(40, (i) => 100 + i, (i) => i + 1);
  assert.equal(averageVolume30D(bars, NOW), 25.5);
});

test("R7b-11 — today's partial bar is not averaged in", () => {
  /*
   * On a 24/7 venue the newest daily bar is however much of the day has
   * happened. Averaging it in gives a "30-day average" that is lowest at 00:05
   * UTC and highest at 23:55, which is an average of nothing.
   */
  const bars = series(31, () => 100, () => 30);
  const withToday = [...bars, { openTime: NOW - 3_600_000, close: 100, volume: 1 }];
  assert.equal(averageVolume30D(withToday, NOW), 30,
    "the one-unit partial day must not drag the average below the thirty closed days");
});

test("R7b-11 — fewer than thirty closed bars is a dash, not a shorter average", () => {
  assert.equal(averageVolume30D(series(20, () => 100, () => 5), NOW), null);
  assert.equal(averageVolume30D([], NOW), null);
});

test("R7b-11 — each period is measured from the bar that many days back", () => {
  // close(i) = i, so `1W` compares the last close with the one seven bars back.
  const bars = series(400, (i) => i + 1, () => 1);
  const out = performance(bars, NOW);
  const last = bars[bars.length - 1]!.close;
  for (const [period, back] of [["1W", 7], ["1M", 30], ["3M", 90], ["6M", 180], ["1Y", 365]] as const) {
    const from = bars[bars.length - 1 - back]!.close;
    assert.equal(out[period], (last / from - 1) * 100, period);
  }
});

test("R7b-11 — YTD is measured from the first bar of the calendar year, not from a bar count", () => {
  /*
   * A year-to-date figure is defined by 1 January, which is anywhere from 0 to
   * 365 bars back depending on the day it is read. A fixed offset would make
   * "YTD" mean "one year" in January and "two weeks" in… nothing consistent.
   */
  const bars = series(400, (i) => i + 1, () => 1);
  const janFirst = Date.UTC(2026, 0, 1);
  const first = bars.find((bar) => bar.openTime >= janFirst)!;
  const last = bars[bars.length - 1]!.close;
  assert.equal(performance(bars, NOW).YTD, (last / first.close - 1) * 100);
});

test("R7b-11 — a period the series cannot support is null, never the oldest bar it has", () => {
  // Twenty bars have a 1W figure and nothing longer. Reaching for bars[0] and
  // labelling the answer "1M" would be a made-up number wearing a real label.
  const out = performance(series(20, (i) => i + 1, () => 1), NOW);
  assert.notEqual(out["1W"], null, "twenty bars DO support a one-week figure");
  for (const period of ["1M", "3M", "6M", "1Y"] as const) {
    assert.equal(out[period], null, `${period} must be refused on a twenty-bar series`);
  }
});

test("an empty series answers null for every period rather than throwing", () => {
  const out = performance([], NOW);
  for (const period of PERFORMANCE_PERIODS) assert.equal(out[period], null, period);
});
