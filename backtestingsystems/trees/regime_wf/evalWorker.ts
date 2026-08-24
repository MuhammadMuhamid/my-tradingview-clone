/**
 * Walk-forward eval worker for the regime_hold test.
 *
 * Trading window arrives per job (config.feedRange only bounds what is fetched),
 * so one cached feed set serves both the training and the untouched test window.
 *
 * Reports two extras the other trees do not, because they are the whole point of
 * this experiment:
 *   buy_hold_pct  — what simply holding the coin did over the same window
 *   exposure_pct  — share of bars spent long
 * Capture ratios are computed from these in report.py.
 */
import { parentPort, workerData } from "node:worker_threads";
import * as candleRepo from "../../../platform/backend/src/repositories/candles";
import * as symbolRepo from "../../../platform/backend/src/repositories/symbols";
import { FeedStore, toBars, Bars } from "../../../platform/backend/src/engine/mtf";
import { computeMetrics } from "../../../platform/backend/src/engine/metrics";
import { regimeHoldModule } from "./strategy";
import type { Interval } from "../../../platform/backend/src/types/market";

const config = (workerData as { config: Record<string, unknown> }).config;
const feedRange = config.feedRange as Record<string, string>;
const feedStartMs = Date.parse(String(feedRange.start));
const feedEndRaw = String(feedRange.end);
const feedEndMs = feedEndRaw === "now" ? Date.now() : Date.parse(feedEndRaw);
const chartTf = String(config.timeframe ?? "1h") as Interval;

const WARMUP_MS: Record<string, number> = {
  "1m": 3 * 86_400_000, "5m": 10 * 86_400_000, "15m": 40 * 86_400_000,
  "1h": 90 * 86_400_000, "4h": 240 * 86_400_000, "1d": 730 * 86_400_000,
};

const feedCache = new Map<string, Bars>();
const tickCache = new Map<string, number>();

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
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

const r2 = (n: number | null): number | null =>
  n === null || n === undefined || Number.isNaN(n) ? null : Math.round(n * 100) / 100;
const r3 = (n: number | null): number | null =>
  n === null || n === undefined || Number.isNaN(n) ? null : Math.round(n * 1000) / 1000;

interface Job {
  coin: string; genome: number[]; params: Record<string, unknown>;
  startMs: number; endMs: number; probe?: boolean;
}

parentPort!.on("message", (job: Job) => {
  void (async () => {
    try {
      if (job.probe) {
        const bars = await getFeed(job.coin, chartTf);
        parentPort!.postMessage({ ok: true, firstBarMs: bars.time[0] ?? Number.POSITIVE_INFINITY });
        return;
      }
      const p = regimeHoldModule.resolveParams(job.params);
      const feeds = new FeedStore();
      for (const need of regimeHoldModule.requiredFeeds(p, chartTf)) {
        feeds.set(await getFeed(need.symbol ?? job.coin, need.interval));
      }
      const tickSize = await getTick(job.coin);
      const res = regimeHoldModule.runBars(feeds, job.coin, chartTf, p, {
        initialCapital: Number(config.initialCapital ?? 1000),
        commissionPct: Number(config.commissionPct ?? 0.1),
        slippageTicks: Number(config.slippageTicks ?? 0),
        tickSize,
        qtyCash: Number(p.qty_cash),
        qtyPctEquity: Number(p.qty_pct_equity ?? 0),
        fillOnBarClose: Boolean(p.fill_bar_close ?? false),
      }, { startMs: job.startMs, endMs: job.endMs });

      const m = computeMetrics(res.broker.closed, res.equityCurve,
        Number(config.initialCapital ?? 1000), res.broker.commissionPaid);
      parentPort!.postMessage({
        ok: true,
        metrics: {
          net_pct: r2(m.netProfitPct),
          net_usdt: r2(m.netProfit),
          dd_pct: r2(m.maxDrawdownPct),
          win_rate: r2(m.winRatePct),
          trades: m.totalTrades,
          profit_factor: m.profitFactor === null ? null : r3(m.profitFactor),
          buy_hold_pct: r2(res.buyHoldPct),
          exposure_pct: res.barsProcessed > 0 ? r2(100 * res.barsLong / res.barsProcessed) : 0,
        },
      });
    } catch (err) {
      parentPort!.postMessage({ ok: false, error: (err as Error).message });
    }
  })();
});
