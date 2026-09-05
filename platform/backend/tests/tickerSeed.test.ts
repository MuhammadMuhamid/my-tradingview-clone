/**
 * The watchlist's same-origin seed.
 *
 * The browser used to show `—` in every watchlist row until the first
 * `@miniTicker` frame arrived, and forever on a network where Binance's stream
 * host refuses the handshake. `/api/symbols/tickers` gives the rows a real
 * quote through the backend's own market-data host before any socket opens.
 *
 * Nothing here reaches Binance: the upstream reader is injected.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { symbolRoutes } from "../src/api/routes/symbols";
import { fetch24hTickers, TICKER_BATCH_LIMIT, type Ticker24h } from "../src/data/binanceRest";

async function server(deps: {
  tickers: (symbols: readonly string[]) => Promise<Ticker24h[]>;
  now?: () => number;
}) {
  const app = Fastify({ logger: false });
  await app.register(symbolRoutes(deps));
  return app;
}

test("the seed returns one row per symbol and validates its input", async (t) => {
  const asked: string[][] = [];
  const app = await server({
    tickers: async (symbols) => {
      asked.push([...symbols]);
      return symbols.map((symbol, i) => ({ symbol, last: 100 + i, open: 90 + i, at: 1_700_000_000_000 }));
    },
  });
  t.after(() => app.close());

  const ok = await app.inject({ method: "GET", url: "/api/symbols/tickers?symbols=btcusdt,ETHUSDT,btcusdt" });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.json(), [
    { symbol: "BTCUSDT", last: 100, open: 90, at: 1_700_000_000_000 },
    { symbol: "ETHUSDT", last: 101, open: 91, at: 1_700_000_000_000 },
  ]);
  assert.deepEqual(asked, [["BTCUSDT", "ETHUSDT"]], "duplicates and case are normalised before the upstream call");

  const empty = await app.inject({ method: "GET", url: "/api/symbols/tickers" });
  assert.equal(empty.statusCode, 400);
  const injected = await app.inject({ method: "GET", url: "/api/symbols/tickers?symbols=BTCUSDT%26x=1" });
  assert.equal(injected.statusCode, 400, "a symbol is a ticker, never a query fragment");
  const tooMany = await app.inject({
    method: "GET",
    url: `/api/symbols/tickers?symbols=${Array.from({ length: TICKER_BATCH_LIMIT + 1 }, (_, i) => `S${i}USDT`).join(",")}`,
  });
  assert.equal(tooMany.statusCode, 400);
});

test("an identical request within the cache window does not go upstream again", async (t) => {
  let clock = 1_000_000;
  let calls = 0;
  const app = await server({
    tickers: async (symbols) => { calls += 1; return symbols.map((symbol) => ({ symbol, last: 1, open: 1, at: clock })); },
    now: () => clock,
  });
  t.after(() => app.close());

  await app.inject({ method: "GET", url: "/api/symbols/tickers?symbols=BTCUSDT,ETHUSDT" });
  await app.inject({ method: "GET", url: "/api/symbols/tickers?symbols=ETHUSDT,BTCUSDT" });
  assert.equal(calls, 1, "the same set in another order is the same request");
  clock += 10_000;
  await app.inject({ method: "GET", url: "/api/symbols/tickers?symbols=BTCUSDT,ETHUSDT" });
  assert.equal(calls, 2, "the cache expired and the seed was refreshed");
});

test("an upstream failure is a 502 with a plain reason, not a crash or a fake quote", async (t) => {
  const app = await server({ tickers: async () => { throw new Error("Binance 451: unavailable for legal reasons"); } });
  t.after(() => app.close());
  const res = await app.inject({ method: "GET", url: "/api/symbols/tickers?symbols=BTCUSDT" });
  assert.equal(res.statusCode, 502);
  assert.match(res.json().error, /market-data host/);
});

test("the upstream reader asks the configured host for the batch form and drops unparseable rows", async () => {
  const urls: string[] = [];
  const rows = await fetch24hTickers(["btcusdt", "ETHUSDT", "BTCUSDT"], async (url) => {
    urls.push(url);
    return [
      { symbol: "BTCUSDT", lastPrice: "65000.10", openPrice: "64000", closeTime: 5 },
      { symbol: "ETHUSDT", lastPrice: "not-a-number", openPrice: "1", closeTime: 5 },
    ];
  });
  assert.equal(urls.length, 1);
  assert.match(urls[0]!, /^https:\/\/api\.binance\.com\/api\/v3\/ticker\/24hr\?symbols=/);
  assert.equal(decodeURIComponent(urls[0]!.split("symbols=")[1]!), '["BTCUSDT","ETHUSDT"]');
  assert.deepEqual(rows, [{ symbol: "BTCUSDT", last: 65000.1, open: 64000, at: 5 }]);
  await assert.rejects(() => fetch24hTickers(["bad symbol"], async () => []), /invalid symbol/);
  assert.deepEqual(await fetch24hTickers([], async () => { throw new Error("must not be called"); }), []);
});
