import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_OVERLAY_PREFERENCES, TradingOverlayCache, anchorTradingOverlays, compactOverlaySource,
  mergeOverlayResponses, overlayChartContextKey, overlayItemVisible, overlayRequestKey, requestedOverlayRange,
  splitOverlayResponse, type TradingOverlayItem, type TradingOverlayResponse,
} from "../lib/tradingOverlays";
import type { Candle } from "../lib/types";

const T0 = Date.UTC(2026, 8, 1, 12);
const candle = (openTime: number, duration = 60_000): Candle => ({
  symbol: "BTCUSDT", interval: "1m", openTime, closeTime: openTime + duration - 1,
  open: 100, high: 102, low: 99, close: 101, volume: 2,
});
const item = (overrides: Partial<TradingOverlayItem> = {}): TradingOverlayItem => ({
  id: "execution:1", kind: "HISTORICAL_ACTIVITY_MARKER",
  evidenceClass: "AUTHORITATIVE_HISTORICAL_EVENT", evidenceKind: "PERSISTED_EXECUTION_SNAPSHOT",
  source: "AUTOMATED", environment: "REAL", symbol: "BTCUSDT", side: "BUY",
  eventTime: new Date(T0 + 30_000).toISOString(), observedAt: null, price: 100,
  quantity: 1, state: "filled", orderType: "MARKET", completeness: "INCOMPLETE",
  detail: "Order-level activity", identifiers: { executionId: "1" },
  provenance: { deploymentId: "dep-1", strategy: { id: "7", key: "ma", name: "MA" },
    config: { id: "cfg-1", name: "Prod" } }, ...overrides,
});
const response = (items: TradingOverlayItem[]): TradingOverlayResponse => ({
  symbol: "BTCUSDT", range: { from: new Date(T0).toISOString(),
    to: new Date(T0 + 120_000).toISOString(), replayCutoff: null },
  items, truncated: false, limit: 300, limitations: [],
});

test("event anchors only to the actual containing loaded candle", () => {
  const candles = [candle(T0), candle(T0 + 120_000)];
  assert.equal(anchorTradingOverlays([item()], candles)[0]?.anchorTime, T0 / 1000);
  const gap = item({ id: "gap", eventTime: new Date(T0 + 90_000).toISOString() });
  assert.equal(anchorTradingOverlays([gap], candles).length, 0,
    "a gap event is not moved to the nearest or future candle");
  const outside = item({ id: "outside", eventTime: new Date(T0 - 1).toISOString() });
  assert.equal(anchorTradingOverlays([outside], candles).length, 0);
});

test("timeframe changes preserve identity and deterministically re-anchor", () => {
  const evidence = item({ eventTime: new Date(T0 + 90_000).toISOString() });
  const oneMinute = anchorTradingOverlays([evidence], [candle(T0), candle(T0 + 60_000)])[0]!;
  const fiveMinute = anchorTradingOverlays([evidence], [candle(T0, 300_000)])[0]!;
  assert.equal(oneMinute.id, fiveMinute.id);
  assert.equal(oneMinute.anchorTime, (T0 + 60_000) / 1000);
  assert.equal(fiveMinute.anchorTime, T0 / 1000);
});

test("display toggles filter only rendering and never mutate authoritative data", () => {
  const paper = item({ id: "paper-fill:1", source: "PAPER", environment: "PAPER",
    kind: "PAPER_FILL_MARKER" });
  const original = JSON.stringify(paper);
  assert.equal(overlayItemVisible(paper, DEFAULT_OVERLAY_PREFERENCES), true);
  assert.equal(overlayItemVisible(paper, { ...DEFAULT_OVERLAY_PREFERENCES, paper: false }), false);
  assert.equal(overlayItemVisible(item({ kind: "POSITION_LINE" }),
    { ...DEFAULT_OVERLAY_PREFERENCES, positions: false }), false);
  assert.equal(JSON.stringify(paper), original);
  assert.equal(compactOverlaySource(item()), "A·REAL");
  assert.equal(compactOverlaySource(paper), "P·PAPER");
  assert.equal(compactOverlaySource(item({ source: "MANUAL", environment: "DRY_RUN" })), "M·DRY_RUN");
});

test("request identity keys exact symbol, range, scope and Replay cutoff", () => {
  const base = { symbol: "BTCUSDT", from: T0, to: T0 + 1000, replayCutoff: null, scope: "historical" };
  const live = overlayRequestKey(base);
  assert.notEqual(live, overlayRequestKey({ ...base, symbol: "ETHUSDT" }));
  assert.notEqual(live, overlayRequestKey({ ...base, replayCutoff: T0 + 500 }));
  assert.notEqual(live, overlayRequestKey({ ...base, scope: "current" }));
  assert.notEqual(overlayRequestKey({ ...base, replayCutoff: T0 + 900 }),
    overlayRequestKey({ ...base, replayCutoff: T0 + 400 }),
    "a rewind cannot reuse a later-cutoff response");
  assert.notEqual(overlayChartContextKey("BTCUSDT", "1m", null),
    overlayChartContextKey("BTCUSDT", "5m", null));
  assert.notEqual(overlayChartContextKey("BTCUSDT", "5m", T0 + 900),
    overlayChartContextKey("BTCUSDT", "5m", T0 + 400));
});

test("requested range is loaded, buffered, capped and Replay-bounded", () => {
  const candles = Array.from({ length: 30 }, (_, index) => candle(T0 + index * 60_000));
  const range = requestedOverlayRange(candles, { from: (T0 + 10 * 60_000) / 1000,
    to: (T0 + 12 * 60_000) / 1000 }, 60_000, T0 + 11 * 60_000 + 59_999)!;
  assert.equal(range.from, T0);
  assert.equal(range.to, T0 + 11 * 60_000 + 59_999);
});

test("history/current merge stays distinct and cache suppresses unchanged settled reads", () => {
  const history = response([item()]);
  const currentItem = item({ id: "order:1", kind: "ACTIVE_ORDER_LINE", eventTime: null,
    observedAt: new Date(T0 + 1000).toISOString(), evidenceClass: "CURRENT_AUTHORITATIVE_STATE" });
  const split = splitOverlayResponse(response([item(), currentItem]));
  assert.deepEqual(split.historical.items.map((entry) => entry.id), ["execution:1"]);
  assert.deepEqual(split.current.items.map((entry) => entry.id), ["order:1"]);
  assert.equal(mergeOverlayResponses(history, split.current)?.items.length, 2);
  const cache = new TradingOverlayCache(2);
  cache.set("same-range", history);
  assert.equal(cache.get("same-range"), history);
  cache.set("second", history); cache.set("third", history);
  assert.equal(cache.get("same-range"), undefined);
  assert.equal(cache.size, 2);
});
