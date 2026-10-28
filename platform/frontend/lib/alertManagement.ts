import type {
  BulkAlertAction, BulkAlertResult, ConditionKind, MaAlert,
} from "@/lib/api";
import type { Interval } from "@/lib/types";
import { isAlertActive } from "@/lib/alerts";
import { INTERVAL_VALUES } from "@/lib/types";

export type AlertStatusFilter = "all" | "active" | "inactive";
export type AlertTimeframeFilter = "all" | Interval;
export type AlertTypeFilter =
  | "all" | ConditionKind | "ma_ema" | "ma_sma";

export interface AlertFilters {
  search: string;
  status: AlertStatusFilter;
  type: AlertTypeFilter;
  timeframe: AlertTimeframeFilter;
}

export const ALERT_STATUS_FILTERS: ReadonlyArray<{
  value: AlertStatusFilter; label: string;
}> = [
  { value: "all", label: "All statuses" },
  { value: "active", label: "Active" },
  { value: "inactive", label: "Paused / inactive" },
];

/** Every family, plus truthful subtype choices for persisted single-MA rows. */
export const ALERT_TYPE_FILTERS: ReadonlyArray<{
  value: AlertTypeFilter; label: string; scopeLabel: string;
}> = [
  { value: "all", label: "All types", scopeLabel: "alerts" },
  { value: "price", label: "Price", scopeLabel: "Price alerts" },
  { value: "ma", label: "Moving average — EMA & SMA", scopeLabel: "MA alerts" },
  { value: "ma_ema", label: "Moving average — EMA only", scopeLabel: "EMA alerts" },
  { value: "ma_sma", label: "Moving average — SMA only", scopeLabel: "SMA alerts" },
  { value: "ma_vs_ma", label: "MA vs MA", scopeLabel: "MA-vs-MA alerts" },
  { value: "sr_zone", label: "Support / resistance", scopeLabel: "S/R alerts" },
  { value: "pivot_level", label: "Pivot levels", scopeLabel: "Pivot alerts" },
  { value: "fib_level", label: "Auto fib levels", scopeLabel: "Fib alerts" },
  { value: "msb", label: "Market structure breaks", scopeLabel: "MSB alerts" },
  { value: "order_block", label: "Order block zones", scopeLabel: "Order block alerts" },
  { value: "liquidity_swing", label: "Liquidity swing levels", scopeLabel: "Liquidity alerts" },
  { value: "rsi", label: "RSI", scopeLabel: "RSI alerts" },
  { value: "macd", label: "MACD", scopeLabel: "MACD alerts" },
  { value: "supertrend", label: "Supertrend", scopeLabel: "Supertrend alerts" },
  { value: "bollinger", label: "Bollinger band", scopeLabel: "Bollinger alerts" },
  { value: "stochastic", label: "Stochastic", scopeLabel: "Stochastic alerts" },
  { value: "adx", label: "ADX", scopeLabel: "ADX alerts" },
];

/**
 * The timeframes worth offering: the ones some alert is actually on.
 *
 * Derived from the rows rather than listed statically, because an account with
 * three 1h alerts has no use for a menu of twelve intervals, eleven of which
 * select nothing. Ordered by duration rather than alphabetically, so 15m sits
 * between 5m and 1h instead of between 12h and 1d.
 */
export function alertTimeframeOptions(alerts: MaAlert[]): Interval[] {
  const present = new Set(alerts.map((a) => a.timeframe));
  return INTERVAL_VALUES.filter((i) => present.has(i));
}

/**
 * Fall back to "all" when the chosen timeframe has no alerts left.
 *
 * Deleting the last 4h alert while filtered to 4h would otherwise leave the
 * list empty under a filter the user can no longer see the point of, which
 * reads as "my alerts are gone" rather than "nothing matches".
 */
export function normalizeTimeframeFilter(
  filters: AlertFilters, alerts: MaAlert[]
): AlertFilters {
  if (filters.timeframe === "all") return filters;
  return alerts.some((a) => a.timeframe === filters.timeframe)
    ? filters
    : { ...filters, timeframe: "all" };
}

function matchesType(alert: MaAlert, type: AlertTypeFilter): boolean {
  if (type === "all") return true;
  if (type === "ma_ema") return alert.conditionKind === "ma" && alert.maType === "ema";
  if (type === "ma_sma") return alert.conditionKind === "ma" && alert.maType === "sma";
  return alert.conditionKind === type;
}

/** Case-insensitive symbol substring search composed with status and type. */
export function filterAlerts(alerts: MaAlert[], filters: AlertFilters): MaAlert[] {
  const search = filters.search.trim().toLocaleUpperCase();
  return alerts.filter((alert) => {
    if (search && !alert.symbol.toLocaleUpperCase().includes(search)) return false;
    if (filters.status === "active" && !isAlertActive(alert)) return false;
    if (filters.status === "inactive" && isAlertActive(alert)) return false;
    if (filters.timeframe !== "all" && alert.timeframe !== filters.timeframe) return false;
    return matchesType(alert, filters.type);
  });
}

/** Human-readable scope used by destructive confirmation and completion copy. */
export function describeAlertScope(filters: AlertFilters, count: number): string {
  const type = ALERT_TYPE_FILTERS.find((option) => option.value === filters.type)!;
  const search = filters.search.trim();
  const status = filters.status === "active" ? "active "
    : filters.status === "inactive" ? "paused / inactive " : "";
  const noun = filters.type === "all" ? "alerts" : type.scopeLabel;
  const matching = search ? ` matching “${search}”` : "";
  // The timeframe goes AFTER the search phrase so the sentence still reads as
  // one scope: "3 active RSI alerts matching “BTC” on 4h".
  const timeframe = filters.timeframe === "all" ? "" : ` on ${filters.timeframe}`;
  return `${count} ${status}${noun}${matching}${timeframe}`;
}

/** Null is the empty-scope guard: no caller can turn zero IDs into delete-all. */
export function deleteConfirmation(filters: AlertFilters, count: number): string | null {
  if (count <= 0) return null;
  return `Delete ${describeAlertScope(filters, count)}?\n\n` +
    "Only the current filtered result will be deleted. This cannot be undone.";
}

/**
 * The confirmation for a bulk action over SELECTED rows.
 *
 * Bulk actions act on an explicit selection, never on "whatever the filter
 * happens to show": the count the user ticked is the count named here, with
 * the shown total beside it so "42 of 185" is read before anything is gone.
 */
export function selectionConfirmation(
  action: BulkAlertAction, selected: number, shown: number
): string | null {
  if (selected <= 0) return null;
  const noun = `alert${selected === 1 ? "" : "s"}`;
  if (action === "delete") {
    return `Delete ${selected} selected ${noun} (of ${shown} shown)?\n\n` +
      "Only the ticked rows are deleted. This cannot be undone.";
  }
  return null;
}

export function buildBulkRequest(
  action: BulkAlertAction, alerts: MaAlert[]
): { action: BulkAlertAction; ids: string[] } | null {
  const ids = [...new Set(alerts.map((alert) => alert.id))];
  return ids.length > 0 ? { action, ids } : null;
}

export function bulkCompletionMessage(
  action: BulkAlertAction, expected: number, result: BulkAlertResult
): string {
  if (
    result.action !== action || result.requested !== expected ||
    result.missingIds.length > 0 || result.affected !== expected
  ) {
    throw new Error(
      `${action} changed ${result.affected} of ${expected} alerts; the result may be partial`
    );
  }
  const verb = action === "delete" ? "Deleted" : action === "pause" ? "Paused" : "Resumed";
  return `${verb} ${result.affected} alert${result.affected === 1 ? "" : "s"}`;
}
