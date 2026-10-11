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
  drawsOhlc, isChartType, isSyntheticChartType, isSyntheticTimeBase, mainSeriesDatum, renderKind, renkoParams,
  timeAnchoredVisualsTruthful,
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
   *
   * TVP8: re-pinned to the live reference, measured at 1440x900. Two runs
   * moved. The profiles now read footprint, TPO, session volume profile — the
   * order they appear in the reference, not the order they were implemented
   * in. And `range` moved from the middle of the profiles to the very END,
   * after the five transforms, because that is where a trader looks for it:
   * beside the other bars whose count and spacing come from price rather than
   * from the clock.
   */
  assert.deepEqual(CHART_TYPES.map((t) => t.value), [
    "bars", "candles", "hollowCandles", "volumeCandles",
    "line", "lineWithMarkers", "stepLine",
    "area", "hlcArea", "baseline",
    "columns", "highLow",
    "footprint", "tpo", "sessionVolumeProfile",
    "heikinAshi", "renko", "lineBreak", "kagi", "pointAndFigure", "range",
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
      "stepLine", "area", "hlcArea", "baseline", "columns", "highLow",
      "footprint", "tpo", "sessionVolumeProfile", "range"]);
  assert.deepEqual(transforms, ["heikinAshi", "renko", "lineBreak", "kagi", "pointAndFigure"]);

  /*
   * POSITION NO LONGER IMPLIES GROUP, AND NOTHING MAY ASSUME IT DOES.
   *
   * This used to assert that every presentation preceded every transform, so
   * the menu could render `filter(presentation)` then `filter(transform)` and
   * get the list back in order. The reference puts Range LAST — after Point &
   * figure — and Range is a presentation: it draws the market's own
   * trade-driven bars and invents no price. Both facts are true at once, and
   * the menu now renders `CHART_TYPES` in sequence rather than in two passes,
   * which is what lets them be.
   *
   * What still has to hold is that `group` answers only its own question, for
   * every type, wherever it sits.
   */
  const last = CHART_TYPES[CHART_TYPES.length - 1]!;
  assert.equal(last.value, "range");
  assert.equal(last.group, "presentation",
    "Range sits with the price-driven forms in the menu and invents no price — "
    + "its position must not be read as a claim that it is synthetic");
  assert.equal(syntheticDisclosure("range"), null);

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
  // TVP8: line break and P&F draw blocks, not a polyline through the closes.
  assert.equal(renderKind("lineBreak"), "candles");
  assert.equal(renderKind("pointAndFigure"), "candles");
  // Kagi is genuinely a LINE — one continuous path whose width changes at the
  // shoulder. It is the one transform a candlestick series cannot express.
  assert.equal(renderKind("kagi"), "line");
});

test("A TRANSFORM THAT EMITS A BLOCK IS NEVER DRAWN AS A LINE", () => {
  /*
   * The rule the assertion above is a table of.
   *
   * Line break and Point & figure each spent a campaign as `renderKind: "line"`
   * while their folds emitted a full OHLC block, so `mainSeriesDatum` reduced
   * every one of them to `{ time, value: close }` and the chart drew a polyline
   * under a chip reading "3 lines" or "1% / 3 boxes". A table of expected
   * strings could not catch that, because the table was equally happy to be
   * wrong. This asks the pair of them directly: if the transform's own output
   * distinguishes open from close, the renderer has to keep both.
   */
  const block = {
    openTime: 1_700_000_000_000, open: 100, high: 110, low: 99, close: 108,
  };
  for (const type of CHART_TYPES.filter((t) => t.group === "transform")) {
    const datum = mainSeriesDatum(type.value, block) as unknown as Record<string, number>;
    if (type.value === "kagi") continue;  // a line by definition, see above
    assert.ok("open" in datum && "close" in datum,
      `${type.value} transforms OHLC but is rendered as a line — its open is discarded`);
    assert.equal(datum.open, 100, `${type.value} lost its open`);
    assert.equal(datum.close, 108, `${type.value} lost its close`);
  }
});

test("THE MENU OFFERS NO TYPE THE RENDERER CANNOT DRAW", () => {
  // Every entry has a glyph and reaches a real branch of the series factory.
  const menu = read("components/tv/ChartTypeMenu.tsx");
  const chart = read("components/CandleChart.tsx");
  for (const t of CHART_TYPES) {
    assert.ok(menu.includes(`${t.value}:`), `${t.value} has no icon in the menu`);
  }
  assert.ok(!/disabled/.test(menu), "the menu grew an entry that cannot be chosen");

  /*
   * THE HEADING IS GONE AND THE DISCLOSURE IS NOT.
   *
   * The transform group used to sit under a written heading, "Transforms ·
   * display only". The reference has no headings in this menu at all — six
   * runs of related shapes, separated by a space and a hairline — and a
   * heading that applies to five of twenty-one rows reads as a warning label
   * on a list the other sixteen rows are also on.
   *
   * So the sentence moved onto the ROWS it is about, where it is attached to
   * the thing it describes: every transform's `title` carries the whole
   * "display only" statement and its accessible name says so too. The
   * load-bearing copy was never here — it is the amber chip `CandleChart`
   * paints on the chart itself, which is on screen the entire time a
   * transform is drawing and is asserted below.
   */
  assert.doesNotMatch(menu, /Transforms · display only/,
    "the reference's menu has no headings; the disclosure belongs on the rows");
  assert.match(menu, /SYNTHETIC_DISCLOSURE_HINT/,
    "a transform row must still carry the whole display-only sentence");
  assert.match(menu, /a synthetic display transform/,
    "and must still say so in its accessible name");
  // And the chart discloses the transform on the chart itself, not only in the
  // toolbar — sixteen panes, one toolbar. It passes the pane's settings, so
  // the chip names the parameters actually in force.
  assert.match(chart, /syntheticDisclosure\(chartType, settings\)/);
  // The chip stands down while the unavailable notice is speaking: a label
  // asserting "Kagi · 1% reversal" over a blank plot is worse than silence.
  assert.match(chart, /syntheticDisclosure\(chartType, settings\) && !chartUnavailable/);
});

test("THE BAR IS A SPLIT CONTROL AND THE MENU OPENS AT THE TOP OF THE ROW", () => {
  /*
   * The measured shape of the reference's own control, at 1440x900.
   *
   * The bar carries the account's favourite styles as 38px icon-only radio
   * buttons followed by a 24px caret, and the caret's menu is 273px wide,
   * opening at the caret's left edge.
   *
   * F-12 (re-measured on live Premium twice, 2026-10-11): the list is a
   * full-height column from the viewport's top — 273×900 at y=0 — the same
   * rule as the interval menu, capped at the viewport and scrolling inside.
   * B-16 had hung it under the caret at viewport − 48 (273×852 at y=40).
   */
  const menu = read("components/tv/ChartTypeMenu.tsx");

  // The split: radios on the bar, a caret-only disclosure after them.
  assert.match(menu, /role="radiogroup"/);
  assert.match(menu, /role="radio"/);
  assert.match(menu, /aria-checked=\{selected\}/);
  assert.match(menu, /w-\[38px\]/, "a style chip on the bar is 38px square");
  assert.match(menu, /className=\{TOOL_CARET_BUTTON\}/,
    "the caret is the shared 24px half of a split button, not a bespoke one");
  assert.match(menu, /aria-label="Chart style"/);
  assert.match(menu, /aria-haspopup="menu"/);

  // The menu's own geometry.
  assert.match(menu, /absolute left-0 top-0 z-50 max-h-\[100vh\] w-\[273px\] overflow-y-auto/);
  assert.doesNotMatch(menu, /max-h-\[calc\(100vh-48px\)\]/, "the list is no longer hung under the caret");

  /*
   * NO WRITTEN DISCLOSURE ON THE BAR, AND NOT BECAUSE IT STOPPED MATTERING.
   *
   * The trigger used to grow an amber word — "Renko · ATR(14)" — whenever a
   * transform was on. It was the widest thing on the row at the moment the
   * row was most under pressure, and it was the THIRD copy of a statement the
   * chart itself already makes: `CandleChart` paints the same chip on the
   * plot for as long as the transform is drawing, which is asserted above and
   * is the copy that cannot be missed.
   *
   * So the value is computed here and spent on the tooltip and the accessible
   * name, and no ink on the bar.
   */
  assert.doesNotMatch(menu, /\{synthetic\}/,
    "the disclosure must not be drawn as a label on the toolbar");
  assert.match(menu, /\$\{SYNTHETIC_DISCLOSURE_HINT\}/,
    "…but the caret must still carry the whole sentence in its tooltip");

  /*
   * The favourites are a PER-BROWSER toolbar preference, stored beside the
   * timeframe strip's own and under a versioned key — not workspace state,
   * because it is a fact about this toolbar and not about any chart.
   */
  assert.match(menu, /"tv\.chart-type\.favourites\.v1"/);
  assert.match(menu, /"candles", "heikinAshi", "renko"/,
    "the reference's own defaults for a fresh account");
});

test("THE MENU IS SIX RUNS OF SHAPES, IN THE REFERENCE'S ORDER", () => {
  const menu = read("components/tv/ChartTypeMenu.tsx");
  const starts = /const GROUP_STARTS = new Set<ChartType>\(\[([\s\S]*?)\]\)/.exec(menu);
  assert.ok(starts, "the group breaks could not be located");
  const declared = [...starts[1]!.matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]!);
  assert.deepEqual(declared, ["line", "area", "columns", "footprint", "heikinAshi"],
    "five hairlines, splitting the twenty-one rows into the reference's six runs");

  // Every break names a type that exists and is not the first row — a stale
  // one would silently draw a hairline above nothing or above everything.
  const order = CHART_TYPES.map((t) => t.value);
  for (const start of declared) {
    assert.ok(order.includes(start as ChartType), `${start} is not a chart type`);
    assert.notEqual(order[0], start, "a break above the first row is a rule above a list");
  }

  // The label the reference prints, without the acronym it does not print.
  assert.equal(chartTypeLabel("tpo"), "Time price opportunity");
  assert.equal(chartTypeLabel("footprint"), "Volume footprint");
  assert.equal(chartTypeLabel("sessionVolumeProfile"), "Session volume profile");
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

test("A CHANGE OF TIME BASE REFITS; A CHANGE OF PRESENTATION DOES NOT", () => {
  /*
   * Candles → bars → line are the same bars drawn differently, and holding the
   * viewport across that is what stops the chart jumping under the user.
   *
   * Renko, Line break, Kagi and P&F are not the same bars. Their series has a
   * different length and its spacing comes from price, so the held range
   * landed on times that series does not occupy: choosing Line break showed
   * four fifths of an empty pane with a perfectly correct chart off to the
   * right, until the user found `reset`.
   *
   * Heikin Ashi is one smoothed bar per canonical bar at the same times, so it
   * stays on the viewport-preserving side — which is what makes it read as the
   * same chart, smoothed.
   */
  /*
   * It asks the TYPE, not the transform. Range applies no candle transform —
   * it is built from the execution tape — so it answered `transform: null` and
   * was classified canonical by omission, which is the whole of F-1: overlays
   * drawn at times its bars do not hold, the MA taking the price scale, and no
   * refit on the way in or out.
   */
  assert.equal(isSyntheticTimeBase("candles"), false);
  assert.equal(isSyntheticTimeBase("heikinAshi"), false);
  assert.equal(isSyntheticTimeBase("footprint"), false,
    "footprint's series holds the canonical candles, so its time base is theirs");
  for (const t of ["renko", "lineBreak", "kagi", "pointAndFigure", "range"] as const) {
    assert.equal(isSyntheticTimeBase(t), true, `${t} has a time base of its own`);
  }

  // Every type states it, so a type added later cannot inherit a wrong answer.
  const synthetic = CHART_TYPES.filter((t) => isSyntheticTimeBase(t.value)).map((t) => t.value);
  assert.deepEqual([...synthetic].sort(),
    ["kagi", "lineBreak", "pointAndFigure", "range", "renko"]);

  // A synthetic time base and a truthful time-anchored layer are the same
  // question asked twice; they may never disagree.
  for (const t of CHART_TYPES) {
    assert.equal(timeAnchoredVisualsTruthful(t.value), !isSyntheticTimeBase(t.value),
      `${t.value} cannot both hide its time-anchored layers and keep them`);
  }

  // And the chart actually acts on it, rather than only exporting the rule.
  const chart = read("components/CandleChart.tsx");
  assert.match(chart, /isSyntheticTimeBase\(drawnType\)/,
    "the time-base change must reach the refit");
  assert.match(chart, /timeBaseChanged/);
});
