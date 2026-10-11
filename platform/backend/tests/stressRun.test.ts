/**
 * A stress run's request, the traded instrument's own move, and the chart's
 * series — everything around discovery that discovery must not depend on.
 *
 * None of this reaches the database: the request rules are pure, the target
 * return is two candles, and the two route checks below answer before any
 * query is made. Were one made, `not-a-uuid` would reach Postgres as a uuid
 * cast and come back as a 500 (or as a connection failure where no server
 * runs) — which is the defect those checks close.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { isUuid, parseStressRunSettings } from "../src/api/routes/stressRequest";
import { stressRoutes } from "../src/api/routes/stress";
import { targetReturn } from "../src/engine/stressTarget";
import { benchmarkPath, discoverStressWindows } from "../src/engine/stress";
import type { Candle } from "../src/types/market";

const HOUR = 3_600_000;
const T0 = Date.parse("2025-01-01T00:00:00Z");

function bar(i: number, open: number, close: number, low = Math.min(open, close)): Candle {
  return {
    symbol: "SOLUSDT", interval: "1h",
    openTime: T0 + i * HOUR, closeTime: T0 + (i + 1) * HOUR - 1,
    open, close, high: Math.max(open, close), low, volume: 1,
  };
}

// ── The run's settings ──────────────────────────────────────────────────────

/** What `/stress?from=<id>` sends: a finished run's own configuration. */
const FROM_A_RUN = {
  strategyKey: "ma_rr_v9", symbol: "solusdt", timeframe: "1h",
  params: { qty_cash: 930, ma_len: 50, use_filter: true, mode: "close" },
  initialCapital: 2500, commissionPct: 0.075, slippageTicks: 1,
};

test("a finished run's settings pass through unchanged", () => {
  const parsed = parseStressRunSettings(FROM_A_RUN);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
  assert.deepEqual(parsed.value, { ...FROM_A_RUN, symbol: "SOLUSDT" },
    "every number the page sent is the number that is queued");
});

test("absent costs stay absent, so the route's one set of defaults applies", () => {
  const parsed = parseStressRunSettings({ strategyKey: "mtf_lean", symbol: "SOLUSDT", timeframe: "1h" });
  assert.ok(parsed.ok);
  for (const key of ["initialCapital", "commissionPct", "slippageTicks"] as const) {
    assert.equal(key in parsed.value, false, `${key} must not acquire a default here`);
  }
  assert.deepEqual(parsed.value.params, {});
});

test("settings no real run could have are refused before ten backtests are queued", () => {
  const refusals: [string, Record<string, unknown>, RegExp][] = [
    ["no strategy", { ...FROM_A_RUN, strategyKey: "" }, /strategyKey is required/],
    ["zero capital", { ...FROM_A_RUN, initialCapital: 0 }, /initialCapital must be a positive amount/],
    ["negative capital", { ...FROM_A_RUN, initialCapital: -5 }, /initialCapital/],
    ["capital as text", { ...FROM_A_RUN, initialCapital: "1000" }, /initialCapital/],
    ["negative commission", { ...FROM_A_RUN, commissionPct: -0.1 }, /commissionPct/],
    ["commission as a fraction typo", { ...FROM_A_RUN, commissionPct: 50 }, /commissionPct/],
    ["fractional slippage", { ...FROM_A_RUN, slippageTicks: 1.5 }, /slippageTicks/],
    ["params as a list", { ...FROM_A_RUN, params: [1, 2] }, /params must be an object/],
    ["params null", { ...FROM_A_RUN, params: null }, /params must be an object/],
    ["a nested param", { ...FROM_A_RUN, params: { qty_cash: { value: 930 } } }, /params\.qty_cash/],
    ["an infinite param", { ...FROM_A_RUN, params: { qty_cash: Infinity } }, /params\.qty_cash/],
    ["a symbol that is not text", { ...FROM_A_RUN, symbol: 42 }, /symbol must be a string/],
  ];
  for (const [name, body, message] of refusals) {
    const parsed = parseStressRunSettings(body);
    assert.equal(parsed.ok, false, `${name} was accepted`);
    if (!parsed.ok) {
      assert.equal(parsed.code, 400, name);
      assert.match(parsed.error, message, name);
    }
  }
});

test("a configId that is not a uuid cannot name a config: 404, not a database error", () => {
  const parsed = parseStressRunSettings({ ...FROM_A_RUN, configId: "not-a-uuid" });
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.equal(parsed.code, 404);
  assert.ok(parseStressRunSettings({
    ...FROM_A_RUN, configId: "3f1c2a9e-8d4b-4c6f-9a1e-2b7d5c8e0f13",
  }).ok);
  assert.equal(isUuid("3F1C2A9E-8D4B-4C6F-9A1E-2B7D5C8E0F13"), true);
  assert.equal(isUuid("3f1c2a9e8d4b4c6f9a1e2b7d5c8e0f13"), false);
});

test("a stress run id that is not a uuid is a 404, and asks the database nothing", async (t) => {
  const app = Fastify({ logger: false });
  await stressRoutes(app);
  t.after(() => app.close());
  for (const url of ["/api/stress/runs/not-a-uuid", "/api/stress/runs/not-a-uuid/benchmark"]) {
    const response = await app.inject({ method: "GET", url });
    assert.equal(response.statusCode, 404, `${url}: ${response.body}`);
    assert.deepEqual(response.json(), { error: "stress run not found" });
  }
});

// ── What the traded instrument did ──────────────────────────────────────────

const WINDOW = { startMs: T0 + 2 * HOUR, endMs: T0 + 6 * HOUR - 1 };

test("the traded symbol's buy-and-hold runs from the window's first open to its last close", () => {
  const first = bar(2, 100, 95);
  const last = bar(5, 82, 80);
  const target = targetReturn(first, last, WINDOW, HOUR);
  assert.deepEqual(target, {
    returnPct: -20, startMs: first.openTime, endMs: last.closeTime, complete: true,
  });
});

test("a target figure over part of the window says so", () => {
  // The traded symbol's history begins two bars into the window.
  const late = targetReturn(bar(4, 100, 99), bar(5, 99, 90), WINDOW, HOUR);
  assert.ok(late);
  assert.equal(late.complete, false, "a figure over half the window is not the window's figure");
  assert.equal(late.startMs, T0 + 4 * HOUR);
});

test("no figure is not a zero, and nothing after the window is read", () => {
  assert.equal(targetReturn(undefined, bar(5, 1, 1), WINDOW, HOUR), null);
  assert.equal(targetReturn(bar(2, 1, 1), undefined, WINDOW, HOUR), null);
  assert.equal(targetReturn(bar(5, 1, 1), bar(3, 1, 1), WINDOW, HOUR), null, "out of order");
  assert.equal(targetReturn(bar(2, 0, 1), bar(5, 1, 1), WINDOW, HOUR), null, "no opening price");
  assert.equal(targetReturn(bar(2, 1, 1), bar(6, 1, 1), WINDOW, HOUR), null,
    "a bar that closes after the window must not supply its last price");
});

test("the target is computed after discovery and cannot reach it", () => {
  /*
   * Discovery's signature is the guarantee (see stressWindows.test.ts); this
   * is the same property from the other side. Whatever the traded symbol did,
   * the benchmark's windows are the same.
   */
  const benchmark = Array.from({ length: 30 }, (_, i) => bar(i, 100 - i, 99 - i));
  const before = discoverStressWindows(benchmark, { method: "worst_return", lengthBars: 4, topN: 3 });
  targetReturn(bar(2, 100, 50), bar(5, 50, 10), WINDOW, HOUR);
  assert.deepEqual(
    discoverStressWindows(benchmark, { method: "worst_return", lengthBars: 4, topN: 3 }), before);
  assert.equal(targetReturn.length, 4, "two candles, a window and a bar length — no run output");
});

// ── The chart's series ──────────────────────────────────────────────────────

test("the benchmark path is thinned without stepping over the crash", () => {
  const candles: Candle[] = [];
  for (let i = 0; i < 50_000; i += 1) {
    // A gentle rise, with one single-bar crash at a position no stride hits.
    const close = i === 31_337 ? 40 : 100 + i / 1000;
    candles.push(bar(i, close, close));
  }
  const path = benchmarkPath(candles, 600);
  assert.ok(path.length <= 602, `${path.length} points`);
  assert.deepEqual(path[0], [candles[0]!.openTime, candles[0]!.close], "the line starts at the start");
  assert.deepEqual(path[path.length - 1],
    [candles[49_999]!.openTime, candles[49_999]!.close], "and ends at the end");
  assert.ok(path.some(([, close]) => close === 40), "the crash must survive the thinning");
  for (let k = 1; k < path.length; k += 1) {
    assert.ok(path[k]![0] > path[k - 1]![0], "points stay in time order, once each");
  }
});

test("a short benchmark is drawn bar for bar", () => {
  const candles = Array.from({ length: 40 }, (_, i) => bar(i, 100 + i, 101 + i));
  assert.deepEqual(benchmarkPath(candles, 600), candles.map((c) => [c.openTime, c.close]));
});
