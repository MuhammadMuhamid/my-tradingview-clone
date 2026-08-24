/**
 * MTF Lean 3-year eval worker — replays one stored config over the pre-optimizer period.
 *
 * Differences from optimizer1y1h/evalWorker.ts:
 *   - the trading window comes per job (each coin's holdout starts at its own
 *     first bar, so one window does not fit all)
 *   - qty_pct_equity is forced to 0 and qtyCash to config.qtyCash, so every
 *     config trades a FIXED $1000 notional. The live tree compounds at 100% of
 *     equity, which makes net% a function of leverage rather than edge.
 *   - reports buy-and-hold over the same window, so the leaderboard can show
 *     what each config achieved relative to simply holding the coin.
 */
import { parentPort, workerData } from "node:worker_threads";
import * as candleRepo from "../src/repositories/candles";
import * as symbolRepo from "../src/repositories/symbols";
import { FeedStore, toBars, Bars } from "../src/engine/mtf";
import { mtfLeanModule } from "../src/engine/strategies/mtf_lean";
import { computeMetrics } from "../src/engine/metrics";
import type { Interval } from "../src/types/market";
import type { StrategyParams } from "../src/types/strategy";

const config = (workerData as { config: Record<string, unknown> }).config;
const chartTf = String(config.timeframe ?? "1h") as Interval;
const holdoutStartMs = Date.parse(String(config.holdoutStart));
const holdoutEndMs = Date.parse(String(config.holdoutEnd));
const splitMs = Date.parse(String(config.splitDate));

// Deep warmup so indicators are settled by the first tradeable bar.
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
    const from = holdoutStartMs - (WARMUP_MS[interval] ?? 30 * 86_400_000);
    const candles = await withDbRetry(() => candleRepo.getCandles(symbol, interval, { from, to: holdoutEndMs }));
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
  coin: string; rank: number; params: Record<string, unknown>;
  startMs: number; endMs: number; probe?: boolean;
}

parentPort!.on("message", (job: Job) => {
  void (async () => {
    try {
      if (job.probe) {
        const bars = await getFeed(job.coin, chartTf);
        parentPort!.postMessage({
          ok: true,
          firstBarMs: bars.time[0] ?? Number.POSITIVE_INFINITY,
          barCount: bars.time.length,
        });
        return;
      }
      const p = mtfLeanModule.resolveParams(job.params as StrategyParams);
      const feeds = new FeedStore();
      for (const need of mtfLeanModule.requiredFeeds(p, chartTf)) {
        feeds.set(await getFeed(need.symbol ?? job.coin, need.interval));
      }
      const tickSize = await getTick(job.coin);
      const result = mtfLeanModule.runBars(feeds, job.coin, chartTf, p, {
        initialCapital: Number(config.initialCapital ?? 1000),
        commissionPct: Number(config.commissionPct ?? 0.1),
        slippageTicks: Number(config.slippageTicks ?? 0),
        tickSize,
        qtyCash: Number(config.qtyCash ?? 1000),
        qtyPctEquity: 0,               // forced: no compounding, no leverage effect
        fillOnBarClose: Boolean(p.fill_bar_close ?? false),
      }, { startMs: job.startMs, endMs: job.endMs });

      const m = computeMetrics(result.broker.closed, result.equityCurve,
        Number(config.initialCapital ?? 1000), result.broker.commissionPaid);

      // Split realised PnL either side of the optimizer's window start, so the
      // report can show what came from unseen history vs the fitted year.
      let oosPnl = 0, isPnl = 0, oosWins = 0, isWins = 0;
      const oosEntries = new Set<number>(), isEntries = new Set<number>();
      for (const t of result.broker.closed) {
        const when = (t as { exitTime?: number; entryTime?: number }).exitTime
          ?? (t as { entryTime?: number }).entryTime ?? 0;
        const pnl = t.pnl ?? 0;
        const eb = (t as { entryBar?: number }).entryBar ?? -1;
        if (when < splitMs) { oosPnl += pnl; oosEntries.add(eb); if (pnl > 0) oosWins++; }
        else { isPnl += pnl; isEntries.add(eb); if (pnl > 0) isWins++; }
      }
      const oosTrades = oosEntries.size, isTrades = isEntries.size;
      const cap = Number(config.initialCapital ?? 1000);

      // Buy-and-hold over the identical window, for context in the leaderboard.
      const chart = feeds.get(job.coin, chartTf);
      let first = NaN, last = NaN;
      for (let i = 0; i < chart.time.length; i++) {
        const t = chart.time[i]!;
        if (t < job.startMs) continue;
        if (t > job.endMs) break;
        if (Number.isNaN(first)) first = chart.close[i]!;
        last = chart.close[i]!;
      }
      const bh = Number.isNaN(first) || first <= 0 ? null : ((last / first) - 1) * 100;

      parentPort!.postMessage({
        ok: true,
        metrics: {
          net_pct: r2(m.netProfitPct),
          net_usdt: r2(m.netProfit),
          dd_pct: r2(m.maxDrawdownPct),
          win_rate: r2(m.winRatePct),
          trades: new Set(result.broker.closed.map((t) => t.entryBar)).size,
          legs: m.totalTrades,
          profit_factor: m.profitFactor === null ? null : r3(m.profitFactor),
          buy_hold_pct: r2(bh),
          oos_net_pct: r2((oosPnl / cap) * 100),
          is_net_pct: r2((isPnl / cap) * 100),
          oos_trades: oosTrades,
          is_trades: isTrades,
          oos_win_rate: oosTrades ? r2((oosWins / oosTrades) * 100) : null,
          is_win_rate: isTrades ? r2((isWins / isTrades) * 100) : null,
        },
      });
    } catch (err) {
      parentPort!.postMessage({ ok: false, error: (err as Error).message });
    }
  })();
});
