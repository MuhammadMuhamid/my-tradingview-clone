/**
 * The gates that compare a line to another line, and the gates that name a
 * timeframe of their own.
 *
 * These are the capabilities the fixed three-slot shape could not express:
 *
 *  - RSI against a moving average OF THE RSI, rather than a fixed level;
 *  - the MACD against its signal, as the STATE a crossover leaves behind;
 *  - more than one gate of the same kind;
 *  - a gate measured on a timeframe other than the alert's own.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  filtersPass, describeFilters, describeGate, validateCondition,
  parseStoredFilters, conditionFromRow,
  type AlertFilters,
} from "../src/alerts/alertConditions";
import { readCondition } from "../src/alerts/alertRequest";
import { mergeConditionRequest } from "../src/alerts/alertEdit";
import { MAX_ALERT_FILTERS, type MaAlertRow } from "../src/types/maAlerts";

/** A minimal sr_zone row; the gate columns are set per test. */
const BASE_ROW = {
  id: "00000000-0000-4000-8000-000000000000",
  symbol: "BTCUSDT", timeframe: "1h", conditionKind: "sr_zone",
  srSide: "support", srPivotLength: 5, srInvalidation: "close",
  mode: "near_above", nearMinPct: 0.2, nearMaxPct: 0.5,
  filters: null,
  filterRsiLength: null, filterRsiLevel: null, filterRsiSide: null,
  filterMaType: null, filterMaLength: null, filterMaSide: null,
  filterStPeriod: null, filterStMultiplier: null,
  filterStAtrMethod: null, filterStSide: null,
};

const bar = { high: 101, low: 99, close: 100 };

const srNear = (filters?: AlertFilters) => ({
  kind: "sr_zone" as const,
  srSide: "support" as const,
  mode: "near_above" as const,
  nearMinPct: 0.2,
  nearMaxPct: 0.5,
  pivotLength: 5,
  invalidation: "close" as const,
  ...(filters ? { filters } : {}),
});

// ── the reading is a spread, and the sign is the whole test ────────────────

test("an RSI-vs-its-own-MA gate opens on the spread, not on a level", () => {
  const gate: AlertFilters = [
    { kind: "rsi_ma", length: 50, maType: "ema", maLength: 14, side: "above" },
  ];
  // RSI 44 is below 50, and this gate does not care: it is above its own EMA.
  assert.equal(filtersPass(gate, { ...bar, filterReadings: [44 - 41] }), true);
  assert.equal(filtersPass(gate, { ...bar, filterReadings: [44 - 47] }), false);
  // Exactly equal is not "above".
  assert.equal(filtersPass(gate, { ...bar, filterReadings: [0] }), false);
});

test("a MACD gate is the STATE a crossover left behind", () => {
  const bullish: AlertFilters = [
    { kind: "macd", fastLength: 12, slowLength: 26, signalLength: 9, target: "signal", side: "above" },
  ];
  // Still above the signal many bars after the cross: the gate is open. A gate
  // keyed on the CROSS would have been true for one bar and shut ever since.
  assert.equal(filtersPass(bullish, { ...bar, filterReadings: [12.5] }), true);
  assert.equal(filtersPass(bullish, { ...bar, filterReadings: [-0.01] }), false);
});

test("every gate fails CLOSED when its input has not resolved", () => {
  for (const gate of [
    [{ kind: "rsi_ma" as const, length: 50, maType: "ema" as const, maLength: 14, side: "above" as const }],
    [{ kind: "macd" as const, fastLength: 12, slowLength: 26, signalLength: 9, target: "signal" as const, side: "above" as const }],
  ]) {
    assert.equal(filtersPass(gate, { ...bar }), false, "no readings at all");
    assert.equal(filtersPass(gate, { ...bar, filterReadings: [undefined] }), false);
    assert.equal(filtersPass(gate, { ...bar, filterReadings: [NaN] }), false);
  }
});

// ── a fast length at or above the slow one inverts the line ────────────────

test("an inverted MACD gate is refused, not normalised", () => {
  const inverted: AlertFilters = [
    { kind: "macd", fastLength: 26, slowLength: 26, signalLength: 9, target: "signal", side: "above" },
  ];
  assert.match(validateCondition(srNear(inverted)) ?? "", /shorter than/);
  // And the stored reader refuses it too, so it cannot arrive from the database
  // having bypassed validation.
  assert.equal(parseStoredFilters([{ ...inverted[0] }]), null);
});

// ── the sides are named for the mood they describe ─────────────────────────

test("against the signal the MACD gate says bullish and bearish", () => {
  assert.equal(
    describeGate({
      kind: "macd", fastLength: 12, slowLength: 26, signalLength: 9,
      target: "signal", side: "above",
    }),
    "MACD 12/26/9 is bullish (above signal)"
  );
  assert.equal(
    describeGate({
      kind: "macd", fastLength: 12, slowLength: 26, signalLength: 9,
      target: "signal", side: "below",
    }),
    "MACD 12/26/9 is bearish (below signal)"
  );
});

test("against ZERO it keeps above and below, because the mood words would lie", () => {
  // The centreline says which way the trend leans, not whether momentum turned.
  assert.equal(
    describeGate({
      kind: "macd", fastLength: 12, slowLength: 26, signalLength: 9,
      target: "zero", side: "above",
    }),
    "MACD 12/26/9 is above zero"
  );
});

// ── more than one gate of a kind, on more than one timeframe ───────────────

test("the same kind twice on two timeframes is two gates, not a contradiction", () => {
  // "15m support, but only while the 1h MACD is bearish AND the 4h is bullish".
  // Opposite sides on two timeframes is a normal request — a trader buying a
  // pullback inside an uptrend — and must not be read as self-cancelling.
  const gates: AlertFilters = [
    { kind: "macd", timeframe: "1h", fastLength: 12, slowLength: 26, signalLength: 9, target: "signal", side: "below" },
    { kind: "macd", timeframe: "4h", fastLength: 12, slowLength: 26, signalLength: 9, target: "signal", side: "above" },
  ];
  assert.equal(validateCondition(srNear(gates)), null, "both gates are valid");
  assert.equal(filtersPass(gates, { ...bar, filterReadings: [-3, 5] }), true);
  assert.equal(filtersPass(gates, { ...bar, filterReadings: [3, 5] }), false, "1h not bearish");
  assert.equal(filtersPass(gates, { ...bar, filterReadings: [-3, -5] }), false, "4h not bullish");

  assert.equal(
    describeFilters(gates),
    " — only while the 1h MACD 12/26/9 is bearish (below signal)" +
    " and the 4h MACD 12/26/9 is bullish (above signal)"
  );
});

test("one RSI question on two timeframes costs two slots and reads as two", () => {
  const gates: AlertFilters = [
    { kind: "rsi_ma", timeframe: "1h", length: 50, maType: "ema", maLength: 14, side: "above" },
    { kind: "rsi_ma", timeframe: "4h", length: 50, maType: "ema", maLength: 21, side: "above" },
  ];
  assert.equal(
    describeFilters(gates),
    " — only while the 1h RSI 50 is above its EMA 14" +
    " and the 4h RSI 50 is above its EMA 21"
  );
  assert.equal(filtersPass(gates, { ...bar, filterReadings: [1, 1] }), true);
  assert.equal(filtersPass(gates, { ...bar, filterReadings: [1, -1] }), false);
});

test("a gate on an unreachable timeframe is SHUT, never waved through", () => {
  // The runner leaves a timeframe it could not fetch out of `gateFeeds`, which
  // reaches the evaluator as an unresolved reading.
  const gates: AlertFilters = [
    { kind: "rsi", timeframe: "4h", length: 50, level: 50, side: "above" },
  ];
  assert.equal(filtersPass(gates, { ...bar, filterReadings: [undefined] }), false);
});

// ── the cap ───────────────────────────────────────────────────────────────

test("the cap bounds the list at both the validator and the reader", () => {
  const one = { kind: "rsi" as const, length: 50, level: 50, side: "above" as const };
  const atCap = Array.from({ length: MAX_ALERT_FILTERS }, () => ({ ...one }));
  assert.equal(validateCondition(srNear(atCap)), null, `${MAX_ALERT_FILTERS} gates is allowed`);
  assert.ok(parseStoredFilters(atCap), "the reader accepts a list at the cap");

  const overCap = [...atCap, { ...one }];
  assert.match(validateCondition(srNear(overCap)) ?? "", /at most 10 gates/);
  assert.equal(parseStoredFilters(overCap), null, "the reader refuses one over");
});

// ── the reader refuses rather than drops ──────────────────────────────────

test("an unrecognised gate kind makes the alert UNEVALUABLE, not ungated", () => {
  // This is the whole reason the reader refuses the list rather than skipping
  // the entry: a row written by a newer deploy must not come back as an alert
  // with no precondition that fires freely while still displaying a filter.
  const fromTheFuture = [{ kind: "ichimoku", side: "above", spanLength: 52 }];
  assert.equal(parseStoredFilters(fromTheFuture), null);

  const row = {
    conditionKind: "sr_zone" as const, srSide: "support" as const, mode: "near_above" as const,
    maType: null, maLength: null, ma2Type: null, ma2Length: null,
    targetPrice: null, priceDirection: null,
    nearMinPct: 0.2, nearMaxPct: 0.5,
    filters: fromTheFuture,
  };
  assert.equal(conditionFromRow(row), null, "the runner must skip this row, not fire it");
});

test("a gate naming a timeframe this build cannot measure is refused", () => {
  assert.equal(
    parseStoredFilters([{ kind: "rsi", length: 50, level: 50, side: "above", timeframe: "7h" }]),
    null
  );
});

test("a malformed gate does not quietly become a smaller list", () => {
  const good = { kind: "rsi" as const, length: 50, level: 50, side: "above" as const };
  // One valid gate and one missing its side: refusing only the bad one would
  // leave an alert gated on half of what it says it is gated on.
  assert.equal(parseStoredFilters([good, { kind: "rsi", length: 14, level: 30 }]), null);
});

// ── the API accepts the list form, through the same reader ────────────────

test("the list form arrives through the API and keeps its timeframes", () => {
  const r = readCondition("sr_zone", {
    srSide: "support",
    filters: [
      { kind: "rsi_ma", timeframe: "1h", length: 50, maType: "ema", maLength: 14, side: "above" },
      { kind: "macd", timeframe: "4h", fastLength: 12, slowLength: 26, signalLength: 9, target: "signal", side: "below" },
    ],
  });
  assert.ok("condition" in r, JSON.stringify(r));
  assert.deepEqual(r.condition.filters, [
    { side: "above", timeframe: "1h", kind: "rsi_ma", length: 50, maType: "ema", maLength: 14 },
    { side: "below", timeframe: "4h", kind: "macd", fastLength: 12, slowLength: 26, signalLength: 9, target: "signal" },
  ]);
});

test("the API refuses a gate the database would refuse to read back", () => {
  // The API and the stored form go through the SAME reader, so a gate that
  // could be created and then never read is not expressible.
  const r = readCondition("sr_zone", {
    srSide: "support",
    filters: [{ kind: "rsi_ma", length: 50, maType: "hull", maLength: 14, side: "above" }],
  });
  assert.ok("error" in r);
  assert.match(r.error, /cannot read/);
});

test("the legacy flat fields still create the gates they always did", () => {
  const r = readCondition("sr_zone", {
    srSide: "support", filterRsi: true, filterMa: true,
  });
  assert.ok("condition" in r);
  assert.deepEqual(r.condition.filters, [
    { kind: "rsi", length: 50, level: 50, side: "above" },
    { kind: "ma", type: "ema", length: 200, side: "above" },
  ]);
});

// ── editing the list ──────────────────────────────────────────────────────

test("sending the list REPLACES the gates, and takes the legacy ones with it", () => {
  // A row whose gates live in the legacy columns, edited with a list. If the
  // old single-gate description survived the merge, the alert would keep gates
  // the dialog no longer shows.
  const row = {
    ...BASE_ROW,
    filterRsiLength: 21, filterRsiLevel: 55, filterRsiSide: "above",
    filterMaType: "ema", filterMaLength: 200, filterMaSide: "above",
  } as unknown as MaAlertRow;

  const merged = mergeConditionRequest(row, {
    filters: [
      { kind: "macd", timeframe: "4h", fastLength: 12, slowLength: 26, signalLength: 9, target: "signal", side: "above" },
    ],
  })!;
  assert.ok(merged, "the edit was accepted");
  assert.deepEqual(
    (merged.filters as unknown[]).length, 1,
    "the list is exactly what was sent"
  );
  for (const key of [
    "filterRsi", "filterRsiLength", "filterRsiLevel", "filterRsiSide",
    "filterMa", "filterMaType", "filterMaLength", "filterMaSide",
  ]) {
    assert.equal(merged[key], undefined, `${key} survived a list edit`);
  }
});

test("an empty list removes every gate", () => {
  const row = {
    ...BASE_ROW,
    filterRsiLength: 21, filterRsiLevel: 55, filterRsiSide: "above",
  } as unknown as MaAlertRow;

  const merged = mergeConditionRequest(row, { filters: [] })!;
  const read = readCondition("sr_zone", merged);
  assert.ok("condition" in read, JSON.stringify(read));
  assert.equal(
    read.condition.filters, undefined,
    "an alert edited to no gates must come back ungated"
  );
});

test("a row already on the list form keeps it across an unrelated edit", () => {
  const gates = [
    { kind: "rsi_ma", timeframe: "1h", length: 50, maType: "ema", maLength: 14, side: "above" },
  ];
  const row = { ...BASE_ROW, filters: gates } as unknown as MaAlertRow;
  const merged = mergeConditionRequest(row, { nearMaxPct: 0.9 })!;
  assert.deepEqual(
    merged.filters, gates,
    "editing something else must not drop the gates"
  );
});
