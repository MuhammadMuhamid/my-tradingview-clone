import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import Fastify from "fastify";
import {
  createAlpacaUsEquityAdapter, type AlpacaEquityDependencies, type NormalizedAlpacaAsset,
} from "../src/market/alpacaEquitiesAdapter";
import { runProviderConformance } from "../src/market/conformance";
import { canonicalInstrumentId } from "../src/market/model";
import { ProviderRegistry } from "../src/market/registry";
import {
  assertEquityPricePurpose, equitySessionPhase, expectedEquityBars, replayCorporateActions,
} from "../src/market/usEquities";
import { marketCatalogRoutesFor } from "../src/api/routes/marketCatalog";
import { manualTradingRoutes } from "../src/api/routes/manualTrading";
import { EQUITY_ALERT_UNAVAILABLE, isCanonicalEquityAlertSymbol } from "../src/api/routes/maAlerts";
import { config } from "../src/config";
import { equityExecutionRoutes } from "../src/api/routes/equityExecution";
import type { Candle, Interval } from "../src/types/market";
import type { EquityCorporateAction, MarketCalendarDay } from "../src/market/provider";
import {
  ALPACA_DATA_ORIGIN, ALPACA_PAPER_ORIGIN, createAlpacaHttpDependencies,
} from "../src/market/alpacaEquitiesHttp";

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "alpacaUsEquities.json"), "utf8")) as {
  assets: NormalizedAlpacaAsset[];
  calendar: MarketCalendarDay[];
  bars: Array<Omit<Candle, "symbol" | "interval" | "closeTime">>;
  actions: Array<Omit<EquityCorporateAction, "canonicalInstrumentId">>;
};

function dependencies(counters = { bars: 0 }): AlpacaEquityDependencies {
  return {
    list: async () => fixture.assets,
    bars: async (symbol, interval: Interval, startMs, endMs) => {
      counters.bars += 1;
      return fixture.bars.filter((bar) => bar.openTime >= startMs && bar.openTime <= endMs).map((bar) => ({
        ...bar, symbol, interval, closeTime: bar.openTime + 59_999,
      }));
    },
    tickers: async (symbols) => symbols.map((symbol, index) => ({
      symbol, observedAt: Date.parse("2026-09-10T12:00:00Z"), last: index === 0 ? 225.5 : 650.25,
    })),
    calendar: async (startDate, endDate) => fixture.calendar.filter((day) => day.date >= startDate && day.date <= endDate),
    corporateActions: async (symbol, canonicalInstrumentId, startDate, endDate) => fixture.actions
      .filter((action) => action.providerSymbol === symbol && action.exDate >= startDate && action.exDate <= endDate)
      .map((action) => ({ ...action, canonicalInstrumentId })),
  };
}

function registry(counters = { bars: 0 }): ProviderRegistry {
  const value = new ProviderRegistry();
  value.register(createAlpacaUsEquityAdapter(dependencies(counters), {
    id: "alpaca-us-equities-fixture", access: { mode: "public", proof: "official_contract" },
  }));
  return value;
}

const AAPL = "instrument:v1:NASDAQ:stock:AAPL:USD:USD:cash";
const SPY = "instrument:v1:ARCA:etf:SPY:USD:USD:cash";

test("official Alpaca HTTP transport is fixed-host, authenticated and classification-gated", async () => {
  const calls: Array<{ url: URL; headers: Headers }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); calls.push({ url, headers: new Headers(init?.headers) });
    let body: unknown;
    if (url.pathname === "/v2/assets") body = [{ symbol: "AAPL", name: "Apple", exchange: "NASDAQ",
      status: "active", tradable: true, fractionable: true, shortable: true, borrow_status: "hard_to_borrow" },
      { symbol: "UNCLASSIFIED", name: "Unknown", exchange: "NYSE", status: "active", tradable: true }];
    else if (url.pathname.endsWith("/bars")) body = { bars: [{ t: "2026-03-09T13:30:00Z", o: 100, h: 101, l: 99, c: 100.5, v: 20 }], next_page_token: null };
    else if (url.pathname === "/v2/stocks/trades/latest") body = { trades: { AAPL: { t: "2026-03-09T13:30:10Z", p: 100.5 } } };
    else if (url.pathname === "/v2/calendar") body = [{ date: "2026-03-09", open: "09:30", close: "16:00" }];
    else body = { corporate_actions: { stock_splits: [{ id: "split-1", ex_date: "2026-03-09",
      process_date: "2026-03-08", old_rate: "1", new_rate: "2" }], cash_dividends: [] }, next_page_token: null };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  const deps = createAlpacaHttpDependencies({ apiKey: "paper-key", apiSecret: "paper-secret", fetchImpl,
    classifications: [{ symbol: "AAPL", securityType: "stock", source: "fixture-license-v1" }] });
  const assets = await deps.list();
  assert.equal(assets.length, 1, "an asset without independent stock/ETF classification is omitted");
  assert.equal(assets[0]!.classificationSource, "fixture-license-v1");
  assert.equal(assets[0]!.borrowStatus, "hard_to_borrow");
  assert.equal((await deps.bars("AAPL", "1m", 1773063000000, 1773063060000, "iex"))[0]!.close, 100.5);
  assert.equal((await deps.tickers(["AAPL"], "iex"))[0]!.last, 100.5);
  assert.deepEqual(await deps.calendar("2026-03-09", "2026-03-09"), [{ date: "2026-03-09",
    open: "2026-03-09T13:30:00.000Z", close: "2026-03-09T20:00:00.000Z" }]);
  assert.equal((await deps.corporateActions("AAPL", AAPL, "2026-03-01", "2026-03-10"))[0]!.splitRatio, 2);
  assert.equal(calls.every(({ url }) => url.origin === ALPACA_DATA_ORIGIN || url.origin === ALPACA_PAPER_ORIGIN), true);
  assert.equal(calls.every(({ headers }) => headers.get("APCA-API-KEY-ID") === "paper-key" &&
    headers.get("APCA-API-SECRET-KEY") === "paper-secret"), true);
  const barsUrl = calls.find(({ url }) => url.pathname.endsWith("/bars"))!.url;
  assert.equal(barsUrl.searchParams.get("adjustment"), "raw");
  assert.equal(barsUrl.searchParams.get("feed"), "iex");
});

test("Alpaca adapter models stock/ETF identity, feed entitlement and borrow without assumptions", async () => {
  const adapter = registry().get("alpaca-us-equities-fixture")!;
  const report = await runProviderConformance(adapter, {
    providerSymbol: "AAPL", interval: "1m", startMs: 1772830740000, endMs: 1773063000000,
  });
  assert.equal(report.passed, true, JSON.stringify(report.failures));
  const rows = await adapter.catalog.list();
  assert.deepEqual(rows.map((row) => row.identity.canonicalId), [AAPL, SPY]);
  assert.equal(rows[0]!.equity?.marketData.defaultFeed, "iex");
  assert.equal(rows[0]!.equity?.marketData.feedDelaySeconds, 0);
  assert.equal(rows[0]!.equity?.marketData.historicalEmbargoSeconds, 900);
  assert.equal(rows[0]!.execution.directions.short, true);
  assert.equal(rows[0]!.equity?.borrow.status, "easy_to_borrow");
  assert.equal(rows[1]!.execution.directions.short, false);
  assert.equal(rows[1]!.execution.shortSale.support, "unsupported");
  assert.equal(rows[1]!.compliance.shariah.status, "unknown");
});

test("canonical venue and security type prevent ticker collisions", () => {
  const nyseStock = canonicalInstrumentId({ venueId: "NYSE", instrumentType: "stock", baseAsset: "DUAL",
    quoteAsset: "USD", settlementAsset: "USD", series: { kind: "cash" } });
  const nasdaqStock = canonicalInstrumentId({ venueId: "NASDAQ", instrumentType: "stock", baseAsset: "DUAL",
    quoteAsset: "USD", settlementAsset: "USD", series: { kind: "cash" } });
  const nasdaqEtf = canonicalInstrumentId({ venueId: "NASDAQ", instrumentType: "etf", baseAsset: "DUAL",
    quoteAsset: "USD", settlementAsset: "USD", series: { kind: "cash" } });
  assert.equal(new Set([nyseStock, nasdaqStock, nasdaqEtf]).size, 3);
});

test("calendar semantics preserve DST, holidays and early closes", () => {
  assert.equal(equitySessionPhase(Date.parse("2026-03-06T14:30:00Z"), fixture.calendar), "regular");
  assert.equal(equitySessionPhase(Date.parse("2026-03-09T13:30:00Z"), fixture.calendar), "regular",
    "09:30 ET moves one UTC hour at DST");
  assert.equal(equitySessionPhase(Date.parse("2026-11-26T15:00:00Z"), fixture.calendar), "closed",
    "Thanksgiving is absent from the official-calendar fixture");
  assert.equal(equitySessionPhase(Date.parse("2026-11-27T17:59:00Z"), fixture.calendar), "regular");
  assert.equal(equitySessionPhase(Date.parse("2026-11-27T18:00:00Z"), fixture.calendar), "after",
    "early close is read from the calendar, not assumed to be 16:00");
  assert.equal(expectedEquityBars(fixture.calendar, "1m", 1772830740000, 1773063000000, "regular"), 2,
    "weekend/DST closed-session gap is not counted as missing 24/7 bars");
});

test("corporate actions replay from raw bars reproducibly and execution refuses adjusted prices", () => {
  const raw: Candle[] = [
    { symbol: "AAPL", interval: "1m", openTime: Date.parse("2026-03-06T20:59:00Z"), closeTime: Date.parse("2026-03-06T20:59:59.999Z"),
      open: 100, high: 104, low: 98, close: 102, volume: 1000 },
    { symbol: "AAPL", interval: "1m", openTime: Date.parse("2026-03-09T13:30:00Z"), closeTime: Date.parse("2026-03-09T13:30:59.999Z"),
      open: 52, high: 53, low: 51, close: 52.5, volume: 1200 },
  ];
  const action: EquityCorporateAction = { ...fixture.actions[0]!, canonicalInstrumentId: AAPL };
  const first = replayCorporateActions(raw, [action], "split");
  const second = replayCorporateActions(raw, [action], "split");
  assert.deepEqual(first, second);
  assert.deepEqual(first.actionIds, [action.id]);
  assert.equal(first.bars[0]!.close, 51);
  assert.equal(first.bars[0]!.volume, 2000);
  assert.equal(raw[0]!.close, 102, "raw source is not mutated");
  assert.throws(() => assertEquityPricePurpose("split", "execution", "regular"), /execution prices must be raw/);
  assert.throws(() => assertEquityPricePurpose("all", "alert", "regular"), /alert prices must be raw/);
  assert.throws(() => assertEquityPricePurpose("raw", "alert", "all"), /regular-session-only/);
});

test("equity alerts fail closed until the runner persists calendar and adjustment semantics", () => {
  assert.equal(isCanonicalEquityAlertSymbol(AAPL), true);
  assert.equal(isCanonicalEquityAlertSymbol(SPY), true);
  assert.equal(isCanonicalEquityAlertSymbol("BTCUSDT"), false);
  assert.match(EQUITY_ALERT_UNAVAILABLE, /RAW adjustment and REGULAR session/);
  const routes = fs.readFileSync(path.join(__dirname, "..", "src", "api", "routes", "maAlerts.ts"), "utf8");
  assert.match(routes, /isCanonicalEquityAlertSymbol\(String\(b\.symbol/);
  assert.match(routes, /identity\.error/);
});

test("market API makes adjustment/session/feed meaning explicit and protects study boundaries", async () => {
  const counters = { bars: 0 };
  const app = Fastify(); await app.register(marketCatalogRoutesFor(registry(counters))); await app.ready();
  try {
    const search = await app.inject({ method: "GET", url: "/api/market/v1/search?q=A&type=stock" });
    assert.equal(search.statusCode, 200); assert.equal(search.json().results[0].canonicalId, AAPL);
    assert.equal(search.json().results[0].equity.marketData.feedCoverage, "single_venue");

    const regular = await app.inject({ method: "GET", url: `/api/market/v1/candles/${encodeURIComponent(AAPL)}` +
      "?interval=1m&from=1772830740000&to=1773063000000&format=compact&session=regular&adjustment=raw" });
    assert.equal(regular.statusCode, 200);
    assert.equal(regular.json().marketData.completeness.complete, true);
    assert.equal(regular.json().marketData.completeness.closedSessionGapsIgnored, true);
    assert.deepEqual(regular.json().bars.map((bar: number[]) => bar[0]), [1772830740000, 1773063000000]);
    assert.equal(regular.json().marketData.studies.regularSessionOnly, true);
    assert.equal(regular.json().marketData.feed.delaySeconds, 0);

    const all = await app.inject({ method: "GET", url: `/api/market/v1/candles/${encodeURIComponent(AAPL)}` +
      "?interval=1m&from=1773057600000&to=1773086400000&format=compact&session=all&adjustment=raw" });
    assert.equal(all.json().marketData.studies.extendedHoursIncluded, true);
    assert.equal(all.json().marketData.studies.regularSessionOnly, false);
    assert.deepEqual(all.json().bars.map((bar: number[]) => bar[0]), [1773057600000, 1773063000000, 1773086400000]);

    const before = counters.bars;
    const refused = await app.inject({ method: "GET", url: `/api/market/v1/candles/${encodeURIComponent(AAPL)}` +
      "?interval=1m&from=1772830740000&to=1773063000000&purpose=execution&adjustment=split" });
    assert.equal(refused.statusCode, 422); assert.match(refused.body, /execution prices must be raw/);
    assert.equal(counters.bars, before, "rejected semantics never reach the market-data provider");

    const actions = await app.inject({ method: "GET", url: `/api/market/v1/corporate-actions/${encodeURIComponent(AAPL)}` +
      "?start=2026-03-01&end=2026-03-10" });
    assert.equal(actions.statusCode, 200); assert.equal(actions.json().actions[0].id, fixture.actions[0]!.id);
  } finally { await app.close(); }
});

test("category-aware screener separates stocks and ETFs and rejects semantically mixed studies", async () => {
  const app = Fastify(); await app.register(marketCatalogRoutesFor(registry())); await app.ready();
  try {
    const stock = await app.inject({ method: "GET", url: "/api/market/v1/screener?type=stock" });
    assert.equal(stock.statusCode, 200); assert.deepEqual(stock.json().rows.map((row: { canonicalId: string }) => row.canonicalId), [AAPL]);
    const etf = await app.inject({ method: "GET", url: "/api/market/v1/screener?type=etf" });
    assert.equal(etf.statusCode, 200); assert.deepEqual(etf.json().rows.map((row: { canonicalId: string }) => row.canonicalId), [SPY]);
    const extended = await app.inject({ method: "GET", url: "/api/market/v1/screener?type=stock&session=all" });
    assert.equal(extended.statusCode, 422); assert.match(extended.body, /regular-session\/raw-only/);
  } finally { await app.close(); }
});

test("Platform rejects closed and unsupported equity states before contacting Bot", async () => {
  const adapter = registry().get("alpaca-us-equities-fixture")!;
  const equity = (await adapter.catalog.metadata(["AAPL"]))[0]!;
  let botCalls = 0;
  const prior = config.manualTradingEnabled; config.manualTradingEnabled = true;
  const app = Fastify();
  await app.register(async (child) => manualTradingRoutes(child, {
    executionTarget: () => ({ providerId: adapter.id, venueId: "NASDAQ", instrumentType: "stock",
      capabilities: equity.execution, marketState: { kind: "calendar", phase: "closed",
        listingStatus: "active", observedAt: "2026-09-10T22:00:00Z" } }),
    botRequest: (async () => { botCalls += 1; return {}; }) as never,
  }));
  try {
    const closed = await app.inject({ method: "POST", url: "/api/manual-trading/orders",
      payload: { symbol: AAPL, side: "BUY", environment: "paper", orderType: "MARKET" } });
    assert.equal(closed.statusCode, 422); assert.match(closed.body, /session is closed/); assert.equal(botCalls, 0);
  } finally { config.manualTradingEnabled = prior; await app.close(); }
});

const equityOrder = { deploymentId: "00000000-0000-4000-8000-000000000040",
  dedupeKey: "equity:alpaca:AAPL:1773063000000", barTime: 1_773_063_000_000,
  canonicalInstrumentId: AAPL, side: "BUY", positionEffect: "OPEN_LONG", quantity: "2.5",
  orderType: "MARKET", timeInForce: "DAY", extendedHours: false };
const pendingEquityIntent = { id: 84, deploymentId: equityOrder.deploymentId, alertId: null,
  dedupeKey: equityOrder.dedupeKey, action: "buy" as const, barTime: equityOrder.barTime,
  exitLeg: null, state: "pending" as const, resolvedAt: null, detail: null, emitterId: null,
  createdAt: Date.parse("2026-03-09T14:30:00.000Z") };
const allowShariah = async () => ({ allowed: true, reason: null, context: { mode: "off" as const,
  policyVersion: null, assetId: null, baseAsset: null, effectiveStatus: "REVIEW" as const,
  publicationId: null } });

test("signed X4 proxy derives raw paper/session/asset truth before durable Bot delivery", async () => {
  const old = config.equityPaperExecutionEnabled; config.equityPaperExecutionEnabled = true;
  const events: string[] = []; let sent: Record<string, unknown> | null = null;
  const app = Fastify();
  await app.register(async (child) => equityExecutionRoutes(child, { registry: registry(),
    providerId: "alpaca-us-equities-fixture", now: () => Date.parse("2026-03-09T14:30:00.000Z"),
    evaluateShariah: allowShariah,
    claimIntent: async () => { events.push("claim"); return { claimed: true, intent: pendingEquityIntent }; },
    botRequest: async (input) => { events.push("bot"); sent = input.body as Record<string, unknown>; return { status: "NEW" }; },
    resolveIntent: async (id, state) => { events.push("resolve"); assert.equal(id, 84); assert.equal(state, "delivered"); },
  }));
  try {
    const response = await app.inject({ method: "POST", url: "/api/equity-execution/v1/orders", payload: equityOrder });
    assert.equal(response.statusCode, 200, response.body); assert.deepEqual(events, ["claim", "bot", "resolve"]);
    assert.ok(sent); const body = sent as unknown as Record<string, unknown>;
    assert.equal(body.environment, "paper"); assert.equal(body.providerSymbol, "AAPL");
    assert.equal(body.instrumentType, "STOCK"); assert.equal(body.primaryVenue, "NASDAQ");
    assert.equal(body.adjustmentMode, "raw");
    assert.deepEqual(body.session, { phase: "REGULAR", observedAt: "2026-03-09T14:30:00.000Z",
      calendarDate: "2026-03-09" });
    assert.deepEqual(body.asset, { status: "ACTIVE", tradable: true, fractionable: true,
      shortable: true, borrowStatus: "EASY_TO_BORROW", observedAt: "2026-03-09T14:30:00.000Z" });
    const platformIntent = body.platformIntent as Record<string, string>;
    assert.equal(platformIntent.id, "x4_platform_intent_84");
    assert.equal(typeof platformIntent.payloadHash, "string");
    assert.match(platformIntent.payloadHash!, /^[0-9a-f]{64}$/);
    assert.equal(body.deploymentId, undefined, "browser durability fields are not forwarded as provider truth");
  } finally { config.equityPaperExecutionEnabled = old; await app.close(); }
});

test("X4 proxy refuses closed sessions and caller-asserted provider semantics before claim or Bot", async () => {
  const old = config.equityPaperExecutionEnabled; config.equityPaperExecutionEnabled = true;
  let claims = 0; let botCalls = 0;
  const app = Fastify(); await app.register(async (child) => equityExecutionRoutes(child, { registry: registry(),
    providerId: "alpaca-us-equities-fixture", now: () => Date.parse("2026-11-26T15:00:00.000Z"),
    evaluateShariah: allowShariah,
    claimIntent: async () => { claims += 1; return { claimed: true, intent: pendingEquityIntent }; },
    botRequest: async () => { botCalls += 1; return {}; }, resolveIntent: async () => {},
  }));
  try {
    const closed = await app.inject({ method: "POST", url: "/api/equity-execution/v1/orders", payload: equityOrder });
    assert.equal(closed.statusCode, 422); assert.match(closed.body, /session is closed/);
    const asserted = await app.inject({ method: "POST", url: "/api/equity-execution/v1/orders",
      payload: { ...equityOrder, providerSymbol: "AAPL", adjustmentMode: "split" } });
    assert.equal(asserted.statusCode, 400); assert.match(asserted.body, /provider-derived field/);
    const unsupported = await app.inject({ method: "POST", url: "/api/equity-execution/v1/orders",
      payload: { ...equityOrder, extendedHours: true } });
    assert.equal(unsupported.statusCode, 422); assert.match(unsupported.body, /must be LIMIT/);
    assert.equal(claims, 0); assert.equal(botCalls, 0);
  } finally { config.equityPaperExecutionEnabled = old; await app.close(); }
});

test("X4 proxy refuses unresolved duplicate intents without blind Bot replay", async () => {
  const old = config.equityPaperExecutionEnabled; config.equityPaperExecutionEnabled = true;
  let botCalls = 0;
  const app = Fastify(); await app.register(async (child) => equityExecutionRoutes(child, { registry: registry(),
    providerId: "alpaca-us-equities-fixture", now: () => Date.parse("2026-03-09T14:30:00.000Z"),
    evaluateShariah: allowShariah, claimIntent: async () => ({ claimed: false, existing: pendingEquityIntent }),
    botRequest: async () => { botCalls += 1; return {}; }, resolveIntent: async () => {},
  }));
  try {
    const response = await app.inject({ method: "POST", url: "/api/equity-execution/v1/orders", payload: equityOrder });
    assert.equal(response.statusCode, 409); assert.match(response.body, /no retry was sent/); assert.equal(botCalls, 0);
  } finally { config.equityPaperExecutionEnabled = old; await app.close(); }
});
