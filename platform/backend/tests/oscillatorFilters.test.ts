/**
 * Two gates that compare a line to another line: RSI against its own moving
 * average, and MACD against its signal.
 *
 * The request: "fire only when the 1h RSI 50 is above its EMA 14 AND the 4h
 * MACD is above its signal". Both are momentum questions rather than the level
 * questions the earlier gates ask, and both need two computed numbers rather
 * than one number and a constant.
 *
 * What is pinned here:
 *
 *  - the reading is the SPREAD, so the gate's answer is a sign;
 *  - the same question on two timeframes is two gates, and both must hold;
 *  - the cross-timeframe path agrees with the own-timeframe path;
 *  - a fast length at or above the slow one is refused rather than inverted;
 *  - a stored gate round-trips — a kind that failed to parse would be dropped,
 *    which would leave the alert firing UNGATED.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  filtersPass, parseStoredFilters, describeFilters, validateCondition,
  type AlertCondition, type AlertFilters,
} from "../src/alerts/alertConditions";
import { gateReading } from "../src/alerts/filterSeries";
import { readCondition, toColumns } from "../src/alerts/alertRequest";
import { ema, macd, rsi } from "../src/engine/ta";

const bar = { high: 101, low: 99, close: 100 };

const rsiMa = (over: Partial<Extract<AlertFilters[number], { kind: "rsi_ma" }>> = {}) => ({
  kind: "rsi_ma" as const, timeframe: null, length: 50,
  maType: "ema" as const, maLength: 14, side: "above" as const, ...over,
});
const macdGate = (over: Partial<Extract<AlertFilters[number], { kind: "macd" }>> = {}) => ({
  kind: "macd" as const, timeframe: null, fastLength: 12, slowLength: 26,
  signalLength: 9, target: "signal" as const, side: "above" as const, ...over,
});

// ── the reading is a spread ────────────────────────────────────────────────

test("the gate reads a spread, so its sign is the whole answer", () => {
  // +1.4 means the RSI sits 1.4 points above its average.
  assert.equal(filtersPass([rsiMa()], { ...bar, filterReadings: [1.4] }), true);
  assert.equal(filtersPass([rsiMa()], { ...bar, filterReadings: [-1.4] }), false);
  assert.equal(
    filtersPass([rsiMa({ side: "below" })], { ...bar, filterReadings: [-1.4] }), true
  );

  assert.equal(filtersPass([macdGate()], { ...bar, filterReadings: [12.5] }), true);
  assert.equal(filtersPass([macdGate()], { ...bar, filterReadings: [-12.5] }), false);
});

test("an exact touch is not 'above' — the gate needs a strict side", () => {
  assert.equal(filtersPass([rsiMa()], { ...bar, filterReadings: [0] }), false);
  assert.equal(
    filtersPass([rsiMa({ side: "below" })], { ...bar, filterReadings: [0] }), false
  );
});

test("an unresolved gate fails closed, as every other gate does", () => {
  assert.equal(filtersPass([macdGate()], { ...bar, filterReadings: [undefined] }), false);
  assert.equal(filtersPass([rsiMa()], { ...bar, filterReadings: [NaN] }), false);
});

// ── the same question on two timeframes ────────────────────────────────────

test("the same gate on 1h and 4h is two gates, and both must hold", () => {
  const read = readCondition("sr_zone", {
    srSide: "support",
    filters: [
      { kind: "rsi_ma", timeframe: "1h", length: 50, maType: "ema", maLength: 14 },
      { kind: "rsi_ma", timeframe: "4h", length: 50, maType: "ema", maLength: 21 },
      { kind: "macd", timeframe: "1h" },
      { kind: "macd", timeframe: "4h" },
    ],
  });
  assert.ok("condition" in read, "four gates, two kinds, two timeframes each");
  const filters = read.condition.filters!;
  assert.equal(filters.length, 4);

  assert.equal(
    filtersPass(filters, { ...bar, filterReadings: [1, 1, 1, 1] }), true,
    "all four open"
  );
  assert.equal(
    filtersPass(filters, { ...bar, filterReadings: [1, 1, 1, -1] }), false,
    "the 4h MACD alone shuts it — gates are ANDed"
  );
});

test("two gates differing only by timeframe are not duplicates", () => {
  /*
   * The duplicate rule lives in `validateCondition`, which is the second half
   * of the route's pipeline — `readCondition` parses a request, the validator
   * judges the condition it produced. Both run before anything is stored.
   */
  const of = (filters: unknown[]): AlertCondition => {
    const read = readCondition("sr_zone", { srSide: "support", filters });
    assert.ok("condition" in read);
    return read.condition;
  };

  assert.equal(
    validateCondition(of([
      { kind: "macd", timeframe: "1h" }, { kind: "macd", timeframe: "4h" },
    ])),
    null, "the same question on two timeframes is the point of the feature"
  );
  assert.match(
    validateCondition(of([
      { kind: "macd", timeframe: "1h" }, { kind: "macd", timeframe: "1h" },
    ])) ?? "",
    /identical/, "the same question twice is a mistake, not a stricter rule"
  );
  assert.match(
    validateCondition(of([
      { kind: "rsi_ma", timeframe: "1h" }, { kind: "rsi_ma", timeframe: "1h" },
    ])) ?? "",
    /identical/
  );
});

// ── the cross-timeframe path agrees with the direct computation ────────────

const HOUR = 3_600_000;
/** A rising-then-falling series, long enough for a 26/9 MACD to warm up. */
const bars = (n: number) =>
  Array.from({ length: n }, (_, i) => {
    const close = 100 + Math.sin(i / 9) * 12 + i * 0.15;
    return { high: close + 1, low: close - 1, close, closeTime: (i + 1) * HOUR };
  });

test("a higher-timeframe RSI-vs-EMA reading is the spread of the same two series", () => {
  const window = bars(300);
  const closes = window.map((b) => b.close);
  const series = rsi(closes, 50);
  const avg = ema(series, 14);
  const expected = series[series.length - 1]! - avg[avg.length - 1]!;

  const got = gateReading(window, window[window.length - 1]!.closeTime, rsiMa());
  assert.ok(got !== undefined);
  assert.ok(Math.abs(got - expected) < 1e-9, `${got} vs ${expected}`);
});

test("a higher-timeframe MACD reading is the line minus its signal", () => {
  const window = bars(300);
  const m = macd(window.map((b) => b.close), 12, 26, 9);
  const expected = m.macd[m.macd.length - 1]! - m.signal[m.signal.length - 1]!;

  const got = gateReading(window, window[window.length - 1]!.closeTime, macdGate());
  assert.ok(got !== undefined);
  assert.ok(Math.abs(got - expected) < 1e-9, `${got} vs ${expected}`);
});

test("target 'zero' compares the MACD line to the centreline, not the signal", () => {
  const window = bars(300);
  const m = macd(window.map((b) => b.close), 12, 26, 9);
  const line = m.macd[m.macd.length - 1]!;

  const got = gateReading(
    window, window[window.length - 1]!.closeTime, macdGate({ target: "zero" })
  );
  assert.ok(got !== undefined && Math.abs(got - line) < 1e-9);
});

test("a gate whose indicator has not warmed up reads undefined, not zero", () => {
  // Ten bars cannot produce a 26-period MACD, let alone its 9-period signal.
  const window = bars(10);
  assert.equal(gateReading(window, window[9]!.closeTime, macdGate()), undefined);
  assert.equal(gateReading(window, window[9]!.closeTime, rsiMa()), undefined);
});

test("the gate never reads a bar that has not closed", () => {
  const window = bars(300);
  const atBar200 = gateReading(window, window[199]!.closeTime, macdGate());
  const m = macd(window.slice(0, 200).map((b) => b.close), 12, 26, 9);
  const expected = m.macd[199]! - m.signal[199]!;
  assert.ok(atBar200 !== undefined && Math.abs(atBar200 - expected) < 1e-9,
    "evaluating at bar 200 uses bars 1..200 and nothing after");
});

// ── the rules ──────────────────────────────────────────────────────────────

test("a MACD fast length at or above its slow length is refused", () => {
  for (const [fast, slow] of [[26, 26], [30, 26]] as const) {
    assert.ok("error" in readCondition("sr_zone", {
      srSide: "support",
      filters: [{ kind: "macd", fastLength: fast, slowLength: slow }],
    }), `${fast}/${slow} inverts the line, so "above the signal" would mean its opposite`);
  }
  assert.ok("condition" in readCondition("sr_zone", {
    srSide: "support",
    filters: [{ kind: "macd", fastLength: 14, slowLength: 21, signalLength: 7 }],
  }), "the 14/21/7 pair from the request is accepted");
});

test("neither gate accepts 'either' — both ask which side of a line", () => {
  for (const kind of ["rsi_ma", "macd"] as const) {
    assert.ok("error" in readCondition("sr_zone", {
      srSide: "support", filters: [{ kind, side: "either" }],
    }), `"${kind} is either above" is not a rule`);
  }
});

test("an RSI average type other than sma or ema is refused", () => {
  assert.ok("error" in readCondition("sr_zone", {
    srSide: "support", filters: [{ kind: "rsi_ma", maType: "hma" }],
  }));
});

test("the validator agrees with the request reader", () => {
  const condition = {
    kind: "sr_zone", srSide: "support", mode: "cross_up",
    nearMinPct: 0, nearMaxPct: 1,
    filters: [macdGate({ fastLength: 26, slowLength: 26 })],
  } as unknown as AlertCondition;
  assert.ok(validateCondition(condition), "a stored row is held to the same rule");
});

// ── storage ────────────────────────────────────────────────────────────────

test("both gates survive the trip through columns and back", () => {
  const read = readCondition("sr_zone", {
    srSide: "support",
    filters: [
      { kind: "rsi_ma", timeframe: "1h", length: 50, maType: "ema", maLength: 21 },
      { kind: "macd", timeframe: "4h", fastLength: 14, slowLength: 21, signalLength: 7 },
    ],
  });
  assert.ok("condition" in read);
  const back = parseStoredFilters(toColumns(read.condition).filters);
  assert.deepEqual(back, read.condition.filters,
    "a kind parseStoredFilters did not know would be DROPPED, and the alert "
    + "would then fire with no gate at all"
  );
});

test("a stored gate missing a required field is dropped, not defaulted", () => {
  assert.deepEqual(
    parseStoredFilters([{ kind: "macd", side: "above", fastLength: 12 }]), [],
    "a half-written gate must not become a gate with invented lengths"
  );
  assert.deepEqual(
    parseStoredFilters([{ kind: "rsi_ma", side: "above", length: 50, maLength: 14 }]), [],
    "no maType means no gate"
  );
});

// ── what the user reads ────────────────────────────────────────────────────

test("the description names the average and the timeframe", () => {
  assert.equal(
    describeFilters([rsiMa({ timeframe: "1h", maLength: 21 })]),
    " — only while 1h RSI 50 is above its EMA 21"
  );
  assert.equal(
    describeFilters([macdGate({ timeframe: "4h", fastLength: 14, slowLength: 21, signalLength: 7 })]),
    " — only while 4h MACD is above its signal line (14/21/7)"
  );
  assert.equal(
    describeFilters([macdGate({ target: "zero" })]),
    " — only while MACD is above zero"
  );
});
