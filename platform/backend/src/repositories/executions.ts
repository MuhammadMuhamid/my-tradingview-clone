import { query } from "../db/pool";
import type { ExecutionEvidence } from "../timeline/projection";

interface DbExecution {
  id: number;
  alert_id: number | null;
  deployment_id: string | null;
  exchange_order_id: string | null;
  side: string | null;
  order_type: string | null;
  qty: string | number | null;
  price: string | number | null;
  status: string | null;
  created_at: Date;
}
const numberOrNull = (value: string | number | null): number | null =>
  value === null ? null : Number.isFinite(Number(value)) ? Number(value) : null;

/**
 * Execution reports linked by an explicit deployment FK or by an alert FK.
 * No symbol/time/quantity correlation is attempted.
 */
export async function listByDeployment(deploymentId: string, limit = 50): Promise<ExecutionEvidence[]> {
  const bounded = Math.max(1, Math.min(100, Math.trunc(limit)));
  const { rows } = await query<DbExecution>(
    `SELECT e.id, e.alert_id, e.deployment_id, e.exchange_order_id, e.side,
            e.order_type, e.qty, e.price, e.status, e.created_at
       FROM executions e
      WHERE e.deployment_id = $1
         OR e.alert_id IN (SELECT id FROM alerts WHERE deployment_id = $1)
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT $2`,
    [deploymentId, bounded]
  );
  return rows.map((row) => ({
    id: row.id,
    alertId: row.alert_id,
    deploymentId: row.deployment_id,
    exchangeOrderId: row.exchange_order_id,
    side: row.side,
    orderType: row.order_type,
    qty: numberOrNull(row.qty),
    price: numberOrNull(row.price),
    status: row.status,
    createdAt: row.created_at.getTime(),
  }));
}
