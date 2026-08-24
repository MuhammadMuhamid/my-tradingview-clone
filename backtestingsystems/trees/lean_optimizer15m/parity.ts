import * as fs from "node:fs";
import * as candleRepo from "../../../platform/backend/src/repositories/candles";
import * as symbolRepo from "../../../platform/backend/src/repositories/symbols";
import { FeedStore, toBars } from "../../../platform/backend/src/engine/mtf";
import { mtfLeanModule } from "../../../platform/backend/src/engine/strategies/mtf_lean";
import { computeMetrics } from "../../../platform/backend/src/engine/metrics";
import type { Interval } from "../../../platform/backend/src/types/market";

const HERE = __dirname;
const base = JSON.parse(fs.readFileSync(`${HERE}/base_params.json`, "utf8"));
const chartTf = "5m" as Interval;
const WARMUP: Record<string, number> = { "1m": 3*864e5, "5m": 10*864e5, "15m": 40*864e5, "1h": 90*864e5 };

async function run(coin: string, startMs: number, endMs: number, ov: Record<string, unknown> = {}) {
  const p = mtfLeanModule.resolveParams({ ...base, ...ov } as any);
  const feeds = new FeedStore();
  for (const need of mtfLeanModule.requiredFeeds(p, chartTf)) {
    const c = await candleRepo.getCandles(coin, need.interval, { from: startMs - (WARMUP[need.interval] ?? 30*864e5), to: endMs });
    feeds.set(toBars(c));
  }
  const info = await symbolRepo.getSymbol(coin);
  const r = mtfLeanModule.runBars(feeds, coin, chartTf, p, {
    initialCapital: 1000, commissionPct: 0.1, slippageTicks: 0, tickSize: info!.priceTick,
    qtyCash: Number(p.qty_cash), qtyPctEquity: Number(p.qty_pct_equity ?? 0), fillOnBarClose: true,
  }, { startMs, endMs });
  const m = computeMetrics(r.broker.closed, r.equityCurve, 1000, r.broker.commissionPaid);
  return { r, m };
}

(async () => {
  const coin = process.argv[2] ?? "PUMPUSDT";
  const s = Date.parse(process.argv[3] ?? "2026-07-20T00:00:00Z");
  const e = Date.parse(process.argv[4] ?? "2026-07-30T00:00:00Z");
  const { r, m } = await run(coin, s, e);
  console.log(`${coin}  ${new Date(s).toISOString().slice(0,10)} → ${new Date(e).toISOString().slice(0,10)}`);
  console.log(`trades=${m.totalTrades} net=${m.netProfitPct.toFixed(2)}% dd=${m.maxDrawdownPct.toFixed(2)}% wr=${m.winRatePct.toFixed(1)}%`);
  for (const t of r.broker.closed.slice(0, 20)) {
    console.log(`  ${new Date(t.entryTime).toISOString().slice(5,16)} → ${new Date(t.exitTime).toISOString().slice(5,16)}  ${t.entryPrice.toPrecision(6)} → ${t.exitPrice.toPrecision(6)}  ${(t.pnl ?? 0).toFixed(2)}  ${t.exitReason}`);
  }
  process.exit(0);
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
