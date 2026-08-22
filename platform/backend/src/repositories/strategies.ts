import { query } from "../db/pool";
import type { Interval } from "../types/market";
import type {
  StrategyParams,
  StrategyRow,
  StrategyConfigRow,
} from "../types/strategy";

interface DbStrategy {
  id: number;
  key: string;
  name: string;
  description: string | null;
  pine_source: string | null;
}

interface DbConfig {
  id: string;
  strategy_id: number;
  name: string;
  symbol: string | null;
  timeframe: Interval;
  params: StrategyParams;
  is_default: boolean;
  created_at: Date;
  updated_at: Date;
}

function toStrategy(r: DbStrategy): StrategyRow {
  return {
    id: r.id,
    key: r.key,
    name: r.name,
    description: r.description,
    pineSource: r.pine_source,
  };
}

function toConfig(r: DbConfig): StrategyConfigRow {
  return {
    id: r.id,
    strategyId: r.strategy_id,
    name: r.name,
    symbol: r.symbol,
    timeframe: r.timeframe,
    params: r.params,
    isDefault: r.is_default,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

export async function listStrategies(): Promise<StrategyRow[]> {
  const { rows } = await query<DbStrategy>(
    "SELECT * FROM strategies ORDER BY id"
  );
  return rows.map(toStrategy);
}

export async function getStrategyByKey(key: string): Promise<StrategyRow | null> {
  const { rows } = await query<DbStrategy>(
    "SELECT * FROM strategies WHERE key = $1",
    [key]
  );
  return rows[0] ? toStrategy(rows[0]) : null;
}

export async function getStrategyById(id: number): Promise<StrategyRow | null> {
  const { rows } = await query<DbStrategy>(
    "SELECT * FROM strategies WHERE id = $1",
    [id]
  );
  return rows[0] ? toStrategy(rows[0]) : null;
}

export async function listConfigs(
  strategyId?: number
): Promise<StrategyConfigRow[]> {
  const { rows } = strategyId
    ? await query<DbConfig>(
        "SELECT * FROM strategy_configs WHERE strategy_id = $1 ORDER BY name",
        [strategyId]
      )
    : await query<DbConfig>("SELECT * FROM strategy_configs ORDER BY name");
  return rows.map(toConfig);
}

export async function getConfig(id: string): Promise<StrategyConfigRow | null> {
  const { rows } = await query<DbConfig>(
    "SELECT * FROM strategy_configs WHERE id = $1",
    [id]
  );
  return rows[0] ? toConfig(rows[0]) : null;
}

export async function createConfig(input: {
  strategyId: number;
  name: string;
  symbol?: string;
  timeframe: Interval;
  params: StrategyParams;
  isDefault?: boolean;
}): Promise<StrategyConfigRow> {
  const { rows } = await query<DbConfig>(
    `INSERT INTO strategy_configs (strategy_id, name, symbol, timeframe, params, is_default)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      input.strategyId,
      input.name,
      input.symbol ?? null,
      input.timeframe,
      JSON.stringify(input.params),
      input.isDefault ?? false,
    ]
  );
  return toConfig(rows[0]!);
}

export async function updateConfig(
  id: string,
  patch: {
    name?: string;
    symbol?: string | null;
    timeframe?: Interval;
    params?: StrategyParams;
    isDefault?: boolean;
  }
): Promise<StrategyConfigRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [id];
  const push = (sql: string, v: unknown) => {
    params.push(v);
    sets.push(`${sql} = $${params.length}`);
  };
  if (patch.name !== undefined) push("name", patch.name);
  if (patch.symbol !== undefined) push("symbol", patch.symbol);
  if (patch.timeframe !== undefined) push("timeframe", patch.timeframe);
  if (patch.params !== undefined) push("params", JSON.stringify(patch.params));
  if (patch.isDefault !== undefined) push("is_default", patch.isDefault);
  if (sets.length === 0) return getConfig(id);

  const { rows } = await query<DbConfig>(
    `UPDATE strategy_configs SET ${sets.join(", ")}, updated_at = now()
     WHERE id = $1 RETURNING *`,
    params
  );
  return rows[0] ? toConfig(rows[0]) : null;
}

export async function deleteConfig(id: string): Promise<boolean> {
  const res = await query("DELETE FROM strategy_configs WHERE id = $1", [id]);
  return (res.rowCount ?? 0) > 0;
}
