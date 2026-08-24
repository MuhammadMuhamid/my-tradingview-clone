import { query } from "../db/pool";
import type { Interval } from "../types/market";
import type {
  MaAlertEventRow, MaAlertMode, MaAlertRow, MaType, TriggerMode,
} from "../types/maAlerts";

interface DbAlert {
  id: string;
  symbol: string;
  timeframe: Interval;
  ma_type: MaType;
  ma_length: number;
  mode: MaAlertMode;
  near_min_pct: string | number;
  near_max_pct: string | number;
  enabled: boolean;
  cooldown_min: number;
  note: string | null;
  trigger_mode: TriggerMode;
  last_side: "above" | "below" | null;
  last_fired_at: Date | null;
  last_fired_bar_time: Date | null;
  created_at: Date;
  updated_at: Date;
}

// pg returns numeric as string to preserve precision; these are display-scale
// percentages, so Number() is safe and keeps the API shape numeric.
const num = (v: string | number): number => (typeof v === "number" ? v : Number(v));

function toRow(r: DbAlert): MaAlertRow {
  return {
    id: r.id,
    symbol: r.symbol,
    timeframe: r.timeframe,
    maType: r.ma_type,
    maLength: r.ma_length,
    mode: r.mode,
    nearMinPct: num(r.near_min_pct),
    nearMaxPct: num(r.near_max_pct),
    enabled: r.enabled,
    cooldownMin: r.cooldown_min,
    note: r.note,
    trigger: r.trigger_mode,
    lastSide: r.last_side,
    lastFiredAt: r.last_fired_at ? r.last_fired_at.toISOString() : null,
    lastFiredBarTime: r.last_fired_bar_time ? r.last_fired_bar_time.toISOString() : null,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

export interface MaAlertInput {
  symbol: string;
  timeframe: Interval;
  maType: MaType;
  maLength: number;
  mode: MaAlertMode;
  nearMinPct?: number;
  nearMaxPct?: number;
  enabled?: boolean;
  cooldownMin?: number;
  note?: string | null;
  trigger?: TriggerMode;
}

/**
 * Upsert on (symbol, timeframe, ma, mode). Arming the same line twice edits the
 * existing alert rather than creating a duplicate that would double-notify.
 */
export async function upsertAlert(input: MaAlertInput): Promise<MaAlertRow> {
  const { rows } = await query<DbAlert>(
    `INSERT INTO ma_alerts
       (symbol, timeframe, ma_type, ma_length, mode,
        near_min_pct, near_max_pct, enabled, cooldown_min, note, trigger_mode)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (symbol, timeframe, ma_type, ma_length, mode) DO UPDATE SET
       near_min_pct = EXCLUDED.near_min_pct,
       near_max_pct = EXCLUDED.near_max_pct,
       enabled      = EXCLUDED.enabled,
       cooldown_min = EXCLUDED.cooldown_min,
       note         = EXCLUDED.note,
       trigger_mode = EXCLUDED.trigger_mode,
       updated_at   = now()
     RETURNING *`,
    [
      input.symbol.toUpperCase(), input.timeframe, input.maType, input.maLength,
      input.mode, input.nearMinPct ?? 0.2, input.nearMaxPct ?? 0.5,
      input.enabled ?? true, input.cooldownMin ?? 60, input.note ?? null,
      input.trigger ?? "once_per_bar_close",
    ]
  );
  return toRow(rows[0]!);
}

export async function listAlerts(opts: {
  symbol?: string;
  timeframe?: Interval;
  enabledOnly?: boolean;
} = {}): Promise<MaAlertRow[]> {
  const params: unknown[] = [];
  const where: string[] = [];
  if (opts.symbol) { params.push(opts.symbol.toUpperCase()); where.push(`symbol = $${params.length}`); }
  if (opts.timeframe) { params.push(opts.timeframe); where.push(`timeframe = $${params.length}`); }
  if (opts.enabledOnly) where.push("enabled");
  const { rows } = await query<DbAlert>(
    `SELECT * FROM ma_alerts ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY symbol, timeframe, ma_length DESC, ma_type`,
    params
  );
  return rows.map(toRow);
}

export async function getAlert(id: string): Promise<MaAlertRow | null> {
  const { rows } = await query<DbAlert>("SELECT * FROM ma_alerts WHERE id = $1", [id]);
  return rows[0] ? toRow(rows[0]) : null;
}

export async function updateAlert(
  id: string,
  patch: Partial<Pick<MaAlertInput, "enabled" | "cooldownMin" | "nearMinPct" | "nearMaxPct" | "note" | "mode" | "timeframe" | "trigger">>
): Promise<MaAlertRow | null> {
  const cols: Record<string, unknown> = {};
  if (patch.enabled !== undefined) cols.enabled = patch.enabled;
  if (patch.cooldownMin !== undefined) cols.cooldown_min = patch.cooldownMin;
  if (patch.nearMinPct !== undefined) cols.near_min_pct = patch.nearMinPct;
  if (patch.nearMaxPct !== undefined) cols.near_max_pct = patch.nearMaxPct;
  if (patch.note !== undefined) cols.note = patch.note;
  if (patch.mode !== undefined) cols.mode = patch.mode;
  if (patch.timeframe !== undefined) cols.timeframe = patch.timeframe;
  if (patch.trigger !== undefined) cols.trigger_mode = patch.trigger;
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
 * Persist cross-detection state, the cooldown clock and the fired-bar stamp in
 * one write.
 *
 * `disable` implements the "Once only" trigger: the alert switches itself off
 * after firing, exactly as TradingView retires a one-shot alert.
 */
export async function recordEvaluation(
  id: string,
  opts: {
    side?: "above" | "below" | null;
    fired: boolean;
    barTime?: number | null;
    disable?: boolean;
  }
): Promise<void> {
  await query(
    `UPDATE ma_alerts
       SET last_side = COALESCE($2, last_side),
           last_fired_at = CASE WHEN $3 THEN now() ELSE last_fired_at END,
           last_fired_bar_time = CASE WHEN $3 AND $4::timestamptz IS NOT NULL
                                      THEN $4 ELSE last_fired_bar_time END,
           enabled = CASE WHEN $5 THEN false ELSE enabled END
     WHERE id = $1`,
    [
      id,
      opts.side ?? null,
      opts.fired,
      opts.barTime != null ? new Date(opts.barTime) : null,
      opts.disable ?? false,
    ]
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
}): Promise<void> {
  await query(
    `INSERT INTO ma_alert_events
       (alert_id, bar_time, price, ma_value, distance_pct, title, body, pushed_to)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      input.alertId, new Date(input.barTime), input.price, input.maValue,
      input.distancePct, input.title, input.body, input.pushedTo,
    ]
  );
}

interface DbEvent {
  id: string; alert_id: string; fired_at: Date; bar_time: Date;
  price: string; ma_value: string; distance_pct: string;
  title: string; body: string; pushed_to: number;
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
  }));
}
