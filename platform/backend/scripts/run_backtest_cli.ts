/**
 * Run a backtest synchronously in THIS process (fresh code, no server worker):
 * creates the row, claims it immediately, executes, persists, prints the id.
 *
 *   npx tsx scripts/run_backtest_cli.ts <params.json>
 *
 * params.json: { symbol, timeframe, startTime, endTime, initialCapital,
 *                commissionPct, slippageTicks, params: {...engine params} }
 */
import fs from "node:fs";
import { query, closePool } from "../src/db/pool";
import * as strategyRepo from "../src/repositories/strategies";
import { executeBacktest } from "../src/engine/backtester";
import { finishBacktest, getBacktest, failBacktest } from "../src/repositories/backtests";
import type { BacktestRow } from "../src/types/backtest";

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) throw new Error("usage: run_backtest_cli.ts <spec.json>");
  const spec = JSON.parse(fs.readFileSync(file, "utf8"));
  const strategy = await strategyRepo.getStrategyByKey(spec.strategyKey ?? "ma_rr_v9");
  if (!strategy) throw new Error("strategy not found");

  // Insert directly as 'running' so the server worker can never claim it.
  const { rows } = await query<{ id: string }>(
    `INSERT INTO backtests
       (strategy_id, symbol, timeframe, start_time, end_time, params,
        initial_capital, commission_pct, slippage_ticks, status, started_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'running',now())
     RETURNING id`,
    [
      strategy.id, spec.symbol, spec.timeframe,
      new Date(spec.startTime), new Date(spec.endTime),
      JSON.stringify(spec.params ?? {}),
      spec.initialCapital ?? 1000, spec.commissionPct ?? 0.05, spec.slippageTicks ?? 0,
    ]
  );
  const id = rows[0]!.id;
  const row = (await getBacktest(id)) as BacktestRow;
  try {
    const t0 = Date.now();
    const out = await executeBacktest(row, (m) => console.log("  " + m));
    await finishBacktest(id, out);
    const m = out.metrics;
    console.log(`backtestId: ${id}`);
    console.log(
      `net ${m.netProfitPct.toFixed(2)}% | dd ${m.maxDrawdownPct.toFixed(2)}% | ` +
      `wr ${m.winRatePct.toFixed(2)}% | pf ${m.profitFactor?.toFixed(3) ?? "-"} | ` +
      `trades ${m.totalTrades} | ${((Date.now() - t0) / 1000).toFixed(1)}s`
    );
  } catch (err) {
    await failBacktest(id, (err as Error).message);
    throw err;
  } finally {
    await closePool();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
