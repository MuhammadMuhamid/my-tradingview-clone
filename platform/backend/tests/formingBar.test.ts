/**
 * A bar that has not closed must not enter the shared candle store.
 *
 * Binance returns the CURRENT, still-forming kline whenever the requested
 * window reaches the present. Nothing dropped it, so it went into `candles`
 * through `upsertCandles` looking exactly like a completed bar — and its
 * "close" was whatever the price happened to be at the instant of the request.
 * Backtests, studies and alert evaluation all read it as a settled close.
 *
 * It self-healed on the next backfill, because the upsert is a DO UPDATE on
 * (symbol, interval, open_time). That is precisely what let it survive
 * unnoticed: the store is eventually right, and wrong only in the window where
 * the newest bar is the one most things are looking at.
 *
 * Every stored backtest result carries
 * `dataCompleteness: "incomplete_live_bars_not_persisted"`. This is the test
 * that makes the claim true of the REST path.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const SRC = path.join(__dirname, "..", "src");

test("the kline pager drops any row whose close time has not passed", () => {
  const source = fs.readFileSync(path.join(SRC, "data", "binanceRest.ts"), "utf8");
  const pager = /async function\* klinePages\([\s\S]*?\n\}/.exec(source);
  assert.ok(pager, "klinePages could not be located");
  /*
   * Asserted on the pager specifically because it is the ONE choke point: both
   * `fetchKlines` and the bulk acquisition path iterate it, so a guard here
   * cannot be bypassed by adding a third caller.
   */
  assert.match(pager[0], /r\[6\] >= now/,
    "a still-forming kline is admitted to the candle store");
  assert.match(pager[0], /const now = Date\.now\(\)/,
    "the comparison needs a clock read inside the pager");
});

test("both persistence paths go through that one pager", () => {
  const source = fs.readFileSync(path.join(SRC, "data", "binanceRest.ts"), "utf8");
  /*
   * If a path ever fetched klines without the pager, the guard would be
   * bypassed for it — so the number of places that actually BUILD a klines URL
   * is itself the invariant. Counted on URL construction rather than on the
   * path string, which also appears in prose.
   */
  const builders = source.split("\n")
    .filter((line) => line.includes("/api/v3/klines") && line.includes("base()"));
  assert.equal(builders.length, 1,
    `a second kline fetcher would bypass the forming-bar guard: ${builders.join(" | ")}`);
});

test("the completeness claim every stored result carries is the one this enforces", () => {
  const backtester = fs.readFileSync(path.join(SRC, "engine", "backtester.ts"), "utf8");
  assert.match(backtester, /incomplete_live_bars_not_persisted/,
    "the provenance string this guard exists to make true has moved or gone");
});
