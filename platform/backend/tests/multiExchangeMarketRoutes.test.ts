import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { marketCatalogRoutesFor, providerResolutionPlan } from "../src/api/routes/marketCatalog";
import { createOfficialSpotAdapter, OFFICIAL_SPOT_DEFINITIONS,
  type OfficialSpotDependencies } from "../src/market/officialSpotAdapters";
import { ProviderRegistry } from "../src/market/registry";
import type { Candle } from "../src/types/market";

const T = Date.UTC(2026, 8, 9, 12, 0, 0);
const definition = OFFICIAL_SPOT_DEFINITIONS.find((item) => item.id === "coinbase-spot")!;
const listing = { symbol: "BTC-USD", base: "BTC", quote: "USD", active: true,
  priceTick: 0.01, quantityLot: 0.00000001 };
const bar: Candle = { symbol: listing.symbol, interval: "1m", openTime: T, closeTime: T + 59_999,
  open: 100, high: 102, low: 99, close: 101, volume: 5 };

function deps(fail = false): OfficialSpotDependencies {
  return {
    list: async () => { if (fail) throw new Error("isolated catalog outage"); return [listing]; },
    candles: async () => [bar],
    tickers: async () => [{ symbol: listing.symbol, observedAt: T, last: 101, bid: 100, ask: 102 }],
  };
}

async function serverWithFailure(): Promise<ReturnType<typeof Fastify>> {
  const registry = new ProviderRegistry();
  registry.register(createOfficialSpotAdapter(definition, deps()));
  registry.register(createOfficialSpotAdapter({ ...definition, id: "fixture-failure", venueId: "FAILURE" }, deps(true)));
  const app = Fastify();
  await app.register(marketCatalogRoutesFor(registry));
  await app.ready();
  return app;
}

test("unified search returns canonical venue identity while isolating another provider failure", async () => {
  const app = await serverWithFailure();
  const response = await app.inject({ method: "GET", url: "/api/market/v1/search?q=BTC" });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.results[0].canonicalId, "instrument:v1:COINBASE:spot:BTC:USD:USD:spot");
  assert.equal(body.results[0].providerSymbol, "BTC-USD");
  assert.equal(body.errors[0].providerId, "fixture-failure");
  await app.close();
});

test("canonical chart and ticker routes preserve identity, ordering and freshness", async () => {
  const app = await serverWithFailure();
  const id = "instrument:v1:COINBASE:spot:BTC:USD:USD:spot";
  const candles = await app.inject({ method: "GET",
    url: `/api/market/v1/candles/${encodeURIComponent(id)}?interval=1m&from=${T}&to=${T + 59_999}&format=compact` });
  assert.equal(candles.statusCode, 200);
  assert.deepEqual(candles.json().bars, [[T, 100, 102, 99, 101, 5]]);
  assert.equal(candles.json().symbol, id);

  const tickers = await app.inject({ method: "GET",
    url: `/api/market/v1/tickers?instruments=${encodeURIComponent(id)}` });
  assert.equal(tickers.statusCode, 200);
  assert.equal(tickers.json().providers[0].observations[0].canonicalInstrumentId, id);
  assert.equal(tickers.json().providers[0].observations[0].freshness.state, "stale");

  const isolated = await app.inject({ method: "GET",
    url: `/api/market/v1/tickers?instruments=${encodeURIComponent(`${id},instrument:v1:FAILURE:spot:BTC:USD:USD:spot`)}` });
  assert.equal(isolated.statusCode, 200);
  assert.equal(isolated.json().providers[0].providerId, "coinbase-spot");
  assert.equal(isolated.json().errors[0].providerId, "fixture-failure");
  await app.close();
});

test("provider intervals are exact, derived only from a native divisor, and expose completeness", async () => {
  assert.deepEqual(providerResolutionPlan("45m", ["1m", "5m", "15m"]), {
    id: "45m", ms: 2_700_000, source: "15m", factor: 3, native: false, unit: "m", count: 45,
  });
  assert.equal(providerResolutionPlan("30s", ["1m", "5m"]), null);

  const app = await serverWithFailure();
  const id = "instrument:v1:COINBASE:spot:BTC:USD:USD:spot";
  const response = await app.inject({ method: "GET",
    url: `/api/market/v1/candles/${encodeURIComponent(id)}?interval=45m&from=${T}&to=${T + 2_699_999}&format=compact` });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().interval, "45m");
  assert.equal(response.json().completeness.complete, false);
  assert.equal(response.json().completeness.missingBars, 1);
  await app.close();
});

test("stream config resolves only a registered canonical provider mapping", async () => {
  const app = await serverWithFailure();
  const id = "instrument:v1:COINBASE:spot:BTC:USD:USD:spot";
  const response = await app.inject({ method: "GET",
    url: `/api/market/v1/stream/${encodeURIComponent(id)}?kind=ticker` });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().providerId, "coinbase-spot");
  assert.deepEqual(response.json().request.origins, ["wss://ws-feed.exchange.coinbase.com"]);
  assert.match(response.json().request.subscribeMessage, /BTC-USD/);
  const missing = await app.inject({ method: "GET",
    url: `/api/market/v1/stream/${encodeURIComponent("instrument:v1:UNKNOWN:spot:BTC:USD:USD:spot")}?kind=ticker` });
  assert.equal(missing.statusCode, 404);
  await app.close();
});
