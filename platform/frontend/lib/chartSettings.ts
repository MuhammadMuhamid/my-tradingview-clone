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

/**
 * What the watermark behind the bars is for.
 *
 * R6 (TVP8): the reference's Canvas tab has a `Watermark` DROPDOWN, not a
 * checkbox — hidden, the instrument's own name, or "replay mode", which draws
 * it only while the pane is replaying history, so a screenshot taken during a
 * replay says so. The boolean that came before it migrates in
 * `normalizeChartSettings`: `true → "symbol"`, `false → "hidden"`.
 */
export type WatermarkMode = "hidden" | "symbol" | "replay";

/** When the axis-foot `log % auto reset` strip is drawn. */
export type ScaleButtonsMode = "hover" | "always" | "hidden";

/** IANA zone used only to format chart labels; candle timestamps never move. */
export type ChartTimeZone = "UTC" | "America/New_York" | "Europe/London" | "Asia/Karachi" | "Asia/Tokyo";

/** Whether an auxiliary price is absent, an axis value, or a value plus line. */
export type AuxiliaryPriceLineMode = "hidden" | "value" | "line";

/** Whether the pane draws the ticker's bid and ask as price lines. */
export type BidAskLines = "hidden" | "line";

/**
 * Which form of the instrument's name the status line carries.
 *
 * ── R3b-25: the reference's three forms, on the two stored values ──────────
 *
 * TradingView offers `Name` / `Ticker` / `Description`; this offered `Name` /
 * `Full symbol`, and `Full symbol` printed `BINANCE:BTC/USDT · SPOT` — a form
 * the reference does not have and that §5 keeps out of primary copy anyway.
 *
 * The LITERALS are unchanged so that every workspace already on disk, and the
 * pane that forwards them, keep working: `ticker` is still the descriptive
 * NAME (which is what it has always rendered), `symbol` is now the TICKER
 * (`BTCUSDT`) instead of the qualified id, and `description` is new. A stored
 * `symbol` therefore stops printing a canonical-looking string and starts
 * printing what the reference's second option prints, which is the repair.
 */
export type StatusTitleForm = "ticker" | "symbol" | "description";

/** The three `Title` options, in the reference's order. */
export const STATUS_TITLE_FORMS: readonly StatusTitleForm[] = ["ticker", "symbol", "description"];

export interface ChartSettings {
  // ── Series appearance (the reference's "Symbol" tab) ──────────────────────
  /** Candle bodies are filled; off draws them hollow. */
  candleBody: boolean;
  /** Candle borders. */
  candleBorders: boolean;
  /** Candle wicks. */
  candleWicks: boolean;
  /** Direction is close versus the preceding close, rather than open. */
  colorBarsBasedOnPreviousClose: boolean;
  /**
   * Bars drawn at one pixel, whatever the zoom.
   *
   * The reference's Symbol tab offers this for its Bars chart and this product
   * did not — it shipped the library's `thinBars: false`, which widens every
   * bar with the bar spacing, so a zoomed-in Bars chart here was a row of fat
   * ticks where the reference's stays hairline. It only reaches the Bars
   * series; nothing else in the registry has a thickness to thin.
   */
  thinBars: boolean;
  /** Up colour, as a hex literal — a canvas cannot read a custom property. */
  upColor: string;
  /** Down colour, as a hex literal. */
  downColor: string;
  /**
   * R6 S-2: a colour pair per candle COMPONENT, as the reference has.
   *
   * The dialog offered `Body`, `Borders` and `Wick` as three bare checkboxes
   * and then one shared `Up / down` pair below them, so a border could be
   * turned off but never coloured — while lightweight-charts 4.2's candlestick
   * series has carried `borderUpColor` / `borderDownColor` / `wickUpColor` /
   * `wickDownColor` the whole time. Absent from a stored workspace these
   * default to `upColor` / `downColor`, which is exactly what the chart drew
   * before they existed, so nobody's chart changes on the update.
   */
  borderUpColor: string;
  borderDownColor: string;
  wickUpColor: string;
  wickDownColor: string;
  /** Price precision, or `auto` to follow the instrument's tick size. */
  precision: PricePrecision;

  // ── Status line ───────────────────────────────────────────────────────────
  /** The instrument/OHLC readout over the plot, as a whole. */
  showStatusLine: boolean;
  /** The instrument name and interval within it. */
  statusSymbol: boolean;
  /**
   * R6 SL-2: which form of the name, since the product has two.
   *
   * `displayTicker` gives `BTCUSDT`, `displaySymbol` gives
   * `BINANCE:BTC/USDT · SPOT`. The legend hard-coded the first. Contract §5
   * keeps the ticker as the default — this is an opt-in to the longer form,
   * not a licence to print a canonical `instrument:v1:…` id anywhere.
   */
  statusTitle: StatusTitleForm;
  /**
   * R3b-24: the instrument's own mark before the name.
   *
   * The reference draws a 24px logo there and has a `Logo` row for it. Ours is
   * the product's own asset disc (`instrumentMark`), because we ship no
   * third-party marks — the shape of the row is the reference's, the artwork
   * is this product's.
   */
  statusLogo: boolean;
  /**
   * R3b-24: the market-status dot after the venue.
   *
   * Green while the instrument's market is open. Absent — not grey, and not
   * green — for an instrument whose session calendar this build does not hold,
   * because a dot that guessed would be a light on a closed market.
   */
  statusMarketStatus: boolean;
  /** O/H/L/C values within it. */
  statusOhlc: boolean;
  /** The bar's absolute and percentage change. */
  statusBarChange: boolean;
  /** The bar's volume. */
  statusVolume: boolean;
  /**
   * R6 SL-3: the instrument's 24h change, which the quote contract carries.
   *
   * Off by default, as the reference's `Last day change values` is. When the
   * feed has no 24h figure for this instrument the legend renders nothing —
   * not a dash, which would read as "zero".
   */
  statusDayChange: boolean;
  /**
   * R6 SL-1: the legend already draws three separable things.
   *
   * `statusIndicatorValues` used to gate the whole `IndicatorLegend`, so one
   * switch hid a study's title, its inputs (`Length 14 · Source close`) and its
   * values together. The reference has three rows; so does this, and a
   * workspace stored with the single key seeds all three (see
   * `normalizeChartSettings`).
   */
  statusIndicatorTitles: boolean;
  /** Dependent on titles: the inputs printed after a study's name. */
  statusIndicatorInputs: boolean;
  /** Indicator values in the legend below the status line. */
  statusIndicatorValues: boolean;
  /**
   * R3b-25: the translucent plate behind every legend text run.
   *
   * The reference's `Background` row, default on with an opacity slider. The
   * legend sits on the candles, and at the crosshair a run of numbers over a
   * dense green candle is unreadable without it. It is a fill behind the TEXT
   * runs, not a box around the legend — the box is the thing R3-10 removed.
   */
  statusLegendBackground: boolean;
  /** How opaque that plate is, 0–100. The reference's default reads ~60. */
  statusLegendBackgroundOpacity: number;

  // ── Scales and lines ──────────────────────────────────────────────────────
  scalePlacement: ScalePlacement;
  /** 24-hour axis labels; off is 12-hour with am/pm. */
  timeFormat24h: boolean;
  /** Display zone for the axis and the live clock; data remains epoch UTC. */
  timeZone: ChartTimeZone;
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
  /**
   * R6 SC-2: whether the axis-foot `log % auto reset` strip is drawn.
   *
   * The reference's `Scale modes (A and L)` row is about the VISIBILITY of the
   * axis buttons, not about the modes themselves. `hover` is this product's
   * behaviour today and the reference's own default, so a stored workspace
   * that has never seen this control looks exactly as it did.
   */
  scaleButtons: ScaleButtonsMode;
  /**
   * R6 SC-3: the price tag on the scale for study and overlay series.
   *
   * ANDed into the `lastValueVisible` the pane already computes from pane
   * density, so turning it off is absolute and turning it on does not override
   * the density rule that keeps a crowded pane readable.
   */
  indicatorLastValue: boolean;
  /**
   * R6 SC-4: bid and ask as price lines.
   *
   * The canonical ticker event carries `bid` / `ask`, and `createPriceLine` is
   * already how the pane draws trading levels. The ROW only appears once the
   * pane's ticker has actually reported a bid and an ask, so a provider
   * without quotes never gets a control that cannot move.
   */
  bidAskLines: BidAskLines;
  bidColor: string;
  askColor: string;
  /**
   * R6 SC-5(d): `Mon` before the date on a day-boundary tick label.
   *
   * The reference has it on by default. `CandleChart` already supplies a
   * `tickMarkFormatter`, so this is a branch inside a function that exists.
   */
  dayOfWeekOnLabels: boolean;
  noOverlappingLabels: boolean;
  plusButton: boolean;
  countdownToBarClose: boolean;
  previousDayClose: AuxiliaryPriceLineMode;
  previousDayCloseColor: string;
  highLow: AuxiliaryPriceLineMode;
  highLowColor: string;

  // ── Canvas ────────────────────────────────────────────────────────────────
  /** Vertical grid lines. */
  gridVertical: boolean;
  /** Horizontal grid lines. */
  gridHorizontal: boolean;
  /**
   * TVP8: the grid had a pair of on/off switches and no appearance at all.
   *
   * ── R6 C-1: one appearance for two directions was one too few ────────────
   *
   * These two are the SHARED pair, and they are what `CandleChart` still
   * applies to both `vertLines` and `horzLines`. The reference gives each
   * direction its own line-style button, and lightweight-charts has always
   * accepted two independent sets, so `gridVertColor` / `gridVertStyle` /
   * `gridHorzColor` / `gridHorzStyle` below are what the dialog writes now.
   * The shared pair stays until the apply site reads the new four (it is the
   * seed the new four migrate from, so deleting it would lose a pinned grid
   * colour on the next reload).
   */
  gridColor: string;
  gridStyle: LineStyleName;
  /** R6 C-1: the vertical grid's own colour (`""` = the theme's) and style. */
  gridVertColor: string;
  gridVertStyle: LineStyleName;
  /** R6 C-1: the horizontal grid's own colour and style. */
  gridHorzColor: string;
  gridHorzStyle: LineStyleName;
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
  /**
   * R6 C-2: the watermark is a MODE, not a switch.
   *
   * ── Why this is not simply `watermark` retyped ───────────────────────────
   *
   * It will be. `CandleChart.tsx:1214` reads `visible: settings.watermark` as
   * a boolean, and that file belongs to another change in flight; retyping the
   * key underneath it would not only fail `tsc`, it would make every chart in
   * the product draw a watermark, because `"hidden"` is a truthy string. So
   * the mode is the value the dialog writes and the boolean is kept in step
   * beside it (`mode === "symbol"`), and the apply-site change collapses the
   * two into one key named `watermark`.
   */
  watermarkMode: WatermarkMode;
  /** R6 C-2: the watermark's colour; `""` is the theme's own. */
  watermarkColor: string;
  /** Solid ground, or the reference's vertical gradient. */
  backgroundGradient: boolean;
  /** R6 C-2: the ground's colour; `""` is the theme's own. */
  backgroundColor: string;
  /**
   * R6b-18: the gradient's SECOND well, which the reference draws beside the
   * first the moment `Gradient` is chosen and this dialog did not have.
   *
   * `""` is the theme's own, in both wells, and that pair must still be a
   * VISIBLE wash — the previous answer was 6% of accent blue over transparent,
   * measured at three points of luminance across the whole plot, i.e. a
   * dropdown option that moved nothing. `resolveBackgroundGradient` is where
   * the theme pair is derived, and `tests/chartSettings.test.ts` pins that the
   * two ends differ.
   */
  backgroundColor2: string;
  /** Axis label size in px. */
  scaleFontSize: number;
  /** R6 C-4: axis text colour (`layout.textColor`); `""` is the theme's own. */
  scaleTextColor: string;
  /** R6 C-4: the price and time scale border colour; `""` is the theme's own. */
  scaleLineColor: string;
  paneSeparatorColor: string;
  /** Visibility of the study-pane hover controls. */
  paneButtons: ScaleButtonsMode;
  /** Empty space above the highest bar, as a percentage of pane height. */
  marginTopPct: number;
  /** Empty space below the lowest bar, as a percentage of pane height. */
  marginBottomPct: number;
  /** Empty bars kept to the right of the newest bar. */
  rightOffsetBars: number;

  // ── Overlays ──────────────────────────────────────────────────────────────
  /** Position and order price lines. */
  showTrading: boolean;
  /**
   * R6 T-2: the unrealised P&L on a position's own line.
   *
   * Implemented rather than omitted because `ManualPosition` (`lib/api.ts`)
   * already carries `pnlUsdt` and `pnlPct` — the line's title has the number to
   * print. There are deliberately no Money / Pips / % sub-rows: the ticket
   * reports in money and a pip has no meaning on a crypto pair.
   */
  showPnlValue: boolean;
  /**
   * R6 T-1: execution marks, which were gated under `showTrading` with the
   * price lines even though they are a different thing on the chart.
   */
  showExecutionMarks: boolean;
  /** Dependent on marks: the `BUY 77,600` text beside each one. */
  showExecutionLabels: boolean;
  /**
   * R6 A-1: a price line per fixed-price alert on this instrument.
   *
   * Coloured per alert by `alertColor(a)` rather than from one swatch — the
   * product's alerts already carry their own colour, and one dialog colour for
   * all of them would be less truthful than what is drawn. Alerts stated
   * relative to a moving average or a band have no single price and are
   * skipped.
   */
  showAlertLines: boolean;
  /** Dependent on alert lines: `isAlertActive` filters the armed ones. */
  onlyActiveAlerts: boolean;
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
  colorBarsBasedOnPreviousClose: false,
  // The library's own default, and the reference's: a Bars chart is hairline
  // until somebody asks for otherwise.
  thinBars: true,
  upColor: "#2ebd85",
  downColor: "#f6465d",
  // The same two colours: a border and a wick follow the body until somebody
  // says otherwise, which is what the chart drew before these keys existed.
  borderUpColor: "#2ebd85",
  borderDownColor: "#f6465d",
  wickUpColor: "#2ebd85",
  wickDownColor: "#f6465d",
  precision: "auto",

  showStatusLine: true,
  statusSymbol: true,
  statusTitle: "ticker",
  // R3b-24: the reference draws both before anybody chooses.
  statusLogo: true,
  statusMarketStatus: true,
  statusOhlc: true,
  statusBarChange: true,
  /*
   * R3-14: off by default, because the reference's status line is.
   *
   * `Vol 898.81` rode at the end of every OHLC row — a number the reference
   * does not show there at all, in the one line of the chart that must read at
   * a glance. It stays a Status-line switch for anyone who wants it; what
   * changed is which way it points before anybody has chosen.
   */
  statusVolume: false,
  // The reference's `Last day change values` is off before anybody chooses.
  statusDayChange: false,
  statusIndicatorTitles: true,
  statusIndicatorInputs: true,
  statusIndicatorValues: true,
  statusLegendBackground: true,
  statusLegendBackgroundOpacity: 60,

  scalePlacement: "right",
  timeFormat24h: true,
  timeZone: "UTC",
  lastValueLine: true,
  lastValueLineColor: "#758696",
  lastValueLineWidth: 1,
  lastValueLineStyle: "dashed",
  lastValueLabel: true,
  dateFormat: "dd MMM yy",
  /*
   * `hover` — which is what this product does today AND what the reference's
   * own row says (`Visible on mouse over`).
   *
   * R6's prompt guessed `always`, but TVP8 R1-11 deliberately took the
   * permanent `log % auto reset` group off the bottom row and put it on the
   * axis, revealed on hover. Defaulting the new control to `always` would
   * have relit that group on every chart in the product on the update that
   * added a way to turn it off, which is the opposite of what the control is
   * for. `always` and `hidden` are the two things a user can now ask for.
   */
  scaleButtons: "hover",
  indicatorLastValue: true,
  bidAskLines: "hidden",
  bidColor: "#2ebd85",
  askColor: "#f6465d",
  dayOfWeekOnLabels: true,
  noOverlappingLabels: true,
  plusButton: true,
  countdownToBarClose: true,
  previousDayClose: "hidden",
  previousDayCloseColor: "#758696",
  highLow: "hidden",
  highLowColor: "#758696",

  gridVertical: true,
  gridHorizontal: true,
  gridColor: "",
  gridStyle: "solid",
  gridVertColor: "",
  gridVertStyle: "solid",
  gridHorzColor: "",
  gridHorzStyle: "solid",
  showCrosshair: true,
  crosshairColor: "",
  crosshairWidth: 1,
  crosshairStyle: "dashed",
  watermark: false,
  watermarkMode: "hidden",
  watermarkColor: "",
  backgroundGradient: false,
  backgroundColor: "",
  backgroundColor2: "",
  scaleFontSize: 12,
  scaleTextColor: "",
  scaleLineColor: "",
  paneSeparatorColor: "",
  paneButtons: "hover",
  marginTopPct: 10,
  marginBottomPct: 8,
  rightOffsetBars: 5,

  showTrading: true,
  showPnlValue: true,
  showExecutionMarks: true,
  showExecutionLabels: true,
  showAlertLines: true,
  onlyActiveAlerts: true,
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
export const WATERMARK_MODES: readonly WatermarkMode[] = ["hidden", "symbol", "replay"];
export const SCALE_BUTTON_MODES: readonly ScaleButtonsMode[] = ["hover", "always", "hidden"];
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

  /*
   * ── The three migrations R6 asked for, in one place ──────────────────────
   *
   * Each one is a key that SPLIT or changed shape, and each seeds its
   * successors from what the user had. The failure this guards against is
   * always the same: a workspace that comes back from an update with a
   * setting the user had switched off switched back on.
   */
  /** The body colours, resolved first: the candle-component pairs default to them. */
  const up = hex(value.upColor, DEFAULT_CHART_SETTINGS.upColor) || DEFAULT_CHART_SETTINGS.upColor;
  const down = hex(value.downColor, DEFAULT_CHART_SETTINGS.downColor) || DEFAULT_CHART_SETTINGS.downColor;
  /** C-1: one grid colour and style became one of each per direction. */
  const legacyGridColor = hex(value.gridColor, "");
  const legacyGridStyle = lineStyle(value.gridStyle, "solid");
  /** SL-1: one indicator switch became titles / inputs / values. */
  const legacyIndicators = bool(value.statusIndicatorValues, true);
  /** C-2: the watermark boolean became a three-state mode. */
  const watermarkMode: WatermarkMode = WATERMARK_MODES.includes(value.watermarkMode as WatermarkMode)
    ? value.watermarkMode as WatermarkMode
    : value.watermark === true ? "symbol" : "hidden";

  return {
    candleBody: bool(value.candleBody, true),
    candleBorders: bool(value.candleBorders, true),
    candleWicks: bool(value.candleWicks, true),
    colorBarsBasedOnPreviousClose: bool(value.colorBarsBasedOnPreviousClose, false),
    thinBars: bool(value.thinBars, true),
    upColor: up,
    downColor: down,
    // S-2: absent, these ARE the body's colours — the chart is unchanged for
    // every workspace that predates them.
    borderUpColor: hex(value.borderUpColor, up) || up,
    borderDownColor: hex(value.borderDownColor, down) || down,
    wickUpColor: hex(value.wickUpColor, up) || up,
    wickDownColor: hex(value.wickDownColor, down) || down,
    precision,

    showStatusLine: bool(value.showStatusLine, true),
    statusSymbol: bool(value.statusSymbol, true),
    statusTitle: STATUS_TITLE_FORMS.includes(value.statusTitle as StatusTitleForm)
      ? value.statusTitle as StatusTitleForm : "ticker",
    statusLogo: bool(value.statusLogo, true),
    statusMarketStatus: bool(value.statusMarketStatus, true),
    statusOhlc: bool(value.statusOhlc, true),
    statusBarChange: bool(value.statusBarChange, true),
    statusVolume: bool(value.statusVolume, false),
    statusDayChange: bool(value.statusDayChange, false),
    // SL-1: the single switch seeds all three, so a user who had the legend
    // off does not find titles and inputs back.
    statusIndicatorTitles: bool(value.statusIndicatorTitles, legacyIndicators),
    statusIndicatorInputs: bool(value.statusIndicatorInputs, legacyIndicators),
    statusIndicatorValues: legacyIndicators,
    statusLegendBackground: bool(value.statusLegendBackground, true),
    statusLegendBackgroundOpacity:
      Math.round(num(value.statusLegendBackgroundOpacity, 60, 0, 100)),

    scalePlacement: PLACEMENTS.includes(value.scalePlacement as ScalePlacement)
      ? value.scalePlacement as ScalePlacement : "right",
    timeFormat24h: bool(value.timeFormat24h, true),
    timeZone: ["UTC", "America/New_York", "Europe/London", "Asia/Karachi", "Asia/Tokyo"]
      .includes(value.timeZone as string) ? value.timeZone as ChartTimeZone : "UTC",
    lastValueLine: bool(value.lastValueLine, true),
    lastValueLineColor: hex(value.lastValueLineColor, DEFAULT_CHART_SETTINGS.lastValueLineColor),
    lastValueLineWidth: Math.round(num(value.lastValueLineWidth, 1, 1, 4)),
    lastValueLineStyle: lineStyle(value.lastValueLineStyle, "dashed"),
    lastValueLabel: bool(value.lastValueLabel, true),
    dateFormat: DATE_FORMATS.includes(value.dateFormat as DateFormatName)
      ? value.dateFormat as DateFormatName : "dd MMM yy",
    scaleButtons: SCALE_BUTTON_MODES.includes(value.scaleButtons as ScaleButtonsMode)
      ? value.scaleButtons as ScaleButtonsMode : "hover",
    indicatorLastValue: bool(value.indicatorLastValue, true),
    bidAskLines: value.bidAskLines === "line" ? "line" : "hidden",
    bidColor: hex(value.bidColor, DEFAULT_CHART_SETTINGS.bidColor) || DEFAULT_CHART_SETTINGS.bidColor,
    askColor: hex(value.askColor, DEFAULT_CHART_SETTINGS.askColor) || DEFAULT_CHART_SETTINGS.askColor,
    dayOfWeekOnLabels: bool(value.dayOfWeekOnLabels, true),
    noOverlappingLabels: bool(value.noOverlappingLabels, true),
    plusButton: bool(value.plusButton, true),
    countdownToBarClose: bool(value.countdownToBarClose, true),
    previousDayClose: (["hidden", "value", "line"] as const).includes(value.previousDayClose as AuxiliaryPriceLineMode)
      ? value.previousDayClose as AuxiliaryPriceLineMode : "hidden",
    previousDayCloseColor: hex(value.previousDayCloseColor, DEFAULT_CHART_SETTINGS.previousDayCloseColor),
    highLow: (["hidden", "value", "line"] as const).includes(value.highLow as AuxiliaryPriceLineMode)
      ? value.highLow as AuxiliaryPriceLineMode : "hidden",
    highLowColor: hex(value.highLowColor, DEFAULT_CHART_SETTINGS.highLowColor),

    gridVertical: bool(value.gridVertical, legacyGrid),
    gridHorizontal: bool(value.gridHorizontal, legacyGrid),
    // Empty means "the theme's own", which is what every chart had before
    // these controls existed and what Reset returns them to.
    gridColor: legacyGridColor,
    gridStyle: legacyGridStyle,
    // C-1: the shared pair seeds BOTH directions, exactly as `showGrid` seeds
    // both visibilities above — a pinned grid colour survives the split.
    gridVertColor: hex(value.gridVertColor, legacyGridColor),
    gridVertStyle: lineStyle(value.gridVertStyle, legacyGridStyle),
    gridHorzColor: hex(value.gridHorzColor, legacyGridColor),
    gridHorzStyle: lineStyle(value.gridHorzStyle, legacyGridStyle),
    showCrosshair: bool(value.showCrosshair, true),
    crosshairColor: hex(value.crosshairColor, ""),
    crosshairWidth: Math.round(num(value.crosshairWidth, 1, 1, 4)),
    crosshairStyle: lineStyle(value.crosshairStyle, "dashed"),
    // C-2: the mode is the value; the boolean is what the apply site still
    // reads, and it is kept in step rather than left to drift.
    watermarkMode,
    watermark: watermarkMode === "symbol",
    watermarkColor: hex(value.watermarkColor, ""),
    backgroundGradient: bool(value.backgroundGradient, false),
    backgroundColor: hex(value.backgroundColor, ""),
    backgroundColor2: hex(value.backgroundColor2, ""),
    scaleFontSize: Math.round(num(value.scaleFontSize, 12, 8, 20)),
    scaleTextColor: hex(value.scaleTextColor, ""),
    scaleLineColor: hex(value.scaleLineColor, ""),
    paneSeparatorColor: hex(value.paneSeparatorColor, ""),
    paneButtons: SCALE_BUTTON_MODES.includes(value.paneButtons as ScaleButtonsMode)
      ? value.paneButtons as ScaleButtonsMode : "hover",
    marginTopPct: Math.round(num(value.marginTopPct, 10, 0, 50)),
    marginBottomPct: Math.round(num(value.marginBottomPct, 8, 0, 50)),
    rightOffsetBars: Math.round(num(value.rightOffsetBars, 5, 0, 200)),

    showTrading: bool(value.showTrading, true),
    showPnlValue: bool(value.showPnlValue, true),
    showExecutionMarks: bool(value.showExecutionMarks, true),
    showExecutionLabels: bool(value.showExecutionLabels, true),
    showAlertLines: bool(value.showAlertLines, true),
    onlyActiveAlerts: bool(value.onlyActiveAlerts, true),
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

/**
 * A date format, shown as a date rather than as its pattern.
 *
 * R6 SC-5(a): the dialog listed `dd MMM yy` / `MMM dd, yyyy` / `yyyy-MM-dd` —
 * the library's pattern tokens, printed at a trader. The reference's row reads
 * `Mon 29 Sep '97`: the choice is what the axis will LOOK like, so the option
 * is the thing itself.
 *
 * Rendered through the same token substitution `lightweight-charts` performs on
 * `localization.dateFormat`, on one fixed date (Monday 29 September 1997) so
 * every option differs visibly and none of them depends on today.
 */
export function dateFormatExample(format: DateFormatName): string {
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const y = 1997, m = 9, d = 29;
  return format
    .replace("yyyy", String(y))
    .replace("MMM", MONTHS[m - 1]!)
    .replace("MM", String(m).padStart(2, "0"))
    .replace("dd", String(d))
    .replace("yy", `'${String(y).slice(2)}`);
}

/** The label a precision choice carries in the dialog. */
export function precisionLabel(value: PricePrecision): string {
  return value === "auto" ? "Default" : value === 0 ? "1" : `0.${"0".repeat(value - 1)}1`;
}

export { PRECISIONS, PLACEMENTS };

/**
 * The two plot margins, as a pair the chart library will accept.
 *
 * ── IO-A8 was reported as a defect and is NOT one. Measured, not assumed ───
 *
 * The reviewer's finding: `marginTopPct` and `marginBottomPct` each accept
 * 0–50 in the dialog and were each clamped to 0.9 independently, so fifty and
 * fifty made 1.0, lightweight-charts "requires the two to sum to less than
 * one", the throw was swallowed by the call site's `try`/`catch`, and both
 * controls went inert with nothing said.
 *
 * Driven against the real `IPriceScaleApi` at the version this product ships:
 *
 *     0.5 / 0.5  → accepted, stored as 0.5 / 0.5
 *     0.6 / 0.6  → Invalid margins - sum of margins must be less than 1, given=1.2
 *
 * The library's test is `sum > 1`, not `sum >= 1`, and the message is what the
 * finding was reasoned from rather than the behaviour. The dialog caps each box
 * at 50 and `normalizeChartSettings` caps stored values at 50, so the largest
 * sum reachable is exactly 1.0 — accepted. **The controls were never inert.**
 * Recorded in the repair queue as INVALID_FINDING with this measurement.
 *
 * ── What IS worth having, for a different and smaller reason ───────────────
 *
 * The dialog's maximum sits exactly on the library's limit, one step from the
 * far side of it, and the call site's `catch` — which is there for a chart that
 * has gone away between render and effect — would turn a step over that line
 * into precisely the silent, inert state the finding described. Widening either
 * cap from 50, or adding any third contribution to the margins, is enough.
 *
 * So the pair is clamped where the library's limit actually is. Every value
 * reachable today passes through unchanged; a future one that would have been
 * swallowed is scaled to fit instead. Scaling BOTH by the same factor is what
 * keeps it honest — clamping only the second would silently privilege whichever
 * control happened to be written first.
 */
export const MAX_SCALE_MARGIN_SUM = 1;

export function scaleMarginsFor(topPct: number, bottomPct: number): {
  top: number; bottom: number;
} {
  const clamp = (pct: number): number =>
    Number.isFinite(pct) ? Math.min(0.9, Math.max(0, pct / 100)) : 0;
  const top = clamp(topPct);
  const bottom = clamp(bottomPct);
  const sum = top + bottom;
  if (sum <= MAX_SCALE_MARGIN_SUM) return { top, bottom };
  const factor = MAX_SCALE_MARGIN_SUM / sum;
  return { top: top * factor, bottom: bottom * factor };
}

/* ── R6b-18: `Background → Gradient` has to be visible ────────────────────── */

/**
 * The chart surface and the chart ink, as this build's tokens or their dark
 * fallbacks.
 *
 * Read here rather than imported from `lib/chartTheme` so this module stays
 * free of `lightweight-charts` — it is imported by the pure unit suite, and a
 * settings model that cannot be loaded without a charting library is a model
 * nothing can test. The two literals are `--ts-surface` and `--ts-ink`'s own
 * dark values, which is what `chartTheme` falls back to as well.
 */
function themeToken(name: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const read = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return /^#[0-9a-fA-F]{6}$/.test(read) ? read : fallback;
}

function channelsOf(color: string): [number, number, number] | null {
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) return null;
  return [1, 3, 5].map((at) => parseInt(color.slice(at, at + 2), 16)) as [number, number, number];
}

/** Rec. 601 luma, 0–255 — enough to say "these two ends differ to the eye". */
export function colorLuminance(color: string): number {
  const rgb = channelsOf(color);
  if (!rgb) return 0;
  return 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
}

function mix(from: string, to: string, weight: number): string {
  const a = channelsOf(from);
  const b = channelsOf(to);
  if (!a || !b) return from;
  const w = Math.max(0, Math.min(1, weight));
  return `#${a.map((value, i) => Math.round(value + (b[i]! - value) * w)
    .toString(16).padStart(2, "0")).join("")}`;
}

/**
 * How much of the ink the theme's own gradient mixes into its top end.
 *
 * R6b-18 measured the previous answer: `rgba(41,98,255,0.06)` over transparent
 * moved rows 60..70 of the plot from 45/30/32 to 46/34/43 — three points of
 * luminance, which is nothing a user sees, on a dropdown option. 12% of the
 * ink is the smallest step that reads as a wash on both themes, and the test
 * in `tests/chartSettings.test.ts` holds it to ≥ 24 points of separation.
 */
const THEME_GRADIENT_MIX = 0.14;

/**
 * The two ends of the canvas gradient, resolved.
 *
 * `""` in either well means "the theme's own", and the two `""` ends are NOT
 * the same colour: the top is the surface mixed toward the ink, the bottom is
 * the surface. A user who chooses `Gradient` and touches nothing else must see
 * a gradient.
 */
export function resolveBackgroundGradient(top: string, bottom: string): {
  top: string; bottom: string;
} {
  const surface = themeToken("--ts-surface", "#0f0f0f");
  const ink = themeToken("--ts-ink", "#dbdbdb");
  return {
    top: top || mix(surface, ink, THEME_GRADIENT_MIX),
    bottom: bottom || surface,
  };
}
