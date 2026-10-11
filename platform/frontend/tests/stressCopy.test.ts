/**
 * The stress page's sentences, as what they claim.
 *
 * Each of these replaced a sentence that was wrong: a footnote saying the
 * page ran your configuration when it ran the defaults, a line calling every
 * window "directly comparable with any other run" when Strategy % is divided
 * by a capital the trades never committed, and a provider id printed as prose.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  benchmarkSource, exposureNote, qualifiedBy, shortRunId, stressSourceDetail,
  startableRunLabel, stressSourceFromBacktest, stressSourceHeadline,
} from "../lib/stress";
import type { Backtest, StressWindow } from "../lib/types";

const STRATEGIES = [{ id: 7, key: "ma_rr_v9", name: "MA RR v9" }];

function backtest(over: Partial<Backtest> = {}): Backtest {
  return {
    id: "3f1c2a9e-8d4b-4c6f-9a1e-2b7d5c8e0f13", strategyId: 7, configId: "c0ffee00-0000-4000-8000-000000000001",
    symbol: "SOLUSDT", timeframe: "4h", startTime: "", endTime: "",
    params: { qty_cash: 930 }, initialCapital: 2500, commissionPct: 0.075, slippageTicks: 1,
    status: "done", error: null, metrics: null, equityCurve: null, holdoutFraction: null,
    segments: null, executionTruth: null, stressRunId: null, createdAt: "", ...over,
  };
}

test("a run's settings are taken whole, from its own snapshot", () => {
  const source = stressSourceFromBacktest(backtest(), STRATEGIES);
  assert.ok(!("reason" in source));
  assert.deepEqual(source, {
    backtestId: "3f1c2a9e-8d4b-4c6f-9a1e-2b7d5c8e0f13", strategyKey: "ma_rr_v9",
    strategyName: "MA RR v9", symbol: "SOLUSDT", timeframe: "4h",
    params: { qty_cash: 930 }, initialCapital: 2500, commissionPct: 0.075, slippageTicks: 1,
  }, "the params are the run's merged snapshot; its config id is not re-sent");
  assert.equal(stressSourceHeadline(source),
    "Stressing the settings of run 3f1c2a9e (MA RR v9 · SOLUSDT · 4h)");
  assert.match(stressSourceDetail(source), /^1 parameter · 2,500 initial capital · 0\.075 % commission/);
});

test("a run whose strategy this install cannot run is refused, not guessed at", () => {
  const refused = stressSourceFromBacktest(backtest({ strategyId: 99 }), STRATEGIES);
  assert.ok("reason" in refused);
  assert.match(refused.reason, /not available here/);
});

test("C-07 a run whose stored settings the server now refuses is not stressed", () => {
  const refused = stressSourceFromBacktest(
    backtest({ initialCapital: -5, refusedSettings: "Initial capital must be a number greater than 0." }), STRATEGIES);
  assert.ok("reason" in refused);
  assert.match(refused.reason, /this engine now refuses them: Initial capital must be a number greater than 0\./);
});

test("why a window qualified names the ranked statistic and its value", () => {
  const w = (metric: StressWindow["selectedBy"]["metric"], value: number) => ({
    rank: 1, startMs: 0, endMs: 1, bars: 2, benchmarkReturnPct: 0, benchmarkDrawdownPct: 0,
    benchmarkVolatilityPct: 0, selectedBy: { metric, value },
  });
  assert.equal(qualifiedBy(w("worst_return", -34.16)), "return -34.16%");
  assert.equal(qualifiedBy(w("deepest_drawdown", 41)), "drawdown -41.00%");
  assert.equal(qualifiedBy(w("highest_volatility", 3.125)), "volatility 3.13");
  assert.equal(qualifiedBy(w("manual", -5)), "named window");
});

test("the benchmark's source is a venue in words; the ids are kept for the tooltip", () => {
  const source = benchmarkSource({
    symbol: "BTCUSDT", canonicalInstrument: "instrument:v1:BINANCE:spot:BTC:USDT:USDT:spot",
    interval: "1d", providerId: "binance-spot", feedId: "binance-public-klines",
  });
  assert.equal(source.label, "Binance market data");
  assert.match(source.detail, /binance-spot/);
  assert.equal(benchmarkSource({
    symbol: "BTCUSDT", canonicalInstrument: null, interval: "1d",
    providerId: "binance-spot", feedId: "binance-public-klines",
  }).label, "this install's stored market data", "never the raw provider id as the label");
});

test("the exposure note states the cash-size to capital ratio, with the arithmetic", () => {
  // The page's old default: 10,000 capital and a 1,000 cash size.
  const note = exposureNote({ mode: "fixed_cash", value: 1000 }, 10_000,
    { returnPct: -30, symbol: "SOLUSDT" });
  assert.match(note, /fixed 1,000 of quote currency — 10 % of the 10,000 initial capital/);
  assert.match(note, /not over the cash at risk/);
  assert.match(note, /SOLUSDT moved -30\.00%, a position of that size would show about -3\.00%/);
});

test("compounding sizing and an unknown sizing are said as what they are", () => {
  assert.match(exposureNote({ mode: "percent_of_equity", value: 100 }, 1000, null),
    /100 % of current equity, so a window compounds/);
  assert.match(exposureNote(null, 1000, null), /reported once a window has run/);
  // No example means no invented arithmetic.
  assert.doesNotMatch(exposureNote({ mode: "fixed_cash", value: 930 }, 1000, null), /would show/);
});

test("a short run id is the first eight characters", () => {
  assert.equal(shortRunId("3f1c2a9e-8d4b-4c6f-9a1e-2b7d5c8e0f13"), "3f1c2a9e");
});

test("a run to start from is told apart by its window and its result", () => {
  // Five runs of one strategy on one symbol made the same afternoon used to
  // read as five identical rows ending on the day they were created (C-03).
  const done = backtest({
    startTime: "2025-01-01T00:00:00.000Z", endTime: "2025-06-01T00:00:00.000Z",
    createdAt: "2025-06-02T09:00:00.000Z",
    metrics: { netProfitPct: -3.456 } as Backtest["metrics"],
  });
  assert.equal(startableRunLabel(done, "MA RR v9"),
    "3f1c2a9e · MA RR v9 · SOLUSDT · 4h · 2025-01-01 → 2025-06-01 · -3.46%");
  // A run with no figures says nothing about a result rather than inventing one.
  assert.equal(startableRunLabel(backtest({
    startTime: "2025-01-01T00:00:00.000Z", endTime: "2025-06-01T00:00:00.000Z",
  }), null), "3f1c2a9e · strategy · SOLUSDT · 4h · 2025-01-01 → 2025-06-01");
});
