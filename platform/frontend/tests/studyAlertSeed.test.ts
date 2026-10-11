/**
 * C-04: a study's `Add alert on …` opens on that study's inputs.
 *
 * The chart's RSI(14, close) opened the alert dialog at RSI length 50, so the
 * alert watched a different indicator from the line that was clicked.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { alertSeedFromStudy } from "../lib/studyAlertSeed";

test("each family carries the study's own parameters", () => {
  assert.deepEqual(alertSeedFromStudy("rsi", { length: 14, source: "close" }),
    { rsiLength: 14, differs: null });
  assert.deepEqual(alertSeedFromStudy("macd", { fast: 8, slow: 21, signal: 5, source: "close" }),
    { macdFast: 8, macdSlow: 21, macdSignal: 5, differs: null });
  assert.deepEqual(alertSeedFromStudy("bb", { length: 30, mult: 2.5, maType: "EMA", source: "close" }),
    { bbLength: 30, bbMult: 2.5, bbMaType: "ema", differs: null });
  assert.deepEqual(alertSeedFromStudy("supertrend", { period: 7, multiplier: 2, atrMethod: "sma" }),
    { stPeriod: 7, stMultiplier: 2, stAtrMethod: "sma", differs: null });
  assert.deepEqual(alertSeedFromStudy("stoch", { kLength: 21, kSmooth: 3, dSmooth: 5 }),
    { stochKLength: 21, stochKSmooth: 3, stochDSmooth: 5, differs: null });
  assert.deepEqual(alertSeedFromStudy("adx", { diLength: 10, adxLength: 20 }),
    { adxDiLength: 10, adxSmoothing: 20, differs: null });
});

test("what the alert cannot evaluate the study's way is said, not substituted", () => {
  assert.deepEqual(alertSeedFromStudy("rsi", { length: 21, source: "hl2" }), {
    rsiLength: 21, differs: "This RSI reads hl2; an alert evaluates it on the close.",
  });
  const bb = alertSeedFromStudy("bb", { length: 20, mult: 2, maType: "WMA", source: "close" })!;
  assert.equal(bb.bbMaType, undefined, "an unsupported basis keeps the dialog's own choice");
  assert.match(bb.differs ?? "", /basis is WMA; an alert can watch an SMA or EMA basis only/);
});

test("a study no alert watches has no seed, and a missing input keeps the dialog's value", () => {
  assert.equal(alertSeedFromStudy("atr", { length: 14 }), null);
  assert.deepEqual(alertSeedFromStudy("rsi", {}), { differs: null });
});
