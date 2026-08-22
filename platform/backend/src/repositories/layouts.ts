/**
 * Chart layouts — server-persisted TradingView-style workspaces. A layout
 * snapshots symbol, timeframe, history depth, strategy key/params and the
 * backtest properties, keyed by a case-insensitively unique name.
 */
import { query } from "../db/pool";
import type { Interval } from "../types/market";
import type { StrategyParams } from "../types/strategy";
import type { DeploymentRow } from "../types/deployments";

export interface LayoutProperties {
  initialCapital: number;
  qtyCash: number;
  qtyType?: "cash" | "percent_of_equity";
  qtyValue?: number;
  commissionPct: number;
  slippageTicks: number;
}

/** One MA line the layout draws; mirrors frontend lib/movingAverages.ts. */
export interface LayoutMaLine {
  type: "sma" | "ema";
  length: number;
  visible: boolean;
}

export interface LayoutRow {
  id: string;
  name: string;
  symbol: string;
  timeframe: Interval;
  bars: number;
  strategyKey: string;
  params: StrategyParams;
  properties: LayoutProperties;
  movingAverages: LayoutMaLine[];
  createdAt: string;
  updatedAt: string;
}

interface DbLayout {
  id: string;
  name: string;
  symbol: string;
  timeframe: Interval;
  bars: number;
  strategy_key: string;
  params: StrategyParams;
  properties: LayoutProperties;
  moving_averages: LayoutMaLine[];
  created_at: Date;
  updated_at: Date;
}

function toRow(r: DbLayout): LayoutRow {
  return {
    id: r.id,
    name: r.name,
    symbol: r.symbol,
    timeframe: r.timeframe,
    bars: r.bars,
    strategyKey: r.strategy_key,
    params: r.params,
    properties: r.properties,
    movingAverages: r.moving_averages ?? [],
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

export async function listLayouts(): Promise<LayoutRow[]> {
  const { rows } = await query<DbLayout>(
    "SELECT * FROM chart_layouts ORDER BY updated_at DESC"
  );
  return rows.map(toRow);
}

export async function getLayout(id: string): Promise<LayoutRow | null> {
  const { rows } = await query<DbLayout>(
    "SELECT * FROM chart_layouts WHERE id = $1",
    [id]
  );
  return rows[0] ? toRow(rows[0]) : null;
}

export async function getLayoutByName(name: string): Promise<LayoutRow | null> {
  const { rows } = await query<DbLayout>(
    "SELECT * FROM chart_layouts WHERE upper(btrim(name)) = upper(btrim($1))",
    [name]
  );
  return rows[0] ? toRow(rows[0]) : null;
}

export interface LayoutState {
  symbol: string;
  timeframe: Interval;
  bars: number;
  strategyKey: string;
  params: StrategyParams;
  properties: LayoutProperties;
  movingAverages?: LayoutMaLine[];
}

/** Create or update by case-insensitive name (frontend upsert semantics). */
export async function upsertLayoutByName(
  name: string,
  state: LayoutState
): Promise<LayoutRow> {
  const cleanName = name.trim() || "Unnamed";
  const { rows } = await query<DbLayout>(
    `INSERT INTO chart_layouts
       (name, symbol, timeframe, bars, strategy_key, params, properties, moving_averages)
     VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::jsonb, '[]'::jsonb))
     ON CONFLICT (upper(btrim(name)))
     DO UPDATE SET
       symbol = EXCLUDED.symbol,
       timeframe = EXCLUDED.timeframe,
       bars = EXCLUDED.bars,
       strategy_key = EXCLUDED.strategy_key,
       params = EXCLUDED.params,
       properties = EXCLUDED.properties,
       -- Deployment sync calls this without MA data; $8 is NULL there, so keep
       -- what the user drew rather than blanking the lines on every sync pass.
       moving_averages = COALESCE($8::jsonb, chart_layouts.moving_averages),
       updated_at = now()
     RETURNING *`,
    [
      cleanName, state.symbol, state.timeframe, state.bars, state.strategyKey,
      JSON.stringify(state.params), JSON.stringify(state.properties),
      state.movingAverages ? JSON.stringify(state.movingAverages) : null,
    ]
  );
  return toRow(rows[0]!);
}

export async function updateLayout(
  id: string,
  patch: Partial<LayoutState> & { name?: string }
): Promise<LayoutRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [id];
  const push = (col: string, v: unknown) => {
    params.push(v);
    sets.push(`${col} = $${params.length}`);
  };
  if (patch.name !== undefined) push("name", patch.name.trim() || "Unnamed");
  if (patch.symbol !== undefined) push("symbol", patch.symbol);
  if (patch.timeframe !== undefined) push("timeframe", patch.timeframe);
  if (patch.bars !== undefined) push("bars", patch.bars);
  if (patch.strategyKey !== undefined) push("strategy_key", patch.strategyKey);
  if (patch.params !== undefined) push("params", JSON.stringify(patch.params));
  if (patch.properties !== undefined) push("properties", JSON.stringify(patch.properties));
  if (patch.movingAverages !== undefined) push("moving_averages", JSON.stringify(patch.movingAverages));
  if (sets.length === 0) return getLayout(id);

  const { rows } = await query<DbLayout>(
    `UPDATE chart_layouts SET ${sets.join(", ")}, updated_at = now()
     WHERE id = $1 RETURNING *`,
    params
  );
  return rows[0] ? toRow(rows[0]) : null;
}

export async function deleteLayout(id: string): Promise<boolean> {
  const res = await query("DELETE FROM chart_layouts WHERE id = $1", [id]);
  return (res.rowCount ?? 0) > 0;
}

/**
 * Backtest defaults the user standardized on (handoff §7):
 * 1000 USDT initial capital, 100% of equity, 0.1% commission, 0 slippage.
 */
export function defaultSyncedProperties(buyQuoteQty: number | null): LayoutProperties {
  return {
    initialCapital: 1000,
    qtyCash: buyQuoteQty ?? 1000,
    qtyType: "percent_of_equity",
    qtyValue: 100,
    commissionPct: 0.1,
    slippageTicks: 0,
  };
}

/**
 * Pure merge used by deployment→layout sync: the deployment (a saved alert)
 * is authoritative for symbol/timeframe/strategy/params; user-tuned layout
 * properties and history depth are preserved when the layout already exists.
 */
export function layoutStateFromDeployment(
  deployment: Pick<DeploymentRow, "symbol" | "timeframe" | "params" | "buyQuoteQty">,
  strategyKey: string,
  existing: Pick<LayoutRow, "bars" | "properties"> | null
): LayoutState {
  return {
    symbol: deployment.symbol,
    timeframe: deployment.timeframe,
    bars: existing?.bars ?? 10000,
    strategyKey,
    params: deployment.params,
    properties: existing?.properties && Object.keys(existing.properties).length > 0
      ? existing.properties
      : defaultSyncedProperties(deployment.buyQuoteQty),
  };
}

/**
 * Choose which deployment represents a symbol when several exist:
 * active beats paused/stopped, then most recently created.
 */
export function pickSyncDeployment(rows: DeploymentRow[]): Map<string, DeploymentRow> {
  const bySymbol = new Map<string, DeploymentRow>();
  const rank = (s: DeploymentRow["status"]): number =>
    s === "active" ? 2 : s === "paused" ? 1 : 0;
  for (const d of rows) {
    const cur = bySymbol.get(d.symbol);
    if (
      !cur ||
      rank(d.status) > rank(cur.status) ||
      (rank(d.status) === rank(cur.status) && d.createdAt > cur.createdAt)
    ) {
      bySymbol.set(d.symbol, d);
    }
  }
  return bySymbol;
}
