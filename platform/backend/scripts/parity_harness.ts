/**
 * Cross-strategy parity harness.
 *
 * Runs a FIXED, deterministic set of configurations through the local backtest
 * engine and prints one stable JSON blob of metrics. Run it before a shared-code
 * change (ta.ts, broker.ts, mtf.ts), run it again after, and diff the two files:
 * any difference means the change altered results and would silently invalidate
 * the accumulated histories in optimizer1y15m / optimizer1y1h / sr_optimizer1h.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/parity_harness.ts > /tmp/before.json
 *   ...edit...
 *   node node_modules/tsx/dist/cli.mjs scripts/parity_harness.ts > /tmp/after.json
 *   diff /tmp/before.json /tmp/after.json && echo IDENTICAL
 *
 * Cases are built from the REAL leaderboard winners of each surviving tree
 * (base_params.json + best/<COIN>.json, reproduced the way optimizer.ts builds a
 * job) rather than bare module defaults, which take no trades and would make the
 * harness a no-op guard.
 */
import { readFileSync } from "node:fs";
import * as candleRepo from "../src/repositories/candles";
import * as symbolRepo from "../src/repositories/symbols";
import { FeedStore, toBars } from "../src/engine/mtf";
import { computeMetrics } from "../src/engine/metrics";
import { maRrV9Module } from "../src/engine/strategies/ma_rr_v9";
import { srTrendV10Module } from "../src/engine/strategies/srtrend_v10";
import type { Interval } from "../src/types/market";
import type { StrategyParams } from "../src/types/strategy";

const START = Date.parse("2025-07-20T00:00:00Z");
const END = Date.parse("2026-07-30T00:00:00Z");

interface Mod {
  resolveParams: (o: StrategyParams) => Record<string, unknown>;
  requiredFeeds: (p: never, tf: Interval) => { symbol: string | null; interval: Interval; warmupBars: number }[];
  warmupMs: (n: never) => number;
  runBars: (...a: never[]) => { broker: { closed: unknown[]; commissionPaid: number }; equityCurve: unknown[] };
}

const CASES: { name: string; mod: Mod; coin: string; tf: Interval; params: StrategyParams }[] = [];

/**
 * The MA/SR modules take no trades on bare defaults, which would make them
 * worthless as guards. Use their REAL leaderboard winners instead — reproduced
 * exactly the way optimizer.ts builds a job: base_params.json + best.params.
 * These configs trade, and they are the records a regression would corrupt.
 */
function fromBest(tree: string, mod: Mod, coin: string, tf: Interval): typeof CASES[number] | null {
  const root = new URL(`../${tree}/`, import.meta.url);
  try {
    const base = JSON.parse(readFileSync(new URL("base_params.json", root), "utf8"));
    const best = JSON.parse(readFileSync(new URL(`best/${coin}.json`, root), "utf8"));
    delete base._comment;
    return { name: `${tree}/${tf}/${coin}/best`, mod, coin, tf,
      params: { ...base, ...(best.params ?? {}) } as StrategyParams };
  } catch {
    return null;
  }
}

for (const c of [
  fromBest("optimizer1y1h", maRrV9Module as unknown as Mod, "ALGOUSDT", "1h"),
  fromBest("optimizer1y1h", maRrV9Module as unknown as Mod, "ZECUSDT", "1h"),
  fromBest("optimizer1y15m", maRrV9Module as unknown as Mod, "ALGOUSDT", "15m"),
  fromBest("sr_optimizer1h", srTrendV10Module as unknown as Mod, "ALLOUSDT", "1h"),
]) if (c) CASES.push(c);

async function main(): Promise<void> {
  const out: Record<string, unknown> = {};
  for (const c of CASES) {
    try {
      const p = c.mod.resolveParams(c.params);
      const feeds = new FeedStore();
      for (const need of c.mod.requiredFeeds(p as never, c.tf)) {
        const warm = c.mod.warmupMs(need as never);
        const rows = await candleRepo.getCandles(need.symbol ?? c.coin, need.interval,
          { from: START - warm, to: END });
        if (rows.length === 0) throw new Error(`no ${need.interval} data for ${need.symbol ?? c.coin}`);
        feeds.set(toBars(rows));
      }
      const tickSize = (await symbolRepo.getSymbol(c.coin))?.priceTick ?? 0;
      const r = c.mod.runBars(feeds as never, c.coin as never, c.tf as never, p as never, {
        initialCapital: 1000, commissionPct: 0.1, slippageTicks: 0, tickSize,
        qtyCash: Number(p.qty_cash ?? 0), qtyPctEquity: Number(p.qty_pct_equity ?? 0),
        fillOnBarClose: Boolean(p.fill_bar_close ?? false),
      } as never, { startMs: START, endMs: END } as never);
      const m = computeMetrics(r.broker.closed as never, r.equityCurve as never, 1000, r.broker.commissionPaid);
      // Full float precision on purpose: rounding would hide small regressions.
      out[c.name] = {
        net: m.netProfit, netPct: m.netProfitPct, dd: m.maxDrawdownPct,
        trades: m.totalTrades, wins: m.winningTrades, winPct: m.winRatePct,
        pf: m.profitFactor, commission: m.commissionPaid, avgBars: m.avgBarsInTrade,
      };
    } catch (err) {
      out[c.name] = { error: (err as Error).message };
    }
  }
  console.log(JSON.stringify(out, null, 1));
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
