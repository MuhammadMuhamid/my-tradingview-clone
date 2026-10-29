/**
 * The "recent S/R touch" gate: a structure break (or any alert) that fires only
 * after price came back to the nearest support and bounced off it — or to the
 * nearest resistance and was rejected there.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildZones, DEFAULT_SR_OPTIONS, srTouchBounce, type Bars } from "../src/ta/core";
import {
  describeGate, parseStoredFilters, validateCondition, type AlertCondition, type AlertFilters,
} from "../src/alerts/alertConditions";
import { planAlert, type AlertSpec, type FeedSample } from "../src/alerts/alertPlan";
import { initialFireState } from "../src/alerts/alertFrequency";

const OPTS = { ...DEFAULT_SR_OPTIONS, pivotLength: 3, invalidation: "close" as const };

/**
 * A swing low at 100 (bar 4, confirmed at bar 7), a rally, and a return whose
 * wick reaches 100.1 on bar 12 before price closes back up on bar 13.
 */
function series(extra: { low: number; close: number }[] = []): Bars {
  const lows = [110, 108, 106, 104, 100, 103, 105, 107, 109, 108, 106, 104, 100.1, 101];
  const closes = lows.map((x) => x + 1);
  closes[12] = 101.5;
  closes[13] = 102;
  for (const b of extra) { lows.push(b.low); closes.push(b.close); }
  return { low: lows, high: lows.map((x) => x + 2), close: closes };
}

test("a wick to support within the window, then a close above it, is a bounce", () => {
  const bars = series();
  const zones = buildZones(bars, OPTS);
  const hit = srTouchBounce(bars, zones, 13, "support", 10, 0.2, OPTS);
  assert.deepEqual(hit, { price: 100, touchIndex: 12 });
});

test("no touch: the wick stayed outside the tolerance, or before the window", () => {
  const bars = series();
  const zones = buildZones(bars, OPTS);
  // 0.05% of 100 is 100.05; the wick reached 100.1.
  assert.equal(srTouchBounce(bars, zones, 13, "support", 10, 0.05, OPTS), null);
  // A one-bar window sees only bar 13, whose low is 101.
  assert.equal(srTouchBounce(bars, zones, 13, "support", 1, 0.2, OPTS), null);
});

test("a close through the support since the touch is a break, not a bounce", () => {
  const bars = series([{ low: 99, close: 99.5 }]);
  const zones = buildZones(bars, OPTS);
  assert.equal(srTouchBounce(bars, zones, 14, "support", 10, 0.2, OPTS), null);
});

test("a level is never used before it is confirmed", () => {
  // At bar 6 the swing low at bar 4 is not yet knowable (confirmed at 7).
  const bars = series();
  const zones = buildZones(bars, OPTS);
  assert.equal(srTouchBounce(bars, zones, 6, "support", 10, 50, OPTS), null);
});

// ── the gate on an alert ──────────────────────────────────────────────────

const GATE: AlertFilters = [
  { kind: "sr_touch", pivotLength: 15, lookback: 10, tolerancePct: 0.2, side: "above", timeframe: "1h" },
];

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
  const probe = { ...feed, srTouch: (k: "support" | "resistance") => { kinds.push(k); return true; } };
  planAlert(spec(bearish), { ...probe, gateFeeds: { "1h": probe } }, 0);
  assert.deepEqual(kinds, ["resistance"]);
});

test("the gate is stored, read back, described and validated", () => {
  const parsed = parseStoredFilters(JSON.parse(JSON.stringify(GATE)));
  assert.deepEqual(parsed, GATE);
  assert.equal(describeGate(GATE[0]!),
    "price bounced off the 1h support (pivot 15) within the last 10 bars");
  assert.equal(describeGate({ ...GATE[0]!, side: "below", lookback: 1 } as AlertFilters[number]),
    "price was rejected at the 1h resistance (pivot 15) within the last bar");
  assert.equal(validateCondition(msb(GATE)), null);
  const bad = (over: Record<string, number>) =>
    validateCondition(msb([{ ...GATE[0]!, ...over } as AlertFilters[number]]));
  assert.match(bad({ lookback: 0 }) ?? "", /lookback/);
  assert.match(bad({ pivotLength: 1.5 }) ?? "", /pivot length/);
  assert.match(bad({ tolerancePct: 11 }) ?? "", /tolerance/);
  // Missing a field: the whole list is refused rather than half-read.
  assert.equal(parseStoredFilters([{ kind: "sr_touch", side: "above", pivotLength: 15 }]), null);
});
