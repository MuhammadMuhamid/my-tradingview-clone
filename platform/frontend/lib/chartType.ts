/**
 * How the main price series is drawn.
 *
 * Every mode here is a different *presentation* of the same authoritative OHLC
 * candles the chart already holds — nothing is recomputed, resampled or
 * synthesised. That is the whole reason the list stops where it does:
 * Heikin-Ashi, Renko, Kagi, Range and Point & Figure are not presentations,
 * they are transformations that invent their own bars, and drawing them from
 * this dataset would put prices on screen that never traded. They are absent
 * rather than approximated.
 */
export type ChartType = "candles" | "bars" | "line" | "area";

export const CHART_TYPES: readonly { value: ChartType; label: string; hint: string }[] = [
  { value: "candles", label: "Candles", hint: "Open, high, low and close as a filled body with wicks" },
  { value: "bars", label: "Bars", hint: "Open, high, low and close as an OHLC bar" },
  { value: "line", label: "Line", hint: "Closing price only" },
  { value: "area", label: "Area", hint: "Closing price, filled to the baseline" },
];

export const CHART_TYPE_KEY = "tv.chartType";

const DEFAULT_CHART_TYPE: ChartType = "candles";

export function isChartType(value: unknown): value is ChartType {
  return CHART_TYPES.some((t) => t.value === value);
}

export function chartTypeLabel(type: ChartType): string {
  return CHART_TYPES.find((t) => t.value === type)?.label ?? type;
}

/** Modes that draw open/high/low as well as close. */
export function drawsOhlc(type: ChartType): boolean {
  return type === "candles" || type === "bars";
}

export function loadChartType(): ChartType {
  if (typeof window === "undefined") return DEFAULT_CHART_TYPE;
  try {
    const raw = window.localStorage.getItem(CHART_TYPE_KEY);
    return isChartType(raw) ? raw : DEFAULT_CHART_TYPE;
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

/** The subset of a candle the presentation layer reads. */
export interface OhlcBar {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
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

export function mainSeriesDatum(
  type: ChartType, bar: OhlcBar, color?: string | null
): MainSeriesDatum {
  const time = bar.openTime / 1000;
  if (!drawsOhlc(type)) return { time, value: bar.close };
  const ohlc = { time, open: bar.open, high: bar.high, low: bar.low, close: bar.close };
  if (!color) return ohlc;
  return type === "candles"
    ? { ...ohlc, color, borderColor: color, wickColor: color }
    : { ...ohlc, color };
}
