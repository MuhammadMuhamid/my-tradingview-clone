/**
 * A stress window's own integrity: what its bar count says it spans, what it
 * actually spans, and the bars missing inside it.
 *
 * Discovery counts windows in STORED bars, so over a series with an interior
 * hole "the worst 24 1h bars" can be a stretch of five days. These tests pin
 * that every window says so about itself — on a contiguous series it says it
 * is whole and nothing else changes; across a hole it records its real span,
 * the missing bars and where they are, and earns a status that the result
 * pages turn into "not comparable" — and that the measurement travels into
 * the stored run, while a run stored before it existed is never presented as
 * complete.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import {
  discoverStressWindows, STRESS_IMPAIRED_MAX_MISSING_BARS, STRESS_MAX_LISTED_GAPS,
  stressIntegrityStatus, stressWindowIntegrity, type StressWindow,
} from "../src/engine/stress";
import { stressRoutes } from "../src/api/routes/stress";
import { pool } from "../src/db/pool";
import type { Candle } from "../src/types/market";

const HOUR = 3_600_000;
const T0 = Date.parse("2025-01-01T00:00:00Z");

/** Hourly bars at slots `0..n-1` except those in `holes` ([from, to) slot ranges). */
function hourly(n: number, close: (slot: number) => number, holes: [number, number][] = []): Candle[] {
  const out: Candle[] = [];
  for (let k = 0; k < n; k += 1) {
    if (holes.some(([a, b]) => k >= a && k < b)) continue;
    const c = close(k);
    // A bar after a hole opens where the market really was, not where the
    // last STORED bar closed: the hole hides a move, it does not pause one.
    const previous = k === 0 ? c : close(k - 1);
    out.push({
      symbol: "BTCUSDT", interval: "1h",
      openTime: T0 + k * HOUR, closeTime: T0 + (k + 1) * HOUR - 1,
      open: previous, close: c, high: Math.max(previous, c), low: Math.min(previous, c), volume: 1,
    });
  }
  return out;
}

/** Flat at 100, then a long slide from slot 140 to 260, then flat. */
const slide = (k: number): number => (k < 140 ? 100 : k < 260 ? 100 - (k - 140) * 0.5 : 40);

// ── Contiguous data: whole, and nothing else changes ────────────────────────

test("contiguous data: every window is complete and spans exactly bars × interval", () => {
  const candles = hourly(400, slide);
  for (const method of ["worst_return", "deepest_drawdown", "highest_volatility"] as const) {
    const windows = discoverStressWindows(candles, { method, lengthBars: 24, topN: 3 });
    assert.equal(windows.length, 3);
    for (const w of windows) {
      assert.deepEqual(w.integrity, {
        intervalMs: HOUR, nominalMs: 24 * HOUR, actualMs: 24 * HOUR,
        missingBars: 0, gapCount: 0, gaps: [], status: "complete",
      }, method);
      assert.equal(w.endMs + 1 - w.startMs, 24 * HOUR, "the stored dates are the window's real span");
    }
  }
});

// ── Missing interior candles ────────────────────────────────────────────────

test("missing interior candles: a window across the hole records its actual span, its missing bars and where they are", () => {
  // 100 hourly bars (slots 150..249) are absent, in the middle of the slide.
  const candles = hourly(400, slide, [[150, 250]]);
  const [worst] = discoverStressWindows(candles, { method: "worst_return", lengthBars: 24, topN: 1 });
  assert.ok(worst);
  // 24 STORED bars that straddle the hole: the steepest "24-bar" fall is the
  // one with 100 hours of extra slide hidden inside it.
  assert.ok(worst.startMs < T0 + 150 * HOUR && worst.endMs >= T0 + 250 * HOUR,
    "the worst 24 stored bars are the ones that cross the hole");
  const integrity = worst.integrity!;
  assert.equal(worst.bars, 24, "the label still says 24 bars");
  assert.equal(integrity.nominalMs, 24 * HOUR, "nominal: 24 bars × 1h");
  assert.equal(integrity.actualMs, 124 * HOUR, "actual: first open to last close, 124 hours");
  assert.equal(integrity.actualMs, worst.endMs + 1 - worst.startMs);
  assert.equal(integrity.missingBars, 100);
  assert.equal(integrity.gapCount, 1);
  assert.deepEqual(integrity.gaps, [
    { startMs: T0 + 150 * HOUR, endMs: T0 + 250 * HOUR - 1, bars: 100 },
  ], "the missing slots are named in UTC ms: first missing open to last missing close");
  assert.equal(integrity.status, "not_comparable");
});

test("actual elapsed time is measured per window, so only the window that crosses the gap is marked", () => {
  const candles = hourly(400, slide, [[150, 250]]);
  const windows = discoverStressWindows(candles, { method: "highest_volatility", lengthBars: 10, topN: 5 });
  assert.ok(windows.length >= 3);
  for (const w of windows) {
    const crosses = w.startMs < T0 + 150 * HOUR && w.endMs >= T0 + 250 * HOUR;
    const i = w.integrity!;
    assert.equal(i.actualMs - i.nominalMs, i.missingBars * HOUR,
      "the extra elapsed time is exactly the missing bars");
    assert.equal(i.status, crosses ? "not_comparable" : "complete",
      `${new Date(w.startMs).toISOString()} crosses=${crosses}`);
  }
});

test("the gapped window's figures are not adjusted — they stay first open to last close over the stored bars", () => {
  const candles = hourly(400, slide, [[150, 250]]);
  const [worst] = discoverStressWindows(candles, { method: "worst_return", lengthBars: 24, topN: 1 });
  const first = candles.find((c) => c.openTime === worst!.startMs)!;
  const last = candles.find((c) => c.closeTime === worst!.endMs)!;
  assert.equal(worst!.benchmarkReturnPct, ((last.close - first.open) / first.open) * 100);
});

test("the threshold: one missing bar is impaired, two or more are not comparable", () => {
  assert.equal(STRESS_IMPAIRED_MAX_MISSING_BARS, 1);
  assert.equal(stressIntegrityStatus(0), "complete");
  assert.equal(stressIntegrityStatus(1), "impaired");
  assert.equal(stressIntegrityStatus(2), "not_comparable");
  assert.equal(stressIntegrityStatus(Number.NaN), "complete",
    "only a measured shortfall downgrades; an absent measurement is the caller's 'unverified'");

  const one = hourly(30, (k) => 100 - k, [[10, 11]]);
  assert.equal(stressWindowIntegrity(one, 0, one.length - 1).status, "impaired");
  assert.equal(stressWindowIntegrity(one, 0, one.length - 1).actualMs, 30 * HOUR);
  assert.equal(stressWindowIntegrity(one, 0, one.length - 1).nominalMs, 29 * HOUR);
  const two = hourly(30, (k) => 100 - k, [[10, 11], [20, 21]]);
  const measured = stressWindowIntegrity(two, 0, two.length - 1);
  assert.equal(measured.status, "not_comparable");
  assert.equal(measured.gapCount, 2);
  assert.equal(measured.missingBars, 2);
});

test("many separate holes are counted in full and listed up to a bound", () => {
  const holes: [number, number][] = Array.from({ length: 8 }, (_, g) => [10 + g * 10, 12 + g * 10]);
  const candles = hourly(100, (k) => 100 + k, holes);
  const measured = stressWindowIntegrity(candles, 0, candles.length - 1);
  assert.equal(measured.gapCount, 8);
  assert.equal(measured.missingBars, 16);
  assert.equal(measured.gaps.length, STRESS_MAX_LISTED_GAPS);
  assert.deepEqual(measured.gaps[0], { startMs: T0 + 10 * HOUR, endMs: T0 + 12 * HOUR - 1, bars: 2 });
});

test("a manual window over a hole is measured the same way", () => {
  const candles = hourly(200, slide, [[150, 160]]);
  const [w] = discoverStressWindows(candles, {
    method: "manual", lengthBars: 2, topN: 1,
    manualWindows: [{ startMs: T0 + 140 * HOUR, endMs: T0 + 170 * HOUR }],
  });
  assert.equal(w!.bars, 20, "30 hours of calendar hold 20 stored bars");
  assert.equal(w!.integrity!.actualMs, 30 * HOUR);
  assert.equal(w!.integrity!.nominalMs, 20 * HOUR);
  assert.equal(w!.integrity!.missingBars, 10);
  assert.equal(w!.integrity!.status, "not_comparable");
});

// ── Benchmark handling: the stored run carries each window's integrity ───────

test("a stress run stores each window's integrity beside the benchmark's searched-period completeness", async (t) => {
  const RUN = "3f1c2a9e-8d4b-4c6f-9a1e-2b7d5c8e0f13";
  // The benchmark (BTCUSDT 1h) falls 1 % a bar and has a 3-bar hole at slots
  // 200..202 — under 1 % of the period, which the store's fetch tolerance
  // accepts without refetching (so this test never reaches the network).
  const rows = hourly(400, (k) => 100 * 0.99 ** k, [[200, 203]]).map((c) => ({
    symbol: c.symbol, interval: c.interval, open_time: new Date(c.openTime),
    close_time: new Date(c.closeTime), open: c.open, high: c.high, low: c.low, close: c.close,
    volume: 1, quote_volume: null, trade_count: null,
  }));
  const coordinator = {
    id: RUN, strategy_id: 1, config_id: null, source_backtest_id: null,
    symbol: "SOLUSDT", timeframe: "1h", params: {}, initial_capital: 2500,
    commission_pct: 0.075, slippage_ticks: 1, benchmark_symbol: "BTCUSDT",
    benchmark_interval: "1h", discovery: {}, windows: [], status: "running", error: null,
    created_at: new Date(T0), finished_at: null,
  };
  let storedDiscovery: { dataCompleteness: { complete: boolean; interiorMissingBars: number } } | null = null;
  let attached: StressWindow[] | null = null;
  let child = 0;
  t.mock.method(pool, "query", async (sql: string) => {
    if (sql.startsWith("SELECT * FROM symbols WHERE")) return { rows: [{ symbol: "BTCUSDT",
      base_asset: "BTC", quote_asset: "USDT", price_tick: 0.01, qty_step: 0.001,
      min_notional: 1, is_active: true }] };
    if (sql.startsWith("SELECT * FROM strategies WHERE")) return { rows: [{ id: 1,
      key: "ma_rr_v9", name: "MA RR", description: null, pine_source: null }] };
    if (sql.startsWith("SELECT * FROM candles WHERE")) return { rows };
    throw new Error(`unexpected query: ${sql}`);
  });
  t.mock.method(pool, "connect", async () => ({
    query: async (sql: string, values: unknown[] = []) => {
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
      if (sql.includes("INSERT INTO stress_runs")) {
        storedDiscovery = JSON.parse(String(values[10]));
        return { rows: [coordinator] };
      }
      if (sql.includes("INSERT INTO backtests")) {
        child += 1;
        return { rows: [{ ...coordinator, id: `${RUN.slice(0, -1)}${child}`,
          start_time: values[4], end_time: values[5], stress_run_id: RUN,
          started_at: null, holdout_fraction: null, engine_fingerprint: null }] };
      }
      if (sql.startsWith("UPDATE stress_runs SET windows")) {
        attached = JSON.parse(String(values[1]));
        return { rows: [{ ...coordinator, windows: attached }] };
      }
      throw new Error(`unexpected transactional query: ${sql}`);
    },
    release: () => {},
  }));
  const app = Fastify({ logger: false });
  await stressRoutes(app);
  try {
    const response = await app.inject({ method: "POST", url: "/api/stress/runs", payload: {
      strategyKey: "ma_rr_v9", symbol: "SOLUSDT", timeframe: "1h",
      params: { qty_cash: 500 }, initialCapital: 2500,
      benchmarkSymbol: "BTCUSDT", benchmarkInterval: "1h",
      startTime: T0, endTime: T0 + 400 * HOUR - 1,
      method: "worst_return", lengthBars: 4, topN: 3,
    } });
    assert.equal(response.statusCode, 201, response.body);
    assert.ok(attached, "the windows were attached");
    const windows = attached as StressWindow[];
    assert.ok(windows.length >= 2);
    for (const w of windows) {
      assert.ok(w.integrity, "every stored window carries its measured integrity");
      const crosses = w.startMs < T0 + 200 * HOUR && w.endMs >= T0 + 203 * HOUR;
      assert.equal(w.integrity.status, crosses ? "not_comparable" : "complete");
      assert.equal(w.integrity.missingBars, crosses ? 3 : 0);
    }
    assert.ok(windows.some((w) => w.integrity?.status === "not_comparable"),
      "the steepest 4 stored bars are the ones across the hole");
    assert.equal(storedDiscovery!.dataCompleteness.complete, false);
    assert.equal(storedDiscovery!.dataCompleteness.interiorMissingBars, 3);
    assert.equal(response.json().windows[0].integrity !== undefined, true,
      "the created run the page receives carries it too");
  } finally { await app.close(); t.mock.restoreAll(); }
});

// ── Legacy: a run stored before integrity was measured ───────────────────────

test("a legacy run is returned without integrity or completeness — nothing is fabricated as complete", async (t) => {
  const RUN = "9b2e4f60-1a3c-4d5e-8f70-a1b2c3d4e5f6";
  const legacyWindow = {
    rank: 1, startMs: T0, endMs: T0 + 24 * HOUR - 1, bars: 24,
    benchmarkReturnPct: -12, benchmarkDrawdownPct: 15, benchmarkVolatilityPct: 2,
    selectedBy: { metric: "worst_return", value: -12 },
    backtestId: "00000000-0000-4000-8000-000000000001",
  };
  t.mock.method(pool, "query", async (sql: string) => {
    if (sql.startsWith("SELECT * FROM stress_runs WHERE id")) return { rows: [{
      id: RUN, strategy_id: 1, config_id: null, symbol: "SOLUSDT", timeframe: "1h", params: {},
      initial_capital: 1000, commission_pct: 0.1, slippage_ticks: 1,
      benchmark_symbol: "BTCUSDT", benchmark_interval: "1h",
      discovery: {
        schemaVersion: "stress-discovery.v2",
        benchmark: { symbol: "BTCUSDT", canonicalInstrument: null, interval: "1h",
          providerId: "binance-spot", feedId: "binance-public-klines" },
        searched: { startMs: T0, endMs: T0 + 400 * HOUR - 1, bars: 400 },
        config: { method: "worst_return", lengthBars: 24, topN: 1, minSeparationBars: 24 },
        epistemicNote: "",
      },
      windows: [legacyWindow], status: "done", error: null,
      created_at: new Date(T0), finished_at: new Date(T0),
    }] };
    if (sql.startsWith("SELECT * FROM backtests WHERE id = ANY")) return { rows: [] };
    if (sql.includes("FROM candles WHERE")) return { rows: [] };
    throw new Error(`unexpected query: ${sql}`);
  });
  const app = Fastify({ logger: false });
  await stressRoutes(app);
  try {
    const response = await app.inject({ method: "GET", url: `/api/stress/runs/${RUN}` });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.equal("integrity" in body.results[0].window, false,
      "an unmeasured window must reach the page unmeasured, for it to say 'not verified'");
    assert.equal("dataCompleteness" in body.discovery, false);
  } finally { await app.close(); t.mock.restoreAll(); }
});
