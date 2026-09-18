/**
 * Trend gates on the level alert families.
 *
 * A gate is a PRECONDITION, not a trigger. The three properties that matter,
 * and that are easy to get wrong:
 *
 *  - it suppresses the notification only; cross state is still recorded, or a
 *    shut gate would leave stale state that fires spuriously when it opens.
 *  - it fails CLOSED. An RSI still warming up is not "trend up".
 *  - it is evaluated on the alert's own timeframe, against the same bar.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateCondition, filtersPass, describeFilters, validateCondition,
  conditionFromRow, type AlertCondition,
} from "../src/alerts/alertConditions";
import { readCondition, toColumns } from "../src/alerts/alertRequest";

const bar = { high: 101, low: 99, close: 100 };

/** Support at 99.5; a close of 100 sits 0.50% above it, inside the 0.2–0.5 band. */
const srNear = (
  filters?: Extract<AlertCondition, { kind: "sr_zone" }>["filters"]
): Extract<AlertCondition, { kind: "sr_zone" }> => ({
  kind: "sr_zone",
  srSide: "support",
  mode: "near_above",
  nearMinPct: 0.2,
  nearMaxPct: 0.6,
  pivotLength: 10,
  invalidation: "close",
  ...(filters ? { filters } : {}),
});

const RSI_UP = [{ kind: "rsi" as const, length: 50, level: 50, side: "above" as const }];
const MA_UP = [{ kind: "ma" as const, type: "ema" as const, length: 200, side: "above" as const }];
const BOTH = [...RSI_UP, ...MA_UP];

/**
 * Gate readings, written the way a reader sees them.
 *
 * Every gate reduces to a SIGNED SPREAD, so the evaluator only tests a sign.
 * These helpers keep the tests phrased in the quantities a trader would name —
 * "RSI 61", "close 100 against an EMA of 90" — rather than in the differences
 * the evaluator actually consumes.
 */
const rsiReading = (value: number, level = 50): number => value - level;
const maReading = (close: number, ma: number): number => close - ma;

test("with no gate the alert behaves exactly as before", () => {
  const e = evaluateCondition(srNear(), { ...bar, refValue: 99.5 }, "above");
  assert.equal(e.triggered, true);
});

test("an open RSI gate lets the level alert through", () => {
  const e = evaluateCondition(
    srNear(RSI_UP), { ...bar, refValue: 99.5, filterReadings: [rsiReading(61)] }, "above"
  );
  assert.equal(e.triggered, true);
});

test("a shut RSI gate silences the same event", () => {
  const e = evaluateCondition(
    srNear(RSI_UP), { ...bar, refValue: 99.5, filterReadings: [rsiReading(43)] }, "above"
  );
  assert.equal(e.triggered, false);
});

test("the boundary is strict: RSI exactly at the level does not open an 'above' gate", () => {
  const e = evaluateCondition(
    srNear(RSI_UP), { ...bar, refValue: 99.5, filterReadings: [rsiReading(50)] }, "above"
  );
  assert.equal(e.triggered, false, "50 is not above 50");
});

test("the EMA gate compares the CLOSE against the moving average", () => {
  const open = evaluateCondition(
    srNear(MA_UP), { ...bar, refValue: 99.5, filterReadings: [maReading(100, 90)] }, "above"
  );
  assert.equal(open.triggered, true, "close 100 is above EMA 90");

  const shut = evaluateCondition(
    srNear(MA_UP), { ...bar, refValue: 99.5, filterReadings: [maReading(100, 110)] }, "above"
  );
  assert.equal(shut.triggered, false, "close 100 is below EMA 110");
});

test("two gates are ANDed — both must be open", () => {
  const both = BOTH;
  const s = { ...bar, refValue: 99.5 };
  assert.equal(
    evaluateCondition(srNear(both), { ...s, filterReadings: [rsiReading(61), maReading(100, 90)] }, "above").triggered,
    true
  );
  assert.equal(
    evaluateCondition(srNear(both), { ...s, filterReadings: [rsiReading(61), maReading(100, 110)] }, "above").triggered,
    false, "MA gate shut"
  );
  assert.equal(
    evaluateCondition(srNear(both), { ...s, filterReadings: [rsiReading(43), maReading(100, 90)] }, "above").triggered,
    false, "RSI gate shut"
  );
});

test("a gate whose input has not resolved fails CLOSED", () => {
  // The runner passes undefined while RSI or the 200 EMA is still warming up.
  // "Only when the trend is up" must not fire because the trend is UNKNOWN.
  assert.equal(filtersPass(RSI_UP, { ...bar }), false);
  assert.equal(filtersPass(MA_UP, { ...bar }), false);
  assert.equal(filtersPass(RSI_UP, { ...bar, filterReadings: [NaN] }), false);
  assert.equal(
    filtersPass(RSI_UP, { ...bar, filterReadings: [] }), false,
    "a gate with no reading at its position is shut, not open"
  );
  const e = evaluateCondition(srNear(RSI_UP), { ...bar, refValue: 99.5 }, "above");
  assert.equal(e.triggered, false);
});

/**
 * The property that makes gates safe to combine with cross modes. If a shut
 * gate withheld the side as well as the notification, the next open bar would
 * compare against a stale side and report a cross that already happened.
 */
test("a shut gate suppresses the notification but not the recorded side", () => {
  const cross = {
    ...srNear(RSI_UP), mode: "cross_up" as const,
  };
  const shut = evaluateCondition(
    cross, { ...bar, close: 100, refValue: 99.5, filterReadings: [rsiReading(10)] }, "below"
  );
  assert.equal(shut.triggered, false, "gate is shut");
  assert.equal(shut.side, "above", "the side must still move with the market");
  assert.ok(Number.isFinite(shut.distancePct));
  assert.equal(shut.reference, 99.5);
});

test("a gate never turns an untriggered condition ON", () => {
  // Price far away from the zone: no level event, so an open gate changes
  // nothing. A gate can only ever subtract.
  const e = evaluateCondition(
    srNear(RSI_UP), { ...bar, close: 500, refValue: 99.5, filterReadings: [rsiReading(99)] }, "above"
  );
  assert.equal(e.triggered, false);
});

// ── request and storage ────────────────────────────────────────────────────

test("gates are opt-in: a request without them produces no filters", () => {
  const r = readCondition("sr_zone", { srSide: "support" });
  assert.ok("condition" in r);
  assert.equal((r.condition as { filters?: unknown }).filters, undefined);
});

test("the requested defaults are RSI 50 above 50 and price above the EMA 200", () => {
  const r = readCondition("sr_zone", { srSide: "support", filterRsi: true, filterMa: true });
  assert.ok("condition" in r);
  const f = (r.condition as { filters?: unknown }).filters;
  assert.deepEqual(f, [
    { kind: "rsi", length: 50, level: 50, side: "above" },
    { kind: "ma", type: "ema", length: 200, side: "above" },
  ]);
});

test("a gate that could never open is refused", () => {
  for (const [body, re] of [
    [{ filterRsi: true, filterRsiLevel: 100 }, /between 0 and 100/],
    [{ filterRsi: true, filterRsiLevel: 0 }, /between 0 and 100/],
    [{ filterRsi: true, filterRsiSide: "sideways" }, /above or below/],
    [{ filterMa: true, filterMaType: "hull" }, /sma or ema/],
    [{ filterMa: true, filterMaLength: 0 }, /integer 1\.\.1000/],
  ] as const) {
    const r = readCondition("sr_zone", { srSide: "support", ...body });
    assert.ok("error" in r, JSON.stringify(body));
    assert.match(r.error, re);
  }
});

test("gates survive the trip through columns and back", () => {
  for (const c of [
    srNear(RSI_UP),
    srNear(MA_UP),
    srNear(BOTH),
    srNear(),
  ]) {
    const cols = toColumns(c);
    const back = conditionFromRow({ ...cols, nearMinPct: c.nearMinPct, nearMaxPct: c.nearMaxPct });
    assert.deepEqual(
      (back as { filters?: unknown }).filters,
      (c as { filters?: unknown }).filters,
      describeFilters(c.filters) || "no gate"
    );
  }
});

test("a half-written gate row is read as no gate rather than guessed at", () => {
  const back = conditionFromRow({
    conditionKind: "sr_zone", srSide: "support", mode: "near_above",
    maType: null, maLength: null, ma2Type: null, ma2Length: null,
    targetPrice: null, priceDirection: null,
    nearMinPct: 0.2, nearMaxPct: 0.5,
    // A length with no side: not an evaluable rule.
    filterRsiLength: 50, filterRsiLevel: null, filterRsiSide: null,
  });
  assert.equal((back as { filters?: unknown }).filters, undefined);
});

test("a gate that cannot be satisfied fails validation", () => {
  assert.match(
    validateCondition(srNear([{ kind: "rsi", length: 50, level: 150, side: "above" }])) ?? "",
    /filterRsiLevel/
  );
  assert.equal(validateCondition(srNear(RSI_UP)), null);
});

test("the description says the gate is a precondition, not a trigger", () => {
  assert.equal(
    describeFilters(BOTH),
    " — only while RSI 50 is above 50 and price is above the EMA 200"
  );
  assert.equal(describeFilters(undefined), "");
});
