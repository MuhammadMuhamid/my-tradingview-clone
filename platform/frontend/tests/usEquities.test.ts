import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  canonicalCandleSemantics, canonicalDisplayParts, displaySymbol, instrumentTypeLabel,
  isEquityInstrumentId, storedSymbol,
} from "../lib/instrument";
import { heldWindow } from "../lib/useCandleHistory";
import type { Candle } from "../lib/types";

const ROOT = path.resolve(__dirname, "..");
const read = (relative: string) => fs.readFileSync(path.join(ROOT, relative), "utf8");
const aapl = "instrument:v1:NASDAQ:stock:AAPL:USD:USD:cash";
const spy = "instrument:v1:ARCA:etf:SPY:USD:USD:cash";

test("canonical stock and ETF identities preserve venue and product collisions", () => {
  assert.deepEqual(canonicalDisplayParts(aapl), {
    venue: "NASDAQ", type: "stock", base: "AAPL", quote: "USD", settlement: "USD",
    series: "cash", expiry: null,
  });
  assert.equal(isEquityInstrumentId(aapl), true);
  assert.equal(isEquityInstrumentId(spy), true);
  assert.equal(storedSymbol(aapl), aapl);
  assert.equal(displaySymbol(aapl), "NASDAQ:AAPL/USD · STOCK");
  assert.equal(displaySymbol(spy), "ARCA:SPY/USD · ETF");
  assert.equal(instrumentTypeLabel("etf"), "ETF");
  assert.notEqual(displaySymbol(aapl), displaySymbol("instrument:v1:NYSE:stock:AAPL:USD:USD:cash"));
  assert.equal(isEquityInstrumentId("instrument:v1:NASDAQ:stock:AAPL:USD:USD:spot"), false);
});

test("equity chart requests are explicitly regular-session raw data", () => {
  const source = read("lib/api.ts");
  const contract = "session=regular&adjustment=raw${canonicalCandleSemantics";
  assert.equal(source.split(contract).length - 1, 2,
    "both depth and range requests must preserve the same study-safe boundary");
  assert.equal(canonicalCandleSemantics(aapl), "&purpose=chart");
  assert.equal(canonicalCandleSemantics(aapl, "backtest"), "&purpose=backtest");
  assert.match(source, /equityInstrument:.*EquityInstrumentResponse/s);
});

test("closed equity sessions do not trigger crypto-style 24/7 tail repair", () => {
  const old = Date.parse("2026-03-06T20:59:00.000Z");
  const bar: Candle = { symbol: aapl, interval: "1m", openTime: old,
    closeTime: old + 59_999, open: 100, high: 101, low: 99, close: 100, volume: 10 };
  assert.equal(heldWindow([bar], { symbol: aapl, interval: "1m", bars: 1000 },
    Date.parse("2026-03-09T12:00:00.000Z")).stale, false);
  assert.match(read("lib/useCandleHistory.ts"), /Server-side calendar completeness remains the authority/);
});

test("workstation identity makes venue, session, feed delay and adjustment legible", () => {
  const identity = read("components/tv/EquityIdentity.tsx");
  const legend = read("components/tv/PaneLegend.tsx");
  for (const semantic of ["Regular · 09:30–16:00 ET", "holidays/early closes", "RAW · execution-compatible",
    "Feed entitlement", "Data delay", "Historical embargo", "Explicit split/dividend events",
    "Extended-hours bars are excluded", "Adjusted history is analysis-only", "never assumed"]) {
    assert.match(identity, new RegExp(semantic.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(identity, /role="status"/);
  assert.match(identity, /aria-label="Equity market-data semantics"/);
  assert.match(identity, /max-sm:fixed max-sm:left-3 max-sm:right-3/);
  assert.match(legend, /<EquityIdentity symbol=\{symbol\}/);
});

test("search and watchlists carry stock and ETF category without collapsing canonical ids", () => {
  const search = read("components/tv/SymbolSearch.tsx");
  const watchlist = read("components/tv/Watchlist.tsx");
  assert.match(search, /\["stock", "STOCK"\]/);
  assert.match(search, /\["etf", "ETF"\]/);
  assert.match(search, /REG · RAW ·.*feedDelaySeconds\}s delay/s);
  assert.match(watchlist, /"us_equity" as const/);
  assert.match(watchlist, /canonicalDisplayParts\(s\)/);
});

test("equity alert controls explain the calendar-aware boundary instead of arming a crypto runner", () => {
  const page = read("app/chart/page.tsx");
  assert.match(page, /alertCapability\(symbol\)/);
  assert.match(read("lib/workstation.ts"), /Binance Spot last-price bars only/);
  assert.match(page, /onOpenAutomation=\{openAutomation\}/);
});
