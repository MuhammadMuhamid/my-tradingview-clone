/**
 * Two overlays that report what something else decided.
 *
 * ── The claim each one makes ───────────────────────────────────────────────
 *
 * A fired-alert mark says "the server delivered this notification, on this
 * bar". A pattern mark says "the Screener reports this pattern, on this bar".
 * Neither says "this would have fired" or "this looks like a hammer to me",
 * and the distance between those pairs is the whole design: the weaker claim
 * is fabricated history on a chart a user reads to decide what happened.
 *
 * So both modules contain no evaluation logic at all, and what is tested here
 * is that they place an authoritative fact on the right bar, refuse to place
 * one they cannot attribute, and say out loud what their marks do NOT cover.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  alertEventMarkers, markerNotice, placeAlertEvents,
} from "../lib/alertMarkers";
import {
  overlayNotice, patternExportCsv, patternExportJson, patternMarkers, placePatterns,
  type PatternAnalysis,
} from "../lib/candleOverlay";
import type { MaAlert, MaAlertEvent } from "../lib/api";
import type { Candle } from "../lib/types";
import realExactBarFixture from "./fixtures/p2_btcusdt_15m_exact_bar.json";

const HOUR = 3_600_000;
const candle = (i: number): Candle => ({
  symbol: "BTCUSDT", interval: "1h",
  openTime: i * HOUR, closeTime: i * HOUR + HOUR - 1,
  open: 100, high: 101, low: 99, close: 100, volume: 10,
});
const candles = (n: number) => Array.from({ length: n }, (_, i) => candle(i));

const alert = (over: Partial<MaAlert> = {}): MaAlert => ({
  id: "a1", symbol: "BTCUSDT", timeframe: "1h", conditionKind: "ma",
  maType: "ema", maLength: 200, mode: "cross_up",
  ...over,
} as unknown as MaAlert);

const event = (over: Partial<MaAlertEvent> = {}): MaAlertEvent => ({
  id: 1, alertId: "a1",
  firedAt: new Date(5 * HOUR).toISOString(),
  barTime: new Date(5 * HOUR).toISOString(),
  price: 100, maValue: 99, distancePct: 1,
  title: "t", body: "b", pushedTo: 1, pushFailed: 0,
  ...over,
} as MaAlertEvent);

// ── fired alerts ───────────────────────────────────────────────────────────

test("an event is placed on the bar the server said it fired on", () => {
  const placed = placeAlertEvents([event()], [alert()], "BTCUSDT", "1h", candles(10));
  assert.equal(placed.length, 1);
  assert.equal(placed[0]!.time, (5 * HOUR) / 1000);
});

test("an event that belongs to another instrument or timeframe is not placed", () => {
  // A BTCUSDT alert on a SOLUSDT chart, and a 1h alert on a 1m chart, would
  // both sit on bars they have no relationship to.
  assert.equal(
    placeAlertEvents([event()], [alert()], "SOLUSDT", "1h", candles(10)).length, 0);
  assert.equal(
    placeAlertEvents([event()], [alert()], "BTCUSDT", "1m", candles(10)).length, 0);
  // Canonical identity, so `BINANCE:BTCUSDT` still matches.
  assert.equal(
    placeAlertEvents([event()], [alert()], "BINANCE:BTCUSDT", "1h", candles(10)).length, 1);
});

test("an event outside the loaded window is omitted, never clamped onto an edge bar", () => {
  // Clamping would claim an event happened on a bar it did not — the mark
  // would be plausible, visible and wrong.
  const old = event({ barTime: new Date(-50 * HOUR).toISOString() });
  const future = event({ barTime: new Date(500 * HOUR).toISOString() });
  assert.equal(placeAlertEvents([old, future], [alert()], "BTCUSDT", "1h", candles(10)).length, 0);
});

test("an event whose alert this client no longer holds is not attributed to a guess", () => {
  // The event is real, but without its alert there is no instrument or
  // timeframe to check it against, so it is not placed at all.
  assert.equal(placeAlertEvents([event()], [], "BTCUSDT", "1h", candles(10)).length, 0);
});

test("repeat deliveries on one bar are one mark, counted", () => {
  // An intrabar frequency can fire several times inside one candle and a push
  // can reach several devices. A dozen arrows on one bar say nothing more than
  // one arrow does.
  const placed = placeAlertEvents(
    [event({ id: 1 }), event({ id: 2, firedAt: new Date(5 * HOUR + 60_000).toISOString() }),
     event({ id: 3 })],
    [alert()], "BTCUSDT", "1h", candles(10));
  assert.equal(placed.length, 1);
  assert.equal(placed[0]!.stacked, 3);
  // And the EARLIEST is kept: that is when the condition first became true.
  assert.equal(placed[0]!.event.firedAt, new Date(5 * HOUR).toISOString());
  assert.match(alertEventMarkers(placed)[0]!.text!, /×3/);
});

test("two different alerts on the same bar stay two marks", () => {
  const placed = placeAlertEvents(
    [event({ alertId: "a1" }), event({ id: 2, alertId: "a2" })],
    [alert(), { ...alert(), id: "a2" }],
    "BTCUSDT", "1h", candles(10));
  assert.equal(placed.length, 2, "deduping is per ALERT per bar, not per bar");
});

test("no alert has fired is said out loud, because absence is the misreadable part", () => {
  // An alert armed today has no marks in the past, and that is correct — but a
  // reader who does not know that reads the absence as "this never triggered".
  assert.match(String(markerNotice([], 3)), /Marks appear only for alerts the server/);
  // With nothing armed there is nothing to explain.
  assert.equal(markerNotice([], 0), null);
  const placed = placeAlertEvents([event()], [alert()], "BTCUSDT", "1h", candles(10));
  assert.equal(markerNotice(placed, 3), null);
});

test("the markers module evaluates no condition of its own", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "lib", "alertMarkers.ts"), "utf8");
  // Re-evaluating an alert against history would produce marks where it WOULD
  // have fired, which is a different and much weaker claim than "this fired".
  for (const forbidden of [/evaluateCondition/, /crossover|crossunder/, /\bsma\(|\bema\(/]) {
    assert.doesNotMatch(source, forbidden,
      `${forbidden} would mean the chart is deciding what fired`);
  }
});

// ── candlestick patterns ───────────────────────────────────────────────────

const pattern = (openTime: number, over: Record<string, unknown> = {}) => ({
  id: "engulfing_bullish", name: "Engulfing - Bullish", direction: "bull",
  bars: 2, confirmation: "bar_close", predictive_claim: false,
  strength: 0.82, basis: "geometric fit", open_time: openTime,
  confirmed_at: openTime + HOUR, detector_id: "trading-scene-candlesticks",
  detector_version: "2.0.0", settings_hash: "abc123", ...over,
});

const analysis = (patterns: unknown[]): PatternAnalysis => ({
  detector_id: "trading-scene-candlesticks", detector_version: "2.0.0",
  catalog_observed_at: "2026-09-08", catalog_size: 44,
  confirmation: "bar_close", causal: true, predictive_claim: false,
  settings: { trend_method: "sma50" }, settings_hash: "abc123",
  input_end_open_time: 8 * HOUR, patterns,
  source: { venue: "BINANCE", market_type: "spot", symbol: "BTCUSDT", timeframe: "1h",
    ohlc: "caller_supplied_binance_spot", as_of: 9 * HOUR,
    closed_bars_analyzed: 9, forming_bars_excluded: 1 },
} as PatternAnalysis);

test("patterns are anchored by exact authoritative open-time", () => {
  const series = candles(10);
  const placed = placePatterns(analysis([pattern(8 * HOUR)]), series);
  assert.equal(placed.length, 1);
  assert.equal(placed[0]!.index, 8);
  assert.equal(placed[0]!.time, (8 * HOUR) / 1000);
  const older = placePatterns(analysis([pattern(6 * HOUR)]), series);
  assert.equal(older[0]!.index, 6);
});

test("reviewed Binance Spot OHLC places canonical occurrences on their exact real bars", () => {
  const fixture = realExactBarFixture as unknown as {
    candles: Candle[];
    analysis: PatternAnalysis;
  };
  const placed = placePatterns(fixture.analysis, fixture.candles);
  assert.deepEqual(
    placed.map(({ pattern: occurrence, index, time }) => ({
      id: occurrence.id, index, time,
    })),
    [
      { id: "marubozu_black_bearish", index: 1, time: 1788700500 },
      { id: "doji", index: 2, time: 1788701400 },
    ],
  );
  assert.equal(placed[1]!.pattern.confirmed_at, fixture.candles[2]!.closeTime + 1);
});

test("a pattern older than the loaded window is omitted, not clamped", () => {
  const series = candles(5);
  assert.equal(placePatterns(analysis([pattern(50 * HOUR)]), series).length, 0);
});

test("the notice distinguishes loading, failure, empty, and non-predictive results", () => {
  assert.match(overlayNotice(null, true, null, "BTCUSDT"), /Analyzing completed/);
  assert.match(overlayNotice(null, false, "offline", "BTCUSDT"), /unavailable: offline/);
  assert.match(overlayNotice(analysis([]), false, null, "BTCUSDT"), /No recognized/);
  assert.match(overlayNotice(analysis([pattern(HOUR)]), false, null, "BTCUSDT"),
    /not a return forecast/);
});

test("the overlay module contains no pattern logic at all", () => {
  const raw = fs.readFileSync(
    path.join(__dirname, "..", "lib", "candleOverlay.ts"), "utf8");
  /*
   * The CODE, with the comments removed.
   *
   * The file's header explains the rule and necessarily names a pattern to do
   * it. What must not appear is a pattern name in an expression — there must
   * be exactly one implementation of "is this a hammer", and it is the
   * Screener's. A port here would agree the day it was written and drift, and
   * then the two tools would disagree with each other in front of the user.
   */
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  for (const forbidden of [/hammer/i, /engulf/i, /\bdoji\b/i, /\bstar\b/i, /marubozu/i]) {
    assert.doesNotMatch(code, forbidden,
      `${forbidden} means a second implementation has started here`);
  }
  // Nor an inspection of a bar's own prices, which is what pattern logic IS.
  for (const forbidden of [/\.close\s*[<>]/, /\.high\s*-\s*\w+\.low/, /Math\.abs\(\w+\.open/]) {
    assert.doesNotMatch(code, forbidden,
      "a comparison of one bar's own prices is pattern logic");
  }
});

test("a marker says what it is and how textbook, without pretending to predict", () => {
  const series = candles(10);
  const placed = placePatterns(analysis([pattern(8 * HOUR)]), series);
  const [marker] = patternMarkers(placed);
  assert.match(marker!.text!, /Engulfing - Bullish/);
  assert.match(marker!.text!, /82%/);
  assert.match(marker!.text!, /fit/);
  assert.equal(marker!.shape, "arrowUp");
  assert.equal(marker!.position, "belowBar");
});

test("Research JSON and CSV retain exact time, settings, version, and Spot provenance", () => {
  const value = analysis([pattern(8 * HOUR)]);
  const json = JSON.parse(patternExportJson(value)) as PatternAnalysis;
  assert.equal(json.source.venue, "BINANCE");
  assert.equal(json.settings_hash, "abc123");
  assert.equal(json.patterns[0]!.open_time, 8 * HOUR);
  const csv = patternExportCsv(value);
  for (const field of ["BTCUSDT", "engulfing_bullish", "2.0.0", "abc123",
    "caller_supplied_binance_spot", String(8 * HOUR)]) assert.match(csv, new RegExp(field));
});

test("catalog selection filters annotations without re-evaluating OHLC", () => {
  const value = analysis([
    pattern(HOUR), pattern(2 * HOUR, { id: "doji", name: "Doji", direction: "none" }),
  ]);
  assert.deepEqual(placePatterns(value, candles(4), new Set(["doji"])).map((p) => p.pattern.id), ["doji"]);
  assert.equal(placePatterns(value, candles(4), new Set()).length, 0);
});
