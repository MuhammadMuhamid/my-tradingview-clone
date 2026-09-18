/**
 * How the main price series is drawn.
 *
 * ── Two kinds of entry, and the line between them ──────────────────────────
 *
 * PRESENTATIONS (`candles`, `bars`, `line`, `area`) draw the authoritative
 * exchange candles this chart already holds. Nothing is recomputed and no
 * price appears that did not trade.
 *
 * TRANSFORMS (`heikinAshi`, `renko`, `lineBreak`, `kagi`, `pointAndFigure`) do not. They derive their own bars from
 * the canonical candles and put prices on screen that never traded — which is
 * the point of them, and exactly why they are labelled wherever they are
 * active and kept in their own group in the menu. They are a lens on the
 * chart and nothing else:
 *
 *      canonical candles ──┬──> strategy, alerts, backtests, LiveRunner,
 *                          │    Paper, manual and Bot orders, Shariah,
 *                          │    scientific results, persisted market data
 *                          │    ── all UNCHANGED, none of them can see a
 *                          │       transformed value ──
 *                          │
 *                          └──> transform (lib/chartTransforms) ──> pixels
 *
 * The arithmetic lives in `lib/chartTransforms`, which has no dependencies and
 * no dependants other than the renderer. This module only says which types
 * exist, what each one means, and how a bar becomes a datum.
 *
 * Point & Figure is a close/high/low display transform with an explicit
 * high-first policy when a candle spans both directions. Range remains absent
 * because its price-crossing inputs are not present in the supported candle
 * contract. Line Break and Kagi are close-driven transforms.
 */
import {
  DEFAULT_KAGI_REVERSAL_PERCENT, DEFAULT_LINE_BREAK_LINES, DEFAULT_RENKO_ATR_PERIOD,
  DEFAULT_PNF_BOX_PERCENT, DEFAULT_PNF_REVERSAL_BOXES,
  type OhlcBar, type RenkoParams, type TransformKind, type TransformParams,
} from "./chartTransforms";

export type { OhlcBar } from "./chartTransforms";
export {
  DEFAULT_KAGI_REVERSAL_PERCENT, DEFAULT_LINE_BREAK_LINES, DEFAULT_RENKO_ATR_PERIOD,
  DEFAULT_PNF_BOX_PERCENT, DEFAULT_PNF_REVERSAL_BOXES,
} from "./chartTransforms";

export type ChartType =
  | "bars" | "candles" | "hollowCandles" | "volumeCandles" | "line" | "lineWithMarkers"
  | "stepLine" | "area" | "hlcArea" | "baseline" | "columns" | "highLow"
  | "footprint" | "tpo" | "sessionVolumeProfile"
  | "heikinAshi" | "renko" | "lineBreak" | "kagi" | "pointAndFigure" | "range";

/** Which of lightweight-charts' series kinds actually draws a type. */
export type ChartRenderKind = "candles" | "bars" | "line" | "area" | "baseline" | "histogram";

/**
 * What a type DOES to the prices, which is not the same thing as where it sits
 * in the menu.
 *
 * `transform` means "this puts a price on screen that never traded"; every
 * other type is a `presentation` of the exchange's own candles. The menu
 * groups by shape and puts Range — a presentation — after the five transforms,
 * so position in `CHART_TYPES` says nothing about this field and vice versa.
 */
export type ChartTypeGroup = "presentation" | "transform";

export interface ChartTypeSpec {
  value: ChartType;
  label: string;
  hint: string;
  group: ChartTypeGroup;
  renderKind: ChartRenderKind;
  /** The transform applied before drawing, or null for a canonical drawing. */
  transform: TransformKind | null;
  /*
   * Whether this type's bars sit at CANONICAL bar times.
   *
   * This was derived from `transform === null`, and that proxy held for every
   * type that existed when it was written. Range broke it: Range applies no
   * candle transform — it is built from the execution tape — so it declared
   * `transform: null` and was classified canonical by omission. It is not.
   * Its bars complete on a price crossing and carry ordering keys, so every
   * time-anchored layer was drawn over them at times they do not line up with,
   * the MA overlay took the price scale with it, and no refit fired when the
   * chart switched into or out of it. None of that was decided; it fell out of
   * a field that was never about time.
   *
   * So it is stated per type, and `tests/chartType.test.ts` requires every
   * type to state it. A type added later cannot inherit the wrong answer.
   */
  timeBase: ChartTimeBase;
}

/** Whether a type draws at canonical bar times or at keys of its own. */
export type ChartTimeBase = "canonical" | "synthetic";

/*
 * THE MENU'S ORDER, AND WHY `range` IS LAST.
 *
 * This list IS the order the chart-style menu renders, measured off the
 * reference at 1440×900: the four price-bar forms, the three line forms, the
 * three filled forms, the two discrete forms, the three trade-driven profiles,
 * then the six price-driven forms — Heikin Ashi, Renko, Line break, Kagi,
 * Point & figure and Range.
 *
 * That last group is a GROUPING IN THE MENU, not the `group` field. Range
 * draws the market's own trade-driven bars and invents no price, so it stays a
 * `presentation`; it simply sits beside the five transforms because that is
 * where a trader looks for it. `group` answers "does this put a price on
 * screen that never traded" and nothing else, so it is no longer true that
 * every presentation precedes every transform in this array — and nothing may
 * infer one from the other.
 */
export const CHART_TYPES: readonly ChartTypeSpec[] = [
  {
    value: "bars", label: "Bars", group: "presentation",
    renderKind: "bars", transform: null, timeBase: "canonical",
    hint: "Open, high, low and close as an OHLC bar",
  },
  {
    value: "candles", label: "Candles", group: "presentation",
    renderKind: "candles", transform: null, timeBase: "canonical",
    hint: "Open, high, low and close as a filled body with wicks",
  },
  {
    /*
     * The same candles, drawn hollow on an up bar.
     *
     * A PRESENTATION, not a transform: the bars are the market's own, and the
     * only difference is whether the body is filled. Which is exactly why it
     * belongs on this shelf — nothing about the prices changes.
     */
    value: "hollowCandles", label: "Hollow candles", group: "presentation",
    renderKind: "candles", transform: null, timeBase: "canonical",
    hint: "Candles with an unfilled body where the bar closed up",
  },
  {
    value: "volumeCandles", label: "Volume candles", group: "presentation",
    renderKind: "candles", transform: null, timeBase: "canonical",
    hint: "Candles shaded by each bar's traded volume",
  },
  {
    value: "line", label: "Line", group: "presentation",
    renderKind: "line", transform: null, timeBase: "canonical",
    hint: "Closing price only",
  },
  {
    value: "lineWithMarkers", label: "Line with markers", group: "presentation",
    renderKind: "line", transform: null, timeBase: "canonical",
    hint: "Closing price with a marker at every bar",
  },
  {
    value: "stepLine", label: "Step line", group: "presentation",
    renderKind: "line", transform: null, timeBase: "canonical",
    hint: "Closing price as a step — each close held until the next one",
  },
  {
    value: "area", label: "Area", group: "presentation",
    renderKind: "area", transform: null, timeBase: "canonical",
    hint: "Closing price, filled to the baseline",
  },
  {
    value: "hlcArea", label: "HLC area", group: "presentation",
    renderKind: "line", transform: null, timeBase: "canonical",
    hint: "High-to-low range filled with the closing price traced through it",
  },
  {
    /*
     * Filled above and below a reference price, in two colours.
     *
     * The reference is the FIRST CLOSE in view, which is what makes it read as
     * "up or down since the start of what I am looking at" rather than as a
     * second, invisible input the user has to set.
     */
    value: "baseline", label: "Baseline", group: "presentation",
    renderKind: "baseline", transform: null, timeBase: "canonical",
    hint: "Filled above and below the first close in view",
  },
  {
    value: "columns", label: "Columns", group: "presentation",
    renderKind: "histogram", transform: null, timeBase: "canonical",
    hint: "Closing price as vertical columns",
  },
  {
    value: "highLow", label: "High-low", group: "presentation",
    renderKind: "candles", transform: null, timeBase: "canonical",
    hint: "The traded high-to-low range without an OHLC body",
  },
  {
    value: "footprint", label: "Volume footprint", group: "presentation", renderKind: "candles", transform: null, timeBase: "canonical",
    hint: "Trade-driven bars with bid/ask volume by price level",
  },
  {
    /*
     * "Time price opportunity", spelt the way the reference spells it.
     *
     * The label used to carry a trailing "(TPO)". A parenthetical acronym in a
     * 273px menu row is chrome every reader steps over on every scan, and the
     * reference — which invented neither the chart nor the abbreviation —
     * prints the words alone. The acronym is still what the settings panel and
     * the pane's own profile readout call it, so nothing that names a control
     * lost it; what went is a second name for the row.
     */
    value: "tpo", label: "Time price opportunity", group: "presentation",
    renderKind: "candles", transform: null, timeBase: "canonical",
    hint: "Session profile counting time brackets at each traded price",
  },
  {
    value: "sessionVolumeProfile", label: "Session volume profile", group: "presentation",
    renderKind: "candles", transform: null, timeBase: "canonical",
    hint: "Candles with a price-volume profile for the current UTC session",
  },
  {
    value: "heikinAshi", label: "Heikin Ashi", group: "transform",
    renderKind: "candles", transform: "heikinAshi", timeBase: "canonical",
    hint: "Averaged bars — display only, not traded prices",
  },
  {
    value: "renko", label: "Renko", group: "transform",
    renderKind: "candles", transform: "renko", timeBase: "synthetic",
    hint: `Bricks of one ATR(${DEFAULT_RENKO_ATR_PERIOD}) — display only, no time axis`,
  },
  {
    value: "lineBreak", label: "Line break", group: "transform",
    // TVP8: a line-break chart is a column of BLOCKS, and `foldLineBreak`
    // already emits one OHLC bar per line — open at the previous line's close,
    // close at the breaking close. Rendering that as `line` threw the block
    // away and drew a polyline through the closes, while the disclosure chip
    // underneath still said "3 lines". Same for Point & figure below.
    renderKind: "candles", transform: "lineBreak", timeBase: "synthetic",
    hint: `${DEFAULT_LINE_BREAK_LINES}-line close-break transform — display only`,
  },
  {
    value: "kagi", label: "Kagi", group: "transform",
    renderKind: "line", transform: "kagi", timeBase: "synthetic",
    hint: "Close-driven Kagi line with a fixed percentage reversal",
  },
  {
    value: "pointAndFigure", label: "Point & figure", group: "transform",
    renderKind: "candles", transform: "pointAndFigure", timeBase: "synthetic",
    hint: `Price columns using ${DEFAULT_PNF_BOX_PERCENT}% boxes and ${DEFAULT_PNF_REVERSAL_BOXES}-box reversals`,
  },
  {
    value: "range", label: "Range", group: "presentation", renderKind: "candles", transform: null, timeBase: "synthetic",
    hint: "Trade-driven bars completed after the configured price range",
  },
];

export const CHART_TYPE_KEY = "tv.chartType";

const DEFAULT_CHART_TYPE: ChartType = "candles";

function spec(type: ChartType): ChartTypeSpec {
  return CHART_TYPES.find((t) => t.value === type) ?? CHART_TYPES[0]!;
}

export function isChartType(value: unknown): value is ChartType {
  return CHART_TYPES.some((t) => t.value === value);
}

/** Anything unrecognised — a damaged record, a type from a newer build. */
export function chartTypeOrDefault(value: unknown): ChartType {
  return isChartType(value) ? value : DEFAULT_CHART_TYPE;
}

export function chartTypeLabel(type: ChartType): string {
  return spec(type).label;
}

/** The lightweight-charts series that draws this type. */
export function renderKind(type: ChartType): ChartRenderKind {
  return spec(type).renderKind;
}

/** Modes that draw open/high/low as well as close. */
export function drawsOhlc(type: ChartType): boolean {
  const kind = renderKind(type);
  return kind === "candles" || kind === "bars";
}

export function isVolumeCandle(type: ChartType): boolean { return type === "volumeCandles"; }
export function hasLineMarkers(type: ChartType): boolean { return type === "lineWithMarkers"; }
export function hasHlcComponents(type: ChartType): boolean { return type === "hlcArea"; }
export function isHighLow(type: ChartType): boolean { return type === "highLow"; }

/** The transform to run before drawing, or null when the candles are drawn as-is. */
/**
 * Whether a transform draws on a time base of its own.
 *
 * Renko bricks, line-break lines, Kagi segments and P&F columns are not time
 * bars: their count and their spacing come from price, so a viewport that was
 * right for the candles is not right for them. Heikin Ashi is the exception —
 * one smoothed bar per canonical bar, same times — which is why switching to
 * it holds the viewport and switching to the other four refits.
 *
 * It takes a TYPE now, not a transform. Range applies no transform and has a
 * time base of its own, so the transform could not answer this question; the
 * spec does.
 */
export function isSyntheticTimeBase(type: ChartType): boolean {
  return spec(type).timeBase === "synthetic";
}

export function chartTransform(type: ChartType): TransformKind | null {
  return spec(type).transform;
}

/** True for the modes that invent bars or synthetic price points. */
export function isSyntheticChartType(type: ChartType): boolean {
  return spec(type).group === "transform";
}

/**
 * Where a transform reads its parameters from.
 *
 * These were constants: "the chart-type token IS the parameter set", which is
 * the smallest thing that persists and was the right call while nothing could
 * change them. The comment that used to sit here said that if a period ever
 * became adjustable this is the one function that would have to learn where
 * to read it from. It has.
 *
 * The source is the pane's own `ChartSettings`, so a parameter round-trips
 * with the workspace exactly as `rangeTicks` already did, and an absent
 * settings object still yields the documented defaults — every caller that
 * has not been given one keeps its old behaviour to the digit.
 */
export interface TransformSettings {
  renkoAtrPeriod?: number;
  lineBreakLines?: number;
  kagiReversalPercent?: number;
  pnfBoxPercent?: number;
  pnfReversalBoxes?: number;
}

export function renkoParams(type: ChartType, settings?: TransformSettings): RenkoParams | null {
  return chartTransform(type) === "renko"
    ? { atrPeriod: settings?.renkoAtrPeriod ?? DEFAULT_RENKO_ATR_PERIOD }
    : null;
}

/** Parameters for every implemented display transform. */
export function transformParams(
  type: ChartType, tickSize = 0.01, settings?: TransformSettings
): TransformParams {
  const transform = chartTransform(type);
  return {
    atrPeriod: settings?.renkoAtrPeriod ?? DEFAULT_RENKO_ATR_PERIOD,
    ...(transform === "lineBreak"
      ? { lineBreakLines: settings?.lineBreakLines ?? DEFAULT_LINE_BREAK_LINES } : {}),
    ...(transform === "kagi"
      ? { kagiReversalPercent: settings?.kagiReversalPercent ?? DEFAULT_KAGI_REVERSAL_PERCENT } : {}),
    ...(transform === "pointAndFigure" ? {
      pnfBoxPercent: settings?.pnfBoxPercent ?? DEFAULT_PNF_BOX_PERCENT,
      pnfReversalBoxes: settings?.pnfReversalBoxes ?? DEFAULT_PNF_REVERSAL_BOXES,
    } : {}),
    // TVP8: Renko joins the two percentage transforms in sizing from the
    // latest bar. Equal brick height is Renko's defining property, and the
    // reference buys it with exactly this repaint.
    ...(transform === "kagi" || transform === "pointAndFigure" || transform === "renko"
      ? { latestCloseSizing: true } : {}),
    tickSize,
  };
}

/**
 * The active parameters of a transform, as a short phrase, or null.
 *
 * Split out of `label` because the label is used in six places — the menu row,
 * the toolbar's disclosure text, the on-chart amber chip, the settings
 * heading, the screen-reader announcement and the tooltip — and baking
 * "· ATR(14)" into it meant a user who changed the period read a stale number
 * in all six. The reference's menu says "Renko"; the parameters belong beside
 * the controls that set them.
 */
export function transformParamSummary(
  type: ChartType, settings?: TransformSettings
): string | null {
  switch (chartTransform(type)) {
    case "renko":
      return `ATR(${settings?.renkoAtrPeriod ?? DEFAULT_RENKO_ATR_PERIOD})`;
    case "lineBreak":
      return `${settings?.lineBreakLines ?? DEFAULT_LINE_BREAK_LINES} lines`;
    case "kagi":
      return `${settings?.kagiReversalPercent ?? DEFAULT_KAGI_REVERSAL_PERCENT}% reversal`;
    case "pointAndFigure":
      return `${settings?.pnfBoxPercent ?? DEFAULT_PNF_BOX_PERCENT}% / `
        + `${settings?.pnfReversalBoxes ?? DEFAULT_PNF_REVERSAL_BOXES} boxes`;
    default:
      return null;
  }
}

/**
 * The text a chart must show while a transform is active, or null when what is
 * drawn is the canonical candles.
 *
 * Null for every presentation is the load-bearing half: a canonical chart must
 * not carry a synthetic label, or the label stops meaning anything.
 */
export function syntheticDisclosure(
  type: ChartType, settings?: TransformSettings
): string | null {
  if (!isSyntheticChartType(type)) return null;
  const params = transformParamSummary(type, settings);
  // The chip names the transform and its ACTIVE parameters, so a user who
  // changed the Renko period reads their own number rather than the default
  // that used to be welded into the label.
  return params ? `${spec(type).label} · ${params}` : spec(type).label;
}

/** Spelt out for screen readers and the badge's tooltip. */
export const SYNTHETIC_DISCLOSURE_HINT =
  "Synthetic display transform. Orders, alerts, strategies and backtests use "
  + "the canonical exchange candles, not the bars drawn here.";

export function loadChartType(): ChartType {
  if (typeof window === "undefined") return DEFAULT_CHART_TYPE;
  try {
    return chartTypeOrDefault(window.localStorage.getItem(CHART_TYPE_KEY));
  } catch {
    return DEFAULT_CHART_TYPE;
  }
}

export function saveChartType(type: ChartType): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CHART_TYPE_KEY, type);
  } catch { /* private mode — the preference is a convenience, not state */ }
}

/**
 * One bar in the wire shape the chosen presentation needs.
 *
 * `color` is a per-bar override from `barcolor()`. It is applied only to the
 * OHLC modes: a script that colours *bars* has said nothing about how to
 * colour a continuous line, and tinting line segments per bar would be an
 * invention rather than a rendering of what the script asked for.
 */
export interface MainSeriesDatum {
  time: number;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  value?: number;
  color?: string;
  borderColor?: string;
  wickColor?: string;
}

/**
 * A bar in the shape the series takes.
 *
 * `bar` is whatever the renderer is drawing: a canonical candle for the
 * presentations, or an already-transformed bar for Heikin Ashi and Renko. This
 * function performs no transform of its own — it reshapes one bar and nothing
 * more, so it can never be the place a synthetic price leaks in.
 */
export function mainSeriesDatum(
  type: ChartType, bar: OhlcBar, color?: string | null
): MainSeriesDatum {
  const time = bar.openTime / 1000;
  const kind = renderKind(type);
  if (kind !== "candles" && kind !== "bars") return { time, value: bar.close };
  const ohlc = type === "highLow"
    ? {
        time, open: (bar.high + bar.low) / 2,
        high: bar.high, low: bar.low, close: (bar.high + bar.low) / 2,
      }
    : { time, open: bar.open, high: bar.high, low: bar.low, close: bar.close };
  if (!color) return ohlc;
  return kind === "candles"
    ? { ...ohlc, color, borderColor: color, wickColor: color }
    : { ...ohlc, color };
}

/**
 * Which bars the OHLC legend is describing.
 *
 * The legend used to read the canonical candles whatever was drawn, which for
 * Heikin Ashi meant the numbers named O/H/L/C did not match the body the user
 * was pointing at, and for Renko meant a time-candle readout was printed over
 * a chart that has no time candles. Both are answered here rather than in the
 * renderer, so "what does the legend claim" is a property of the chart type.
 */
export type LegendSource = "canonical" | "tradeBar" | "heikinAshi" | "renkoBrick" | "pointFigureColumn" | "kagiPoint" | "lineBreakLine";

export function legendSource(type: ChartType): LegendSource {
  const transform = chartTransform(type);
  /*
   * Footprint is NOT a tradeBar legend, though it once was.
   *
   * Its series holds the canonical candles — the exchange's own OHLC for every
   * bar, with the tape supplying cells on top rather than bars underneath — so
   * the legend must read the same thing the user is pointing at. The tradeBar
   * shape it used to read came from `footprintBarsAsOhlc`, whose `open` is the
   * lowest traded LEVEL and whose `close` is a volume-weighted mean, printed
   * under the labels O/H/L/C. `open` equalled `low` on every bar, which is the
   * tell. Range keeps it: a range bar genuinely is the bar being drawn.
   */
  if (type === "range") return "tradeBar";
  if (transform === "heikinAshi") return "heikinAshi";
  if (transform === "renko") return "renkoBrick";
  if (transform === "pointAndFigure") return "pointFigureColumn";
  if (transform === "kagi") return "kagiPoint";
  if (transform === "lineBreak") return "lineBreakLine";
  return "canonical";
}

/**
 * Whether anything anchored to a canonical timestamp can be drawn truthfully
 * on top of this presentation.
 *
 * True for every canonical presentation, and true for Heikin Ashi, which emits
 * exactly one bar per canonical bar at that bar's own timestamp — so a script
 * plot, a trade marker or a drawing lands on the bar it belongs to.
 *
 * False for sparse price-driven displays. A synthetic point is not a canonical
 * time bar: one candle can complete several points and many can complete none,
 * so a plot drawn at canonical times against that axis would look aligned to
 * points it has no relationship with. The resolution is to draw none of it
 * rather than to draw it wrong, and to say so.
 */
export function timeAnchoredVisualsTruthful(type: ChartType): boolean {
  return spec(type).timeBase === "canonical";
}

/** Shown wherever a sparse transform has suppressed a time-anchored layer. */
export const RENKO_ALIGNMENT_NOTE =
  "Synthetic points are not time bars, so script plots, markers, drawings and "
  + "indicator panes are hidden here rather than drawn at times they do not line "
  + "up with. They are unchanged and return on any other chart type.";
