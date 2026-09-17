/**
 * TVP8 F-03-R2: the price row of the last-price plate says what the AXIS says.
 *
 * `lib/priceAxisText` is the one place a price-scale mode is allowed to change
 * what a price reads as. The oracle for every case here is lightweight-charts
 * 4.2.3's own `PriceScale.formatPrice(price, firstValue)`, quoted in that
 * module's header, and the numbers the axis was actually seen to print:
 * `2,420.00` beside a raw `2416.65` (Regular, ETHUSDT), `101.60` above a raw
 * `98.64` (Indexed-to-100, SOLUSDT), `−2.46%` (Percentage, the reference).
 *
 * None of the implementation is repeated here. The expected strings are
 * written out by hand from the library's rules, and the product's own
 * `fmtPriceAt` is passed in as the chart's `localization.priceFormatter`
 * exactly as `CandleChart` installs it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { fmtPriceAt } from "../lib/format";
import {
  NEAREST_LEFT, NEAREST_RIGHT, PRICE_SCALE_MODE,
  firstVisibleClose, lastVisibleClose, libraryPercentageFormat, libraryPriceFormat,
  priceAxisText, readPriceAxisFormatting, toIndexedTo100, toPercent,
} from "../lib/priceAxisText";

/** The chart as `CandleChart` configures it: the product's grouping formatter, no percentage one. */
const CHART = {
  priceFormatter: (price: number) => fmtPriceAt(price, 2),
  percentageFormatter: undefined,
  seriesFormatter: { format: (price: number) => price.toFixed(2) },
};

/* ── the library's formatters, by the library's rules ────────────────────── */

test("F-03-R2 — `PriceFormatter(100, 1)`: two decimals, U+2212 for the sign, carry on rounding", () => {
  assert.equal(libraryPriceFormat(101.6), "101.60", "the Indexed-to-100 label the axis was seen to print");
  assert.equal(libraryPriceFormat(98.64), "98.64");
  assert.equal(libraryPriceFormat(0), "0.00");
  assert.equal(libraryPriceFormat(-2.456), "−2.46", "minus is U+2212, as wide as plus");
  assert.equal(libraryPriceFormat(1.995), "2.00", "a fractional part that rounds to the base carries");
  assert.equal(libraryPriceFormat(2416.65), "2416.65", "and it never groups — that is the localization formatter's job");
});

test("F-03-R2 — `PriceFormatter(priceScale, minMove)` honours precision and tick the library's way", () => {
  assert.equal(libraryPriceFormat(1.23456, 100000, 1), "1.23456");
  assert.equal(libraryPriceFormat(1.23456, 1000, 5), "1.235", "minMove 5 in thousandths: the step is 0.005");
  assert.equal(libraryPriceFormat(7, 1, 1), "7", "no decimals when the base is 1");
  assert.equal(libraryPriceFormat(12.3, 100, 25), "12.25", "a quarter tick lands on a quarter");
});

test("F-03-R2 — `PercentageFormatter`: the price formatter's text with a `%`", () => {
  assert.equal(libraryPercentageFormat(-2.456), "−2.46%", "the reference's own `−2.46%`");
  assert.equal(libraryPercentageFormat(1.59), "1.59%");
  assert.equal(libraryPercentageFormat(0), "0.00%");
});

/* ── the transforms ──────────────────────────────────────────────────────── */

test("F-03-R2 — `toPercent` and `toIndexedTo100` are relative to the first visible close", () => {
  const near = (actual: number, expected: number) =>
    assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);
  near(toPercent(98.14, 100), -1.86);
  near(toIndexedTo100(98.14, 100), 98.14);
  assert.equal(toPercent(110, 100), 10);
  assert.equal(toIndexedTo100(110, 100), 110);
  // A negative base flips the sign, as the library's `toPercent` does: from
  // −100 to −90 is a move UP, so it is +10%, and indexed it is −90.
  assert.equal(toPercent(-90, -100), 10);
  assert.equal(toIndexedTo100(-90, -100), -90);
});

/* ── the switch, mode by mode ────────────────────────────────────────────── */

test("F-03-R2 — Regular: the chart's localization formatter, grouped like the axis", () => {
  const text = priceAxisText(2416.65, 2400, { mode: PRICE_SCALE_MODE.normal, ...CHART });
  assert.equal(text, "2,416.65", "`2416.65` beside `2,420.00` was the defect");
  assert.equal(priceAxisText(0.5, 1, { mode: PRICE_SCALE_MODE.normal, ...CHART }), "0.50");
});

test("F-03-R2 — Logarithmic: coordinates change, the text does not", () => {
  const log = priceAxisText(2416.65, 2400, { mode: PRICE_SCALE_MODE.logarithmic, ...CHART });
  const regular = priceAxisText(2416.65, 2400, { mode: PRICE_SCALE_MODE.normal, ...CHART });
  assert.equal(log, regular);
  assert.equal(log, "2,416.65");
});

test("F-03-R2 — Percentage: the percentage of the first visible close, in the library's own format", () => {
  assert.equal(priceAxisText(98.14, 100, { mode: PRICE_SCALE_MODE.percentage, ...CHART }), "−1.86%");
  assert.equal(priceAxisText(101.59, 100, { mode: PRICE_SCALE_MODE.percentage, ...CHART }), "1.59%");
  // The reference plate: a close 2.46% under the first visible close.
  assert.equal(priceAxisText(2400 * (1 - 0.0246), 2400, { mode: PRICE_SCALE_MODE.percentage, ...CHART }),
    "−2.46%");
});

test("F-03-R2 — Percentage honours a `localization.percentageFormatter` when the chart has one", () => {
  const text = priceAxisText(110, 100, {
    mode: PRICE_SCALE_MODE.percentage, ...CHART,
    percentageFormatter: (percentage: number) => `${percentage.toFixed(1)} pct`,
  });
  assert.equal(text, "10.0 pct");
});

test("F-03-R2 — Indexed-to-100: the indexed value, two decimals, and NOT the localization formatter", () => {
  // 98.64 raw under an axis label of 101.60: the base is 98.64 / 1.016.
  const base = 98.64 / 1.016;
  assert.equal(priceAxisText(98.64, base, { mode: PRICE_SCALE_MODE.indexedTo100, ...CHART }), "101.60",
    "the raw `98.64` under `101.60` was the defect");
  // A grouping localization formatter must be ignored here: the library's
  // scale formatter in this mode is a fresh `PriceFormatter(100, 1)`.
  const grouped = priceAxisText(20, 1, {
    mode: PRICE_SCALE_MODE.indexedTo100,
    priceFormatter: (price: number) => `GROUPED ${fmtPriceAt(price, 2)}`,
    seriesFormatter: { format: (price: number) => price.toFixed(5) },
  });
  assert.equal(grouped, "2000.00", "neither the localization formatter nor the series precision applies");
});

test("F-03-R2 — the relative modes print nothing without a first value, as the chip does", () => {
  assert.equal(priceAxisText(98.14, null, { mode: PRICE_SCALE_MODE.percentage, ...CHART }), "");
  assert.equal(priceAxisText(98.14, null, { mode: PRICE_SCALE_MODE.indexedTo100, ...CHART }), "");
  assert.equal(priceAxisText(98.14, null, { mode: PRICE_SCALE_MODE.normal, ...CHART }), "98.14",
    "the absolute modes never needed one");
});

test("F-03-R2 — Regular falls back the way the scale does: series formatter, then the library default", () => {
  assert.equal(priceAxisText(2416.65, null, {
    mode: PRICE_SCALE_MODE.normal, seriesFormatter: { format: (price: number) => price.toFixed(3) },
  }), "2416.650", "no localization formatter: the scale's formatter is the series'");
  assert.equal(priceAxisText(2416.65, null, { mode: PRICE_SCALE_MODE.normal }), "2416.65",
    "no series either: `PriceFormatter(100, 1)`");
  assert.equal(priceAxisText(2416.65, null, { mode: undefined, ...CHART }), "2,416.65",
    "an unreadable mode is Normal, the library's default");
});

/* ── reading the state off a chart, fresh every time ─────────────────────── */

function fakeSeries(mode: number, lastValueVisible = true) {
  const state = { mode };
  return {
    state,
    series: {
      priceScale: () => ({ options: () => ({ mode: state.mode }) }),
      priceFormatter: () => CHART.seriesFormatter,
      options: () => ({ lastValueVisible }),
    },
    chart: {
      options: () => ({ localization: { priceFormatter: CHART.priceFormatter } }),
      timeScale: () => ({ getVisibleLogicalRange: () => ({ from: 0, to: 2 }) }),
    },
  };
}

test("F-03-R2 — the formatting is read off the chart at call time, so a mode switch is not stale", () => {
  const fake = fakeSeries(PRICE_SCALE_MODE.normal);
  const before = readPriceAxisFormatting(fake.chart, fake.series);
  assert.equal(before.mode, PRICE_SCALE_MODE.normal);
  assert.equal(before.priceFormatter, CHART.priceFormatter, "the chart's OWN formatter, not a copy of it");
  assert.equal(before.seriesFormatter, CHART.seriesFormatter);
  assert.equal(priceAxisText(98.14, 100, before), "98.14");

  // The axis context menu: Regular → Percent, between two paints.
  fake.state.mode = PRICE_SCALE_MODE.percentage;
  const after = readPriceAxisFormatting(fake.chart, fake.series);
  assert.equal(priceAxisText(98.14, 100, after), "−1.86%");
  fake.state.mode = PRICE_SCALE_MODE.indexedTo100;
  assert.equal(priceAxisText(98.14, 100, readPriceAxisFormatting(fake.chart, fake.series)), "98.14");
  fake.state.mode = PRICE_SCALE_MODE.logarithmic;
  assert.equal(priceAxisText(98.14, 100, readPriceAxisFormatting(fake.chart, fake.series)), "98.14");
});

test("F-03-R2 — a chart or series that cannot be read degrades to the library's defaults", () => {
  const formatting = readPriceAxisFormatting(null, {
    priceScale: () => { throw new Error("gone"); },
    priceFormatter: () => { throw new Error("gone"); },
  });
  assert.equal(formatting.mode, undefined);
  assert.equal(formatting.priceFormatter, undefined);
  assert.equal(formatting.seriesFormatter, null);
  assert.equal(priceAxisText(98.14, null, formatting), "98.14");
});

test("F-03-R2 — first and last visible closes are the bars the library's strict range picks", () => {
  /*
   * `visibleStrictRange` is `[floor(from), ceil(to)]`; `firstBar` searches
   * from its left NearestRight, `lastValueData` from its right NearestLeft.
   */
  const calls: Array<[number, number]> = [];
  const bars = [{ close: 100 }, { close: 95 }, { close: 98.14 }, { close: 99 }];
  const series = {
    dataByIndex: (index: number, direction: number) => {
      calls.push([index, direction]);
      return bars[Math.max(0, Math.min(index, bars.length - 1))] ?? null;
    },
  };
  const chart = {
    options: () => ({}),
    timeScale: () => ({ getVisibleLogicalRange: () => ({ from: 0.6, to: 2.4 }) }),
  };
  assert.equal(firstVisibleClose(chart, series), 100);
  assert.deepEqual(calls.at(-1), [0, NEAREST_RIGHT], "floor(0.6) = 0, searched rightwards");
  assert.equal(lastVisibleClose(chart, series), 99);
  assert.deepEqual(calls.at(-1), [3, NEAREST_LEFT], "ceil(2.4) = 3, searched leftwards");

  assert.equal(firstVisibleClose(null, series), null, "no chart, no visible range");
  assert.equal(lastVisibleClose({ ...chart, timeScale: () => ({ getVisibleLogicalRange: () => null }) }, series),
    null);
  assert.equal(firstVisibleClose(chart, {}), null, "a series with no `dataByIndex` has no bars to offer");
});
