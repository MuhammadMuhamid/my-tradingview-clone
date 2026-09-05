/**
 * Alert descriptions in the UI, and the one sentence that must not drift.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  alertColor, alertInactiveReason, alertLineLabel, describeAlert,
  frequencyWarning, isAlertActive, FREQUENCY_LABELS, INTRABAR_WARNING,
} from "../lib/alerts";
import type { AlertFrequency, MaAlert } from "../lib/api";

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
