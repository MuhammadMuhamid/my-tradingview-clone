/**
 * Stress runs: the coordinator rows, and the ordinary backtests they point at.
 *
 * A stress run does not execute anything. It records how a set of adverse
 * windows was chosen from benchmark market data, and which normal backtest
 * answered each one. Reading a stress run is therefore a join: the windows as
 * discovered, plus whatever the worker has since made of them.
 */
import { query } from "../db/pool";
import type { Interval } from "../types/market";
import type { StressProvenance, StressWindow } from "../engine/stress";
import type { BacktestRow } from "../types/backtest";
import type { StrategyParams } from "../types/strategy";
import { toBacktestRow, type DbBacktest } from "./backtests";

/** A discovered window plus the run that answered it. */
export interface StressRunWindow extends StressWindow {
  backtestId: string;
}

export interface StressRunRow {
  id: string;
  strategyId: number;
  configId: string | null;
  /** C-06: the finished run whose settings this copied, or null. Provenance only. */
  sourceBacktestId: string | null;
  symbol: string;
  timeframe: Interval;
  params: StrategyParams;
  initialCapital: number;
  commissionPct: number;
  slippageTicks: number;
  benchmarkSymbol: string;
  benchmarkInterval: Interval;
  discovery: StressProvenance;
  windows: StressRunWindow[];
  status: "running" | "done" | "error";
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

interface DbStressRun {
  id: string;
  strategy_id: number;
  config_id: string | null;
  /** Absent on a database that predates migration 046. */
  source_backtest_id?: string | null;
  symbol: string;
  timeframe: Interval;
  params: StrategyParams;
  initial_capital: number;
  commission_pct: number;
  slippage_ticks: number;
  benchmark_symbol: string;
  benchmark_interval: Interval;
  discovery: StressProvenance;
  windows: StressRunWindow[];
  status: "running" | "done" | "error";
  error: string | null;
  created_at: Date;
  finished_at: Date | null;
}

function toRow(r: DbStressRun): StressRunRow {
  return {
    id: r.id,
    strategyId: r.strategy_id,
    configId: r.config_id,
    sourceBacktestId: r.source_backtest_id ?? null,
    symbol: r.symbol,
    timeframe: r.timeframe,
    params: r.params,
    initialCapital: Number(r.initial_capital),
    commissionPct: Number(r.commission_pct),
    slippageTicks: Number(r.slippage_ticks),
    benchmarkSymbol: r.benchmark_symbol,
    benchmarkInterval: r.benchmark_interval,
    discovery: r.discovery,
    windows: r.windows,
    status: r.status,
    error: r.error,
    createdAt: r.created_at.toISOString(),
    finishedAt: r.finished_at ? r.finished_at.toISOString() : null,
  };
}

export async function createStressRun(input: {
  strategyId: number;
  configId: string | null;
  sourceBacktestId: string | null;
  symbol: string;
  timeframe: Interval;
  params: StrategyParams;
  initialCapital: number;
  commissionPct: number;
  slippageTicks: number;
  benchmarkSymbol: string;
  benchmarkInterval: Interval;
  discovery: StressProvenance;
  windows: StressRunWindow[];
}, runQuery: typeof query = query): Promise<StressRunRow> {
  const { rows } = await runQuery<DbStressRun>(
    `INSERT INTO stress_runs
       (strategy_id, config_id, symbol, timeframe, params, initial_capital,
        commission_pct, slippage_ticks, benchmark_symbol, benchmark_interval,
        discovery, windows, source_backtest_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING *`,
    [
      input.strategyId, input.configId, input.symbol, input.timeframe,
      JSON.stringify(input.params), input.initialCapital, input.commissionPct,
      input.slippageTicks, input.benchmarkSymbol, input.benchmarkInterval,
      JSON.stringify(input.discovery), JSON.stringify(input.windows),
      input.sourceBacktestId,
    ],
  );
  return toRow(rows[0]!);
}

export async function getStressRun(id: string): Promise<StressRunRow | null> {
  const { rows } = await query<DbStressRun>("SELECT * FROM stress_runs WHERE id = $1", [id]);
  return rows[0] ? toRow(rows[0]) : null;
}

export async function listStressRuns(limit = 50): Promise<StressRunRow[]> {
  const { rows } = await query<DbStressRun>(
    "SELECT * FROM stress_runs ORDER BY created_at DESC LIMIT $1", [Math.min(Math.max(limit, 1), 200)],
  );
  return rows.map(toRow);
}

/** The per-window backtests, in window order. */
export async function stressRunBacktests(run: StressRunRow): Promise<Map<string, BacktestRow>> {
  const ids = run.windows.map((w) => w.backtestId);
  if (ids.length === 0) return new Map();
  const { rows } = await query<DbBacktest>(
    "SELECT * FROM backtests WHERE id = ANY($1::uuid[])", [ids],
  );
  return new Map(rows.map((r) => [r.id, toBacktestRow(r)]));
}

/**
 * Settle the coordinator from its children.
 *
 * `running` while any window is still queued or running; `error` when every
 * window failed — a partial failure stays `done`, because a report over four
 * of five windows is a real report and saying otherwise would discard it. The
 * per-window status is on each child and is what a reader should see.
 */
export async function settleStressRun(run: StressRunRow): Promise<StressRunRow> {
  if (run.status !== "running") return run;
  // An older coordinator may be visible while its children are being
  // attached. No windows is not evidence that all windows finished.
  if (run.windows.length === 0) return run;
  const children = await stressRunBacktests(run);
  const states = run.windows.map((w) => children.get(w.backtestId)?.status ?? "queued");
  if (states.some((s) => s === "queued" || s === "running")) return run;

  const failed = states.filter((s) => s === "error").length;
  const status = failed === states.length && states.length > 0 ? "error" : "done";
  const error = status === "error"
    ? "Every stress window failed to run. The per-window results say why."
    : null;
  const { rows } = await query<DbStressRun>(
    `UPDATE stress_runs SET status = $2, error = $3, finished_at = now()
     WHERE id = $1 AND status = 'running' RETURNING *`,
    [run.id, status, error],
  );
  return rows[0] ? toRow(rows[0]) : run;
}

/**
 * Record which backtests answered which windows, once they all exist.
 *
 * The coordinator is created before its children so each child can carry its
 * id; this closes the loop. Two statements rather than one because a child
 * needs the coordinator's id and the coordinator needs the children's.
 */
export async function attachStressWindows(
  id: string, windows: StressRunWindow[],
  runQuery: typeof query = query,
): Promise<StressRunRow> {
  const { rows } = await runQuery<DbStressRun>(
    "UPDATE stress_runs SET windows = $2 WHERE id = $1 RETURNING *",
    [id, JSON.stringify(windows)],
  );
  return toRow(rows[0]!);
}
