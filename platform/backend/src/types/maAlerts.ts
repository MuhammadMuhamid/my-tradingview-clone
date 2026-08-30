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
  "price", "ma", "ma_vs_ma", "sr_zone", "pivot_level",
] as const;
export type ConditionKind = (typeof CONDITION_KINDS)[number];

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
