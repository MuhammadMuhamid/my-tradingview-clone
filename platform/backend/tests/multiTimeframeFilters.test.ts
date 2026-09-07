/**
 * Gates on more than one timeframe, and more than one of a kind.
 *
 * The request this exists for: "alert me when 15m price approaches support,
 * but only while BOTH the 15m RSI and the 1h RSI are above 50". Two gates of
 * the same kind on different timeframes — the shape the old one-slot-per-kind
 * model could not express at all.
 *
 * What is pinned here:
 *
 *  - a higher-timeframe gate reads the last CLOSED bar of its period and never
 *    a forming one, so it cannot see into an unfinished hour and cannot
 *    repaint once that hour closes;
 *  - gates are ANDed, and an unresolved one fails CLOSED;
 *  - a gate on the alert's own timeframe still costs no cross-timeframe work;
 *  - a row written before the list still evaluates.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateCondition, filtersPass, parseStoredFilters, describeFilters,
  validateCondition, conditionFromRow,
  type AlertCondition, type AlertFilters,
} from "../src/alerts/alertConditions";
import { barsClosedBy, gateReading } from "../src/alerts/filterSeries";
import { readCondition, toColumns } from "../src/alerts/alertRequest";
import { planAlert, type AlertSpec, type FeedSample } from "../src/alerts/alertPlan";
import { initialFireState } from "../src/alerts/alertFrequency";

const bar = { high: 101, low: 99, close: 100 };

const HOUR = 3_600_000;
/** Hourly bars closing on the hour: 01:00, 02:00, … */
const hourly = (n: number, price: (i: number) => number) =>
  Array.from({ length: n }, (_, i) => ({
    high: price(i) + 1, low: price(i) - 1, close: price(i),
    closeTime: (i + 1) * HOUR,
  }));

// ── the look-ahead boundary ────────────────────────────────────────────────

test("a higher-timeframe gate sees only bars that have already closed", () => {
  const bars = hourly(5, (i) => 100 + i);

  // Standing at 02:30 — inside the 02:00–03:00 bar, which has NOT closed.
  // Only the 01:00 and 02:00 bars are knowable.
  const at0230 = barsClosedBy(bars, 2 * HOUR + 1800_000);
  assert.equal(at0230.length, 2);
  assert.equal(at0230[at0230.length - 1]!.closeTime, 2 * HOUR);

  // Exactly on 03:00, the bar that closes at 03:00 is knowable — its period is
  // over. `closeTime <= closeTime`, not `<`.
  assert.equal(barsClosedBy(bars, 3 * HOUR).length, 3);

  // Before the first bar has closed there is nothing to read at all.
  assert.equal(barsClosedBy(bars, 1).length, 0);
});

test("the gate's answer does not change while the higher-timeframe bar forms", () => {
  // Oscillating, not monotonic: a series that only rises pins RSI at 100, and
  // a constant reading would pass this test without proving anything.
  const bars = hourly(60, (i) => 100 + Math.sin(i / 3) * 5);
  const filter: AlertFilters[number] = {
    kind: "rsi", timeframe: "1h", length: 14, level: 50, side: "above",
  };
  // Three moments inside the same unfinished hour must give the same reading,
  // because all three select the same last-closed bar. A gate that repainted
  // would answer differently as the hour progressed.
  const a = gateReading(bars, 40 * HOUR + 60_000, filter);
  const b = gateReading(bars, 40 * HOUR + 1800_000, filter);
  const c = gateReading(bars, 41 * HOUR - 1, filter);
  assert.ok(a !== undefined);
  assert.equal(a, b);
  assert.equal(b, c);

  // And the next hour genuinely moves it on.
  assert.notEqual(gateReading(bars, 41 * HOUR, filter), a);
});

test("an unresolved higher-timeframe gate reads undefined, not zero", () => {
  const bars = hourly(5, () => 100);
  // RSI 14 cannot have a value from five bars; a length that has not warmed up
  // must be "unknown", which fails the gate closed — never a number that would
  // sail through a comparison.
  assert.equal(
    gateReading(bars, 5 * HOUR, {
      kind: "rsi", timeframe: "1h", length: 14, level: 50, side: "above",
    }),
    undefined
  );
  assert.equal(
    gateReading([], 5 * HOUR, {
      kind: "ma", timeframe: "1h", type: "ema", length: 200, side: "above",
    }),
    undefined
  );
});

// ── two gates of the same kind ─────────────────────────────────────────────

const srNear = (filters: AlertFilters): AlertCondition => ({
  kind: "sr_zone", srSide: "support", mode: "near_above",
  nearMinPct: 0.2, nearMaxPct: 0.6, pivotLength: 10, invalidation: "close",
  filters,
});

const TWO_RSI: AlertFilters = [
  { kind: "rsi", timeframe: null, length: 50, level: 50, side: "above" },
  { kind: "rsi", timeframe: "1h", length: 50, level: 50, side: "above" },
];

test("two RSI gates on different timeframes are both required", () => {
  const s = { ...bar, refValue: 99.5 };
  const fire = (own: number | undefined, htf: number | undefined) =>
    evaluateCondition(srNear(TWO_RSI), { ...s, filterReadings: [own, htf] }, "above").triggered;

  assert.equal(fire(61, 61), true, "both open");
  assert.equal(fire(61, 43), false, "the 1h gate alone can shut it");
  assert.equal(fire(43, 61), false, "the 15m gate alone can shut it");
  // Fails closed on the unresolved one, even with the other wide open. This is
  // the case a naive `?? 0` or `|| true` would get wrong.
  assert.equal(fire(61, undefined), false, "an unknown 1h reading is not a pass");
});

test("readings are positional, so the same kind twice cannot collide", () => {
  // A named field could hold only one RSI. The index is what keeps the 15m and
  // the 1h readings apart, and mixing them up would silently swap the gates.
  assert.equal(filtersPass(TWO_RSI, { ...bar, filterReadings: [61, 43] }), false);
  assert.equal(filtersPass(TWO_RSI, { ...bar, filterReadings: [43, 61] }), false);
  assert.equal(filtersPass(TWO_RSI, { ...bar, filterReadings: [61, 61] }), true);
});

// ── the runner asks the right resolver ─────────────────────────────────────

test("a gate on another timeframe goes through otherTimeframe, not the feed", () => {
  const read = readCondition("rsi", {
    mode: "cross_up",
    filters: [
      { kind: "rsi", timeframe: null, length: 50, level: 50, side: "above" },
      { kind: "rsi", timeframe: "1h", length: 50, level: 50, side: "above" },
    ],
  });
  assert.ok("condition" in read);

  const spec: AlertSpec = {
    id: "a", symbol: "BTCUSDT", timeframe: "15m", enabled: true,
    condition: read.condition, frequency: "once_per_bar_close",
    lastSide: "below", fireState: initialFireState(0), lastBarTime: null,
  };
  const asked: string[] = [];
  const feed = (htf: number): FeedSample => ({
    symbol: "BTCUSDT", timeframe: "15m", barTime: 1, isClosedBar: true,
    high: 101, low: 99, close: 100,
    series: () => undefined,
    rsi: () => { asked.push("own"); return { value: 55, reference: 50 }; },
    otherTimeframe: (tf) => { asked.push(`other:${tf}`); return htf; },
  });

  const open = planAlert(spec, feed(61), Date.now());
  assert.ok(open.act && open.fire, "both gates open, the cross fires");
  // Gates resolve in list order first, then the condition's own reading. What
  // matters is WHICH resolver each gate used: the 15m gate never crosses a
  // timeframe, and the 1h gate always does.
  assert.deepEqual(asked, ["own", "other:1h", "own"],
    "the own-timeframe gate uses the feed; only the 1h gate crosses timeframes");

  asked.length = 0;
  const shut = planAlert(spec, feed(43), Date.now());
  assert.ok(shut.act && shut.triggered === false, "a shut 1h gate silences it");
});

// ── storage ────────────────────────────────────────────────────────────────

test("a row written before the list still evaluates, as own-timeframe gates", () => {
  const back = conditionFromRow({
    conditionKind: "sr_zone", srSide: "support", mode: "near_above",
    nearMinPct: 0.2, nearMaxPct: 0.5,
    maType: null, maLength: null, ma2Type: null, ma2Length: null,
    targetPrice: null, priceDirection: null,
    srPivotLength: 5, srInvalidation: "close",
    // No `filters` at all — the pre-032 shape.
    filterRsiLength: 50, filterRsiLevel: 50, filterRsiSide: "above",
  } as Parameters<typeof conditionFromRow>[0]);
  assert.deepEqual(back?.filters, [
    { kind: "rsi", timeframe: null, length: 50, level: 50, side: "above" },
  ]);
});

test("an empty stored list means no gates, not fall back to the old columns", () => {
  // The distinction matters: a user who REMOVED their last gate must not have
  // it resurrected from the legacy columns on the next read.
  const back = conditionFromRow({
    conditionKind: "sr_zone", srSide: "support", mode: "near_above",
    nearMinPct: 0.2, nearMaxPct: 0.5,
    maType: null, maLength: null, ma2Type: null, ma2Length: null,
    targetPrice: null, priceDirection: null,
    srPivotLength: 5, srInvalidation: "close",
    filters: [],
    filterRsiLength: 50, filterRsiLevel: 50, filterRsiSide: "above",
  } as Parameters<typeof conditionFromRow>[0]);
  assert.equal(back?.filters, undefined);
});

test("a stored element that is not an evaluable gate is dropped, not evaluated", () => {
  // A gate whose reading can never resolve fails closed forever, silencing the
  // alert with nothing to show why. Dropping it is the lesser evil, and the
  // request parser refuses these on the way in anyway.
  const parsed = parseStoredFilters([
    { kind: "rsi", timeframe: "1h", length: 50, level: 50, side: "above" },
    { kind: "rsi", side: "above" },                 // no length or level
    { kind: "ichimoku", side: "above" },            // not a kind
    { kind: "ma", type: "ema", length: 200 },       // no side
    { kind: "ma", timeframe: "nonsense", type: "ema", length: 200, side: "below" },
    "not an object",
  ]);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0]!.timeframe, "1h");
  // An unrecognised timeframe degrades to the alert's own rather than dropping
  // the gate: the rule is still evaluable, just on the timeframe it was armed
  // for, which is the conservative reading.
  assert.equal(parsed[1]!.timeframe, null);
});

test("the list survives the trip through columns and back", () => {
  const filters: AlertFilters = [
    { kind: "rsi", timeframe: null, length: 50, level: 50, side: "above" },
    { kind: "rsi", timeframe: "1h", length: 50, level: 55, side: "above" },
    { kind: "supertrend", timeframe: "4h", period: 10, multiplier: 3, atrMethod: "rma", side: "above" },
  ];
  const cols = toColumns(srNear(filters));
  assert.deepEqual(cols.filters, filters);
  // The legacy columns mirror only the first own-timeframe gate of each kind —
  // there is no column that could express "1h RSI", and writing one would read
  // as a complete gate that is not the one being enforced.
  assert.equal(cols.filterRsiLevel, 50);
  assert.equal(cols.filterStSide, null, "a 4h Supertrend gate has no legacy column");

  const back = conditionFromRow({ ...cols, nearMinPct: 0.2, nearMaxPct: 0.6 });
  assert.deepEqual(back?.filters, filters);
});

// ── the request surface ────────────────────────────────────────────────────

test("the list form is accepted, and its timeframe is validated", () => {
  const ok = readCondition("sr_zone", {
    srSide: "support",
    filters: [{ kind: "rsi", timeframe: "1h", length: 50, level: 50, side: "above" }],
  });
  assert.ok("condition" in ok);
  assert.equal(ok.condition.filters?.[0]?.timeframe, "1h");

  for (const bad of [
    { filters: "nope" },
    { filters: [{ kind: "ichimoku" }] },
    { filters: [{ kind: "rsi", timeframe: "7h" }] },
    { filters: [{ kind: "rsi", level: 150 }] },
    { filters: [{ kind: "rsi", side: "sideways" }] },
  ]) {
    assert.ok(
      "error" in readCondition("sr_zone", { srSide: "support", ...bad }),
      JSON.stringify(bad)
    );
  }
});

test("two identical gates are refused — it is the same question twice", () => {
  const same: AlertFilters = [
    { kind: "rsi", timeframe: "1h", length: 50, level: 50, side: "above" },
    { kind: "rsi", timeframe: "1h", length: 50, level: 50, side: "above" },
  ];
  assert.match(validateCondition(srNear(same)) ?? "", /identical/);

  // The same gate on two timeframes is the whole point, and must pass.
  assert.equal(validateCondition(srNear(TWO_RSI)), null);
});

test("the description names a gate's timeframe only when it is not the alert's own", () => {
  assert.equal(
    describeFilters(TWO_RSI),
    " — only while RSI 50 is above 50 and 1h RSI 50 is above 50"
  );
});

// ── the pivot gate ─────────────────────────────────────────────────────────

/**
 * "Only fire while price is near a daily pivot."
 *
 * Shaped unlike the other three gates, and the difference is the point: they
 * ask which SIDE of a line price is on, this asks how FAR from it. So it
 * carries a band rather than a bare side, and it accepts `either` — "near S1"
 * usually means near it from whichever direction price approaches.
 *
 * The reading the runner supplies is the LEVEL'S PRICE. The distance is
 * computed in `filtersPass`, so the runner resolves a level and nothing else —
 * the same resolver a `pivot_level` alert already uses, on the same completed
 * anchor period.
 */
const pivotGate = (over: Partial<Extract<AlertFilters[number], { kind: "pivot" }>> = {}) => ({
  kind: "pivot" as const, timeframe: null, anchor: "1d" as const,
  pivotType: "Fibonacci" as const, levelName: "S1",
  side: "either" as const, minPct: 0, maxPct: 0.5,
  ...over,
});

test("the pivot gate measures distance from the level, not which side of it", () => {
  // Level at 100. A close of 100.3 is 0.30% above; 99.7 is 0.30% below.
  const at = (close: number, filter = pivotGate()) =>
    filtersPass([filter], { high: close, low: close, close, filterReadings: [100] });

  assert.equal(at(100.3), true, "0.30% above is inside a 0–0.5% band");
  assert.equal(at(99.7), true, "0.30% below is too, when the side is either");
  assert.equal(at(101), false, "1.00% away is outside the band");
  assert.equal(at(100), true, "exactly on the level is zero away, inside 0–0.5%");
});

test("a directional pivot gate rejects the side it was not asked about", () => {
  const above = pivotGate({ side: "above" });
  const below = pivotGate({ side: "below" });
  const at = (close: number, f: AlertFilters[number]) =>
    filtersPass([f], { high: close, low: close, close, filterReadings: [100] });

  assert.equal(at(100.3, above), true);
  assert.equal(at(99.7, above), false, "below the level is not 'above' it");
  assert.equal(at(99.7, below), true);
  assert.equal(at(100.3, below), false);
});

test("a band with a floor is an approach, not a proximity", () => {
  // 0.2–0.5% is "coming up on it but not there yet" — the same reading the
  // near_above alert mode has. Sitting exactly on the level fails it.
  const approach = pivotGate({ minPct: 0.2, maxPct: 0.5 });
  const at = (close: number) =>
    filtersPass([approach], { high: close, low: close, close, filterReadings: [100] });
  assert.equal(at(100), false, "on the level is not approaching it");
  assert.equal(at(100.3), true);
  assert.equal(at(100.6), false, "past the far edge");
});

test("an unresolved or zero level fails the gate closed", () => {
  const f = pivotGate();
  const bar = { high: 100, low: 100, close: 100 };
  // No completed anchor period yet.
  assert.equal(filtersPass([f], { ...bar, filterReadings: [undefined] }), false);
  // A zero level would make the percentage meaningless rather than infinite.
  assert.equal(filtersPass([f], { ...bar, filterReadings: [0] }), false);
});

test("a pivot gate is resolved from the anchor, never across a timeframe", () => {
  const read = readCondition("macd", {
    mode: "cross_up",
    filters: [{ kind: "pivot", anchor: "1w", pivotType: "Fibonacci", levelName: "P" }],
  });
  assert.ok("condition" in read);

  const spec: AlertSpec = {
    id: "a", symbol: "BTCUSDT", timeframe: "15m", enabled: true,
    condition: read.condition, frequency: "once_per_bar_close",
    lastSide: "below", fireState: initialFireState(0), lastBarTime: null,
  };
  const asked: string[] = [];
  const feed: FeedSample = {
    symbol: "BTCUSDT", timeframe: "15m", barTime: 1, isClosedBar: true,
    high: 101, low: 99, close: 100,
    series: () => undefined,
    macd: () => ({ value: 0.3, reference: 0.1 }),
    pivotLevel: (type, anchor, name) => {
      asked.push(`pivot:${type}:${anchor}:${name}`);
      return { price: 100, label: name };
    },
    otherTimeframe: () => { asked.push("otherTimeframe"); return undefined; },
  };

  const plan = planAlert(spec, feed, Date.now());
  assert.ok(plan.act && plan.fire, "the MACD cross fires with the gate open");
  assert.deepEqual(asked, ["pivot:Fibonacci:1w:P"],
    "a pivot gate uses the anchored resolver and never crosses a timeframe");
});

test("a pivot gate is refused when its level could never resolve", () => {
  // Fibonacci defines no R4, so gating on it would silence the alert forever.
  const bad = readCondition("sr_zone", {
    srSide: "support",
    filters: [{ kind: "pivot", pivotType: "Fibonacci", levelName: "R4" }],
  });
  assert.ok("condition" in bad);
  assert.match(validateCondition(bad.condition) ?? "", /has no level "R4"/);

  for (const f of [
    { kind: "pivot", anchor: "3d" },
    { kind: "pivot", pivotType: "Nonsense" },
    { kind: "pivot", minPct: 0.5, maxPct: 0.2 },
    { kind: "pivot", minPct: -1 },
    { kind: "pivot", side: "sideways" },
  ]) {
    assert.ok(
      "error" in readCondition("sr_zone", { srSide: "support", filters: [f] }),
      JSON.stringify(f)
    );
  }
});

test("only the pivot gate accepts 'either' — it is the only distance question", () => {
  assert.ok("error" in readCondition("sr_zone", {
    srSide: "support",
    filters: [{ kind: "rsi", side: "either" }],
  }), "'RSI is either 50' is not a rule");
});

test("the pivot gate describes itself as a distance", () => {
  assert.equal(
    describeFilters([pivotGate({ minPct: 0.2, maxPct: 0.5 })]),
    " — only while price is 0.2–0.5% either side of Fibonacci S1 (1d)"
  );
  assert.equal(
    describeFilters([pivotGate({ levelName: "any", anchor: "1w", side: "above" })]),
    " — only while price is 0–0.5% above the nearest Fibonacci pivot (1w)"
  );
});
