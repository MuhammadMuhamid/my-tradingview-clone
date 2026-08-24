import type { Interval } from "./market";

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
 * How often an alert may fire, matching TradingView's wording.
 *   once_per_bar_close — only on a confirmed candle close (default)
 *   once_per_bar       — intrabar, at most once per candle
 *   once               — intrabar, then the alert disables itself
 */
export const TRIGGER_MODES = ["once", "once_per_bar", "once_per_bar_close"] as const;
export type TriggerMode = (typeof TRIGGER_MODES)[number];

export const isTriggerMode = (v: string): v is TriggerMode =>
  (TRIGGER_MODES as readonly string[]).includes(v);

/** The two modes that must be checked on every tick, not just at bar close. */
export const isIntrabar = (t: TriggerMode): boolean => t !== "once_per_bar_close";

export const TRIGGER_LABELS: Record<TriggerMode, string> = {
  once: "Once only",
  once_per_bar: "Once per bar",
  once_per_bar_close: "Once per bar close",
};

export interface MaAlertRow {
  id: string;
  symbol: string;
  timeframe: Interval;
  maType: MaType;
  maLength: number;
  mode: MaAlertMode;
  /** Band edges in percent; only read for the near_* modes. */
  nearMinPct: number;
  nearMaxPct: number;
  enabled: boolean;
  cooldownMin: number;
  note: string | null;
  trigger: TriggerMode;
  lastSide: "above" | "below" | null;
  lastFiredAt: string | null;
  /** Open time of the candle this alert last fired on, for once_per_bar. */
  lastFiredBarTime: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MaAlertEventRow {
  id: number;
  alertId: string;
  firedAt: string;
  barTime: string;
  price: number;
  maValue: number;
  distancePct: number;
  title: string;
  body: string;
  pushedTo: number;
}

/** Human label for an armed line, e.g. "EMA 200". */
export const maLabel = (type: MaType, length: number): string =>
  `${type.toUpperCase()} ${length}`;

export function describeMode(row: Pick<MaAlertRow, "mode" | "nearMinPct" | "nearMaxPct">): string {
  switch (row.mode) {
    case "touch": return "touches";
    case "cross_up": return "crosses above";
    case "cross_down": return "crosses below";
    case "near_above": return `is ${row.nearMinPct}–${row.nearMaxPct}% above`;
    case "near_below": return `is ${row.nearMinPct}–${row.nearMaxPct}% below`;
  }
}
