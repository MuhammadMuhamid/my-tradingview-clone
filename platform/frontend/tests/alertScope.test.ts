/**
 * Arming one alert across a watchlist or every tracked coin.
 *
 * What is pinned here is what a bulk save DOES, because the dialog states it
 * before Save is pressed and the user approves it on that basis:
 *
 *  - which coins a scope means, and which it must leave out;
 *  - whether the alert engine can actually watch the result — past its feed
 *    cap an alert shows as armed and never fires, silently;
 *  - that each coin's existing alert is EDITED, not left behind beside a twin;
 *  - that one failing coin does not abandon the rest half done.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  ALERT_FEED_CAP, allAlertableSymbols, armAcross, armingSummary, feedBudget,
  isAlertable, parseScope, planArming, scopeTargets, scopeValue,
} from "../lib/alertScope";
import type { MaAlert, ServerWatchlist } from "../lib/api";
import type { Interval, SymbolInfo } from "../lib/types";

const sym = (symbol: string, over: Partial<SymbolInfo> = {}): SymbolInfo => ({
  symbol, baseAsset: symbol.replace(/USDT$/, ""), quoteAsset: "USDT",
  priceTick: null, qtyStep: null, minNotional: null, isActive: true, ...over,
});

const alert = (id: string, over: Partial<MaAlert>): MaAlert =>
  ({ id, symbol: "BTCUSDT", timeframe: "15m", conditionKind: "rsi", enabled: true,
     completedAt: null, ...over } as MaAlert);

const wl = (id: string, symbols: string[]): ServerWatchlist =>
  ({ id, name: id, symbols, position: 0, updatedAt: "" });

// ── the engine's real limit ────────────────────────────────────────────────

test("the feed cap is the backend's own, read from the file that enforces it", () => {
  const ws = fs.readFileSync(
    path.join(process.cwd(), "..", "backend", "src", "data", "binanceWs.ts"), "utf8");
  const m = ws.match(/const MAX_STREAMS_PER_CONN = (\d+)/);
  assert.ok(m, "MAX_STREAMS_PER_CONN not found — the alert engine's feed limit moved");
  assert.equal(ALERT_FEED_CAP, Number(m[1]),
    "the dialog's budget must equal the engine's cap, or it will allow alerts that never fire");
});

// ── which coins a scope means ──────────────────────────────────────────────

test("the scope round-trips through its select value", () => {
  for (const s of [{ kind: "symbol" }, { kind: "all" }, { kind: "watchlist", id: "w-1" }] as const) {
    assert.deepEqual(parseScope(scopeValue(s)), s);
  }
});

test("this coin only is just the chart's coin", () => {
  assert.deepEqual(scopeTargets({ kind: "symbol" }, "nearusdt", [], []),
    { symbols: ["NEARUSDT"], excluded: [] });
});

test("all coins means active, tracked Binance spot — once each, sorted", () => {
  const tracked = [
    sym("SOLUSDT"), sym("BTCUSDT"), sym("btcusdt"),
    sym("OLDUSDT", { isActive: false }),
    sym("AAPL", { venue: "ALPACA", assetClass: "us_equity" }),
    sym("BTCUSDT-PERP", { venue: "BINANCE", assetClass: "crypto_derivative" }),
    sym("ETHUSDT", { venue: undefined, assetClass: undefined }),
  ];
  assert.deepEqual(allAlertableSymbols(tracked), ["BTCUSDT", "ETHUSDT", "SOLUSDT"],
    "inactive coins, other venues and derivatives cannot be watched by the alert engine");
});

test("a pre-venue catalogue row counts as Binance spot, as the catalogue defaults it", () => {
  assert.equal(isAlertable({}), true);
  assert.equal(isAlertable({ venue: "BINANCE", assetClass: "crypto_spot" }), true);
  assert.equal(isAlertable({ venue: "ALPACA" }), false);
});

test("a watchlist keeps the user's coins, minus ones known to be elsewhere", () => {
  const tracked = [sym("BTCUSDT"), sym("AAPL", { venue: "ALPACA", assetClass: "us_equity" })];
  const t = scopeTargets({ kind: "watchlist", id: "w" }, "BTCUSDT",
    [wl("w", ["btcusdt", "BTCUSDT", "AAPL", "NEWCOINUSDT"])], tracked);
  assert.deepEqual(t.symbols, ["BTCUSDT", "NEWCOINUSDT"],
    "deduplicated, and a coin the catalogue has never seen is still the user's choice");
  assert.deepEqual(t.excluded, ["AAPL"], "left out, and REPORTED rather than silently dropped");
});

test("a watchlist that no longer exists arms nothing", () => {
  assert.deepEqual(scopeTargets({ kind: "watchlist", id: "gone" }, "BTCUSDT", [], []),
    { symbols: [], excluded: [] });
});

// ── whether the engine can watch it ────────────────────────────────────────

const target = (symbol: string, timeframe: Interval) => ({ symbol, timeframe });

test("feeds are counted the way the runner counts them", () => {
  const existing = [
    alert("a", { symbol: "BTCUSDT", timeframe: "15m" }),
    alert("b", { symbol: "BTCUSDT", timeframe: "15m", conditionKind: "macd" }),  // same feed
    alert("c", { symbol: "ETHUSDT", timeframe: "1h", enabled: false }),           // paused: none
    alert("d", { symbol: "SOLUSDT", timeframe: "4h", completedAt: "2026-10-01" }), // retired: none
  ];
  const b = feedBudget(existing, [target("BTCUSDT", "15m"), target("ETHUSDT", "1h")], true);
  assert.equal(b.inUse, 1, "two alerts on one coin and timeframe share one feed");
  assert.equal(b.after, 2, "BTCUSDT 15m is already streaming; ETHUSDT 1h is the only new feed");
});

test("alerts saved paused take no feed, so they always fit", () => {
  const many = Array.from({ length: 500 }, (_, i) => target(`C${i}USDT`, "15m"));
  const b = feedBudget([], many, false);
  assert.equal(b.after, 0);
  assert.equal(b.fits, true);
});

test("the cap is inclusive: exactly the cap fits, one more does not", () => {
  const n = (k: number) => Array.from({ length: k }, (_, i) => target(`C${i}USDT`, "15m"));
  assert.equal(feedBudget([], n(ALERT_FEED_CAP), true).fits, true);
  assert.equal(feedBudget([], n(ALERT_FEED_CAP + 1), true).fits, false);
});

test("all coins on four timeframes is refused when it would not be watched", () => {
  const coins = Array.from({ length: 80 }, (_, i) => `C${i}USDT`);
  const plan = planArming(coins, ["5m", "15m", "1h", "4h"], [], () => false);
  const b = feedBudget([], plan, true);
  assert.equal(b.after, 320);
  assert.equal(b.fits, false, "320 feeds would leave 120 alerts armed and silent");
});

// ── edit, never twin ───────────────────────────────────────────────────────

test("each coin's existing alert is edited, matched on that coin only", () => {
  const existing = [
    alert("btc-15m", { symbol: "BTCUSDT", timeframe: "15m" }),
    alert("eth-1h", { symbol: "ethusdt", timeframe: "1h" }),
  ];
  const sameRsi = (a: MaAlert, tf: Interval) => a.conditionKind === "rsi" && a.timeframe === tf;
  const plan = planArming(["BTCUSDT", "ETHUSDT", "SOLUSDT"], ["15m", "1h"], existing, sameRsi);
  const id = (s: string, tf: string) => plan.find((p) => p.symbol === s && p.timeframe === tf)!.existingId;

  assert.equal(plan.length, 6, "one request per coin × timeframe");
  assert.equal(id("BTCUSDT", "15m"), "btc-15m");
  assert.equal(id("ETHUSDT", "1h"), "eth-1h", "symbol matching ignores case");
  assert.equal(id("ETHUSDT", "15m"), null, "BTCUSDT's 15m alert is not ETHUSDT's");
  assert.equal(id("SOLUSDT", "15m"), null);
});

test("the dialog's own rule decides sameness — a different family is a new alert", () => {
  const existing = [alert("btc-macd", { symbol: "BTCUSDT", timeframe: "15m", conditionKind: "macd" })];
  const sameRsi = (a: MaAlert, tf: Interval) => a.conditionKind === "rsi" && a.timeframe === tf;
  assert.equal(planArming(["BTCUSDT"], ["15m"], existing, sameRsi)[0]!.existingId, null);
});

// ── running it ─────────────────────────────────────────────────────────────

test("one failing coin is reported and the rest still arm, in order", async () => {
  const plan = planArming(["AUSDT", "BUSDT", "CUSDT"], ["15m"], [], () => false);
  const seen: string[] = [];
  const progress: string[] = [];
  const result = await armAcross(plan, async (item) => {
    seen.push(item.symbol);
    if (item.symbol === "BUSDT") throw new Error("symbol is delisted");
  }, (done, total) => progress.push(`${done}/${total}`));

  assert.deepEqual(seen, ["AUSDT", "BUSDT", "CUSDT"], "sequential, and it did not stop at B");
  assert.deepEqual(result.done.map((i) => i.symbol), ["AUSDT", "CUSDT"]);
  assert.deepEqual(result.failed.map((f) => [f.item.symbol, f.reason]), [["BUSDT", "symbol is delisted"]]);
  assert.deepEqual(progress, ["1/3", "2/3", "3/3"]);
});

test("the summary says what happened, including updates and failures", () => {
  const plan = planArming(["AUSDT", "BUSDT"], ["15m", "1h"], [
    alert("x", { symbol: "AUSDT", timeframe: "15m" }),
  ], (a, tf) => a.timeframe === tf);
  assert.equal(
    armingSummary({ done: plan, failed: [] }, ["15m", "1h"]),
    "4 alerts armed across 2 coins · 15m, 1h (1 existing updated, not duplicated)");
  assert.equal(
    armingSummary({ done: plan.slice(0, 3), failed: [{ item: plan[3]!, reason: "timeout" }] },
      ["15m", "1h"], "saved"),
    "3 alerts saved across 2 coins · 15m, 1h (1 existing updated, not duplicated)"
      + " · 1 failed — BUSDT 1h: timeout");
});

// ── watchlists hold canonical instrument ids ───────────────────────────────

/*
 * Found by driving the real release: a watchlist saved through the API stores
 * `instrument:v1:BINANCE:spot:BTC:USDT:USDT:spot`, while alerts are stored
 * under `BTCUSDT`. Upper-casing the id produced a ticker nothing recognised,
 * matched no existing alert (so it would have armed a twin), and could not
 * tell a perpetual or a stock from spot.
 */
const C = (base: string, venue = "BINANCE", type = "spot") =>
  `instrument:v1:${venue}:${type}:${base}:USDT:USDT:${type}`;

test("a canonical watchlist entry becomes the ticker alerts are stored under", () => {
  const t = scopeTargets({ kind: "watchlist", id: "w" }, "BTCUSDT",
    [wl("w", [C("BTC"), C("ETH"), "solusdt", C("BTC")])], []);
  assert.deepEqual(t.symbols, ["BTCUSDT", "ETHUSDT", "SOLUSDT"], "one key per coin, however written");
  assert.deepEqual(t.excluded, []);
});

test("a canonical perpetual or stock is left out and reported, never armed", () => {
  const perp = C("BTC", "BINANCE", "perp");
  const stock = "instrument:v1:ALPACA:stock:AAPL:USD:USD:stock";
  const t = scopeTargets({ kind: "watchlist", id: "w" }, "BTCUSDT",
    [wl("w", [C("ETH"), perp, stock])], []);
  assert.deepEqual(t.symbols, ["ETHUSDT"]);
  assert.deepEqual(t.excluded, [perp, stock], "kept as written, so the dialog can name them");
});

test("a coin's existing alert is found whichever way the coin was written", () => {
  const existing = [alert("eth-15m", { symbol: "ETHUSDT", timeframe: "15m" })];
  const plan = planArming(["ETHUSDT"], ["15m"], existing, (a, tf) => a.timeframe === tf);
  assert.equal(plan[0]!.existingId, "eth-15m");
  const fromCanonical = scopeTargets({ kind: "watchlist", id: "w" }, "X", [wl("w", [C("ETH")])], []);
  assert.equal(planArming(fromCanonical.symbols, ["15m"], existing, (a, tf) => a.timeframe === tf)[0]!
    .existingId, "eth-15m", "a canonical watchlist entry edits the bare-ticker alert, not a twin");
});

test("feeds already streaming are recognised across spellings", () => {
  const existing = [alert("a", { symbol: "ETHUSDT", timeframe: "15m" })];
  const b = feedBudget(existing, [{ symbol: C("ETH"), timeframe: "15m" }], true);
  assert.equal(b.after, 1, "ETH 15m is one feed whether written as a ticker or an id");
});
