/**
 * Editing a persisted alert IN PLACE.
 *
 * Creation already owns the accept/reject matrix for every family
 * (`alertRequest.ts`) and the rules a condition must satisfy to be evaluable at
 * all (`alertConditions.ts`). An edit must land on exactly the same rules, or
 * the two paths drift and a configuration the create route refuses becomes
 * reachable by saving an edit.
 *
 * So an edit is expressed as: take the request body the row WOULD have been
 * created from, overlay only the keys the client actually sent, and run the
 * result back through `readCondition` → `validateCondition` → `toColumns`.
 * Nothing here re-implements a family; it only reverses the flattening that
 * `toColumns` performs, so the same forward path can be reused.
 *
 * ── Why the alert keeps its ID ─────────────────────────────────────────────
 *
 * Deleting and re-creating would change the primary key, orphan the event log
 * (`ma_alert_events.alert_id`), discard `last_side`, `last_fired_at`,
 * `last_fired_bar_time` and `completed_at`, and leave a window in which the old
 * and new configurations could both be evaluated by an in-flight runner pass.
 * An UPDATE has none of those properties, and the runner re-reads the table on
 * every evaluation, so a saved edit is consumed on the next bar with no restart
 * and no double-arm.
 */
import {
  PIVOT_LEVEL_ANY,
  type ConditionKind, type MaAlertRow,
} from "../types/maAlerts";
import { DEFAULT_SR_OPTIONS } from "../engine/srZones";
import type { AlertColumns } from "./alertRequest";

/**
 * The request keys each family lets a user edit.
 *
 * Derived from what `readCondition` reads for that kind — nothing is offered
 * here that the creation path could not also accept, and nothing a family does
 * not read is listed, so an editor built from this table cannot show a control
 * that silently does nothing.
 *
 * `mode`, `timeframe`, `symbol`, `frequency`, `cooldownMin`, `note` and
 * `enabled` are common to every family and live in `COMMON_EDITABLE_FIELDS`.
 */
/**
 * The gate fields, editable on EVERY family.
 *
 * They used to be listed only on the two level kinds. Now that any alert may
 * carry a gate, a family that omitted them here would accept the gate at
 * creation and silently discard it on the next save — the edit path rebuilds
 * the condition from `alertRequestFromRow` plus the fields it is allowed to
 * merge, so an unlisted field is a field that quietly reverts.
 */
const GATE_FIELDS = [
  "filterRsi", "filterRsiLength", "filterRsiLevel", "filterRsiSide",
  "filterMa", "filterMaType", "filterMaLength", "filterMaSide",
  "filterSt", "filterStPeriod", "filterStMultiplier", "filterStAtrMethod", "filterStSide",
] as const;

export const EDITABLE_CONDITION_FIELDS: Record<ConditionKind, readonly string[]> = {
  price: ["targetPrice", "priceDirection", ...GATE_FIELDS],
  ma: ["maType", "maLength", "mode", "nearMinPct", "nearMaxPct", ...GATE_FIELDS],
  ma_vs_ma: ["maType", "maLength", "ma2Type", "ma2Length", "mode", ...GATE_FIELDS],
  sr_zone: [
    "srSide", "mode", "nearMinPct", "nearMaxPct", "pivotLength", "invalidation",
    ...GATE_FIELDS,
  ],
  pivot_level: [
    "pivotType", "levelName", "anchor", "mode", "nearMinPct", "nearMaxPct",
    ...GATE_FIELDS,
  ],
  rsi: ["rsiLength", "target", "rsiLevel", "rsiMaLength", "mode", ...GATE_FIELDS],
  macd: ["macdFast", "macdSlow", "macdSignal", "target", "mode", ...GATE_FIELDS],
  supertrend: ["stPeriod", "stMultiplier", "stAtrMethod", "mode", ...GATE_FIELDS],
};

/** Editable on every family, and handled outside the condition round trip. */
export const COMMON_EDITABLE_FIELDS = [
  "symbol", "timeframe", "frequency", "cooldownMin", "note", "enabled",
] as const;

/**
 * Fields the runner and the delivery log own.
 *
 * A client that sends one is not making a mistake about a value, it is trying
 * to rewrite what the system OBSERVED — that an alert has fired, or which side
 * of its reference it last sat on. Refusing them explicitly is better than
 * ignoring them, which would let a UI believe it had reset an alert's history.
 */
export const INTERNAL_ALERT_FIELDS = [
  "id", "conditionKind", "lastSide", "lastFiredAt", "lastFiredBarTime",
  "lastBarTime", "completedAt", "createdAt", "updatedAt",
] as const;

/**
 * The columns whose value decides which SIDE of its reference an alert is on.
 *
 * `last_side` is the memory a cross is detected against. Change the reference —
 * a different level, a different MA length, a different oscillator target — and
 * the stored side describes a comparison that no longer exists, which can
 * manufacture a cross on the very next bar. Changing the MODE does not: which
 * side price is on is the same fact whether the alert watches crosses up or
 * down, so switching direction keeps its memory.
 */
const REFERENCE_COLUMNS: Record<ConditionKind, readonly (keyof AlertColumns)[]> = {
  price: ["targetPrice"],
  ma: ["maType", "maLength"],
  ma_vs_ma: ["maType", "maLength", "ma2Type", "ma2Length"],
  sr_zone: ["srSide", "srPivotLength", "srInvalidation"],
  pivot_level: ["pivotType", "pivotLevelName", "pivotAnchor"],
  rsi: ["rsiLength", "rsiLevel", "rsiMaLength", "indicatorTarget"],
  macd: ["macdFast", "macdSlow", "macdSignal", "indicatorTarget"],
  // Both inputs reshape the bands, and therefore which side of them price is
  // on — a stored side from the old parameters describes a line that no longer
  // exists and would manufacture a flip on the next bar.
  supertrend: ["stPeriod", "stMultiplier", "stAtrMethod"],
};

/**
 * The request body this row would be created from today.
 *
 * The inverse of `toColumns`, in the vocabulary `readCondition` reads — which
 * is NOT the column vocabulary: `sr_pivot_length` is sent as `pivotLength`,
 * `indicator_target` as `target`, and so on. Getting one of those names wrong
 * would silently reset that field to its default on every save, so
 * `tests/alertEdit.test.ts` round-trips every family through this function and
 * back into `toColumns` and asserts the columns are identical.
 */
export function alertRequestFromRow(row: MaAlertRow): Record<string, unknown> {
  const gates: Record<string, unknown> = {};
  if (row.filterRsiLength !== null && row.filterRsiSide !== null) {
    gates.filterRsi = true;
    gates.filterRsiLength = row.filterRsiLength;
    gates.filterRsiLevel = row.filterRsiLevel;
    gates.filterRsiSide = row.filterRsiSide;
  }
  if (row.filterMaType !== null && row.filterMaLength !== null && row.filterMaSide !== null) {
    gates.filterMa = true;
    gates.filterMaType = row.filterMaType;
    gates.filterMaLength = row.filterMaLength;
    gates.filterMaSide = row.filterMaSide;
  }
  if (
    row.filterStPeriod !== null && row.filterStMultiplier !== null &&
    row.filterStAtrMethod !== null && row.filterStSide !== null
  ) {
    gates.filterSt = true;
    gates.filterStPeriod = row.filterStPeriod;
    gates.filterStMultiplier = row.filterStMultiplier;
    gates.filterStAtrMethod = row.filterStAtrMethod;
    gates.filterStSide = row.filterStSide;
  }

  switch (row.conditionKind) {
    case "price":
      return { targetPrice: row.targetPrice, priceDirection: row.priceDirection, ...gates };
    case "ma":
      return {
        maType: row.maType, maLength: row.maLength, mode: row.mode,
        nearMinPct: row.nearMinPct, nearMaxPct: row.nearMaxPct, ...gates,
      };
    case "ma_vs_ma":
      return {
        maType: row.maType, maLength: row.maLength,
        ma2Type: row.ma2Type, ma2Length: row.ma2Length, mode: row.mode, ...gates,
      };
    case "sr_zone":
      return {
        srSide: row.srSide, mode: row.mode,
        nearMinPct: row.nearMinPct, nearMaxPct: row.nearMaxPct,
        pivotLength: row.srPivotLength ?? DEFAULT_SR_OPTIONS.pivotLength,
        invalidation: row.srInvalidation ?? "close",
        ...gates,
      };
    case "pivot_level":
      return {
        pivotType: row.pivotType, levelName: row.pivotLevelName ?? PIVOT_LEVEL_ANY,
        anchor: row.pivotAnchor, mode: row.mode,
        nearMinPct: row.nearMinPct, nearMaxPct: row.nearMaxPct,
        ...gates,
      };
    case "rsi":
      return {
        rsiLength: row.rsiLength, target: row.indicatorTarget,
        rsiLevel: row.rsiLevel, rsiMaLength: row.rsiMaLength, mode: row.mode, ...gates,
      };
    case "macd":
      return {
        macdFast: row.macdFast, macdSlow: row.macdSlow, macdSignal: row.macdSignal,
        target: row.indicatorTarget, mode: row.mode, ...gates,
      };
    case "supertrend":
      return {
        stPeriod: row.stPeriod, stMultiplier: row.stMultiplier,
        stAtrMethod: row.stAtrMethod, mode: row.mode, ...gates,
      };
  }
}

/**
 * The body a partial edit should be read as, or null when the request touches
 * no condition field at all.
 *
 * Null is meaningful: a body of `{ enabled: false }` must keep taking the
 * narrow path, so pausing an alert never re-derives — and therefore can never
 * accidentally rewrite — its condition columns.
 */
export function mergeConditionRequest(
  row: MaAlertRow, body: Record<string, unknown>
): Record<string, unknown> | null {
  const allowed = EDITABLE_CONDITION_FIELDS[row.conditionKind];
  const provided = allowed.filter((key) => body[key] !== undefined);
  if (provided.length === 0) return null;

  const merged = alertRequestFromRow(row);
  for (const key of provided) merged[key] = body[key];

  // A gate is enabled by its checkbox OR by any of its values arriving; it is
  // removed only by an explicit `false`. Without the first rule a client that
  // sent just `filterRsiLevel` on an ungated alert would have it silently
  // dropped by `readFilters`; without the second, a gate could never be taken
  // off, because the merged body always still carries the row's own values.
  for (const [flag, keys] of [
    ["filterRsi", ["filterRsiLength", "filterRsiLevel", "filterRsiSide"]],
    ["filterMa", ["filterMaType", "filterMaLength", "filterMaSide"]],
    ["filterSt", [
      "filterStPeriod", "filterStMultiplier", "filterStAtrMethod", "filterStSide",
    ]],
  ] as const) {
    if (body[flag] === false) {
      delete merged[flag];
      for (const key of keys) delete merged[key];
    } else if (keys.some((key) => body[key] !== undefined)) {
      merged[flag] = true;
    }
  }
  return merged;
}

/** Whether the edit moved the reference `last_side` was recorded against. */
export function referenceChanged(
  kind: ConditionKind, before: MaAlertRow, after: AlertColumns
): boolean {
  return REFERENCE_COLUMNS[kind].some((column) => {
    const previous = (before as unknown as Record<string, unknown>)[column];
    const next = (after as unknown as Record<string, unknown>)[column];
    // Numeric columns come back from pg through `Number()`, so a strict compare
    // is safe here; both sides are already normalised to the row shape.
    return previous !== next;
  });
}
