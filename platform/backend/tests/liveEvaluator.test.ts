import { test } from "node:test";
import assert from "node:assert/strict";
import { FeedStore, toBars } from "../src/engine/mtf";
import { evaluateBar } from "../src/engine/liveEvaluator";
import { resolveParams } from "../src/engine/strategies/ma_rr_v9/params";
import { initialRuntimeState } from "../src/types/deployments";
import type { Candle } from "../src/types/market";

/**
 * Build a synthetic 5m series: a long downtrend below a 5-period MA that then
 * crosses up and rallies, so an MA-primary long triggers and later exits.
 */
function series(): Candle[] {
  const base = Date.UTC(2026, 0, 1);
  const closes = [
    // fall below MA
    100, 99, 98, 97, 96, 95, 94, 93, 92, 91,
    // base then cross up sharply
    91, 92, 96, 99, 102,
    // rally to hit a 2R target then roll over
    104, 106, 108, 103, 99, 95,
  ];
  return closes.map((c, i) => ({
    symbol: "TESTUSDT", interval: "5m" as const,
    openTime: base + i * 300_000,
    open: c - 0.2, high: c + 1.5, low: c - 1.5, close: c,
    volume: 1000, closeTime: base + (i + 1) * 300_000 - 1,
  }));
}

function feedsFrom(candles: Candle[]): FeedStore {
  const f = new FeedStore();
  f.set(toBars(candles));
  return f;
}

const PARAMS = resolveParams({
  useMaTrend: true, maPrimary: true,
  ma1_en: true, ma1_tf: "5", ma1_len: 5, ma1_type: "SMA",
  ma3_en: false,
  useRR: true, rrSwingLb: 5, rrRatio: 2.0,
  useExitLongMa: false, useExitBelowSt: false, useExitBelowMa1: false,
  useExitBelowLinReg: false, useHlBreakExit: false, useChoppyFilter: false,
});

test("evaluateBar fires a BUY on MA crossover from flat", () => {
  const candles = series();
  const feeds = feedsFrom(candles);
  let state = initialRuntimeState();
  const decisions: string[] = [];
  for (const c of candles) {
    const { next, decision } = evaluateBar(feeds, "TESTUSDT", "5m", PARAMS, state, c.openTime);
    state = next;
    if (decision) decisions.push(`${decision.action}@${c.close}:${decision.reason}`);
  }
  const buys = decisions.filter((d) => d.startsWith("buy"));
  assert.ok(buys.length >= 1, `expected at least one buy, got ${JSON.stringify(decisions)}`);
  // A buy must be followed by a sell (position can't stay open forever here)
  assert.ok(decisions.some((d) => d.startsWith("sell")), `expected a sell exit, got ${JSON.stringify(decisions)}`);
});

test("no double-entry while already long", () => {
  const candles = series();
  const feeds = feedsFrom(candles);
  let state = initialRuntimeState();
  let openBuys = 0;
  let maxConcurrent = 0;
  for (const c of candles) {
    const { next, decision } = evaluateBar(feeds, "TESTUSDT", "5m", PARAMS, state, c.openTime);
    state = next;
    if (decision?.action === "buy") { openBuys++; maxConcurrent = Math.max(maxConcurrent, openBuys); }
    if (decision?.action === "sell") openBuys--;
    // Never long twice at once
    assert.ok(openBuys <= 1, "position went above 1 — double entry");
  }
});

test("runtime state persists position across calls (flat→long→flat)", () => {
  const candles = series();
  const feeds = feedsFrom(candles);
  let state = initialRuntimeState();
  const positions: string[] = [];
  for (const c of candles) {
    const { next } = evaluateBar(feeds, "TESTUSDT", "5m", PARAMS, state, c.openTime);
    state = next;
    positions.push(state.position);
  }
  assert.ok(positions.includes("long"), "never went long");
  assert.equal(positions[0], "flat");
});

test("SELL fires at the 2R target with reason TP", () => {
  const candles = series();
  const feeds = feedsFrom(candles);
  let state = initialRuntimeState();
  let sawTp = false;
  for (const c of candles) {
    const { next, decision } = evaluateBar(feeds, "TESTUSDT", "5m", PARAMS, state, c.openTime);
    state = next;
    if (decision?.action === "sell" && decision.reason === "TP") sawTp = true;
  }
  assert.ok(sawTp, "expected a TP exit given the rally to 2R");
});

test("manual-close lock blocks next-candle re-entry from persistent MA state", () => {
  const candles = series();
  const feeds = feedsFrom(candles);
  let state = initialRuntimeState();
  let checked = false;
  for (let i = 0; i < candles.length - 1; i++) {
    const result = evaluateBar(feeds, "TESTUSDT", "5m", PARAMS, state, candles[i]!.openTime);
    state = result.next;
    if (result.decision?.action !== "buy") continue;

    // Simulate the receiver synchronizing a dashboard/manual close while the
    // MA primary remains bullish on the following candle.
    state = {
      ...state,
      position: "flat",
      entryPrice: null,
      entryBarTime: null,
      savedLongStop: null,
      savedLongTp: null,
      manualCloseReentryLock: true,
    };
    const nextBar = evaluateBar(
      feeds, "TESTUSDT", "5m", PARAMS, state, candles[i + 1]!.openTime
    );
    assert.notEqual(nextBar.decision?.action, "buy");
    assert.equal(nextBar.next.manualCloseReentryLock, true);
    checked = true;
    break;
  }
  assert.equal(checked, true, "test series never produced the initial BUY");
});

test("manual-close lock unlocks and enters on a genuinely fresh MA primary event", () => {
  const candles = series();
  const feeds = feedsFrom(candles);
  let state = { ...initialRuntimeState(), manualCloseReentryLock: true };
  let buySeen = false;
  for (const candle of candles) {
    const result = evaluateBar(feeds, "TESTUSDT", "5m", PARAMS, state, candle.openTime);
    state = result.next;
    if (result.decision?.action === "buy") {
      buySeen = true;
      assert.equal(state.manualCloseReentryLock, false);
      break;
    }
  }
  assert.equal(buySeen, true, "fresh MA transition did not unlock a BUY");
});
