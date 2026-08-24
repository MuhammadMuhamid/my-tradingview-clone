/**
 * Walk-forward eval worker.
 *
 * Differs from optimizer1y1h/evalWorker.ts in one way that matters: the trading
 * window is supplied PER JOB rather than fixed at worker start. The candle feed
 * is fetched once per (symbol, interval) covering config.feedRange, and each job
 * restricts trading to its own [startMs, endMs].
 *
 * That is safe against look-ahead: ma_rr_v9.runBars computes signals over the
 * whole feed but only enters/exits between startMs and endMs, and the signal
 * arrays are causal (bar i uses bars <= i). A training job therefore cannot see
 * a bar at or after its fold's testStart, even though those bars sit in RAM.
 */
import { parentPort, workerData } from "node:worker_threads";
import * as candleRepo from "../src/repositories/candles";
import * as symbolRepo from "../src/repositories/symbols";
import { FeedStore, toBars, Bars } from "../src/engine/mtf";
import { maRrV9Module } from "../src/engine/strategies/ma_rr_v9";
import { computeMetrics } from "../src/engine/metrics";
import type { Interval } from "../src/types/market";
import type { StrategyParams } from "../src/types/strategy";

const config = (workerData as { config: Record<string, unknown> }).config;
const feedRange = config.feedRange as Record<string, string>;
const feedStartMs = Date.parse(feedRange.start!);
const feedEndMs = feedRange.end === "now" ? Date.now() : Date.parse(feedRange.end!);
const chartTf = String(config.timeframe ?? "1h") as Interval;

// Deep warmup ahead of feedRange.start so indicators are settled by the first
// tradeable bar of the earliest fold.
const WARMUP_MS: Record<string, number> = {
  "1m": 3 * 86_400_000,
  "5m": 10 * 86_400_000,
  "15m": 40 * 86_400_000,
  "1h": 90 * 86_400_000,
  "4h": 240 * 86_400_000,
  "1d": 730 * 86_400_000,
};

const feedCache = new Map<string, Bars>();
const tickCache = new Map<string, number>();

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
async function withDbRetry<T>(fn: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try { return await fn(); } catch (err) {
      last = err;
      const msg = String((err as Error)?.message ?? err);
      if (!/ECONNREFUSED|connection terminated|Connection terminated|57P0[123]|starting up|shutting down/i.test(msg)) throw err;
      await sleep(Math.min(10_000, 500 * 2 ** attempt));
    }
  }
  throw last;
}

async function getFeed(symbol: string, interval: Interval): Promise<Bars> {
  const key = `${symbol}|${interval}`;
  let bars = feedCache.get(key);
  if (!bars) {
    const from = feedStartMs - (WARMUP_MS[interval] ?? 30 * 86_400_000);
    const candles = await withDbRetry(() => candleRepo.getCandles(symbol, interval, { from, to: feedEndMs }));
    if (candles.length === 0) throw new Error(`no ${interval} data for ${symbol}`);
    bars = toBars(candles);
    feedCache.set(key, bars);
  }
  return bars;
}

async function getTick(symbol: string): Promise<number> {
  let t = tickCache.get(symbol);
  if (t === undefined) {
    const info = await withDbRetry(() => symbolRepo.getSymbol(symbol));
    t = info?.priceTick ?? 0;
    if (!t || t <= 0) throw new Error(`no tick size for ${symbol}`);
    tickCache.set(symbol, t);
  }
  return t;
}

const round2 = (n: number | null): number | null =>
  n === null || n === undefined || Number.isNaN(n) ? null : Math.round(n * 100) / 100;
const round3 = (n: number | null): number | null =>
  n === null || n === undefined || Number.isNaN(n) ? null : Math.round(n * 1000) / 1000;

interface Job {
  coin: string;
  genome: number[];
  params: Record<string, unknown>;
  startMs: number;
  endMs: number;
}

/** First candle open time we hold for a symbol — used to gate fold eligibility. */
async function firstBarMs(symbol: string): Promise<number> {
  const bars = await getFeed(symbol, chartTf);
  return bars.time[0] ?? Number.POSITIVE_INFINITY;
}

parentPort!.on("message", (job: Job & { probe?: boolean }) => {
  void (async () => {
    try {
      if (job.probe) {
        parentPort!.postMessage({ ok: true, firstBarMs: await firstBarMs(job.coin) });
        return;
      }
      const p = maRrV9Module.resolveParams(job.params as StrategyParams);
      const feeds = new FeedStore();
      for (const need of maRrV9Module.requiredFeeds(p, chartTf)) {
        feeds.set(await getFeed(need.symbol ?? job.coin, need.interval));
      }
      const tickSize = await getTick(job.coin);
      const result = maRrV9Module.runBars(feeds, job.coin, chartTf, p, {
        initialCapital: Number(config.initialCapital ?? 1000),
        commissionPct: Number(config.commissionPct ?? 0.1),
        slippageTicks: Number(config.slippageTicks ?? 0),
        tickSize,
        qtyCash: Number(p.qty_cash),
        qtyPctEquity: Number(p.qty_pct_equity ?? 0),
        fillOnBarClose: Boolean(p.fill_bar_close ?? false),
      }, { startMs: job.startMs, endMs: job.endMs });
      const m = computeMetrics(result.broker.closed, result.equityCurve,
        Number(config.initialCapital ?? 1000), result.broker.commissionPaid);
      parentPort!.postMessage({
        ok: true,
        metrics: {
          net_pct: round2(m.netProfitPct),
          net_usdt: round2(m.netProfit),
          dd_pct: round2(m.maxDrawdownPct),
          win_rate: round2(m.winRatePct),
          trades: m.totalTrades,
          profit_factor: m.profitFactor === null ? null : round3(m.profitFactor),
        },
      });
    } catch (err) {
      parentPort!.postMessage({ ok: false, error: (err as Error).message });
    }
  })();
});
