import type { Interval } from "./market";
import type { AlertFrequency } from "../alerts/alertFrequency";

export const MA_TYPES = ["sma", "ema"] as const;
export type MaType = (typeof MA_TYPES)[number];

/** The MA lengths the chart draws and can be armed independently. */
export const MA_LENGTHS = [200, 100, 50, 21, 15] as const;

export const MA_ALERT_MODES = [
  "touch",       // the bar's range contains the MA
  "cross_up",    // close moved from below the MA to above it
  "cross_down",  // close moved from above the MA to below it
  "near_above",  // close sits inside a % band ABOVE the MA, without touching
  "near_below",  // close sits inside a % band BELOW the MA, without touching
] as const;
export type MaAlertMode = (typeof MA_ALERT_MODES)[number];

export const isMaType = (v: string): v is MaType =>
  (MA_TYPES as readonly string[]).includes(v);
export const isMaAlertMode = (v: string): v is MaAlertMode =>
  (MA_ALERT_MODES as readonly string[]).includes(v);

/**
 * What an alert watches. `ma` is the original family; `price` and `ma_vs_ma`
 * were added alongside it, on the same table and the same runner.
 */
export const CONDITION_KINDS = [
  "price", "ma", "ma_vs_ma", "sr_zone", "pivot_level", "rsi", "macd", "supertrend",
  "bollinger", "stochastic", "adx",
] as const;
export type ConditionKind = (typeof CONDITION_KINDS)[number];

export const BULK_ALERT_ACTIONS = ["pause", "resume", "delete"] as const;
export type BulkAlertAction = (typeof BULK_ALERT_ACTIONS)[number];
export const isBulkAlertAction = (value: string): value is BulkAlertAction =>
  (BULK_ALERT_ACTIONS as readonly string[]).includes(value);

/**
 * What an RSI alert compares the oscillator against: a fixed level (the 50
 * midline by default) or its own moving average.
 */
export const RSI_TARGETS = ["level", "sma"] as const;
export type RsiTarget = (typeof RSI_TARGETS)[number];
export const isRsiTarget = (v: string): v is RsiTarget =>
  (RSI_TARGETS as readonly string[]).includes(v);

/** What a MACD alert compares the MACD line against: its signal, or zero. */
export const MACD_TARGETS = ["signal", "zero"] as const;
export type MacdTarget = (typeof MACD_TARGETS)[number];
export const isMacdTarget = (v: string): v is MacdTarget =>
  (MACD_TARGETS as readonly string[]).includes(v);

/**
 * Which side of a filter's reference the market must be on for the gate to
 * open. Same vocabulary as `Side` in the evaluator, kept here so the database
 * and the UI can name it without importing the evaluator.
 */
export const FILTER_SIDES = ["above", "below"] as const;
export type FilterSide = (typeof FILTER_SIDES)[number];
export const isFilterSide = (v: string): v is FilterSide =>
  (FILTER_SIDES as readonly string[]).includes(v);

/**
 * Defaults for the gates: RSI 50 > 50, price > EMA 200, price above Supertrend.
 *
 * The Supertrend gate's defaults are the study's own inputs, so "only while the
 * trend is up" means the line the user is already looking at rather than a
 * differently-tuned one they never chose.
 */
export const FILTER_DEFAULTS = {
  rsi: { length: 50, level: 50, side: "above" as FilterSide },
  ma: { type: "ema" as MaType, length: 200, side: "above" as FilterSide },
  supertrend: {
    period: 10, multiplier: 3, atrMethod: "rma" as StAtrMethod, side: "above" as FilterSide,
  },
} as const;

/**
 * Which average of true range the Supertrend uses.
 *
 * Stored as a name rather than the study's `changeATR` boolean: a column called
 * `change_atr` says nothing about which of the two an existing row actually
 * uses, and these are two different indicators rather than one with a tweak.
 * `rma` is Wilder's, matching `ta.atr` and the study's default.
 */
export const ST_ATR_METHODS = ["rma", "sma"] as const;
export type StAtrMethod = (typeof ST_ATR_METHODS)[number];
export const isStAtrMethod = (v: string): v is StAtrMethod =>
  (ST_ATR_METHODS as readonly string[]).includes(v);

/** The study's own inputs: ATR 10, multiplier 3, Wilder's ATR. */
export const SUPERTREND_DEFAULTS = {
  period: 10, multiplier: 3, atrMethod: "rma" as StAtrMethod,
} as const;

/** Defaults, matching the request these families were added for. */
export const RSI_DEFAULTS = { length: 50, level: 50, maLength: 14 } as const;
export const MACD_DEFAULTS = { fast: 12, slow: 26, signal: 9 } as const;

/**
 * Which Bollinger band an alert watches.
 *
 * Three lines, one alert kind. A band is a price level like any other, so the
 * touch/cross grammar the MA and level families already use applies unchanged
 * — the only new thing is which of the three lines the reference comes from.
 */
export const BOLLINGER_BANDS = ["upper", "basis", "lower"] as const;
export type BollingerBand = (typeof BOLLINGER_BANDS)[number];
export const isBollingerBand = (v: string): v is BollingerBand =>
  (BOLLINGER_BANDS as readonly string[]).includes(v);

/** The study's own defaults, so the alert watches the line on the chart. */
export const BOLLINGER_DEFAULTS = {
  length: 20, mult: 2, band: "upper" as BollingerBand, maType: "sma" as MaType,
} as const;

/**
 * What a Stochastic alert compares %K against: its own %D, or a fixed level.
 *
 * The same shape as the RSI family's target, deliberately — an oscillator
 * against its signal and an oscillator against a line are one comparison with
 * a different reference, not two kinds.
 */
export const STOCHASTIC_TARGETS = ["signal", "level"] as const;
export type StochasticTarget = (typeof STOCHASTIC_TARGETS)[number];
export const isStochasticTarget = (v: string): v is StochasticTarget =>
  (STOCHASTIC_TARGETS as readonly string[]).includes(v);

export const STOCHASTIC_DEFAULTS = {
  kLength: 14, kSmooth: 1, dSmooth: 3, level: 20,
} as const;

/**
 * ADX against a strength threshold.
 *
 * Only a level: ADX has no signal line, and inventing one would be a second
 * indicator. 25 is the conventional "a trend is present" line and is what the
 * study draws.
 */
export const ADX_DEFAULTS = { diLength: 14, smoothing: 14, level: 25 } as const;

export const PRICE_DIRECTIONS = ["cross_up", "cross_down", "either"] as const;

/** Which side of the market a support/resistance alert watches. */
export const SR_SIDES = ["support", "resistance", "either"] as const;
export type SrSide = (typeof SR_SIDES)[number];
export const isSrSide = (v: string): v is SrSide =>
  (SR_SIDES as readonly string[]).includes(v);

/**
 * `any` watches every level of the chosen pivot type and reports whichever is
 * nearest, which is what "tell me when price approaches a pivot" means in
 * practice. A specific name watches only that line.
 */
export const PIVOT_LEVEL_ANY = "any";
export type PriceDirection = (typeof PRICE_DIRECTIONS)[number];

export const isConditionKind = (v: string): v is ConditionKind =>
  (CONDITION_KINDS as readonly string[]).includes(v);
export const isPriceDirection = (v: string): v is PriceDirection =>
  (PRICE_DIRECTIONS as readonly string[]).includes(v);

/**
 * One armed alert.
 *
 * The MA columns are nullable because a price alert names no moving average.
 * Which fields are populated is determined by `conditionKind`, and the database
 * enforces the pairing so a half-specified row — one the runner could not
 * evaluate, and which would therefore silently never fire — cannot be stored.
 */
export interface MaAlertRow {
  id: string;
  symbol: string;
  timeframe: Interval;
  conditionKind: ConditionKind;
  /** Populated for `ma` and `ma_vs_ma`. */
  maType: MaType | null;
  maLength: number | null;
  mode: MaAlertMode | null;
  /** The slow line, for `ma_vs_ma`. */
  ma2Type: MaType | null;
  ma2Length: number | null;
  /** Populated for `price`. */
  targetPrice: number | null;
  priceDirection: PriceDirection | null;

  // ── sr_zone ──
  srSide: SrSide | null;
  srPivotLength: number | null;
  srInvalidation: string | null;

  // ── pivot_level ──
  pivotType: string | null;
  pivotLevelName: string | null;
  /** The period the levels come from — NOT the evaluation timeframe. */
  pivotAnchor: string | null;

  // ── rsi ──
  rsiLength: number | null;
  /** The level crossed when `indicatorTarget` is "level". */
  rsiLevel: number | null;
  /** Length of the RSI-based MA crossed when `indicatorTarget` is "sma". */
  rsiMaLength: number | null;

  // ── supertrend ──
  stPeriod: number | null;
  stMultiplier: number | null;
  /** `StAtrMethod`; null for every other kind. */
  stAtrMethod: string | null;

  // ── macd ──
  macdFast: number | null;
  macdSlow: number | null;
  macdSignal: number | null;

  // ── bollinger ──
  bbLength: number | null;
  bbMult: number | null;
  /** `BollingerBand`: which of the three lines this alert watches. */
  bbBand: string | null;
  /** The basis MA type — the study's own input. */
  bbMaType: MaType | null;

  // ── stochastic ──
  stochKLength: number | null;
  stochKSmooth: number | null;
  stochDSmooth: number | null;
  /** The level crossed when `indicatorTarget` is "level". */
  stochLevel: number | null;

  // ── adx ──
  adxDiLength: number | null;
  adxSmoothing: number | null;
  adxLevel: number | null;

  /**
   * `RsiTarget` for `rsi`, `MacdTarget` for `macd`, `StochasticTarget` for
   * `stochastic`; null otherwise. One column because all three answer the same
   * question — what is this oscillator compared against.
   */
  indicatorTarget: string | null;

  // ── optional gates, available on every family ──
  /** Null when no RSI gate is configured. */
  filterRsiLength: number | null;
  filterRsiLevel: number | null;
  filterRsiSide: string | null;
  /** Null when no moving-average gate is configured. */
  filterMaType: MaType | null;
  filterMaLength: number | null;
  filterMaSide: string | null;
  /** Null when no Supertrend gate is configured. */
  filterStPeriod: number | null;
  filterStMultiplier: number | null;
  filterStAtrMethod: string | null;
  filterStSide: string | null;
  /** Band edges in percent; only read for the near_* modes. */
  nearMinPct: number;
  nearMaxPct: number;
  enabled: boolean;
  /** How often a true condition may notify. See `alerts/alertFrequency.ts`. */
  frequency: AlertFrequency;
  cooldownMin: number;
  note: string | null;
  lastSide: "above" | "below" | null;
  lastFiredAt: string | null;
  /** Open time of the bar the last notification fired on. Caps once_per_bar. */
  lastFiredBarTime: string | null;
  /** Open time of the last bar evaluated. The out-of-order guard reads it. */
  lastBarTime: string | null;
  /** Set when a once_only alert has delivered and retired itself. */
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MaAlertEventRow {
  id: number;
  alertId: string;
  firedAt: string;
  barTime: string;
  price: number;
  /** The value compared against: the MA, the slow MA, or the price target. */
  maValue: number;
  distancePct: number;
  title: string;
  body: string;
  pushedTo: number;
  pushFailed: number;
  pushPruned: number;
  deliveryStatus: "delivered" | "partial_failure" | "failed" | "no_devices";
  /**
   * Whether this fired on a FORMING candle. Recorded because it is the honest
   * half of the intrabar promise: an alert can fire at a price the finished
   * candle never closed at, and the log should say so rather than leave the
   * user to wonder.
   */
  intrabar: boolean;
  frequency: AlertFrequency | null;
}

/** Human label for an armed line, e.g. "EMA 200". */
export const maLabel = (type: MaType, length: number): string =>
  `${type.toUpperCase()} ${length}`;

export function describeMode(
  row: { mode: MaAlertMode | null; nearMinPct: number; nearMaxPct: number }
): string {
  switch (row.mode) {
    case "touch": return "touches";
    case "cross_up": return "crosses above";
    case "cross_down": return "crosses below";
    case "near_above": return `is ${row.nearMinPct}–${row.nearMaxPct}% above`;
    case "near_below": return `is ${row.nearMinPct}–${row.nearMaxPct}% below`;
    default: return "meets";
  }
}
