/**
 * Optimizer eval worker: keeps every candle feed for its coins in RAM and runs
 * one backtest per message. Feeds are fetched once per (symbol, interval) with
 * a generous fixed warmup window so ANY genome's requiredFeeds is covered.
 */
import { parentPort, workerData } from "node:worker_threads";
import * as candleRepo from "../../../platform/backend/src/repositories/candles";
import * as symbolRepo from "../../../platform/backend/src/repositories/symbols";
import { FeedStore, toBars, Bars } from "../../../platform/backend/src/engine/mtf";
import { maRrV9Module } from "../../../platform/backend/src/engine/strategies/ma_rr_v9";
import { computeMetrics, computeSegmentMetrics } from "../../../platform/backend/src/engine/metrics";
import type { Interval } from "../../../platform/backend/src/types/market";
import type { StrategyParams } from "../../../platform/backend/src/types/strategy";

const config = (workerData as { config: Record<string, unknown> }).config;
const startMs = Date.parse(String((config.range as Record<string, string>).start));
const endRaw = String((config.range as Record<string, string>).end);
const endMs = endRaw === "now" ? Date.now() : Date.parse(endRaw);
const chartTf = String(config.timeframe ?? "5m") as Interval;
const splitMs = Date.parse(String((config.range as Record<string, string>).split));
if (!Number.isFinite(splitMs)) throw new Error("config.range.split is required (IS/OOS boundary)");

// Fixed deep warmup per interval (covers every genome the grid can produce).
const WARMUP_MS: Record<string, number> = {
  "1m": 3 * 86_400_000,      // ≥ 1500 bars on 1m is 25h; 3d is plenty for 200-SMA×3
  "5m": 15 * 86_400_000,   // 1500 chart bars on 5m is 5.2d; 15d covers the 1m MA1 feed too
  "15m": 40 * 86_400_000,    // 1500 chart bars ≈ 15.6d; HACOLT deep warmup ≈ 40d
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
    const from = startMs - (WARMUP_MS[interval] ?? 30 * 86_400_000);
    const candles = await withDbRetry(() => candleRepo.getCandles(symbol, interval, { from, to: endMs }));
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

interface Job { coin: string; genome: number[]; params: Record<string, unknown> }

parentPort!.on("message", (job: Job) => {
  void (async () => {
    try {
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
      }, { startMs, endMs });
      // ── In-sample / out-of-sample split ──────────────────────────────────
      // The GA only ever sees IS. OOS is scored from the same single run and
      // carried alongside so a config that was merely curve-fitted to IS shows
      // up as a collapse in OOS. Splitting one run (rather than running twice)
      // is exact here because sizing is fixed cash: trade outcomes do not
      // depend on account equity, so the later window is unaffected by the
      // earlier one's P&L.
      const cap = Number(config.initialCapital ?? 1000);
      const isM  = computeSegmentMetrics(result.broker.closed, result.equityCurve, cap, startMs, splitMs);
      const oosM = computeSegmentMetrics(result.broker.closed, result.equityCurve, cap, splitMs, endMs);
      const m    = computeMetrics(result.broker.closed, result.equityCurve, cap, result.broker.commissionPaid);
      // `trades` counts ENTRIES, not legs. This strategy takes partial profits
      // via RR1/RR2/RR3, so one entry closes as up to three legs; the previous
      // `m.totalTrades` counted legs and sat next to a leg-based win rate,
      // which made win% and SL% impossible to reconcile.
      const entriesIn = (from: number, to: number): number =>
        new Set(result.broker.closed.filter((t) => t.entryTime >= from && t.entryTime < to)
          .map((t) => t.entryBar)).size;
      parentPort!.postMessage({
        ok: true,
        metrics: {
          // Headline numbers are IN-SAMPLE: that is what the GA optimises.
          net_pct: round2(isM.netProfitPct),
          net_usdt: round2(isM.netProfit),
          dd_pct: round2(isM.maxDrawdownPct),
          win_rate: round2(isM.winRatePct),
          trades: entriesIn(startMs, splitMs),
          legs: isM.totalTrades,
          leg_win_rate: isM.legWinRatePct === undefined ? null : round2(isM.legWinRatePct),
          profit_factor: isM.profitFactor === null ? null : round3(isM.profitFactor),
          sl_hit: isM.slEntries ?? null,
          sl_rate: isM.slRatePct === undefined ? null : round2(isM.slRatePct),
          sl_loss: isM.slLossEntries ?? null,
          sl_loss_rate: isM.slLossRatePct === undefined ? null : round2(isM.slLossRatePct),
          sl_profit: isM.slProfitEntries ?? null,
          sl_profit_rate: isM.slProfitRatePct === undefined ? null : round2(isM.slProfitRatePct),
          tp_hit: isM.tpEntries ?? null,
          other_loss: isM.otherLossEntries ?? null,
          other_loss_rate: isM.otherLossRatePct === undefined ? null : round2(isM.otherLossRatePct),
          // Out-of-sample — never seen by the search.
          oos_net_pct: round2(oosM.netProfitPct),
          oos_dd_pct: round2(oosM.maxDrawdownPct),
          oos_win_rate: round2(oosM.winRatePct),
          oos_trades: entriesIn(splitMs, endMs),
          oos_profit_factor: oosM.profitFactor === null ? null : round3(oosM.profitFactor),
          oos_sl_hit: oosM.slEntries ?? null,
          oos_sl_rate: oosM.slRatePct === undefined ? null : round2(oosM.slRatePct),
          oos_sl_loss: oosM.slLossEntries ?? null,
          oos_sl_loss_rate: oosM.slLossRatePct === undefined ? null : round2(oosM.slLossRatePct),
          oos_sl_profit: oosM.slProfitEntries ?? null,
          oos_sl_profit_rate: oosM.slProfitRatePct === undefined ? null : round2(oosM.slProfitRatePct),
          oos_tp_hit: oosM.tpEntries ?? null,
          oos_other_loss: oosM.otherLossEntries ?? null,
          oos_other_loss_rate: oosM.otherLossRatePct === undefined ? null : round2(oosM.otherLossRatePct),
          // Whole window, for reference.
          full_net_pct: round2(m.netProfitPct),
          full_dd_pct: round2(m.maxDrawdownPct),
        },
      });
    } catch (err) {
      parentPort!.postMessage({ ok: false, error: (err as Error).message });
    }
  })();
});

const round2 = (v: number): number => Math.round(v * 100) / 100;
const round3 = (v: number): number => Math.round(v * 1000) / 1000;
