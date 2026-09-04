import { query } from "../db/pool";
import type {
  AutomatedActivityEvidence, AutomatedRealizationEvidence, PaperFillEvidence,
} from "../journal/projection";

export interface JournalReadFilter {
  from: Date;
  toExclusive: Date;
  symbol: string | null;
  deploymentId: string | null;
  strategyId: number | null;
  limit: number;
}

interface DbProvenance {
  deployment_id: string;
  strategy_id: number;
  strategy_key: string | null;
  strategy_name: string | null;
  config_id: string | null;
  config_name: string | null;
  symbol: string;
}

const num = (value: string | number | null): number | null =>
  value === null ? null : Number(value);
const provenance = (row: DbProvenance) => ({
  deploymentId: row.deployment_id,
  strategyId: row.strategy_id,
  strategyKey: row.strategy_key,
  strategyName: row.strategy_name,
  configId: row.config_id,
  configName: row.config_name,
  symbol: row.symbol,
});
const params = (filter: JournalReadFilter): unknown[] => [
  filter.from, filter.toExclusive, filter.symbol, filter.deploymentId,
  filter.strategyId, filter.limit,
];

/** Platform-owned signed realization records. No Bot lookup is performed. */
export async function listAutomatedRealizations(
  filter: JournalReadFilter
): Promise<AutomatedRealizationEvidence[]> {
  const { rows } = await query<DbProvenance & {
    id: number; closed_at: Date; pnl_quote: string | number;
    entry_price: string | number | null; exit_price: string | number | null;
    quantity: string | number | null; reason: string | null;
    source_event_id: string | null; realization_kind: "partial" | "final" | null;
    source_strategy_order_intent_id: string | null; source_exchange_order_id: string | null;
    source_platform_order_intent_id: string | number | null;
    accounting_basis: string | null; fee_model: string | null;
  }>(
    `SELECT rp.id, rp.closed_at, rp.pnl_quote, rp.entry_price, rp.exit_price,
            rp.quantity, rp.reason, rp.source_event_id, rp.realization_kind,
            rp.source_strategy_order_intent_id, rp.source_exchange_order_id,
            rp.source_platform_order_intent_id, rp.accounting_basis, rp.fee_model,
            d.id AS deployment_id, d.strategy_id,
            s.key AS strategy_key, s.name AS strategy_name, d.config_id,
            sc.name AS config_name, d.symbol
       FROM realised_pnl rp
       JOIN deployments d ON d.id = rp.deployment_id
       JOIN strategies s ON s.id = d.strategy_id
       LEFT JOIN strategy_configs sc ON sc.id = d.config_id
      WHERE rp.closed_at >= $1 AND rp.closed_at < $2
        AND ($3::text IS NULL OR d.symbol = $3)
        AND ($4::uuid IS NULL OR d.id = $4)
        AND ($5::integer IS NULL OR d.strategy_id = $5)
      ORDER BY rp.closed_at DESC, rp.id DESC
      LIMIT $6`, params(filter)
  );
  return rows.map((row) => ({
    ...provenance(row), id: row.id, closedAt: row.closed_at.getTime(),
    pnlQuote: Number(row.pnl_quote), entryPrice: num(row.entry_price),
    exitPrice: num(row.exit_price), quantity: num(row.quantity), reason: row.reason,
    sourceEventId: row.source_event_id, realizationKind: row.realization_kind,
    strategyOrderIntentId: row.source_strategy_order_intent_id,
    exchangeOrderId: row.source_exchange_order_id,
    platformOrderIntentId: row.source_platform_order_intent_id === null
      ? null : String(row.source_platform_order_intent_id),
    accountingBasis: row.accounting_basis, feeModel: row.fee_model,
  }));
}

/** Durable intents and persisted cumulative execution reports, never synthetic fills. */
export async function listAutomatedActivity(
  filter: JournalReadFilter
): Promise<AutomatedActivityEvidence[]> {
  const { rows } = await query<DbProvenance & {
    kind: "INTENT" | "EXECUTION_SNAPSHOT"; id: number; occurred_at: Date;
    side: "BUY" | "SELL"; state: string | null; quantity: string | number | null;
    price: string | number | null; intent_id: number | null; execution_id: number | null;
    exchange_order_id: string | null;
  }>(
    `SELECT evidence.* FROM (
       SELECT 'INTENT'::text AS kind, oi.id, oi.created_at AS occurred_at,
              upper(oi.action) AS side, oi.state, NULL::numeric AS quantity,
              NULL::numeric AS price, oi.id AS intent_id, NULL::bigint AS execution_id,
              NULL::text AS exchange_order_id, d.id AS deployment_id, d.strategy_id,
              s.key AS strategy_key, s.name AS strategy_name, d.config_id,
              sc.name AS config_name, d.symbol
         FROM order_intents oi
         JOIN deployments d ON d.id = oi.deployment_id
         JOIN strategies s ON s.id = d.strategy_id
         LEFT JOIN strategy_configs sc ON sc.id = d.config_id
        WHERE d.delivery IN ('custom','3commas')
       UNION ALL
       SELECT 'EXECUTION_SNAPSHOT'::text AS kind, e.id, e.created_at AS occurred_at,
              e.side, e.status AS state, e.qty AS quantity, e.price,
              NULL::bigint AS intent_id, e.id AS execution_id, e.exchange_order_id,
              d.id AS deployment_id, d.strategy_id, s.key AS strategy_key,
              s.name AS strategy_name, d.config_id, sc.name AS config_name, d.symbol
         FROM executions e
         LEFT JOIN alerts a ON a.id = e.alert_id
         JOIN deployments d ON d.id = COALESCE(e.deployment_id, a.deployment_id)
         JOIN strategies s ON s.id = d.strategy_id
         LEFT JOIN strategy_configs sc ON sc.id = d.config_id
        WHERE d.delivery IN ('custom','3commas') AND e.side IN ('BUY','SELL')
     ) evidence
      WHERE evidence.occurred_at >= $1 AND evidence.occurred_at < $2
        AND ($3::text IS NULL OR evidence.symbol = $3)
        AND ($4::uuid IS NULL OR evidence.deployment_id = $4)
        AND ($5::integer IS NULL OR evidence.strategy_id = $5)
      ORDER BY evidence.occurred_at DESC, evidence.id DESC
      LIMIT $6`, params(filter)
  );
  return rows.map((row) => ({
    ...provenance(row), kind: row.kind, id: row.id, occurredAt: row.occurred_at.getTime(),
    side: row.side, state: row.state, quantity: num(row.quantity), price: num(row.price),
    intentId: row.intent_id, executionId: row.execution_id,
    exchangeOrderId: row.exchange_order_id,
  }));
}

/**
 * Paper fills plus their exact preceding entry under the existing paper engine's
 * no-averaging, one-position rule. This reuses that relationship; it does not
 * introduce a new lot-matching policy.
 */
export async function listPaperFills(filter: JournalReadFilter): Promise<PaperFillEvidence[]> {
  const { rows } = await query<DbProvenance & {
    id: number; occurred_at: Date; action: "buy" | "sell"; price: string | number;
    quantity: string | number; commission: string | number;
    realized_pnl: string | number | null; position_qty_after: string | number;
    reason: string | null; entry_occurred_at: Date | null;
    entry_price: string | number | null; entry_quantity: string | number | null;
    entry_commission: string | number | null;
  }>(
    `SELECT pf.id, pf.bar_time AS occurred_at, pf.action, pf.price,
            pf.qty AS quantity, pf.commission, pf.realised_pnl AS realized_pnl,
            pf.position_qty AS position_qty_after, pf.reason,
            entry.bar_time AS entry_occurred_at, entry.price AS entry_price,
            entry.qty AS entry_quantity, entry.commission AS entry_commission,
            d.id AS deployment_id, d.strategy_id, s.key AS strategy_key,
            s.name AS strategy_name, d.config_id, sc.name AS config_name, d.symbol
       FROM paper_fills pf
       JOIN deployments d ON d.id = pf.deployment_id AND d.delivery = 'paper'
       JOIN strategies s ON s.id = d.strategy_id
       LEFT JOIN strategy_configs sc ON sc.id = d.config_id
       LEFT JOIN LATERAL (
         SELECT buy.bar_time, buy.price, buy.qty, buy.commission
           FROM paper_fills buy
          WHERE buy.deployment_id = pf.deployment_id AND buy.action = 'buy'
            AND (buy.bar_time, buy.id) < (pf.bar_time, pf.id)
          ORDER BY buy.bar_time DESC, buy.id DESC LIMIT 1
       ) entry ON pf.action = 'sell'
      WHERE pf.bar_time >= $1 AND pf.bar_time < $2
        AND ($3::text IS NULL OR d.symbol = $3)
        AND ($4::uuid IS NULL OR d.id = $4)
        AND ($5::integer IS NULL OR d.strategy_id = $5)
      ORDER BY pf.bar_time DESC, pf.id DESC
      LIMIT $6`, params(filter)
  );
  return rows.map((row) => ({
    ...provenance(row), id: row.id, occurredAt: row.occurred_at.getTime(),
    action: row.action, price: Number(row.price), quantity: Number(row.quantity),
    commission: Number(row.commission), realizedPnl: num(row.realized_pnl),
    positionQtyAfter: Number(row.position_qty_after), reason: row.reason,
    entry: row.entry_occurred_at && row.entry_price !== null && row.entry_quantity !== null
      && row.entry_commission !== null ? {
        occurredAt: row.entry_occurred_at.getTime(), price: Number(row.entry_price),
        quantity: Number(row.entry_quantity), commission: Number(row.entry_commission),
      } : null,
  }));
}
