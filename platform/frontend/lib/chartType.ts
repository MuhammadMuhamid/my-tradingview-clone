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
  | "candles" | "hollowCandles" | "volumeCandles" | "bars" | "line" | "lineWithMarkers"
  | "stepLine" | "area" | "hlcArea" | "baseline" | "columns" | "highLow" | "sessionVolumeProfile"
  | "tpo" | "heikinAshi" | "renko" | "lineBreak" | "kagi" | "pointAndFigure";

/** Which of lightweight-charts' series kinds actually draws a type. */
export type ChartRenderKind = "candles" | "bars" | "line" | "area" | "baseline" | "histogram";

/** The two shelves of the menu. Transforms never mix in with presentations. */
export type ChartTypeGroup = "presentation" | "transform";

export interface ChartTypeSpec {
  value: ChartType;
  label: string;
  hint: string;
  group: ChartTypeGroup;
  renderKind: ChartRenderKind;
  /** The transform applied before drawing, or null for a canonical drawing. */
  transform: TransformKind | null;
}

export const CHART_TYPES: readonly ChartTypeSpec[] = [
  {
    value: "candles", label: "Candles", group: "presentation",
    renderKind: "candles", transform: null,
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
    renderKind: "candles", transform: null,
    hint: "Candles with an unfilled body where the bar closed up",
  },
  {
    value: "volumeCandles", label: "Volume candles", group: "presentation",
    renderKind: "candles", transform: null,
    hint: "Candles shaded by each bar's traded volume",
  },
  {
    value: "bars", label: "Bars", group: "presentation",
    renderKind: "bars", transform: null,
    hint: "Open, high, low and close as an OHLC bar",
  },
  {
    value: "line", label: "Line", group: "presentation",
    renderKind: "line", transform: null,
    hint: "Closing price only",
  },
  {
    value: "lineWithMarkers", label: "Line with markers", group: "presentation",
    renderKind: "line", transform: null,
    hint: "Closing price with a marker at every bar",
  },
  {
    value: "stepLine", label: "Step line", group: "presentation",
    renderKind: "line", transform: null,
    hint: "Closing price as a step — each close held until the next one",
  },
  {
    value: "area", label: "Area", group: "presentation",
    renderKind: "area", transform: null,
    hint: "Closing price, filled to the baseline",
  },
  {
    value: "hlcArea", label: "HLC area", group: "presentation",
    renderKind: "line", transform: null,
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
    renderKind: "baseline", transform: null,
    hint: "Filled above and below the first close in view",
  },
  {
    value: "columns", label: "Columns", group: "presentation",
    renderKind: "histogram", transform: null,
    hint: "Closing price as vertical columns",
  },
  {
    value: "highLow", label: "High-low", group: "presentation",
    renderKind: "candles", transform: null,
    hint: "The traded high-to-low range without an OHLC body",
  },
  {
    value: "sessionVolumeProfile", label: "Session volume profile", group: "presentation",
    renderKind: "candles", transform: null,
    hint: "Candles with a price-volume profile for the current UTC session",
  },
  {
    value: "tpo", label: "Time Price Opportunity (TPO)", group: "presentation",
    renderKind: "candles", transform: null,
    hint: "Session profile counting time brackets at each traded price",
  },
  {
    value: "heikinAshi", label: "Heikin Ashi", group: "transform",
    renderKind: "candles", transform: "heikinAshi",
    hint: "Averaged bars — display only, not traded prices",
  },
  {
    value: "renko", label: `Renko · ATR(${DEFAULT_RENKO_ATR_PERIOD})`, group: "transform",
    renderKind: "candles", transform: "renko",
    hint: `Bricks of one ATR(${DEFAULT_RENKO_ATR_PERIOD}) — display only, no time axis`,
  },
  {
    value: "lineBreak", label: `${DEFAULT_LINE_BREAK_LINES}-line Break`, group: "transform",
    renderKind: "line", transform: "lineBreak",
    hint: `${DEFAULT_LINE_BREAK_LINES}-line close-break transform — display only`,
  },
  {
    value: "kagi", label: `Kagi · ${DEFAULT_KAGI_REVERSAL_PERCENT}% reversal`, group: "transform",
    renderKind: "line", transform: "kagi",
    hint: "Close-driven Kagi line with a fixed percentage reversal",
  },
  {
    value: "pointAndFigure", label: `Point & Figure · ${DEFAULT_PNF_BOX_PERCENT}% / ${DEFAULT_PNF_REVERSAL_BOXES} boxes`, group: "transform",
    renderKind: "line", transform: "pointAndFigure",
    hint: `Price columns using ${DEFAULT_PNF_BOX_PERCENT}% boxes and ${DEFAULT_PNF_REVERSAL_BOXES}-box reversals`,
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
export function chartTransform(type: ChartType): TransformKind | null {
  return spec(type).transform;
}

/** True for the modes that invent bars or synthetic price points. */
export function isSyntheticChartType(type: ChartType): boolean {
  return spec(type).group === "transform";
}

/**
 * Renko's active parameters for a chart type, or null for every other type.
 *
 * V1 has exactly one parameter and it is fixed at ATR(14): the chart-type
 * token IS the parameter set, which is the smallest per-pane representation
 * that persists it — a pane storing `"renko"` restores ATR(14) and nothing
 * else has to round-trip. There is deliberately no settings subsystem; if a
 * period ever becomes adjustable, this is the one function that has to learn
 * where to read it from.
 */
export function renkoParams(type: ChartType): RenkoParams | null {
  return chartTransform(type) === "renko"
    ? { atrPeriod: DEFAULT_RENKO_ATR_PERIOD }
    : null;
}

/** Parameters for every implemented display transform. */
export function transformParams(type: ChartType): TransformParams {
  const transform = chartTransform(type);
  return {
    atrPeriod: DEFAULT_RENKO_ATR_PERIOD,
    ...(transform === "lineBreak" ? { lineBreakLines: DEFAULT_LINE_BREAK_LINES } : {}),
    ...(transform === "kagi" ? { kagiReversalPercent: DEFAULT_KAGI_REVERSAL_PERCENT } : {}),
    ...(transform === "pointAndFigure" ? {
      pnfBoxPercent: DEFAULT_PNF_BOX_PERCENT, pnfReversalBoxes: DEFAULT_PNF_REVERSAL_BOXES,
    } : {}),
    ...(transform === "kagi" || transform === "pointAndFigure" ? { latestCloseSizing: true } : {}),
  };
}

/**
 * The text a chart must show while a transform is active, or null when what is
 * drawn is the canonical candles.
 *
 * Null for every presentation is the load-bearing half: a canonical chart must
 * not carry a synthetic label, or the label stops meaning anything.
 */
export function syntheticDisclosure(type: ChartType): string | null {
  return isSyntheticChartType(type) ? spec(type).label : null;
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
export type LegendSource = "canonical" | "heikinAshi" | "renkoBrick" | "pointFigureColumn" | "kagiPoint" | "lineBreakLine";

export function legendSource(type: ChartType): LegendSource {
  const transform = chartTransform(type);
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
  const transform = chartTransform(type);
  return transform === null || transform === "heikinAshi";
}

/** Shown wherever a sparse transform has suppressed a time-anchored layer. */
export const RENKO_ALIGNMENT_NOTE =
  "Synthetic points are not time bars, so script plots, markers, drawings and "
  + "indicator panes are hidden here rather than drawn at times they do not line "
  + "up with. They are unchanged and return on any other chart type.";
