/**
 * Simulated fills for `delivery: "paper"` deployments.
 *
 * Deliberately a separate table from `executions`, which records what the
 * exchange actually did. Mixing the two would make a simulated fill
 * indistinguishable from a real one in exactly the query an operator runs to
 * check a real one.
 */
import { query } from "../db/pool";
import type { PaperFill, PaperPosition } from "../engine/paperBroker";
import { FLAT } from "../engine/paperBroker";

export interface PaperFillRow {
  id: number;
  deploymentId: string;
  alertId: number | null;
  barTime: number;
  filledAt: number;
  action: "buy" | "sell";
  price: number;
  qty: number;
  quote: number;
  commission: number;
  realisedPnl: number | null;
  positionQty: number;
  costBasis: number;
  entryPrice: number | null;
  reason: string | null;
}

const num = (v: string | number | null): number =>
  v === null ? 0 : typeof v === "number" ? v : Number(v);

/**
 * Record a fill. `alertId` carries the unique index, so a retry of the same
 * logical order cannot book a second fill — the same rule the live path gets
 * from its dedupe key.
 */
export async function recordFill(input: {
  deploymentId: string;
  alertId: number | null;
  fill: PaperFill;
  reason: string | null;
}): Promise<void> {
  const { fill } = input;
  await query(
    `INSERT INTO paper_fills
       (deployment_id, alert_id, bar_time, action, price, qty, quote, commission,
        realised_pnl, position_qty, cost_basis, entry_price, reason)
     VALUES ($1,$2,to_timestamp($3/1000.0),$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (alert_id) WHERE alert_id IS NOT NULL DO NOTHING`,
    [
      input.deploymentId, input.alertId, fill.barTime, fill.action,
      fill.price, fill.qty, fill.quote, fill.commission, fill.realisedPnl,
      fill.positionAfter.qty, fill.positionAfter.costBasis, fill.positionAfter.entryPrice,
      input.reason,
    ]
  );
}

/** Newest-first fills for one deployment, bounded. */
export async function listFills(deploymentId: string, limit = 200): Promise<PaperFillRow[]> {
  const { rows } = await query<Record<string, string | number | Date | null>>(
    `SELECT id, deployment_id, alert_id, bar_time, filled_at, action, price, qty, quote,
            commission, realised_pnl, position_qty, cost_basis, entry_price, reason
       FROM paper_fills WHERE deployment_id = $1
      ORDER BY bar_time DESC, id DESC LIMIT $2`,
    [deploymentId, limit]
  );
  return rows.map((r) => ({
    id: Number(r.id),
    deploymentId: String(r.deployment_id),
    alertId: r.alert_id === null ? null : Number(r.alert_id),
    barTime: (r.bar_time as Date).getTime(),
    filledAt: (r.filled_at as Date).getTime(),
    action: r.action as "buy" | "sell",
    price: num(r.price as string | number),
    qty: num(r.qty as string | number),
    quote: num(r.quote as string | number),
    commission: num(r.commission as string | number),
    realisedPnl: r.realised_pnl === null ? null : num(r.realised_pnl as string | number),
    positionQty: num(r.position_qty as string | number),
    costBasis: num(r.cost_basis as string | number),
    entryPrice: r.entry_price === null ? null : num(r.entry_price as string | number),
    reason: r.reason === null ? null : String(r.reason),
  }));
}

/**
 * The position a deployment's simulation currently holds.
 *
 * Read from the newest fill rather than replayed, so a long-running paper
 * deployment does not re-read its whole history on every bar.
 */
export async function currentPosition(deploymentId: string): Promise<PaperPosition> {
  const { rows } = await query<{
    position_qty: string | number; cost_basis: string | number;
    entry_price: string | number | null; bar_time: Date;
  }>(
    `SELECT position_qty, cost_basis, entry_price, bar_time
       FROM paper_fills WHERE deployment_id = $1
      ORDER BY bar_time DESC, id DESC LIMIT 1`,
    [deploymentId]
  );
  const row = rows[0];
  if (!row) return { ...FLAT };
  const qty = num(row.position_qty);
  if (qty <= 0) return { ...FLAT };
  return {
    qty,
    costBasis: num(row.cost_basis),
    entryPrice: row.entry_price === null ? null : num(row.entry_price),
    entryBarTime: row.bar_time.getTime(),
  };
}
