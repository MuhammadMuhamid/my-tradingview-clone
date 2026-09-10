import assert from "node:assert/strict";
import test from "node:test";
import { parseCanonicalMarketFrame } from "../lib/canonicalMarketStream";
import type { MarketStreamConfig } from "../lib/api";
import { heldWindow, mergeLiveBarsInto } from "../lib/useCandleHistory";

const T = 1_788_955_200_000;
const ID = "instrument:v1:COINBASE:spot:BTC:USD:USD:spot";

function config(providerId: string): MarketStreamConfig {
  return { contractVersion: "market.v1", canonicalId: ID, providerId, providerSymbol: "BTC-USD",
    interval: "1m", request: { origins: ["wss://example.test"], path: "/ws",
      subscribeMessage: "{}", requiresBootstrapToken: false } };
}

test("all public provider candle frames normalize to canonical identity and UTC milliseconds", () => {
  const fixtures: Array<[string, string]> = [
    ["binance-spot", JSON.stringify({ E: T, k: { t: T, o: "1", h: "3", l: "0.5", c: "2", v: "4", x: true } })],
    ["coinbase-spot", JSON.stringify({ candles: [[T / 1000, "0.5", "3", "1", "2", "4"]] })],
    ["bybit-spot", JSON.stringify({ ts: T, data: [{ start: T, open: "1", high: "3", low: "0.5", close: "2", volume: "4", confirm: true }] })],
    ["okx-spot", JSON.stringify({ data: [[String(T), "1", "3", "0.5", "2", "4", "0", "0", "1"]] })],
    ["kraken-spot", JSON.stringify({ data: [{ interval_begin: new Date(T).toISOString(), open: 1, high: 3, low: 0.5, close: 2, volume: 4 }] })],
    ["kucoin-spot", JSON.stringify({ data: { candles: [String(T / 1000), "1", "2", "3", "0.5", "4"] } })],
    ["gateio-spot", JSON.stringify({ result: { t: T / 1000, o: "1", h: "3", l: "0.5", c: "2", v: "4" } })],
    ["hyperliquid-spot", JSON.stringify({ data: { t: T, o: "1", h: "3", l: "0.5", c: "2", v: "4" } })],
  ];
  for (const [provider, raw] of fixtures) {
    const event = parseCanonicalMarketFrame(config(provider), "candle", raw, "1m");
    assert.equal(event?.kind, "candle", provider);
    if (event?.kind === "candle") assert.deepEqual(
      [event.candle.symbol, event.candle.openTime, event.candle.open, event.candle.high,
        event.candle.low, event.candle.close, event.candle.volume],
      [ID, T, 1, 3, 0.5, 2, 4], provider);
  }
});

test("a reconnect replay replaces its open-time bar and cannot duplicate it", () => {
  const first = parseCanonicalMarketFrame(config("bybit-spot"), "candle", JSON.stringify({ ts: T,
    data: [{ start: T, open: "1", high: "3", low: "0.5", close: "2", volume: "4" }] }), "1m");
  const replay = parseCanonicalMarketFrame(config("bybit-spot"), "candle", JSON.stringify({ ts: T + 1,
    data: [{ start: T, open: "1", high: "4", low: "0.5", close: "3", volume: "5" }] }), "1m");
  assert.equal(first?.kind, "candle"); assert.equal(replay?.kind, "candle");
  if (first?.kind !== "candle" || replay?.kind !== "candle") return;
  const initial = heldWindow([first.candle], { symbol: ID, interval: "1m", bars: 100 }, T);
  const merged = mergeLiveBarsInto(initial, null, replay.candle);
  assert.equal(merged.candles.length, 1);
  assert.equal(merged.candles[0]!.close, 3);
});

test("control, malformed, and invalid OHLC frames do not poison the feed", () => {
  assert.equal(parseCanonicalMarketFrame(config("coinbase-spot"), "ticker", "not-json", "1m"), null);
  assert.equal(parseCanonicalMarketFrame(config("okx-spot"), "candle", JSON.stringify({ event: "subscribe" }), "1m"), null);
  assert.equal(parseCanonicalMarketFrame(config("hyperliquid-spot"), "candle",
    JSON.stringify({ data: { t: T, o: "3", h: "2", l: "1", c: "3", v: "4" } }), "1m"), null);
});
