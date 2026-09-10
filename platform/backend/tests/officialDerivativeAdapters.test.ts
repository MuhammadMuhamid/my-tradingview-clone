import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { marketCatalogRoutesFor } from "../src/api/routes/marketCatalog";
import { runProviderConformance } from "../src/market/conformance";
import { effectiveListingStatus, normalizeCanonicalInstrumentId } from "../src/market/model";
import {
  OFFICIAL_DERIVATIVE_DEFINITIONS, createOfficialDerivativeAdapter,
  normalizeKrakenDerivativeListing, normalizeOkxDerivativeListing,
  type NormalizedDerivativeListing, type NormalizedDerivativeSnapshot, type OfficialDerivativeDependencies,
} from "../src/market/officialDerivativeAdapters";
import { ProviderRegistry } from "../src/market/registry";
import type { Candle } from "../src/types/market";

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "cryptoDerivatives.json"), "utf8")) as {
  perpetual: NormalizedDerivativeListing;
  future: NormalizedDerivativeListing;
  snapshot: NormalizedDerivativeSnapshot;
  funding: Array<{ rate: number; intervalMs: number; fundingAt: number }>;
};
const START = 1_788_940_800_000;

function deps(listings: NormalizedDerivativeListing[] = [FIXTURE.perpetual], fail = false): OfficialDerivativeDependencies {
  const reject = (): never => { throw new Error("fixture derivative outage"); };
  return {
    list: async () => fail ? reject() : listings,
    candles: async (symbol, interval, startMs): Promise<Candle[]> => fail ? reject() : [{
      symbol, interval, openTime: startMs, closeTime: startMs + 59_999,
      open: 76_900, high: 77_200, low: 76_800, close: 77_000, volume: 12,
    }],
    snapshots: async (symbols) => fail ? reject() : symbols.map((symbol) => ({ ...FIXTURE.snapshot, symbol })),
    fundingHistory: async () => fail ? reject() : [...FIXTURE.funding, FIXTURE.funding[1]!],
  };
}

test("all target derivative providers declare official capability and Coinbase remains entitlement-gated", () => {
  assert.deepEqual(OFFICIAL_DERIVATIVE_DEFINITIONS.map((item) => item.id), [
    "binance-derivatives", "bybit-derivatives", "okx-derivatives", "kucoin-derivatives",
    "gateio-derivatives", "kraken-derivatives", "hyperliquid-perps", "coinbase-derivatives",
  ]);
  for (const definition of OFFICIAL_DERIVATIVE_DEFINITIONS) {
    assert.ok(definition.documentation.length > 0, definition.id);
    assert.ok(definition.documentation.every((source) => source.accessedOn === "2026-09-10"));
  }
  const coinbase = OFFICIAL_DERIVATIVE_DEFINITIONS.at(-1)!;
  assert.equal(coinbase.access.mode, "authentication_required");
  assert.ok(coinbase.unavailableReason?.includes("eligible"));
  assert.equal(coinbase.derivativeStream.support, "unsupported");
  const hyperliquid = OFFICIAL_DERIVATIVE_DEFINITIONS.find((item) => item.id === "hyperliquid-perps")!;
  assert.equal(hyperliquid.tickerStream.support, "unsupported");
  assert.equal(hyperliquid.priceRoles?.index?.support, "unsupported");
  assert.equal(hyperliquid.priceRoles?.last?.support, "unsupported");
});

test("the X0 conformance runner validates every public X2 adapter with deterministic fixtures", async () => {
  for (const definition of OFFICIAL_DERIVATIVE_DEFINITIONS.filter((item) => item.access.mode === "public")) {
    const adapter = createOfficialDerivativeAdapter({ ...definition, resolutions: ["1m"] }, deps());
    const report = await runProviderConformance(adapter, {
      providerSymbol: FIXTURE.perpetual.symbol, interval: "1m", startMs: START, endMs: START + 59_999,
    });
    assert.equal(report.passed, true, `${definition.id}: ${JSON.stringify(report.failures)}`);
  }
});

test("inverse contract quantities, provider multipliers, price roles, OI units and basis remain distinct", async () => {
  const definition = OFFICIAL_DERIVATIVE_DEFINITIONS[0]!;
  const adapter = createOfficialDerivativeAdapter(definition, deps());
  const instrument = (await adapter.catalog.list())[0]!;
  assert.equal(instrument.identity.instrumentType, "perpetual");
  assert.deepEqual(instrument.derivative, {
    kind: "contract", contractSize: { value: 100, unit: "quote" }, multiplier: 100,
    quantityUnit: "contracts", settlement: "inverse", maturity: { kind: "perpetual" },
  });
  if (adapter.derivatives.support !== "supported") return assert.fail("derivatives unsupported");
  const observation = (await adapter.derivatives.snapshot([FIXTURE.perpetual.symbol]))[0]!;
  assert.deepEqual(observation.prices, { last: 77_000, mark: 77_100, index: 77_050 });
  assert.deepEqual(observation.basis, { absolute: 50, rate: 50 / 77_050, mark: 77_100, index: 77_050 });
  assert.deepEqual(observation.openInterest, {
    value: 12_500, unit: "contracts", converted: { value: 16.2232, unit: "base", role: "provider_reported" },
  });
  assert.equal(observation.funding?.intervalMs, 14_400_000, "variable 4h funding is not coerced to 8h");
  assert.equal(observation.liquidation?.source, "provider_contract_metadata");
});

test("official OKX and Kraken catalog shapes retain economic identity", () => {
  const okxInverse = normalizeOkxDerivativeListing({ instId: "BTC-USD-SWAP", uly: "BTC-USD", settleCcy: "BTC",
    ctType: "inverse", ctVal: "100", ctValCcy: "USD", ctMult: "1", state: "live", tickSz: "0.1",
    lotSz: "1", minSz: "1", lever: "100" }, "SWAP");
  assert.deepEqual([okxInverse.base, okxInverse.quote, okxInverse.settlement, okxInverse.contractSizeUnit,
    okxInverse.settlementMode], ["BTC", "USD", "BTC", "quote", "inverse"]);

  const krakenPerpetual = normalizeKrakenDerivativeListing({ symbol: "PF_XBTUSD", type: "flexible_futures",
    underlying: "rr_xbtusd", base: "BTC", quote: "USD", contractSize: 1, tradeable: true, tickSize: 1,
    marginLevels: [{ initialMargin: 0.01, maintenanceMargin: 0.005 }] });
  assert.deepEqual([krakenPerpetual.kind, krakenPerpetual.base, krakenPerpetual.quote,
    krakenPerpetual.settlement, krakenPerpetual.contractSizeUnit, krakenPerpetual.quantityUnit,
    krakenPerpetual.maxLeverage], ["perpetual", "BTC", "USD", "USD", "base", "base", 100]);
});

test("funding history is inclusive, ordered, deduplicated and keeps interval boundaries", async () => {
  const adapter = createOfficialDerivativeAdapter(OFFICIAL_DERIVATIVE_DEFINITIONS[1]!, deps());
  await adapter.catalog.list();
  if (adapter.derivatives.support !== "supported" || adapter.derivatives.fundingHistory.support !== "supported") {
    return assert.fail("fixture funding unavailable");
  }
  const history = await adapter.derivatives.fundingHistory.fetch(FIXTURE.perpetual.symbol,
    FIXTURE.funding[0]!.fundingAt, FIXTURE.funding[1]!.fundingAt);
  assert.deepEqual(history.map((row) => [row.fundingAt, row.intervalMs]), [
    [FIXTURE.funding[0]!.fundingAt, 14_400_000], [FIXTURE.funding[1]!.fundingAt, 14_400_000],
  ]);
});

test("dated expiry uses the exact delivery instant and spot/perp/future IDs cannot collide", async () => {
  const adapter = createOfficialDerivativeAdapter(OFFICIAL_DERIVATIVE_DEFINITIONS[4]!, deps([FIXTURE.future]));
  const future = (await adapter.catalog.list())[0]!;
  assert.equal(future.identity.canonicalId, "instrument:v1:GATEIO:future:BTC:USD:USD:dated-20260925");
  assert.equal(future.derivative.kind === "contract" && future.derivative.maturity.kind === "dated"
    ? future.derivative.maturity.expiresAt : null, "2026-09-25T15:00:00.000Z");
  assert.equal(effectiveListingStatus(future, Date.parse("2026-09-25T14:59:59.999Z")), "active");
  assert.equal(effectiveListingStatus(future, Date.parse("2026-09-25T15:00:00.000Z")), "delisted");
  assert.equal(normalizeCanonicalInstrumentId("instrument:v1:GATEIO:future:BTC:USD:USD:dated-20260231"), null);
  assert.notEqual(future.identity.canonicalId, "instrument:v1:GATEIO:spot:BTC:USD:USD:spot");
  assert.notEqual(future.identity.canonicalId, "instrument:v1:GATEIO:perpetual:BTC:USD:USD:perpetual");
  if (adapter.derivatives.support !== "supported") return assert.fail("derivatives unavailable");
  assert.equal((await adapter.derivatives.snapshot([FIXTURE.future.symbol]))[0]!.funding, null,
    "dated contracts never inherit zero/blank perpetual funding fields");
  await assert.rejects(() => createOfficialDerivativeAdapter(OFFICIAL_DERIVATIVE_DEFINITIONS[4]!,
    deps([{ ...FIXTURE.future, expiryAt: undefined }])).catalog.list(), /exact delivery instant/);
});

test("derivative routes expose snapshot, funding and same-underlying comparison with failure isolation", async () => {
  const registry = new ProviderRegistry();
  const failedSibling = createOfficialDerivativeAdapter({ ...OFFICIAL_DERIVATIVE_DEFINITIONS[2]!,
    id: "failed-binance-derivatives", venueId: "BINANCE" }, deps(undefined, true));
  const ok = createOfficialDerivativeAdapter(OFFICIAL_DERIVATIVE_DEFINITIONS[0]!, deps());
  const second = createOfficialDerivativeAdapter({ ...OFFICIAL_DERIVATIVE_DEFINITIONS[1]!, venueId: "BYBIT" }, deps());
  const failed = createOfficialDerivativeAdapter({ ...OFFICIAL_DERIVATIVE_DEFINITIONS[2]!, venueId: "FAILURE" }, deps(undefined, true));
  registry.register(failedSibling); registry.register(ok); registry.register(second); registry.register(failed);
  const app = Fastify(); await app.register(marketCatalogRoutesFor(registry)); await app.ready();
  const id = "instrument:v1:BINANCE:perpetual:BTC:USD:USD:perpetual";
  const snapshot = await app.inject({ method: "GET", url: `/api/market/v1/derivatives/${encodeURIComponent(id)}` });
  assert.equal(snapshot.statusCode, 200);
  assert.equal(snapshot.json().observation.prices.mark, 77_100);
  assert.equal(snapshot.json().freshness.state, "stale");
  const funding = await app.inject({ method: "GET", url: `/api/market/v1/funding/${encodeURIComponent(id)}?from=${START}&to=${START + 28_800_000}` });
  assert.equal(funding.statusCode, 200);
  assert.equal(funding.json().observations.length, 3);
  const compare = await app.inject({ method: "GET", url: "/api/market/v1/compare?base=BTC&type=perpetual" });
  assert.equal(compare.statusCode, 200);
  assert.equal(compare.json().providers.length, 2);
  assert.deepEqual(compare.json().errors.map((row: { providerId: string }) => row.providerId).sort(),
    ["failed-binance-derivatives", "okx-derivatives"]);
  await app.close();
});

test("search separates spot/perpetual/future collisions and filters exact expiry state", async () => {
  const registry = new ProviderRegistry();
  registry.register(createOfficialDerivativeAdapter(OFFICIAL_DERIVATIVE_DEFINITIONS[4]!, deps([FIXTURE.perpetual, FIXTURE.future])));
  const app = Fastify(); await app.register(marketCatalogRoutesFor(registry)); await app.ready();
  const perps = await app.inject({ method: "GET", url: "/api/market/v1/search?q=BTC&type=perpetual&expiry=live" });
  assert.deepEqual(perps.json().results.map((row: { instrumentType: string }) => row.instrumentType), ["perpetual"]);
  const futures = await app.inject({ method: "GET", url: "/api/market/v1/search?q=BTC&type=future&expiry=30d" });
  assert.equal(futures.json().results[0].series.expiry, "2026-09-25");
  const expired = await app.inject({ method: "GET", url: "/api/market/v1/search?q=BTC&type=future&expiry=expired" });
  assert.equal(expired.json().results.length, 0);
  await app.close();
});
