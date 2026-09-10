import { performance } from "node:perf_hooks";
import { runCanonicalBacktest, type CanonicalBacktestInput } from "../src/engine/canonicalMultiAssetBacktester";
import type { CanonicalInstrument } from "../src/market/model";

const COUNT = 25_000;
const interval = 60_000;
const unsupported = { support: "unsupported" as const, reason: "benchmark fixture" };
const instrument: CanonicalInstrument = {
  contractVersion: "market.v1",
  identity: { canonicalId: "instrument:v1:BINANCE:spot:BTC:USDT:USDT:spot", venueId: "BINANCE",
    assetClass: "crypto", instrumentType: "spot", baseAsset: "BTC", quoteAsset: "USDT",
    settlementAsset: "USDT", series: { kind: "spot" } },
  listing: { providerId: "binance-spot", providerSymbol: "BTCUSDT", status: "active" }, currency: "USDT",
  precision: { priceTick: { state: "known", value: 0.01 }, quantityLot: { state: "known", value: 0.001 },
    minimumQuantity: { state: "known", value: 0.001 }, minimumNotional: { state: "known", value: 1 },
    priceDecimals: { state: "known", value: 2 }, quantityDecimals: { state: "known", value: 3 } },
  derivative: { kind: "none" },
  sessions: { kind: "continuous", timezone: "UTC", calendarId: "24x7", supports24x7: true },
  prices: { last: { support: "supported" }, bid: unsupported, ask: unsupported, mid: unsupported,
    mark: unsupported, index: unsupported },
  events: { corporateActions: unsupported, funding: unsupported, openInterest: unsupported },
  execution: { mutationBoundary: "bot_only", availability: { paper: true, testnet: true, live: true },
    directions: { long: true, short: false }, shortSale: unsupported, leverage: unsupported,
    marginModes: ["cash"], reduceOnly: false, positionModes: ["one_way"] },
  compliance: { shariah: { status: "unknown", reason: "not_classified_by_market_metadata",
    classificationAuthority: "platform_shariah_policy" }, jurisdictionTags: [] },
};
const start = 1_800_100_000_000 - (1_800_100_000_000 % interval);
const bars = Array.from({ length: COUNT }, (_, index) => {
  const openTime = start + index * interval;
  const price = 100 + (index % 100) / 10;
  return { openTime, closeTime: openTime + interval - 1, open: price, high: price + 1,
    low: price - 1, close: price + 0.1, volume: 10, complete: true };
});
const request: CanonicalBacktestInput = {
  schemaVersion: "canonical-backtest-input.v1", instrument, bars, orders: [], events: [], initialCapital: 10_000,
  feed: { providerId: instrument.listing.providerId, feedId: "synthetic-benchmark", datasetId: "benchmark-v1" },
  methodology: { intervalMs: interval, price: { execution: "last", valuation: "last" },
    session: { mode: "continuous" }, adjustment: "not_applicable",
    costs: { commissionRate: 0.001, commissionFixed: 0, slippageTicks: 0 },
    margin: { model: "cash", leverage: 1, mode: "cash", positionMode: "one_way" }, funding: { mode: "not_applicable" },
    rollover: { mode: "not_applicable" }, roll: { mode: "not_applicable" }, expiry: { mode: "not_applicable" },
    shorting: { allowed: false, borrowAssumption: "not_applicable" } },
};
const began = performance.now();
runCanonicalBacktest(request);
const elapsedMs = performance.now() - began;
const barsPerSecond = COUNT / (elapsedMs / 1000);
if (elapsedMs > 5_000) throw new Error(`material regression: ${COUNT} bars took ${elapsedMs.toFixed(1)}ms`);
process.stdout.write(JSON.stringify({ benchmark: "canonical-multiasset-v1", bars: COUNT,
  elapsedMs: Number(elapsedMs.toFixed(1)), barsPerSecond: Math.round(barsPerSecond), ceilingMs: 5_000 }) + "\n");
