import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { canonicalizeLegacySpotSymbol, legacyBinanceSpotTicker } from "../lib/instrument";
import { alertCapability, categoryForInstrument, researchAssumptions } from "../lib/workstation";
import { directWatchlistStreamSupported, MAX_CANONICAL_WATCHLIST_STREAMS } from "../lib/useWatchlistTickers";
import { canonicalCandleStreamSupported } from "../lib/useCandleHistory";
import { parseWorkspace } from "../lib/workspace";

const ROOT = path.resolve(__dirname, "..");
const BTC = "instrument:v1:BINANCE:spot:BTC:USDT:USDT:spot";
const PERP = "instrument:v1:BYBIT:perpetual:BTC:USDT:USDT:perpetual";
const FX = "instrument:v1:OANDA:fx_pair:EUR:USD:USD:cash";
const CONTINUOUS = "instrument:v1:NYMEX:continuous_future:CL:USD:USD:continuous-cl-front-calendar-unadjusted";

test("legacy browser identity and stored workspace panes migrate canonically", () => {
  assert.equal(canonicalizeLegacySpotSymbol("BINANCE:btcusdt"), BTC);
  assert.equal(canonicalizeLegacySpotSymbol("INSTRUMENT:V1:NYMEX:CONTINUOUS_FUTURE:CL:USD:USD:CONTINUOUS-CL-FRONT-CALENDAR-UNADJUSTED"), CONTINUOUS);
  assert.equal(legacyBinanceSpotTicker(BTC), "BTCUSDT");
  assert.equal(legacyBinanceSpotTicker("BINANCE:btcusdt"), "BTCUSDT");
  assert.equal(legacyBinanceSpotTicker(PERP), null);
  assert.equal(legacyBinanceSpotTicker(FX), null);
  const restored = parseWorkspace({ version: 2, presetId: "1", activePaneId: "p1", maximizedPaneId: null,
    panes: [{ id: "p1", symbol: "BTCUSDT", interval: "15m", chartType: "candles", bars: 1000,
      maLines: [], compare: { symbol: "ETHUSDT", mode: "percent", length: 60 } }] });
  assert.equal(restored?.panes[0]?.symbol, BTC);
  assert.equal(restored?.panes[0]?.compare?.symbol, "instrument:v1:BINANCE:spot:ETH:USDT:USDT:spot");
});

test("alert and research semantics are capability-driven", () => {
  assert.equal(alertCapability(BTC).supported, true);
  assert.equal(alertCapability(PERP).supported, false);
  assert.match(alertCapability(FX).reason ?? "", /Binance Spot last-price/);
  assert.equal(categoryForInstrument(PERP), "crypto_derivatives");
  assert.equal(categoryForInstrument(FX), "fx");
  assert.ok(researchAssumptions(PERP).some((item) => /historical funding required/.test(item)));
  assert.ok(researchAssumptions(CONTINUOUS).some((item) => /roll cl-front-calendar-unadjusted/.test(item)));
});

test("large mixed watchlists cap live canonical subscriptions and retain shared polling", () => {
  assert.equal(MAX_CANONICAL_WATCHLIST_STREAMS, 12);
  assert.equal(directWatchlistStreamSupported("instrument:v1:COINBASE:spot:BTC:USD:USD:spot"), true);
  assert.equal(directWatchlistStreamSupported(PERP), true);
  assert.equal(directWatchlistStreamSupported(FX), false);
  assert.equal(directWatchlistStreamSupported(CONTINUOUS), false);
  assert.equal(canonicalCandleStreamSupported(FX, "15m"), false);
  assert.equal(canonicalCandleStreamSupported(CONTINUOUS, "15m"), false);
  assert.equal(canonicalCandleStreamSupported("instrument:v1:COINBASE:spot:BTC:USD:USD:spot", "15m"), false);
  assert.equal(canonicalCandleStreamSupported("instrument:v1:COINBASE:spot:BTC:USD:USD:spot", "5m"), true);
  assert.equal(canonicalCandleStreamSupported(PERP, "15m"), true);
  const source = fs.readFileSync(path.join(ROOT, "lib", "useWatchlistTickers.ts"), "utf8");
  assert.match(source, /directCanonical\.slice\(0, MAX_CANONICAL_WATCHLIST_STREAMS\)/);
  assert.match(source, /setCanonicalStreamEligible\(market\?\.providers\.flatMap/,
    "only catalog-resolved instruments may open a direct provider stream");
  assert.match(source, /Canonical persistence must not turn one legacy socket into one/);
  assert.match(source, /combinedStreamPath\(combined\.map/);
  assert.match(source, /api\.marketTickers\(canonical/);
  assert.match(source, /const contentKey = symbols\.map/,
    "effect dependencies must be stable when a parent recreates an equal symbol array");
  assert.match(source, /15-second provider snapshot/);
});

test("all alert entry points and order-ticket chrome use cross-market boundaries", () => {
  const page = fs.readFileSync(path.join(ROOT, "app", "chart", "page.tsx"), "utf8");
  assert.ok((page.match(/alertCapability\(/g) ?? []).length >= 6);
  assert.doesNotMatch(page, /setPriceAlertOpen\(true\)[\s\S]{0,80}isEquityInstrumentId/);
  const side = fs.readFileSync(path.join(ROOT, "components", "tv", "ChartSidePanel.tsx"), "utf8");
  assert.match(side, /Paper \/ demo \/ testnet order ticket/);
});
