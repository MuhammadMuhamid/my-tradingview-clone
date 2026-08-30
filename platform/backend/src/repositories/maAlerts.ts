import { query } from "../db/pool";
import type { Interval } from "../types/market";
import type {
  ConditionKind, MaAlertEventRow, MaAlertMode, MaAlertRow, MaType, PriceDirection,
  SrSide,
} from "../types/maAlerts";
import type { AlertFrequency } from "../alerts/alertFrequency";

interface DbAlert {
  id: string;
  symbol: string;
  timeframe: Interval;
  condition_kind: ConditionKind;
  ma_type: MaType | null;
  ma_length: number | null;
  mode: MaAlertMode | null;
  ma2_type: MaType | null;
  ma2_length: number | null;
  target_price: string | number | null;
  price_direction: PriceDirection | null;
  sr_side: SrSide | null;
  sr_pivot_length: number | null;
  sr_invalidation: string | null;
  pivot_type: string | null;
  pivot_level_name: string | null;
  pivot_anchor: string | null;
  rsi_length: number | null;
  rsi_level: string | number | null;
  rsi_ma_length: number | null;
  macd_fast: number | null;
  macd_slow: number | null;
  macd_signal: number | null;
  indicator_target: string | null;
  near_min_pct: string | number;
  near_max_pct: string | number;
  enabled: boolean;
  frequency: AlertFrequency;
  cooldown_min: number;
  note: string | null;
  last_side: "above" | "below" | null;
  last_fired_at: Date | null;
  last_fired_bar_time: Date | null;
  last_bar_time: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

// pg returns numeric as string to preserve precision; these are display-scale
// percentages, so Number() is safe and keeps the API shape numeric.
const num = (v: string | number): number => (typeof v === "number" ? v : Number(v));
const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

function toRow(r: DbAlert): MaAlertRow {
  return {
    id: r.id,
    symbol: r.symbol,
    timeframe: r.timeframe,
    conditionKind: r.condition_kind,
    maType: r.ma_type,
    maLength: r.ma_length,
    mode: r.mode,
    ma2Type: r.ma2_type,
    ma2Length: r.ma2_length,
    targetPrice: r.target_price === null ? null : num(r.target_price),
    priceDirection: r.price_direction,
    rsiLength: r.rsi_length,
    rsiLevel: r.rsi_level === null ? null : num(r.rsi_level),
    rsiMaLength: r.rsi_ma_length,
    macdFast: r.macd_fast,
    macdSlow: r.macd_slow,
    macdSignal: r.macd_signal,
    indicatorTarget: r.indicator_target,
    srSide: r.sr_side,
    srPivotLength: r.sr_pivot_length,
    srInvalidation: r.sr_invalidation,
    pivotType: r.pivot_type,
    pivotLevelName: r.pivot_level_name,
    pivotAnchor: r.pivot_anchor,
    nearMinPct: num(r.near_min_pct),
    nearMaxPct: num(r.near_max_pct),
    enabled: r.enabled,
    frequency: r.frequency,
    cooldownMin: r.cooldown_min,
    note: r.note,
    lastSide: r.last_side,
    lastFiredAt: iso(r.last_fired_at),
    lastFiredBarTime: iso(r.last_fired_bar_time),
    lastBarTime: iso(r.last_bar_time),
    completedAt: iso(r.completed_at),
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

export interface MaAlertInput {
  symbol: string;
  timeframe: Interval;
  conditionKind?: ConditionKind;
  maType?: MaType | null;
  maLength?: number | null;
  mode?: MaAlertMode | null;
  ma2Type?: MaType | null;
  ma2Length?: number | null;
  targetPrice?: number | null;
  priceDirection?: PriceDirection | null;
  nearMinPct?: number;
  nearMaxPct?: number;
  enabled?: boolean;
  frequency?: AlertFrequency;
  cooldownMin?: number;
  note?: string | null;
  srSide?: SrSide | null;
  srPivotLength?: number | null;
  srInvalidation?: string | null;
  pivotType?: string | null;
  pivotLevelName?: string | null;
  pivotAnchor?: string | null;
  rsiLength?: number | null;
  rsiLevel?: number | null;
  rsiMaLength?: number | null;
  macdFast?: number | null;
  macdSlow?: number | null;
  macdSignal?: number | null;
  indicatorTarget?: string | null;
}

/** The unique index that governs "the same alert" for each condition kind. */
const CONFLICT_TARGET: Record<ConditionKind, string> = {
  ma: "(symbol, timeframe, ma_type, ma_length, mode) WHERE condition_kind = 'ma'",
  price: "(symbol, timeframe, target_price, price_direction) WHERE condition_kind = 'price'",
  ma_vs_ma:
    "(symbol, timeframe, ma_type, ma_length, ma2_type, ma2_length, mode)" +
    " WHERE condition_kind = 'ma_vs_ma'",
  sr_zone: "(symbol, timeframe, sr_side, mode) WHERE condition_kind = 'sr_zone'",
  pivot_level:
    "(symbol, timeframe, pivot_type, pivot_level_name, pivot_anchor, mode)" +
    " WHERE condition_kind = 'pivot_level'",
  rsi:
    "(symbol, timeframe, rsi_length, indicator_target, rsi_level, rsi_ma_length, mode)" +
    " WHERE condition_kind = 'rsi'",
  macd:
    "(symbol, timeframe, macd_fast, macd_slow, macd_signal, indicator_target, mode)" +
    " WHERE condition_kind = 'macd'",
};

/**
 * Upsert on whatever identifies "the same alert" for this kind. Arming the same
 * line, or the same price, twice edits the existing alert rather than creating a
 * duplicate that would double-notify.
 *
 * Re-arming also CLEARS the completion and firing state: a user who re-arms a
 * spent once_only alert means "watch this again", and leaving `completed_at` set
 * would hand them an alert that looks armed and can never fire.
 */
export async function upsertAlert(input: MaAlertInput): Promise<MaAlertRow> {
  const kind = input.conditionKind ?? "ma";
  const { rows } = await query<DbAlert>(
    `INSERT INTO ma_alerts
       (symbol, timeframe, condition_kind, ma_type, ma_length, mode,
        ma2_type, ma2_length, target_price, price_direction,
        near_min_pct, near_max_pct, enabled, frequency, cooldown_min, note,
        sr_side, sr_pivot_length, sr_invalidation,
        pivot_type, pivot_level_name, pivot_anchor,
        rsi_length, rsi_level, rsi_ma_length,
        macd_fast, macd_slow, macd_signal, indicator_target)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
             $17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)
     ON CONFLICT ${CONFLICT_TARGET[kind]} DO UPDATE SET
       near_min_pct        = EXCLUDED.near_min_pct,
       near_max_pct        = EXCLUDED.near_max_pct,
       enabled             = EXCLUDED.enabled,
       frequency           = EXCLUDED.frequency,
       cooldown_min        = EXCLUDED.cooldown_min,
       note                = EXCLUDED.note,
       ma2_type            = EXCLUDED.ma2_type,
       ma2_length          = EXCLUDED.ma2_length,
       sr_side             = EXCLUDED.sr_side,
       sr_pivot_length     = EXCLUDED.sr_pivot_length,
       sr_invalidation     = EXCLUDED.sr_invalidation,
       pivot_type          = EXCLUDED.pivot_type,
       pivot_level_name    = EXCLUDED.pivot_level_name,
       pivot_anchor        = EXCLUDED.pivot_anchor,
       rsi_length          = EXCLUDED.rsi_length,
       rsi_level           = EXCLUDED.rsi_level,
       rsi_ma_length       = EXCLUDED.rsi_ma_length,
       macd_fast           = EXCLUDED.macd_fast,
       macd_slow           = EXCLUDED.macd_slow,
       macd_signal         = EXCLUDED.macd_signal,
       indicator_target    = EXCLUDED.indicator_target,
       completed_at        = NULL,
       last_fired_at       = NULL,
       last_fired_bar_time = NULL,
       updated_at          = now()
     RETURNING *`,
    [
      input.symbol.toUpperCase(), input.timeframe, kind,
      input.maType ?? null, input.maLength ?? null, input.mode ?? null,
      input.ma2Type ?? null, input.ma2Length ?? null,
      input.targetPrice ?? null, input.priceDirection ?? null,
      input.nearMinPct ?? 0.2, input.nearMaxPct ?? 0.5,
      input.enabled ?? true, input.frequency ?? "once_per_bar_close",
      input.cooldownMin ?? 60, input.note ?? null,
      input.srSide ?? null, input.srPivotLength ?? null, input.srInvalidation ?? null,
      input.pivotType ?? null, input.pivotLevelName ?? null, input.pivotAnchor ?? null,
      input.rsiLength ?? null, input.rsiLevel ?? null, input.rsiMaLength ?? null,
      input.macdFast ?? null, input.macdSlow ?? null, input.macdSignal ?? null,
      input.indicatorTarget ?? null,
    ]
  );
  return toRow(rows[0]!);
}

export async function listAlerts(opts: {
  symbol?: string;
  timeframe?: Interval;
  /** Only alerts the runner should be watching: enabled and not yet retired. */
  activeOnly?: boolean;
} = {}): Promise<MaAlertRow[]> {
  const params: unknown[] = [];
  const where: string[] = [];
  if (opts.symbol) { params.push(opts.symbol.toUpperCase()); where.push(`symbol = $${params.length}`); }
  if (opts.timeframe) { params.push(opts.timeframe); where.push(`timeframe = $${params.length}`); }
  // A spent once_only alert is not something the runner should still subscribe
  // a websocket stream for.
  if (opts.activeOnly) where.push("enabled AND completed_at IS NULL");
  const { rows } = await query<DbAlert>(
    `SELECT * FROM ma_alerts ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY symbol, timeframe, condition_kind, ma_length DESC NULLS LAST, target_price NULLS LAST`,
    params
  );
  return rows.map(toRow);
}

export async function getAlert(id: string): Promise<MaAlertRow | null> {
  const { rows } = await query<DbAlert>("SELECT * FROM ma_alerts WHERE id = $1", [id]);
  return rows[0] ? toRow(rows[0]) : null;
}

export type MaAlertPatch = Partial<Pick<MaAlertInput,
  | "enabled" | "cooldownMin" | "nearMinPct" | "nearMaxPct" | "note"
  | "mode" | "timeframe" | "frequency" | "targetPrice" | "priceDirection"
>>;

export async function updateAlert(id: string, patch: MaAlertPatch): Promise<MaAlertRow | null> {
  const cols: Record<string, unknown> = {};
  if (patch.enabled !== undefined) cols.enabled = patch.enabled;
  if (patch.cooldownMin !== undefined) cols.cooldown_min = patch.cooldownMin;
  if (patch.nearMinPct !== undefined) cols.near_min_pct = patch.nearMinPct;
  if (patch.nearMaxPct !== undefined) cols.near_max_pct = patch.nearMaxPct;
  if (patch.note !== undefined) cols.note = patch.note;
  if (patch.mode !== undefined) cols.mode = patch.mode;
  if (patch.timeframe !== undefined) cols.timeframe = patch.timeframe;
  if (patch.frequency !== undefined) cols.frequency = patch.frequency;
  if (patch.targetPrice !== undefined) cols.target_price = patch.targetPrice;
  if (patch.priceDirection !== undefined) cols.price_direction = patch.priceDirection;
  // Re-enabling a retired once_only alert must actually re-arm it. Otherwise the
  // UI shows an enabled alert that can never fire.
  if (patch.enabled === true) cols.completed_at = null;
  const keys = Object.keys(cols);
  if (keys.length === 0) return getAlert(id);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`);
  const { rows } = await query<DbAlert>(
    `UPDATE ma_alerts SET ${sets.join(", ")}, updated_at = now()
     WHERE id = $1 RETURNING *`,
    [id, ...keys.map((k) => cols[k])]
  );
  return rows[0] ? toRow(rows[0]) : null;
}

export async function deleteAlert(id: string): Promise<boolean> {
  const { rowCount } = await query("DELETE FROM ma_alerts WHERE id = $1", [id]);
  return (rowCount ?? 0) > 0;
}

/**
 * Persist everything one evaluation decided, in a single write.
 *
 * All of it in one statement is deliberate: the cross side, the fired-bar cap
 * and the retirement flag are one consistent view of "what this alert has seen".
 * Splitting them would let a crash between writes leave an alert that has
 * notified but does not remember doing so — which is a duplicate notification on
 * the next tick.
 */
export async function recordEvaluation(input: {
  id: string;
  side: "above" | "below" | null;
  barTime: number;
  fired: boolean;
  /** Retire a once_only alert. Only ever true after a successful delivery. */
  complete: boolean;
}): Promise<void> {
  await query(
    `UPDATE ma_alerts
       SET last_side           = $2,
           last_bar_time       = $3,
           last_fired_at       = CASE WHEN $4 THEN now() ELSE last_fired_at END,
           last_fired_bar_time = CASE WHEN $4 THEN $3 ELSE last_fired_bar_time END,
           completed_at        = CASE WHEN $5 THEN now() ELSE completed_at END
     WHERE id = $1`,
    [input.id, input.side, new Date(input.barTime), input.fired, input.complete]
  );
}

export async function createEvent(input: {
  alertId: string;
  barTime: number;
  price: number;
  maValue: number;
  distancePct: number;
  title: string;
  body: string;
  pushedTo: number;
  intrabar: boolean;
  frequency: AlertFrequency;
}): Promise<void> {
  await query(
    `INSERT INTO ma_alert_events
       (alert_id, bar_time, price, ma_value, distance_pct, title, body,
        pushed_to, intrabar, frequency)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      input.alertId, new Date(input.barTime), input.price, input.maValue,
      input.distancePct, input.title, input.body, input.pushedTo,
      input.intrabar, input.frequency,
    ]
  );
}

interface DbEvent {
  id: string; alert_id: string; fired_at: Date; bar_time: Date;
  price: string; ma_value: string; distance_pct: string;
  title: string; body: string; pushed_to: number;
  intrabar: boolean; frequency: AlertFrequency | null;
}

export async function listEvents(limit = 100): Promise<MaAlertEventRow[]> {
  const { rows } = await query<DbEvent>(
    "SELECT * FROM ma_alert_events ORDER BY fired_at DESC LIMIT $1",
    [Math.min(Math.max(limit, 1), 500)]
  );
  return rows.map((r) => ({
    id: Number(r.id),
    alertId: r.alert_id,
    firedAt: r.fired_at.toISOString(),
    barTime: r.bar_time.toISOString(),
    price: num(r.price),
    maValue: num(r.ma_value),
    distancePct: num(r.distance_pct),
    title: r.title,
    body: r.body,
    pushedTo: r.pushed_to,
    intrabar: r.intrabar,
    frequency: r.frequency,
  }));
}
