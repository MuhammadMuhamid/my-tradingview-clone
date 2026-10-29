/**
 * The "recent S/R touch" gate: a structure break (or any alert) that fires only
 * after price retested a live Flux Charts support and bounced — or a
 * resistance and was rejected there.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FLUX_SR_DEFAULTS, fluxSrTouchBounce, type FluxSrBar } from "../src/ta/core";
import {
  describeGate, parseStoredFilters, validateCondition, type AlertCondition, type AlertFilters,
} from "../src/alerts/alertConditions";
import { planAlert, type AlertSpec, type FeedSample } from "../src/alerts/alertPlan";
import { initialFireState } from "../src/alerts/alertFrequency";

const OPTS = { ...FLUX_SR_DEFAULTS, pivotLength: 3 };

/**
 * A swing low at 100 (bar 4; the indicator adds it on bar 7), a rally, and a
 * return whose wick dips to 99.9 on bar 12 and closes back above (the chart's
 * "R"), before price closes higher on bar 13.
 */
function series(touchLow = 99.9, extra: { low: number; close: number }[] = []): FluxSrBar[] {
  const lows = [110, 108, 106, 104, 100, 103, 105, 107, 109, 108, 106, 104, touchLow, 101];
  const closes = lows.map((x) => x + 1);
  closes[12] = 101.5;
  closes[13] = 102;
  for (const b of extra) { lows.push(b.low); closes.push(b.close); }
  return lows.map((low, i) => ({
    time: i * 3_600_000, low, high: low + 2, close: closes[i]!, volume: 1,
  }));
}

test("a retest of a live support, then a close above it, is a bounce", () => {
  assert.deepEqual(fluxSrTouchBounce(series(), OPTS, "support", 10, 0), { price: 100, touchIndex: 12 });
});

test("a touch is the indicator's own retest: the wick must reach the level", () => {
  // 100.1 stops short of 100: no "R" on the chart, so no touch…
  assert.equal(fluxSrTouchBounce(series(100.1), OPTS, "support", 10, 0), null);
  // …unless the gate is given room for it.
  assert.deepEqual(fluxSrTouchBounce(series(100.1), OPTS, "support", 10, 0.2), { price: 100, touchIndex: 12 });
});

test("outside the window, or once the support is broken, there is no bounce", () => {
  // A two-bar window is bars 12..13 — and bar 12 is the touch; one bar is only 13.
  assert.ok(fluxSrTouchBounce(series(), OPTS, "support", 2, 0));
  assert.equal(fluxSrTouchBounce(series(), OPTS, "support", 1, 0), null);
  assert.equal(fluxSrTouchBounce(series(99.9, [{ low: 99, close: 99.5 }]), OPTS, "support", 10, 0), null);
});

test("Strength hides a level the chart would not show", () => {
  // Created at strength 1; the retest on bar 12 makes it 2.
  assert.ok(fluxSrTouchBounce(series(), { ...OPTS, strength: 2 }, "support", 10, 0));
  assert.equal(fluxSrTouchBounce(series(), { ...OPTS, strength: 3 }, "support", 10, 0), null);
});

// ── the gate on an alert ──────────────────────────────────────────────────

const GATE: AlertFilters = [{
  kind: "sr_touch", pivotLength: 15, strength: 1, invalidation: "close", avoidFalseBreaks: false,
  breakVolumeThreshold: 0.3, inverseBroken: false, lookback: 10, tolerancePct: 0,
  side: "above", timeframe: "1h",
}];

const msb = (filters?: AlertFilters): AlertCondition => ({
  kind: "msb", zigzagLength: 2, fibFactor: 0.33, mode: "cross_up",
  ...(filters ? { filters } : {}),
} as AlertCondition);

function spec(condition: AlertCondition): AlertSpec {
  return {
    id: "a1", symbol: "NEARUSDT", timeframe: "1h", enabled: true, condition,
    frequency: "once_per_bar_close", lastSide: null,
    fireState: initialFireState(0), lastBarTime: null,
  };
}

function sample(touch: boolean | undefined): FeedSample {
  const feed: FeedSample = {
    symbol: "NEARUSDT", timeframe: "1h", barTime: 1_700_000_000_000, isClosedBar: true,
    high: 3, low: 2, close: 2.5, series: () => undefined,
    // A bullish break on this bar.
    msb: () => ({ market: 1, broke: 1, price: 2.4 }),
    srTouch: () => touch,
  };
  return { ...feed, gateFeeds: { "1h": feed } };
}

test("a bullish MSB gated on a support bounce fires only after the bounce", () => {
  const ungated = planAlert(spec(msb()), sample(false), 0);
  assert.ok(ungated.act && ungated.fire, "the break alone fires without the gate");

  const bounced = planAlert(spec(msb(GATE)), sample(true), 0);
  assert.ok(bounced.act && bounced.fire, "touched support and bounced: fires");

  const none = planAlert(spec(msb(GATE)), sample(false), 0);
  assert.ok(none.act && !none.fire, "no recent touch: silent");

  const unknown = planAlert(spec(msb(GATE)), sample(undefined), 0);
  assert.ok(unknown.act && !unknown.fire, "cannot tell: fails closed");
});

test("the resistance side asks for a rejection, and support alone does not open it", () => {
  const below: AlertFilters = [{ ...GATE[0]!, side: "below" } as AlertFilters[number]];
  const bearish = { ...msb(below), mode: "cross_down" } as AlertCondition;
  const s = sample(true);
  const feed = { ...s, msb: () => ({ market: -1, broke: -1, price: 2.6 }) };
  const withFeeds = { ...feed, gateFeeds: { "1h": feed } };
  const fired = planAlert(spec(bearish), withFeeds, 0);
  assert.ok(fired.act && fired.fire);
  const kinds: string[] = [];
  const probe: FeedSample = { ...feed, srTouch: (g) => { kinds.push(g.side); return true; } };
  planAlert(spec(bearish), { ...probe, gateFeeds: { "1h": probe } }, 0);
  assert.deepEqual(kinds, ["below"]);
});

test("the gate is stored, read back, described and validated", () => {
  const parsed = parseStoredFilters(JSON.parse(JSON.stringify(GATE)));
  assert.deepEqual(parsed, GATE);
  assert.equal(describeGate(GATE[0]!),
    "price bounced off a 1h Flux support within the last 10 bars");
  assert.equal(describeGate({ ...GATE[0]!, side: "below", lookback: 1 } as AlertFilters[number]),
    "price was rejected at a 1h Flux resistance within the last bar");
  assert.equal(validateCondition(msb(GATE)), null);
  const bad = (over: Record<string, number>) =>
    validateCondition(msb([{ ...GATE[0]!, ...over } as AlertFilters[number]]));
  assert.match(bad({ lookback: 0 }) ?? "", /lookback/);
  assert.match(bad({ pivotLength: 2 }) ?? "", /pivot length/);
  assert.match(bad({ strength: 4 }) ?? "", /strength/);
  assert.match(bad({ tolerancePct: 11 }) ?? "", /tolerance/);
  // Missing a field: the whole list is refused rather than half-read.
  assert.equal(parseStoredFilters([{ kind: "sr_touch", side: "above", pivotLength: 15 }]), null);
  // A gate saved by the first version (no Flux settings) reads as the defaults.
  assert.deepEqual(
    parseStoredFilters([{ kind: "sr_touch", side: "above", pivotLength: 5, lookback: 10, tolerancePct: 0.2 }]),
    [{ ...GATE[0]!, pivotLength: 5, tolerancePct: 0.2, timeframe: undefined }].map(({ timeframe: _t, ...g }) => g),
  );
});
