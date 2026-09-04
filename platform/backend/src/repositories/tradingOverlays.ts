import { query } from "../db/pool";
import type {
  CurrentAutomatedOrderEvidence, CurrentPositionEvidence,
} from "../overlays/projection";

interface ProvenanceRow {
  deployment_id: string; strategy_id: number; strategy_key: string | null;
  strategy_name: string | null; config_id: string | null; config_name: string | null;
  symbol: string;
}
const num = (value: string | number | null): number | null => value === null ? null : Number(value);
const base = (row: ProvenanceRow) => ({
  deploymentId: row.deployment_id, strategyId: row.strategy_id,
  strategyKey: row.strategy_key, strategyName: row.strategy_name,
  configId: row.config_id, configName: row.config_name, symbol: row.symbol,
});

/** Latest persisted snapshot per exact exchange-order identity; never calls Bot. */
export async function listCurrentAutomatedOrders(
  symbol: string, limit: number
): Promise<CurrentAutomatedOrderEvidence[]> {
  const { rows } = await query<ProvenanceRow & {
    id: number; alert_id: number | null; exchange_order_id: string;
    side: "BUY" | "SELL"; order_type: string; qty: string | number | null;
    price: string | number; status: string; created_at: Date;
  }>(
    `SELECT ranked.id, ranked.alert_id, ranked.exchange_order_id, ranked.side,
            ranked.order_type, ranked.qty, ranked.price, ranked.status, ranked.created_at,
            ranked.deployment_id, ranked.strategy_id, ranked.strategy_key,
            ranked.strategy_name, ranked.config_id, ranked.config_name, ranked.symbol
       FROM (
         SELECT e.id, e.alert_id, e.exchange_order_id, e.side, e.order_type,
                e.qty, e.price, e.status, e.created_at,
                d.id AS deployment_id, d.strategy_id,
                s.key AS strategy_key, s.name AS strategy_name,
                d.config_id, sc.name AS config_name, d.symbol,
                row_number() OVER (
           PARTITION BY d.id, e.exchange_order_id ORDER BY e.created_at DESC, e.id DESC
         ) AS rank
           FROM executions e
           LEFT JOIN alerts a ON a.id = e.alert_id
           JOIN deployments d ON d.id = COALESCE(e.deployment_id, a.deployment_id)
           JOIN strategies s ON s.id = d.strategy_id
           LEFT JOIN strategy_configs sc ON sc.id = d.config_id
          WHERE e.exchange_order_id IS NOT NULL AND d.symbol = $1
            AND d.delivery IN ('custom','3commas')
       ) ranked
      WHERE ranked.rank = 1
        AND upper(ranked.order_type) = 'LIMIT'
        AND lower(ranked.status) IN ('requested','pending','submitted','new','open','partially_filled','working')
      ORDER BY ranked.created_at DESC, ranked.id DESC LIMIT $2`, [symbol, limit]
  );
  return rows.map((row) => ({ ...base(row), executionId: row.id, alertId: row.alert_id,
    exchangeOrderId: row.exchange_order_id, side: row.side, orderType: row.order_type,
    quantity: num(row.qty), price: Number(row.price), state: row.status,
    observedAt: row.created_at.getTime() }));
}

/** Existing deployment runtime state only; quantity is deliberately not derived. */
export async function listCurrentAutomatedPositions(
  symbol: string, limit: number
): Promise<CurrentPositionEvidence[]> {
  const { rows } = await query<ProvenanceRow & { entry_price: string; observed_at: Date }>(
    `SELECT d.id AS deployment_id, d.strategy_id, s.key AS strategy_key,
            s.name AS strategy_name, d.config_id, sc.name AS config_name, d.symbol,
            d.runtime_state->>'entryPrice' AS entry_price, d.updated_at AS observed_at
       FROM deployments d JOIN strategies s ON s.id = d.strategy_id
       LEFT JOIN strategy_configs sc ON sc.id = d.config_id
      WHERE d.symbol = $1 AND d.delivery IN ('custom','3commas')
        AND d.runtime_state->>'position' = 'long'
        AND NULLIF(d.runtime_state->>'entryPrice','') IS NOT NULL
      ORDER BY d.updated_at DESC, d.id LIMIT $2`, [symbol, limit]
  );
  return rows.map((row) => ({ ...base(row), source: "AUTOMATED", price: Number(row.entry_price),
    quantity: null, costBasis: null, observedAt: row.observed_at.getTime() }));
}

/** Newest persisted fill row is the existing paper engine's current position model. */
export async function listCurrentPaperPositions(
  symbol: string, limit: number
): Promise<CurrentPositionEvidence[]> {
  const { rows } = await query<ProvenanceRow & {
    position_qty: string | number; cost_basis: string | number;
    entry_price: string | number; observed_at: Date;
  }>(
    `SELECT d.id AS deployment_id, d.strategy_id, s.key AS strategy_key,
            s.name AS strategy_name, d.config_id, sc.name AS config_name, d.symbol,
            latest.position_qty, latest.cost_basis, latest.entry_price,
            latest.bar_time AS observed_at
       FROM deployments d JOIN strategies s ON s.id = d.strategy_id
       LEFT JOIN strategy_configs sc ON sc.id = d.config_id
       JOIN LATERAL (
         SELECT pf.position_qty, pf.cost_basis, pf.entry_price, pf.bar_time
           FROM paper_fills pf WHERE pf.deployment_id = d.id
          ORDER BY pf.bar_time DESC, pf.id DESC LIMIT 1
       ) latest ON true
      WHERE d.symbol = $1 AND d.delivery = 'paper'
        AND latest.position_qty > 0 AND latest.entry_price IS NOT NULL
      ORDER BY latest.bar_time DESC, d.id LIMIT $2`, [symbol, limit]
  );
  return rows.map((row) => ({ ...base(row), source: "PAPER", price: Number(row.entry_price),
    quantity: Number(row.position_qty), costBasis: Number(row.cost_basis),
    observedAt: row.observed_at.getTime() }));
}
