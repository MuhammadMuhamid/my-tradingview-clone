/**
 * BE-29 — golden-file regression for every strategy bar loop.
 *
 * The audit's coverage finding names two missing suites. This is the first:
 * `backtester.ts`, `mtf.ts`, `metrics.ts`, every `strategies/*\/index.ts` bar
 * loop and ~1400 lines of `signals.ts` ran against no test at all. Phase 0
 * added 42 characterization cases elsewhere, and not this one. (The second,
 * backtest-vs-live equivalence, is `tests/liveParity.test.ts` plus
 * `tests/liveEvaluator.test.ts` and `tests/mtfLeanLiveEvaluator.test.ts`.)
 *
 * ── What these tests are, and are not ─────────────────────────────────────
 *
 * They run each strategy over a deterministic synthetic fixture with a real
 * `base_params.json` from the tree that deploys it, and pin the exact trades,
 * metrics and signal series it produces. Any change to the engine that moves a
 * single fill shows up here as a failing digest.
 *
 * They are NOT evidence about the strategies. The fixture is generated, not
 * market data; a number below says only "this is what the code did last time".
 * That is precisely what a regression net is for, and what `BE-04`'s unnoticed
 * entry-bar defect and `BE-01`/`BE-03`'s live divergences needed.
 *
 * WHEN ONE OF THESE FAILS: do not update the golden value to make it pass.
 * A moved fill is a changed backtest, and a changed backtest invalidates every
 * stored leaderboard number for that strategy. Either the change was intended —
 * in which case it belongs behind a flag in `engine/corrections.ts`, like the
 * six that are — or it is a bug.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { digest, feedsFor, FIXTURE_SYMBOL, minuteSeries } from "./support/marketFixture";
import type { Interval } from "../src/types/market";
import { noCorrections } from "../src/engine/corrections";
import { computeMetrics, toTradeRecords } from "../src/engine/metrics";
import { maRrV9Module } from "../src/engine/strategies/ma_rr_v9";
import { srTrendV10Module } from "../src/engine/strategies/srtrend_v10";
import { mtfLeanModule } from "../src/engine/strategies/mtf_lean";
import { computeSignals as maSignals } from "../src/engine/strategies/ma_rr_v9/signals";
import { computeSignals as srSignals } from "../src/engine/strategies/srtrend_v10/signals";
import { computeSignals as leanSignals } from "../src/engine/strategies/mtf_lean/signals";

const BACKEND = path.resolve(__dirname, "..");
const MINUTES = 60 * 24 * 400;          // 400 days of 1-minute bars

/** The cost model every current tree runs (docs/COST-MODELS.md). */
const BROKER = {
  initialCapital: 10_000, commissionPct: 0.1, slippageTicks: 2,
  tickSize: 0.01, qtyCash: 1000, qtyPctEquity: 0, corrections: noCorrections(),
};

interface Case {
  key: string;
  module: typeof maRrV9Module;
  chartTf: Interval;
  baseParams: string;
  seed: number;
  signals: (...args: never[]) => unknown;
  golden: {
    chartBars: number; barsProcessed: number; legs: number; entries: number;
    netProfitPct: number; winRatePct: number; profitFactor: number | null;
    maxDrawdownPct: number; tradeDigest: string; exitReasons: string[];
    signalDigests: Record<string, string>;
  };
}

const CASES: Case[] = [
  {
    key: "ma_rr_v9",
    module: maRrV9Module,
    chartTf: "15m",
    baseParams: "optimizer1y15m/base_params.json",
    seed: 20240101,
    signals: maSignals as never,
    golden: {
      chartBars: 38400, barsProcessed: 24960, legs: 10, entries: 10,
      netProfitPct: 9.574293, winRatePct: 70, profitFactor: 2.975126,
      maxDrawdownPct: 2.552999,
      tradeDigest: "1c636f4eacc7a0b2",
      exitReasons: ["TP", "SL", "TP", "HL Break", "TP", "TP", "SL", "TP", "TP", "SL"],
      signalDigests: {
        longSetup: "f5052397b61f85bd", filterLong: "993b5ce5a15246b3",
        confirmationLong: "6f98bba58adaa3af", hhTrendStrong: "c0de16d757ec9b61",
        anyIndBuyTrig: "228868251a2a42d7", freshPrimaryBuy: "ce46bdc54be73d93",
        exitMaTrig: "ce46bdc54be73d93", belowSt: "ce46bdc54be73d93",
        belowMa1: "ce46bdc54be73d93", belowLinReg: "ce46bdc54be73d93",
        rsiExit: "ce46bdc54be73d93", hlBreak: "d965d617305db031",
        rfSell: "ce46bdc54be73d93", atSell: "ce46bdc54be73d93",
        hacSell: "ce46bdc54be73d93", utSell: "ce46bdc54be73d93",
        atrRisk: "fff23252f36c3102", rrSwingLow: "cfc7aea8a64e056a",
      },
    },
  },
  {
    key: "srtrend_v10",
    module: srTrendV10Module as unknown as typeof maRrV9Module,
    chartTf: "1h",
    baseParams: "optimizer1y1h/base_params.json",
    seed: 20240101,
    signals: srSignals as never,
    golden: {
      chartBars: 9600, barsProcessed: 6240, legs: 3, entries: 3,
      netProfitPct: 66.711559, winRatePct: 100, profitFactor: null,
      maxDrawdownPct: 2.554153,
      tradeDigest: "8972ba5fff6318af",
      exitReasons: ["SL", "TP", "HL Break"],
      signalDigests: {
        longSetup: "fd400305cdbe6ddf", freshPrimaryBuy: "59976e773e9b5d65",
        supportLevel: "96b465a9a31412cf", atr: "281057cc950128e6",
        swingLow: "010de155c7045fe3", exitMa: "1ad725c51b3fd093",
        belowSt: "1ad725c51b3fd093", belowMa1: "1ad725c51b3fd093",
        belowLinReg: "1ad725c51b3fd093", hlBreak: "632907a566d90f6f",
        volExhaust: "1ad725c51b3fd093", htfBreak: "4a1e67e57722d56b",
        sessionEnded: "1ad725c51b3fd093", strongTrend: "c8af6d77d9e0409d",
      },
    },
  },
  {
    key: "mtf_lean",
    module: mtfLeanModule as unknown as typeof maRrV9Module,
    chartTf: "15m",
    baseParams: "lean_optimizer15m/base_params.json",
    // A different seed: mtf_lean's gates are strict enough that most synthetic
    // series never satisfy them. That selectivity is the strategy working as
    // designed, not a fixture defect — and it is why a golden test for it is
    // worth having at all.
    seed: 2468,
    signals: leanSignals as never,
    golden: {
      chartBars: 38400, barsProcessed: 24960, legs: 1, entries: 1,
      netProfitPct: 1.560985, winRatePct: 100, profitFactor: null,
      maxDrawdownPct: 0.234037,
      tradeDigest: "6de8a37921d8d5e1",
      exitReasons: ["TP"],
      signalDigests: {
        longSetup: "75a2c0d75ac74d61", filtersOk: "75a2c0d75ac74d61",
        anyIndBuyTrig: "ce46bdc54be73d93", freshPrimaryBuy: "75a2c0d75ac74d61",
        g1Bear: "ffc5e677b400688d", s4Bear: "e60884c5da54cd07",
        hlBreak: "ce46bdc54be73d93", atrRisk: "118de26557ad4c7b",
        rrSwingLow: "d5b12bb1bd89a447",
      },
    },
  },
];

function paramsFor(c: Case): Record<string, unknown> {
  const raw = JSON.parse(fs.readFileSync(path.join(BACKEND, c.baseParams), "utf8")) as Record<string, unknown>;
  if (c.key === "mtf_lean") {
    // `base_params.json` holds the statics; the gates are tunables. Use a real
    // recommended configuration rather than inventing one.
    const best = JSON.parse(
      fs.readFileSync(path.join(BACKEND, "lean_optimizer15m", "BEST_CONFIGS_15M.json"), "utf8")
    ) as Record<string, { recommended_conservative: { params: Record<string, unknown> } }>;
    Object.assign(raw, best.DEXEUSDT!.recommended_conservative.params);
  }
  return raw;
}

function run(c: Case) {
  const corrections = noCorrections();
  const p = (c.module.resolveParams as unknown as (x: unknown, k?: unknown) => never)(paramsFor(c), corrections);
  const needs = (c.module.requiredFeeds as unknown as (p: never, tf: Interval, k?: unknown) => { interval: Interval }[])(
    p, c.chartTf, corrections
  );
  const feeds = feedsFor(minuteSeries(MINUTES, c.seed), needs.map((n) => n.interval));
  const chart = feeds.get(FIXTURE_SYMBOL, c.chartTf);
  const from = Math.floor(chart.length * 0.35);
  const range = { startMs: chart.time[from]!, endMs: chart.closeTime[chart.length - 1]! };
  const res = (c.module.runBars as unknown as (...a: never[]) => never)(
    feeds as never, FIXTURE_SYMBOL as never, c.chartTf as never, p, BROKER as never, range as never
  ) as { broker: { closed: never[]; commissionPaid: number }; equityCurve: never[]; barsProcessed: number };
  const trades = toTradeRecords(res.broker.closed);
  const metrics = computeMetrics(res.broker.closed, res.equityCurve, BROKER.initialCapital, res.broker.commissionPaid);
  return { chart, trades, metrics, res, p, feeds };
}

for (const c of CASES) {
  test(`${c.key}: the bar loop produces exactly the trades it produced last time`, () => {
    const { chart, trades, res } = run(c);
    assert.equal(chart.length, c.golden.chartBars, "fixture drifted — every golden below is void");
    assert.equal(res.barsProcessed, c.golden.barsProcessed);
    assert.equal(trades.length, c.golden.legs, "a different number of exit legs");
    assert.equal(new Set(trades.map((t) => t.entryTime)).size, c.golden.entries);
    assert.deepEqual(trades.map((t) => t.exitReason), c.golden.exitReasons);
    assert.equal(
      digest(trades.flatMap((t) => [t.entryTime, t.exitTime, t.entryPrice, t.exitPrice, t.qty, t.pnl])),
      c.golden.tradeDigest,
      "a fill moved: entry/exit time, price, quantity or P&L changed"
    );
  });

  test(`${c.key}: the metrics computed from those trades are unchanged`, () => {
    const { metrics } = run(c);
    assert.equal(Number(metrics.netProfitPct?.toFixed(6)), c.golden.netProfitPct);
    assert.equal(Number(metrics.winRatePct?.toFixed(6)), c.golden.winRatePct);
    assert.equal(
      metrics.profitFactor === null ? null : Number(metrics.profitFactor.toFixed(6)),
      c.golden.profitFactor
    );
    assert.equal(Number(metrics.maxDrawdownPct?.toFixed(6)), c.golden.maxDrawdownPct);
    assert.equal(metrics.totalTrades, c.golden.legs);
  });

  test(`${c.key}: every signal series is unchanged`, () => {
    const { p, feeds } = run(c);
    const sig = (c.signals as (...a: never[]) => never)(
      feeds as never, FIXTURE_SYMBOL as never, c.chartTf as never, p
    ) as unknown as Record<string, unknown>;
    const got: Record<string, string> = {};
    for (const [k, v] of Object.entries(sig)) if (Array.isArray(v)) got[k] = digest(v as never);
    assert.deepEqual(got, c.golden.signalDigests,
      "a signal series changed — this moves which bars the strategy can act on");
  });

  test(`${c.key}: the run is deterministic`, () => {
    const a = run(c), b = run(c);
    assert.equal(
      digest(a.trades.map((t) => t.pnl)),
      digest(b.trades.map((t) => t.pnl)),
      "two runs over the same fixture disagreed"
    );
  });
}

test("the fixture is identical on every run and every machine", () => {
  const a = minuteSeries(500, 42), b = minuteSeries(500, 42), c = minuteSeries(500, 43);
  assert.equal(digest(a.close), digest(b.close));
  assert.notEqual(digest(a.close), digest(c.close));
  assert.equal(a.length, 500);
});

test("aggregation preserves OHLCV correctly", () => {
  const base = minuteSeries(600, 7);
  const feeds = feedsFor(base, ["1m", "15m"]);
  const m15 = feeds.get(FIXTURE_SYMBOL, "15m");
  assert.equal(m15.length, 40);
  // The first 15m bar is built from the first fifteen 1m bars.
  assert.equal(m15.open[0], base.open[0]);
  assert.equal(m15.close[0], base.close[14]);
  assert.equal(m15.high[0], Math.max(...base.high.slice(0, 15)));
  assert.equal(m15.low[0], Math.min(...base.low.slice(0, 15)));
  assert.equal(m15.volume[0], base.volume.slice(0, 15).reduce((a, b) => a + b, 0));
  assert.equal(m15.closeTime[0], m15.time[0]! + 15 * 60_000 - 1);
});

test("SOME signal series are constant on this fixture, and that is recorded", () => {
  // A constant series' digest cannot catch a change in it. Naming the count
  // here stops the suite from looking like more coverage than it is.
  const constants: Record<string, number> = {};
  for (const c of CASES) {
    const { p, feeds } = run(c);
    const sig = (c.signals as (...a: never[]) => never)(
      feeds as never, FIXTURE_SYMBOL as never, c.chartTf as never, p
    ) as unknown as Record<string, unknown>;
    constants[c.key] = Object.values(sig)
      .filter((v): v is unknown[] => Array.isArray(v))
      .filter((v) => new Set(v).size <= 1).length;
  }
  assert.deepEqual(constants, { ma_rr_v9: 10, srtrend_v10: 6, mtf_lean: 2 });
});
