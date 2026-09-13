/**
 * Preferences owned by one chart pane and persisted with the workspace.
 *
 * ── Why this grew, and what the rule for growing it is ─────────────────────
 *
 * TVP7 compared this against the live TradingView chart-settings dialog, tab
 * by tab and scroll state by scroll state, rather than by counting sidebar
 * labels. The seven labels matched. Behind them were eleven controls — seven
 * booleans, one number, and a Symbol tab that was a read-only `<dl>` printing
 * `instrument:v1:BINANCE:spot:BTC:USDT:USDT:spot` at the user. The reference
 * has around seventy.
 *
 * The rule applied here is NOT "add a switch for every switch TradingView
 * has". It is: a control belongs in this model when the engine already
 * underneath this chart can honour it, and the pane can persist it. Every
 * field below is backed by a lightweight-charts option or by markup this
 * product already renders, and `CandleChart` applies each one. Nothing here is
 * a switch that does nothing — the campaign's own standard, and the reason
 * `lockPriceToBarRatio` and `noOverlappingLabels` are absent: lightweight-
 * charts 4.2 exposes no equivalent, so offering them would be a lie.
 */

/** How many digits a price is drawn to; `auto` follows the instrument's tick. */
export type PricePrecision = "auto" | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/** Which side of the plot the price axis is drawn on. */
export type ScalePlacement = "right" | "left" | "both" | "none";

export interface ChartSettings {
  // ── Series appearance (the reference's "Symbol" tab) ──────────────────────
  /** Candle bodies are filled; off draws them hollow. */
  candleBody: boolean;
  /** Candle borders. */
  candleBorders: boolean;
  /** Candle wicks. */
  candleWicks: boolean;
  /** Up colour, as a hex literal — a canvas cannot read a custom property. */
  upColor: string;
  /** Down colour, as a hex literal. */
  downColor: string;
  /** Price precision, or `auto` to follow the instrument's tick size. */
  precision: PricePrecision;

  // ── Status line ───────────────────────────────────────────────────────────
  /** The instrument/OHLC readout over the plot, as a whole. */
  showStatusLine: boolean;
  /** The instrument name and interval within it. */
  statusSymbol: boolean;
  /** O/H/L/C values within it. */
  statusOhlc: boolean;
  /** The bar's absolute and percentage change. */
  statusBarChange: boolean;
  /** The bar's volume. */
  statusVolume: boolean;
  /** Indicator names and values in the legend below it. */
  statusIndicatorValues: boolean;

  // ── Scales and lines ──────────────────────────────────────────────────────
  scalePlacement: ScalePlacement;
  /** 24-hour axis labels; off is 12-hour with am/pm. */
  timeFormat24h: boolean;

  // ── Canvas ────────────────────────────────────────────────────────────────
  /** Vertical grid lines. */
  gridVertical: boolean;
  /** Horizontal grid lines. */
  gridHorizontal: boolean;
  /** Lightweight-charts crosshair. */
  showCrosshair: boolean;
  /** Axis label size in px. */
  scaleFontSize: number;
  /** Empty space above the highest bar, as a percentage of pane height. */
  marginTopPct: number;
  /** Empty space below the lowest bar, as a percentage of pane height. */
  marginBottomPct: number;
  /** Empty bars kept to the right of the newest bar. */
  rightOffsetBars: number;

  // ── Overlays ──────────────────────────────────────────────────────────────
  /** Paper/trading position and order decorations. */
  showTrading: boolean;
  /** Fired-alert markers recorded by the alert runner. */
  showAlerts: boolean;
  /** Strategy, script and pattern event markers. */
  showEvents: boolean;

  // ── Chart-type parameters ─────────────────────────────────────────────────
  /**
   * Range chart size, in provider ticks.
   *
   * This lived under "Canvas", which is where TVP7 found it: a parameter of
   * one CHART TYPE filed under a tab about the drawing surface, so it was
   * present and visible on every chart including the twenty that ignore it.
   * The reference files a chart type's own parameters under the tab that names
   * the chart type, and so does the dialog now.
   */
  rangeTicks: number;
}

export const DEFAULT_CHART_SETTINGS: ChartSettings = {
  candleBody: true,
  candleBorders: true,
  candleWicks: true,
  upColor: "#2ebd85",
  downColor: "#f6465d",
  precision: "auto",

  showStatusLine: true,
  statusSymbol: true,
  statusOhlc: true,
  statusBarChange: true,
  statusVolume: true,
  statusIndicatorValues: true,

  scalePlacement: "right",
  timeFormat24h: true,

  gridVertical: true,
  gridHorizontal: true,
  showCrosshair: true,
  scaleFontSize: 12,
  marginTopPct: 10,
  marginBottomPct: 8,
  rightOffsetBars: 5,

  showTrading: true,
  showAlerts: true,
  showEvents: true,

  rangeTicks: 20,
};

const PRECISIONS: readonly PricePrecision[] = ["auto", 0, 1, 2, 3, 4, 5, 6, 7, 8];
const PLACEMENTS: readonly ScalePlacement[] = ["right", "left", "both", "none"];
const HEX = /^#[0-9a-fA-F]{6}$/;

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function num(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

/**
 * Read stored settings, defaulting anything absent or malformed.
 *
 * A workspace saved before this shape existed carries `showGrid`, one switch
 * for both grid directions. It seeds BOTH of the two that replaced it, so a
 * user who had turned the grid off does not find it back on after an update —
 * which is the only kind of migration failure this file can cause.
 */
export function normalizeChartSettings(raw: unknown): ChartSettings {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_CHART_SETTINGS };
  const value = raw as Partial<ChartSettings> & { showGrid?: unknown };
  const legacyGrid = bool(value.showGrid, true);
  const precision = PRECISIONS.includes(value.precision as PricePrecision)
    ? value.precision as PricePrecision : "auto";
  return {
    candleBody: bool(value.candleBody, true),
    candleBorders: bool(value.candleBorders, true),
    candleWicks: bool(value.candleWicks, true),
    upColor: typeof value.upColor === "string" && HEX.test(value.upColor)
      ? value.upColor : DEFAULT_CHART_SETTINGS.upColor,
    downColor: typeof value.downColor === "string" && HEX.test(value.downColor)
      ? value.downColor : DEFAULT_CHART_SETTINGS.downColor,
    precision,

    showStatusLine: bool(value.showStatusLine, true),
    statusSymbol: bool(value.statusSymbol, true),
    statusOhlc: bool(value.statusOhlc, true),
    statusBarChange: bool(value.statusBarChange, true),
    statusVolume: bool(value.statusVolume, true),
    statusIndicatorValues: bool(value.statusIndicatorValues, true),

    scalePlacement: PLACEMENTS.includes(value.scalePlacement as ScalePlacement)
      ? value.scalePlacement as ScalePlacement : "right",
    timeFormat24h: bool(value.timeFormat24h, true),

    gridVertical: bool(value.gridVertical, legacyGrid),
    gridHorizontal: bool(value.gridHorizontal, legacyGrid),
    showCrosshair: bool(value.showCrosshair, true),
    scaleFontSize: Math.round(num(value.scaleFontSize, 12, 8, 20)),
    marginTopPct: Math.round(num(value.marginTopPct, 10, 0, 50)),
    marginBottomPct: Math.round(num(value.marginBottomPct, 8, 0, 50)),
    rightOffsetBars: Math.round(num(value.rightOffsetBars, 5, 0, 200)),

    showTrading: bool(value.showTrading, true),
    showAlerts: bool(value.showAlerts, true),
    showEvents: bool(value.showEvents, true),

    rangeTicks: typeof value.rangeTicks === "number" && Number.isFinite(value.rangeTicks)
      && value.rangeTicks >= 1 ? Math.min(10000, Math.round(value.rangeTicks)) : 20,
  };
}

export function isDefaultChartSettings(value: ChartSettings): boolean {
  return (Object.keys(DEFAULT_CHART_SETTINGS) as (keyof ChartSettings)[])
    .every((key) => value[key] === DEFAULT_CHART_SETTINGS[key]);
}

/** The label a precision choice carries in the dialog. */
export function precisionLabel(value: PricePrecision): string {
  return value === "auto" ? "Default" : value === 0 ? "1" : `0.${"0".repeat(value - 1)}1`;
}

export { PRECISIONS, PLACEMENTS };
