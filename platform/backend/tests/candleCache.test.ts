/**
 * B-08: the provider candle cache and the paged kline fetch behind it.
 *
 * No network and no database: the cache is driven with a fake venue and a fake
 * clock, the kline pager with a fetch stub, the route with fixture adapters.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { ProviderCandleCache, candleCacheKey, type CandleCacheRequest } from "../src/market/candleCache";
import { RequestPacer } from "../src/data/requestPacer";
import {
  fetchKlines, klinePacer, klineWindows, KLINE_WINDOW_CONCURRENCY, USED_WEIGHT_SOFT_LIMIT,
} from "../src/data/binanceRest";
import { createBinanceSpotAdapter } from "../src/market/binanceSpotAdapter";
import { createOfficialSpotAdapter, OFFICIAL_SPOT_DEFINITIONS } from "../src/market/officialSpotAdapters";
import { ProviderRegistry } from "../src/market/registry";
import { marketCatalogRoutesFor } from "../src/api/routes/marketCatalog";
import { INTERVAL_MS, type Candle, type Interval } from "../src/types/market";

const STEP = INTERVAL_MS["15m"];
const T0 = Date.UTC(2026, 0, 1);

function bar(openTime: number, close = openTime / STEP, step = STEP): Candle {
  return { symbol: "SOLUSDT", interval: "15m", openTime, closeTime: openTime + step - 1,
    open: close, high: close + 1, low: close - 1, close, volume: 1 };
}

/**
 * A venue with a bar on every 15m slot from T0 (except an outage gap), whose
 * fetch answers exactly what a real one would at the fake clock's `now`:
 * closed bars only, or closed bars plus the forming one.
 */
function venue(clock: { now: number }, opts: { forming?: boolean; gap?: [number, number] } = {}) {
  const calls: Array<[number, number]> = [];
  const truth = (startMs: number, endMs: number): Candle[] => {
    const out: Candle[] = [];
    const first = Math.max(T0, Math.ceil(startMs / STEP) * STEP);
    for (let t = first; t <= endMs; t += STEP) {
      if (opts.gap && t >= opts.gap[0] && t <= opts.gap[1]) continue;
      const closed = t + STEP <= clock.now;
      if (closed) out.push(bar(t));
      else if (opts.forming && t <= clock.now) out.push({ ...bar(t), close: clock.now }); // live close
    }
    return out;
  };
  const fetch = async (startMs: number, endMs: number): Promise<Candle[]> => {
    calls.push([startMs, endMs]);
    return truth(startMs, endMs);
  };
  return { calls, truth, fetch };
}

function request(v: ReturnType<typeof venue>, startMs: number, endMs: number,
  over: Partial<CandleCacheRequest> = {}): CandleCacheRequest {
  return { venueId: "BINANCE", providerId: "binance-spot", providerSymbol: "SOLUSDT", interval: "15m",
    stepMs: STEP, startMs, endMs, closedBarsOnly: true, fetch: v.fetch, ...over };
}

/** The chart's latest-window request: `limit` bars ending now. */
const latest = (clock: { now: number }, limit: number): [number, number] =>
  [clock.now - (limit - 1) * STEP, clock.now];

// ── Hit / miss ───────────────────────────────────────────────────────────────

test("a repeated latest window is served from held bars with no provider call", async () => {
  const clock = { now: T0 + 20_000 * STEP + 5 * 60_000 }; // 5 minutes into a bar
  const v = venue(clock);
  const cache = new ProviderCandleCache({ now: () => clock.now });
  const first = await cache.read(request(v, ...latest(clock, 10_000)));
  assert.equal(first.outcome, "miss");
  assert.equal(v.calls.length, 1);
  assert.equal(first.rows.length, 9_998, "closed bars only: the forming bar is not one");

  clock.now += 4 * 60_000; // still inside the same bar
  const second = await cache.read(request(v, ...latest(clock, 10_000)));
  assert.equal(second.outcome, "hit");
  assert.equal(v.calls.length, 1, "nothing can have closed, so nothing is asked");
  assert.deepEqual(second.rows, v.truth(...latest(clock, 10_000)));
});

test("a bar that closed since the last probe is fetched as a one-bar tail, never the window", async () => {
  const clock = { now: T0 + 20_000 * STEP + 14 * 60_000 };
  const v = venue(clock);
  const cache = new ProviderCandleCache({ now: () => clock.now });
  await cache.read(request(v, ...latest(clock, 10_000)));
  const lastHeld = v.truth(...latest(clock, 10_000)).at(-1)!.openTime;

  clock.now += 2 * 60_000; // crosses the 15m boundary: one more bar has closed
  const window = latest(clock, 10_000);
  const result = await cache.read(request(v, ...window));
  assert.equal(result.outcome, "partial");
  assert.deepEqual(result.fetched, [[lastHeld + 1, window[1]]], "only after the last held bar");
  assert.deepEqual(result.rows, v.truth(...window), "identical to a full fetch at this moment");
  assert.equal(result.rows.at(-1)!.openTime, lastHeld + STEP, "the newly closed bar is served");
});

test("an adapter that returns the forming bar has its tail re-read on every request", async () => {
  const clock = { now: T0 + 20_000 * STEP + 3 * 60_000 };
  const v = venue(clock, { forming: true });
  const cache = new ProviderCandleCache({ now: () => clock.now });
  const req = (w: [number, number]) => request(v, ...w, { closedBarsOnly: false });
  const first = await cache.read(req(latest(clock, 1_000)));
  assert.equal(first.rows.at(-1)!.close, clock.now, "the forming bar as the venue reported it");

  clock.now += 30_000; // same bar, new live close
  const second = await cache.read(req(latest(clock, 1_000)));
  assert.equal(second.outcome, "partial");
  assert.equal(v.calls.length, 2);
  assert.equal(second.rows.at(-1)!.close, clock.now, "never a frozen forming bar");
  assert.deepEqual(second.rows, v.truth(...latest(clock, 1_000)));
  assert.equal(cache.totalBars, 998, "the forming bar itself is never stored");
});

// ── Key ─────────────────────────────────────────────────────────────────────

test("the key separates venue, provider, symbol and interval", async () => {
  const clock = { now: T0 + 2_000 * STEP + 60_000 };
  const v = venue(clock);
  const cache = new ProviderCandleCache({ now: () => clock.now });
  const window = latest(clock, 500);
  await cache.read(request(v, ...window));
  for (const over of [{ venueId: "BYBIT" }, { providerId: "bybit-spot" },
    { providerSymbol: "AVAXUSDT" }, { interval: "1h" as Interval }]) {
    const before = v.calls.length;
    const result = await cache.read(request(v, ...window, over));
    assert.equal(result.outcome, "miss", JSON.stringify(over));
    assert.equal(v.calls.length, before + 1);
  }
  assert.equal(cache.size, 5);
  assert.notEqual(candleCacheKey(request(v, 0, 1)), candleCacheKey(request(v, 0, 1, { venueId: "OKX" })));
});

test("window size (limit) and end (to) are ranges over the key: only the uncovered part is fetched", async () => {
  const clock = { now: T0 + 30_000 * STEP + 60_000 };
  const v = venue(clock);
  const cache = new ProviderCandleCache({ now: () => clock.now });
  const small = latest(clock, 1_000);
  await cache.read(request(v, ...small));

  // A smaller window inside what is held: no call.
  const smaller = await cache.read(request(v, ...latest(clock, 300)));
  assert.equal(smaller.outcome, "hit");
  assert.deepEqual(smaller.rows, v.truth(...latest(clock, 300)));

  // A larger limit: only the older head is fetched.
  const big = latest(clock, 10_000);
  const larger = await cache.read(request(v, ...big));
  assert.equal(larger.outcome, "partial");
  assert.deepEqual(larger.fetched, [[big[0], small[0] - 1]]);
  assert.deepEqual(larger.rows, v.truth(...big));

  // An explicit past `to` inside the held range: no call, exactly that range.
  const past: [number, number] = [big[0] + 100 * STEP, big[0] + 600 * STEP - 1];
  const ranged = await cache.read(request(v, ...past));
  assert.equal(ranged.outcome, "hit");
  assert.deepEqual(ranged.rows, v.truth(...past));
  assert.equal(v.calls.length, 2);
});

test("an entry filled for an explicit past end still fetches bars beyond that end", async () => {
  const clock = { now: T0 + 30_000 * STEP + 60_000 };
  const v = venue(clock);
  const cache = new ProviderCandleCache({ now: () => clock.now });
  const pastEnd = T0 + 20_000 * STEP - 1;
  await cache.read(request(v, T0 + 19_000 * STEP, pastEnd));
  const window: [number, number] = [T0 + 19_500 * STEP, clock.now];
  const result = await cache.read(request(v, ...window));
  assert.equal(result.outcome, "partial");
  assert.deepEqual(result.rows, v.truth(...window));
});

test("a disjoint older window does not evict the live entry", async () => {
  const clock = { now: T0 + 30_000 * STEP + 60_000 };
  const v = venue(clock);
  const cache = new ProviderCandleCache({ now: () => clock.now });
  const live = latest(clock, 1_000);
  await cache.read(request(v, ...live));
  const old: [number, number] = [T0, T0 + 500 * STEP];
  const oldResult = await cache.read(request(v, ...old));
  assert.equal(oldResult.outcome, "miss");
  assert.deepEqual(oldResult.rows, v.truth(...old));
  assert.equal((await cache.read(request(v, ...live))).outcome, "hit");
});

// ── Expiry, bounds, failure, coalescing ─────────────────────────────────────

test("an entry expires maxAgeMs after it was filled and is then fetched in full", async () => {
  const clock = { now: T0 + 2_000 * STEP };
  const v = venue(clock);
  const cache = new ProviderCandleCache({ now: () => clock.now, maxAgeMs: 60_000 });
  const window = (): [number, number] => latest(clock, 500);
  await cache.read(request(v, ...window()));
  clock.now += 59_000;
  assert.equal((await cache.read(request(v, ...window()))).outcome, "hit");
  clock.now += 1_000;
  const expired = await cache.read(request(v, ...window()));
  assert.equal(expired.outcome, "miss");
  assert.deepEqual(expired.fetched, [window()]);
});

test("a window wider than maxBarsPerRequest bypasses the cache", async () => {
  const clock = { now: T0 + 2_000 * STEP };
  const v = venue(clock);
  const cache = new ProviderCandleCache({ now: () => clock.now, maxBarsPerRequest: 100 });
  const result = await cache.read(request(v, ...latest(clock, 101)));
  assert.equal(result.outcome, "bypass");
  assert.equal(cache.size, 0);
  assert.equal((await cache.read(request(v, ...latest(clock, 101)))).outcome, "bypass");
});

test("least recently used series are evicted past maxSeries and maxBars", async () => {
  const clock = { now: T0 + 2_000 * STEP };
  const v = venue(clock);
  const cache = new ProviderCandleCache({ now: () => clock.now, maxSeries: 2, maxBars: 10_000 });
  const window = latest(clock, 100);
  await cache.read(request(v, ...window, { providerSymbol: "A" }));
  await cache.read(request(v, ...window, { providerSymbol: "B" }));
  await cache.read(request(v, ...window, { providerSymbol: "A" })); // A is now most recent
  await cache.read(request(v, ...window, { providerSymbol: "C" }));
  assert.equal(cache.size, 2);
  assert.equal((await cache.read(request(v, ...window, { providerSymbol: "A" }))).outcome, "hit");
  assert.equal((await cache.read(request(v, ...window, { providerSymbol: "B" }))).outcome, "miss");

  const byBars = new ProviderCandleCache({ now: () => clock.now, maxBars: 150 });
  await byBars.read(request(v, ...window, { providerSymbol: "A" }));
  await byBars.read(request(v, ...window, { providerSymbol: "B" }));
  assert.equal(byBars.size, 1);
  assert.ok(byBars.totalBars <= 150);
});

test("a failed fetch propagates and leaves the held entry untouched", async () => {
  const clock = { now: T0 + 2_000 * STEP + 60_000 };
  const v = venue(clock);
  const cache = new ProviderCandleCache({ now: () => clock.now, maxAgeMs: 60 * 60_000 });
  await cache.read(request(v, ...latest(clock, 500)));
  clock.now += STEP; // a bar closes, so the tail must be fetched
  const failing = async (): Promise<Candle[]> => { throw new Error("provider down"); };
  await assert.rejects(cache.read(request(v, ...latest(clock, 500), { fetch: failing })), /provider down/);
  const recovered = await cache.read(request(v, ...latest(clock, 500)));
  assert.equal(recovered.outcome, "partial");
  assert.deepEqual(recovered.rows, v.truth(...latest(clock, 500)));
});

test("concurrent reads of one series share one provider fetch", async () => {
  const clock = { now: T0 + 2_000 * STEP + 60_000 };
  const v = venue(clock);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const slow = async (s: number, e: number) => { await gate; return v.fetch(s, e); };
  const cache = new ProviderCandleCache({ now: () => clock.now });
  const reads = [0, 1, 2].map(() => cache.read(request(v, ...latest(clock, 1_000), { fetch: slow })));
  release();
  const results = await Promise.all(reads);
  assert.equal(v.calls.length, 1);
  assert.deepEqual(results.map((r) => r.outcome), ["miss", "hit", "hit"]);
  for (const r of results) assert.deepEqual(r.rows, results[0]!.rows);
});

test("data truth: any sequence of windows and clock steps serves exactly a full fetch", async () => {
  let seed = 7;
  const random = () => { seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31; return seed / 2 ** 31; };
  const outcomes = new Set<string>();
  for (const [forming, maxAgeMs] of [[false, 10 * 60_000], [false, 1e12], [true, 1e12]] as const) {
    const clock = { now: T0 + 40_000 * STEP };
    const v = venue(clock, { forming, gap: [T0 + 39_000 * STEP, T0 + 39_010 * STEP] });
    const cache = new ProviderCandleCache({ now: () => clock.now, maxAgeMs });
    for (let i = 0; i < 300; i += 1) {
      clock.now += Math.floor(random() * 2 * STEP);
      const limit = 1 + Math.floor(random() * 5_000);
      const end = random() < 0.7 ? clock.now : clock.now - Math.floor(random() * 3_000) * STEP;
      const window: [number, number] = [end - (limit - 1) * STEP, end];
      const result = await cache.read(request(v, ...window, { closedBarsOnly: !forming }));
      const expected = v.truth(...window);
      assert.deepEqual(result.rows.map((r) => [r.openTime, r.close]), expected.map((r) => [r.openTime, r.close]),
        `step ${i} (${result.outcome})`);
      outcomes.add(result.outcome);
    }
  }
  assert.deepEqual([...outcomes].sort(), ["hit", "miss", "partial"], "every path was exercised");
});

// ── Pagination ─────────────────────────────────────────────────────────────

test("kline windows are contiguous, disjoint and page-sized", () => {
  const start = T0 + 123;
  const end = start + 9_999 * STEP;
  const windows = klineWindows(start, end, STEP);
  assert.equal(windows.length, 10);
  assert.equal(windows[0]!.startMs, start);
  assert.equal(windows.at(-1)!.endMs, end);
  for (let i = 1; i < windows.length; i += 1) {
    assert.equal(windows[i]!.startMs, windows[i - 1]!.endMs + 1, "no gap, no overlap");
  }
  for (const w of windows) assert.ok(Math.floor((w.endMs - w.startMs) / STEP) + 1 <= 1_000);
  assert.deepEqual(klineWindows(end, start, STEP), []);
  assert.deepEqual(klineWindows(start, start, STEP), [{ startMs: start, endMs: start }]);
});

/** Honours startTime/endTime/limit like Binance; includes the forming kline. */
function fakeBinance(bars: number, step: number, base: number, stats: { calls: number; active: number; peak: number }) {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    stats.calls += 1; stats.active += 1; stats.peak = Math.max(stats.peak, stats.active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const startTime = Number(url.searchParams.get("startTime"));
    const endTime = Number(url.searchParams.get("endTime"));
    const limit = Number(url.searchParams.get("limit"));
    const rows: unknown[][] = [];
    for (let i = 0; i < bars && rows.length < limit; i += 1) {
      const openTime = base + i * step;
      if (openTime < startTime || openTime > endTime) continue;
      rows.push([openTime, "1", "100000", "0.5", String(i + 1), "10", openTime + step - 1, "10", 3, "0", "0", "0"]);
    }
    stats.active -= 1;
    return new Response(JSON.stringify(rows), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

test("fetchKlines fetches a 10,000-bar window's pages together and returns the identical series", async () => {
  const step = INTERVAL_MS["15m"];
  const now = Date.now();
  const base = Math.floor(now / step) * step - 9_999 * step; // the last bar is the forming one
  const stats = { calls: 0, active: 0, peak: 0 };
  const original = globalThis.fetch;
  globalThis.fetch = fakeBinance(10_000, step, base, stats);
  try {
    const rows = await fetchKlines("SOLUSDT", "15m", base, now);
    assert.equal(rows.length, 9_999, "every closed bar, and not the forming one");
    for (let i = 0; i < rows.length; i += 1) {
      assert.equal(rows[i]!.openTime, base + i * step, `bar ${i} in order, no gap, no duplicate`);
      assert.equal(rows[i]!.close, i + 1);
    }
    assert.equal(stats.calls, 10, "one request per page, no extra probe page");
    assert.ok(stats.peak > 1, "pages are in flight together");
    assert.ok(stats.peak <= KLINE_WINDOW_CONCURRENCY);
  } finally { globalThis.fetch = original; }
});

test("fetchKlines over a range before the listing and a short window still answers exactly", async () => {
  const step = INTERVAL_MS["1h"];
  const base = Date.UTC(2024, 0, 1);
  const stats = { calls: 0, active: 0, peak: 0 };
  const original = globalThis.fetch;
  globalThis.fetch = fakeBinance(1_500, step, base, stats);
  try {
    const rows = await fetchKlines("SOLUSDT", "1h", base - 3_000 * step, base + 1_499 * step);
    assert.equal(rows.length, 1_500);
    assert.equal(rows[0]!.openTime, base);
    assert.equal(rows.at(-1)!.openTime, base + 1_499 * step);
    const one = await fetchKlines("SOLUSDT", "1h", base + 10 * step, base + 10 * step);
    assert.deepEqual(one.map((r) => r.openTime), [base + 10 * step]);
  } finally { globalThis.fetch = original; }
});

// ── Pacer ──────────────────────────────────────────────────────────────────

test("the request pacer bounds concurrency and the sustained rate, and a pause holds everyone", async () => {
  let clock = 0;
  const slept: number[] = [];
  const pacer = new RequestPacer({ maxConcurrent: 2, ratePerSecond: 4, burst: 3,
    now: () => clock, sleep: async (ms) => { slept.push(ms); clock += ms; } });
  let active = 0; let peak = 0;
  const op = async () => {
    active += 1; peak = Math.max(peak, active);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
  };
  await Promise.all(Array.from({ length: 7 }, () => pacer.run(op)));
  assert.equal(peak, 2, "never more than maxConcurrent in flight");
  // 3 burst tokens, then 4 more at 4/s: at least one second of waiting.
  assert.ok(clock >= 1_000, `waited ${clock} ms`);

  pacer.pauseUntil(clock + 5_000);
  const before = clock;
  await pacer.run(async () => undefined);
  assert.ok(clock - before >= 5_000, "a provider rate-limit pause holds the next caller");
  assert.throws(() => new RequestPacer({ maxConcurrent: 0, ratePerSecond: 1, burst: 1 }));
});

// ── Abort ──────────────────────────────────────────────────────────────────

test("a queued paced request whose caller went away is never sent", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const pacer = new RequestPacer({ maxConcurrent: 1, ratePerSecond: 100, burst: 100 });
  let sent = 0;
  const first = pacer.run(async () => { sent += 1; await gate; });
  const controller = new AbortController();
  const queued = pacer.run(async () => { sent += 1; }, controller.signal);
  controller.abort();
  release();
  await first;
  await assert.rejects(queued, (error: Error) => error.name === "AbortError");
  assert.equal(sent, 1);
  assert.equal(pacer.inFlight, 0, "the abandoned caller's slot is released");
});

test("fetchKlines stops sending pages once its caller aborts", async () => {
  const step = INTERVAL_MS["1m"];
  const base = Date.UTC(2024, 0, 1);
  const stats = { calls: 0, active: 0, peak: 0 };
  const controller = new AbortController();
  const fake = fakeBinance(50_000, step, base, stats);
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (stats.calls === 0) controller.abort(); // the chart switched away mid-load
    init?.signal?.throwIfAborted();
    return fake(input, init);
  }) as typeof fetch;
  try {
    await assert.rejects(fetchKlines("SOLUSDT", "1m", base, base + 49_999 * step, controller.signal));
    assert.ok(stats.calls < 50, `only ${stats.calls} of 50 pages reached the venue`);
  } finally { globalThis.fetch = original; }
});

test("an aborted cache read stores nothing and the next reader fetches for itself", async () => {
  const clock = { now: T0 + 2_000 * STEP + 60_000 };
  const v = venue(clock);
  const cache = new ProviderCandleCache({ now: () => clock.now });
  const aborted = async (): Promise<Candle[]> => { throw new DOMException("gone", "AbortError"); };
  const first = cache.read(request(v, ...latest(clock, 500), { fetch: aborted }));
  const second = cache.read(request(v, ...latest(clock, 500)));
  await assert.rejects(first);
  const result = await second;
  assert.equal(result.outcome, "miss");
  assert.deepEqual(result.rows, v.truth(...latest(clock, 500)));
  assert.equal(cache.size, 1);
});

test("an abandoned provider call does not count against the provider's health", async () => {
  const registry = new ProviderRegistry();
  registry.register(createBinanceSpotAdapter({
    listSymbols: async () => [], metadata: async () => [], tickers: async () => [],
    candles: async () => { throw new DOMException("gone", "AbortError"); },
  }));
  for (let i = 0; i < 3; i += 1) {
    await assert.rejects(registry.candles("binance-spot", "BINANCE", "SOLUSDT", "1h", T0, T0 + STEP * 10));
  }
  assert.equal(registry.health("binance-spot").consecutiveFailures, 0);
  assert.notEqual(registry.health("binance-spot").state, "unavailable");
});

// ── Route ──────────────────────────────────────────────────────────────────

test("the canonical candles route serves a repeated chart window from the cache", async () => {
  const step = INTERVAL_MS["1d"];
  let calls = 0;
  const adapter = createBinanceSpotAdapter({
    listSymbols: async () => [{ symbol: "SOLUSDT", baseAsset: "SOL", quoteAsset: "USDT", status: "TRADING" }],
    metadata: async () => [],
    tickers: async () => [],
    candles: async (_symbol, _interval, startMs, endMs) => {
      calls += 1;
      const out: Candle[] = [];
      const now = Date.now();
      for (let t = Math.ceil(startMs / step) * step; t <= endMs; t += step) {
        if (t + step <= now) out.push({ ...bar(t, t / step, step), interval: "1d" });
      }
      return out;
    },
  });
  const registry = new ProviderRegistry();
  registry.register(adapter);
  const app = Fastify();
  await app.register(marketCatalogRoutesFor(registry));
  await app.ready();
  try {
    const id = "instrument:v1:BINANCE:spot:SOL:USDT:USDT:spot";
    const url = `/api/market/v1/candles/${encodeURIComponent(id)}?interval=1d&limit=2000&format=compact&purpose=chart`;
    const t1 = Date.now();
    const first = await app.inject({ method: "GET", url });
    const second = await app.inject({ method: "GET", url });
    const t2 = Date.now();
    assert.equal(first.statusCode, 200);
    assert.equal(first.headers["x-candle-cache"], "miss");
    assert.equal(first.json().bars.length, 1_998);
    assert.deepEqual(second.json().bars, first.json().bars);
    if (Math.floor(t1 / step) === Math.floor(t2 / step)) {
      assert.equal(second.headers["x-candle-cache"], "hit");
      assert.equal(calls, 1, "the second request made no provider call");
    }
  } finally { await app.close(); }
});

test("an adapter that does not declare closedBarsOnly keeps a fresh tail through the route", async () => {
  const definition = OFFICIAL_SPOT_DEFINITIONS.find((item) => item.id === "coinbase-spot")!;
  const step = INTERVAL_MS["1m"];
  let live = 100;
  let calls = 0;
  const registry = new ProviderRegistry();
  registry.register(createOfficialSpotAdapter(definition, {
    list: async () => [{ symbol: "BTC-USD", base: "BTC", quote: "USD", active: true, priceTick: 0.01, quantityLot: 0.00000001 }],
    tickers: async () => [],
    candles: async (_symbol, _interval, startMs, endMs) => {
      calls += 1;
      const out: Candle[] = [];
      for (let t = Math.ceil(startMs / step) * step; t <= Math.min(endMs, Date.now()); t += step) {
        out.push({ symbol: "BTC-USD", interval: "1m", openTime: t, closeTime: t + step - 1,
          open: 1, high: 1_000, low: 1, close: t + step <= Date.now() ? 1 : live, volume: 1 });
      }
      return out;
    },
  }));
  const app = Fastify();
  await app.register(marketCatalogRoutesFor(registry));
  await app.ready();
  try {
    const id = "instrument:v1:COINBASE:spot:BTC:USD:USD:spot";
    const url = `/api/market/v1/candles/${encodeURIComponent(id)}?interval=1m&limit=50&format=compact`;
    await app.inject({ method: "GET", url });
    live = 123;
    const second = await app.inject({ method: "GET", url });
    assert.equal(second.headers["x-candle-cache"], "partial");
    assert.equal(calls, 2);
    assert.equal(second.json().bars.at(-1)[4], 123, "the forming bar's close is the venue's latest");
  } finally { await app.close(); }
});

// Last in the file: it leaves the process-wide kline pacer paused.
test("a response reporting the address's weight near its budget pauses kline paging", async () => {
  const step = INTERVAL_MS["1h"];
  const base = Date.UTC(2024, 0, 1);
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify([
    [base, "1", "2", "0.5", "1.5", "10", base + step - 1, "10", 3, "0", "0", "0"],
  ]), { status: 200, headers: { "content-type": "application/json",
    "x-mbx-used-weight-1m": String(USED_WEIGHT_SOFT_LIMIT) } })) as typeof fetch;
  try {
    const before = Date.now();
    const rows = await fetchKlines("SOLUSDT", "1h", base, base);
    assert.equal(rows.length, 1);
    assert.ok(klinePacer.pausedUntilMs > before, "the next page waits for the next minute's budget");
    assert.ok(klinePacer.pausedUntilMs <= before + 62_000);
  } finally { globalThis.fetch = original; }
});
