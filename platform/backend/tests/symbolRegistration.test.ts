/**
 * `POST /api/symbols` writes the SHARED symbols table every account reads, and
 * ordinary accounts reach it. So the row's assets come from the venue and never
 * from the request body, a pair the venue does not list is never written, and
 * the suffix guess is used only while the directory is unavailable, for a pair
 * that has no row yet — and the response says it was a guess.
 *
 * Nothing here reaches Binance or PostgreSQL: every dependency is injected.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { symbolRoutes, type SymbolRouteDeps } from "../src/api/routes/symbols";
import type { SymbolInfo } from "../src/types/market";

function row(symbol: string, baseAsset: string, quoteAsset: string): SymbolInfo {
  return {
    symbol, baseAsset, quoteAsset, priceTick: null, qtyStep: null, minNotional: null,
    isActive: true, venue: "BINANCE", assetClass: "crypto_spot",
  };
}

function harness(t: TestContext, deps: Pick<SymbolRouteDeps, "ensureMetadata" | "getSymbol">) {
  const added: Array<[string, string, string]> = [];
  const app = Fastify({ logger: false });
  t.after(() => app.close());
  const ready = app.register(symbolRoutes({
    tickers: async () => [],
    ...deps,
    addSymbol: async (symbol, base, quote) => { added.push([symbol, base, quote]); return row(symbol, base, quote); },
  }));
  const register = async (payload: object) => { await ready; return app.inject({ method: "POST", url: "/api/symbols", payload }); };
  return { register, added };
}

const unavailable = async (): Promise<never> => { throw new Error("Binance 503: service unavailable"); };

test("an invalid ticker is a 400 naming the problem, before any lookup", async (t) => {
  let asked = 0;
  const { register, added } = harness(t, {
    ensureMetadata: async () => { asked += 1; return []; },
    getSymbol: async () => null,
  });
  const res = await register({ symbol: "NYSE:IBM", baseAsset: "IBM", quoteAsset: "USD" });
  assert.equal(res.statusCode, 400);
  assert.ok(res.json().error.length > 0);
  assert.equal((await register({})).statusCode, 400);
  assert.equal(asked, 0);
  assert.deepEqual(added, []);
});

test("the venue's metadata is the row, whatever the body claimed", async (t) => {
  const { register, added } = harness(t, {
    ensureMetadata: async (symbols) => symbols.map((s) => row(s, "ETH", "BTC")),
    getSymbol: async () => null,
  });
  const res = await register({ symbol: "ethbtc", baseAsset: "ETHB", quoteAsset: "USDT" });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json().symbol, "ETHBTC");
  assert.equal(res.json().baseAsset, "ETH");
  assert.equal(res.json().quoteAsset, "BTC");
  assert.equal(res.json().degraded, undefined);
  assert.deepEqual(added, [], "metadata registration writes through its own path, never the body's assets");
});

test("a pair the venue does not list is a 404 and nothing is written", async (t) => {
  const { register, added } = harness(t, {
    ensureMetadata: async () => [null],
    getSymbol: async () => null,
  });
  const res = await register({ symbol: "NOTACOINUSDT", baseAsset: "NOTACOIN", quoteAsset: "USDT" });
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.json(), { error: "NOTACOINUSDT is not a Binance spot symbol" });
  assert.deepEqual(added, []);

  // Binance's own answer for an unlisted pair is HTTP 400 / -1121, which the
  // REST reader throws. That is the directory answering, not being down.
  const refused = harness(t, {
    ensureMetadata: async () => { throw new Error('Binance 400: {"code":-1121,"msg":"Invalid symbol."}'); },
    getSymbol: async () => null,
  });
  const res2 = await refused.register({ symbol: "NOTACOINUSDT" });
  assert.equal(res2.statusCode, 404);
  assert.deepEqual(refused.added, []);
});

test("directory unavailable and the row exists: it is returned untouched", async (t) => {
  const existing = row("BTCFDUSD", "BTC", "FDUSD");
  const { register, added } = harness(t, {
    ensureMetadata: unavailable,
    getSymbol: async (s) => (s === "BTCFDUSD" ? existing : null),
  });
  const res = await register({ symbol: "BTCFDUSD", baseAsset: "BTCFDUSD", quoteAsset: "USDT" });
  assert.equal(res.statusCode, 200, "nothing was created");
  assert.deepEqual(res.json(), { ...existing, degraded: "instrument metadata unavailable" });
  assert.deepEqual(added, []);
});

test("directory unavailable and no row: registered by suffix, never by the body, and flagged", async (t) => {
  const { register, added } = harness(t, { ensureMetadata: unavailable, getSymbol: async () => null });
  const res = await register({ symbol: "ETHBTC", baseAsset: "ETHB", quoteAsset: "TC" });
  assert.equal(res.statusCode, 201);
  assert.deepEqual(added, [["ETHBTC", "ETH", "BTC"]], "the caller's assets are ignored");
  assert.equal(res.json().degraded, "instrument metadata unavailable");

  // The frontend's current body shape (a guessed base) and a bare symbol both work.
  const bare = await register({ symbol: "SOLUSDT" });
  assert.equal(bare.statusCode, 201);
  assert.deepEqual(added[1], ["SOLUSDT", "SOL", "USDT"]);

  // No recognisable quote suffix: refusing beats a junk row every account would see.
  const unknownQuote = await register({ symbol: "FOOBAR", baseAsset: "FOO", quoteAsset: "BAR" });
  assert.equal(unknownQuote.statusCode, 503);
  assert.equal(added.length, 2);
});
