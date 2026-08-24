/**
 * The alert planner: which samples an alert is allowed to see, and what it
 * persists afterwards.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  planAlert, stateAfterPlan,
  type AlertPlan, type AlertSpec, type FeedSample,
} from "../src/alerts/alertPlan";
import { initialFireState, type AlertFrequency } from "../src/alerts/alertFrequency";
import type { MaType } from "../src/types/maAlerts";

const BAR = 1_700_000_000_000;
const MINUTE = 60_000;

function spec(over: Partial<AlertSpec> = {}): AlertSpec {
  return {
    id: "a1",
    symbol: "BTCUSDT",
    timeframe: "1h",
    enabled: true,
    condition: { kind: "price", targetPrice: 100, direction: "cross_up" },
    frequency: "once_per_bar_close",
    lastSide: "below",
    fireState: initialFireState(0),
    lastBarTime: null,
    ...over,
  };
}

function sample(over: Partial<FeedSample> = {}): FeedSample {
  return {
    symbol: "BTCUSDT",
    timeframe: "1h",
    barTime: BAR,
    isClosedBar: true,
    high: 103,
    low: 99,
    close: 102,
    series: () => undefined,
    ...over,
  };
}

const acted = (plan: AlertPlan): Extract<AlertPlan, { act: true }> => {
  assert.equal(plan.act, true, `expected the alert to be evaluated, got ${JSON.stringify(plan)}`);
  return plan as Extract<AlertPlan, { act: true }>;
};

// ── The staleness guard ─────────────────────────────────────────────────────

test("STALE SYMBOL AND TIMEFRAME SAMPLES CANNOT TRIGGER AN ALERT", () => {
  // Feeds are multiplexed and re-subscribed on reconnect, so a frame for a
  // just-unsubscribed stream is ordinary. Evaluating BTC's alert against ETH's
  // price would fire a wrong notification AND corrupt the stored cross side.
  const wrongSymbol = planAlert(spec(), sample({ symbol: "ETHUSDT" }), BAR);
  assert.deepEqual(wrongSymbol, { act: false, reason: "wrong_symbol" });

  const wrongTimeframe = planAlert(spec(), sample({ timeframe: "15m" }), BAR);
  assert.deepEqual(wrongTimeframe, { act: false, reason: "wrong_timeframe" });

  // Both would have fired had the feed matched — the guard is what stops them,
  // not an incidentally-false condition.
  assert.equal(acted(planAlert(spec(), sample(), BAR)).fire, true);
});

test("a late frame for an OLDER bar cannot rewrite cross state", () => {
  const armed = spec({ lastBarTime: BAR });
  assert.deepEqual(
    planAlert(armed, sample({ barTime: BAR - 3_600_000 }), BAR),
    { act: false, reason: "stale_bar" }
  );
  // The current bar is still fine, and so is the next one.
  assert.equal(planAlert(armed, sample({ barTime: BAR }), BAR).act, true);
  assert.equal(planAlert(armed, sample({ barTime: BAR + 3_600_000 }), BAR).act, true);
});

test("a disabled alert is never evaluated", () => {
  assert.deepEqual(planAlert(spec({ enabled: false }), sample(), BAR), {
    act: false, reason: "disabled",
  });
});

// ── The cadence boundary ────────────────────────────────────────────────────

test("A FORMING CANDLE IS INVISIBLE TO A once_per_bar_close ALERT", () => {
  // Not merely "does not fire" — not evaluated at all, so `lastSide` is never
  // written from a forming bar. If it were, a mid-candle wick above the level
  // would consume the cross and the close would find itself already `above`,
  // silently turning a bar-close alert into a worse intrabar one.
  const forming = sample({ isClosedBar: false });
  assert.deepEqual(planAlert(spec(), forming, BAR), {
    act: false, reason: "wrong_sample_kind",
  });
});

test("the intrabar modes and once_only do see a forming candle", () => {
  const forming = sample({ isClosedBar: false });
  for (const frequency of ["once_per_bar", "once_per_minute", "once_only"] as AlertFrequency[]) {
    assert.equal(acted(planAlert(spec({ frequency }), forming, BAR)).fire, true, frequency);
  }
});

test("a bar-close alert is unaffected by a wick its intrabar neighbour reacted to", () => {
  // Same condition, same feed, two frequencies. The wick pierces 100 and the
  // candle closes back below it.
  const wick = sample({ isClosedBar: false, high: 101, low: 98, close: 100.5 });
  const close = sample({ isClosedBar: true, high: 101, low: 98, close: 99.4 });

  const intrabar = spec({ id: "fast", frequency: "once_per_bar" });
  const intrabarPlan = acted(planAlert(intrabar, wick, BAR));
  assert.equal(intrabarPlan.fire, true, "the intrabar alert reacts to the wick");

  const barClose = spec({ id: "slow", frequency: "once_per_bar_close" });
  assert.equal(planAlert(barClose, wick, BAR).act, false, "the wick is not shown to it");
  const closePlan = acted(planAlert(barClose, close, BAR));
  assert.equal(closePlan.fire, false, "and the close did not cross");
  assert.equal(closePlan.side, "below", "so its side is still below, ready for a real cross");
});

// ── Suppression is reported, not hidden ─────────────────────────────────────

test("a true condition the frequency withholds is reported as suppressed", () => {
  const fired = spec({
    frequency: "once_per_bar",
    fireState: { ...initialFireState(0), lastFiredBarTime: BAR, lastFiredAt: BAR },
  });
  const plan = acted(planAlert(fired, sample(), BAR));
  assert.equal(plan.triggered, true);
  assert.equal(plan.fire, false);
  assert.equal(plan.suppressed, "already_fired_this_bar");
});

test("a false condition is not reported as suppressed — nothing was withheld", () => {
  const plan = acted(planAlert(spec(), sample({ close: 98, high: 99 }), BAR));
  assert.equal(plan.triggered, false);
  assert.equal(plan.suppressed, null);
});

// ── Series wiring ───────────────────────────────────────────────────────────

test("each condition kind asks for exactly the series it compares against", () => {
  const asked: string[] = [];
  const series = (type: MaType, length: number): number => {
    asked.push(`${type}${length}`);
    return 100;
  };

  planAlert(spec(), sample({ series }), BAR);
  assert.deepEqual(asked, [], "a price alert computes no moving average");

  planAlert(
    spec({ condition: { kind: "ma", maType: "sma", maLength: 15, mode: "cross_up", nearMinPct: 0.2, nearMaxPct: 0.5 } }),
    sample({ series }), BAR
  );
  assert.deepEqual(asked, ["sma15"]);

  asked.length = 0;
  planAlert(
    spec({ condition: { kind: "ma_vs_ma", maType: "ema", maLength: 50, ma2Type: "sma", ma2Length: 200, mode: "cross_up" } }),
    sample({ series }), BAR
  );
  assert.deepEqual(asked, ["ema50", "sma200"]);
});

test("an unseeded MA evaluates to no trigger and leaves the side alone", () => {
  const ma = spec({
    condition: { kind: "ma", maType: "ema", maLength: 200, mode: "cross_up", nearMinPct: 0.2, nearMaxPct: 0.5 },
  });
  const plan = acted(planAlert(ma, sample(), BAR));
  assert.equal(plan.fire, false);
  assert.equal(plan.side, "below", "unchanged from the alert's stored side");
});

// ── What gets persisted ─────────────────────────────────────────────────────

test("a fire records the bar and the clock; a non-fire records only the side", () => {
  const armed = spec();
  const fired = acted(planAlert(armed, sample(), BAR));
  const after = stateAfterPlan(armed, fired, { barTime: BAR, now: BAR + 10, delivered: true });
  assert.equal(after.lastSide, "above");
  assert.equal(after.lastBarTime, BAR);
  assert.equal(after.fireState.lastFiredAt, BAR + 10);
  assert.equal(after.fireState.lastFiredBarTime, BAR);

  const quiet = spec({ lastSide: "above" });
  const plan = acted(planAlert(quiet, sample(), BAR));
  assert.equal(plan.fire, false);
  const unchanged = stateAfterPlan(quiet, plan, { barTime: BAR, now: BAR + 10, delivered: false });
  assert.equal(unchanged.fireState.lastFiredAt, null, "a quiet evaluation does not touch the clock");
  assert.equal(unchanged.lastBarTime, BAR, "but it does advance the staleness watermark");
});

test("a once_only alert retires on delivery and is inert afterwards, across a restart", () => {
  const armed = spec({ frequency: "once_only" });
  const plan = acted(planAlert(armed, sample(), BAR));
  assert.equal(plan.fire, true);

  const after = stateAfterPlan(armed, plan, { barTime: BAR, now: BAR, delivered: true });
  assert.equal(after.fireState.completed, true);

  // Round-trip through JSON the way the database round-trips it.
  const restarted = spec({
    frequency: "once_only",
    lastSide: after.lastSide,
    lastBarTime: after.lastBarTime,
    fireState: JSON.parse(JSON.stringify(after.fireState)),
  });
  const later = acted(planAlert(restarted, sample({ barTime: BAR + 3_600_000, close: 99 }), BAR + MINUTE));
  assert.equal(later.fire, false);
  const again = acted(planAlert(restarted, sample({ barTime: BAR + 7_200_000 }), BAR + 2 * MINUTE));
  assert.equal(again.triggered, false, "side is already above, so no cross");
  assert.equal(again.fire, false);
});

test("an undelivered once_only alert stays armed", () => {
  const armed = spec({ frequency: "once_only" });
  const plan = acted(planAlert(armed, sample(), BAR));
  const after = stateAfterPlan(armed, plan, { barTime: BAR, now: BAR, delivered: false });
  assert.equal(after.fireState.completed, false, "a push that reached nobody must not retire the alert");
});

// ── The whole point, end to end ─────────────────────────────────────────────

test("FORTY INTRABAR TICKS IN ONE CANDLE PRODUCE EXACTLY ONE once_per_bar NOTIFICATION", () => {
  let current = spec({ frequency: "once_per_bar", lastSide: "below" });
  let fires = 0;
  for (let i = 0; i < 40; i += 1) {
    const s = sample({ isClosedBar: i === 39, close: 100 + (i % 2 === 0 ? 2 : -2), high: 103, low: 97 });
    const plan = acted(planAlert(current, s, BAR + i * 1000));
    if (plan.fire) fires += 1;
    const after = stateAfterPlan(current, plan, {
      barTime: BAR, now: BAR + i * 1000, delivered: plan.fire,
    });
    current = { ...current, ...after };
  }
  assert.equal(fires, 1);
});

test("once_per_minute is capped by the clock, not by the candle", () => {
  let current = spec({ frequency: "once_per_minute", condition: { kind: "price", targetPrice: 100, direction: "either" } });
  let fires = 0;
  // Ten minutes of ticks, one every ten seconds, condition permanently true.
  for (let i = 0; i < 60; i += 1) {
    const now = BAR + i * 10_000;
    const plan = acted(planAlert(current, sample({ isClosedBar: false, barTime: BAR + Math.floor(i / 6) * 60_000 }), now));
    if (plan.fire) fires += 1;
    const after = stateAfterPlan(current, plan, { barTime: BAR, now, delivered: plan.fire });
    current = { ...current, ...after };
  }
  assert.equal(fires, 10, "one per minute over ten minutes");
});
