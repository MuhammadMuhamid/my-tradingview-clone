/**
 * The chart-type model: which types exist, which of them are canonical
 * presentations and which are synthetic transforms, and how a bar becomes a
 * datum.
 *
 * Two properties carry the weight here. `mainSeriesDatum` never invents a
 * price — it reshapes exactly the bar it is handed, so it cannot be the place
 * a transform leaks in. And the presentation/transform split is data on the
 * type itself rather than a convention: the menu, the disclosure badge and the
 * renderer all read it from one place, so a type cannot be synthetic in one of
 * them and canonical in another.
 *
 * The transform arithmetic lives in `tests/chartTransforms.test.ts`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  CHART_TYPES, chartTransform, chartTypeLabel, chartTypeOrDefault, DEFAULT_RENKO_ATR_PERIOD,
  drawsOhlc, isChartType, isSyntheticChartType, mainSeriesDatum, renderKind, renkoParams,
  syntheticDisclosure, SYNTHETIC_DISCLOSURE_HINT, transformParams, transformParamSummary,
  type ChartType,
} from "../lib/chartType";

const ROOT = path.join(__dirname, "..");
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

const BAR = { openTime: 1_700_000_000_000, open: 10, high: 12, low: 9, close: 11 };

test("only the types this chart actually implements are offered", () => {
  /*
   * `bars` leads, as it does in the reference's own menu.
   *
   * This list IS the menu's order — the menu renders `CHART_TYPES` in
   * sequence — so the order is a product decision and belongs in an
   * assertion. It is not alphabetical and not arbitrary: bars, candles,
   * hollow, volume candles are the four price-bar forms, and the reference
   * puts the plainest first.
   */
  assert.deepEqual(CHART_TYPES.map((t) => t.value), [
    "bars", "candles", "hollowCandles", "volumeCandles", "line", "lineWithMarkers",
    "stepLine", "area", "hlcArea", "baseline", "columns", "highLow", "sessionVolumeProfile", "tpo", "range", "footprint",
    "heikinAshi", "renko", "lineBreak", "kagi", "pointAndFigure",
  ]);
  for (const absent of ["pnf", "heikinashi", "Renko", "tpoo"]) {
    assert.equal(isChartType(absent), false, absent);
  }
});

test("presentations and transforms are separate, and the split is data", () => {
  const presentations = CHART_TYPES.filter((t) => t.group === "presentation").map((t) => t.value);
  const transforms = CHART_TYPES.filter((t) => t.group === "transform").map((t) => t.value);
  /*
   * Hollow candles, step line and baseline are PRESENTATIONS.
   *
   * Each draws the market's own bars differently — an unfilled body, a held
   * close, a fill either side of a reference. None of them changes a price, so
   * none of them belongs on the transform shelf beside Heikin Ashi and Renko,
   * which do. That distinction is what the disclosure hint hangs off, and it
   * is what keeps "display only" meaning something.
   */
  assert.deepEqual(presentations,
    ["bars", "candles", "hollowCandles", "volumeCandles", "line", "lineWithMarkers",
      "stepLine", "area", "hlcArea", "baseline", "columns", "highLow", "sessionVolumeProfile", "tpo", "range", "footprint"]);
  assert.deepEqual(transforms, ["heikinAshi", "renko", "lineBreak", "kagi", "pointAndFigure"]);

  // The transforms come last, so the menu can render them as a terminal group.
  assert.deepEqual(CHART_TYPES.map((t) => t.group),
    [...presentations.map(() => "presentation"), ...transforms.map(() => "transform")]);

  for (const t of CHART_TYPES) {
    assert.equal(isSyntheticChartType(t.value), t.group === "transform");
    assert.equal(chartTransform(t.value) === null, t.group === "presentation",
      `${t.value} disagrees with itself about whether it transforms anything`);
  }
});

test("a synthetic type is disclosed and a canonical one never is", () => {
  assert.equal(syntheticDisclosure("heikinAshi"), "Heikin Ashi");
  assert.equal(syntheticDisclosure("renko"), `Renko · ATR(${DEFAULT_RENKO_ATR_PERIOD})`);
  for (const canonical of ["candles", "bars", "line", "lineWithMarkers", "area", "hlcArea",
    "columns", "highLow", "sessionVolumeProfile", "tpo"] as ChartType[]) {
    assert.equal(syntheticDisclosure(canonical), null,
      `${canonical} draws the exchange's own candles and must not carry a synthetic label`);
  }
  assert.match(SYNTHETIC_DISCLOSURE_HINT, /canonical exchange candles/);
});

test("Renko's parameters default to ATR(14) and are read from the pane's settings", () => {
  assert.equal(DEFAULT_RENKO_ATR_PERIOD, 14);
  // No settings: the documented default, so every caller that has not been
  // given one keeps its old behaviour to the digit.
  assert.deepEqual(renkoParams("renko"), { atrPeriod: 14 });
  assert.deepEqual(renkoParams("renko", {}), { atrPeriod: 14 });
  assert.deepEqual(renkoParams("renko", { renkoAtrPeriod: 20 }), { atrPeriod: 20 });

  /*
   * The LABEL no longer carries the period.
   *
   * It used to, on the reasoning that what is persisted should be what is
   * shown — which was true while the period could not change. It is used in
   * six places (menu row, toolbar disclosure, on-chart chip, settings
   * heading, screen-reader name, tooltip), so once the period became editable
   * the baked-in "· ATR(14)" was a stale number in all six. The parameters
   * are now `transformParamSummary`, computed from the same settings the
   * transform reads, and the reference's own menu says "Renko" too.
   */
  assert.equal(chartTypeLabel("renko"), "Renko");
  assert.equal(transformParamSummary("renko"), "ATR(14)");
  assert.equal(transformParamSummary("renko", { renkoAtrPeriod: 20 }), "ATR(20)");
  assert.equal(transformParamSummary("candles"), null);

  // The disclosure chip still states both, so nothing a user could read got
  // quieter — it just stopped lying when the period changed.
  assert.equal(syntheticDisclosure("renko"), "Renko · ATR(14)");
  assert.equal(syntheticDisclosure("renko", { renkoAtrPeriod: 20 }), "Renko · ATR(20)");
  assert.equal(syntheticDisclosure("candles"), null);

  for (const other of ["candles", "bars", "line", "area", "heikinAshi"] as ChartType[]) {
    assert.equal(renkoParams(other), null);
  }
});

test("every transform reads its parameters from the pane rather than a constant", () => {
  assert.equal(transformParams("lineBreak", 0.01).lineBreakLines, 3);
  assert.equal(transformParams("lineBreak", 0.01, { lineBreakLines: 5 }).lineBreakLines, 5);
  assert.equal(transformParams("kagi", 0.01).kagiReversalPercent, 1);
  assert.equal(transformParams("kagi", 0.01, { kagiReversalPercent: 2.5 }).kagiReversalPercent, 2.5);
  const pnf = transformParams("pointAndFigure", 0.01, { pnfBoxPercent: 0.5, pnfReversalBoxes: 2 });
  assert.equal(pnf.pnfBoxPercent, 0.5);
  assert.equal(pnf.pnfReversalBoxes, 2);
  // A parameter belonging to another transform is never smuggled in.
  assert.equal(transformParams("kagi", 0.01, { lineBreakLines: 5 }).lineBreakLines, undefined);
  // `latestCloseSizing` is a property of the transform, not of the settings.
  assert.equal(transformParams("kagi", 0.01).latestCloseSizing, true);
  assert.equal(transformParams("lineBreak", 0.01).latestCloseSizing, undefined);
});

test("an unknown or damaged persisted type falls back to canonical candles", () => {
  for (const bad of [null, undefined, 3, "", "renko ", {}, ["renko"]]) {
    assert.equal(chartTypeOrDefault(bad), "candles", JSON.stringify(bad));
  }
  // A type that IS known round-trips unchanged, including the synthetic ones.
  for (const t of CHART_TYPES) assert.equal(chartTypeOrDefault(t.value), t.value);
});

test("transforms are drawn by a candlestick series, not by a series of their own", () => {
  assert.equal(renderKind("heikinAshi"), "candles");
  assert.equal(renderKind("renko"), "candles");
  assert.equal(renderKind("candles"), "candles");
  assert.equal(renderKind("bars"), "bars");
  assert.equal(renderKind("line"), "line");
  assert.equal(renderKind("lineWithMarkers"), "line");
  assert.equal(renderKind("area"), "area");
  assert.equal(renderKind("hlcArea"), "line");
  assert.equal(renderKind("columns"), "histogram");
  assert.equal(renderKind("highLow"), "candles");
  assert.equal(renderKind("sessionVolumeProfile"), "candles");
  assert.equal(renderKind("lineBreak"), "line");
  assert.equal(renderKind("kagi"), "line");
  assert.equal(renderKind("pointAndFigure"), "line");
});

test("THE MENU OFFERS NO TYPE THE RENDERER CANNOT DRAW", () => {
  // Every entry has a glyph and reaches a real branch of the series factory.
  const menu = read("components/tv/ChartTypeMenu.tsx");
  const chart = read("components/CandleChart.tsx");
  for (const t of CHART_TYPES) {
    assert.ok(menu.includes(`${t.value}:`), `${t.value} has no icon in the menu`);
  }
  assert.ok(!/disabled/.test(menu), "the menu grew an entry that cannot be chosen");
  assert.match(menu, /Transforms · display only/, "the transform group lost its heading");
  // And the chart discloses the transform on the chart itself, not only in the
  // toolbar — sixteen panes, one toolbar. It passes the pane's settings, so
  // the chip names the parameters actually in force.
  assert.match(chart, /syntheticDisclosure\(chartType, settings\)/);
  // The chip stands down while the unavailable notice is speaking: a label
  // asserting "Kagi · 1% reversal" over a blank plot is worse than silence.
  assert.match(chart, /syntheticDisclosure\(chartType, settings\) && !chartUnavailable/);
});

test("isChartType rejects anything that is not a mode", () => {
  assert.equal(isChartType("candles"), true);
  assert.equal(isChartType(""), false);
  assert.equal(isChartType(null), false);
  assert.equal(isChartType(undefined), false);
  assert.equal(isChartType(3), false);
});

test("every mode has a label, and drawsOhlc splits them the way the API does", () => {
  for (const t of CHART_TYPES) assert.ok(chartTypeLabel(t.value).length > 0);
  assert.equal(drawsOhlc("candles"), true);
  assert.equal(drawsOhlc("bars"), true);
  assert.equal(drawsOhlc("line"), false);
  assert.equal(drawsOhlc("area"), false);
  // The transforms hand the series a full bar, so they draw OHLC too.
  assert.equal(drawsOhlc("heikinAshi"), true);
  assert.equal(drawsOhlc("renko"), true);
});

test("time is the bar's own open time in seconds, in every mode", () => {
  for (const t of CHART_TYPES) {
    assert.equal(mainSeriesDatum(t.value, BAR).time, 1_700_000_000);
  }
});

test("OHLC modes carry the candle unchanged", () => {
  // Including the transforms: `mainSeriesDatum` reshapes the bar it is given
  // and never derives one, whichever type asked for it.
  for (const t of ["candles", "bars", "heikinAshi", "renko"] as ChartType[]) {
    const d = mainSeriesDatum(t, BAR);
    assert.equal(d.open, 10);
    assert.equal(d.high, 12);
    assert.equal(d.low, 9);
    assert.equal(d.close, 11);
    assert.equal(d.value, undefined);
  }
});

test("line and area plot the close, and nothing derived from it", () => {
  for (const t of ["line", "lineWithMarkers", "area", "hlcArea"] as ChartType[]) {
    const d = mainSeriesDatum(t, BAR);
    assert.equal(d.value, 11);
    assert.equal(d.open, undefined);
    assert.equal(d.high, undefined);
    assert.equal(d.low, undefined);
  }
});

test("a barcolor() override paints candles fully and bars by body only", () => {
  const candle = mainSeriesDatum("candles", BAR, "#ff0000");
  assert.equal(candle.color, "#ff0000");
  assert.equal(candle.borderColor, "#ff0000");
  assert.equal(candle.wickColor, "#ff0000");

  const bar = mainSeriesDatum("bars", BAR, "#ff0000");
  assert.equal(bar.color, "#ff0000");
  assert.equal(bar.borderColor, undefined);
  assert.equal(bar.wickColor, undefined);
});

test("a bar colour says nothing about a continuous line, so it is not applied", () => {
  for (const t of ["line", "area"] as ChartType[]) {
    const d = mainSeriesDatum(t, BAR, "#ff0000");
    assert.equal(d.color, undefined);
    assert.equal(d.value, 11);
  }
});

test("no colour override leaves the datum uncoloured rather than defaulted", () => {
  for (const t of CHART_TYPES) {
    const d = mainSeriesDatum(t.value, BAR, null);
    assert.equal(d.color, undefined);
  }
});

test("the new presentations are display-only: alerts and orders see canonical bars", () => {
  // The whole point of the presentation/transform split. A hollow candle, a
  // step line and a baseline fill are ways of DRAWING the market's bars; a
  // Heikin Ashi bar and a Renko brick are prices the market never printed.
  for (const type of ["hollowCandles", "stepLine", "baseline"] as const) {
    assert.equal(isSyntheticChartType(type), false,
      `${type} must not be disclosed as synthetic — it changes no price`);
    assert.equal(chartTransform(type), null);
    assert.equal(syntheticDisclosure(type), null);
  }
  // And the two that are.
  for (const type of ["heikinAshi", "renko"] as const) {
    assert.equal(isSyntheticChartType(type), true);
    assert.ok(syntheticDisclosure(type));
  }
});

test("every type names a series kind the renderer can actually create", () => {
  // A type whose `renderKind` the chart does not implement would silently fall
  // through to a line and misdraw without erroring.
  const implemented = new Set(["candles", "bars", "line", "area", "baseline", "histogram"]);
  for (const t of CHART_TYPES) {
    assert.ok(implemented.has(t.renderKind), `${t.value} names an unimplemented ${t.renderKind}`);
  }
  // Hollow candles and step line share a kind with a sibling, and are told
  // apart by the type itself rather than by the kind — which the renderer has
  // to do, and this pins the reason.
  assert.equal(CHART_TYPES.find((t) => t.value === "hollowCandles")!.renderKind, "candles");
  assert.equal(CHART_TYPES.find((t) => t.value === "stepLine")!.renderKind, "line");
});

test("simple TradingView variants reuse canonical OHLC data without changing semantics", () => {
  assert.deepEqual(mainSeriesDatum("highLow", BAR), {
    time: 1_700_000_000, open: 10.5, high: 12, low: 9, close: 10.5,
  });
  assert.equal(mainSeriesDatum("columns", BAR).value, 11);
  assert.equal(mainSeriesDatum("lineWithMarkers", BAR).value, 11);
  assert.equal(mainSeriesDatum("volumeCandles", BAR).close, 11);
  assert.equal(mainSeriesDatum("hlcArea", BAR).value, 11);
  assert.equal(mainSeriesDatum("sessionVolumeProfile", BAR).close, 11);
});

test("HLC area uses the shared fill decoration between high and low overlays", () => {
  const pane = read("components/tv/ChartPane.tsx");
  assert.match(pane, /firstId: `hlc:\$\{paneId\}:high`/);
  assert.match(pane, /secondId: `hlc:\$\{paneId\}:low`/);
  assert.match(pane, /kind: "fill"/);
});
