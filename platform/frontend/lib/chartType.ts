/**
 * How the main price series is drawn.
 *
 * ── Two kinds of entry, and the line between them ──────────────────────────
 *
 * PRESENTATIONS (`candles`, `bars`, `line`, `area`) draw the authoritative
 * exchange candles this chart already holds. Nothing is recomputed and no
 * price appears that did not trade.
 *
 * TRANSFORMS (`heikinAshi`, `renko`) do not. They derive their own bars from
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
 * Kagi, Point & Figure, Range and Line Break are still absent: they are not
 * implemented, and the menu offers only what is.
 */
import {
  DEFAULT_RENKO_ATR_PERIOD, type OhlcBar, type RenkoParams, type TransformKind,
} from "./chartTransforms";

export type { OhlcBar } from "./chartTransforms";
export { DEFAULT_RENKO_ATR_PERIOD } from "./chartTransforms";

export type ChartType =
  | "candles" | "bars" | "line" | "area"
  | "heikinAshi" | "renko";

/** Which of lightweight-charts' series kinds actually draws a type. */
export type ChartRenderKind = "candles" | "bars" | "line" | "area";

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
    value: "area", label: "Area", group: "presentation",
    renderKind: "area", transform: null,
    hint: "Closing price, filled to the baseline",
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

/** The transform to run before drawing, or null when the candles are drawn as-is. */
export function chartTransform(type: ChartType): TransformKind | null {
  return spec(type).transform;
}

/** True for the modes that invent bars: Heikin Ashi and Renko. */
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
  const ohlc = { time, open: bar.open, high: bar.high, low: bar.low, close: bar.close };
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
export type LegendSource = "canonical" | "heikinAshi" | "renkoBrick";

export function legendSource(type: ChartType): LegendSource {
  const transform = chartTransform(type);
  if (transform === "heikinAshi") return "heikinAshi";
  if (transform === "renko") return "renkoBrick";
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
 * False for Renko. A brick is not a bar: one canonical candle can complete
 * several bricks and hundreds can complete none, so a plot drawn at canonical
 * times against a brick axis would *look* aligned to bricks it has no
 * relationship with. Wave 2 left that as an approximation; the resolution here
 * is to draw none of it rather than to draw it wrong, and to say so.
 */
export function timeAnchoredVisualsTruthful(type: ChartType): boolean {
  return chartTransform(type) !== "renko";
}

/** Shown wherever Renko has suppressed a time-anchored layer. */
export const RENKO_ALIGNMENT_NOTE =
  "Bricks are not time bars, so script plots, markers, drawings and indicator "
  + "panes are hidden here rather than drawn at times they do not line up with. "
  + "They are unchanged and return on any other chart type.";
