/** Smoke-test the 1-year 5m MA+R:R optimizer: params resolve, a real backtest
 *  runs, and win% / stopped-at-a-loss% reconcile against the same denominator. */
import * as fs from "node:fs";
import * as path from "node:path";
import * as candleRepo from "../../../platform/backend/src/repositories/candles";
import * as symbolRepo from "../../../platform/backend/src/repositories/symbols";
import { FeedStore, toBars } from "../../../platform/backend/src/engine/mtf";
import { maRrV9Module } from "../../../platform/backend/src/engine/strategies/ma_rr_v9";
import { MA_RR_V9_DEFAULTS } from "../../../platform/backend/src/engine/strategies/ma_rr_v9/params";
import { computeSegmentMetrics } from "../../../platform/backend/src/engine/metrics";
import type { Interval } from "../../../platform/backend/src/types/market";

const HERE = __dirname;
const cfg = JSON.parse(fs.readFileSync(path.join(HERE, "config.json"), "utf8"));
const base = JSON.parse(fs.readFileSync(path.join(HERE, "base_params.json"), "utf8"));
const P = JSON.parse(fs.readFileSync(path.join(HERE, "params.json"), "utf8"));
const startMs = Date.parse(cfg.range.start), splitMs = Date.parse(cfg.range.split), endMs = Date.now();
let pass = 0, fail = 0;
const ck = (n: string, ok: boolean, d = ""): void => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); ok ? pass++ : fail++; };

(async () => {
  const defs = MA_RR_V9_DEFAULTS as Record<string, unknown>;
  const tun = (P.parameters as { name: string; values: unknown[] }[]).map((p) => p.name);
  ck("all 7 tunables exist in strategy defaults", tun.every((n) => n in defs),
    tun.filter((n) => !(n in defs)).join(",") || `${tun.length} tunables`);
  ck("all base params exist in strategy defaults",
    Object.keys(base).filter((k) => !k.startsWith("_")).every((k) => k in defs),
    Object.keys(base).filter((k) => !k.startsWith("_") && !(k in defs)).join(",") || "ok");
  ck("no tunable also pinned in base_params", tun.every((n) => !(n in base)));

  const coins = fs.readFileSync(path.join(HERE, "coins.txt"), "utf8").split("\n").map((s) => s.trim()).filter((s) => s && !s.startsWith("#")).slice(0, 6);
  for (const coin of coins) {
    const over: Record<string, unknown> = {};
    for (const p of P.parameters as { name: string; values: unknown[] }[]) over[p.name] = p.values[Math.floor(p.values.length / 2)];
    const p = maRrV9Module.resolveParams({ ...base, ...over } as never);
    const feeds = new FeedStore();
    for (const n of maRrV9Module.requiredFeeds(p, cfg.timeframe as Interval))
      feeds.set(toBars(await candleRepo.getCandles(n.symbol ?? coin, n.interval, { from: startMs - 40 * 864e5, to: endMs })));
    const info = await symbolRepo.getSymbol(coin);
    const r = maRrV9Module.runBars(feeds, coin, cfg.timeframe as Interval, p, {
      initialCapital: cfg.initialCapital, commissionPct: cfg.commissionPct,
      slippageTicks: cfg.slippageTicks, tickSize: info!.priceTick,
      qtyCash: Number(p.qty_cash), qtyPctEquity: Number(p.qty_pct_equity ?? 0),
      fillOnBarClose: Boolean(p.fill_bar_close),
    }, { startMs, endMs });
    const legs = r.broker.closed;
    const m = computeSegmentMetrics(legs, r.equityCurve, cfg.initialCapital, startMs, splitMs);
    const o = computeSegmentMetrics(legs, r.equityCurve, cfg.initialCapital, splitMs, endMs);
    const ent = new Set(legs.filter((t) => t.entryTime >= startMs && t.entryTime < splitMs).map((t) => t.entryBar)).size;
    console.log(`\n${coin}  IS: net ${m.netProfitPct.toFixed(1)}%  dd ${m.maxDrawdownPct.toFixed(1)}%  wr ${m.winRatePct.toFixed(1)}%  entries ${ent}  legs ${m.totalTrades}  SLloss ${(m.slLossRatePct ?? 0).toFixed(1)}%`);
    console.log(`${" ".repeat(coin.length)}  OOS: net ${o.netProfitPct.toFixed(1)}%  dd ${o.maxDrawdownPct.toFixed(1)}%  wr ${o.winRatePct.toFixed(1)}%  SLloss ${(o.slLossRatePct ?? 0).toFixed(1)}%`);
    ck(`${coin} entries match metrics.entries`, (m.entries ?? 0) === ent);
    ck(`${coin} IS  wr% + SLloss% never exceed 100`, (m.slLossRatePct ?? 0) <= 100 - m.winRatePct + 0.02,
      `${m.winRatePct.toFixed(1)} + ${(m.slLossRatePct ?? 0).toFixed(1)}`);
    ck(`${coin} OOS wr% + SLloss% never exceed 100`, (o.slLossRatePct ?? 0) <= 100 - o.winRatePct + 0.02,
      `${o.winRatePct.toFixed(1)} + ${(o.slLossRatePct ?? 0).toFixed(1)}`);
    ck(`${coin} sl split reconciles`, (m.slLossEntries ?? 0) + (m.slProfitEntries ?? 0) === (m.slEntries ?? 0));
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
