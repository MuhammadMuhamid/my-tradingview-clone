/**
 * One source of truth for how every lightweight-charts instance in the
 * workspace is themed.
 *
 * The price chart, each indicator pane, the split view's second chart and the
 * strategy tester's equity curve each called `createChart` with their own
 * hand-copied colour literals. They had already drifted — the equity curve
 * painted an opaque background while the panes were transparent, and the grid
 * was a different weight in each — so a change to the surface hierarchy had to
 * be made in four places and was in practice made in one.
 *
 * The values themselves are the Tailwind tokens in `tailwind.config.ts`, kept
 * as literals because lightweight-charts renders to a canvas and cannot read a
 * CSS custom property.
 */
import { ColorType, CrosshairMode, LineStyle, type DeepPartial, type ChartOptions, type IChartApi } from "lightweight-charts";

export const CHART_SURFACE = "#121722";
export const CHART_GRID = "#161c28";
export const CHART_BORDER = "#232b3a";
export const CHART_TEXT = "#9aa4b6";
export const CHART_TEXT_STRONG = "#e6e9ef";
export const CHART_FONT = "ui-monospace, SFMono-Regular, Menlo, monospace";

/*
 * The chart's semantic colours — the same values as the Tailwind tokens `up`,
 * `down`, `accent` and `warn`, held here because a canvas cannot read a class.
 * Every series, marker and histogram reads these rather than its own literal,
 * so the product's meaning of green, red, blue and amber is decided once.
 */
export const CHART_UP = "#2ebd85";
export const CHART_DOWN = "#f6465d";
export const CHART_ACCENT = "#4f8cff";
export const CHART_CAUTION = "#f0b90b";
/** Volume bars: the same hues at histogram strength, under the candles. */
export const CHART_VOLUME_UP = "#1c3a30";
export const CHART_VOLUME_DOWN = "#3a1c24";
/** A series with no direction yet (an empty volume histogram, a muted line). */
export const CHART_MUTED = "#2a3346";
export const CHART_CROSSHAIR = "#4b556b";
export const CHART_LABEL_BG = "#2c3548";

function cssToken(name: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/** The volume histogram's colour for one bar. */
export function volumeColor(open: number, close: number): string {
  return close >= open ? CHART_VOLUME_UP : CHART_VOLUME_DOWN;
}

/**
 * Width reserved for the price axis in every pane.
 *
 * Without it each pane sizes its own axis to its own longest label, so the
 * price chart's axis started at one x and the oscillator's at another: the
 * plot areas below one another were different widths and the same bar sat at
 * two different horizontal positions down the stack. TradingView aligns them,
 * and it is the single change that makes a multi-pane layout read as one
 * chart rather than three stacked ones.
 */
export const PRICE_AXIS_WIDTH = 76;

/**
 * Base options shared by every chart.
 *
 * `attributionLogo: false` is deliberate and must stay: lightweight-charts 4.2
 * paints a TradingView wordmark into the corner of every pane by default. This
 * product is not TradingView and does not carry its identity — with three
 * indicator panes and an equity curve on screen the default put five of them
 * on one page.
 */
export function baseChartOptions(): DeepPartial<ChartOptions> {
  const text = cssToken("--ts-ink-muted", CHART_TEXT);
  const grid = cssToken("--ts-chart-grid", CHART_GRID);
  const border = cssToken("--ts-line", CHART_BORDER);
  const crosshair = cssToken("--ts-chart-crosshair", CHART_CROSSHAIR);
  const label = cssToken("--ts-chart-label", CHART_LABEL_BG);
  return {
    layout: {
      background: { type: ColorType.Solid, color: "rgba(0,0,0,0)" },
      textColor: text,
      fontFamily: CHART_FONT,
      fontSize: 11,
      attributionLogo: false,
    },
    grid: {
      vertLines: { color: grid },
      horzLines: { color: grid },
    },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: {
        color: crosshair, width: 1, style: LineStyle.LargeDashed,
        labelBackgroundColor: label,
      },
      horzLine: {
        color: crosshair, width: 1, style: LineStyle.LargeDashed,
        labelBackgroundColor: label,
      },
    },
    rightPriceScale: {
      borderColor: border,
      minimumWidth: PRICE_AXIS_WIDTH,
    },
    timeScale: {
      borderColor: border,
      timeVisible: true,
      secondsVisible: false,
    },
    autoSize: true,
  };
}

/** Apply semantic canvas tokens immediately whenever the root theme changes. */
export function subscribeChartTheme(chart: IChartApi): () => void {
  const apply = (): void => chart.applyOptions(baseChartOptions());
  window.addEventListener("trading-scene-theme", apply);
  return () => window.removeEventListener("trading-scene-theme", apply);
}
