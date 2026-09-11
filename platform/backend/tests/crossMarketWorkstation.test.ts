import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { storedLayoutSymbol } from "../src/api/routes/layouts";
import { alertInstrumentIdentity } from "../src/api/routes/maAlerts";
import { marketCatalogRoutes } from "../src/api/routes/marketCatalog";
import { cleanSymbols } from "../src/api/routes/watchlists";
import { createBinanceSpotAdapter } from "../src/market/binanceSpotAdapter";
import { canonicalizeLegacySpotSymbol } from "../src/market/model";
import { ProviderRegistry } from "../src/market/registry";
import { ibkrFuturesPaperAdapter, oandaFxPracticeAdapter } from "../src/market/officialTraditionalAdapters";
import { SCREENER_FIELDS, screenerFieldsFor } from "../src/market/workstation";

const BTC = "instrument:v1:BINANCE:spot:BTC:USDT:USDT:spot";
const PERP = "instrument:v1:BINANCE:perpetual:BTC:USDT:USDT:perpetual";
const AAPL = "instrument:v1:NASDAQ:stock:AAPL:USD:USD:cash";
const FX = "instrument:v1:OANDA:fx_pair:EUR:USD:USD:cash";

test("legacy Binance saved state migrates to one canonical spelling", () => {
  assert.equal(canonicalizeLegacySpotSymbol("btcusdt"), BTC);
  assert.equal(canonicalizeLegacySpotSymbol("BINANCE:btcusdt"), BTC);
  assert.equal(storedLayoutSymbol("btcusdt"), BTC);
  assert.deepEqual(cleanSymbols(["BTCUSDT", "binance:btcusdt", AAPL]), [BTC, AAPL]);
  assert.equal(canonicalizeLegacySpotSymbol("AAPL"), null, "unknown legacy tokens are not invented as Spot pairs");
});

test("alert identity accepts only the runner's Binance Spot last-price contract", () => {
  assert.deepEqual(alertInstrumentIdentity(BTC), {
    symbol: "BTCUSDT", canonicalInstrumentId: BTC, providerId: "binance-spot", priceBasis: "last",
  });
  assert.deepEqual(alertInstrumentIdentity("BTCUSDT"), {
    symbol: "BTCUSDT", canonicalInstrumentId: BTC, providerId: "binance-spot", priceBasis: "last",
  });
  for (const instrument of [PERP, AAPL, FX]) {
    const result = alertInstrumentIdentity(instrument);
    assert.equal("error" in result && result.status, 422);
  }
});

test("Screener field contracts do not leak category-specific semantics", async () => {
  assert.equal(SCREENER_FIELDS.crypto_spot.some((field) => field.semantic === "funding"), false);
  assert.equal(SCREENER_FIELDS.fx.some((field) => field.id === "volume_24h"), false);
  assert.equal(SCREENER_FIELDS.stocks.some((field) => field.semantic === "adjustment"), true);
  assert.equal(SCREENER_FIELDS.crypto_derivatives.some((field) => field.semantic === "open_interest"), true);
  assert.equal(SCREENER_FIELDS.indices.some((field) => field.semantic === "funding"), false);

  const fx = (await oandaFxPracticeAdapter.catalog.list())[0]!;
  assert.deepEqual(screenerFieldsFor(fx).map((field) => field.id),
    ["listing_status", "session", "feed", "bid", "ask", "mid"],
    "OTC FX must not imply a consolidated last trade");
  const futures = await ibkrFuturesPaperAdapter.catalog.list();
  const dated = futures.find((item) => item.identity.series.kind === "dated")!;
  assert.equal(screenerFieldsFor(dated).some((field) => field.id === "expiry"), true);
  assert.equal(screenerFieldsFor(dated).some((field) => field.id === "roll"), false);
  const continuous = futures.find((item) => item.identity.series.kind === "continuous")!;
  assert.equal(screenerFieldsFor(continuous).some((field) => field.id === "expiry"), false);
  assert.equal(screenerFieldsFor(continuous).some((field) => field.id === "roll"), true);

  const app = Fastify();
  await app.register(marketCatalogRoutes);
  try {
    const response = await app.inject({ method: "GET", url: "/api/market/v1/screener/schema?category=fx" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().fields.map((field: { id: string }) => field.id),
      ["listing_status", "session", "feed", "bid", "ask", "mid"]);
    const invalid = await app.inject({ method: "GET", url: "/api/market/v1/screener/schema?category=options" });
    assert.equal(invalid.statusCode, 400);
  } finally { await app.close(); }
});

test("provider catalog reads coalesce and remain bounded by the cache TTL", async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const adapter = createBinanceSpotAdapter({
    listSymbols: async () => { calls += 1; await gate; return [
      { symbol: "BADUSDT", baseAsset: "币安人生", quoteAsset: "USDT", status: "TRADING" },
      { symbol: "BTCUSDT", baseAsset: "BTC", quoteAsset: "USDT", status: "TRADING" },
    ]; },
    metadata: async () => [], candles: async () => [], tickers: async () => [],
  });
  const registry = new ProviderRegistry(); registry.register(adapter);
  const first = registry.catalog(adapter.id, 1_000, 15_000);
  const second = registry.catalog(adapter.id, 1_000, 15_000);
  release();
  assert.equal((await first)[0]?.identity.canonicalId, BTC);
  assert.equal((await second)[0]?.identity.canonicalId, BTC);
  assert.equal((await second).length, 1, "one malformed provider row does not fail the venue catalog");
  assert.equal(calls, 1, "concurrent callers share one catalog request");
  await registry.catalog(adapter.id, 15_999, 15_000);
  assert.equal(calls, 1, "a cache hit performs no provider request");
  registry.clearCatalog(adapter.id);
  await registry.catalog(adapter.id, 16_000, 15_000);
  assert.equal(calls, 2);
});

test("X7 migration backfills alert, watchlist and layout identity without touching the outbox", () => {
  const sql = fs.readFileSync(path.join(__dirname, "..", "src", "db", "migrations",
    "039_canonical_alert_identity.sql"), "utf8");
  for (const field of ["canonical_instrument_id", "provider_id", "price_basis", "UPDATE watchlists", "UPDATE chart_layouts"])
    assert.match(sql, new RegExp(field));
  assert.doesNotMatch(sql, /alert_delivery_outbox[\s\S]*(?:DELETE|TRUNCATE|DROP)/i);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS ma_alerts_canonical_identity_idx/);
});
