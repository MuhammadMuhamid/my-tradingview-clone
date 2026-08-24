import { query } from "../db/pool";
import type { Interval } from "../types/market";
import type { StrategyParams } from "../types/strategy";
import {
  DeliveryMode, DeploymentRow, DeploymentStatus, RuntimeState, initialRuntimeState,
} from "../types/deployments";
import { decryptSecret, encryptSecret } from "../security/secrets";

interface DbDeployment {
  id: string;
  strategy_id: number;
  config_id: string | null;
  symbol: string;
  timeframe: Interval;
  params: StrategyParams;
  status: DeploymentStatus;
  delivery: DeliveryMode;
  webhook_url: string | null;
  secret: string | null;
  bot_uuid: string | null;
  buy_quote_qty: number | null;
  runtime_state: RuntimeState;
  last_bar_time: Date | null;
  created_at: Date;
  updated_at: Date;
}

function toRow(r: DbDeployment): DeploymentRow {
  return {
    id: r.id,
    strategyId: r.strategy_id,
    configId: r.config_id,
    symbol: r.symbol,
    timeframe: r.timeframe,
    params: r.params,
    status: r.status,
    delivery: r.delivery,
    webhookUrl: r.webhook_url,
    secret: decryptSecret(r.secret),
    botUuid: decryptSecret(r.bot_uuid),
    buyQuoteQty: r.buy_quote_qty,
    runtimeState: { ...initialRuntimeState(), ...(r.runtime_state ?? {}) },
    lastBarTime: r.last_bar_time ? r.last_bar_time.toISOString() : null,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

export async function createDeployment(input: {
  strategyId: number;
  configId?: string;
  symbol: string;
  timeframe: Interval;
  params: StrategyParams;
  delivery: DeliveryMode;
  webhookUrl?: string;
  secret?: string;
  botUuid?: string;
  buyQuoteQty?: number;
}): Promise<DeploymentRow> {
  const { rows } = await query<DbDeployment>(
    `INSERT INTO deployments
       (strategy_id, config_id, symbol, timeframe, params, delivery,
        webhook_url, secret, bot_uuid, buy_quote_qty, runtime_state, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'paused')
     RETURNING *`,
    [
      input.strategyId, input.configId ?? null, input.symbol, input.timeframe,
      JSON.stringify(input.params), input.delivery,
      input.webhookUrl ?? null, input.secret ? encryptSecret(input.secret) : null,
      input.botUuid ? encryptSecret(input.botUuid) : null,
      input.buyQuoteQty ?? null, JSON.stringify(initialRuntimeState()),
    ]
  );
  return toRow(rows[0]!);
}

export async function listDeployments(status?: DeploymentStatus): Promise<DeploymentRow[]> {
  const { rows } = status
    ? await query<DbDeployment>("SELECT * FROM deployments WHERE status = $1 ORDER BY created_at DESC", [status])
    : await query<DbDeployment>("SELECT * FROM deployments ORDER BY created_at DESC");
  return rows.map(toRow);
}

export async function getDeployment(id: string): Promise<DeploymentRow | null> {
  const { rows } = await query<DbDeployment>("SELECT * FROM deployments WHERE id = $1", [id]);
  return rows[0] ? toRow(rows[0]) : null;
}

export async function setDeploymentStatus(
  id: string, status: DeploymentStatus
): Promise<DeploymentRow | null> {
  const { rows } = await query<DbDeployment>(
    "UPDATE deployments SET status = $2, updated_at = now() WHERE id = $1 RETURNING *",
    [id, status]
  );
  return rows[0] ? toRow(rows[0]) : null;
}

/** Persist runtime state + last processed bar after each evaluated bar close. */
export async function saveRuntimeState(
  id: string, state: RuntimeState, lastBarTime: number
): Promise<void> {
  await query(
    "UPDATE deployments SET runtime_state = $2, last_bar_time = $3, updated_at = now() WHERE id = $1",
    [id, JSON.stringify(state), new Date(lastBarTime)]
  );
}

/** Persist an accepted partial leg without marking the candle complete. */
export async function saveRuntimeStateOnly(id: string, state: RuntimeState): Promise<void> {
  await query(
    "UPDATE deployments SET runtime_state = $2, updated_at = now() WHERE id = $1",
    [id, JSON.stringify(state)]
  );
}

/**
 * Atomically reconcile a locally-long deployment after the receiver confirms
 * that its SmartTrade is already flat (for example, a dashboard manual close).
 * Strategy streak/circuit-breaker state is preserved; only position-scoped
 * fields are cleared. Returns true only when a long position was changed.
 */
export async function reconcileReceiverFlat(id: string, closedAt = Date.now()): Promise<boolean> {
  const patch: Partial<RuntimeState> = {
    position: "flat",
    entryPrice: null,
    entryBarTime: null,
    savedLongStop: null,
    savedLongTp: null,
    trailAnchor: null,
    trailArmed: false,
    tp1Done: false,
    tp2Done: false,
    indSigArmed: false,
    lastExitBarTime: closedAt,
    manualCloseReentryLock: true,
  };
  const result = await query(
    `UPDATE deployments
     SET runtime_state = runtime_state || $2::jsonb, updated_at = now()
     WHERE id = $1 AND status = 'active' AND runtime_state->>'position' = 'long'`,
    [id, JSON.stringify(patch)]
  );
  return (result.rowCount ?? 0) === 1;
}

/**
 * The mirror case: the receiver reports LONG for a deployment this platform
 * believes is flat.
 *
 * `reconcileReceiverFlat` handled one direction only, and the audit named the
 * consequence exactly (X-03): the state left behind by a crash between delivery
 * and persistence (BE-13), or by a dedupe skip that advanced state without
 * placing an order (BE-16), is *locally flat, receiver long*. From there the
 * platform issues a fresh BUY on the next entry signal, adding to a position it
 * does not know it holds, and computing stops and targets from the wrong entry
 * price. The 30-second sync that exists to prevent divergence could not see it.
 *
 * This does NOT adopt the position. The platform does not know the entry price,
 * the stop, the targets or which tiers were taken — inventing them would put
 * real money behind a guess. It pauses the deployment and records why, so the
 * operator decides. A paused deployment cannot emit, which makes the safe
 * outcome the automatic one.
 *
 * Returns true only when a deployment was actually paused by this call.
 */
export async function pauseOnReceiverLong(id: string, detail: string): Promise<boolean> {
  const result = await query(
    `UPDATE deployments
        SET status = 'paused',
            runtime_state = runtime_state || $2::jsonb,
            updated_at = now()
      WHERE id = $1
        AND status = 'active'
        AND COALESCE(runtime_state->>'position', 'flat') = 'flat'`,
    [
      id,
      JSON.stringify({
        divergenceDetectedAt: Date.now(),
        divergenceDetail: detail,
      }),
    ]
  );
  return (result.rowCount ?? 0) === 1;
}

/**
 * Edit the delivery-side settings of an alert (TradingView "edit alert").
 * Strategy identity (symbol/timeframe/params) is intentionally not editable —
 * runtime state is tied to it; recreate the alert to change the strategy.
 * The live runner re-reads the row on every bar close, so edits take effect
 * on the next confirmed bar without pausing.
 */
export async function updateDeployment(
  id: string,
  patch: {
    delivery?: DeliveryMode;
    webhookUrl?: string;
    secret?: string;
    botUuid?: string;
    buyQuoteQty?: number;
  }
): Promise<DeploymentRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [id];
  const push = (col: string, v: unknown) => {
    params.push(v);
    sets.push(`${col} = $${params.length}`);
  };
  if (patch.delivery !== undefined) push("delivery", patch.delivery);
  if (patch.webhookUrl !== undefined) push("webhook_url", patch.webhookUrl);
  if (patch.secret !== undefined) push("secret", encryptSecret(patch.secret));
  if (patch.botUuid !== undefined) push("bot_uuid", encryptSecret(patch.botUuid));
  if (patch.buyQuoteQty !== undefined) push("buy_quote_qty", patch.buyQuoteQty);
  if (sets.length === 0) return getDeployment(id);

  const { rows } = await query<DbDeployment>(
    `UPDATE deployments SET ${sets.join(", ")}, updated_at = now()
     WHERE id = $1 RETURNING *`,
    params
  );
  return rows[0] ? toRow(rows[0]) : null;
}

export async function deleteDeployment(id: string): Promise<boolean> {
  const res = await query("DELETE FROM deployments WHERE id = $1", [id]);
  return (res.rowCount ?? 0) > 0;
}

/** One-time/startup migration for legacy plaintext deployment credentials. */
export async function encryptLegacySecrets(): Promise<number> {
  const { rows } = await query<{ id: string; secret: string | null; bot_uuid: string | null }>(
    "SELECT id, secret, bot_uuid FROM deployments WHERE (secret IS NOT NULL AND secret NOT LIKE 'enc:%') OR (bot_uuid IS NOT NULL AND bot_uuid NOT LIKE 'enc:%')"
  );
  for (const row of rows) {
    await query(
      "UPDATE deployments SET secret=$2, bot_uuid=$3, updated_at=now() WHERE id=$1",
      [row.id, row.secret ? encryptSecret(row.secret) : null, row.bot_uuid ? encryptSecret(row.bot_uuid) : null]
    );
  }
  return rows.length;
}
