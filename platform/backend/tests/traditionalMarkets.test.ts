import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { config } from "../src/config";
import { marketCatalogRoutesFor } from "../src/api/routes/marketCatalog";
import { traditionalExecutionRoutes } from "../src/api/routes/traditionalExecution";
import { canonicalInstrumentId, effectiveListingStatus, normalizeCanonicalInstrumentId } from "../src/market/model";
import { ibkrFuturesPaperAdapter, oandaFxPracticeAdapter } from "../src/market/officialTraditionalAdapters";
import { ProviderRegistry } from "../src/market/registry";
import { assertTraditionalResearchSemantics, buildContinuousSeries, cmeGlobexSessionOpen,
  fxSideAwareFill, normalizeFxQuote, oandaFxSessionOpen } from "../src/market/traditionalMarkets";
import type { Candle } from "../src/types/market";

const EURUSD = "instrument:v1:OANDA:fx_pair:EUR:USD:USD:cash";
const CLX = "instrument:v1:NYMEX:future:CL:USD:USD:dated-20261020";
const CLC = "instrument:v1:NYMEX:continuous_future:CL:USD:USD:continuous-cl-front-calendar-unadjusted";
const SPX = "instrument:v1:CBOE_INDEX:index:SPX:USD:USD:cash";

test("official OANDA/IBKR catalogs preserve FX, contract, continuous and reference identities", async () => {
  const fx = await oandaFxPracticeAdapter.catalog.list(); const rows = await ibkrFuturesPaperAdapter.catalog.list();
  assert.equal(fx[0]!.identity.canonicalId, EURUSD); assert.equal(fx[0]!.prices.last.support, "unsupported");
  assert.equal(fx[0]!.fx?.marketStructure, "otc_provider_quote"); assert.equal(fx[0]!.fx?.defaultPriceBasis, "mid");
  assert.equal(rows.some((row) => row.identity.canonicalId === CLX), true);
  assert.equal(rows.some((row) => row.identity.canonicalId === CLC && row.derivative.kind === "continuous_series"), true);
  assert.equal(rows.some((row) => row.identity.canonicalId === SPX && row.referenceIndex?.directlyTradable === false), true);
  const cl = rows.find((row) => row.identity.canonicalId === CLX)!;
  assert.deepEqual({ root: cl.futures?.root, code: cl.futures?.contractCode, expiry: cl.futures?.expiry,
    multiplier: cl.futures?.multiplier, tick: cl.futures?.tickSize, tickValue: cl.futures?.tickValue,
    firstNotice: cl.futures?.firstNoticeDate, delivery: cl.futures?.lastDeliveryDate, chain: cl.futures?.chainPosition },
  { root: "CL", code: "CLX26", expiry: "2026-10-20", multiplier: 1000, tick: 0.01, tickValue: 10,
    firstNotice: "2026-10-22", delivery: "2026-11-30", chain: "next" });
  assert.equal(oandaFxPracticeAdapter.access.mode, "authentication_required");
  assert.equal(ibkrFuturesPaperAdapter.access.mode, "authentication_required");
  assert.equal([...oandaFxPracticeAdapter.documentation, ...ibkrFuturesPaperAdapter.documentation]
    .every((source) => source.accessedOn === "2026-09-10" && source.url.startsWith("https://")), true);
});

test("canonical continuous identity is distinct and normalizes without becoming tradable", () => {
  const built = canonicalInstrumentId({ venueId: "NYMEX", instrumentType: "continuous_future", baseAsset: "CL",
    quoteAsset: "USD", settlementAsset: "USD", series: { kind: "continuous", methodologyId: "cl-front-calendar-unadjusted" } });
  assert.equal(built, CLC); assert.equal(normalizeCanonicalInstrumentId(built), built);
  assert.throws(() => canonicalInstrumentId({ venueId: "NYMEX", instrumentType: "future", baseAsset: "CL",
    quoteAsset: "USD", settlementAsset: "USD", series: { kind: "continuous", methodologyId: "bad" } }), /requires dated/);
});

test("FX spread and side-aware fills never use midpoint as executable price", () => {
  const quote = normalizeFxQuote({ bid: 1.08491, ask: 1.08507, observedAt: 1 });
  assert.ok(Math.abs(quote.spread - 0.00016) < 1e-12); assert.equal(quote.mid, 1.08499);
  assert.equal(fxSideAwareFill(quote, "BUY").price, 1.08507); assert.equal(fxSideAwareFill(quote, "BUY").basis, "ask");
  assert.equal(fxSideAwareFill(quote, "SELL").price, 1.08491); assert.equal(fxSideAwareFill(quote, "SELL").basis, "bid");
  assert.throws(() => normalizeFxQuote({ bid: 1.1, ask: 1.1, observedAt: 1 }), /bid < ask/);
});

test("FX and CME week/session boundaries follow New York/Chicago DST", () => {
  assert.equal(oandaFxSessionOpen(Date.parse("2026-03-08T21:04:00Z")), false);
  assert.equal(oandaFxSessionOpen(Date.parse("2026-03-08T21:05:00Z")), true, "17:05 New York is 21:05Z after DST");
  assert.equal(oandaFxSessionOpen(Date.parse("2026-03-09T20:58:00Z")), true);
  assert.equal(oandaFxSessionOpen(Date.parse("2026-03-09T20:59:00Z")), false, "daily break starts at 16:59 New York");
  assert.equal(oandaFxSessionOpen(Date.parse("2026-03-09T21:04:00Z")), false);
  assert.equal(oandaFxSessionOpen(Date.parse("2026-03-09T21:05:00Z")), true, "daily session reopens at 17:05 New York");
  assert.equal(oandaFxSessionOpen(Date.parse("2026-03-13T20:58:00Z")), true);
  assert.equal(oandaFxSessionOpen(Date.parse("2026-03-13T20:59:00Z")), false, "Friday closes at 16:59 New York");
  assert.equal(oandaFxSessionOpen(Date.parse("2026-01-11T22:04:00Z")), false);
  assert.equal(oandaFxSessionOpen(Date.parse("2026-01-11T22:05:00Z")), true, "winter boundary is 22:05Z");
  assert.equal(cmeGlobexSessionOpen(Date.parse("2026-03-09T20:59:00Z")), true);
  assert.equal(cmeGlobexSessionOpen(Date.parse("2026-03-09T21:00:00Z")), false, "16:00 CT daily break");
  assert.equal(cmeGlobexSessionOpen(Date.parse("2026-03-09T22:00:00Z")), true, "17:00 CT reopen");
  assert.equal(cmeGlobexSessionOpen(Date.parse("2026-03-14T15:00:00Z")), false, "Saturday closed");
});

const bar = (symbol: string, time: number, close: number): Candle => ({ symbol, interval: "1m", openTime: time,
  closeTime: time + 59_999, open: close, high: close + 1, low: close - 1, close, volume: 10 });
test("continuous futures roll and adjustment are explicit and reproducible", () => {
  const t0 = 1_000; const rollAt = 61_000; const t2 = 121_000;
  const contracts = { CLV26: [bar("CLV26", t0, 99), bar("CLV26", rollAt, 100)],
    CLX26: [bar("CLX26", rollAt, 110), bar("CLX26", t2, 111)] };
  const rolls = [{ fromContract: "CLV26", toContract: "CLX26", rollAt }];
  assert.deepEqual(buildContinuousSeries({ contracts, rolls, adjustment: "none" }).map((row) => row.close), [99, 110, 111]);
  assert.deepEqual(buildContinuousSeries({ contracts, rolls, adjustment: "back_adjusted_difference" }).map((row) => row.close), [109, 110, 111]);
  assert.deepEqual(buildContinuousSeries({ contracts, rolls, adjustment: "back_adjusted_ratio" }).map((row) => row.close), [108.9, 110, 111]);
  assert.throws(() => buildContinuousSeries({ contracts: { CLV26: contracts.CLV26, CLX26: [bar("CLX26", t2, 111)] }, rolls,
    adjustment: "back_adjusted_difference" }), /lacks both closes/);
});

test("chart/backtest semantics require FX basis and registered continuous roll method", async () => {
  const fx = (await oandaFxPracticeAdapter.catalog.list())[0]!;
  const continuous = (await ibkrFuturesPaperAdapter.catalog.list()).find((row) => row.identity.canonicalId === CLC)!;
  assert.throws(() => assertTraditionalResearchSemantics(fx, { purpose: "backtest" }), /must state bid, ask, or mid/);
  assert.doesNotThrow(() => assertTraditionalResearchSemantics(fx, { purpose: "backtest", priceBasis: "mid" }));
  assert.throws(() => assertTraditionalResearchSemantics(fx, { purpose: "execution", priceBasis: "mid" }), /cannot fill at mid/);
  assert.throws(() => assertTraditionalResearchSemantics(continuous, { purpose: "chart", continuousAdjustment: "none" }), /roll schedule/);
  assert.doesNotThrow(() => assertTraditionalResearchSemantics(continuous, { purpose: "backtest", continuousAdjustment: "none",
    rollSchedule: "cl-front-calendar-unadjusted" }));
  assert.throws(() => assertTraditionalResearchSemantics(continuous, { purpose: "execution" }), /not directly tradable/);
});

test("expired futures are economically delisted even when provider status is stale", async () => {
  const ng = (await ibkrFuturesPaperAdapter.catalog.list()).find((row) => row.futures?.contractCode === "NGV26")!;
  assert.equal(effectiveListingStatus(ng, Date.parse("2026-09-28T23:59:59Z")), "active");
  assert.equal(effectiveListingStatus(ng, Date.parse("2026-09-29T00:00:00Z")), "delisted");
});

test("unified search exposes clear feed/type metadata and isolates one provider failure", async () => {
  const registry = new ProviderRegistry(); registry.register(oandaFxPracticeAdapter); registry.register(ibkrFuturesPaperAdapter);
  registry.register({ ...oandaFxPracticeAdapter, id: "broken-fx", catalog: { ...oandaFxPracticeAdapter.catalog,
    list: async () => { throw new Error("fixture outage"); } } });
  const app = Fastify(); await app.register(marketCatalogRoutesFor(registry)); await app.ready();
  try {
    const fx = await app.inject({ url: "/api/market/v1/search?q=EUR&type=fx_pair" });
    assert.equal(fx.statusCode, 200); assert.equal(fx.json().results[0].fx.defaultPriceBasis, "mid");
    assert.deepEqual(fx.json().errors, [{ providerId: "broken-fx", error: "fixture outage" }]);
    const futures = await app.inject({ url: "/api/market/v1/search?q=CL&type=future&expiry=all" });
    assert.equal(futures.json().results[0].futures.tickValue, 10);
    const commodity = await app.inject({ url: "/api/market/v1/search?q=GC&type=commodity&expiry=all" });
    assert.equal(commodity.json().results[0].futures.exchange, "COMEX");
    const index = await app.inject({ url: "/api/market/v1/search?q=SPX&type=index" });
    assert.equal(index.json().results[0].referenceIndex.directlyTradable, false);
  } finally { await app.close(); }
});

const pending = { id: 95, deploymentId: "00000000-0000-4000-8000-000000000050", alertId: null,
  dedupeKey: "traditional:fixture:CLX26:1788966000000", action: "buy" as const, barTime: 1_788_966_000_000,
  exitLeg: null, state: "pending" as const, resolvedAt: null, detail: null, emitterId: null,
  createdAt: Date.parse("2026-09-09T15:00:00Z") };
const baseOrder = { deploymentId: pending.deploymentId, dedupeKey: pending.dedupeKey, barTime: pending.barTime,
  canonicalInstrumentId: CLX, side: "BUY", quantity: "1", orderType: "LIMIT", limitPrice: "70.25" };

test("Platform-to-Bot paper boundary derives futures truth and rejects invalid instruments/sessions pre-Bot", async () => {
  const old = config.traditionalPaperExecutionEnabled; config.traditionalPaperExecutionEnabled = true;
  const registry = new ProviderRegistry(); registry.register(ibkrFuturesPaperAdapter); let calls = 0; const sent: Record<string, unknown>[] = [];
  const make = async (clock: string) => { const app = Fastify(); await app.register(async (child) => traditionalExecutionRoutes(child, {
    registry, now: () => Date.parse(clock), claimIntent: async () => ({ claimed: true, intent: pending }),
    resolveIntent: async () => {}, botRequest: async (input) => { calls += 1; sent.push(input.body as Record<string, unknown>); return { status: "accepted" }; },
  })); await app.ready(); return app; };
  try {
    const app = await make("2026-09-09T15:00:00Z");
    const accepted = await app.inject({ method: "POST", url: "/api/traditional-execution/v1/orders", payload: baseOrder });
    assert.equal(accepted.statusCode, 200, accepted.body); assert.equal(calls, 1); assert.equal(sent.length, 1);
    assert.equal(sent[0]!.environment, "IBKR_PAPER"); assert.equal(sent[0]!.priceBasis, "EXCHANGE_ORDER");
    assert.deepEqual(sent[0]!.contract, { root: "CL", contractCode: "CLX26", expiry: "2026-10-20", multiplier: 1000, tickSize: 0.01, tickValue: 10 });
    const index = await app.inject({ method: "POST", url: "/api/traditional-execution/v1/orders", payload: { ...baseOrder,
      canonicalInstrumentId: SPX, dedupeKey: "traditional:fixture:SPX:1788966000000" } });
    assert.equal(index.statusCode, 422); assert.match(index.body, /read-only/);
    const continuous = await app.inject({ method: "POST", url: "/api/traditional-execution/v1/orders", payload: { ...baseOrder,
      canonicalInstrumentId: CLC, dedupeKey: "traditional:fixture:CLC:1788966000000" } });
    assert.equal(continuous.statusCode, 422); assert.match(continuous.body, /research-only/);
    const offTick = await app.inject({ method: "POST", url: "/api/traditional-execution/v1/orders", payload: { ...baseOrder,
      limitPrice: "70.251", dedupeKey: "traditional:fixture:tick:1788966000000" } });
    assert.equal(offTick.statusCode, 422); assert.match(offTick.body, /off the contract/); assert.equal(calls, 1);
    await app.close();
    const closedApp = await make("2026-09-12T15:00:00Z");
    const closed = await closedApp.inject({ method: "POST", url: "/api/traditional-execution/v1/orders", payload: baseOrder });
    assert.equal(closed.statusCode, 422); assert.match(closed.body, /session is closed/); assert.equal(calls, 1); await closedApp.close();
  } finally { config.traditionalPaperExecutionEnabled = old; }
});

test("Platform boundary derives FX side basis and rejects caller/provider assertions", async () => {
  const old = config.traditionalPaperExecutionEnabled; config.traditionalPaperExecutionEnabled = true;
  const registry = new ProviderRegistry(); registry.register(oandaFxPracticeAdapter); let calls = 0;
  const app = Fastify(); await app.register(async (child) => traditionalExecutionRoutes(child, { registry,
    now: () => Date.parse("2026-09-09T15:00:00Z"), claimIntent: async () => ({ claimed: true, intent: pending }),
    resolveIntent: async () => {}, botRequest: async (input) => { calls += 1; assert.equal((input.body as Record<string, unknown>).priceBasis, "ASK"); return {}; },
  }));
  try {
    const order = { ...baseOrder, canonicalInstrumentId: EURUSD, dedupeKey: "traditional:fixture:EURUSD:1788966000000",
      quantity: "1000", orderType: "MARKET" as const, limitPrice: undefined };
    assert.equal((await app.inject({ method: "POST", url: "/api/traditional-execution/v1/orders", payload: order })).statusCode, 200);
    const asserted = await app.inject({ method: "POST", url: "/api/traditional-execution/v1/orders",
      payload: { ...order, priceBasis: "MID" } });
    assert.equal(asserted.statusCode, 400); assert.match(asserted.body, /provider-derived/); assert.equal(calls, 1);
  } finally { config.traditionalPaperExecutionEnabled = old; await app.close(); }
});
