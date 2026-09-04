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
import { ColorType, CrosshairMode, LineStyle, type DeepPartial, type ChartOptions } from "lightweight-charts";

export const CHART_SURFACE = "#121722";
export const CHART_GRID = "#161c28";
export const CHART_BORDER = "#232b3a";
export const CHART_TEXT = "#9aa4b6";
export const CHART_TEXT_STRONG = "#e6e9ef";
export const CHART_FONT = "ui-monospace, SFMono-Regular, Menlo, monospace";

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
  return {
    layout: {
      background: { type: ColorType.Solid, color: "rgba(0,0,0,0)" },
      textColor: CHART_TEXT,
      fontFamily: CHART_FONT,
      fontSize: 11,
      attributionLogo: false,
    },
    grid: {
      vertLines: { color: CHART_GRID },
      horzLines: { color: CHART_GRID },
    },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: {
        color: "#4b556b", width: 1, style: LineStyle.LargeDashed,
        labelBackgroundColor: "#2c3548",
      },
      horzLine: {
        color: "#4b556b", width: 1, style: LineStyle.LargeDashed,
        labelBackgroundColor: "#2c3548",
      },
    },
    rightPriceScale: {
      borderColor: CHART_BORDER,
      minimumWidth: PRICE_AXIS_WIDTH,
    },
    timeScale: {
      borderColor: CHART_BORDER,
      timeVisible: true,
      secondsVisible: false,
    },
    autoSize: true,
  };
}
