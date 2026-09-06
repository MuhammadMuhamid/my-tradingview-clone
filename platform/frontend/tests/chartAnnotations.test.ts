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
  anchorIndex, overlayNotice, patternMarkers, placePatterns,
} from "../lib/candleOverlay";
import type { MaAlert, MaAlertEvent } from "../lib/api";
import type { Candle } from "../lib/types";
import type { Snapshot } from "../lib/scanner/types";

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
} as MaAlert & typeof over);

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

const snapshot = (patterns: unknown[]): Snapshot => ({
  rows: [{
    symbol: "BTC/USDT", timeframe: "1h",
    market: { native_symbol: "BTCUSDT", config_symbol: "BTC/USDT" },
    indicators: { candles: { patterns } },
  }],
} as unknown as Snapshot);

const pattern = (barsAgo: number, over: Record<string, unknown> = {}) => ({
  name: "Bullish Engulfing", direction: "bull", strength: 0.82,
  basis: "body ratio", bars_ago: barsAgo, ...over,
});

test("patterns are anchored on the last CLOSED bar, not the forming one", () => {
  // `bars_ago: 0` is the Screener's newest closed bar, and the chart's newest
  // bar is usually still forming. Off by one here would put every mark on the
  // bar AFTER the one that formed the pattern.
  const series = candles(10);
  const now = 9 * HOUR + 100; // bar 9 is forming
  assert.equal(anchorIndex(series, now), 8);
  const placed = placePatterns(snapshot([pattern(0)]), "BTCUSDT", "1h", series, now);
  assert.equal(placed.length, 1);
  assert.equal(placed[0]!.index, 8);
  assert.equal(placed[0]!.time, (8 * HOUR) / 1000);
  // And two bars back is two bars back from THAT.
  const older = placePatterns(snapshot([pattern(2)]), "BTCUSDT", "1h", series, now);
  assert.equal(older[0]!.index, 6);
});

test("the Screener naming its pairs differently does not silently mean no patterns", () => {
  // The Screener says `BTC/USDT` and the chart says `BTCUSDT`. Comparing those
  // as strings would never match and would look exactly like "no patterns".
  const series = candles(10);
  const now = 9 * HOUR + 100;
  assert.equal(placePatterns(snapshot([pattern(0)]), "BINANCE:BTCUSDT", "1h", series, now).length, 1);
  // A pair the Screener does not track produces nothing, which is honest.
  assert.equal(placePatterns(snapshot([pattern(0)]), "SOLUSDT", "1h", series, now).length, 0);
});

test("a pattern older than the loaded window is omitted, not clamped", () => {
  const series = candles(5);
  const now = 4 * HOUR + 100;
  assert.equal(placePatterns(snapshot([pattern(50)]), "BTCUSDT", "1h", series, now).length, 0);
});

test("the notice distinguishes 'no answer' from 'no patterns' from 'recent only'", () => {
  // Three different truths, and each changes what the marks mean.
  assert.match(String(overlayNotice(null, [], "BTCUSDT")), /has not answered/);
  assert.match(String(overlayNotice(snapshot([]), [], "BTCUSDT")), /no recent pattern/);
  const series = candles(10);
  const placed = placePatterns(snapshot([pattern(0)]), "BTCUSDT", "1h", series, 9 * HOUR + 100);
  assert.match(String(overlayNotice(snapshot([pattern(0)]), placed, "BTCUSDT")),
    /not every pattern in the chart's history/);
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
  const placed = placePatterns(snapshot([pattern(0)]), "BTCUSDT", "1h", series, 9 * HOUR + 100);
  const [marker] = patternMarkers(placed);
  assert.match(marker!.text!, /Bullish Engulfing/);
  assert.match(marker!.text!, /82%/);
  assert.equal(marker!.shape, "arrowUp");
  assert.equal(marker!.position, "belowBar");
});
