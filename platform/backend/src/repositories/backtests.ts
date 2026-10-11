import { pool, query } from "../db/pool";
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
  holdout_fraction: number | null;
  status: BacktestStatus;
  error: string | null;
  metrics: BacktestMetrics | null;
  equity_curve: EquityPoint[] | null;
  engine_fingerprint: string | null;
  result_provenance: Record<string, unknown> | null;
  segments: Record<string, unknown> | null;
  execution_truth: Record<string, unknown> | null;
  stress_run_id: string | null;
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
    holdoutFraction: r.holdout_fraction ?? null,
    status: r.status,
    error: r.error,
    metrics: r.metrics,
    equityCurve: r.equity_curve,
    engineFingerprint: r.engine_fingerprint,
    resultProvenance: r.result_provenance ?? null,
    segments: r.segments ?? null,
    executionTruth: r.execution_truth ?? null,
    stressRunId: r.stress_run_id ?? null,
    semanticsStatus: r.result_provenance ? "reproducible"
      : r.engine_fingerprint ? "engine_only_legacy" : "historical_unversioned",
    startedAt: r.started_at ? r.started_at.toISOString() : null,
    finishedAt: r.finished_at ? r.finished_at.toISOString() : null,
    createdAt: r.created_at.toISOString(),
  };
}

export async function createBacktest(req: BacktestRequest, runQuery: typeof query = query): Promise<BacktestRow> {
  const { rows } = await runQuery<DbBacktest>(
    `INSERT INTO backtests
       (strategy_id, config_id, symbol, timeframe, start_time, end_time,
        params, initial_capital, commission_pct, slippage_ticks, holdout_fraction,
        stress_run_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
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
      req.holdoutFraction ?? null,
      req.stressRunId ?? null,
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

/**
 * Record a finished run: its metrics, and the trades that produced them.
 *
 * ── Why this takes a client rather than the pool ──────────────────────────
 *
 * These are two statements, and they were two statements on two connections.
 * A crash, a restart or a lost connection between them left a row reading
 * `status = 'done'` with a full metrics block and no trades at all — a result
 * that looks complete, is reported as complete, and cannot be told apart from
 * a genuine zero-trade run. So the pair is atomic: either the run is finished
 * with its trades or it is not finished.
 *
 * `runQuery` stays injectable for the tests that drive this without a database.
 */
export async function finishBacktest(
  id: string,
  result: {
    metrics: BacktestMetrics;
    equityCurve: EquityPoint[];
    trades: TradeRecord[];
    engine: string;
    provenance?: Record<string, unknown>;
    segments?: unknown;
    executionTruth?: unknown;
  },
  runQuery?: WriteQuery
): Promise<void> {
  if (runQuery === undefined) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await finishBacktest(id, result, (text, params) => client.query(text, params));
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    return;
  }
  await runQuery(
    `UPDATE backtests
     SET status = 'done', metrics = $2, equity_curve = $3,
         engine_fingerprint = $4, result_provenance = $5,
         segments = $6, execution_truth = $7, finished_at = now()
     WHERE id = $1`,
    [id, JSON.stringify(result.metrics), JSON.stringify(result.equityCurve), result.engine,
      result.provenance ? JSON.stringify(result.provenance) : null,
      result.segments ? JSON.stringify(result.segments) : null,
      result.executionTruth ? JSON.stringify(result.executionTruth) : null]
  );
  if (result.trades.length > 0) {
    /*
     * `cum_profit` used to be missing from here and from nowhere else.
     *
     * The column exists (`001_init.sql`), all three strategies compute it, the
     * record type carries it, `getBacktestTrades` reads it back and
     * `TradeList` renders it — and this INSERT named thirteen columns. So
     * every stored trade had a null cumulative, and the Cumulative column was
     * blank on the research detail page and in the chart's Strategy Tester,
     * for every run ever recorded. Written down as a count, `COLS` is the kind
     * of thing that stays thirteen when a fourteenth value is added; the
     * column list below is the source of truth for it now.
     */
    const COLUMNS = [
      "backtest_id", "trade_no", "direction", "entry_time", "entry_price",
      "exit_time", "exit_price", "qty", "pnl", "pnl_pct", "exit_reason",
      "run_up_pct", "drawdown_pct", "cum_profit",
    ] as const;
    const values: unknown[] = [];
    const tuples = result.trades.map((t, i) => {
      const o = i * COLUMNS.length;
      values.push(
        id, t.tradeNo, t.direction,
        new Date(t.entryTime), t.entryPrice,
        t.exitTime !== null ? new Date(t.exitTime) : null, t.exitPrice,
        t.qty, t.pnl, t.pnlPct, t.exitReason, t.runUpPct, t.drawdownPct,
        t.cumProfit
      );
      return `(${COLUMNS.map((_, c) => `$${o + c + 1}`).join(",")})`;
    });
    await runQuery(
      `INSERT INTO backtest_trades (${COLUMNS.join(", ")})
       VALUES ${tuples.join(",")}`,
      values
    );
  }
}

/**
 * Delete one run, unless it is running or belongs to a stress analysis.
 *
 * One statement, so the refusal and the delete cannot race the worker: a run
 * the worker claims between a read and a delete would otherwise be deleted
 * mid-simulation and its result written to nothing. Under READ COMMITTED a
 * claim that commits first makes this `WHERE` fail on re-check.
 *
 * Trades go with the run (`backtest_trades … ON DELETE CASCADE`); a stress
 * analysis seeded from it keeps its own settings and loses only the link
 * (`stress_runs.source_backtest_id … ON DELETE SET NULL`). A stress WINDOW is
 * refused, because its analysis reads it and would wait for it forever.
 *
 * Returns the deleted row's id, or null when nothing was deleted — the route
 * reads the row to say why.
 */
export async function deleteBacktest(id: string, runQuery: typeof query = query): Promise<string | null> {
  const { rows } = await runQuery<{ id: string }>(
    `DELETE FROM backtests
     WHERE id = $1 AND status <> 'running' AND stress_run_id IS NULL
     RETURNING id`,
    [id]
  );
  return rows[0]?.id ?? null;
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
