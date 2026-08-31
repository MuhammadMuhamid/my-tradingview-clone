import { query } from "../db/pool";
import type {
  BacktestMetrics,
  BacktestRequest,
  BacktestRow,
  BacktestStatus,
  EquityPoint,
  TradeRecord,
} from "../types/backtest";
import type { Interval } from "../types/market";
import type { StrategyParams } from "../types/strategy";

export interface DbBacktest {
  id: string;
  strategy_id: number;
  config_id: string | null;
  symbol: string;
  timeframe: Interval;
  start_time: Date;
  end_time: Date;
  params: StrategyParams;
  initial_capital: number;
  commission_pct: number;
  slippage_ticks: number;
  status: BacktestStatus;
  error: string | null;
  metrics: BacktestMetrics | null;
  equity_curve: EquityPoint[] | null;
  engine_fingerprint: string | null;
  started_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
}

export function toBacktestRow(r: DbBacktest): BacktestRow {
  return {
    id: r.id,
    strategyId: r.strategy_id,
    configId: r.config_id,
    symbol: r.symbol,
    timeframe: r.timeframe,
    startTime: r.start_time.toISOString(),
    endTime: r.end_time.toISOString(),
    params: r.params,
    initialCapital: r.initial_capital,
    commissionPct: r.commission_pct,
    slippageTicks: r.slippage_ticks,
    status: r.status,
    error: r.error,
    metrics: r.metrics,
    equityCurve: r.equity_curve,
    engineFingerprint: r.engine_fingerprint,
    startedAt: r.started_at ? r.started_at.toISOString() : null,
    finishedAt: r.finished_at ? r.finished_at.toISOString() : null,
    createdAt: r.created_at.toISOString(),
  };
}

export async function createBacktest(req: BacktestRequest): Promise<BacktestRow> {
  const { rows } = await query<DbBacktest>(
    `INSERT INTO backtests
       (strategy_id, config_id, symbol, timeframe, start_time, end_time,
        params, initial_capital, commission_pct, slippage_ticks)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [
      req.strategyId,
      req.configId ?? null,
      req.symbol,
      req.timeframe,
      new Date(req.startTime),
      new Date(req.endTime),
      JSON.stringify(req.params),
      req.initialCapital,
      req.commissionPct,
      req.slippageTicks,
    ]
  );
  return toBacktestRow(rows[0]!);
}

export async function getBacktest(id: string): Promise<BacktestRow | null> {
  const { rows } = await query<DbBacktest>(
    "SELECT * FROM backtests WHERE id = $1",
    [id]
  );
  return rows[0] ? toBacktestRow(rows[0]) : null;
}

export async function listBacktests(opts: {
  symbol?: string;
  limit?: number;
} = {}): Promise<BacktestRow[]> {
  const params: unknown[] = [];
  let where = "";
  if (opts.symbol) {
    params.push(opts.symbol);
    where = `WHERE symbol = $${params.length}`;
  }
  params.push(opts.limit ?? 50);
  const { rows } = await query<DbBacktest>(
    `SELECT * FROM backtests ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
    params
  );
  return rows.map(toBacktestRow);
}

/** Claims the oldest queued backtest for the Stage 2 runner (single-worker safe). */
export async function claimNextQueued(): Promise<BacktestRow | null> {
  const { rows } = await query<DbBacktest>(
    `UPDATE backtests SET status = 'running', started_at = now()
     WHERE id = (
       SELECT id FROM backtests WHERE status = 'queued'
       ORDER BY created_at ASC LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`
  );
  return rows[0] ? toBacktestRow(rows[0]) : null;
}

type WriteQuery = (text: string, params?: unknown[]) => Promise<unknown>;

export async function finishBacktest(
  id: string,
  result: {
    metrics: BacktestMetrics;
    equityCurve: EquityPoint[];
    trades: TradeRecord[];
    engine: string;
  },
  runQuery: WriteQuery = query
): Promise<void> {
  await runQuery(
    `UPDATE backtests
     SET status = 'done', metrics = $2, equity_curve = $3,
         engine_fingerprint = $4, finished_at = now()
     WHERE id = $1`,
    [id, JSON.stringify(result.metrics), JSON.stringify(result.equityCurve), result.engine]
  );
  if (result.trades.length > 0) {
    const COLS = 13;
    const values: unknown[] = [];
    const tuples = result.trades.map((t, i) => {
      const o = i * COLS;
      values.push(
        id, t.tradeNo, t.direction,
        new Date(t.entryTime), t.entryPrice,
        t.exitTime !== null ? new Date(t.exitTime) : null, t.exitPrice,
        t.qty, t.pnl, t.pnlPct, t.exitReason, t.runUpPct, t.drawdownPct
      );
      return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7},$${o + 8},$${o + 9},$${o + 10},$${o + 11},$${o + 12},$${o + 13})`;
    });
    await runQuery(
      `INSERT INTO backtest_trades
         (backtest_id, trade_no, direction, entry_time, entry_price,
          exit_time, exit_price, qty, pnl, pnl_pct, exit_reason, run_up_pct, drawdown_pct)
       VALUES ${tuples.join(",")}`,
      values
    );
  }
}

export async function failBacktest(id: string, error: string): Promise<void> {
  await query(
    "UPDATE backtests SET status = 'error', error = $2, finished_at = now() WHERE id = $1",
    [id, error]
  );
}

export async function getBacktestTrades(backtestId: string): Promise<TradeRecord[]> {
  interface DbTrade {
    trade_no: number;
    direction: "long" | "short";
    entry_time: Date;
    entry_price: number;
    exit_time: Date | null;
    exit_price: number | null;
    qty: number;
    pnl: number | null;
    pnl_pct: number | null;
    exit_reason: string | null;
    run_up_pct: number | null;
    drawdown_pct: number | null;
    cum_profit: number | null;
  }
  const { rows } = await query<DbTrade>(
    "SELECT * FROM backtest_trades WHERE backtest_id = $1 ORDER BY trade_no",
    [backtestId]
  );
  return rows.map((t) => ({
    tradeNo: t.trade_no,
    direction: t.direction,
    entryTime: t.entry_time.getTime(),
    entryPrice: t.entry_price,
    exitTime: t.exit_time ? t.exit_time.getTime() : null,
    exitPrice: t.exit_price,
    qty: t.qty,
    pnl: t.pnl,
    pnlPct: t.pnl_pct,
    exitReason: t.exit_reason,
    runUpPct: t.run_up_pct,
    drawdownPct: t.drawdown_pct,
    cumProfit: t.cum_profit,
  }));
}
