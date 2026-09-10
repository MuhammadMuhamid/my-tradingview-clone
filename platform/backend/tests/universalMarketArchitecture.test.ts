import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { createBinanceSpotAdapter } from "../src/market/binanceSpotAdapter";
import { runProviderConformance } from "../src/market/conformance";
import {
  MARKET_CONTRACT_VERSION, UNKNOWN_COMPLIANCE, canonicalInstrumentId, supported, unsupported,
  type CanonicalInstrument, type ExecutionCapabilities,
} from "../src/market/model";
import type { MarketDataProviderAdapter } from "../src/market/provider";
import { observationFreshness } from "../src/market/provider";
import { ProviderRegistry } from "../src/market/registry";
import { ProviderHttpError, withProviderRetry } from "../src/market/retry";
import { assertExecutionSupported, UnsupportedExecutionError } from "../src/market/execution";
import { manualTradingRoutes } from "../src/api/routes/manualTrading";
import { config } from "../src/config";
import { requiredMigrationFiles } from "../src/db/migrate";
import { venueRegistry } from "../src/market/venues";
import { marketCatalogRoutes } from "../src/api/routes/marketCatalog";

interface FakeSpec {
  providerId: string; venueId: string; providerSymbol: string; baseAsset: string; quoteAsset: string;
  instrumentType: "spot" | "future"; expiry?: string; session: "continuous" | "calendar";
}

const fixture = JSON.parse(fs.readFileSync(path.join(
  __dirname, "fixtures", "providerConformance.json"), "utf8")) as Record<string, FakeSpec>;

const noPrecision = {
  priceTick: { state: "known" as const, value: 0.01 },
  quantityLot: { state: "known" as const, value: 0.001 },
  minimumQuantity: { state: "known" as const, value: 0.001 },
  minimumNotional: { state: "known" as const, value: 5 },
  priceDecimals: { state: "known" as const, value: 2 },
  quantityDecimals: { state: "known" as const, value: 3 },
};

const fakeExecution: ExecutionCapabilities = {
  mutationBoundary: "bot_only", availability: { paper: true, testnet: false, live: false },
  directions: { long: true, short: false },
  shortSale: { support: "unsupported", reason: "fixture has no borrow" },
  leverage: { support: "unsupported", reason: "fixture has no leverage" },
  marginModes: ["cash"], reduceOnly: false, positionModes: ["one_way"],
};

function fakeInstrument(spec: FakeSpec): CanonicalInstrument {
  const series = spec.instrumentType === "future"
    ? { kind: "dated" as const, expiry: spec.expiry!, delivery: "cash" as const }
    : { kind: "spot" as const };
  const identity = {
    canonicalId: "", venueId: spec.venueId, assetClass: "crypto" as const,
    instrumentType: spec.instrumentType, baseAsset: spec.baseAsset, quoteAsset: spec.quoteAsset,
    settlementAsset: spec.quoteAsset, series,
  };
  identity.canonicalId = canonicalInstrumentId(identity);
  return {
    contractVersion: MARKET_CONTRACT_VERSION, identity,
    listing: { providerId: spec.providerId, providerSymbol: spec.providerSymbol, status: "active" },
    currency: spec.quoteAsset, precision: noPrecision,
    derivative: spec.instrumentType === "future" ? {
      kind: "contract", contractSize: 1, multiplier: 10, settlement: "linear",
      maturity: { kind: "dated", expiry: spec.expiry!, delivery: "cash" },
    } : { kind: "none" },
    sessions: spec.session === "continuous"
      ? { kind: "continuous", timezone: "UTC", calendarId: "24x7", supports24x7: true }
      : { kind: "calendar", timezone: "America/New_York", calendarId: "FAKE_US",
        supports24x7: false, weeklySessions: [{ days: [1, 2, 3, 4, 5], open: "09:30", close: "16:00" }] },
    prices: { last: supported(), bid: supported(), ask: supported(), mid: supported(),
      mark: spec.instrumentType === "future" ? supported() : unsupported("spot"),
      index: spec.instrumentType === "future" ? supported() : unsupported("spot") },
    events: {
      corporateActions: spec.instrumentType === "spot"
        ? { support: "supported", eventTypes: ["symbol_change"] }
        : { support: "unsupported", reason: "fixture derivative has no corporate actions" },
      funding: { support: "unsupported", reason: "not perpetual" },
      openInterest: spec.instrumentType === "future"
        ? { support: "supported", historical: true, stream: false }
        : { support: "unsupported", reason: "spot" },
    },
    execution: fakeExecution, compliance: UNKNOWN_COMPLIANCE,
  };
}

function fakeProvider(spec: FakeSpec, fail = false): MarketDataProviderAdapter {
  const instrument = fakeInstrument(spec);
  const maybeFail = async <T>(value: T): Promise<T> => {
    if (fail) throw new Error(`${spec.providerId} fixture failure`);
    return value;
  };
  return {
    id: spec.providerId, label: spec.providerId, venueIds: [spec.venueId],
    access: { mode: "public", proof: "official_contract" },
    documentation: [{ title: "Fixture official contract", url: "https://example.test/official",
      accessedOn: "2026-09-09", covers: ["catalog", "metadata", "ticker", "candles"],
      access: "public", limits: ["deterministic fixture"] }],
    healthPolicy: { staleAfterMs: 1000, unavailableAfterFailures: 2 },
    rateLimits: { buckets: [{ id: "fixture", limit: { kind: "fixed", requests: 10 }, windowMs: 1000 }],
      retry: { maxAttempts: 2, baseDelayMs: 1, maximumDelayMs: 2, retryableStatuses: [429, 503] } },
    catalog: { availability: supported(), list: () => maybeFail([instrument]), metadata: () => maybeFail([instrument]) },
    candles: { availability: supported(), resolutions: ["1m"],
      pagination: { maxPageSize: 10, direction: "forward" },
      stream: { support: "unsupported", reason: "fixture stream disabled" },
      fetch: async (symbol, interval, startMs) => maybeFail([{
      symbol, interval, openTime: startMs, open: 1, high: 2, low: 1, close: 2, volume: 3,
      closeTime: startMs + 59_999,
    }]) },
    ticker: { availability: supported(), prices: instrument.prices, fetch: async () => maybeFail([{
      canonicalInstrumentId: instrument.identity.canonicalId, providerSymbol: spec.providerSymbol,
      observedAt: 1000, values: { last: 2 },
    }]), stream: { support: "unsupported", reason: "fixture stream disabled" } },
    trades: { support: "unsupported", reason: "fixture" },
    orderBook: { support: "unsupported", reason: "fixture" },
    derivativeMetadata: spec.instrumentType === "future"
      ? { support: "supported", fetch: async () => [instrument] }
      : { support: "unsupported", reason: "spot" },
    execution: fakeExecution,
  };
}

test("one conformance harness validates two providers with the same code", async () => {
  for (const spec of Object.values(fixture)) {
    const report = await runProviderConformance(fakeProvider(spec), {
      providerSymbol: spec.providerSymbol, interval: "1m", startMs: 0, endMs: 59_999,
    });
    assert.equal(report.passed, true, JSON.stringify(report.failures));
    assert.ok(report.checks >= 20);
  }
});

test("provider-symbol collisions and spot/derivative identities cannot collide", () => {
  const alpha = fakeInstrument(fixture.alpha!);
  const beta = fakeInstrument(fixture.beta!);
  assert.equal(alpha.listing.providerSymbol, beta.listing.providerSymbol);
  assert.notEqual(alpha.identity.canonicalId, beta.identity.canonicalId, "venue disambiguates the collision");
  const sameVenueFuture = canonicalInstrumentId({ ...alpha.identity, instrumentType: "future",
    series: { kind: "dated", expiry: "2026-12-18", delivery: "cash" } });
  assert.notEqual(alpha.identity.canonicalId, sameVenueFuture, "spot and dated future are distinct identities");
  assert.throws(() => canonicalInstrumentId({ ...alpha.identity, instrumentType: "future",
    series: { kind: "spot" } }), /requires dated/);
});

test("venue and provider registries are distinct", () => {
  assert.equal(venueRegistry.get("binance")?.id, "BINANCE");
  assert.equal(venueRegistry.get("BINANCE")?.calendarIds[0], "24x7");
  assert.equal(venueRegistry.get("binance-spot"), null, "a provider id is not a venue id");
});

test("Platform publishes a versioned read-only provider capability contract", async () => {
  const app = Fastify();
  await app.register(marketCatalogRoutes);
  try {
    const response = await app.inject({ method: "GET", url: "/api/market/v1/providers" });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.contractVersion, "market.v1");
    assert.equal(body.venues[0].id, "BINANCE");
    assert.equal(body.providers[0].id, "binance-spot");
    assert.equal(body.providers[0].capabilities.execution.mutationBoundary, "bot_only");
    assert.doesNotMatch(response.body, /apiKey|apiSecret|credentialValue/);
  } finally {
    await app.close();
  }
});

test("session, expiry, corporate action, funding, OI and compliance semantics are explicit", () => {
  const spot = fakeInstrument(fixture.alpha!);
  const future = fakeInstrument(fixture.beta!);
  assert.equal(spot.sessions.kind, "continuous");
  assert.equal(spot.sessions.supports24x7, true);
  assert.equal(future.sessions.kind, "calendar");
  assert.equal(future.derivative.kind, "contract");
  if (future.derivative.kind === "contract") assert.equal(future.derivative.maturity.kind, "dated");
  assert.equal(spot.events.corporateActions.support, "supported");
  assert.equal(future.events.funding.support, "unsupported");
  assert.equal(future.events.openInterest.support, "supported");
  assert.equal(future.compliance.shariah.status, "unknown");
});

test("one provider failure changes only that provider's health", async () => {
  const registry = new ProviderRegistry();
  registry.register(fakeProvider(fixture.alpha!, true));
  registry.register(fakeProvider(fixture.beta!));
  await assert.rejects(() => registry.call("fake-alpha", (provider) => provider.catalog.list(), 100));
  await registry.call("fake-beta", (provider) => provider.catalog.list(), 100);
  assert.equal(registry.health("fake-alpha", 100).state, "degraded");
  assert.equal(registry.health("fake-beta", 100).state, "healthy");
  assert.equal(registry.health("fake-beta", 1_101).state, "degraded", "a silent provider becomes stale");
});

test("observation staleness and provider rate-limit health are explicit", async () => {
  assert.deepEqual(observationFreshness(100, 1_100, 1_000), { state: "fresh", ageMs: 1_000 });
  assert.deepEqual(observationFreshness(100, 1_101, 1_000), { state: "stale", ageMs: 1_001 });
  const registry = new ProviderRegistry();
  registry.register(fakeProvider(fixture.alpha!));
  await assert.rejects(() => registry.call("fake-alpha", async () => {
    throw new ProviderHttpError("limited", 429, 50);
  }, 100));
  assert.equal(registry.health("fake-alpha", 120).state, "rate_limited");
  assert.equal(registry.health("fake-alpha", 120).retryAfterMs, 30);
});

test("retry is bounded, status-driven, and honors rate-limit delay", async () => {
  const delays: number[] = [];
  let attempts = 0;
  const result = await withProviderRetry(async () => {
    attempts += 1;
    if (attempts < 3) throw new ProviderHttpError("limited", 429, 7);
    return "ok";
  }, { maxAttempts: 3, baseDelayMs: 2, maximumDelayMs: 10, retryableStatuses: [429] },
  async (delay) => { delays.push(delay); });
  assert.equal(result, "ok");
  assert.deepEqual(delays, [7, 7]);
  await assert.rejects(() => withProviderRetry(async () => {
    throw new ProviderHttpError("bad request", 400);
  }, { maxAttempts: 9, baseDelayMs: 1, maximumDelayMs: 2, retryableStatuses: [429] }));
});

test("Binance adapter preserves legacy candles and maps metadata without changing inputs", async () => {
  const candle = { symbol: "BTCUSDT", interval: "1m" as const, openTime: 0, open: 1,
    high: 2, low: 1, close: 2, volume: 4, quoteVolume: 8, tradeCount: 3, closeTime: 59_999 };
  const calls: unknown[][] = [];
  const adapter = createBinanceSpotAdapter({
    listSymbols: async () => [{ symbol: "BTCUSDT", baseAsset: "BTC", quoteAsset: "USDT", status: "TRADING" }],
    metadata: async (symbols) => { calls.push(symbols); return [{ symbol: "BTCUSDT", baseAsset: "BTC",
      quoteAsset: "USDT", status: "TRADING", active: true, priceTick: 0.01, qtyStep: 0.001, minNotional: 5 }]; },
    candles: async (symbol, interval, start, end) => { calls.push([symbol, interval, start, end]); return [candle]; },
    tickers: async (symbols) => { calls.push([...symbols]); return [{ symbol: "BTCUSDT", last: 2, open: 1, at: 59_999 }]; },
  });
  assert.deepEqual(await adapter.candles.fetch("BTCUSDT", "1m", 0, 59_999), [candle]);
  assert.deepEqual(calls[0], ["BTCUSDT", "1m", 0, 59_999]);
  const metadata = await adapter.catalog.metadata(["BTCUSDT"]);
  assert.equal(metadata[0]!.listing.providerSymbol, "BTCUSDT");
  assert.equal(metadata[0]!.identity.canonicalId, "instrument:v1:BINANCE:spot:BTC:USDT:USDT:spot");
  assert.equal(metadata[0]!.compliance.shariah.status, "unknown");
  const report = await runProviderConformance(adapter, {
    providerSymbol: "BTCUSDT", interval: "1m", startMs: 0, endMs: 59_999,
  });
  assert.equal(report.passed, true, JSON.stringify(report.failures));
});

test("unsupported execution is rejected before the Bot boundary", async () => {
  assert.throws(() => assertExecutionSupported({ providerId: "fake-alpha", venueId: "ALPHA",
    instrumentType: "spot", capabilities: fakeExecution }, { positionDirection: "short" }),
  UnsupportedExecutionError);

  const prior = config.manualTradingEnabled;
  config.manualTradingEnabled = true;
  let botCalls = 0;
  const app = Fastify();
  await app.register(async (child) => manualTradingRoutes(child, {
    executionTarget: () => ({ providerId: "fake-alpha", venueId: "ALPHA",
      instrumentType: "spot", capabilities: fakeExecution }),
    botRequest: (async () => { botCalls += 1; return {}; }) as never,
  }));
  try {
    const response = await app.inject({ method: "POST", url: "/api/manual-trading/orders",
      payload: { symbol: "COLLIDE", side: "SELL", positionDirection: "short" } });
    assert.equal(response.statusCode, 422);
    assert.equal(response.json().code, "unsupported_execution");
    assert.equal(botCalls, 0);
  } finally {
    config.manualTradingEnabled = prior;
    await app.close();
  }
});

test("persistence migration versions canonical ids without rewriting legacy symbols", () => {
  assert.ok(requiredMigrationFiles().includes("036_universal_market_architecture.sql"));
  const sql = fs.readFileSync(path.join(__dirname, "..", "src", "db", "migrations",
    "036_universal_market_architecture.sql"), "utf8");
  assert.match(sql, /CREATE TABLE canonical_instruments/);
  assert.match(sql, /CREATE TABLE provider_instrument_mappings/);
  assert.match(sql, /instrument:v1:BINANCE:spot:/);
  assert.match(sql, /status":"unknown"/);
  assert.doesNotMatch(sql, /ALTER TABLE symbols RENAME|UPDATE symbols SET symbol/i);
});
