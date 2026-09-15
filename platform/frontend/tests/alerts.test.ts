/**
 * Alert descriptions in the UI, and the one sentence that must not drift.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  alertColor, alertInactiveReason, alertLineLabel, describeAlert, describeFilters,
  frequencyWarning, isAlertActive, FREQUENCY_LABELS, INTRABAR_WARNING,
} from "../lib/alerts";
import type { AlertFrequency, ConditionKind, MaAlert } from "../lib/api";

const base: MaAlert = {
  id: "a1", symbol: "BTCUSDT", timeframe: "1h",
  conditionKind: "ma",
  maType: "ema", maLength: 200, mode: "cross_up",
  ma2Type: null, ma2Length: null,
  targetPrice: null, priceDirection: null,
  srSide: null, srPivotLength: null, srInvalidation: null,
  pivotType: null, pivotLevelName: null, pivotAnchor: null,
  rsiLength: null, rsiLevel: null, rsiMaLength: null,
  macdFast: null, macdSlow: null, macdSignal: null, indicatorTarget: null,
  filterRsiLength: null, filterRsiLevel: null, filterRsiSide: null,
  filterMaType: null, filterMaLength: null, filterMaSide: null,
  filterStPeriod: null, filterStMultiplier: null,
  filterStAtrMethod: null, filterStSide: null,
  // null = a row written before migration 032, so the legacy `filter*` columns
  // below are what describes its gates. Exercises the fallback path.
  filters: null,
  stPeriod: null, stMultiplier: null, stAtrMethod: null,
  bbLength: null, bbMult: null, bbBand: null, bbMaType: null,
  stochKLength: null, stochKSmooth: null, stochDSmooth: null, stochLevel: null,
  adxDiLength: null, adxSmoothing: null, adxLevel: null,
  nearMinPct: 0.2, nearMaxPct: 0.5,
  enabled: true, frequency: "once_per_bar_close", cooldownMin: 60, note: null,
  lastSide: null, lastFiredAt: null, lastFiredBarTime: null, lastBarTime: null,
  completedAt: null, createdAt: "", updatedAt: "",
};
const alert = (over: Partial<MaAlert>): MaAlert => ({ ...base, ...over });

// ── The warning ─────────────────────────────────────────────────────────────

test("THE INTRABAR WARNING IS THE SERVER'S SENTENCE, CHARACTER FOR CHARACTER", () => {
  // The UI states what the runner does, so the runner's file is the source. If
  // this fails, the two have drifted and the UI is describing behaviour the
  // backend no longer has.
  const backend = fs.readFileSync(
    path.join(__dirname, "..", "..", "backend", "src", "alerts", "alertFrequency.ts"),
    "utf8"
  );
  const match = backend.match(/export const INTRABAR_WARNING\s*=\s*\n?\s*"([^"]+)"/);
  assert.ok(match, "INTRABAR_WARNING was not found in the backend's alertFrequency.ts");
  assert.equal(INTRABAR_WARNING, match![1]);
});

test("exactly the two intrabar modes carry a warning", () => {
  const warned = (["once_only", "once_per_bar", "once_per_bar_close", "once_per_minute"] as AlertFrequency[])
    .filter((f) => frequencyWarning(f) !== null);
  assert.deepEqual(warned, ["once_per_bar", "once_per_minute"]);
  assert.equal(frequencyWarning("once_per_bar"), INTRABAR_WARNING);
  assert.equal(frequencyWarning("once_per_bar_close"), null);
});

test("every frequency has a label, so a select can never render an empty option", () => {
  for (const f of ["once_only", "once_per_bar", "once_per_bar_close", "once_per_minute"] as AlertFrequency[]) {
    assert.ok(FREQUENCY_LABELS[f].length > 0, f);
  }
});

// ── Descriptions ────────────────────────────────────────────────────────────

test("an MA alert reads as it always did", () => {
  assert.equal(describeAlert(alert({ mode: "touch" })), "price touches");
  assert.equal(describeAlert(alert({ mode: "cross_up" })), "price crosses above");
  assert.equal(describeAlert(alert({ mode: "near_below" })), "price 0.2–0.5% below");
  assert.equal(alertLineLabel(alert({})), "EMA 200");
});

test("a price alert names its level and direction", () => {
  const a = alert({
    conditionKind: "price", maType: null, maLength: null, mode: null,
    targetPrice: 64000, priceDirection: "either",
  });
  assert.equal(describeAlert(a), "price reaches 64,000.00");
  assert.equal(describeAlert({ ...a, priceDirection: "cross_up" }), "price crosses above 64,000.00");
  assert.equal(describeAlert({ ...a, priceDirection: "cross_down" }), "price crosses below 64,000.00");
  assert.equal(alertLineLabel(a), "64,000.00");
});

test("an MA-versus-MA alert names both lines, in order", () => {
  const a = alert({
    conditionKind: "ma_vs_ma", maType: "ema", maLength: 50,
    ma2Type: "sma", ma2Length: 200, mode: "cross_up",
  });
  assert.equal(describeAlert(a), "EMA 50 crosses above SMA 200");
  assert.equal(alertLineLabel(a), "EMA 50/SMA 200");
  assert.equal(describeAlert({ ...a, mode: "cross_down" }), "EMA 50 crosses below SMA 200");
});

test("a price alert does not borrow a moving average's colour", () => {
  // Colouring it like the 200 SMA would suggest a relationship that is not there.
  const price = alert({ conditionKind: "price", maLength: null, targetPrice: 1 });
  assert.notEqual(alertColor(price), alertColor(alert({ maLength: 200 })));
});

// ── Active versus armed ─────────────────────────────────────────────────────

test("A SPENT once_only ALERT READS AS DONE, NOT AS ARMED", () => {
  // It is still `enabled`, so without this it would look armed while being
  // permanently inert — the UI telling the user something untrue.
  const spent = alert({ frequency: "once_only", completedAt: "2026-08-24T10:00:00.000Z" });
  assert.equal(isAlertActive(spent), false);
  assert.equal(alertInactiveReason(spent), "Fired once — done");

  assert.equal(isAlertActive(alert({})), true);
  assert.equal(alertInactiveReason(alert({})), null);
  assert.equal(alertInactiveReason(alert({ enabled: false })), "Paused");
});

test("a paused alert reports pausing even when it has also completed", () => {
  const both = alert({ enabled: false, completedAt: "2026-08-24T10:00:00.000Z" });
  assert.equal(isAlertActive(both), false);
  assert.equal(alertInactiveReason(both), "Fired once — done");
});

test("a level alert is not labelled as a moving average", () => {
  // "SMA 0" appeared on the alerts page for these kinds, because the label
  // fell through to the MA branch with null length.
  const sr: MaAlert = {
    ...base, conditionKind: "sr_zone", maType: null, maLength: null,
    mode: "near_above", srSide: "support",
  };
  assert.equal(alertLineLabel(sr), "Support");
  assert.doesNotMatch(alertLineLabel(sr), /SMA|EMA/);
  assert.match(describeAlert(sr), /support/);

  const pivot: MaAlert = {
    ...base, conditionKind: "pivot_level", maType: null, maLength: null,
    mode: "near_below", pivotType: "Fibonacci", pivotLevelName: "S1", pivotAnchor: "1d",
  };
  assert.equal(alertLineLabel(pivot), "Pivot S1");
  assert.match(describeAlert(pivot), /Fibonacci S1/);
});

// ── RSI and MACD rows ───────────────────────────────────────────────────────

test("an oscillator alert never describes itself as a price move", () => {
  const rsiLevel = alert({
    conditionKind: "rsi", maType: null, maLength: null, mode: "cross_up",
    rsiLength: 50, rsiLevel: 50, indicatorTarget: "level",
  });
  assert.equal(describeAlert(rsiLevel), "RSI 50 crosses above 50");
  // The subject must be the oscillator; "price crosses above 50" would be a
  // different — and wrong — statement about a $100 coin.
  assert.doesNotMatch(describeAlert(rsiLevel), /price/i);

  const rsiSma = alert({
    conditionKind: "rsi", maType: null, maLength: null, mode: "cross_down",
    rsiLength: 50, rsiMaLength: 14, indicatorTarget: "sma",
  });
  assert.equal(describeAlert(rsiSma), "RSI 50 crosses below its SMA 14");
});

test("MACD rows name what is crossed, and hide default lengths only", () => {
  const signal = alert({
    conditionKind: "macd", maType: null, maLength: null, mode: "cross_up",
    macdFast: 12, macdSlow: 26, macdSignal: 9, indicatorTarget: "signal",
  });
  assert.equal(describeAlert(signal), "MACD crosses above the signal line");
  assert.equal(alertLineLabel(signal), "MACD");

  const zero = alert({
    conditionKind: "macd", maType: null, maLength: null, mode: "cross_down",
    macdFast: 8, macdSlow: 21, macdSignal: 5, indicatorTarget: "zero",
  });
  assert.equal(describeAlert(zero), "MACD 8/21/5 crosses below zero");
  assert.equal(alertLineLabel(zero), "MACD 8/21/5");
});

test("oscillator rows are not labelled as a moving average", () => {
  // The bug this pins: a kind with null maType/maLength falling through to the
  // MA branch and rendering "SMA 0" — which happened to the level families.
  for (const a of [
    alert({ conditionKind: "rsi", maType: null, maLength: null, rsiLength: 50 }),
    alert({
      conditionKind: "macd", maType: null, maLength: null,
      macdFast: 12, macdSlow: 26, macdSignal: 9,
    }),
  ]) {
    assert.doesNotMatch(alertLineLabel(a), /SMA 0|EMA 0/, alertLineLabel(a));
  }
  assert.equal(
    alertLineLabel(alert({ conditionKind: "rsi", maType: null, maLength: null, rsiLength: 50 })),
    "RSI 50"
  );
});

test("each oscillator gets its own swatch, not a moving average's hue", () => {
  const rsiColor = alertColor(alert({ conditionKind: "rsi", maLength: null }));
  const macdColor = alertColor(alert({ conditionKind: "macd", maLength: null }));
  assert.notEqual(rsiColor, macdColor);
  for (const c of [rsiColor, macdColor]) {
    assert.match(c, /^#[0-9a-f]{6}$/i);
    assert.notEqual(c, alertColor(alert({ conditionKind: "ma", maLength: 200 })));
  }
});

// ── trend gates on level alerts ─────────────────────────────────────────────

test("a gated level alert reads as a precondition, not a second trigger", () => {
  const a = alert({
    conditionKind: "sr_zone", srSide: "support", mode: "near_above",
    maType: null, maLength: null,
    filterRsiLength: 50, filterRsiLevel: 50, filterRsiSide: "above",
    filterMaType: "ema", filterMaLength: 200, filterMaSide: "above",
  });
  assert.equal(
    describeAlert(a),
    "price 0.2–0.5% above the 1h support — only while RSI 50 is above 50 " +
    "and price is above the EMA 200"
  );
  // "and" alone would read as two things that must both HAPPEN; these must
  // read as a state that must HOLD.
  assert.match(describeAlert(a), /only while/);
});

test("an ungated level alert is worded exactly as before", () => {
  const a = alert({
    conditionKind: "sr_zone", srSide: "support", mode: "near_above",
    maType: null, maLength: null,
  });
  assert.equal(describeAlert(a), "price 0.2–0.5% above the 1h support");
  assert.doesNotMatch(describeAlert(a), /only while/);
});

test("one gate on its own is described on its own", () => {
  const rsiOnly = alert({
    conditionKind: "pivot_level", pivotType: "Fibonacci", pivotLevelName: "S1",
    pivotAnchor: "1d", mode: "near_above", maType: null, maLength: null,
    filterRsiLength: 50, filterRsiLevel: 50, filterRsiSide: "above",
  });
  assert.match(describeAlert(rsiOnly), /Fibonacci S1 \(1d\) — only while RSI 50 is above 50$/);

  const maOnly = alert({
    conditionKind: "sr_zone", srSide: "support", mode: "near_above",
    maType: null, maLength: null,
    filterMaType: "ema", filterMaLength: 200, filterMaSide: "above",
  });
  assert.match(maOnly && describeAlert(maOnly), /only while price is above the EMA 200$/);
});

// ── every family, not just the ones that existed first ─────────────────────

/**
 * The row shape each family actually stores, keyed exhaustively.
 *
 * A `Record<ConditionKind, …>` rather than an array so that adding a family to
 * the union fails to compile here until it has been described. Three families
 * were added to the union and to the server's labels without ever reaching
 * `alertLineLabel`'s switch, so every Bollinger, Stochastic and ADX alert in
 * the list read "SMA 0 — price crosses above", including its `aria-label`. For
 * the two oscillators that was not vague, it was false: neither watches price.
 */
const FAMILY_ROWS: Record<ConditionKind, Partial<MaAlert>> = {
  price: { conditionKind: "price", targetPrice: 64_000, priceDirection: "cross_up" },
  ma: { conditionKind: "ma", maType: "ema", maLength: 200, mode: "cross_up" },
  ma_vs_ma: {
    conditionKind: "ma_vs_ma", maType: "ema", maLength: 50,
    ma2Type: "sma", ma2Length: 200, mode: "cross_up",
  },
  sr_zone: { conditionKind: "sr_zone", srSide: "support", mode: "near_above" },
  pivot_level: {
    conditionKind: "pivot_level", pivotType: "Fibonacci",
    pivotLevelName: "S1", pivotAnchor: "1d", mode: "near_above",
  },
  rsi: { conditionKind: "rsi", rsiLength: 14, rsiLevel: 70, indicatorTarget: "level", mode: "cross_up" },
  macd: { conditionKind: "macd", macdFast: 12, macdSlow: 26, macdSignal: 9, indicatorTarget: "signal", mode: "cross_up" },
  supertrend: { conditionKind: "supertrend", stPeriod: 10, stMultiplier: 3, stAtrMethod: "rma", mode: "cross_up" },
  bollinger: {
    conditionKind: "bollinger", bbLength: 20, bbMult: 2, bbBand: "upper",
    bbMaType: "sma", mode: "touch",
  },
  stochastic: {
    conditionKind: "stochastic", stochKLength: 14, stochKSmooth: 1,
    stochDSmooth: 3, stochLevel: 20, indicatorTarget: "signal", mode: "cross_down",
  },
  adx: { conditionKind: "adx", adxDiLength: 14, adxSmoothing: 14, adxLevel: 25, mode: "cross_up" },
};

test("no family falls through to the moving-average description", () => {
  for (const [kind, row] of Object.entries(FAMILY_ROWS)) {
    const a = alert({ maType: null, maLength: null, ...row });
    const label = alertLineLabel(a);
    assert.notEqual(label, "SMA 0", `${kind} is labelled as a nonexistent moving average`);
    assert.ok(label.trim().length > 0, `${kind} has no label`);
    assert.equal(describeAlert(a) === "condition met", false, `${kind} is not described`);
  }
});

test("an oscillator is never described as watching price", () => {
  for (const kind of ["stochastic", "adx"] as const) {
    const a = alert({ maType: null, maLength: null, ...FAMILY_ROWS[kind] });
    const desc = describeAlert(a);
    assert.doesNotMatch(desc, /^price /,
      `${kind} watches its own reading, not the market price`);
    assert.match(desc, kind === "adx" ? /^ADX rises through 25/ : /^Stochastic %K crosses below its %D/);
  }
  // Bollinger DOES watch price, against a band, and says so.
  const bb = alert({ maType: null, maLength: null, ...FAMILY_ROWS.bollinger });
  assert.equal(describeAlert(bb), "price touches the upper bollinger band");
});

test("a gate configured on a new family is visible on its row", () => {
  for (const kind of ["bollinger", "stochastic", "adx"] as const) {
    const a = alert({
      maType: null, maLength: null, ...FAMILY_ROWS[kind],
      filterMaType: "ema", filterMaLength: 200, filterMaSide: "above",
    });
    assert.match(describeAlert(a), /only while price is above the EMA 200$/,
      `${kind} silently ignores its configured gate in the UI`);
  }
});

test("each family's swatch is its own, so the list is readable at a glance", () => {
  const colours = new Set<string>();
  for (const row of Object.values(FAMILY_ROWS)) {
    colours.add(alertColor(alert({ maType: null, maLength: null, ...row })));
  }
  // sr_zone resolves by side and pivot/ma share no hue; the point is only that
  // the three late families did not all collapse onto one grey.
  for (const kind of ["bollinger", "stochastic", "adx"] as const) {
    const c = alertColor(alert({ maType: null, maLength: null, ...FAMILY_ROWS[kind] }));
    assert.notEqual(c, alertColor(alert({ conditionKind: "ma", maType: null, maLength: null })),
      `${kind} borrows a moving average's colour`);
  }
  assert.ok(colours.size >= 7);
});

test("non-default inputs are named, defaults are not", () => {
  const plain = alert({ maType: null, maLength: null, ...FAMILY_ROWS.bollinger });
  assert.equal(alertLineLabel(plain), "upper Bollinger band");
  const tuned = alert({ ...plain, bbLength: 34, bbMult: 2.5 });
  assert.equal(alertLineLabel(tuned), "upper Bollinger band (34, 2.5)");

  assert.equal(alertLineLabel(alert({ maType: null, maLength: null, ...FAMILY_ROWS.stochastic })),
    "Stochastic %K");
  assert.equal(
    alertLineLabel(alert({ maType: null, maLength: null, ...FAMILY_ROWS.stochastic, stochKLength: 21 })),
    "Stochastic %K 21/1/3");
  assert.equal(alertLineLabel(alert({ maType: null, maLength: null, ...FAMILY_ROWS.adx })), "ADX");
  assert.equal(
    alertLineLabel(alert({ maType: null, maLength: null, ...FAMILY_ROWS.adx, adxSmoothing: 21 })),
    "ADX 14/21");
});

/**
 * The gate sentence the UI writes must match the one the SERVER writes, since
 * the server's copy becomes the push notification. Two implementations of one
 * sentence is a drift risk, and the only thing holding them together is that
 * both files assert the same literals — these strings are duplicated verbatim
 * in `backend/tests/oscillatorFilters.test.ts` on purpose.
 */
test("the MACD gate sentence matches the server's, word for word", () => {
  const withGates = (filters: MaAlert["filters"]): string =>
    describeFilters({ ...base, filters });

  assert.equal(
    withGates([{
      kind: "macd", timeframe: "1h", fastLength: 12, slowLength: 26,
      signalLength: 9, target: "signal", side: "below",
    }]),
    " — only while 1h MACD (12/26/9) is bearish — line below signal"
  );
  assert.equal(
    withGates([{
      kind: "macd", timeframe: "4h", fastLength: 12, slowLength: 26,
      signalLength: 9, target: "signal", side: "above",
    }]),
    " — only while 4h MACD (12/26/9) is bullish — line above signal"
  );
  // Against zero the mood words would be wrong: the centreline says which way
  // the trend leans, not whether momentum has turned.
  assert.equal(
    withGates([{
      kind: "macd", timeframe: null, fastLength: 12, slowLength: 26,
      signalLength: 9, target: "zero", side: "below",
    }]),
    " — only while MACD (12/26/9) is below zero"
  );
});

test("the pullback-inside-a-trend pair reads as two opposite gates", () => {
  assert.equal(
    describeFilters({
      ...base,
      filters: [
        { kind: "macd", timeframe: "1h", fastLength: 12, slowLength: 26, signalLength: 9, target: "signal", side: "below" },
        { kind: "macd", timeframe: "4h", fastLength: 12, slowLength: 26, signalLength: 9, target: "signal", side: "above" },
      ],
    }),
    " — only while 1h MACD (12/26/9) is bearish — line below signal"
    + " and 4h MACD (12/26/9) is bullish — line above signal"
  );
});
