/**
 * Equivalent history loads happen once.
 *
 * The chart page and the old split pane each ran their own `api.candles(...)`
 * loader, so two panes on one symbol and resolution pulled the same ten
 * thousand bars twice — and sixteen would have pulled them sixteen times, on
 * every symbol change. The cache keys a load by exactly what makes two of them
 * equivalent, and everything below drives it with a stub loader so the counts
 * are exact and nothing reaches the network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  CandleHistoryCache, historyKey, type HistoryRequest,
} from "../lib/candleHistory";
import type { Candle, Interval } from "../lib/types";

const ROOT = path.join(__dirname, "..");

const bar = (symbol: string, interval: Interval, openTime: number, close = 1): Candle => ({
  symbol, interval, openTime, closeTime: openTime + 59_999,
  open: 1, high: 2, low: 0.5, close, volume: 10,
});

const window_ = (
  symbol: string, interval: Interval, bars = 1000
): HistoryRequest => ({ symbol, interval, bars });

/** A loader that counts calls and resolves when the test says so. */
function stubLoader() {
  const calls: HistoryRequest[] = [];
  const pending: Array<{ request: HistoryRequest; resolve: (c: Candle[]) => void;
    reject: (e: unknown) => void; aborted: () => boolean }> = [];
  const loader = (request: HistoryRequest, signal: AbortSignal): Promise<Candle[]> => {
    calls.push(request);
    return new Promise<Candle[]>((resolve, reject) => {
      pending.push({ request, resolve, reject, aborted: () => signal.aborted });
    });
  };
  return { loader, calls, pending };
}

test("the cache key is symbol, interval and depth — and nothing else", () => {
  assert.equal(historyKey(window_("solusdt", "15m", 1000)), "SOLUSDT|15m|1000");
  assert.equal(historyKey(window_("SOLUSDT", "15m", 1000)), "SOLUSDT|15m|1000");
  assert.notEqual(historyKey(window_("SOLUSDT", "15m", 1000)),
    historyKey(window_("SOLUSDT", "15m", 2000)));
  assert.notEqual(historyKey(window_("SOLUSDT", "15m")), historyKey(window_("SOLUSDT", "1h")));
  assert.notEqual(historyKey(window_("SOLUSDT", "15m")), historyKey(window_("BTCUSDT", "15m")));
});

test("SIXTEEN EQUIVALENT REQUESTS PRODUCE ONE LOAD", async () => {
  const cache = new CandleHistoryCache();
  const { loader, calls, pending } = stubLoader();
  const waiting = Array.from({ length: 16 }, () =>
    cache.load(window_("SOLUSDT", "15m"), loader));

  assert.equal(calls.length, 1, "an equivalent in-flight load was not joined");
  assert.equal(cache.inFlight, 1);

  const data = [bar("SOLUSDT", "15m", 1000), bar("SOLUSDT", "15m", 61_000)];
  pending[0]!.resolve(data);
  const results = await Promise.all(waiting);
  // Every waiter gets the same array, not sixteen copies of it.
  for (const result of results) assert.equal(result, data);
  assert.equal(cache.loadCount, 1);
  assert.equal(cache.hitCount, 15);
  assert.equal(cache.inFlight, 0);
});

test("a completed load is reused, and peek answers without waiting", async () => {
  const cache = new CandleHistoryCache();
  const { loader, calls, pending } = stubLoader();
  const first = cache.load(window_("SOLUSDT", "15m"), loader);
  pending[0]!.resolve([bar("SOLUSDT", "15m", 1000)]);
  await first;

  assert.equal(cache.peek(window_("SOLUSDT", "15m"))!.length, 1);
  await cache.load(window_("SOLUSDT", "15m"), loader);
  assert.equal(calls.length, 1, "a cached window was fetched again");
  // A different depth is a different window and does load.
  void cache.load(window_("SOLUSDT", "15m", 2000), loader);
  assert.equal(calls.length, 2);
  pending[1]!.resolve([]);
});

test("different windows never contaminate one another", async () => {
  const cache = new CandleHistoryCache();
  const { loader, pending } = stubLoader();
  const sol = cache.load(window_("SOLUSDT", "15m"), loader);
  const btc = cache.load(window_("BTCUSDT", "15m"), loader);
  const hourly = cache.load(window_("SOLUSDT", "1h"), loader);
  assert.equal(cache.inFlight, 3);

  // Resolve out of order, which is the case that used to paint one symbol's
  // candles under another symbol's label.
  pending[1]!.resolve([bar("BTCUSDT", "15m", 1000, 60_000)]);
  pending[2]!.resolve([bar("SOLUSDT", "1h", 1000, 200)]);
  pending[0]!.resolve([bar("SOLUSDT", "15m", 1000, 150)]);

  assert.equal((await sol)[0]!.close, 150);
  assert.equal((await btc)[0]!.close, 60_000);
  assert.equal((await hourly)[0]!.close, 200);
  assert.equal(cache.peek(window_("SOLUSDT", "15m"))![0]!.symbol, "SOLUSDT");
  assert.equal(cache.peek(window_("BTCUSDT", "15m"))![0]!.symbol, "BTCUSDT");
});

test("a live bar is folded only into the window it belongs to", async () => {
  const cache = new CandleHistoryCache();
  const { loader, pending } = stubLoader();
  const loads = [
    cache.load(window_("SOLUSDT", "15m"), loader),
    cache.load(window_("SOLUSDT", "1h"), loader),
    cache.load(window_("BTCUSDT", "15m"), loader),
  ];
  pending[0]!.resolve([bar("SOLUSDT", "15m", 1000, 100)]);
  pending[1]!.resolve([bar("SOLUSDT", "1h", 1000, 100)]);
  pending[2]!.resolve([bar("BTCUSDT", "15m", 1000, 100)]);
  await Promise.all(loads);

  // A newer 15m SOL bar.
  cache.applyLiveBar("solusdt", "15m", bar("SOLUSDT", "15m", 61_000, 111));
  assert.equal(cache.peek(window_("SOLUSDT", "15m"))!.length, 2);
  assert.equal(cache.peek(window_("SOLUSDT", "1h"))!.length, 1, "a 15m bar reached the 1h window");
  assert.equal(cache.peek(window_("BTCUSDT", "15m"))!.length, 1, "a SOL bar reached BTCUSDT");

  // Updating the forming bar replaces it rather than appending a duplicate.
  cache.applyLiveBar("SOLUSDT", "15m", bar("SOLUSDT", "15m", 61_000, 222));
  const solWindow = cache.peek(window_("SOLUSDT", "15m"))!;
  assert.equal(solWindow.length, 2);
  assert.equal(solWindow[1]!.close, 222);

  // A bar older than the window's head is not spliced into the middle.
  cache.applyLiveBar("SOLUSDT", "15m", bar("SOLUSDT", "15m", 500, 9));
  assert.equal(cache.peek(window_("SOLUSDT", "15m"))!.length, 2);
});

test("memory is bounded: the oldest windows are evicted", async () => {
  const cache = new CandleHistoryCache({ maxEntries: 3 });
  for (const symbol of ["A", "B", "C", "D", "E"]) {
    cache.store(window_(`${symbol}USDT`, "15m"), [bar(`${symbol}USDT`, "15m", 1000)]);
  }
  assert.equal(cache.size, 3);
  assert.equal(cache.peek(window_("AUSDT", "15m")), null);
  assert.equal(cache.peek(window_("BUSDT", "15m")), null);
  assert.ok(cache.peek(window_("EUSDT", "15m")));
});

test("a cached window expires rather than serving an old chart forever", () => {
  let now = 1_000_000;
  const cache = new CandleHistoryCache({ ttlMs: 10_000, now: () => now });
  cache.store(window_("SOLUSDT", "15m"), [bar("SOLUSDT", "15m", 1000)]);
  assert.ok(cache.peek(window_("SOLUSDT", "15m")));
  now += 9_999;
  assert.ok(cache.peek(window_("SOLUSDT", "15m")));
  now += 2;
  assert.equal(cache.peek(window_("SOLUSDT", "15m")), null);
});

test("ONE PANE LEAVING DOES NOT CANCEL A LOAD ANOTHER PANE IS WAITING FOR", async () => {
  const cache = new CandleHistoryCache();
  const { loader, pending } = stubLoader();
  const leaving = new AbortController();
  const staying = cache.load(window_("SOLUSDT", "15m"), loader);
  const abandoned = cache.load(window_("SOLUSDT", "15m"), loader, leaving.signal)
    .then(() => "resolved").catch((e: Error) => e.name);

  leaving.abort();
  assert.equal(await abandoned, "AbortError", "the leaving pane kept waiting");
  assert.equal(pending[0]!.aborted(), false, "the shared request was cancelled underneath a waiter");

  pending[0]!.resolve([bar("SOLUSDT", "15m", 1000)]);
  assert.equal((await staying).length, 1);
});

test("the last pane leaving cancels the request rather than finishing into nothing", async () => {
  const cache = new CandleHistoryCache();
  const { loader, pending } = stubLoader();
  const only = new AbortController();
  const abandoned = cache.load(window_("SOLUSDT", "15m"), loader, only.signal)
    .catch((e: Error) => e.name);
  only.abort();
  assert.equal(await abandoned, "AbortError");
  assert.equal(pending[0]!.aborted(), true, "a multi-megabyte load nobody wants kept running");
  assert.equal(cache.inFlight, 0);
});

test("a failed load is not cached, so the next pane retries", async () => {
  const cache = new CandleHistoryCache();
  const { loader, calls, pending } = stubLoader();
  const failing = cache.load(window_("SOLUSDT", "15m"), loader).catch((e: Error) => e.message);
  pending[0]!.reject(new Error("backend offline"));
  assert.equal(await failing, "backend offline");
  assert.equal(cache.peek(window_("SOLUSDT", "15m")), null);

  void cache.load(window_("SOLUSDT", "15m"), loader);
  assert.equal(calls.length, 2);
  pending[1]!.resolve([]);
});

test("THE PANES AND THE PAGE SHARE ONE HISTORY PATH", () => {
  /*
   * The split pane had its own copy of the loader that re-requested the WHOLE
   * window after a backfill instead of only the missing head, with no abort
   * and no stale-response guard. One implementation is the fix; these pin that
   * there is still only one.
   */
  const hook = fs.readFileSync(path.join(ROOT, "lib", "useCandleHistory.ts"), "utf8");
  const pane = fs.readFileSync(path.join(ROOT, "components", "tv", "ChartPane.tsx"), "utf8");
  const page = fs.readFileSync(path.join(ROOT, "app", "chart", "page.tsx"), "utf8");

  assert.match(hook, /candleHistory\.load\(window_, loadCandleWindow, signal\)/);
  assert.match(hook, /api\.backfill\(/);
  assert.match(hook, /api\.candlesRange\(/);
  assert.match(pane, /useCandleHistory\(\{/);
  assert.match(page, /useCandleHistory\(\{ symbol, interval, bars \}\)/);
  // No component fetches candles for itself any more.
  for (const [name, source] of [["ChartPane", pane], ["the chart page", page]] as const) {
    assert.ok(!/api\.candles\(/.test(source), `${name} still loads its own candles`);
  }
});
