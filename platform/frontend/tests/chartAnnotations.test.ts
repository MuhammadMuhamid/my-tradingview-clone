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
  overlayNotice, PATTERN_LABEL_LIMIT, patternExportCsv, patternExportJson, patternMarkers,
  placePatterns,
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

test("past a density the arrows keep everything except their names", () => {
  /*
   * The overlay is genuinely good at a day's zoom and was unusable at a
   * quarter's: a live audit counted 1,027 labelled markers drawn at once on the
   * default window, and the price pane became a wall of red and green text with
   * the candles somewhere behind it. Every fact was on screen and none of it
   * was readable.
   *
   * This chart already answers the same question for backtest trades, past
   * `TRADE_LABEL_LIMIT`, and the rule is the same one: an arrow keeps WHERE and
   * WHICH WAY on every single occurrence, so nothing is hidden and nothing is
   * dropped — only the name waits until the window is narrow enough to read it.
   */
  const series = candles(PATTERN_LABEL_LIMIT + 60);
  const many = Array.from({ length: PATTERN_LABEL_LIMIT + 1 },
    (_, i) => pattern((i + 1) * HOUR));
  const dense = patternMarkers(placePatterns(analysis(many), series));

  assert.equal(dense.length, PATTERN_LABEL_LIMIT + 1,
    "every occurrence must still be drawn; this is a labelling rule, not a filter");
  for (const marker of dense) {
    assert.equal(marker.text, "", "past the limit no marker carries a name");
    assert.ok(marker.shape === "arrowUp" || marker.shape === "arrowDown" || marker.shape === "circle",
      "direction survives the density rule");
    assert.ok(marker.color.length > 0, "colour survives the density rule");
    assert.ok(Number.isFinite(marker.time), "position survives the density rule");
  }

  // One fewer, and every name is back. The threshold is a threshold, not a
  // fade: a reader either gets all the names or none, never an arbitrary half.
  const atLimit = patternMarkers(placePatterns(
    analysis(many.slice(0, PATTERN_LABEL_LIMIT)), series));
  assert.equal(atLimit.length, PATTERN_LABEL_LIMIT);
  for (const marker of atLimit) {
    assert.match(marker.text, /fit$/, "at the limit every marker is still named");
  }
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

// ── IO-A5: the marker goes on the bar the event was placed on ──────────────

/**
 * `placeAlertEvents` snaps an event to this timeframe's grid — deliberately,
 * and its own comment says why: "an intrabar event records the bar that was
 * forming". It stores that answer as `time` on the placed event.
 *
 * `alertEventMarkers` then threw it away and recomputed from the raw
 * `event.barTime`. The two disagree for every event that did not fire exactly
 * on a bar open, which is most of them, and the consequence is not cosmetic:
 * `CandleChart` drops any marker outside `[first bar open, last bar open]`, so
 * an alert firing part-way through the bar that is still forming lands past
 * the last open time and is never drawn at all — while the Alerts panel and
 * the chart's own notice both say it fired.
 *
 * An alert the product says fired and does not show you is worse than one it
 * misplaces by a few pixels.
 */
test("IO-A5 — an intrabar alert is drawn on the bar that was forming", () => {
  // Fired 37 minutes into the 1h bar that opens at hour 5.
  const intrabar = event({ barTime: new Date(5 * HOUR + 37 * 60_000).toISOString() });
  const placed = placeAlertEvents([intrabar], [alert()], "BTCUSDT", "1h", candles(10));
  assert.equal(placed.length, 1, "the event was not placed at all");
  assert.equal(placed[0]!.time, (5 * HOUR) / 1000, "placement did not snap to the grid");

  const [marker] = alertEventMarkers(placed);
  assert.ok(marker, "a placed event produced no marker");
  assert.equal(marker.time, placed[0]!.time,
    "the marker is at the raw fired time, not the bar it was placed on — so it "
    + "falls off the grid, and on the newest bar it is dropped entirely");
});

test("IO-A5 — an alert on the newest bar is drawn rather than silently dropped", () => {
  /*
   * The case that loses it completely. `CandleChart` keeps a marker only when
   * its time is within [first bar open, last bar open]; a raw intrabar time on
   * the last bar is past that, so the marker is discarded while the panel and
   * the notice both report the alert as fired.
   */
  const bars = candles(10);
  const lastOpen = bars[bars.length - 1]!.openTime;
  const onNewest = event({ barTime: new Date(lastOpen + 41 * 60_000).toISOString() });

  const placed = placeAlertEvents([onNewest], [alert()], "BTCUSDT", "1h", bars);
  assert.equal(placed.length, 1, "the newest bar's event was not placed");

  const [marker] = alertEventMarkers(placed);
  assert.ok(marker, "no marker for an event on the newest bar");

  const first = bars[0]!.openTime / 1000;
  const last = lastOpen / 1000;
  assert.ok(marker.time >= first && marker.time <= last,
    `the marker at ${marker.time} is outside the chart's window [${first}, ${last}], `
    + "so CandleChart drops it and the alert is never drawn");
});

test("IO-A5 — a stacked group is drawn once, on its own bar", () => {
  const bars = candles(10);
  const two = [
    event({ id: 1, barTime: new Date(5 * HOUR + 5 * 60_000).toISOString() }),
    event({ id: 2, barTime: new Date(5 * HOUR + 50 * 60_000).toISOString() }),
  ];
  const placed = placeAlertEvents(two, [alert()], "BTCUSDT", "1h", bars);
  assert.equal(placed.length, 1, "two events on one bar should group");
  assert.equal(placed[0]!.stacked, 2);

  const markers = alertEventMarkers(placed);
  assert.equal(markers.length, 1);
  assert.equal(markers[0]!.time, (5 * HOUR) / 1000,
    "the group's marker is at one of the raw fired times rather than the bar's");
  assert.match(markers[0]!.text ?? "", /×2/);
});
