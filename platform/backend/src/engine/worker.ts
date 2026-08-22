/**
 * Backtest worker — polls the queue and runs one backtest at a time.
 * Claiming uses FOR UPDATE SKIP LOCKED, so multiple processes stay safe.
 */
import type { FastifyBaseLogger } from "fastify";
import * as backtestRepo from "../repositories/backtests";
import { executeBacktest } from "./backtester";

const POLL_MS = 3000;

export function startBacktestWorker(log: FastifyBaseLogger): { stop: () => void } {
  let running = false;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      for (;;) {
        const job = await backtestRepo.claimNextQueued();
        if (!job) break;
        log.info({ backtestId: job.id, symbol: job.symbol }, "backtest started");
        try {
          const output = await executeBacktest(job, (msg) => log.info({ backtestId: job.id }, msg));
          await backtestRepo.finishBacktest(job.id, output);
          log.info(
            { backtestId: job.id, trades: output.metrics.totalTrades, netPct: output.metrics.netProfitPct },
            "backtest finished"
          );
        } catch (err) {
          const message = (err as Error).message;
          await backtestRepo.failBacktest(job.id, message);
          log.error({ backtestId: job.id, err: message }, "backtest failed");
        }
      }
    } finally {
      running = false;
    }
  };

  const interval = setInterval(() => void tick(), POLL_MS);
  void tick();
  return {
    stop: () => {
      stopped = true;
      clearInterval(interval);
    },
  };
}
