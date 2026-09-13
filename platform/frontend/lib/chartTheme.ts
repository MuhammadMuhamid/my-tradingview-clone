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

export const CHART_SURFACE = "#0f0f0f";
export const CHART_GRID = "#1e1e1e";
export const CHART_BORDER = "#2e2e2e";
export const CHART_TEXT = "#a8a8a8";
export const CHART_TEXT_STRONG = "#dbdbdb";

/**
 * The chart speaks the UI's voice, not a terminal's.
 *
 * This was `ui-monospace, SFMono-Regular, Menlo, monospace` at 11px, and it
 * put the entire pane legend, the OHLC row, every indicator value and every
 * axis label into a typewriter face — twenty-four monospaced elements on the
 * default chart. TradingView has exactly zero anywhere in its chart UI and
 * draws the same content in the platform UI sans at 13-16px, which is why a
 * side-by-side reads as two different classes of product before a single
 * colour is compared.
 *
 * Monospace earns its place on code — the Pine editor keeps it. It does not
 * earn its place on prose ("Built from 1m bars loaded for this range"), on
 * indicator names, or on a price. Where numbers genuinely need to line up in a
 * column, `font-variant-numeric: tabular-nums` on the proportional face does
 * that job without changing what the product sounds like; `body` sets
 * `font-feature-settings: "tnum" 1` globally and `.tabular` is the opt-in for
 * anything that needs it locally.
 *
 * Kept in sync with `--ts-font-ui` in `app/globals.css`, which is the same
 * stack for everything a class can reach. A canvas cannot read a custom
 * property, so this literal is the canvas's copy.
 */
export const CHART_FONT =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, Roboto, "Helvetica Neue", Arial, sans-serif';

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
/** A series with no direction yet (an empty volume histogram, a muted line). */
export const CHART_MUTED = "#3a3a3a";
export const CHART_CROSSHAIR = "#5c5c5c";
export const CHART_LABEL_BG = "#3d3d3d";

function cssToken(name: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/**
 * The volume histogram's two colours.
 *
 * These were the literals `#1c3a30` and `#3a1c24` — picked by eye against the
 * dark surface and, being literals on a canvas, unreachable by the theme. In
 * light mode they painted very nearly black bars across a white chart, which
 * is the one thing a volume histogram must never do: it sits UNDER the price
 * series and has to recede.
 *
 * They are now derived rather than chosen, from two things that are already
 * true:
 *
 *   - the direction colour is the user's own `upColor` / `downColor` chart
 *     setting, so recolouring the candles recolours the volume beneath them
 *     instead of leaving it on a palette the user never picked;
 *   - the mix is toward the chart surface, so the same rule produces a sunk
 *     teal on black and a pale one on white with nothing theme-specific in
 *     the code.
 *
 * The rule and the light weight are measured, not invented. Sampling the live
 * TradingView canvas in light mode (BINANCE:BTCUSDT, `getImageData` over the
 * volume band) returns rgb(131,204,192) as the dominant bar colour, which is
 * exactly their up colour `#089981` at 0.5 over white — and `#089981` is
 * already this product's measured `--ts-positive` for light. The dark weight
 * is 0.28 because that reproduces the previous hand-picked `#1c3a30` to
 * within a shade (`#184030`) while putting both directions on one footing;
 * the old pair did not, being 0.25 on the green and 0.19 on the red.
 */
export const CHART_VOLUME_ALPHA_DARK = 0.28;

/**
 * `#abc` and `#aabbcc` are the same colour, and both reach this file.
 *
 * The tokens are AUTHORED six-digit in `app/globals.css`, but what
 * `getComputedStyle` hands back is whatever survived the CSS pipeline, and
 * that shortens `#ffffff` to `#fff`. A six-digit-only guard here does not
 * throw — it returns the colour unmixed, which in light mode means a full
 * strength volume bar and looks like the bug this was written to fix.
 */
function expand(hex: string): string | null {
  const value = hex.trim();
  if (/^#[0-9a-f]{6}$/i.test(value)) return value;
  if (/^#[0-9a-f]{3}$/i.test(value)) {
    return `#${value.slice(1).split("").map((c) => c + c).join("")}`;
  }
  return null;
}

function channel(hex: string, at: number): number {
  return parseInt(hex.slice(at, at + 2), 16);
}

/** `color` sunk toward `surface`; `alpha` is how much of `color` survives. */
export function mixToward(color: string, surface: string, alpha: number): string {
  const from = expand(color);
  const to = expand(surface);
  if (from === null || to === null) return color;
  const weight = Math.max(0, Math.min(1, alpha));
  const mixed = [1, 3, 5].map((at) => {
    const value = channel(to, at) + (channel(from, at) - channel(to, at)) * weight;
    return Math.round(value).toString(16).padStart(2, "0");
  });
  return `#${mixed.join("")}`;
}

/**
 * The volume colour pair for the current theme and the current chart colours.
 *
 * Resolved once per data pass rather than once per bar: a full series is ten
 * thousand candles and `getComputedStyle` is not free.
 */
export function volumePalette(up: string, down: string): (open: number, close: number) => string {
  const surface = cssToken("--ts-surface", CHART_SURFACE);
  const alpha = Number(cssToken("--ts-chart-volume-alpha", String(CHART_VOLUME_ALPHA_DARK)));
  const weight = Number.isFinite(alpha) ? alpha : CHART_VOLUME_ALPHA_DARK;
  const upBar = mixToward(up, surface, weight);
  const downBar = mixToward(down, surface, weight);
  return (open, close) => (close >= open ? upBar : downBar);
}

/** The neutral a histogram falls back to before any direction is known. */
export function chartMuted(): string {
  return cssToken("--ts-chart-muted", CHART_MUTED);
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
      fontSize: 12,
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
