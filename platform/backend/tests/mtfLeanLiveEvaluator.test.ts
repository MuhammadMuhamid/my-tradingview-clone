import { test } from "node:test";
import assert from "node:assert/strict";
import { FeedStore, toBars } from "../src/engine/mtf";
import { evaluateMtfLeanBar } from "../src/engine/mtfLeanLiveEvaluator";
import { resolveParams } from "../src/engine/strategies/mtf_lean/params";
import { initialRuntimeState } from "../src/types/deployments";
import type { Candle } from "../src/types/market";

function fixture(lastHigh: number, lastLow = 99): { feeds: FeedStore; time: number } {
  const base = Date.UTC(2026, 0, 1);
  const candles: Candle[] = Array.from({ length: 240 }, (_, i) => ({
    symbol: "TESTUSDT", interval: "15m" as const,
    openTime: base + i * 900_000,
    open: i === 239 ? 103 : 100,
    high: i === 239 ? lastHigh : 101,
    low: i === 239 ? lastLow : 99,
    close: i === 239 ? 102.5 : 100,
    volume: 1000,
    closeTime: base + (i + 1) * 900_000 - 1,
  }));
  const feeds = new FeedStore();
  feeds.set(toBars(candles));
  return { feeds, time: candles[239]!.openTime };
}

const baseParams = {
  g1_tf: "15", g2_tf: "15", g3_tf: "15", g4_tf: "15", volTf: "15",
  s1_tf: "15", s4_tf: "15", s5_tf: "15", s6_tf: "15",
  useG1: false, useG2: false, useG3: false, useG4: false,
  useS1: false, useS4: false, useS5: false, useS6: false,
  useVolumeFilter: false, useBodyFilter: false, useHlBreakExit: false,
  rrTp1Pct: 2, rrTp1Size: 40, rrTp2Pct: 4, rrTp2Size: 30,
};

function longState() {
  return {
    ...initialRuntimeState(),
    position: "long" as const,
    entryPrice: 100,
    entryBarTime: Date.UTC(2026, 0, 1),
    savedLongStop: 90,
    savedLongTp: 130,
  };
}

test("MTF Lean sends TP1 and TP2 as 40% then 50% of remaining", () => {
  const { feeds, time } = fixture(105);
  const result = evaluateMtfLeanBar(
    feeds, "TESTUSDT", "15m", resolveParams({ ...baseParams, rrUsePartialTp: true }), longState(), time
  );
  assert.deepEqual(result.steps.map((s) => s.decision.exitLeg), ["tp1", "tp2"]);
  assert.deepEqual(result.steps.map((s) => s.decision.sellPercent), [40, 50]);
  assert.equal(result.next.position, "long");
  assert.equal(result.next.tp1Done, true);
  assert.equal(result.next.tp2Done, true);
});

test("full-exit mode remains one runner SELL with no partial percentage", () => {
  const { feeds, time } = fixture(131);
  const result = evaluateMtfLeanBar(
    feeds, "TESTUSDT", "15m", resolveParams({ ...baseParams, rrUsePartialTp: false }), longState(), time
  );
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0]!.decision.exitLeg, "runner");
  assert.equal(result.steps[0]!.decision.sellPercent, undefined);
  assert.equal(result.next.position, "flat");
});

test("a trail derived at this close cannot retroactively stop the same bar", () => {
  const { feeds, time } = fixture(105, 95);
  const result = evaluateMtfLeanBar(
    feeds,
    "TESTUSDT",
    "15m",
    resolveParams({
      ...baseParams,
      rrUsePartialTp: false,
      rrUseTrailSl: true,
      rrTrailActPct: 1,
      rrTrailPct: 5,
    }),
    longState(),
    time,
  );
  assert.deepEqual(result.steps, []);
  assert.equal(result.next.position, "long");
  assert.equal(result.next.trailArmed, true);
  assert.equal(result.next.trailAnchor, 102.5 * 0.95);
});

test("strategy order prices use the same tick normalization as Backtester", () => {
  const { feeds, time } = fixture(130);
  const state = { ...longState(), savedLongTp: 130.004 };
  const result = evaluateMtfLeanBar(
    feeds,
    "TESTUSDT",
    "15m",
    resolveParams({ ...baseParams, rrUsePartialTp: false }),
    state,
    time,
    0.01,
  );
  assert.equal(result.steps[0]?.decision.reason, "TP");
  assert.equal(result.steps[0]?.decision.price, 130);
});
