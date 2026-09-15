import { pool, query } from "../db/pool";
import type { Interval } from "../types/market";
import type {
  BulkAlertAction, ConditionKind, MaAlertEventRow, MaAlertMode, MaAlertRow, MaType,
  PriceDirection, SrSide, StAtrMethod,
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
  st_period: number | null;
  st_multiplier: string | number | null;
  st_atr_method: string | null;
  bb_length: number | null;
  bb_mult: string | number | null;
  bb_band: string | null;
  bb_ma_type: MaType | null;
  stoch_k_length: number | null;
  stoch_k_smooth: number | null;
  stoch_d_smooth: number | null;
  stoch_level: string | number | null;
  adx_di_length: number | null;
  adx_smoothing: number | null;
  adx_level: string | number | null;
  indicator_target: string | null;
  filter_rsi_length: number | null;
  filter_rsi_level: string | number | null;
  filter_rsi_side: string | null;
  filter_ma_type: MaType | null;
  filter_ma_length: number | null;
  filter_ma_side: string | null;
  filter_st_period: number | null;
  filter_st_multiplier: string | number | null;
  filter_st_atr_method: string | null;
  filter_st_side: string | null;
  filters: unknown;
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
    stPeriod: r.st_period,
    stMultiplier: r.st_multiplier === null ? null : num(r.st_multiplier),
    stAtrMethod: r.st_atr_method,
    bbLength: r.bb_length,
    bbMult: r.bb_mult === null ? null : num(r.bb_mult),
    bbBand: r.bb_band,
    bbMaType: r.bb_ma_type,
    stochKLength: r.stoch_k_length,
    stochKSmooth: r.stoch_k_smooth,
    stochDSmooth: r.stoch_d_smooth,
    stochLevel: r.stoch_level === null ? null : num(r.stoch_level),
    adxDiLength: r.adx_di_length,
    adxSmoothing: r.adx_smoothing,
    adxLevel: r.adx_level === null ? null : num(r.adx_level),
    indicatorTarget: r.indicator_target,
    filterRsiLength: r.filter_rsi_length,
    filterRsiLevel: r.filter_rsi_level === null ? null : num(r.filter_rsi_level),
    filterRsiSide: r.filter_rsi_side,
    filterMaType: r.filter_ma_type,
    filterMaLength: r.filter_ma_length,
    filterMaSide: r.filter_ma_side,
    filterStPeriod: r.filter_st_period,
    filterStMultiplier:
      r.filter_st_multiplier === null ? null : num(r.filter_st_multiplier),
    filterStAtrMethod: r.filter_st_atr_method,
    filterStSide: r.filter_st_side,
    filters: r.filters,
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
  stPeriod?: number | null;
  stMultiplier?: number | null;
  stAtrMethod?: StAtrMethod | null;
  indicatorTarget?: string | null;
  filterRsiLength?: number | null;
  filterRsiLevel?: number | null;
  filterRsiSide?: string | null;
  filterMaType?: MaType | null;
  filterMaLength?: number | null;
  filterMaSide?: string | null;
  filterStPeriod?: number | null;
  filterStMultiplier?: number | null;
  filterStAtrMethod?: StAtrMethod | null;
  filterStSide?: string | null;
  /** The gates, in order. Stored as JSONB; authoritative since migration 032. */
  filters?: unknown;
  bbLength?: number | null;
  bbMult?: number | null;
  bbBand?: string | null;
  bbMaType?: MaType | null;
  stochKLength?: number | null;
  stochKSmooth?: number | null;
  stochDSmooth?: number | null;
  stochLevel?: number | null;
  adxDiLength?: number | null;
  adxSmoothing?: number | null;
  adxLevel?: number | null;
}

/**
 * The unique index that governs "the same alert" for each condition kind.
 *
 * These MUST match migration 036's indexes column for column. Postgres infers
 * the arbiter index from the column list, so a target that names a set no
 * index covers does not fall back to anything — it raises "there is no unique
 * or exclusion constraint matching the ON CONFLICT specification" on every
 * insert. Changing an index here without changing this list takes the create
 * route down completely, which is exactly what happened when 036 was written
 * and this was not.
 *
 * `filters` is the last column of each, because two alerts with the same
 * condition and different gates are two different questions — see 036.
 */
export const CONFLICT_TARGET: Record<ConditionKind, string> = {
  ma: "(symbol, timeframe, ma_type, ma_length, mode, filters) WHERE condition_kind = 'ma'",
  price:
    "(symbol, timeframe, target_price, price_direction, filters)" +
    " WHERE condition_kind = 'price'",
  ma_vs_ma:
    "(symbol, timeframe, ma_type, ma_length, ma2_type, ma2_length, mode, filters)" +
    " WHERE condition_kind = 'ma_vs_ma'",
  sr_zone:
    "(symbol, timeframe, sr_side, mode, filters) WHERE condition_kind = 'sr_zone'",
  pivot_level:
    "(symbol, timeframe, pivot_type, pivot_level_name, pivot_anchor, mode, filters)" +
    " WHERE condition_kind = 'pivot_level'",
  rsi:
    "(symbol, timeframe, rsi_length, indicator_target, rsi_level, rsi_ma_length," +
    " mode, filters) WHERE condition_kind = 'rsi'",
  macd:
    "(symbol, timeframe, macd_fast, macd_slow, macd_signal, indicator_target," +
    " mode, filters) WHERE condition_kind = 'macd'",
  supertrend:
    "(symbol, timeframe, st_period, st_multiplier, st_atr_method, mode, filters)" +
    " WHERE condition_kind = 'supertrend'",
  // Every band input is part of the key: an upper-band touch and a lower-band
  // touch are two alerts, and a 20/2 band and a 20/3 band are two lines.
  bollinger:
    "(symbol, timeframe, bb_length, bb_mult, bb_band, bb_ma_type, mode, filters)" +
    " WHERE condition_kind = 'bollinger'",
  stochastic:
    "(symbol, timeframe, stoch_k_length, stoch_k_smooth, stoch_d_smooth," +
    " indicator_target, stoch_level, mode, filters) WHERE condition_kind = 'stochastic'",
  adx:
    "(symbol, timeframe, adx_di_length, adx_smoothing, adx_level, mode, filters)" +
    " WHERE condition_kind = 'adx'",
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
        macd_fast, macd_slow, macd_signal, indicator_target,
        st_period, st_multiplier, st_atr_method,
        bb_length, bb_mult, bb_band, bb_ma_type,
        stoch_k_length, stoch_k_smooth, stoch_d_smooth, stoch_level,
        adx_di_length, adx_smoothing, adx_level,
        filter_rsi_length, filter_rsi_level, filter_rsi_side,
        filter_ma_type, filter_ma_length, filter_ma_side,
        filter_st_period, filter_st_multiplier, filter_st_atr_method, filter_st_side,
        filters)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
             $17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,
             $30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,
             $43,$44,$45,$46,$47,$48,$49,$50,$51,$52,$53,$54)
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
       st_period           = EXCLUDED.st_period,
       st_multiplier       = EXCLUDED.st_multiplier,
       st_atr_method       = EXCLUDED.st_atr_method,
       bb_length           = EXCLUDED.bb_length,
       bb_mult             = EXCLUDED.bb_mult,
       bb_band             = EXCLUDED.bb_band,
       bb_ma_type          = EXCLUDED.bb_ma_type,
       stoch_k_length      = EXCLUDED.stoch_k_length,
       stoch_k_smooth      = EXCLUDED.stoch_k_smooth,
       stoch_d_smooth      = EXCLUDED.stoch_d_smooth,
       stoch_level         = EXCLUDED.stoch_level,
       adx_di_length       = EXCLUDED.adx_di_length,
       adx_smoothing       = EXCLUDED.adx_smoothing,
       adx_level           = EXCLUDED.adx_level,
       filter_rsi_length   = EXCLUDED.filter_rsi_length,
       filter_rsi_level    = EXCLUDED.filter_rsi_level,
       filter_rsi_side     = EXCLUDED.filter_rsi_side,
       filter_ma_type      = EXCLUDED.filter_ma_type,
       filter_ma_length    = EXCLUDED.filter_ma_length,
       filter_ma_side      = EXCLUDED.filter_ma_side,
       filter_st_period    = EXCLUDED.filter_st_period,
       filter_st_multiplier = EXCLUDED.filter_st_multiplier,
       filter_st_atr_method = EXCLUDED.filter_st_atr_method,
       filter_st_side      = EXCLUDED.filter_st_side,
       filters             = EXCLUDED.filters,
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
      input.stPeriod ?? null, input.stMultiplier ?? null, input.stAtrMethod ?? null,
      input.bbLength ?? null, input.bbMult ?? null,
      input.bbBand ?? null, input.bbMaType ?? null,
      input.stochKLength ?? null, input.stochKSmooth ?? null,
      input.stochDSmooth ?? null, input.stochLevel ?? null,
      input.adxDiLength ?? null, input.adxSmoothing ?? null, input.adxLevel ?? null,
      input.filterRsiLength ?? null, input.filterRsiLevel ?? null,
      input.filterRsiSide ?? null,
      input.filterMaType ?? null, input.filterMaLength ?? null,
      input.filterMaSide ?? null,
      input.filterStPeriod ?? null, input.filterStMultiplier ?? null,
      input.filterStAtrMethod ?? null, input.filterStSide ?? null,
      JSON.stringify(input.filters ?? []),
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

/**
 * The rows for a set of ids, in whatever order the database returns them.
 *
 * One query rather than N `getAlert` calls: a bulk edit validates EVERY
 * selected row before writing any of them, and doing that a row at a time
 * would make the dry run cost as much as the write.
 *
 * Ids that do not exist are simply absent from the result — the caller
 * compares what it asked for against what came back, which is also how it
 * detects an alert deleted between the list and the edit.
 */
export async function listAlertsByIds(ids: string[]): Promise<MaAlertRow[]> {
  if (ids.length === 0) return [];
  const { rows } = await query<DbAlert>(
    "SELECT * FROM ma_alerts WHERE id = ANY($1::uuid[])", [ids]
  );
  return rows.map(toRow);
}

/**
 * What an edit may change.
 *
 * `conditionKind` is deliberately absent: an alert's FAMILY is fixed for its
 * lifetime. Turning an RSI alert into a MACD one would keep the id and the
 * event log while making every historical row in that log describe something
 * the alert no longer is, and every unique index in the schema is per-kind, so
 * the "same alert" rule would change underneath a live row.
 */
export type MaAlertPatch = Partial<Omit<MaAlertInput, "conditionKind">> & {
  /**
   * Forget which side of its reference the alert last sat on, so the next
   * evaluation re-seeds instead of comparing against a reference that no longer
   * exists. Set by the API when an edit moves the reference — see
   * `alerts/alertEdit.ts`, and the seeding rule at the top of
   * `alerts/alertConditions.ts`.
   */
  resetLastSide?: boolean;
};

/** Patch key → column, for every field an edit may write. */
const PATCH_COLUMNS: Record<string, string> = {
  symbol: "symbol",
  timeframe: "timeframe",
  enabled: "enabled",
  frequency: "frequency",
  cooldownMin: "cooldown_min",
  note: "note",
  nearMinPct: "near_min_pct",
  nearMaxPct: "near_max_pct",
  maType: "ma_type",
  maLength: "ma_length",
  mode: "mode",
  ma2Type: "ma2_type",
  ma2Length: "ma2_length",
  targetPrice: "target_price",
  priceDirection: "price_direction",
  srSide: "sr_side",
  srPivotLength: "sr_pivot_length",
  srInvalidation: "sr_invalidation",
  pivotType: "pivot_type",
  pivotLevelName: "pivot_level_name",
  pivotAnchor: "pivot_anchor",
  rsiLength: "rsi_length",
  rsiLevel: "rsi_level",
  rsiMaLength: "rsi_ma_length",
  macdFast: "macd_fast",
  macdSlow: "macd_slow",
  macdSignal: "macd_signal",
  indicatorTarget: "indicator_target",
  stPeriod: "st_period",
  stMultiplier: "st_multiplier",
  stAtrMethod: "st_atr_method",
  filterRsiLength: "filter_rsi_length",
  filterRsiLevel: "filter_rsi_level",
  filterRsiSide: "filter_rsi_side",
  filterMaType: "filter_ma_type",
  filterMaLength: "filter_ma_length",
  filterMaSide: "filter_ma_side",
  filterStPeriod: "filter_st_period",
  filterStMultiplier: "filter_st_multiplier",
  filterStAtrMethod: "filter_st_atr_method",
  filterStSide: "filter_st_side",
  filters: "filters",
};

/**
 * An edit that would collide with another alert on the same per-kind unique
 * index.
 *
 * Distinguished from a generic failure because the answer is different: the
 * user has not sent something invalid, they have described an alert that
 * already exists, and merging them silently would delete one of the two.
 */
export class AlertConflictError extends Error {
  constructor(
    message = "another alert already watches this condition with the same filters "
      + "— change a filter, or edit the existing alert"
  ) {
    super(message);
    this.name = "AlertConflictError";
  }
}

/**
 * Update one alert in place, keeping its id, its event history and its
 * delivery state.
 *
 * In place rather than delete-and-recreate: the id is the foreign key
 * `ma_alert_events` hangs off, and it is what `once_only` retirement,
 * `last_fired_bar_time` de-duplication and the observability of "has this
 * alert ever reached a phone?" are all recorded against.
 */
export async function updateAlert(id: string, patch: MaAlertPatch): Promise<MaAlertRow | null> {
  const cols: Record<string, unknown> = {};
  for (const [key, column] of Object.entries(PATCH_COLUMNS)) {
    const value = (patch as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (key === "symbol") { cols[column] = String(value).toUpperCase(); continue; }
    /*
     * `filters` is jsonb. node-pg renders a JS array as a Postgres ARRAY
     * literal — `{...}` — which jsonb rejects, so the gates must be serialised
     * here rather than handed over as an array. Missing this stores nothing
     * and fails loudly, which is the good case; the bad case would be a driver
     * that coerced it into something jsonb accepted but nobody meant.
     */
    cols[column] = key === "filters" ? JSON.stringify(value ?? []) : value;
  }
  // Re-enabling a retired once_only alert must actually re-arm it. Otherwise the
  // UI shows an enabled alert that can never fire.
  if (patch.enabled === true) cols.completed_at = null;
  if (patch.resetLastSide) cols.last_side = null;
  const keys = Object.keys(cols);
  if (keys.length === 0) return getAlert(id);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`);
  try {
    const { rows } = await query<DbAlert>(
      `UPDATE ma_alerts SET ${sets.join(", ")}, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id, ...keys.map((k) => cols[k])]
    );
    return rows[0] ? toRow(rows[0]) : null;
  } catch (error) {
    // 23505 = unique_violation: the edited configuration is already armed on
    // another row.
    if ((error as { code?: string }).code === "23505") throw new AlertConflictError();
    throw error;
  }
}

export async function deleteAlert(id: string): Promise<boolean> {
  const { rowCount } = await query("DELETE FROM ma_alerts WHERE id = $1", [id]);
  return (rowCount ?? 0) > 0;
}

export interface BulkAlertResult {
  action: BulkAlertAction;
  requested: number;
  affected: number;
  missingIds: string[];
}

/**
 * Apply one action to an explicit, already-deduplicated set of alert IDs.
 *
 * The authenticated API is a single-admin scope; there is deliberately no
 * invented user/tenant column. Locking and validating every row before the
 * write makes the operation atomic: a stale or foreign-to-scope ID changes
 * nothing, so the UI can never report a partly-applied bulk action as success.
 */
export async function bulkActAlerts(
  ids: string[], action: BulkAlertAction
): Promise<BulkAlertResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query<{ id: string }>(
      "SELECT id::text AS id FROM ma_alerts WHERE id = ANY($1::uuid[]) FOR UPDATE",
      [ids]
    );
    const foundIds = new Set(found.rows.map((row) => row.id));
    const missingIds = ids.filter((id) => !foundIds.has(id));
    if (missingIds.length > 0) {
      await client.query("ROLLBACK");
      return { action, requested: ids.length, affected: 0, missingIds };
    }

    const result = action === "delete"
      ? await client.query("DELETE FROM ma_alerts WHERE id = ANY($1::uuid[])", [ids])
      : await client.query(
          `UPDATE ma_alerts
             SET enabled = $2,
                 completed_at = CASE WHEN $2 THEN NULL ELSE completed_at END,
                 updated_at = now()
           WHERE id = ANY($1::uuid[])`,
          [ids, action === "resume"]
        );
    await client.query("COMMIT");
    return {
      action,
      requested: ids.length,
      affected: result.rowCount ?? 0,
      missingIds: [],
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
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
  pushFailed: number;
  pushPruned: number;
  deliveryStatus: MaAlertEventRow["deliveryStatus"];
  intrabar: boolean;
  frequency: AlertFrequency;
}): Promise<void> {
  await query(
    `INSERT INTO ma_alert_events
       (alert_id, bar_time, price, ma_value, distance_pct, title, body,
        pushed_to, push_failed, push_pruned, delivery_status, intrabar, frequency)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      input.alertId, new Date(input.barTime), input.price, input.maValue,
      input.distancePct, input.title, input.body, input.pushedTo,
      input.pushFailed, input.pushPruned, input.deliveryStatus,
      input.intrabar, input.frequency,
    ]
  );
}

interface DbEvent {
  id: string; alert_id: string; fired_at: Date; bar_time: Date;
  price: string; ma_value: string; distance_pct: string;
  title: string; body: string; pushed_to: number;
  push_failed: number; push_pruned: number;
  delivery_status: MaAlertEventRow["deliveryStatus"];
  intrabar: boolean; frequency: AlertFrequency | null;
}

/**
 * The newest delivered events, optionally for one instrument and timeframe.
 *
 * The filter matters for the chart's fired-alert marks. Without it this is the
 * newest N events across EVERY alert on the account, so a user with busy
 * alerts elsewhere pushes this chart's events out of the window — and the
 * chart, seeing none, was stating that none had fired. That is a negative the
 * client cannot know. Filtering in SQL makes "the newest 200 for this chart"
 * true, so the absence of a mark means what the copy says it means.
 *
 * The join is on the alert rather than on a column of the event, because an
 * event records what fired, not what it was armed on; the alert owns that.
 */
export async function listEvents(
  limit = 100, scope?: { symbol: string; timeframe: string }
): Promise<MaAlertEventRow[]> {
  if (scope) {
    const { rows } = await query<DbEvent>(
      `SELECT e.* FROM ma_alert_events e
         JOIN ma_alerts a ON a.id = e.alert_id
        WHERE upper(a.symbol) = upper($2) AND a.timeframe = $3
        ORDER BY e.fired_at DESC
        LIMIT $1`,
      [Math.min(Math.max(limit, 1), 500), scope.symbol, scope.timeframe]
    );
    return rows.map(toEventRow);
  }
  const { rows } = await query<DbEvent>(
    "SELECT * FROM ma_alert_events ORDER BY fired_at DESC LIMIT $1",
    [Math.min(Math.max(limit, 1), 500)]
  );
  return rows.map(toEventRow);
}

function toEventRow(r: DbEvent): MaAlertEventRow {
  return {
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
    pushFailed: r.push_failed,
    pushPruned: r.push_pruned,
    deliveryStatus: r.delivery_status,
    intrabar: r.intrabar,
    frequency: r.frequency,
  };
}
