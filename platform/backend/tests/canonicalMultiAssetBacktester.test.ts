import assert from "node:assert/strict";
import test from "node:test";
import {
  CANONICAL_BACKTEST_INPUT_VERSION,
  runCanonicalBacktest,
  type CanonicalBacktestBar,
  type CanonicalBacktestInput,
  type CanonicalBacktestMethodology,
} from "../src/engine/canonicalMultiAssetBacktester";
import {
  MARKET_CONTRACT_VERSION, UNKNOWN_COMPLIANCE, supported, unsupported,
  type CanonicalInstrument,
} from "../src/market/model";

const MINUTE = 60_000;
const close = (open: number) => open + MINUTE - 1;
const approx = (actual: number, expected: number, tolerance = 1e-10): void =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);

function instrument(overrides: Partial<CanonicalInstrument> & {
  identity: CanonicalInstrument["identity"];
  listing: CanonicalInstrument["listing"];
}): CanonicalInstrument {
  return {
    contractVersion: MARKET_CONTRACT_VERSION,
    currency: overrides.identity.settlementAsset,
    precision: {
      priceTick: { state: "known", value: 0.01 }, quantityLot: { state: "known", value: 0.001 },
      minimumQuantity: { state: "known", value: 0.001 }, minimumNotional: { state: "known", value: 1 },
      priceDecimals: { state: "known", value: 2 }, quantityDecimals: { state: "known", value: 3 },
    },
    derivative: { kind: "none" },
    sessions: { kind: "continuous", timezone: "UTC", calendarId: "24x7", supports24x7: true },
    prices: { last: supported(), bid: unsupported("not loaded"), ask: unsupported("not loaded"),
      mid: unsupported("not loaded"), mark: unsupported("not applicable"), index: unsupported("not applicable") },
    events: { corporateActions: { support: "unsupported", reason: "not applicable" },
      funding: { support: "unsupported", reason: "not applicable" },
      openInterest: { support: "unsupported", reason: "not applicable" } },
    execution: { mutationBoundary: "bot_only", availability: { paper: true, testnet: false, live: false },
      directions: { long: true, short: false }, shortSale: { support: "unsupported", reason: "cash long-only" },
      leverage: { support: "unsupported", reason: "cash" }, marginModes: ["cash"], reduceOnly: false, positionModes: ["one_way"] },
    compliance: UNKNOWN_COMPLIANCE,
    ...overrides,
  };
}

const spot = instrument({
  identity: { canonicalId: "instrument:v1:BINANCE:spot:BTC:USDT:USDT:spot", venueId: "BINANCE",
    assetClass: "crypto", instrumentType: "spot", baseAsset: "BTC", quoteAsset: "USDT",
    settlementAsset: "USDT", series: { kind: "spot" } },
  listing: { providerId: "binance-spot", providerSymbol: "BTCUSDT", status: "active" },
});

function method(overrides: Partial<CanonicalBacktestMethodology> = {}): CanonicalBacktestMethodology {
  return {
    intervalMs: MINUTE, price: { execution: "last", valuation: "last" },
    session: { mode: "continuous" }, adjustment: "not_applicable",
    costs: { commissionRate: 0, commissionFixed: 0, slippageTicks: 0 },
    margin: { model: "cash", leverage: 1, mode: "cash", positionMode: "one_way" },
    funding: { mode: "not_applicable" }, rollover: { mode: "not_applicable" },
    roll: { mode: "not_applicable" }, expiry: { mode: "not_applicable" },
    shorting: { allowed: false, borrowAssumption: "not_applicable" }, ...overrides,
  };
}

function bar(openTime: number, value: number, extras: Partial<CanonicalBacktestBar> = {}): CanonicalBacktestBar {
  return { openTime, closeTime: close(openTime), open: value, high: value + 1, low: value - 1,
    close: value + 0.5, volume: 10, complete: true, ...extras };
}

function input(item: CanonicalInstrument, bars: CanonicalBacktestBar[],
  methodology: CanonicalBacktestMethodology): CanonicalBacktestInput {
  return { schemaVersion: CANONICAL_BACKTEST_INPUT_VERSION, instrument: item, bars, orders: [], events: [],
    methodology, initialCapital: 100_000,
    feed: { providerId: item.listing.providerId, feedId: "fixture-bars", datasetId: "sha256:fixture" } };
}

test("crypto spot preserves corrected next-bar long-only fills, fees, slippage and provenance", () => {
  const t = 1_800_000_000_000;
  const value = input(spot, [bar(t, 100), bar(t + MINUTE, 101), bar(t + 2 * MINUTE, 109)],
    method({ costs: { commissionRate: 0.001, commissionFixed: 0, slippageTicks: 1 } }));
  value.orders = [
    { id: "buy", decisionTime: close(t), side: "BUY", effect: "OPEN", quantity: 1 },
    { id: "sell", decisionTime: close(t + MINUTE), side: "SELL", effect: "CLOSE", reduceOnly: true },
  ];
  const result = runCanonicalBacktest(value);
  assert.deepEqual(result.fills.map((fill) => [fill.time, fill.price, fill.priceRole]), [
    [t + MINUTE, 101.01, "last"], [t + 2 * MINUTE, 108.99, "last"],
  ]);
  approx(result.realizedPnl, 7.98); approx(result.feesPaid, 0.21); approx(result.netPnl, 7.77);
  assert.equal(result.provenance.correctedV2Base.startsWith("engine:v2-corrected:"), true);
  assert.equal(result.provenance.canonicalInstrument, spot.identity.canonicalId);
  assert.deepEqual(result.provenance.costs, value.methodology.costs);
  assert.match(result.provenance.inputHash, /^[0-9a-f]{64}$/);
  const illegal = { ...value, orders: [{ id: "short", decisionTime: close(t), side: "SELL" as const,
    effect: "OPEN" as const, quantity: 1 }] };
  assert.throws(() => runCanonicalBacktest(illegal), /short position requires|long-only/);
});

test("linear perpetual supports short contracts, leverage, mark funding and reduce-only close", () => {
  const t = 1_800_000_300_000;
  const perp = instrument({
    identity: { canonicalId: "instrument:v1:BYBIT:perpetual:ETH:USDT:USDT:perpetual", venueId: "BYBIT",
      assetClass: "crypto", instrumentType: "perpetual", baseAsset: "ETH", quoteAsset: "USDT",
      settlementAsset: "USDT", series: { kind: "perpetual" } },
    listing: { providerId: "bybit-derivatives", providerSymbol: "ETHUSDT", status: "active" },
    derivative: { kind: "contract", contractSize: { value: 0.01, unit: "base" }, multiplier: 0.01,
      quantityUnit: "contracts", settlement: "linear", maturity: { kind: "perpetual" } },
    prices: { ...spot.prices, mark: supported() },
    events: { ...spot.events, funding: { support: "supported", historical: true, stream: true } },
    execution: { ...spot.execution, directions: { long: true, short: true },
      shortSale: { support: "supported", borrowRequired: false, availabilityCheckRequired: false },
      leverage: { support: "supported", minimum: 1, maximum: 20 }, marginModes: ["cross", "isolated"], reduceOnly: true },
  });
  const value = input(perp, [bar(t, 105, { markClose: 104 }), bar(t + MINUTE, 100, { markClose: 98 }),
    bar(t + 2 * MINUTE, 90, { markClose: 90 })], method({ price: { execution: "last", valuation: "mark" },
      margin: { model: "notional_leverage", leverage: 5, mode: "isolated", positionMode: "one_way" },
      funding: { mode: "historical_events", boundaryOrder: "events_before_fills_at_same_timestamp" },
      shorting: { allowed: true, borrowAssumption: "not_applicable" },
      costs: { commissionRate: 0.0005, commissionFixed: 0, slippageTicks: 0 } }));
  value.orders = [{ id: "short", decisionTime: close(t), side: "SELL", effect: "OPEN", quantity: 2 },
    { id: "cover", decisionTime: close(t + MINUTE), side: "BUY", effect: "CLOSE", reduceOnly: true }];
  value.events = [{ id: "funding-1", kind: "funding", at: t + 2 * MINUTE, rate: 0.01, markPrice: 95 }];
  const result = runCanonicalBacktest(value);
  approx(result.realizedPnl, 0.2); approx(result.fundingPnl, 0.019); approx(result.feesPaid, 0.0019);
  approx(result.netPnl, 0.2171); assert.equal(result.trades[0]!.direction, "short");
  assert.deepEqual(result.fills.map((fill) => [fill.price, fill.priceRole, fill.effect]),
    [[100, "last", "OPEN"], [90, "last", "CLOSE"]]);
  assert.equal(result.provenance.providerId, "bybit-derivatives");
  assert.deepEqual(result.provenance.fundingMethodology,
    { mode: "historical_events", boundaryOrder: "events_before_fills_at_same_timestamp" });
  assert.equal(result.ledger[0]!.amount > 0, true,
    "funding at the close-fill timestamp applies before that fill under the declared boundary policy");
});

test("inverse contracts compute settlement PnL and funding from reciprocal prices", () => {
  const t = 1_800_000_600_000;
  const inverse = instrument({
    identity: { canonicalId: "instrument:v1:KRAKEN:perpetual:BTC:USD:BTC:perpetual", venueId: "KRAKEN",
      assetClass: "crypto", instrumentType: "perpetual", baseAsset: "BTC", quoteAsset: "USD",
      settlementAsset: "BTC", series: { kind: "perpetual" } },
    listing: { providerId: "kraken-derivatives", providerSymbol: "PI_XBTUSD", status: "active" },
    derivative: { kind: "contract", contractSize: { value: 100, unit: "quote" }, multiplier: 100,
      quantityUnit: "contracts", settlement: "inverse", maturity: { kind: "perpetual" } },
    prices: { ...spot.prices, mark: supported() }, events: { ...spot.events,
      funding: { support: "supported", historical: true, stream: true } },
    execution: { ...spot.execution, directions: { long: true, short: true },
      shortSale: { support: "supported", borrowRequired: false, availabilityCheckRequired: false },
      leverage: { support: "supported", minimum: 1, maximum: 50 }, marginModes: ["cross"], reduceOnly: true },
  });
  const value = input(inverse, [bar(t, 9_900, { markClose: 9_950 }), bar(t + MINUTE, 10_000, { markClose: 11_000 }),
    bar(t + 2 * MINUTE, 12_000, { markClose: 12_000 })], method({
      price: { execution: "last", valuation: "mark" }, margin: { model: "notional_leverage", leverage: 10, mode: "cross", positionMode: "one_way" },
      funding: { mode: "historical_events", boundaryOrder: "events_before_fills_at_same_timestamp" },
      shorting: { allowed: true, borrowAssumption: "not_applicable" },
    }));
  value.orders = [{ id: "long", decisionTime: close(t), side: "BUY", effect: "OPEN", quantity: 10 },
    { id: "close", decisionTime: close(t + MINUTE), side: "SELL", effect: "CLOSE", reduceOnly: true }];
  value.events = [{ id: "funding", kind: "funding", at: t + MINUTE + 1, rate: 0.001, markPrice: 11_000 }];
  const result = runCanonicalBacktest(value);
  approx(result.realizedPnl, 1_000 * (1 / 10_000 - 1 / 12_000));
  approx(result.fundingPnl, -(1_000 / 11_000) * 0.001);
  assert.equal(result.provenance.priceBasis.valuation, "mark");
  assert.equal(result.provenance.margin.leverage, 10);
});

test("raw equities replay split/dividend economics and never fill outside selected provider sessions", () => {
  const friday = Date.parse("2026-03-06T20:59:00.000Z");
  const saturday = friday + MINUTE;
  const monday = Date.parse("2026-03-09T14:30:00.000Z");
  const monday2 = monday + MINUTE;
  const equity = instrument({
    identity: { canonicalId: "instrument:v1:NASDAQ:stock:AAPL:USD:USD:cash", venueId: "NASDAQ",
      assetClass: "equity", instrumentType: "stock", baseAsset: "AAPL", quoteAsset: "USD",
      settlementAsset: "USD", series: { kind: "cash" } },
    listing: { providerId: "alpaca-us-equities", providerSymbol: "AAPL", status: "active" },
    events: { ...spot.events, corporateActions: { support: "supported", eventTypes: ["split", "dividend"] } },
    execution: { ...spot.execution, directions: { long: true, short: false },
      shortSale: { support: "unsupported", reason: "borrow unavailable" } },
    equity: { securityType: "stock", classificationSource: "fixture", primaryListing: { venueId: "NASDAQ", mic: "XNAS" },
      fractional: supported(), marketData: { defaultFeed: "sip", feedEntitlement: "fixture", feedCoverage: "consolidated",
        feedDelaySeconds: 0, historicalEmbargoSeconds: 0, defaultAdjustment: "raw", executionPriceAdjustment: "raw",
        defaultSession: "regular", extendedHours: supported(), overnight: unsupported("not supported") },
      borrow: { shortable: "no", status: "unknown", availabilityCheckRequired: true, source: "fixture" } },
  });
  const value = input(equity, [bar(friday, 99), bar(saturday, 999), bar(monday, 100), bar(monday2, 55)], method({
    session: { mode: "regular", windows: [{ open: friday, close: saturday, phase: "regular" },
      { open: monday, close: monday + 2 * MINUTE, phase: "regular" }] }, adjustment: "raw",
  }));
  value.orders = [{ id: "buy", decisionTime: close(friday), side: "BUY", effect: "OPEN", quantity: 10 },
    { id: "sell", decisionTime: close(monday), side: "SELL", effect: "CLOSE", reduceOnly: true }];
  value.events = [{ id: "split", kind: "split", at: monday + 10_000, ratio: 2 },
    { id: "dividend", kind: "dividend", at: monday + 20_000, cashPerShare: 1 }];
  const result = runCanonicalBacktest(value);
  assert.equal(result.fills[0]!.time, monday, "the closed-session Saturday bar is never executable");
  approx(result.realizedPnl, 100); approx(result.dividendPnl, 20); approx(result.netPnl, 120);
  assert.equal(result.provenance.adjustmentMode, "raw"); assert.equal(result.provenance.sessionMode, "regular");
  assert.equal(result.provenance.providerId, "alpaca-us-equities");
  const adjusted = { ...value, methodology: { ...value.methodology, adjustment: "all" as const } };
  assert.throws(() => runCanonicalBacktest(adjusted), /adjusted bars cannot also replay/);
});

test("ETF extended-hours shorting requires and records explicit borrow capability", () => {
  const t = Date.parse("2026-03-09T13:00:00.000Z");
  const etf = instrument({
    identity: { canonicalId: "instrument:v1:ARCA:etf:SPY:USD:USD:cash", venueId: "ARCA",
      assetClass: "equity", instrumentType: "etf", baseAsset: "SPY", quoteAsset: "USD",
      settlementAsset: "USD", series: { kind: "cash" } },
    listing: { providerId: "alpaca-us-equities", providerSymbol: "SPY", status: "active" },
    execution: { ...spot.execution, directions: { long: true, short: true },
      shortSale: { support: "supported", borrowRequired: true, availabilityCheckRequired: true } },
    equity: { securityType: "etf", classificationSource: "fixture", primaryListing: { venueId: "ARCA", mic: "ARCX" },
      fractional: supported(), marketData: { defaultFeed: "sip", feedEntitlement: "fixture", feedCoverage: "consolidated",
        feedDelaySeconds: 0, historicalEmbargoSeconds: 0, defaultAdjustment: "raw", executionPriceAdjustment: "raw",
        defaultSession: "regular", extendedHours: supported(), overnight: unsupported("not supported") },
      borrow: { shortable: "yes", status: "easy_to_borrow", availabilityCheckRequired: true, source: "fixture-at-run-start" } },
  });
  const value = input(etf, [bar(t, 505), bar(t + MINUTE, 500), bar(t + 2 * MINUTE, 490)], method({
    session: { mode: "extended", windows: [{ open: t, close: t + 3 * MINUTE, phase: "extended" }] }, adjustment: "raw",
    costs: { commissionRate: 0, commissionFixed: 0.01, slippageTicks: 1 },
    shorting: { allowed: true, borrowAssumption: "available" },
  }));
  value.orders = [{ id: "borrowed-short", decisionTime: close(t), side: "SELL", effect: "OPEN", quantity: 2 },
    { id: "cover", decisionTime: close(t + MINUTE), side: "BUY", effect: "CLOSE", reduceOnly: true }];
  const result = runCanonicalBacktest(value);
  assert.deepEqual(result.fills.map((fill) => fill.price), [499.99, 490.01]);
  approx(result.realizedPnl, 19.96); approx(result.feesPaid, 0.02); approx(result.netPnl, 19.94);
  assert.equal(result.provenance.sessionMode, "extended"); assert.equal(result.provenance.assetClass, "equity");
  assert.throws(() => runCanonicalBacktest({ ...value, methodology: { ...value.methodology,
    shorting: { allowed: true, borrowAssumption: "not_applicable" } } }), /borrow/);
  assert.throws(() => runCanonicalBacktest({ ...value, instrument: { ...etf, equity: { ...etf.equity!,
    borrow: { ...etf.equity!.borrow, shortable: "unknown" } } } }), /affirmative borrow snapshot/);
});

test("FX uses ask/bid spread, provider week boundaries, and explicit rollover events", () => {
  const t = Date.parse("2026-03-09T14:30:00.000Z");
  const fx = instrument({
    identity: { canonicalId: "instrument:v1:OANDA:fx_pair:EUR:USD:USD:cash", venueId: "OANDA",
      assetClass: "fx", instrumentType: "fx_pair", baseAsset: "EUR", quoteAsset: "USD",
      settlementAsset: "USD", series: { kind: "cash" } },
    listing: { providerId: "oanda-v20-fx-practice", providerSymbol: "EUR_USD", status: "active" },
    sessions: { kind: "calendar", timezone: "America/New_York", calendarId: "oanda-fx", supports24x7: false,
      weeklySessions: [{ days: [1, 2, 3, 4, 5], open: "17:05", close: "16:59" }] },
    prices: { ...spot.prices, last: unsupported("OTC"), bid: supported(), ask: supported(), mid: supported() },
    execution: { ...spot.execution, directions: { long: true, short: true },
      shortSale: { support: "supported", borrowRequired: false, availabilityCheckRequired: false },
      leverage: { support: "supported", minimum: 1, maximum: 50 }, marginModes: ["cross"] },
    fx: { baseCurrency: "EUR", quoteCurrency: "USD", marketStructure: "otc_provider_quote", defaultPriceBasis: "mid",
      supportedPriceBases: ["bid", "ask", "mid"], pipSize: 0.0001,
      rollover: { capability: "provider_dependent", boundaryTime: "17:00", timezone: "America/New_York" },
      feed: { status: "fixture_only", label: "fixture", delaySeconds: null } },
  });
  const bars = [bar(t, 1.1, { bidOpen: 1.099, askOpen: 1.101 }),
    bar(t + MINUTE, 1.1, { bidOpen: 1.099, askOpen: 1.101 }),
    bar(t + 2 * MINUTE, 1.11, { bidOpen: 1.109, askOpen: 1.111 })];
  const value = input(fx, bars, method({ price: { execution: "bid_ask", valuation: "mid" },
    session: { mode: "provider_hours" }, margin: { model: "notional_leverage", leverage: 20, mode: "cross", positionMode: "one_way" },
    rollover: { mode: "historical_events", boundary: "17:00", timezone: "America/New_York" },
    shorting: { allowed: true, borrowAssumption: "not_applicable" } }));
  value.orders = [{ id: "buy", decisionTime: close(t), side: "BUY", effect: "OPEN", quantity: 100_000 },
    { id: "sell", decisionTime: close(t + MINUTE), side: "SELL", effect: "CLOSE", reduceOnly: true }];
  value.events = [{ id: "rollover", kind: "fx_rollover", at: t + MINUTE + 1, amount: -5 }];
  const result = runCanonicalBacktest(value);
  assert.deepEqual(result.fills.map((fill) => [fill.price, fill.priceRole]), [[1.101, "ask"], [1.109, "bid"]]);
  approx(result.realizedPnl, 800, 1e-8); approx(result.rolloverPnl, -5); approx(result.netPnl, 795, 1e-8);
  assert.deepEqual(result.provenance.rolloverMethodology,
    { mode: "historical_events", boundary: "17:00", timezone: "America/New_York" });

  const preDstOpen = Date.parse("2026-03-08T21:04:00.000Z");
  const dstOpen = Date.parse("2026-03-08T21:05:00.000Z");
  const boundary = input(fx, [bar(preDstOpen, 1.1, { bidOpen: 1.099, askOpen: 1.101 }),
    bar(dstOpen, 1.1, { bidOpen: 1.099, askOpen: 1.101 })], value.methodology);
  boundary.orders = [{ id: "dst-open", decisionTime: preDstOpen - 1, side: "BUY", effect: "OPEN", quantity: 1 }];
  assert.equal(runCanonicalBacktest(boundary).fills[0]!.time, dstOpen,
    "17:05 New York is 21:05Z after DST and the 21:04Z bar is closed-session data");
});

test("traditional futures roll specific contracts and retain continuous signal-series provenance", () => {
  const t = Date.parse("2026-03-09T14:30:00.000Z");
  const future = (code: string, expiry: string): CanonicalInstrument => instrument({
    identity: { canonicalId: `instrument:v1:CME:future:ES:USD:USD:dated-${expiry.replaceAll("-", "")}`, venueId: "CME",
      assetClass: "index", instrumentType: "future", baseAsset: "ES", quoteAsset: "USD", settlementAsset: "USD",
      series: { kind: "dated", expiry, delivery: "cash" } },
    listing: { providerId: "ibkr-tws-futures-paper", providerSymbol: code, status: "active" },
    derivative: { kind: "contract", contractSize: { value: 50, unit: "base" }, multiplier: 50,
      quantityUnit: "contracts", settlement: "linear", maturity: { kind: "dated", expiry,
        expiresAt: `${expiry}T21:00:00.000Z`, delivery: "cash" } },
    sessions: { kind: "calendar", timezone: "America/Chicago", calendarId: "cme-globex", supports24x7: false,
      weeklySessions: [{ days: [1, 2, 3, 4, 5], open: "17:00", close: "16:00" }] },
    execution: { ...spot.execution, directions: { long: true, short: true },
      shortSale: { support: "supported", borrowRequired: false, availabilityCheckRequired: false },
      leverage: { support: "supported", minimum: 1, maximum: 20 }, marginModes: ["cross"], reduceOnly: true },
    futures: { exchange: "CME", root: "ES", contractCode: code, monthCode: code.at(-3) ?? null, contractMonth: expiry.slice(0, 7),
      expiry, firstTradeDate: null, lastTradeDate: expiry, firstNoticeDate: null, lastDeliveryDate: expiry,
      multiplier: 50, tickSize: 0.25, tickValue: 12.5, settlementCurrency: "USD", overnightSession: true,
      openInterest: supported(), chainPosition: "front", feed: { status: "fixture_only", label: "fixture", delaySeconds: null } },
  });
  const front = future("ESH27", "2027-03-19"); const next = future("ESM27", "2027-06-18");
  const value = input(front, [bar(t, 4_990), bar(t + MINUTE, 5_000), bar(t + 2 * MINUTE, 5_020)], method({
    session: { mode: "provider_hours" }, margin: { model: "notional_leverage", leverage: 20, mode: "cross", positionMode: "one_way" },
    roll: { mode: "calendar", methodologyId: "es-front-calendar-v1" }, expiry: { mode: "explicit_settlement" },
    shorting: { allowed: true, borrowAssumption: "not_applicable" },
  }));
  value.initialCapital = 20_000;
  value.signalSource = { canonicalInstrumentId: "instrument:v1:CME:continuous_future:ES:USD:USD:continuous-es-front-calendar-v1",
    methodologyId: "es-front-calendar-v1", adjustment: "none" };
  value.orders = [{ id: "open", decisionTime: close(t), side: "BUY", effect: "OPEN", quantity: 1 },
    { id: "close", decisionTime: close(t + MINUTE), side: "SELL", effect: "CLOSE", reduceOnly: true }];
  value.events = [{ id: "roll", kind: "roll", at: t + MINUTE + 10_000, fromInstrumentId: front.identity.canonicalId,
    toInstrument: next, fromPrice: 5_010, toPrice: 5_011 }];
  const result = runCanonicalBacktest(value);
  approx(result.realizedPnl, 950); // (5010-5000)*50 + (5020-5011)*50
  assert.deepEqual(result.provenance.tradedInstruments, [front.identity.canonicalId, next.identity.canonicalId]);
  assert.equal(result.provenance.signalSource?.canonicalInstrumentId.includes(":continuous_future:"), true);
  assert.equal(result.provenance.rollMethodology.methodologyId, "es-front-calendar-v1");
  const continuous = { ...front, identity: { ...front.identity, canonicalId: value.signalSource.canonicalInstrumentId,
    instrumentType: "continuous_future" as const, series: { kind: "continuous" as const, methodologyId: "es-front-calendar-v1" } },
    derivative: { kind: "continuous_series" as const, root: "ES", methodologyId: "es-front-calendar-v1",
      selection: "front" as const, rollTrigger: "calendar" as const, adjustment: "none" as const,
      rollScheduleSource: "fixture", directlyTradable: false as const } };
  assert.throws(() => runCanonicalBacktest({ ...value, instrument: continuous }), /signal\/research series only/);

  const expiryStart = Date.parse("2027-03-19T20:57:00.000Z");
  const expiring = input(front, [bar(expiryStart, 4_990), bar(expiryStart + MINUTE, 5_000),
    bar(expiryStart + 2 * MINUTE, 5_015)], method({ session: { mode: "provider_hours" },
      margin: { model: "notional_leverage", leverage: 20, mode: "cross", positionMode: "one_way" },
      roll: { mode: "hold_to_expiry" }, expiry: { mode: "explicit_settlement" },
      shorting: { allowed: true, borrowAssumption: "not_applicable" } }));
  expiring.initialCapital = 20_000;
  expiring.orders = [{ id: "expiry-open", decisionTime: close(expiryStart), side: "BUY", effect: "OPEN", quantity: 1 }];
  expiring.events = [{ id: "expiry", kind: "expiry", at: Date.parse("2027-03-19T21:00:00.000Z"),
    instrumentId: front.identity.canonicalId, settlementPrice: 5_020 }];
  const settled = runCanonicalBacktest(expiring);
  approx(settled.realizedPnl, 1_000); assert.equal(settled.openPosition, null);
  assert.equal(settled.trades[0]!.exitReason, "expiry");
});

test("missing open-session bars, incomplete bars and hindsight-only orders fail loudly", () => {
  const t = 1_800_001_200_000;
  assert.throws(() => runCanonicalBacktest(input(spot, [bar(t, 100), bar(t + 2 * MINUTE, 102)], method())), /missing bar/);
  assert.throws(() => runCanonicalBacktest(input(spot, [bar(t, 100, { complete: false })], method())), /incomplete/);
  const noFuture = input(spot, [bar(t, 100)], method());
  noFuture.orders = [{ id: "late", decisionTime: close(t), side: "BUY", effect: "OPEN", quantity: 1 }];
  assert.throws(() => runCanonicalBacktest(noFuture), /same-bar\/hindsight fills are forbidden/);
  const invalidFunding = input(spot, [bar(t, 100)], method());
  invalidFunding.events = [{ id: "bad-funding", kind: "funding", at: t, rate: 0.01, markPrice: 100 }];
  assert.throws(() => runCanonicalBacktest(invalidFunding), /perpetual contract/);
});
