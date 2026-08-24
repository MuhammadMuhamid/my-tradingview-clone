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
