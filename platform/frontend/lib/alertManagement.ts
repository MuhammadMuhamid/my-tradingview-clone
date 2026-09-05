import type {
  BulkAlertAction, BulkAlertResult, ConditionKind, MaAlert,
} from "@/lib/api";
import { isAlertActive } from "@/lib/alerts";

export type AlertStatusFilter = "all" | "active" | "inactive";
export type AlertTypeFilter =
  | "all" | ConditionKind | "ma_ema" | "ma_sma";

export interface AlertFilters {
  search: string;
  status: AlertStatusFilter;
  type: AlertTypeFilter;
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
  { value: "rsi", label: "RSI", scopeLabel: "RSI alerts" },
  { value: "macd", label: "MACD", scopeLabel: "MACD alerts" },
  { value: "supertrend", label: "Supertrend", scopeLabel: "Supertrend alerts" },
  { value: "bollinger", label: "Bollinger band", scopeLabel: "Bollinger alerts" },
  { value: "stochastic", label: "Stochastic", scopeLabel: "Stochastic alerts" },
  { value: "adx", label: "ADX", scopeLabel: "ADX alerts" },
];

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
  return `${count} ${status}${noun}${matching}`;
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
