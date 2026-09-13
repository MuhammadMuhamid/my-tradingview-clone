/**
 * The indicator engine, checked against TradingView's own numbers.
 *
 * Every other test in this repo asks whether the engine agrees with itself or
 * with a formula written by the same hand that wrote the engine. This one asks
 * a different question, and it is the one that matters for a product whose
 * whole claim is convergence: given the SAME BARS, does this engine produce
 * the SAME NUMBERS as TradingView?
 *
 * ── How the numbers on the right-hand side were obtained ───────────────────
 *
 * From the live product, on 2026-09-13, not from documentation:
 *
 *   1. `window.TradingViewApi.activeChart()` on an authenticated TradingView
 *      session showing BINANCE:BTCUSDT at 4h.
 *   2. The study models were read directly — `getStudyById(id)._study` — for
 *      their `metaInfo()` (plot titles, so each column is identified by name
 *      rather than by position), their `properties().inputs` (so the
 *      parameters below are TradingView's actual ones, not assumed defaults),
 *      and their `data()` (TradingView's computed value per bar).
 *   3. The values are taken at the last CLOSED bar, 2026-09-13T00:00:00Z, so
 *      nothing here depends on a live bar that was still moving.
 *
 * ── Why this is a comparison and not a coincidence ─────────────────────────
 *
 * The bars are the same bars. `tests/fixtures/binance-btcusdt-4h.json` comes
 * from Binance's own public market-data mirror, and its OHLCV was verified
 * bar-for-bar against the series read out of TradingView's chart model before
 * a single indicator was compared — the first test below re-checks that, and
 * it is the load-bearing one. Two visually similar curves prove nothing; two
 * identical inputs make every remaining difference a difference in ARITHMETIC.
 *
 * ── What the tolerance means ───────────────────────────────────────────────
 *
 * 1e-9 relative. The observed worst case across all eleven values is 4.8e-13,
 * on a Bollinger band edge, where a square root accumulates differently. These
 * are double-precision artefacts, not disagreements: a 1e-13 relative error on
 * a 78,000 price is four ten-millionths of a cent. The tolerance is set three
 * orders of magnitude above the worst observation so that a genuine change in
 * method fails loudly while a compiler or a reassociated sum does not.
 *
 * The one indicator TradingView is asked about that needs care: its MACD plot
 * is normalised to 0-100 by the script that hosts it, so the raw value was
 * read with that normalisation switched off, and switched back immediately.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { rsi, ema, sma, macd, bollinger, adx, vwap } from "../lib/ta/core";

interface Fixture { symbol: string; interval: string; bars: number; rows: number[][] }
const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures", "binance-btcusdt-4h.json"), "utf8")
) as Fixture;

const rows = FIXTURE.rows;
const time = rows.map((r) => r[0]!);
const high = rows.map((r) => r[2]!);
const low = rows.map((r) => r[3]!);
const close = rows.map((r) => r[4]!);
const volume = rows.map((r) => r[5]!);
const hlc3 = rows.map((_, i) => (high[i]! + low[i]! + close[i]!) / 3);

/** The bar every value below is read at: 2026-09-13T00:00:00Z, closed. */
const BAR_MS = Date.UTC(2026, 8, 13, 0, 0, 0);
const AT = time.indexOf(BAR_MS);

/** TradingView's own OHLC for that bar, read out of its chart model. */
const TV_CANDLE = { open: 77278.73, high: 77341.37, low: 77162.36, close: 77192.01 };

/**
 * TradingView's computed values at that bar, with the parameters TradingView
 * was actually using — read from `properties().inputs`, not assumed.
 */
const TV = {
  "RSI(50, close)": 48.82358308299586,
  "EMA(21, close)": 77553.56632697293,
  "EMA(50, close)": 78060.81696010512,
  "EMA(100, close)": 77541.74726694135,
  "EMA(200, close)": 74991.1771549055,
  "MACD(14,21,7, EMA/EMA, close)": -182.73931528981484,
  "MACD signal": -211.42318510557317,
  "MACD histogram": 28.683869815758328,
  "BB basis (SMA 20, close)": 77391.46100000011,
  "BB upper (20, 2)": 78274.92031282127,
  "BB lower (20, 2)": 76508.00168717896,
  "ADX (DI 14, smoothing 14)": 22.083166920871562,
  "VWAP (session, hlc3)": 77231.91333333333,
};

/** Three orders of magnitude above the worst observed difference. */
const TOLERANCE = 1e-9;

function agrees(name: string, mine: number, theirs: number): void {
  assert.ok(Number.isFinite(mine), `${name}: this engine produced ${mine}`);
  const rel = Math.abs(mine - theirs) / Math.max(1, Math.abs(theirs));
  assert.ok(rel <= TOLERANCE,
    `${name}\n    TradingView ${theirs}\n    this engine ${mine}\n    relative difference ${rel.toExponential(3)} exceeds ${TOLERANCE}`);
}

test("PARITY — the bars are the same bars, so the rest is arithmetic", () => {
  /*
   * The load-bearing assertion. If this fails, every comparison below becomes
   * a statement about two different markets and must not be read as a
   * statement about two different implementations.
   */
  assert.ok(AT >= 0, "the bar under test is missing from the fixture");
  assert.ok(AT > 1500, `only ${AT} bars of warm-up before the bar under test`);
  assert.equal(rows[AT]![1], TV_CANDLE.open);
  assert.equal(rows[AT]![2], TV_CANDLE.high);
  assert.equal(rows[AT]![3], TV_CANDLE.low);
  assert.equal(rows[AT]![4], TV_CANDLE.close);
});

test("PARITY — RSI matches TradingView", () => {
  agrees("RSI(50, close)", rsi(close, 50)[AT]!, TV["RSI(50, close)"]);
});

test("PARITY — EMA matches TradingView at four lengths", () => {
  /*
   * Four lengths rather than one, because an EMA is recursive: a seeding
   * mistake shows up as a small error at a short length and a large one at a
   * long length, and a single length can hide it. 200 is the length where a
   * wrong seed would still be visible 1,800 bars later.
   */
  agrees("EMA(21)", ema(close, 21)[AT]!, TV["EMA(21, close)"]);
  agrees("EMA(50)", ema(close, 50)[AT]!, TV["EMA(50, close)"]);
  agrees("EMA(100)", ema(close, 100)[AT]!, TV["EMA(100, close)"]);
  agrees("EMA(200)", ema(close, 200)[AT]!, TV["EMA(200, close)"]);
});

test("PARITY — MACD line, signal and histogram match TradingView", () => {
  const m = macd(close, 14, 21, 7, "ema", "ema");
  agrees("MACD", m.macd[AT]!, TV["MACD(14,21,7, EMA/EMA, close)"]);
  agrees("MACD signal", m.signal[AT]!, TV["MACD signal"]);
  agrees("MACD histogram", m.histogram[AT]!, TV["MACD histogram"]);
});

test("PARITY — Bollinger Bands match TradingView, and the basis IS an SMA", () => {
  const b = bollinger(close, 20, 2, "SMA");
  agrees("BB basis", b.middle[AT]!, TV["BB basis (SMA 20, close)"]);
  agrees("BB upper", b.upper[AT]!, TV["BB upper (20, 2)"]);
  agrees("BB lower", b.lower[AT]!, TV["BB lower (20, 2)"]);
  // The basis is a plain SMA(20), so this is also a direct SMA comparison
  // against TradingView — there is no separate SMA plot on that chart to read.
  agrees("SMA(20) via the BB basis", sma(close, 20)[AT]!, TV["BB basis (SMA 20, close)"]);
});

test("PARITY — ADX matches TradingView, which also pins true range and Wilder", () => {
  /*
   * ADX is the most demanding of these: directional movement, true range, and
   * two nested Wilder smoothings. `atr` has no plot to compare against on that
   * chart, but it is `rma(trueRange(...), len)` — the same two functions this
   * agreement exercises, on the same bars.
   */
  agrees("ADX", adx(high, low, close, 14, 14).adx[AT]!, TV["ADX (DI 14, smoothing 14)"]);
});

test("PARITY — session VWAP matches TradingView, anchor included", () => {
  /*
   * The anchor is the assertion. On a 24/7 crypto symbol TradingView's
   * "Session" is the UTC day, and the bar under test is 00:00 — the first bar
   * of its session — so a correct implementation returns that bar's own hlc3
   * and a mis-anchored one returns something carried over from yesterday.
   */
  const sessionStart = time.map((ms, i) =>
    i === 0 || new Date(ms).getUTCDate() !== new Date(time[i - 1]!).getUTCDate());
  agrees("VWAP", vwap(hlc3, volume, sessionStart)[AT]!, TV["VWAP (session, hlc3)"]);
  assert.ok(sessionStart[AT], "the bar under test must be a session open for this to bite");
  const ownHlc3 = (TV_CANDLE.high + TV_CANDLE.low + TV_CANDLE.close) / 3;
  agrees("VWAP at a session open is that bar's hlc3", ownHlc3, TV["VWAP (session, hlc3)"]);
});
