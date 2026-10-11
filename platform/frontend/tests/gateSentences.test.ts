/**
 * The gate sentence exists twice, and both copies must say the same thing.
 *
 * The server builds these phrases for the push notification; this build makes
 * them for the alert list. Nothing in the type system connects them, so the
 * moment one is edited the other can drift silently — a user would read one
 * rule in the app and receive a notification describing another.
 *
 * These literals are asserted VERBATIM here and verbatim again in the backend's
 * `oscillatorGates.test.ts`. Changing a word means changing both.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { describeGate } from "../lib/alerts";
import { MAX_ALERT_FILTERS, defaultGate, type AlertGate } from "../lib/api";

test("the MACD gate is named for the mood, against the signal", () => {
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

test("against zero it keeps above and below", () => {
  assert.equal(
    describeGate({
      kind: "macd", fastLength: 12, slowLength: 26, signalLength: 9,
      target: "zero", side: "above",
    }),
    "MACD 12/26/9 is above zero"
  );
});

test("a gate on another timeframe says so, with an article where one is due", () => {
  assert.equal(
    describeGate({
      kind: "rsi_ma", timeframe: "1h", length: 50, maType: "ema", maLength: 14,
      side: "above",
    }),
    "the 1h RSI(50) is above its EMA 14"
  );
  assert.equal(
    describeGate({ kind: "ma", timeframe: "4h", type: "ema", length: 200, side: "above" }),
    "price is above the 4h EMA 200"
  );
});

test("a gate on the alert's own timeframe does not invent one", () => {
  assert.equal(
    describeGate({ kind: "rsi", length: 50, level: 50, side: "above" }),
    "RSI(50) is above 50"
  );
  assert.equal(
    describeGate({ kind: "ma", type: "ema", length: 200, side: "above" }),
    "price is above the EMA 200"
  );
});

test("every kind the editor can create produces a sentence", () => {
  // A kind added to FILTER_KINDS without a phrase here would render as
  // "undefined" in the alert list rather than failing loudly.
  for (const kind of ["rsi", "ma", "supertrend", "rsi_ma", "macd"] as const) {
    const sentence = describeGate(defaultGate(kind) as AlertGate);
    assert.ok(sentence && !sentence.includes("undefined"), `${kind}: ${sentence}`);
  }
});

test("the client's cap matches the server's", () => {
  assert.equal(MAX_ALERT_FILTERS, 10);
});
