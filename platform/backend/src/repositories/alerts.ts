import { query } from "../db/pool";
import type { AlertPayload, AlertRow, DeliveryStatus } from "../types/alerts";
import { redactPayload, redactResponseBody } from "../security/secrets";

interface DbAlert {
  id: number;
  deployment_id: string;
  bar_time: Date;
  fired_at: Date;
  action: "buy" | "sell";
  market_position: string;
  position_size: number;
  trigger_price: number;
  intended_trigger_price: number | null;
  decision_time: Date;
  reason: string | null;
  payload: AlertPayload;
  dedupe_key: string | null;
  delivery_status: DeliveryStatus;
  http_status: number | null;
  response_body: string | null;
  attempts: number;
  sent_at: Date | null;
}

function toRow(r: DbAlert): AlertRow {
  return {
    id: r.id,
    deploymentId: r.deployment_id,
    barTime: r.bar_time.toISOString(),
    firedAt: r.fired_at.toISOString(),
    action: r.action,
    marketPosition: r.market_position,
    positionSize: r.position_size,
    triggerPrice: r.trigger_price,
    intendedTriggerPrice: r.intended_trigger_price,
    decisionTime: r.decision_time.toISOString(),
    reason: r.reason,
    payload: r.payload,
    dedupeKey: r.dedupe_key,
    deliveryStatus: r.delivery_status,
    httpStatus: r.http_status,
    responseBody: r.response_body,
    attempts: r.attempts,
    sentAt: r.sent_at ? r.sent_at.toISOString() : null,
  };
}

export async function createAlert(input: {
  deploymentId: string;
  barTime: number;
  action: "buy" | "sell";
  marketPosition: string;
  positionSize: number;
  triggerPrice: number;
  intendedTriggerPrice?: number | null;
  decisionTime?: number;
  reason: string;
  payload: AlertPayload;
  dedupeKey: string | null;
  deliveryStatus: DeliveryStatus;
}): Promise<AlertRow> {
  const { rows } = await query<DbAlert>(
    `INSERT INTO alerts
       (deployment_id, bar_time, action, market_position, position_size,
        trigger_price, intended_trigger_price, decision_time, reason, payload,
        dedupe_key, delivery_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
    [
      input.deploymentId, new Date(input.barTime), input.action,
      input.marketPosition, input.positionSize, input.triggerPrice,
      input.intendedTriggerPrice ?? null,
      new Date(input.decisionTime ?? input.barTime),
      input.reason, JSON.stringify(redactPayload(input.payload as unknown as Record<string, unknown>)), input.dedupeKey,
      input.deliveryStatus,
    ]
  );
  return toRow(rows[0]!);
}

export async function markDelivery(
  id: number,
  result: { status: DeliveryStatus; httpStatus?: number; responseBody?: string; attempts: number }
): Promise<void> {
  await query(
    `UPDATE alerts SET delivery_status = $2, http_status = $3, response_body = $4,
       attempts = $5, sent_at = CASE WHEN $2 IN ('sent','skipped') THEN now() ELSE sent_at END
     WHERE id = $1`,
    [id, result.status, result.httpStatus ?? null, redactResponseBody(result.responseBody), result.attempts]
  );
}

/** Idempotency guard: was this dedupe key already fired for this deployment? */
export async function dedupeKeyExists(deploymentId: string, dedupeKey: string): Promise<boolean> {
  const { rows } = await query<{ n: number }>(
    "SELECT count(*)::int AS n FROM alerts WHERE deployment_id = $1 AND dedupe_key = $2",
    [deploymentId, dedupeKey]
  );
  return (rows[0]?.n ?? 0) > 0;
}

export async function listAlerts(opts: {
  deploymentId?: string;
  limit?: number;
} = {}): Promise<AlertRow[]> {
  const params: unknown[] = [];
  let where = "";
  if (opts.deploymentId) {
    params.push(opts.deploymentId);
    where = `WHERE deployment_id = $${params.length}`;
  }
  params.push(opts.limit ?? 100);
  const { rows } = await query<DbAlert>(
    `SELECT * FROM alerts ${where} ORDER BY fired_at DESC LIMIT $${params.length}`,
    params
  );
  return rows.map(toRow);
}
