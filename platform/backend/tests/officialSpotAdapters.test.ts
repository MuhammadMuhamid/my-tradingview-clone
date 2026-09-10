import assert from "node:assert/strict";
import test from "node:test";
import { INTERVAL_MS, type Candle } from "../src/types/market";
import { runProviderConformance } from "../src/market/conformance";
import {
  OFFICIAL_SPOT_DEFINITIONS, createOfficialSpotAdapter, normalizeCandles, pageByTime,
  type OfficialSpotDependencies,
} from "../src/market/officialSpotAdapters";
import { ProviderRegistry } from "../src/market/registry";
import { normalizeCanonicalInstrumentId } from "../src/market/model";
import fs from "node:fs";
import path from "node:path";

const START = Date.UTC(2026, 8, 9, 12, 0, 0);

function bar(symbol: string, openTime: number, close = 101): Candle {
  return { symbol, interval: "1m", openTime, open: 100, high: 102, low: 99,
    close, volume: 1.25, closeTime: openTime + 59_999 };
}

function fixtureDeps(symbol: string): OfficialSpotDependencies {
  return {
    list: async () => [{ symbol, base: "BTC", quote: "USD", active: true,
      priceTick: 0.01, quantityLot: 0.00000001, minimumQuantity: 0.00001 }],
    candles: async (_symbol, interval, startMs) => [{ ...bar(symbol, startMs), interval }],
    tickers: async () => [{ symbol, observedAt: START, last: 101, bid: 100.5, ask: 101.5 }],
  };
}

test("all target venues declare dated official sources and truthful access", () => {
  assert.deepEqual(OFFICIAL_SPOT_DEFINITIONS.map((item) => item.venueId), [
    "COINBASE", "BYBIT", "OKX", "KRAKEN", "KUCOIN", "GATEIO", "ROBINHOOD", "HYPERLIQUID",
  ]);
  for (const definition of OFFICIAL_SPOT_DEFINITIONS) {
    assert.ok(definition.documentation.length > 0, definition.id);
    assert.ok(definition.documentation.every((item) => item.accessedOn === "2026-09-09"));
    assert.ok(definition.documentation.every((item) => item.url.startsWith("https://")));
  }
  const robinhood = OFFICIAL_SPOT_DEFINITIONS.find((item) => item.id === "robinhood-crypto")!;
  assert.equal(robinhood.access.mode, "authentication_required");
  assert.equal(robinhood.resolutions.length, 0);
  assert.equal(robinhood.candleStream.support, "unsupported");
});

test("one X0 conformance runner validates every public X1 spot adapter", async () => {
  for (const definition of OFFICIAL_SPOT_DEFINITIONS.filter((item) => item.access.mode === "public")) {
    const symbol = definition.id === "hyperliquid-spot" ? "@1" : "BTC-USD";
    const adapter = createOfficialSpotAdapter({ ...definition, resolutions: ["1m"] }, fixtureDeps(symbol));
    const report = await runProviderConformance(adapter, {
      providerSymbol: symbol, interval: "1m", startMs: START, endMs: START + 59_999,
    });
    assert.equal(report.passed, true, `${definition.id}: ${JSON.stringify(report.failures)}`);
  }
});

test("venue identity disambiguates the same economic pair and provider symbol", async () => {
  const definitions = OFFICIAL_SPOT_DEFINITIONS.filter((item) => item.access.mode === "public").slice(0, 2);
  const instruments = await Promise.all(definitions.map(async (definition) =>
    (await createOfficialSpotAdapter(definition, fixtureDeps("BTC-USD")).catalog.list())[0]!));
  assert.equal(instruments[0]!.listing.providerSymbol, instruments[1]!.listing.providerSymbol);
  assert.notEqual(instruments[0]!.identity.canonicalId, instruments[1]!.identity.canonicalId);
});

test("canonical ids normalize across persistence and the watchlist migration preserves legacy order", () => {
  assert.equal(normalizeCanonicalInstrumentId("INSTRUMENT:V1:coinbase:SPOT:btc:usd:usd:SPOT"),
    "instrument:v1:COINBASE:spot:BTC:USD:USD:spot");
  assert.equal(normalizeCanonicalInstrumentId("BINANCE:BTCUSDT"), null);
  const sql = fs.readFileSync(path.join(__dirname, "..", "src", "db", "migrations",
    "037_multi_exchange_crypto_spot.sql"), "utf8");
  assert.match(sql, /WITH ORDINALITY/);
  assert.match(sql, /COALESCE\(s\.canonical_id, item\)/);
  assert.match(sql, /lower\(legacy\.item\) NOT LIKE 'instrument:v1:%'/);
  assert.doesNotMatch(sql, /DROP TABLE|DELETE FROM|TRUNCATE/i);
});

test("candle normalization is UTC-millisecond exact, ordered, bounded, and deduplicated", () => {
  const rows = normalizeCandles([
    bar("BTC-USD", START + 60_000, 101.5),
    bar("BTC-USD", START, 100),
    bar("BTC-USD", START + 60_000, 101.8),
    bar("BTC-USD", START - 60_000, 98),
  ], "BTC-USD", "1m", START, START + 120_000);
  assert.deepEqual(rows.map((item) => [item.openTime, item.close]), [
    [START, 100], [START + 60_000, 101.8],
  ]);
  assert.equal(rows[1]!.closeTime, rows[1]!.openTime + INTERVAL_MS["1m"] - 1);
  assert.deepEqual(normalizeCandles([bar("BTC-USD", START + 1)], "BTC-USD", "1m", START, START + 60_000), [],
    "a provider bar off the canonical UTC grid is rejected");
});

test("time pagination has no duplicate boundary bars and cancellation stops backfill", async () => {
  const calls: Array<[number, number]> = [];
  const result = await pageByTime({ symbol: "BTC-USD", interval: "1m", startMs: START,
    endMs: START + 4 * 60_000, pageSize: 2,
    fetchPage: async (from, to) => {
      calls.push([from, to]);
      return [bar("BTC-USD", from), bar("BTC-USD", to)];
    } });
  assert.deepEqual(calls, [
    [START, START + 60_000], [START + 120_000, START + 180_000],
    [START + 240_000, START + 240_000],
  ]);
  assert.deepEqual(result.map((item) => item.openTime), [
    START, START + 60_000, START + 120_000, START + 180_000, START + 240_000,
  ]);

  const controller = new AbortController();
  let pages = 0;
  await assert.rejects(pageByTime({ symbol: "BTC-USD", interval: "1m", startMs: START,
    endMs: START + 10 * 60_000, pageSize: 2, signal: controller.signal,
    fetchPage: async (from) => {
      pages += 1; controller.abort(); return [bar("BTC-USD", from)];
    } }), (error: unknown) => error instanceof DOMException && error.name === "AbortError");
  assert.equal(pages, 1);

  await assert.rejects(pageByTime({ symbol: "BTC-USD", interval: "1m", startMs: START,
    endMs: START + 513 * 60_000, pageSize: 1, fetchPage: async () => [] }),
  /needs 514 pages; maximum is 512/);
});

test("one provider failure does not poison another provider health", async () => {
  const [first, second] = OFFICIAL_SPOT_DEFINITIONS.filter((item) => item.access.mode === "public");
  const registry = new ProviderRegistry();
  registry.register(createOfficialSpotAdapter(first!, {
    ...fixtureDeps("BTC-USD"), list: async () => { throw new Error("fixture outage"); },
  }));
  registry.register(createOfficialSpotAdapter(second!, fixtureDeps("BTC-USD")));
  await assert.rejects(registry.call(first!.id, (provider) => provider.catalog.list()));
  await registry.call(second!.id, (provider) => provider.catalog.list());
  assert.equal(registry.health(first!.id).state, "degraded");
  assert.equal(registry.health(second!.id).state, "healthy");
});
