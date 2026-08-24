/**
 * Persistence for the live-safety layer: durable order intent, risk controls,
 * the realised-P&L ledger, the single-emitter lease and feed health.
 *
 * Every function here is a thin wrapper over one statement. The decisions live
 * in `engine/riskControls.ts` and `data/feedHealth.ts`, which are pure and
 * tested; this file exists so that only one place writes SQL.
 */
import { query } from "../db/pool";
import type { RiskLimits, HaltSource } from "../engine/riskControls";
import { DEFAULT_RISK_LIMITS } from "../engine/riskControls";
import type { FeedState } from "../data/feedHealth";
import type { DeliveryRow } from "../engine/deliveryHealth";

// ── Order intent (BE-13, BE-16) ─────────────────────────────────────────────

export type IntentState =
  | "pending"
  | "delivered"
  | "duplicate"
  | "blocked"
  | "rejected"
  | "failed"
  | "stale";

export interface OrderIntent {
  id: number;
  deploymentId: string;
  alertId: number | null;
  dedupeKey: string;
  action: "buy" | "sell";
  barTime: number;
  exitLeg: string | null;
  state: IntentState;
  resolvedAt: number | null;
  detail: string | null;
  emitterId: string | null;
  createdAt: number;
}

interface DbIntent {
  id: number;
  deployment_id: string;
  alert_id: number | null;
  dedupe_key: string;
  action: "buy" | "sell";
  bar_time: Date;
  exit_leg: string | null;
  state: IntentState;
  resolved_at: Date | null;
  detail: string | null;
  emitter_id: string | null;
  created_at: Date;
}

const toIntent = (r: DbIntent): OrderIntent => ({
  id: r.id,
  deploymentId: r.deployment_id,
  alertId: r.alert_id,
  dedupeKey: r.dedupe_key,
  action: r.action,
  barTime: r.bar_time.getTime(),
  exitLeg: r.exit_leg,
  state: r.state,
  resolvedAt: r.resolved_at ? r.resolved_at.getTime() : null,
  detail: r.detail,
  emitterId: r.emitter_id,
  createdAt: r.created_at.getTime(),
});

export type ClaimResult =
  | { claimed: true; intent: OrderIntent }
  | { claimed: false; existing: OrderIntent };

/**
 * Claim the right to attempt one logical order, BEFORE delivering it.
 *
 * `INSERT … ON CONFLICT DO NOTHING RETURNING` makes the unique index the
 * authority, so two processes racing on the same bar cannot both proceed. The
 * previous guard was a read (`dedupeKeyExists`) followed by a write, which is a
 * TOCTOU against that same index — and it reported a skip to the caller as
 * "accepted", advancing runtime state with no order placed (BE-16).
 *
 * When the claim fails, the caller gets the EXISTING row and can see what
 * happened to it. That distinction — "already delivered" versus "key exists but
 * delivery failed" — is what BE-16 asked for and what the old boolean could not
 * express.
 */
export async function claimIntent(input: {
  deploymentId: string;
  dedupeKey: string;
  action: "buy" | "sell";
  barTime: number;
  exitLeg?: string | null;
  emitterId?: string | null;
}): Promise<ClaimResult> {
  const { rows } = await query<DbIntent>(
    `INSERT INTO order_intents
       (deployment_id, dedupe_key, action, bar_time, exit_leg, emitter_id, state)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending')
     ON CONFLICT (deployment_id, dedupe_key) DO NOTHING
     RETURNING *`,
    [
      input.deploymentId,
      input.dedupeKey,
      input.action,
      new Date(input.barTime),
      input.exitLeg ?? null,
      input.emitterId ?? null,
    ]
  );
  if (rows[0]) return { claimed: true, intent: toIntent(rows[0]) };

  const { rows: existing } = await query<DbIntent>(
    "SELECT * FROM order_intents WHERE deployment_id = $1 AND dedupe_key = $2",
    [input.deploymentId, input.dedupeKey]
  );
  // The conflicting row must exist — the index is what refused the insert.
  return { claimed: false, existing: toIntent(existing[0]!) };
}

/** Attach the alert row once it has been created, for the audit trail. */
export async function linkIntentAlert(intentId: number, alertId: number): Promise<void> {
  await query("UPDATE order_intents SET alert_id = $2 WHERE id = $1", [intentId, alertId]);
}

/** Resolve an intent after delivery. Only a pending intent may be resolved. */
export async function resolveIntent(
  intentId: number,
  state: Exclude<IntentState, "pending">,
  detail?: string
): Promise<void> {
  await query(
    `UPDATE order_intents
        SET state = $2, detail = $3, resolved_at = now()
      WHERE id = $1 AND state = 'pending'`,
    [intentId, state, detail ?? null]
  );
}

/**
 * Intents left pending by a process that died mid-delivery.
 *
 * On restart these are orders whose outcome is UNKNOWN: the request may have
 * reached the receiver and placed an order, or it may not. Re-firing is the one
 * thing that must not happen, which is why the row exists at all.
 */
export async function listUnresolvedIntents(deploymentId?: string): Promise<OrderIntent[]> {
  const { rows } = await query<DbIntent>(
    deploymentId
      ? "SELECT * FROM order_intents WHERE state = 'pending' AND deployment_id = $1 ORDER BY created_at"
      : "SELECT * FROM order_intents WHERE state = 'pending' ORDER BY created_at",
    deploymentId ? [deploymentId] : []
  );
  return rows.map(toIntent);
}

// ── Risk controls (BE-11) ───────────────────────────────────────────────────

interface DbRisk {
  trading_halted: boolean;
  halted_reason: string | null;
  halted_by: HaltSource | null;
  max_total_exposure_quote: string | number | null;
  max_concurrent_positions: number | null;
  max_daily_loss_quote: string | number | null;
  daily_loss_window_hours: number;
}

const num = (v: string | number | null): number | null =>
  v === null ? null : typeof v === "number" ? v : Number(v);

export async function getRiskLimits(): Promise<RiskLimits> {
  const { rows } = await query<DbRisk>("SELECT * FROM risk_controls WHERE id = 1");
  const r = rows[0];
  if (!r) return { ...DEFAULT_RISK_LIMITS };
  return {
    tradingHalted: r.trading_halted,
    haltedReason: r.halted_reason,
    haltedBy: r.halted_by,
    maxTotalExposureQuote: num(r.max_total_exposure_quote),
    maxConcurrentPositions: r.max_concurrent_positions,
    maxDailyLossQuote: num(r.max_daily_loss_quote),
    dailyLossWindowHours: r.daily_loss_window_hours,
  };
}

/** Set the kill switch. `reason` is required when halting, for the audit trail. */
export async function setTradingHalted(
  halted: boolean,
  opts: { reason?: string; by?: HaltSource } = {}
): Promise<void> {
  await query(
    `UPDATE risk_controls
        SET trading_halted = $1,
            halted_reason  = CASE WHEN $1 THEN $2 ELSE NULL END,
            halted_by      = CASE WHEN $1 THEN $3 ELSE NULL END,
            halted_at      = CASE WHEN $1 THEN now() ELSE NULL END,
            updated_at     = now()
      WHERE id = 1`,
    [halted, opts.reason ?? null, opts.by ?? null]
  );
}

export async function updateRiskLimits(patch: {
  maxTotalExposureQuote?: number | null;
  maxConcurrentPositions?: number | null;
  maxDailyLossQuote?: number | null;
  dailyLossWindowHours?: number;
}): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [];
  const push = (column: string, value: unknown): void => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };
  if (patch.maxTotalExposureQuote !== undefined) push("max_total_exposure_quote", patch.maxTotalExposureQuote);
  if (patch.maxConcurrentPositions !== undefined) push("max_concurrent_positions", patch.maxConcurrentPositions);
  if (patch.maxDailyLossQuote !== undefined) push("max_daily_loss_quote", patch.maxDailyLossQuote);
  if (patch.dailyLossWindowHours !== undefined) push("daily_loss_window_hours", patch.dailyLossWindowHours);
  if (sets.length === 0) return;
  await query(
    `UPDATE risk_controls SET ${sets.join(", ")}, updated_at = now() WHERE id = 1`,
    params
  );
}

// ── Realised P&L ledger ─────────────────────────────────────────────────────

export async function recordRealisedPnl(input: {
  deploymentId: string;
  alertId?: number | null;
  pnlQuote: number;
  entryPrice?: number | null;
  exitPrice?: number | null;
  quantity?: number | null;
  reason?: string | null;
}): Promise<void> {
  await query(
    `INSERT INTO realised_pnl
       (deployment_id, alert_id, pnl_quote, entry_price, exit_price, quantity, reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      input.deploymentId, input.alertId ?? null, input.pnlQuote,
      input.entryPrice ?? null, input.exitPrice ?? null,
      input.quantity ?? null, input.reason ?? null,
    ]
  );
}

export async function listRealisedPnl(
  windowHours: number
): Promise<{ closedAt: number; pnlQuote: number }[]> {
  const { rows } = await query<{ closed_at: Date; pnl_quote: string | number }>(
    `SELECT closed_at, pnl_quote FROM realised_pnl
      WHERE closed_at >= now() - ($1 || ' hours')::interval
      ORDER BY closed_at DESC`,
    [String(windowHours)]
  );
  return rows.map((r) => ({
    closedAt: r.closed_at.getTime(),
    pnlQuote: typeof r.pnl_quote === "number" ? r.pnl_quote : Number(r.pnl_quote),
  }));
}

/**
 * Recent delivery outcomes, for the operator surface's signal-delivery health.
 *
 * Read-only and bounded: the newest `limit` rows inside the window, so a busy
 * day cannot turn a status poll into a table scan.
 */
export async function listDeliveryOutcomes(
  windowHours: number,
  limit = 500
): Promise<DeliveryRow[]> {
  const { rows } = await query<{
    delivery_status: DeliveryRow["status"];
    fired_at: Date;
    sent_at: Date | null;
    attempts: number;
    http_status: number | null;
  }>(
    `SELECT delivery_status, fired_at, sent_at, attempts, http_status
       FROM alerts
      WHERE fired_at >= now() - ($1 || ' hours')::interval
      ORDER BY fired_at DESC
      LIMIT $2`,
    [String(windowHours), limit]
  );
  return rows.map((r) => ({
    status: r.delivery_status,
    firedAt: r.fired_at.getTime(),
    sentAt: r.sent_at === null ? null : r.sent_at.getTime(),
    attempts: r.attempts,
    httpStatus: r.http_status,
  }));
}

// ── Single-emitter lease (X-06, BE-18) ──────────────────────────────────────

export interface LeaseState {
  holder: string;
  hostname: string | null;
  pid: number | null;
  acquiredAt: number;
  expiresAt: number;
}

/**
 * Take or renew the emitter lease.
 *
 * The row is claimed only when it is absent, already held by this holder, or
 * expired. Two processes cannot both hold it, and the DATABASE decides — which
 * is the point: single-emitter was previously enforced by an in-memory `Set`
 * and a comment, so a laptop launch agent and the cloud deployment could both
 * emit against the same production bot with their runtime state in different
 * databases (X-06, BE-18).
 */
export async function acquireEmitterLease(
  holder: string,
  ttlMs: number,
  meta: { hostname?: string; pid?: number } = {}
): Promise<boolean> {
  const { rows } = await query<{ holder: string }>(
    `INSERT INTO emitter_lease (id, holder, hostname, pid, acquired_at, expires_at)
     VALUES (1, $1, $2, $3, now(), now() + ($4 || ' milliseconds')::interval)
     ON CONFLICT (id) DO UPDATE
       SET holder      = EXCLUDED.holder,
           hostname    = EXCLUDED.hostname,
           pid         = EXCLUDED.pid,
           acquired_at = CASE WHEN emitter_lease.holder = EXCLUDED.holder
                              THEN emitter_lease.acquired_at ELSE now() END,
           expires_at  = EXCLUDED.expires_at
       WHERE emitter_lease.holder = EXCLUDED.holder
          OR emitter_lease.expires_at <= now()
     RETURNING holder`,
    [holder, meta.hostname ?? null, meta.pid ?? null, String(ttlMs)]
  );
  return rows.length > 0;
}

export async function getEmitterLease(): Promise<LeaseState | null> {
  const { rows } = await query<{
    holder: string; hostname: string | null; pid: number | null;
    acquired_at: Date; expires_at: Date;
  }>("SELECT * FROM emitter_lease WHERE id = 1");
  const r = rows[0];
  if (!r) return null;
  return {
    holder: r.holder,
    hostname: r.hostname,
    pid: r.pid,
    acquiredAt: r.acquired_at.getTime(),
    expiresAt: r.expires_at.getTime(),
  };
}

/** Release the lease on a clean shutdown, so a restart does not wait it out. */
export async function releaseEmitterLease(holder: string): Promise<void> {
  await query("DELETE FROM emitter_lease WHERE id = 1 AND holder = $1", [holder]);
}

// ── Feed health ─────────────────────────────────────────────────────────────

export async function recordFeedHealth(input: {
  symbol: string;
  interval: string;
  state: FeedState;
  lastBarOpenTime: number | null;
  missingBars: number;
  detail: string;
}): Promise<void> {
  await query(
    `INSERT INTO feed_health (symbol, interval, state, last_bar_time, missing_bars, detail, last_checked_at)
     VALUES ($1,$2,$3,$4,$5,$6, now())
     ON CONFLICT (symbol, interval) DO UPDATE
       SET state = EXCLUDED.state,
           last_bar_time = EXCLUDED.last_bar_time,
           missing_bars = EXCLUDED.missing_bars,
           detail = EXCLUDED.detail,
           last_checked_at = now()`,
    [
      input.symbol, input.interval, input.state,
      input.lastBarOpenTime === null ? null : new Date(input.lastBarOpenTime),
      input.missingBars, input.detail,
    ]
  );
}

export async function listFeedHealth(): Promise<
  {
    symbol: string; interval: string; state: FeedState;
    lastBarTime: number | null; missingBars: number; detail: string | null;
    lastCheckedAt: number;
  }[]
> {
  const { rows } = await query<{
    symbol: string; interval: string; state: FeedState;
    last_bar_time: Date | null; missing_bars: number; detail: string | null;
    last_checked_at: Date;
  }>("SELECT * FROM feed_health ORDER BY symbol, interval");
  return rows.map((r) => ({
    symbol: r.symbol,
    interval: r.interval,
    state: r.state,
    lastBarTime: r.last_bar_time ? r.last_bar_time.getTime() : null,
    missingBars: r.missing_bars,
    detail: r.detail,
    lastCheckedAt: r.last_checked_at.getTime(),
  }));
}
