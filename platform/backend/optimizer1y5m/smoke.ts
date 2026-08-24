import * as fs from "node:fs";
import * as candleRepo from "../src/repositories/candles";
import * as symbolRepo from "../src/repositories/symbols";
import { FeedStore, toBars } from "../src/engine/mtf";
import { mtfLeanModule } from "../src/engine/strategies/mtf_lean";
import { MTF_LEAN_DEFAULTS } from "../src/engine/strategies/mtf_lean/params";
import { computeMetrics } from "../src/engine/metrics";
import type { Interval } from "../src/types/market";

const HERE = __dirname;
const space = JSON.parse(fs.readFileSync(`${HERE}/params.json`, "utf8"));
const base = JSON.parse(fs.readFileSync(`${HERE}/base_params.json`, "utf8"));
const cfg = JSON.parse(fs.readFileSync(`${HERE}/config.json`, "utf8"));

// 1) every tunable must be a real strategy input
const defaults = new Set(Object.keys(MTF_LEAN_DEFAULTS));
const bad = space.parameters.map((p: any) => p.name).filter((nm: string) => !defaults.has(nm));
console.log("tunables not in MTF_LEAN_DEFAULTS:", bad);
const badBase = Object.keys(base).filter((k) => k !== "_comment" && !defaults.has(k));
console.log("base params not in MTF_LEAN_DEFAULTS:", badBase);

const startMs = Date.parse(cfg.range.start);
const endMs = cfg.range.end === "now" ? Date.now() : Date.parse(cfg.range.end);
const chartTf = cfg.timeframe as Interval;
const WARMUP: Record<string, number> = { "1m": 3*864e5, "5m": 10*864e5, "15m": 40*864e5, "1h": 90*864e5, "4h": 240*864e5, "1d": 730*864e5 };

async function run(coin: string, overrides: Record<string, unknown> = {}) {
  const p = mtfLeanModule.resolveParams({ ...base, ...overrides } as any);
  const feeds = new FeedStore();
  const needs = mtfLeanModule.requiredFeeds(p, chartTf);
  for (const need of needs) {
    const from = startMs - (WARMUP[need.interval] ?? 30*864e5);
    const c = await candleRepo.getCandles(coin, need.interval, { from, to: endMs });
    if (!c.length) throw new Error(`no ${need.interval} for ${coin}`);
    feeds.set(toBars(c));
  }
  const info = await symbolRepo.getSymbol(coin);
  const r = mtfLeanModule.runBars(feeds, coin, chartTf, p, {
    initialCapital: cfg.initialCapital, commissionPct: cfg.commissionPct,
    slippageTicks: cfg.slippageTicks, tickSize: info!.priceTick,
    qtyCash: Number(p.qty_cash), qtyPctEquity: Number(p.qty_pct_equity ?? 0),
    fillOnBarClose: true,
  }, { startMs, endMs });
  const m = computeMetrics(r.broker.closed, r.equityCurve, cfg.initialCapital, r.broker.commissionPaid);
  return { feeds: needs.map(n=>n.interval).join(","), bars: r.barsProcessed, m };
}

(async () => {
  for (const coin of ["ZECUSDT", "PUMPUSDT"]) {
    const t0 = Date.now();
    const out = await run(coin);
    console.log(`\n${coin}  feeds=[${out.feeds}] bars=${out.bars} in ${Date.now()-t0}ms`);
    console.log(`   trades=${out.m.totalTrades} net=${out.m.netProfitPct.toFixed(2)}% dd=${out.m.maxDrawdownPct.toFixed(2)}% wr=${out.m.winRatePct.toFixed(1)}% pf=${out.m.profitFactor}`);
  }
  process.exit(0);
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
