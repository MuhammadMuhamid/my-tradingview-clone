/**
 * Alert conditions: price targets, moving averages, and MA-versus-MA.
 *
 * The MA family's semantics are unchanged — `tests/maEvaluator.test.ts` still
 * pins the original implementation, and these assert the general evaluator
 * agrees with it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describeCondition, evaluateCondition, requiredSeries, validateCondition,
  type AlertCondition, type Sample, type Side,
} from "../src/alerts/alertConditions";
import { evaluateMaAlert } from "../src/alerts/maEvaluator";

const bar = (high: number, low: number, close: number): Sample => ({ high, low, close });
const withMa = (s: Sample, maValue: number, ma2Value?: number): Sample =>
  ({ ...s, maValue, ...(ma2Value !== undefined ? { ma2Value } : {}) });

// ── Price: cross above ──────────────────────────────────────────────────────

const crossUp: AlertCondition = { kind: "price", targetPrice: 100, direction: "cross_up" };

test("price cross_up needs a previous close BELOW the target", () => {
  assert.equal(evaluateCondition(crossUp, bar(103, 99, 102), "below").triggered, true);
  assert.equal(evaluateCondition(crossUp, bar(103, 99, 102), "above").triggered, false);
});

test("arming a cross while price is ALREADY past the target does not fire", () => {
  // The single most common way an alert system loses trust: "notify me when it
  // crosses 100" while price is at 105 must not fire immediately.
  const seed = evaluateCondition(crossUp, bar(106, 104, 105), null);
  assert.equal(seed.triggered, false);
  assert.equal(seed.side, "above", "the side is seeded so the NEXT cross is detectable");
});

test("a wick through the target that closes back does not cross", () => {
  // High 101 pierces 100, but the close is 99.5 — still below.
  const r = evaluateCondition(crossUp, bar(101, 98, 99.5), "below");
  assert.equal(r.triggered, false);
  assert.equal(r.side, "below");
});

test("closing exactly ON the target is not a cross above", () => {
  // `side` is `above` at equality, but `close > reference` is required to fire,
  // so the alert waits for a real breach rather than firing on a touch.
  const r = evaluateCondition(crossUp, bar(101, 99, 100), "below");
  assert.equal(r.side, "above");
  assert.equal(r.triggered, false);
});

// ── Price: cross below ──────────────────────────────────────────────────────

const crossDown: AlertCondition = { kind: "price", targetPrice: 100, direction: "cross_down" };

test("price cross_down mirrors cross_up", () => {
  assert.equal(evaluateCondition(crossDown, bar(101, 97, 98), "above").triggered, true);
  assert.equal(evaluateCondition(crossDown, bar(101, 97, 98), "below").triggered, false);
  assert.equal(evaluateCondition(crossDown, bar(101, 97, 98), null).triggered, false);
  assert.equal(evaluateCondition(crossDown, bar(101, 99, 100), "above").triggered, false);
});

// ── Price: either direction ─────────────────────────────────────────────────

const either: AlertCondition = { kind: "price", targetPrice: 100, direction: "either" };

test("`either` fires when the bar's RANGE reaches the target, from either side", () => {
  // A user dragging a line to 100 wants to know when price got there.
  assert.equal(evaluateCondition(either, bar(100.4, 99.6, 99.8), null).triggered, true);
  assert.equal(evaluateCondition(either, bar(100.4, 99.6, 100.2), null).triggered, true);
  // A spike that reaches the target and closes back still counts as reached.
  assert.equal(evaluateCondition(either, bar(100.4, 98, 98.2), null).triggered, true);
});

test("`either` needs no previous side — it is not a cross", () => {
  for (const prev of [null, "above", "below"] as (Side | null)[]) {
    assert.equal(evaluateCondition(either, bar(101, 99, 100), prev).triggered, true, String(prev));
  }
});

test("`either` does not fire when the bar never reaches the target", () => {
  assert.equal(evaluateCondition(either, bar(99.9, 98, 99), null).triggered, false);
  assert.equal(evaluateCondition(either, bar(103, 100.1, 102), null).triggered, false);
});

test("the target's exact edges count as reached", () => {
  assert.equal(evaluateCondition(either, bar(100, 98, 99), null).triggered, true);
  assert.equal(evaluateCondition(either, bar(103, 100, 101), null).triggered, true);
});

// ── Moving averages: identical to the original evaluator ───────────────────

test("the MA modes agree with the original evaluator, case for case", () => {
  const cases: {
    mode: "touch" | "cross_up" | "cross_down" | "near_above" | "near_below";
    sample: Sample; prev: Side | null;
  }[] = [
    { mode: "touch", sample: bar(102, 98, 101), prev: null },
    { mode: "touch", sample: bar(105, 101, 104), prev: null },
    { mode: "cross_up", sample: bar(103, 99, 102), prev: "below" },
    { mode: "cross_up", sample: bar(103, 99, 102), prev: null },
    { mode: "cross_up", sample: bar(103, 99, 102), prev: "above" },
    { mode: "cross_down", sample: bar(101, 97, 98), prev: "above" },
    { mode: "cross_down", sample: bar(101, 97, 98), prev: "below" },
    { mode: "near_above", sample: bar(100.4, 100.2, 100.3), prev: null },
    { mode: "near_above", sample: bar(100.2, 100.0, 100.1), prev: null },
    { mode: "near_above", sample: bar(100.9, 100.7, 100.8), prev: null },
    { mode: "near_below", sample: bar(99.8, 99.6, 99.7), prev: null },
  ];
  for (const { mode, sample, prev } of cases) {
    const original = evaluateMaAlert(
      { mode, nearMinPct: 0.2, nearMaxPct: 0.5 }, sample, 100, prev
    );
    const general = evaluateCondition(
      { kind: "ma", maType: "sma", maLength: 15, mode, nearMinPct: 0.2, nearMaxPct: 0.5 },
      withMa(sample, 100),
      prev
    );
    assert.equal(general.triggered, original.triggered, `${mode} triggered`);
    assert.equal(general.side, original.side, `${mode} side`);
    assert.ok(Math.abs(general.distancePct - original.distancePct) < 1e-9, `${mode} distance`);
  }
});

test("an MA with too little history does not fire and does not corrupt the stored side", () => {
  const condition: AlertCondition = {
    kind: "ma", maType: "ema", maLength: 200, mode: "cross_up", nearMinPct: 0.2, nearMaxPct: 0.5,
  };
  const r = evaluateCondition(condition, bar(101, 99, 100), "below");
  assert.equal(r.triggered, false);
  assert.equal(r.side, "below", "the previous side must survive a NaN reference");
  assert.equal(Number.isNaN(r.reference), true);
});

// ── MA versus MA ────────────────────────────────────────────────────────────

const goldenCross: AlertCondition = {
  kind: "ma_vs_ma", maType: "ema", maLength: 50, ma2Type: "sma", ma2Length: 200, mode: "cross_up",
};

test("MA-vs-MA compares the two LINES, not the close", () => {
  // Fast 101 over slow 100 with the fast previously below: a cross.
  const r = evaluateCondition(goldenCross, withMa(bar(200, 1, 150), 101, 100), "below");
  assert.equal(r.triggered, true);
  assert.equal(r.side, "above");
  assert.equal(r.reference, 100);
  // The close is 150, far from either line, and is irrelevant to the verdict.
});

test("MA-vs-MA needs a previous side, like any cross", () => {
  assert.equal(evaluateCondition(goldenCross, withMa(bar(1, 1, 1), 101, 100), null).triggered, false);
  assert.equal(evaluateCondition(goldenCross, withMa(bar(1, 1, 1), 101, 100), "above").triggered, false);
});

test("a death cross is the mirror", () => {
  const death: AlertCondition = { ...goldenCross, mode: "cross_down" } as AlertCondition;
  assert.equal(evaluateCondition(death, withMa(bar(1, 1, 1), 99, 100), "above").triggered, true);
  assert.equal(evaluateCondition(death, withMa(bar(1, 1, 1), 99, 100), "below").triggered, false);
});

test("either line missing means no verdict and no state change", () => {
  assert.equal(evaluateCondition(goldenCross, withMa(bar(1, 1, 1), 101), "below").triggered, false);
  assert.equal(
    evaluateCondition(goldenCross, { high: 1, low: 1, close: 1, ma2Value: 100 }, "below").triggered,
    false
  );
});

// ── Series requirements ─────────────────────────────────────────────────────

test("a price alert needs no MA computed at all", () => {
  assert.deepEqual(requiredSeries(crossUp), []);
});

test("an MA alert needs one series; MA-vs-MA needs two", () => {
  assert.deepEqual(
    requiredSeries({ kind: "ma", maType: "sma", maLength: 200, mode: "touch", nearMinPct: 0, nearMaxPct: 1 }),
    [{ type: "sma", length: 200 }]
  );
  assert.deepEqual(requiredSeries(goldenCross), [
    { type: "ema", length: 50 },
    { type: "sma", length: 200 },
  ]);
});

// ── Validation ──────────────────────────────────────────────────────────────

test("a price target must be a positive number", () => {
  for (const targetPrice of [0, -1, NaN, Infinity]) {
    assert.ok(validateCondition({ kind: "price", targetPrice, direction: "either" }));
  }
  assert.equal(validateCondition({ kind: "price", targetPrice: 0.00001234, direction: "either" }), null);
});

test("an MA length is bounded, and a near band must be ordered", () => {
  const base = { kind: "ma", maType: "sma", mode: "near_above", nearMinPct: 0.2, nearMaxPct: 0.5 } as const;
  assert.ok(validateCondition({ ...base, maLength: 0 }));
  assert.ok(validateCondition({ ...base, maLength: 1001 }));
  assert.ok(validateCondition({ ...base, maLength: 15.5 }));
  assert.equal(validateCondition({ ...base, maLength: 15 }), null);
  assert.ok(validateCondition({ ...base, maLength: 15, nearMinPct: 0.5, nearMaxPct: 0.2 }));
  assert.ok(validateCondition({ ...base, maLength: 15, nearMinPct: -1 }));
  // The band is only meaningful for the near modes, so a touch alert is fine
  // with a degenerate one.
  assert.equal(
    validateCondition({ ...base, mode: "touch", maLength: 15, nearMinPct: 5, nearMaxPct: 1 }),
    null
  );
});

test("two identical moving averages are refused — they can never cross", () => {
  const err = validateCondition({
    kind: "ma_vs_ma", maType: "sma", maLength: 50, ma2Type: "sma", ma2Length: 50, mode: "cross_up",
  });
  assert.match(err ?? "", /can never be met/);
  // Same length, different type, is a legitimate pair.
  assert.equal(
    validateCondition({
      kind: "ma_vs_ma", maType: "ema", maLength: 50, ma2Type: "sma", ma2Length: 50, mode: "cross_up",
    }),
    null
  );
});

// ── Description ─────────────────────────────────────────────────────────────

test("every condition describes itself in the words the notification uses", () => {
  assert.equal(describeCondition(crossUp), "crosses above 100");
  assert.equal(describeCondition(crossDown), "crosses below 100");
  assert.equal(describeCondition(either), "reaches 100");
  assert.equal(
    describeCondition({ kind: "ma", maType: "ema", maLength: 200, mode: "touch", nearMinPct: 0, nearMaxPct: 1 }),
    "touches the EMA 200"
  );
  assert.equal(
    describeCondition({ kind: "ma", maType: "sma", maLength: 15, mode: "near_below", nearMinPct: 0.2, nearMaxPct: 0.5 }),
    "is 0.2–0.5% below the SMA 15"
  );
  assert.equal(describeCondition(goldenCross), "EMA 50 crosses above the SMA 200");
});
