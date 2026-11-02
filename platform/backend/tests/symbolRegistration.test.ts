/**
 * `POST /api/symbols` writes the SHARED symbols table every account reads, and
 * ordinary accounts reach it. So the row's assets come from the venue and never
 * from the request body, a pair the venue does not list is never written, and
 * while the directory is unavailable nothing is written at all: an existing
 * row is served (flagged `degraded`), a new pair is a retryable 503.
 *
 * Nothing here reaches Binance or PostgreSQL: the directory is injected, and
 * the catalog's writers are mocked so "nothing written" is a counted fact.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { symbolRoutes, type SymbolRouteDeps } from "../src/api/routes/symbols";
import type { SymbolInfo } from "../src/types/market";
import * as symbolRepo from "../src/repositories/symbols";
import { pool } from "../src/db/pool";

function row(symbol: string, baseAsset: string, quoteAsset: string): SymbolInfo {
  return {
    symbol, baseAsset, quoteAsset, priceTick: null, qtyStep: null, minNotional: null,
    isActive: true, venue: "BINANCE", assetClass: "crypto_spot",
  };
}

/*
 * PostgreSQL replaced at the pool, the one place every repository query goes
 * through: any write to the catalog, by `symbolRepo.addSymbol` or any other
 * route, is recorded here as a call rather than surfacing as a connection
 * error that happens to fail the test. Registering a symbol writes the
 * symbols row as `insert <ticker> <base> <quote>`.
 */
function catalogWrites(t: TestContext): string[] {
  const writes: string[] = [];
  t.mock.method(pool, "query", async (sql: string, params: unknown[] = []) => {
    if (/INSERT INTO symbols/.test(sql)) {
      const [, symbol, base, quote] = params as string[];
      writes.push(`insert ${symbol} ${base} ${quote}`);
      return { rows: [{ symbol, base_asset: base, quote_asset: quote, price_tick: null, qty_step: null,
        min_notional: null, is_active: true }] };
    }
    if (!/^\s*SELECT/i.test(sql)) writes.push(`sql ${sql.trim().slice(0, 40)}`);
    return { rows: [] };
  });
  return writes;
}

function harness(t: TestContext, deps: Pick<SymbolRouteDeps, "ensureMetadata" | "getSymbol">) {
  const added = catalogWrites(t);
  const app = Fastify({ logger: false });
  t.after(() => app.close());
  const ready = app.register(symbolRoutes({ tickers: async () => [], ...deps }));
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
    // As the real metadata path does: the VENUE's assets go through the repository.
    ensureMetadata: async (symbols) => Promise.all(symbols.map((s) => symbolRepo.addSymbol(s, "ETH", "BTC"))),
    getSymbol: async () => null,
  });
  const res = await register({ symbol: "ethbtc", baseAsset: "ETHB", quoteAsset: "USDT" });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json().symbol, "ETHBTC");
  assert.equal(res.json().baseAsset, "ETH");
  assert.equal(res.json().quoteAsset, "BTC");
  assert.equal(res.json().degraded, undefined);
  assert.deepEqual(added, ["insert ETHBTC ETH BTC"], "exactly one write, with the venue's assets, never the body's");
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

test("directory unavailable and no row: 503, nothing written, whatever the suffix or body", async (t) => {
  const { register, added } = harness(t, { ensureMetadata: unavailable, getSymbol: async () => null });
  // A recognisable suffix (ETHBTC, SOLUSDT) and caller-supplied assets are both
  // guesses; neither may become a row every account reads.
  for (const payload of [
    { symbol: "ETHBTC", baseAsset: "ETH", quoteAsset: "BTC" },
    { symbol: "SOLUSDT" },
    { symbol: "FOOBAR", baseAsset: "FOO", quoteAsset: "BAR" },
  ]) {
    const res = await register(payload);
    assert.equal(res.statusCode, 503, payload.symbol);
    const { error } = res.json();
    assert.match(error, /instrument directory is unavailable/);
    assert.match(error, /try again later/);
    assert.match(error, new RegExp(payload.symbol));
  }
  assert.deepEqual(added, []);
});
