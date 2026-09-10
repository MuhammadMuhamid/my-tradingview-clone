import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { canonicalCandleSemantics, canonicalDisplayParts, displaySymbol, instrumentTypeLabel,
  isTraditionalInstrumentId } from "../lib/instrument";
import { SEARCH_MARKET } from "../lib/symbolSearch";

const ROOT = path.resolve(__dirname, "..");
const read = (relative: string) => fs.readFileSync(path.join(ROOT, relative), "utf8");
const eurusd = "instrument:v1:OANDA:fx_pair:EUR:USD:USD:cash";
const clx = "instrument:v1:NYMEX:future:CL:USD:USD:dated-20261020";
const continuous = "instrument:v1:NYMEX:continuous_future:CL:USD:USD:continuous-cl-front-calendar-unadjusted";
const spx = "instrument:v1:CBOE_INDEX:index:SPX:USD:USD:cash";

test("browser identities distinguish OTC FX, specific futures, continuous research and indices", () => {
  assert.deepEqual(canonicalDisplayParts(eurusd), { venue: "OANDA", type: "fx_pair", base: "EUR", quote: "USD",
    settlement: "USD", series: "cash", expiry: null });
  assert.equal(displaySymbol(eurusd), "OANDA:EUR/USD · FX");
  assert.equal(displaySymbol(clx), "NYMEX:CL/USD · FUTURE 2026-10-20");
  assert.equal(displaySymbol(continuous), "NYMEX:CL/USD · CONTINUOUS");
  assert.equal(displaySymbol(spx), "CBOE_INDEX:SPX/USD · INDEX");
  assert.equal(instrumentTypeLabel("continuous_future"), "CONTINUOUS");
  for (const id of [eurusd, clx, continuous, spx]) assert.equal(isTraditionalInstrumentId(id), true);
});

test("chart and range/backtest candle calls state FX basis and continuous methodology", () => {
  assert.equal(canonicalCandleSemantics(eurusd), "&purpose=chart&priceBasis=mid");
  assert.equal(canonicalCandleSemantics(eurusd, "backtest"), "&purpose=backtest&priceBasis=mid");
  assert.equal(canonicalCandleSemantics(continuous),
    "&purpose=chart&rollSchedule=cl-front-calendar-unadjusted&continuousAdjustment=none");
  const api = read("lib/api.ts");
  assert.equal(api.includes("canonicalCandleSemantics(symbol)"), true);
  assert.equal(api.includes("canonicalCandleSemantics(symbol, purpose)"), true, "explicit-range/backtest calls pass their purpose");
  assert.match(read("app/research/[id]/page.tsx"), /"backtest"/);
});

test("unified search/watchlist and chart legend expose feed, contract and non-tradable truth", () => {
  assert.equal(SEARCH_MARKET, "Crypto, stocks, FX, futures & indices");
  const search = read("components/tv/SymbolSearch.tsx"); const watchlist = read("components/tv/Watchlist.tsx");
  const identity = read("components/tv/TraditionalIdentity.tsx"); const legend = read("components/tv/PaneLegend.tsx");
  for (const token of ["continuous_future", "fx_pair", "INDEX", "MID chart", "READ-ONLY REFERENCE", "feed.status"]) {
    assert.match(search, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  for (const asset of ["traditional_future", "reference_index", '"fx" as const']) assert.match(watchlist, new RegExp(asset));
  for (const semantic of ["OTC provider quote · not consolidated", "Chart / backtest basis", "BUY at ask · SELL at bid",
    "Sun–Fri 17:05–16:59 ET · 6m daily break · DST-aware", "First notice / last delivery", "Tick size / value",
    "CONTINUOUS RESEARCH SERIES", "not directly tradable", "CASH/REFERENCE INDEX · READ-ONLY", "delay unknown"]) {
    assert.match(identity, new RegExp(semantic.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(identity, /role="status"/); assert.match(identity, /max-sm:fixed/);
  assert.match(legend, /<TraditionalIdentity symbol=\{symbol\}/);
  assert.match(read("lib/useCandleHistory.ts"), /isTraditionalInstrumentId\(symbol\).*setHeld\(heldWindow\(\[\], window_\)\)/s,
    "a gated traditional feed cannot retain and relabel the previous market's candles");
  assert.match(read("components/tv/ChartPane.tsx"), /live=\{!replayActive && !isCanonicalInstrumentId\(pane\.symbol\)\}/,
    "canonical instruments must never reach the legacy Binance chart subscription");
  assert.match(read("lib/useLivePrice.ts"), /isCanonicalInstrumentId\(symbol\)/,
    "canonical instruments must never reach the legacy Binance toolbar-price subscription");
});
