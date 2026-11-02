/**
 * `ensureCandles` decides whether to FETCH with a 98.5 % count tolerance
 * (exchange downtime is real), and that decision is unchanged. What it now
 * also does is say, truthfully, what the range holds: a 1 % hole in the middle
 * of 10,000 bars used to pass as "covered" with nothing anywhere recording it,
 * and the stress benchmark searched straight across it.
 *
 * Nothing here reaches Binance or PostgreSQL: every dependency is injected.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureCandles, type EnsureCandlesDeps } from "../src/data/binanceRest";
import { measureCandleCoverage } from "../src/data/candleIntegrity";
import { assertNoInternalCandleGaps, missingBarCount } from "../src/data/candleSeries";
import { stressProvenance } from "../src/engine/stress";
import type { Candle } from "../src/types/market";

const HOUR = 3_600_000;
const T0 = Date.parse("2025-01-01T00:00:00Z");
const FAR_FUTURE = T0 + 100_000 * HOUR;

function bar(i: number): Candle {
  return {
    symbol: "BTCUSDT", interval: "1h", openTime: T0 + i * HOUR, closeTime: T0 + (i + 1) * HOUR - 1,
    open: 100, high: 101, low: 99, close: 100, volume: 1,
  };
}

/** Bars 0..n-1 except the half-open index ranges in `holes`. */
function bars(n: number, holes: Array<[number, number]> = []): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i += 1) if (!holes.some(([a, b]) => i >= a && i < b)) out.push(bar(i));
  return out;
}

function store(rows: Candle[], fetchable: Candle[] = [], now = FAR_FUTURE) {
  const calls = { fetch: 0, upserted: 0 };
  let table = [...rows];
  const deps: EnsureCandlesDeps = {
    getCandles: async (_s, _i, opts = {}) =>
      table.filter((c) => (opts.from === undefined || c.openTime >= opts.from)
        && (opts.to === undefined || c.openTime <= opts.to)),
    upsertCandles: async (candles) => {
      calls.upserted += candles.length;
      const byTime = new Map(table.map((c) => [c.openTime, c]));
      for (const c of candles) byTime.set(c.openTime, c);
      table = [...byTime.values()].sort((a, b) => a.openTime - b.openTime);
    },
    fetchKlines: async (_s, _i, from, to) => {
      calls.fetch += 1;
      return fetchable.filter((c) => c.openTime >= from && c.openTime <= to);
    },
    now: () => now,
  };
  return { deps, calls };
}

const START = T0;
const END = T0 + 10_000 * HOUR; // slots 0..9999 expected; a bar opening AT `END` is not required

// ── The fixture that used to pass ───────────────────────────────────────────

test("a 1% interior hole is not fetched (tolerance unchanged) but IS reported, not certified", async () => {
  const gapped = bars(10_000, [[5_000, 5_100]]);
  const { deps, calls } = store(gapped);
  const report = await ensureCandles("BTCUSDT", "1h", START, END, undefined, deps);

  assert.equal(calls.fetch, 0, "the 98.5% fetch decision is deliberately unchanged");
  assert.ok(report, "ensureCandles returns its coverage report");
  assert.equal(report.complete, false, "a hole between two stored bars is never complete");
  assert.equal(report.fetched, false);
  assert.equal(report.expectedBars, 10_000);
  assert.equal(report.presentBars, 9_900);
  assert.equal(report.interiorGaps, 1);
  assert.equal(report.interiorMissingBars, 100);
  assert.deepEqual(report.firstGap, {
    afterOpenTime: T0 + 4_999 * HOUR, beforeOpenTime: T0 + 5_100 * HOUR, missingBars: 100,
  });
  assert.equal(report.leadingMissingBars, 0);
  assert.equal(report.trailingMissingBars, 0);
  // One definition of an interior gap, shared with the engine's refusal.
  assert.equal(report.interiorMissingBars, missingBarCount(gapped, "1h"));
});

test("several small holes are counted in full, and the FIRST one is named", async () => {
  const { deps } = store(bars(10_000, [[100, 101], [7_000, 7_030], [9_000, 9_002]]));
  const report = await ensureCandles("BTCUSDT", "1h", START, END, undefined, deps);
  assert.equal(report.complete, false);
  assert.equal(report.interiorGaps, 3);
  assert.equal(report.interiorMissingBars, 33);
  assert.equal(report.firstGap?.afterOpenTime, T0 + 99 * HOUR);
});

// ── Genuinely complete data passes ─────────────────────────────────────────

test("a contiguous range is complete, with no fetch", async () => {
  const { deps, calls } = store(bars(10_001)); // includes the bar opening exactly at END
  const report = await ensureCandles("BTCUSDT", "1h", START, END, undefined, deps);
  assert.equal(calls.fetch, 0);
  assert.equal(report.complete, true);
  assert.equal(report.expectedBars, 10_000);
  assert.equal(report.presentBars, 10_000, "the bar at END is accepted but not counted as required");
  assert.equal(report.interiorGaps, 0);
  assert.equal(report.firstGap, null);
});

// ── Legitimate unavailability: reported, never a failure ───────────────────

test("a tail still forming is not missing: only CLOSED slots are expected", async () => {
  // now is 30 minutes into slot 9999, so 9999 is forming and 9998 is the newest closed bar.
  const now = T0 + 9_999 * HOUR + 30 * 60_000;
  for (const rows of [bars(9_999), bars(10_000)]) { // with and without the forming bar stored
    const { deps, calls } = store(rows, [], now);
    const report = await ensureCandles("BTCUSDT", "1h", START, END, undefined, deps);
    assert.equal(calls.fetch, 0);
    assert.equal(report.expectedBars, 9_999);
    assert.equal(report.presentBars, 9_999);
    assert.equal(report.complete, true, "a bar that has not closed is not a missing fact");
  }
});

test("an exchange outage the venue itself has no bars for is fetched, then DISCLOSED, not thrown", async () => {
  // Store holds the first half only, so the old rule fetches. Binance answers
  // with its own real hole (an outage): the run is not failed, it is told.
  const venue = bars(10_000, [[6_000, 6_120]]);
  const { deps, calls } = store(bars(5_000), venue);
  const report = await ensureCandles("BTCUSDT", "1h", START, END, undefined, deps);
  assert.equal(calls.fetch, 1);
  assert.equal(report.fetched, true);
  assert.equal(report.complete, false);
  assert.equal(report.interiorMissingBars, 120);
  assert.equal(report.firstGap?.afterOpenTime, T0 + 5_999 * HOUR);
});

test("a fetch that fills the hole yields a complete report — the FINAL store, not the first read", async () => {
  const { deps, calls } = store(bars(10_000, [[2_000, 2_400]]), bars(10_000)); // 4% missing: fetched
  const report = await ensureCandles("BTCUSDT", "1h", START, END, undefined, deps);
  assert.equal(calls.fetch, 1);
  assert.equal(report.fetched, true);
  assert.equal(report.complete, true);
  assert.equal(report.presentBars, 10_000);
});

test("a later listing is a LEADING shortfall, never an interior gap", async () => {
  const listed = bars(10_000).slice(3_000);
  const { deps } = store(listed, listed);
  const report = await ensureCandles("BTCUSDT", "1h", START, END, undefined, deps);
  assert.equal(report.complete, false, "the range asked for is not fully there");
  assert.equal(report.leadingMissingBars, 3_000);
  assert.equal(report.interiorGaps, 0, "a listing boundary is not a hole");
});

test("trailing bars not yet stored are a TRAILING shortfall", () => {
  const report = measureCandleCoverage(bars(9_990).map((c) => c.openTime), "1h", START, END, FAR_FUTURE);
  assert.equal(report.complete, false);
  assert.equal(report.trailingMissingBars, 10);
  assert.equal(report.interiorGaps, 0);
});

test("an empty or inverted range is vacuously complete and expects nothing", () => {
  const report = measureCandleCoverage([], "1h", END, START, FAR_FUTURE);
  assert.equal(report.expectedBars, 0);
  assert.equal(report.complete, true);
});

// ── Strict consumers ───────────────────────────────────────────────────────

test("the backtester's own gate refuses the very fixture ensureCandles lets through unfetched", () => {
  // `executeBacktest` runs `assertNoInternalCandleGaps` on the rows it loads
  // after `ensureCandles`, so a gapped input fails the run rather than being
  // reported as a result. Pinned here beside the fixture it answers.
  assert.throws(() => assertNoInternalCandleGaps(bars(10_000, [[5_000, 5_100]]), "1h", "BTCUSDT 1h"),
    /internal candle gap in BTCUSDT 1h: 100 1h bar\(s\) missing/);
});

// ── A strict consumer: stress discovery must disclose what it searched ─────

test("stress provenance carries the benchmark's completeness, so a gapped search is never presented as complete", () => {
  const benchmark = {
    symbol: "BTCUSDT", canonicalInstrument: null, interval: "1h" as const,
    providerId: "binance-spot", feedId: "binance-public-klines",
  };
  const config = { method: "worst_return" as const, lengthBars: 168, topN: 3 };

  const gapped = bars(10_000, [[5_000, 5_100]]);
  const p = stressProvenance(benchmark, gapped, config,
    measureCandleCoverage(gapped.map((c) => c.openTime), "1h", START, END, FAR_FUTURE));
  assert.equal(p.dataCompleteness.complete, false);
  assert.equal(p.dataCompleteness.interiorMissingBars, 100);
  assert.equal(p.dataCompleteness.firstGapAt, T0 + 5_000 * HOUR, "the first MISSING open time");
  assert.match(p.dataCompleteness.note, /100 1h bar\(s\) missing/);
  assert.match(p.dataCompleteness.note, /span more time/);

  const whole = bars(10_000);
  const q = stressProvenance(benchmark, whole, config,
    measureCandleCoverage(whole.map((c) => c.openTime), "1h", START, END, FAR_FUTURE));
  assert.equal(q.dataCompleteness.complete, true);
  assert.equal(q.dataCompleteness.missingBars, 0);
  assert.equal(q.dataCompleteness.firstGapAt, null);
});
