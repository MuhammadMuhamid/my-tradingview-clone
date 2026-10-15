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
  "bollinger", "stochastic", "adx", "candlestick_pattern", "fib_level",
] as const;
export type ConditionKind = (typeof CONDITION_KINDS)[number];

export const BULK_ALERT_ACTIONS = ["pause", "resume", "delete"] as const;
export type BulkAlertAction = (typeof BULK_ALERT_ACTIONS)[number];
export const isBulkAlertAction = (value: string): value is BulkAlertAction =>
  (BULK_ALERT_ACTIONS as readonly string[]).includes(value);

/**
 * What an RSI alert compares the oscillator against: a fixed level (the 50
 * midline by default) or its own moving average — simple or exponential.
 *
 * `ema` was added in migration 048. The RSI-vs-its-own-MA FILTER always
 * offered both averages; the alert family offered only the SMA, so "RSI 50
 * crosses its EMA 14" could gate an alert but could not BE one.
 */
export const RSI_TARGETS = ["level", "sma", "ema"] as const;
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
 * The timeframes a gate may be measured on.
 *
 * A gate with no timeframe is measured on the alert's OWN, which is what every
 * gate written before the `filters` column did and what an omitted field still
 * means. Naming one turns a single-timeframe question into a multi-timeframe
 * one — "15m support, but only while the 1h trend is down and the 4h is up" —
 * which is a correlation a trader would otherwise have to do by hand across
 * two alerts that cannot actually be correlated.
 */
export const FILTER_TIMEFRAMES = [
  "1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d",
] as const;
export type FilterTimeframe = (typeof FILTER_TIMEFRAMES)[number];
export const isFilterTimeframe = (v: string): v is FilterTimeframe =>
  (FILTER_TIMEFRAMES as readonly string[]).includes(v);

/**
 * The most gates one alert may carry.
 *
 * A bound on what a person can reason about, NOT on cost. The runner fetches
 * one candle series per DISTINCT timeframe and shares it across every alert on
 * the symbol, so ten gates spread over two timeframes cost the same two
 * fetches that two gates would.
 *
 * Asking one question on two timeframes already spends two slots, and a trader
 * who wants an RSI and a moving average behind it is at four before the
 * interesting part — which is why this is 10 rather than the 3 the fixed-slot
 * design allowed.
 *
 * Raising it is a WIDENING, so the CHECK that carries it can never fail
 * against a row that already exists.
 */
export const MAX_ALERT_FILTERS = 10;

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
  /*
   * RSI 50 against its own EMA 14 — a momentum gate that does not need a fixed
   * level to be meaningful. The RSI length defaults to the same 50 the plain
   * RSI gate uses, so switching between the two kinds does not silently change
   * which oscillator is being read.
   */
  rsi_ma: {
    length: 50, maType: "ema" as MaType, maLength: 14, side: "above" as FilterSide,
  },
  /** The classic 12/26/9, matching the MACD condition family's own defaults. */
  macd: {
    fastLength: 12, slowLength: 26, signalLength: 9,
    target: "signal" as MacdTarget, side: "above" as FilterSide,
  },
} as const;

/**
 * The gate kinds, in the order the editor offers them.
 *
 * `rsi_ma` and `macd` both compare two computed series rather than a series to
 * a constant, which is why their reading is a SPREAD (see `filterReadings`).
 */
export const FILTER_KINDS = ["rsi", "ma", "supertrend", "rsi_ma", "macd"] as const;
export type FilterKind = (typeof FILTER_KINDS)[number];
export const isFilterKind = (v: string): v is FilterKind =>
  (FILTER_KINDS as readonly string[]).includes(v);

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
/**
 * Bars of history the alert runner evaluates against.
 *
 * Declared here rather than in the runner because it is a CONTRACT, not an
 * implementation detail: it is the ceiling every family's warm-up has to fit
 * under, and the request validator has to refuse the combinations that do not.
 * `maAlertRunner.ts` reads it as the size of the window it loads, so the two
 * cannot drift.
 */
export const ALERT_HISTORY_BARS = 1200;

/**
 * Bars a configuration must see before it produces its first value.
 *
 * Each length is separately capped at 1000, which is safe for a family whose
 * warm-up is one length. It is not safe where lengths STACK: `adxDiLength`
 * 700 with `adxSmoothing` 700 passes both checks and needs 1400 bars, so the
 * alert is stored, listed as armed, and can never warm up — the exact class
 * migration 027 was written to close. Families whose warm-up is a single
 * length return 0, because a number nothing can exceed is a number nothing
 * should read.
 */
export function warmupBars(condition: {
  kind: string;
  slowLength?: number; signalLength?: number;
  kLength?: number; kSmooth?: number; dSmooth?: number;
  diLength?: number; smoothing?: number;
}): number {
  switch (condition.kind) {
    case "macd":
      // The signal line is an EMA of the MACD line, so the two stack.
      return (condition.slowLength ?? 0) + (condition.signalLength ?? 0);
    case "stochastic":
      // %K needs its window and its smoothing; %D smooths %K again.
      return (condition.kLength ?? 0) + (condition.kSmooth ?? 0) + (condition.dSmooth ?? 0);
    case "adx":
      // DI needs `diLength`, and DX is then smoothed over `smoothing` bars.
      return (condition.diLength ?? 0) + (condition.smoothing ?? 0);
    default:
      return 0;
  }
}

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
  /** The owning account. */
  userId: string;
  symbol: string;
  /** Immutable identity of the provider feed and price role this alert reads. */
  canonicalInstrumentId?: string | null;
  providerId?: string | null;
  priceBasis?: "last" | "bid" | "ask" | "mid" | "mark" | "index" | null;
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
  /** Stable canonical detector id, populated only for candlestick_pattern. */
  patternId?: string | null;
  /**
   * Auto Fib Retracement, populated only for `fib_level` (migration 049): the
   * zig-zag's deviation and depth, whether 0 and 1 are swapped, and the ratio
   * watched — 0.618 is the 61.8% retracement of the latest swing.
   */
  fibDeviation?: number | null;
  fibDepth?: number | null;
  fibReverse?: boolean | null;
  fibLevel?: number | null;
  /** Immutable detector profile captured when a candlestick alert is armed. */
  patternDetectorId?: string | null;
  patternDetectorVersion?: string | null;
  patternSettingsHash?: string | null;
  patternSettings?: Record<string, unknown> | null;

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
  /**
   * The gates this alert carries, in order, as stored in the `filters` JSONB
   * column. Null on a row written before migration 045; the legacy `filter_*`
   * columns below are then read instead. See `filtersFromRow`.
   *
   * Typed `unknown` deliberately: it is whatever the database returned, and
   * `parseStoredFilters` is the only thing allowed to decide it is gates.
   */
  filters: unknown;

  // ── legacy single gates, superseded by `filters` (migration 045) ──
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
  patternDetectorId: string | null;
  patternDetectorVersion: string | null;
  patternSettingsHash: string | null;
  patternOccurrenceId: string | null;
  patternOccurrence: Record<string, unknown> | null;
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
