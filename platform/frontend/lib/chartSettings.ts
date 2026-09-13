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

/** A line's dash pattern, in the reference's own vocabulary. */
export type LineStyleName = "solid" | "dotted" | "dashed";

/** How the axis writes a date. */
export type DateFormatName = "dd MMM yy" | "MMM dd, yyyy" | "yyyy-MM-dd" | "dd/MM/yyyy" | "MM/dd/yyyy";
export const DATE_FORMATS: readonly DateFormatName[] = [
  "dd MMM yy", "MMM dd, yyyy", "yyyy-MM-dd", "dd/MM/yyyy", "MM/dd/yyyy",
];

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
  /**
   * TVP8: the tab literally named "Scales and lines" contained no line
   * controls at all — seven of them, and every one was a scale. These are the
   * lines it is named for, and each is a lightweight-charts 4.2 series or
   * chart option, so none of them is a switch that does nothing.
   */
  /** The dashed line at the last price, running back across the plot. */
  lastValueLine: boolean;
  lastValueLineColor: string;
  lastValueLineWidth: number;
  lastValueLineStyle: LineStyleName;
  /** The price tag on the scale itself. */
  lastValueLabel: boolean;
  /** How the time axis writes a date. */
  dateFormat: DateFormatName;

  // ── Canvas ────────────────────────────────────────────────────────────────
  /** Vertical grid lines. */
  gridVertical: boolean;
  /** Horizontal grid lines. */
  gridHorizontal: boolean;
  /** TVP8: the grid had a pair of on/off switches and no appearance at all. */
  gridColor: string;
  gridStyle: LineStyleName;
  /** Lightweight-charts crosshair. */
  showCrosshair: boolean;
  /** TVP8: same — visible or not, and nothing else. */
  crosshairColor: string;
  crosshairWidth: number;
  crosshairStyle: LineStyleName;
  /**
   * TVP8: the instrument's name behind the bars, as the reference draws it.
   *
   * Off by default. It is the one canvas control that changes what a
   * SCREENSHOT of this chart says it is, which is most of what it is for.
   */
  watermark: boolean;
  /** Solid ground, or the reference's vertical gradient. */
  backgroundGradient: boolean;
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

  /**
   * The four display transforms' own parameters.
   *
   * These were constants baked into the chart-type token, on the reasoning
   * that "the token IS the parameter set" — which is a coherent design right
   * up until a user wants a 20-brick Renko. `chartTransforms` already accepts
   * every one of them as an argument; only the path from a control to the
   * call was missing. The reference exposes all four.
   */
  renkoAtrPeriod: number;
  lineBreakLines: number;
  kagiReversalPercent: number;
  pnfBoxPercent: number;
  pnfReversalBoxes: number;

  /**
   * Session Volume Profile and TPO, which had no settings at all.
   *
   * `VolumeProfileSettings` already carries every one of these and
   * `VolumeProfileLayer` already branches on them — `side`, `split`,
   * `showPoc`, `widthRatio`, `valueAreaPercent`, `rowSize`, `allocation` — so
   * the renderer was fully parameterised and the pane passed it literals.
   *
   * The asymmetry that made this obvious: the DRAWING-based Fixed Range Volume
   * Profile has a five-control quick bar for rows, value-area %, split, side
   * and POC. The CHART-TYPE profiles, reading the same type through the same
   * function, offered none of it.
   */
  profileRows: number;
  profileValueAreaPercent: number;
  /** Volume spread across a bar's whole range, or all of it at the close. */
  profileAllocation: "range" | "close";
  /** Which side of the plot the profile is drawn from. */
  profileSide: "left" | "right";
  /** One total bar per row, or up and down volume split apart. */
  profileSplit: "total" | "upDown";
  profileShowPoc: boolean;
  profileShowValueArea: boolean;
  /** How far across the plot the widest row reaches, in percent. */
  profileWidthPercent: number;
  /** TPO letter-block duration in minutes. */
  tpoBlockMinutes: number;
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
  lastValueLine: true,
  lastValueLineColor: "#758696",
  lastValueLineWidth: 1,
  lastValueLineStyle: "dashed",
  lastValueLabel: true,
  dateFormat: "dd MMM yy",

  gridVertical: true,
  gridHorizontal: true,
  gridColor: "",
  gridStyle: "solid",
  showCrosshair: true,
  crosshairColor: "",
  crosshairWidth: 1,
  crosshairStyle: "dashed",
  watermark: false,
  backgroundGradient: false,
  scaleFontSize: 12,
  marginTopPct: 10,
  marginBottomPct: 8,
  rightOffsetBars: 5,

  showTrading: true,
  showAlerts: true,
  showEvents: true,

  rangeTicks: 20,

  renkoAtrPeriod: 14,
  lineBreakLines: 3,
  kagiReversalPercent: 1,
  pnfBoxPercent: 1,
  pnfReversalBoxes: 3,

  profileRows: 24,
  profileValueAreaPercent: 70,
  profileAllocation: "range",
  profileSide: "right",
  profileSplit: "total",
  profileShowPoc: true,
  profileShowValueArea: true,
  profileWidthPercent: 30,
  tpoBlockMinutes: 30,
};

const PRECISIONS: readonly PricePrecision[] = ["auto", 0, 1, 2, 3, 4, 5, 6, 7, 8];
const PLACEMENTS: readonly ScalePlacement[] = ["right", "left", "both", "none"];
const HEX = /^#[0-9a-fA-F]{6}$/;

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

const LINE_STYLES: readonly LineStyleName[] = ["solid", "dotted", "dashed"];

function lineStyle(value: unknown, fallback: LineStyleName): LineStyleName {
  return LINE_STYLES.includes(value as LineStyleName) ? value as LineStyleName : fallback;
}

/** A hex colour, or the fallback. `""` is a legal value meaning "the theme's". */
function hex(value: unknown, fallback: string): string {
  if (value === "") return "";
  return typeof value === "string" && HEX.test(value) ? value : fallback;
}

function num(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

/*
 * ── TVP8: defaults and templates ───────────────────────────────────────────
 *
 * The reference's chart-settings dialog has a "Template" dropdown and a
 * "Defaults" button (Save as default / Reset settings) in its footer. This
 * dialog had Cancel and Ok, and was the only settings dialog in the product
 * without a Defaults — `StrategySettingsModal` and `NativeStudySettings` both
 * have one.
 *
 * A per-user default matters more here than it looks. Every new pane starts
 * from `DEFAULT_CHART_SETTINGS`, so a trader who wants a 3px crosshair and no
 * grid was re-setting it on every pane they opened, for ever.
 */
export const CHART_SETTINGS_DEFAULT_KEY = "tv.chartSettings.default";
export const CHART_SETTINGS_TEMPLATES_KEY = "tv.chartSettings.templates.v1";

export interface ChartSettingsTemplate {
  name: string;
  settings: ChartSettings;
}

/** The user's own default, or the product's when they have not saved one. */
export function userDefaultChartSettings(): ChartSettings {
  if (typeof window === "undefined") return { ...DEFAULT_CHART_SETTINGS };
  try {
    const raw = window.localStorage.getItem(CHART_SETTINGS_DEFAULT_KEY);
    if (raw === null) return { ...DEFAULT_CHART_SETTINGS };
    return normalizeChartSettings(JSON.parse(raw));
  } catch { return { ...DEFAULT_CHART_SETTINGS }; }
}

export function saveUserDefaultChartSettings(settings: ChartSettings): void {
  try {
    window.localStorage.setItem(CHART_SETTINGS_DEFAULT_KEY, JSON.stringify(settings));
  } catch { /* private window: the settings still apply, they just do not persist */ }
}

export function clearUserDefaultChartSettings(): void {
  try { window.localStorage.removeItem(CHART_SETTINGS_DEFAULT_KEY); }
  catch { /* nothing to clear */ }
}

export function loadChartSettingsTemplates(): ChartSettingsTemplate[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(CHART_SETTINGS_TEMPLATES_KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((row): ChartSettingsTemplate[] => {
      const r = row as { name?: unknown; settings?: unknown };
      return typeof r.name === "string" && r.name.trim() !== ""
        ? [{ name: r.name, settings: normalizeChartSettings(r.settings) }]
        : [];
    });
  } catch { return []; }
}

/** Upsert by name, so saving over a template replaces it rather than doubling it. */
export function saveChartSettingsTemplate(
  templates: readonly ChartSettingsTemplate[], name: string, settings: ChartSettings,
): ChartSettingsTemplate[] {
  const trimmed = name.trim();
  const without = templates.filter((t) => t.name !== trimmed);
  const next = [...without, { name: trimmed, settings }]
    .sort((a, b) => a.name.localeCompare(b.name));
  try {
    window.localStorage.setItem(CHART_SETTINGS_TEMPLATES_KEY, JSON.stringify(next));
  } catch { /* private window */ }
  return next;
}

export function deleteChartSettingsTemplate(
  templates: readonly ChartSettingsTemplate[], name: string,
): ChartSettingsTemplate[] {
  const next = templates.filter((t) => t.name !== name);
  try {
    window.localStorage.setItem(CHART_SETTINGS_TEMPLATES_KEY, JSON.stringify(next));
  } catch { /* private window */ }
  return next;
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
    lastValueLine: bool(value.lastValueLine, true),
    lastValueLineColor: hex(value.lastValueLineColor, DEFAULT_CHART_SETTINGS.lastValueLineColor),
    lastValueLineWidth: Math.round(num(value.lastValueLineWidth, 1, 1, 4)),
    lastValueLineStyle: lineStyle(value.lastValueLineStyle, "dashed"),
    lastValueLabel: bool(value.lastValueLabel, true),
    dateFormat: DATE_FORMATS.includes(value.dateFormat as DateFormatName)
      ? value.dateFormat as DateFormatName : "dd MMM yy",

    gridVertical: bool(value.gridVertical, legacyGrid),
    gridHorizontal: bool(value.gridHorizontal, legacyGrid),
    // Empty means "the theme's own", which is what every chart had before
    // these controls existed and what Reset returns them to.
    gridColor: hex(value.gridColor, ""),
    gridStyle: lineStyle(value.gridStyle, "solid"),
    showCrosshair: bool(value.showCrosshair, true),
    crosshairColor: hex(value.crosshairColor, ""),
    crosshairWidth: Math.round(num(value.crosshairWidth, 1, 1, 4)),
    crosshairStyle: lineStyle(value.crosshairStyle, "dashed"),
    watermark: bool(value.watermark, false),
    backgroundGradient: bool(value.backgroundGradient, false),
    scaleFontSize: Math.round(num(value.scaleFontSize, 12, 8, 20)),
    marginTopPct: Math.round(num(value.marginTopPct, 10, 0, 50)),
    marginBottomPct: Math.round(num(value.marginBottomPct, 8, 0, 50)),
    rightOffsetBars: Math.round(num(value.rightOffsetBars, 5, 0, 200)),

    showTrading: bool(value.showTrading, true),
    showAlerts: bool(value.showAlerts, true),
    showEvents: bool(value.showEvents, true),

    rangeTicks: typeof value.rangeTicks === "number" && Number.isFinite(value.rangeTicks)
      && value.rangeTicks >= 1 ? Math.min(10000, Math.round(value.rangeTicks)) : 20,

    renkoAtrPeriod: Math.round(num(value.renkoAtrPeriod, 14, 2, 200)),
    lineBreakLines: Math.round(num(value.lineBreakLines, 3, 2, 10)),
    // A reversal percentage, so it keeps a decimal; the others are counts.
    kagiReversalPercent: Math.round(num(value.kagiReversalPercent, 1, 0.1, 50) * 10) / 10,
    pnfBoxPercent: Math.round(num(value.pnfBoxPercent, 1, 0.1, 50) * 10) / 10,
    pnfReversalBoxes: Math.round(num(value.pnfReversalBoxes, 3, 1, 10)),

    // Bounds mirror MIN_ROWS/MAX_ROWS and MIN_VALUE_AREA/MAX_VALUE_AREA in
    // `lib/volumeProfile`, which is what actually enforces them downstream.
    profileRows: Math.round(num(value.profileRows, 24, 4, 400)),
    profileValueAreaPercent: Math.round(num(value.profileValueAreaPercent, 70, 30, 100)),
    profileAllocation: value.profileAllocation === "close" ? "close" : "range",
    profileSide: value.profileSide === "left" ? "left" : "right",
    profileSplit: value.profileSplit === "upDown" ? "upDown" : "total",
    profileShowPoc: bool(value.profileShowPoc, true),
    profileShowValueArea: bool(value.profileShowValueArea, true),
    profileWidthPercent: Math.round(num(value.profileWidthPercent, 30, 5, 90)),
    tpoBlockMinutes: Math.round(num(value.tpoBlockMinutes, 30, 1, 1440)),
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
