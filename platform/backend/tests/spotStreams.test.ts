import assert from "node:assert/strict";
import test from "node:test";
import { parseSpotStreamFrame, resolveSpotStreamRequest, spotStreamRequest } from "../src/market/spotStreams";

const T = 1_788_955_200_000;

test("all public X1 stream requests use official websocket origins and explicit subscriptions", () => {
  for (const id of ["binance-spot", "coinbase-spot", "bybit-spot", "okx-spot", "kraken-spot",
    "kucoin-spot", "gateio-spot", "hyperliquid-spot"]) {
    for (const kind of ["ticker", "candle"] as const) {
      const request = spotStreamRequest(id, kind, id === "hyperliquid-spot" ? "PURR/USDC" : "BTC-USDT", "1m");
      assert.ok(request.origins.length > 0);
      assert.ok(request.origins.every((origin) => /^wss:\/\//.test(origin)));
      if (id !== "binance-spot") assert.ok(request.subscribeMessage);
      assert.equal(request.requiresBootstrapToken, id === "kucoin-spot");
    }
  }
});

test("provider candle frames normalize to UTC milliseconds and exact OHLCV", () => {
  const fixtures: Array<[string, string]> = [
    ["binance-spot", JSON.stringify({ E: T, k: { t: T, o: "1", h: "3", l: "0.5", c: "2", v: "4", x: true } })],
    ["coinbase-spot", JSON.stringify({ type: "snapshot", candles: [[T / 1000, "0.5", "3", "1", "2", "4"]] })],
    ["bybit-spot", JSON.stringify({ ts: T, data: [{ start: T, open: "1", high: "3", low: "0.5", close: "2", volume: "4", confirm: true }] })],
    ["okx-spot", JSON.stringify({ arg: { instId: "BTC-USDT" }, data: [[String(T), "1", "3", "0.5", "2", "4", "0", "0", "1"]] })],
    ["kraken-spot", JSON.stringify({ channel: "ohlc", data: [{ interval_begin: new Date(T).toISOString(), open: 1, high: 3, low: 0.5, close: 2, volume: 4 }] })],
    ["kucoin-spot", JSON.stringify({ data: { candles: [String(T / 1000), "1", "2", "3", "0.5", "4"] } })],
    ["gateio-spot", JSON.stringify({ time_ms: T, result: { t: T / 1000, o: "1", h: "3", l: "0.5", c: "2", v: "4", w: true } })],
    ["hyperliquid-spot", JSON.stringify({ channel: "candle", data: { t: T, o: "1", h: "3", l: "0.5", c: "2", v: "4" } })],
  ];
  for (const [provider, raw] of fixtures) {
    const event = parseSpotStreamFrame(provider, "candle", raw, "BTC-USDT", "1m");
    assert.equal(event?.kind, "candle", provider);
    if (event?.kind === "candle") assert.deepEqual(
      [event.candle.openTime, event.candle.open, event.candle.high, event.candle.low, event.candle.close, event.candle.volume],
      [T, 1, 3, 0.5, 2, 4], provider);
  }
});

test("malformed/control frames are ignored instead of poisoning another update", () => {
  assert.equal(parseSpotStreamFrame("coinbase-spot", "ticker", "not-json", "BTC-USD"), null);
  assert.equal(parseSpotStreamFrame("okx-spot", "candle", JSON.stringify({ event: "subscribe" }), "BTC-USDT"), null);
});

test("KuCoin public stream bootstrap is bounded to the official endpoint", async () => {
  let calls = 0;
  const request = await resolveSpotStreamRequest("kucoin-spot", "ticker", "BTC-USDT", "1m",
    async (url, init) => {
      calls += 1;
      assert.equal(url, "https://api.kucoin.com/api/v1/bullet-public");
      assert.equal(init?.method, "POST");
      return new Response(JSON.stringify({ data: { token: "fixture-token",
        instanceServers: [{ endpoint: "wss://ws-api-spot.kucoin.com/endpoint" }] } }), { status: 200 });
    });
  assert.equal(calls, 1);
  assert.deepEqual(request.origins, ["wss://ws-api-spot.kucoin.com"]);
  assert.match(request.path, /^\/endpoint\?token=fixture-token&connectId=market-v1-/);
  assert.equal(request.requiresBootstrapToken, false);
});
