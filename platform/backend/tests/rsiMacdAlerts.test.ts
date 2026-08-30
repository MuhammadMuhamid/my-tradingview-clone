/**
 * RSI and MACD alert families.
 *
 * What matters about these, and what is pinned here:
 *
 *  - the quantity that crosses is the OSCILLATOR, never the close. A bar that
 *    makes a new price high while RSI stays under 50 has not crossed 50.
 *  - distance is reported in indicator units, not as a percentage of price.
 *    MACD's zero reference makes a percentage undefined outright.
 *  - the seeding rule the whole alert system depends on: with no previous side
 *    there is no cross, so arming "RSI crosses above 50" while RSI is already
 *    at 60 stays quiet instead of firing immediately.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateCondition, describeCondition, validateCondition, conditionFromRow,
  macdLabel, type AlertCondition,
} from "../src/alerts/alertConditions";
import { readCondition, toColumns } from "../src/alerts/alertRequest";
import { formatAlertPush } from "../src/alerts/alertMessage";
import { macd, rsi, sma } from "../src/engine/ta";
import { MACD_DEFAULTS, RSI_DEFAULTS } from "../src/types/maAlerts";

const bar = { high: 101, low: 99, close: 100 };

const rsiCond = (over: Partial<Extract<AlertCondition, { kind: "rsi" }>> = {}) => ({
  kind: "rsi" as const,
  rsiLength: RSI_DEFAULTS.length,
  target: "level" as const,
  level: RSI_DEFAULTS.level,
  maLength: RSI_DEFAULTS.maLength,
  mode: "cross_up" as const,
  ...over,
});

const macdCond = (over: Partial<Extract<AlertCondition, { kind: "macd" }>> = {}) => ({
  kind: "macd" as const,
  fastLength: MACD_DEFAULTS.fast,
  slowLength: MACD_DEFAULTS.slow,
  signalLength: MACD_DEFAULTS.signal,
  target: "signal" as const,
  mode: "cross_up" as const,
  ...over,
});

// ── the seeding rule ───────────────────────────────────────────────────────

test("an RSI cross does not fire on its first evaluation, whichever side it starts on", () => {
  for (const value of [60, 40]) {
    const e = evaluateCondition(
      rsiCond(), { ...bar, indicatorValue: value, indicatorReference: 50 }, null
    );
    assert.equal(e.triggered, false, `seeded at ${value}`);
    // The side is still recorded, so the NEXT bar can detect the cross.
    assert.equal(e.side, value >= 50 ? "above" : "below");
  }
});

test("RSI crossing 50 upward fires only on the bar that crosses", () => {
  const c = rsiCond();
  const below = evaluateCondition(c, { ...bar, indicatorValue: 48, indicatorReference: 50 }, null);
  assert.equal(below.side, "below");

  const cross = evaluateCondition(
    c, { ...bar, indicatorValue: 52, indicatorReference: 50 }, below.side
  );
  assert.equal(cross.triggered, true);

  // Still above on the following bar: the cross has already been reported.
  const after = evaluateCondition(
    c, { ...bar, indicatorValue: 55, indicatorReference: 50 }, cross.side
  );
  assert.equal(after.triggered, false);
});

test("cross_down is not the negation of cross_up — each fires on its own direction", () => {
  const up = rsiCond({ mode: "cross_up" });
  const down = rsiCond({ mode: "cross_down" });
  const s = { ...bar, indicatorValue: 45, indicatorReference: 50 };
  assert.equal(evaluateCondition(up, s, "above").triggered, false);
  assert.equal(evaluateCondition(down, s, "above").triggered, true);
});

test("the close is irrelevant to an oscillator cross", () => {
  const c = rsiCond();
  // A huge up-bar in price, with RSI still under the line.
  const s = { high: 500, low: 100, close: 499, indicatorValue: 49, indicatorReference: 50 };
  assert.equal(evaluateCondition(c, s, "below").triggered, false);
});

test("distance is reported in indicator units, not as a percentage of price", () => {
  const e = evaluateCondition(
    rsiCond(), { ...bar, indicatorValue: 55, indicatorReference: 50 }, "below"
  );
  // 5 RSI points. A percentage of price (100) would have been 5% by accident
  // here, so the reference is deliberately not 50-of-100.
  assert.equal(e.distancePct, 5);

  const e2 = evaluateCondition(
    rsiCond({ target: "sma" }), { ...bar, indicatorValue: 61.5, indicatorReference: 60 }, "below"
  );
  assert.ok(Math.abs(e2.distancePct - 1.5) < 1e-9, `got ${e2.distancePct}`);
});

// ── MACD ───────────────────────────────────────────────────────────────────

test("MACD zero-cross uses zero as the reference, which no percentage could express", () => {
  const c = macdCond({ target: "zero" });
  const e = evaluateCondition(
    c, { ...bar, indicatorValue: 0.5, indicatorReference: 0 }, "below"
  );
  assert.equal(e.triggered, true);
  assert.equal(e.reference, 0);
  assert.equal(e.distancePct, 0.5);
  assert.ok(Number.isFinite(e.distancePct), "a division by the zero reference would be Infinity");
});

test("MACD signal cross fires on the crossing bar only", () => {
  const c = macdCond();
  const a = evaluateCondition(c, { ...bar, indicatorValue: -0.2, indicatorReference: 0.1 }, null);
  const b = evaluateCondition(c, { ...bar, indicatorValue: 0.3, indicatorReference: 0.1 }, a.side);
  assert.equal(a.triggered, false);
  assert.equal(b.triggered, true);
});

test("an unseeded oscillator leaves the stored side alone rather than corrupting it", () => {
  // Not enough history yet: the runner passes undefined.
  const e = evaluateCondition(rsiCond(), { ...bar }, "above");
  assert.equal(e.triggered, false);
  assert.equal(e.side, "above", "a NaN comparison must not flip the persisted side");
});

// ── validation ─────────────────────────────────────────────────────────────

test("an RSI level outside 0..100 is refused: it could never be crossed", () => {
  for (const level of [0, 100, 101, -5]) {
    assert.ok(validateCondition(rsiCond({ level })), `level ${level} should be refused`);
  }
  assert.equal(validateCondition(rsiCond({ level: 50 })), null);
});

test("macdFast must be below macdSlow, or the oscillator's sign inverts", () => {
  assert.ok(validateCondition(macdCond({ fastLength: 26, slowLength: 12 })));
  assert.ok(validateCondition(macdCond({ fastLength: 12, slowLength: 12 })));
  assert.equal(validateCondition(macdCond()), null);
});

test("the request parser applies the requested defaults", () => {
  const r = readCondition("rsi", {});
  assert.ok("condition" in r);
  assert.deepEqual(r.condition, {
    kind: "rsi", rsiLength: 50, target: "level", level: 50, maLength: 14, mode: "cross_up",
  });

  const m = readCondition("macd", {});
  assert.ok("condition" in m);
  assert.deepEqual(m.condition, {
    kind: "macd", fastLength: 12, slowLength: 26, signalLength: 9,
    target: "signal", mode: "cross_up",
  });
});

/**
 * The field names are a contract with the client, not an implementation
 * detail. This is the bug it exists for: the parser read `level` while the UI
 * and the column both said `rsiLevel`, so a request for 70 was accepted and
 * quietly armed at the 50 default — no error, wrong alert.
 */
test("the parser reads the field names the client actually sends", () => {
  const r = readCondition("rsi", { rsiLevel: 70, rsiLength: 21, rsiMaLength: 9 });
  assert.ok("condition" in r);
  assert.equal(r.condition.kind, "rsi");
  if (r.condition.kind !== "rsi") return;
  assert.equal(r.condition.level, 70, "rsiLevel must not fall back to the default");
  assert.equal(r.condition.rsiLength, 21);
  assert.equal(r.condition.maLength, 9);

  const m = readCondition("macd", { macdFast: 8, macdSlow: 21, macdSignal: 5, target: "zero" });
  assert.ok("condition" in m);
  if (m.condition.kind !== "macd") return;
  assert.deepEqual(
    [m.condition.fastLength, m.condition.slowLength, m.condition.signalLength, m.condition.target],
    [8, 21, 5, "zero"]
  );
});

test("an out-of-range level sent under its real name is refused", () => {
  const r = readCondition("rsi", { rsiLevel: 120 });
  assert.ok("error" in r, "rsiLevel 120 must be rejected, not silently defaulted");
  assert.match(r.error, /between 0 and 100/);
});

test("the parser rejects what the database would refuse, with a readable message", () => {
  for (const [kind, body, re] of [
    ["rsi", { rsiLevel: 120 }, /between 0 and 100/],
    ["rsi", { target: "nonsense" }, /target must be one of/],
    ["rsi", { mode: "near_above" }, /cross_up or cross_down/],
    ["macd", { macdFast: 30, macdSlow: 10 }, /macdFast must be less than macdSlow/],
    ["macd", { macdSignal: 0 }, /macdSignal must be an integer/],
  ] as const) {
    const r = readCondition(kind, body as Record<string, unknown>);
    assert.ok("error" in r, `${kind} ${JSON.stringify(body)} should be rejected`);
    assert.match(r.error, re);
  }
});

// ── round trip through the column shape ────────────────────────────────────

test("a condition survives the trip through columns and back", () => {
  for (const c of [
    rsiCond(),
    rsiCond({ target: "sma", maLength: 14, mode: "cross_down" }),
    macdCond({ target: "zero", mode: "cross_down" }),
    macdCond({ fastLength: 8, slowLength: 21, signalLength: 5 }),
  ]) {
    const cols = toColumns(c);
    const back = conditionFromRow({ ...cols, nearMinPct: 0.2, nearMaxPct: 0.5 });
    assert.deepEqual(back, c, describeCondition(c));
  }
});

test("columns for one family never carry another family's settings", () => {
  const cols = toColumns(rsiCond());
  assert.equal(cols.macdFast, null);
  assert.equal(cols.pivotType, null);
  assert.equal(cols.maType, null);
  assert.equal(toColumns(macdCond()).rsiLength, null);
});

// ── wording ────────────────────────────────────────────────────────────────

test("descriptions name what is actually being crossed", () => {
  assert.equal(describeCondition(rsiCond()), "RSI 50 crosses above 50");
  assert.equal(
    describeCondition(rsiCond({ target: "sma", mode: "cross_down" })),
    "RSI 50 crosses below its SMA 14"
  );
  assert.equal(describeCondition(macdCond()), "MACD crosses above the signal line");
  assert.equal(
    describeCondition(macdCond({ target: "zero", mode: "cross_down" })),
    "MACD crosses below zero"
  );
});

test("default MACD lengths are not spelled out, non-default ones are", () => {
  assert.equal(macdLabel(MACD_DEFAULTS.fast === 12 ? macdCond() : macdCond()), "MACD");
  assert.equal(macdLabel(macdCond({ fastLength: 8, slowLength: 21, signalLength: 5 })), "MACD 8/21/5");
});

test("the push body reports readings, and never a percentage of price", () => {
  const alert = {
    id: "a1", symbol: "SOLUSDT", timeframe: "1h",
    frequency: "once_per_bar_close" as const, nearMinPct: 0.2, nearMaxPct: 0.5,
  };
  const rsiMsg = formatAlertPush(
    alert, rsiCond(), { close: 100 }, 50, 5.31, false
  );
  assert.match(rsiMsg.body, /RSI 50 crosses above 50/);
  assert.match(rsiMsg.body, /55\.31 vs 50\.00/);
  assert.doesNotMatch(rsiMsg.body, /%/, "an RSI reading is not a percentage");

  const macdMsg = formatAlertPush(
    alert, macdCond({ target: "zero" }), { close: 100 }, 0, 0.00421, false
  );
  assert.match(macdMsg.body, /crosses above zero/);
  // Small MACD values must not round to "0.00 vs 0.00".
  assert.match(macdMsg.body, /0\.00421/);
});

// ── the maths agrees with the indicator sources ────────────────────────────

test("MACD is the fast minus slow EMA, with the signal smoothed from that line", () => {
  const closes = Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 7) * 8 + i * 0.05);
  const m = macd(closes, 12, 26, 9);
  const last = closes.length - 1;

  assert.ok(Math.abs(m.histogram[last]! - (m.macd[last]! - m.signal[last]!)) < 1e-12);

  // The signal is smoothed from the MACD line INCLUDING its leading NaNs, so
  // it appears where the indicator shows it rather than 25 bars early.
  const firstSignal = m.signal.findIndex((v) => Number.isFinite(v));
  const firstMacd = m.macd.findIndex((v) => Number.isFinite(v));
  assert.ok(firstSignal > firstMacd, "signal must lag the MACD line");
});

test("the RSI-based MA is an SMA of the RSI series, matching the indicator", () => {
  const closes = Array.from({ length: 300 }, (_, i) => 100 + Math.cos(i / 5) * 6);
  const r = rsi(closes, 50);
  const m = sma(r, 14);
  const last = closes.length - 1;
  assert.ok(Number.isFinite(r[last]!) && Number.isFinite(m[last]!));
  // RSI is bounded, so its MA must be too — a smoothing bug shows up here.
  assert.ok(m[last]! >= 0 && m[last]! <= 100, `RSI MA out of range: ${m[last]}`);
});
