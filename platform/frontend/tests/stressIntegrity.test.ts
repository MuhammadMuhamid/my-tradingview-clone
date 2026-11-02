/**
 * What the stress page says about a window's own data.
 *
 * A window counted in stored bars can span far more time than its length
 * says when the benchmark series has a hole inside it. These sentences are
 * the page's whole account of that, so they are pinned as what they claim:
 * the actual span against the nominal one, the missing bars and where they
 * are, a verdict that a comparison is or is not supported — and, for a run
 * saved before any of it was measured, "not verified", never "complete".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  discoveryCompleteness, integritySummary, spanLabel, UNVERIFIED_INTEGRITY, utcMinute,
  windowIntegrityView,
} from "../lib/stress";
import type { StressDiscovery, StressWindow, StressWindowIntegrity } from "../lib/types";

const HOUR = 3_600_000;
const T0 = Date.parse("2025-01-01T00:00:00Z");

function window(integrity?: StressWindowIntegrity, over: Partial<StressWindow> = {}): StressWindow {
  return {
    rank: 1, startMs: T0, endMs: T0 + 24 * HOUR - 1, bars: 24,
    benchmarkReturnPct: -12, benchmarkDrawdownPct: 15, benchmarkVolatilityPct: 2,
    selectedBy: { metric: "worst_return", value: -12 },
    ...(integrity ? { integrity } : {}), ...over,
  };
}

const COMPLETE: StressWindowIntegrity = {
  intervalMs: HOUR, nominalMs: 24 * HOUR, actualMs: 24 * HOUR,
  missingBars: 0, gapCount: 0, gaps: [], status: "complete",
};
/** 24 stored bars across a 100-bar hole: 124 hours, not 24. */
const GAPPED: StressWindowIntegrity = {
  intervalMs: HOUR, nominalMs: 24 * HOUR, actualMs: 124 * HOUR,
  missingBars: 100, gapCount: 1,
  gaps: [{ startMs: T0 + 10 * HOUR, endMs: T0 + 110 * HOUR - 1, bars: 100 }],
  status: "not_comparable",
};
const ONE_MISSING: StressWindowIntegrity = {
  intervalMs: HOUR, nominalMs: 24 * HOUR, actualMs: 25 * HOUR,
  missingBars: 1, gapCount: 1, gaps: [{ startMs: T0 + 5 * HOUR, endMs: T0 + 6 * HOUR - 1, bars: 1 }],
  status: "impaired",
};

test("spans and instants are said as a reader says them, in UTC", () => {
  assert.equal(spanLabel(124 * HOUR), "5 d 4 h");
  assert.equal(spanLabel(24 * HOUR), "1 d");
  assert.equal(spanLabel(90 * 60_000), "1 h 30 min");
  assert.equal(utcMinute(T0 + 10 * HOUR), "2025-01-01 10:00 UTC");
});

test("a complete window says nothing more than that, and stays comparable", () => {
  const view = windowIntegrityView(window(COMPLETE), "1h");
  assert.deepEqual(view, { state: "complete", label: "Complete", comparable: true, detail: null });
});

test("a window across missing bars shows its actual elapsed span against its nominal one, and is not comparable", () => {
  const view = windowIntegrityView(window(GAPPED, { endMs: T0 + 124 * HOUR - 1 }), "1h");
  assert.equal(view.state, "not_comparable");
  assert.equal(view.label, "Not comparable");
  assert.equal(view.comparable, false);
  assert.match(view.detail!, /^Actually spans 2025-01-01 00:00 UTC → 2025-01-06 03:59 UTC: 5 d 4 h elapsed, not the 1 d its 24 × 1h bars imply\./);
  assert.match(view.detail!, /100 1h bars missing inside it \(2025-01-01 10:00 UTC → 2025-01-05 13:59 UTC\)/);
  assert.match(view.detail!, /cannot be read against them/);
});

test("one missing bar is impaired: still comparable, and still said", () => {
  const view = windowIntegrityView(window(ONE_MISSING, { endMs: T0 + 25 * HOUR - 1 }), "1h");
  assert.equal(view.state, "impaired");
  assert.equal(view.comparable, true);
  assert.match(view.detail!, /1 d 1 h elapsed, not the 1 d/);
  assert.match(view.detail!, /1 1h bar missing inside it \(2025-01-01 05:00 UTC\)/);
});

test("more gaps than are listed are counted", () => {
  const many: StressWindowIntegrity = { ...GAPPED, gapCount: 7, gaps: GAPPED.gaps };
  assert.match(windowIntegrityView(window(many), "1h").detail!, /and 6 more gaps\)/);
});

test("a legacy window without a measurement is NOT VERIFIED, never complete", () => {
  const view = windowIntegrityView(window(), "1h");
  assert.equal(view.state, "unverified");
  assert.equal(view.label, "Not verified");
  assert.equal(view.detail, UNVERIFIED_INTEGRITY);
  assert.match(UNVERIFIED_INTEGRITY, /not verified \(saved before it was measured\)/);
  assert.notEqual(view.label, "Complete");
});

test("the run-level summary counts each state and is silent only when every window is measured whole", () => {
  assert.equal(integritySummary([window(COMPLETE), window(COMPLETE)], "BTCUSDT", "1h"), null);
  const mixed = integritySummary([window(GAPPED), window(COMPLETE), window(ONE_MISSING)], "BTCUSDT", "1h")!;
  assert.equal(mixed.tone, "warn");
  assert.match(mixed.text, /^1 of 3 windows crosses missing BTCUSDT 1h data and is marked not comparable/);
  assert.match(mixed.text, /1 of 3 windows is missing one 1h bar inside it and is marked impaired/);
  const legacy = integritySummary([window(), window()], "BTCUSDT", "1h")!;
  assert.equal(legacy.tone, "info");
  assert.match(legacy.text, /saved before window data completeness was measured, so none of its windows is verified complete/);
});

test("the searched period's completeness: legacy provenance is unavailable, not complete", () => {
  const base = { schemaVersion: "stress-discovery.v2" } as StressDiscovery;
  assert.match(discoveryCompleteness(base), /not verified — provenance unavailable/);
  assert.equal(discoveryCompleteness({ ...base, dataCompleteness: {
    complete: true, expectedBars: 10, missingBars: 0, interiorMissingBars: 0, interiorGaps: 0,
    firstGapAt: null, leadingMissingBars: 0, trailingMissingBars: 0, note: "x",
  } }), "Every closed benchmark bar of the searched period was present.");
  assert.equal(discoveryCompleteness({ ...base, dataCompleteness: {
    complete: false, expectedBars: 10, missingBars: 3, interiorMissingBars: 3, interiorGaps: 1,
    firstGapAt: T0, leadingMissingBars: 0, trailingMissingBars: 0, note: "3 1h bar(s) missing inside",
  } }), "3 1h bar(s) missing inside");
});
