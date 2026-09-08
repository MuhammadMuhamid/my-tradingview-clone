import assert from "node:assert/strict";
import test from "node:test";
import {
  classicalExportCsv, classicalMarkers, classicalOverlays, type ClassicalAnalysis,
} from "../lib/classicalPatterns";
import type { Candle } from "../lib/types";

const HOUR = 3_600_000;
const candles: Candle[] = Array.from({ length: 8 }, (_, index) => ({
  symbol: "BTCUSDT", interval: "1h",
  openTime: index * HOUR, closeTime: (index + 1) * HOUR - 1,
  open: 100, high: 112, low: 88, close: 100, volume: 10,
}));

const analysis: ClassicalAnalysis = {
  detector_id: "trading-scene-classical-patterns", detector_version: "1.0.0",
  catalog_observed_at: "2026-09-08", catalog_size: 16, search_horizon_bars: 600,
  confirmation: "close", pivot_confirmation: { left_bars: 5, right_bars: 5 },
  causal: true, predictive_claim: false, settings: { bar_duration_ms: HOUR }, settings_hash: "abc",
  input_end_open_time: 7 * HOUR,
  source: { venue: "BINANCE", market_type: "spot", symbol: "BTCUSDT", timeframe: "1h",
    ohlc: "caller_supplied_binance_spot", as_of: 8 * HOUR,
    closed_bars_analyzed: 8, forming_bars_excluded: 0 },
  patterns: [{
    id: "double_top", name: "Double Top", family: "double", direction: "bear",
    confirmation: "close", pivot_basis: "confirmed_5_5", target_basis: "measured_move",
    predictive_claim: false, occurrence_id: "double-1", start_index: 1, end_index: 5,
    detected_at_index: 5, detected_open_time: 5 * HOUR, detected_at: 6 * HOUR,
    state: "completed", status: "awaiting",
    anchors: [
      { index: 1, open_time: HOUR, price: 110, kind: "high", confirmed_at_index: 2, confirmed_at: 3 * HOUR },
      { index: 3, open_time: 3 * HOUR, price: 100, kind: "low", confirmed_at_index: 4, confirmed_at: 5 * HOUR },
      { index: 5, open_time: 5 * HOUR, price: 110, kind: "high", confirmed_at_index: 5, confirmed_at: 6 * HOUR },
    ],
    breakout: { index: 6, open_time: 6 * HOUR, confirmed_at: 7 * HOUR, price: 100, direction: "bear" },
    invalidation: { price: 110, basis: "opposite structure boundary", triggered: null },
    target: { price: 90, direction: "bear", basis: "measured", reached: null },
    boundaries: {
      upper: null,
      lower: { start: { index: 3, open_time: 3 * HOUR, price: 100 },
        end: { index: 5, open_time: 5 * HOUR, price: 100 } },
    },
    quality: { symmetry: 1, score: 0.9 }, detector_id: "trading-scene-classical-patterns",
    detector_version: "1.0.0", settings_hash: "abc",
  }],
};

test("classical geometry uses exact server times and draws measured target", () => {
  const overlays = classicalOverlays(analysis, candles, null, true);
  assert.deepEqual(overlays.map((item) => item.id), [
    "classical:double-1:price", "classical:double-1:lower", "classical:double-1:target",
  ]);
  assert.deepEqual(overlays[0]!.data.map((point) => point.time), [3600, 10800, 18000]);
  assert.deepEqual(overlays[2]!.data.map((point) => point.value), [90, 90]);
});

test("geometry refuses an anchor time that is absent instead of shifting it", () => {
  const clipped = candles.filter((bar) => bar.openTime !== 3 * HOUR);
  const overlays = classicalOverlays(analysis, clipped, null, false);
  assert.equal(overlays.find((item) => item.id.endsWith(":lower")), undefined);
  assert.deepEqual(overlays[0]!.data.map((point) => point.time), [3600, 18000]);
});

test("selection filters geometry and markers from the same occurrence", () => {
  assert.equal(classicalOverlays(analysis, candles, new Set(), true).length, 0);
  assert.equal(classicalMarkers(analysis, new Set()).length, 0);
  const markers = classicalMarkers(analysis, new Set(["double_top"]));
  assert.equal(markers.length, 1);
  assert.equal(markers[0]!.time, 21600);
  assert.match(markers[0]!.text, /Double Top · awaiting · 90% geometry/);
});

test("a target breaking on the latest bar does not emit duplicate chart times", () => {
  const latest = structuredClone(analysis);
  latest.patterns[0]!.breakout!.open_time = 7 * HOUR;
  assert.equal(
    classicalOverlays(latest, candles, null, true).some((item) => item.id.endsWith(":target")),
    false,
  );
});

test("duplicate boundary timestamps are refused instead of crashing the chart", () => {
  const duplicate = structuredClone(analysis);
  duplicate.patterns[0]!.boundaries.lower!.end.open_time =
    duplicate.patterns[0]!.boundaries.lower!.start.open_time;
  assert.equal(
    classicalOverlays(duplicate, candles, null, false).some((item) => item.id.endsWith(":lower")),
    false,
  );
});

test("Research CSV repeats causal provenance and lifecycle fields", () => {
  const csv = classicalExportCsv(analysis);
  assert.match(csv, /"occurrence_id","pattern_id"/);
  assert.match(csv, /"double-1","double_top","Double Top","double","bear","completed","awaiting"/);
  assert.match(csv, /"trading-scene-classical-patterns","1.0.0","abc"/);
  assert.match(csv, /"predictive_claim"/);
});
