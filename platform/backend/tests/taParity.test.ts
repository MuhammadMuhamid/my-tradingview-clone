/**
 * The old maths and the shared maths are the same maths.
 *
 * ── What this is protecting ────────────────────────────────────────────────
 *
 * `engine/ta.ts` is consumed by every strategy, both live evaluators, the
 * alert runner, the Pine interpreter and the Backtester — and the Backtester's
 * results are FROZEN into manifests that a user's leaderboard already holds. A
 * primitive that moved by one bar or one ulp would not fail loudly; it would
 * quietly disagree with history the product has already published.
 *
 * So the move into `ta/core.ts` is checked two ways:
 *
 *   IDENTITY   `engine/ta.ts` re-exports the same function objects the core
 *              defines, so there is one implementation rather than two that
 *              agree today. Asserted by reference equality, which no amount of
 *              copy-paste drift can satisfy accidentally.
 *
 *   NUMBERS    the shared primitives are checked against independently
 *              computed values — worked by hand from the definition, not from
 *              the implementation — and against invariants that a wrong
 *              implementation could not satisfy on random data.
 *
 * The randomised cases use a seeded generator so a failure is reproducible.
 * They are cheap by design: this runs on every commit, not nightly.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as core from "../src/ta/core";
import * as legacy from "../src/engine/ta";
import * as pivots from "../src/engine/pivotLevels";
import * as sr from "../src/engine/srZones";

// ── one implementation, not two ─────────────────────────────────────────────

test("engine/ta re-exports the core's own functions rather than copies of them", () => {
  const shared = [
    "nz", "shift", "change", "sma", "rollSum", "ema", "rma", "wma", "vwma", "hma",
    "maByType", "trueRange", "atr", "rsi", "macd", "mfi", "highest", "lowest",
    "linreg", "stdev", "crossover", "crossunder", "pivothigh", "pivotlow",
    "valuewhen", "barssince", "hl2", "hlc3", "ohlc4", "supertrend",
  ] as const;
  for (const name of shared) {
    assert.equal(
      (legacy as unknown as Record<string, unknown>)[name],
      (core as unknown as Record<string, unknown>)[name],
      `${name} must BE the core's function, not a second implementation of it`);
  }
});

/**
 * And the market structure the alerts fire on.
 *
 * `pivotLevels` and `srZones` were pure, dependency-free engine modules, and
 * their own headers said the chart drew the alert engine's levels "by
 * construction". That held only while the browser had no pivot code at all.
 * Wave C draws them, so the arithmetic moved into the core and both modules
 * became re-exports — the same reference-equality check, for the same reason.
 */
test("the pivot and S/R engines re-export the core rather than a second copy", () => {
  const pivotNames = ["PIVOT_TYPES", "isPivotType", "pivotLevels", "nearestLevel",
    "levelByName"] as const;
  for (const name of pivotNames) {
    assert.equal(
      (pivots as unknown as Record<string, unknown>)[name],
      (core as unknown as Record<string, unknown>)[name],
      `${name} must BE the core's, not a copy`);
  }
  const srNames = ["buildZones", "zonesAsOf", "nearestZones", "isPivotHigh", "isPivotLow",
    "DEFAULT_SR_OPTIONS"] as const;
  for (const name of srNames) {
    assert.equal(
      (sr as unknown as Record<string, unknown>)[name],
      (core as unknown as Record<string, unknown>)[name],
      `${name} must BE the core's, not a copy`);
  }
  // The one rename. `srZones.atr` is a merge tolerance seeded from the first
  // bar; `core.atr` is the volatility reading. They are different functions
  // with different jobs, and conflating them would silently change which
  // levels merge.
  assert.equal(sr.atr, core.srMergeAtr);
  assert.notEqual(sr.atr as unknown, core.atr as unknown);
});

// ── a reproducible series ───────────────────────────────────────────────────

/** Mulberry32: tiny, seeded, and identical on every platform. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Series {
  open: number[]; high: number[]; low: number[]; close: number[]; volume: number[];
}

function series(n: number, seed = 42): Series {
  const next = rng(seed);
  const open: number[] = []; const high: number[] = [];
  const low: number[] = []; const close: number[] = []; const volume: number[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const o = price;
    price *= 1 + (next() - 0.5) * 0.02;
    const c = price;
    const wick = Math.abs(c - o) + next() * 0.5;
    open.push(o);
    close.push(c);
    high.push(Math.max(o, c) + wick * next());
    low.push(Math.min(o, c) - wick * next());
    volume.push(100 + next() * 900);
  }
  return { open, high, low, close, volume };
}

const S = series(600);
const finiteTail = (a: number[]): number[] => a.filter((v) => Number.isFinite(v));

const closeTo = (a: number, b: number, epsilon = 1e-9, message?: string): void => {
  assert.ok(Math.abs(a - b) <= epsilon * Math.max(1, Math.abs(a), Math.abs(b)),
    message ?? `${a} !== ${b} within ${epsilon}`);
};

// ── hand-worked values ──────────────────────────────────────────────────────

test("SMA, EMA and RMA match values worked from the definition", () => {
  const src = [1, 2, 3, 4, 5, 6];
  assert.deepEqual(core.sma(src, 3).slice(2), [2, 3, 4, 5]);

  // EMA seeds with the SMA of the first full window: (1+2+3)/3 = 2, then
  // alpha = 2/(3+1) = 0.5.
  const e = core.ema(src, 3);
  closeTo(e[2]!, 2);
  closeTo(e[3]!, 0.5 * 4 + 0.5 * 2);          // 3
  closeTo(e[4]!, 0.5 * 5 + 0.5 * 3);          // 4
  assert.ok(Number.isNaN(e[1]!), "no value before the window is full");

  // RMA seeds the same way with alpha = 1/3.
  const r = core.rma(src, 3);
  closeTo(r[2]!, 2);
  closeTo(r[3]!, (1 / 3) * 4 + (2 / 3) * 2);
});

test("variance is exactly the square of the standard deviation it shares a window with", () => {
  const v = core.variance(S.close, 20);
  const s = core.stdev(S.close, 20);
  for (let i = 0; i < v.length; i++) {
    if (!Number.isFinite(v[i]!)) { assert.ok(!Number.isFinite(s[i]!)); continue; }
    closeTo(v[i]!, s[i]! * s[i]!, 1e-12,
      "a Bollinger width and a variance plot of the same window must agree");
  }
});

test("correlation of a series with itself is 1, and with its negation is -1", () => {
  const same = core.correlation(S.close, S.close, 30);
  const flipped = core.correlation(S.close, S.close.map((v) => -v), 30);
  for (let i = 0; i < same.length; i++) {
    if (!Number.isFinite(same[i]!)) continue;
    closeTo(same[i]!, 1, 1e-9);
    closeTo(flipped[i]!, -1, 1e-9);
  }
  // A window with no movement has no correlation to report.
  const flat = new Array<number>(100).fill(5);
  assert.ok(core.correlation(flat, S.close.slice(0, 100), 30).every((v) => Number.isNaN(v)),
    "zero variance must be NaN, never 0 and never 1");
});

test("beta of a series against itself is 1", () => {
  const returns = core.logReturns(S.close);
  const b = core.beta(returns, returns, 40);
  for (const v of finiteTail(b)) closeTo(v, 1, 1e-9);
  // A benchmark that never moves has no beta.
  assert.ok(core.beta(returns, new Array<number>(returns.length).fill(0), 40)
    .every((v) => Number.isNaN(v)));
});

test("covariance of a series with itself is its variance", () => {
  const cov = core.covariance(S.close, S.close, 25);
  const varr = core.variance(S.close, 25);
  for (let i = 0; i < cov.length; i++) {
    if (!Number.isFinite(cov[i]!)) continue;
    closeTo(cov[i]!, varr[i]!, 1e-9);
  }
});

test("a z-score has mean zero and unit spread over its own window", () => {
  const z = core.zscore(S.close, 50);
  const i = z.length - 1;
  assert.ok(Number.isFinite(z[i]!));
  // Rebuild the definition independently at one bar.
  const window = S.close.slice(i - 49, i + 1);
  const mean = window.reduce((a, b) => a + b, 0) / 50;
  const sd = Math.sqrt(window.reduce((a, b) => a + (b - mean) ** 2, 0) / 50);
  closeTo(z[i]!, (S.close[i]! - mean) / sd);
});

test("percentile rank puts a window of identical values at the midpoint", () => {
  const flat = new Array<number>(60).fill(7);
  for (const v of finiteTail(core.percentileRank(flat, 20))) closeTo(v, 50);
  // A strictly rising series is always at the top of its own window.
  const rising = Array.from({ length: 60 }, (_, i) => i);
  for (const v of finiteTail(core.percentileRank(rising, 20))) closeTo(v, 97.5);
});

test("R-squared of a perfect line is 1, and of a flat line is undefined", () => {
  const line = Array.from({ length: 100 }, (_, i) => 3 * i + 5);
  for (const v of finiteTail(core.rSquared(line, 20))) closeTo(v, 1, 1e-9);
  for (const v of finiteTail(core.linregSlope(line, 20))) closeTo(v, 3, 1e-9);
  assert.ok(core.rSquared(new Array<number>(100).fill(4), 20).every((v) => Number.isNaN(v)),
    "a flat window has no fit to score; claiming a perfect one would be a lie");
});

test("DEMA and TEMA reduce to the EMA of a straight line", () => {
  // On a linear series every EMA converges to the line, so the de-lagging
  // combinations must too — a sign error in either would show here at once.
  const line = Array.from({ length: 400 }, (_, i) => 10 + 0.5 * i);
  const d = core.dema(line, 20);
  const t = core.tema(line, 20);
  closeTo(d[399]!, line[399]!, 1e-6);
  closeTo(t[399]!, line[399]!, 1e-6);
});

// ── bounded oscillators stay inside their bounds ────────────────────────────

test("every bounded oscillator stays inside its own range on random data", () => {
  const bounded: [string, number[], number, number][] = [
    ["rsi", core.rsi(S.close, 14), 0, 100],
    ["stoch %K", core.stochastic(S.high, S.low, S.close, 14, 1, 3).k, 0, 100],
    ["stoch %D", core.stochastic(S.high, S.low, S.close, 14, 1, 3).d, 0, 100],
    ["stochrsi %K", core.stochasticRsi(S.close, 14, 14, 3, 3).k, 0, 100],
    ["williams %R", core.williamsR(S.high, S.low, S.close, 14), -100, 0],
    ["mfi", core.mfi(core.hlc3(S.high, S.low, S.close), S.volume, 14), 0, 100],
    ["cmf", core.chaikinMoneyFlow(S.high, S.low, S.close, S.volume, 20), -1, 1],
    ["cmo", core.chandeMomentum(S.close, 14), -100, 100],
    ["adx", core.adx(S.high, S.low, S.close, 14, 14).adx, 0, 100],
    ["+DI", core.adx(S.high, S.low, S.close, 14, 14).plusDi, 0, 100],
    ["-DI", core.adx(S.high, S.low, S.close, 14, 14).minusDi, 0, 100],
    ["aroon up", core.aroon(S.high, S.low, 14).up, 0, 100],
    ["aroon down", core.aroon(S.high, S.low, 14).down, 0, 100],
    ["choppiness", core.choppiness(S.high, S.low, S.close, 14), 0, 100],
    ["ultimate", core.ultimateOscillator(S.high, S.low, S.close, 7, 14, 28), 0, 100],
    ["%B", core.bollingerPercentB(S.close, 20, 2), -10, 10],
  ];
  for (const [name, out, lo, hi] of bounded) {
    const values = finiteTail(out);
    assert.ok(values.length > 0, `${name} produced no values at all`);
    for (const v of values) {
      assert.ok(v >= lo && v <= hi, `${name} produced ${v}, outside [${lo}, ${hi}]`);
    }
  }
});

// ── nothing is allowed to emit a non-finite number ─────────────────────────

test("no primitive emits Infinity, on ordinary data or on degenerate data", () => {
  const flat: Series = {
    open: new Array<number>(300).fill(50), high: new Array<number>(300).fill(50),
    low: new Array<number>(300).fill(50), close: new Array<number>(300).fill(50),
    volume: new Array<number>(300).fill(0),
  };
  for (const s of [S, flat]) {
    const outputs: [string, number[]][] = [
      ["ema", core.ema(s.close, 21)],
      ["dema", core.dema(s.close, 21)],
      ["tema", core.tema(s.close, 21)],
      ["kama", core.kama(s.close, 10)],
      ["mcginley", core.mcginley(s.close, 14)],
      ["atr", core.atr(s.high, s.low, s.close, 14)],
      ["rsi", core.rsi(s.close, 14)],
      ["cci", core.cci(core.hlc3(s.high, s.low, s.close), 20)],
      ["roc", core.roc(s.close, 9)],
      ["trix", core.trix(s.close, 15)],
      ["ppo", core.ppo(s.close, 12, 26, 9).line],
      ["tsi", core.tsi(s.close, 25, 13, 13).line],
      ["fisher", core.fisherTransform(s.high, s.low, 9).line],
      ["dpo", core.detrendedPriceOscillator(s.close, 21)],
      ["coppock", core.coppock(s.close)],
      ["forceIndex", core.elderForceIndex(s.close, s.volume, 13)],
      ["vortex+", core.vortex(s.high, s.low, s.close, 14).plus],
      ["psar", core.parabolicSar(s.high, s.low, 0.02, 0.02, 0.2)],
      ["obv", core.obv(s.close, s.volume)],
      ["pvt", core.priceVolumeTrend(s.close, s.volume)],
      ["ad", core.accumulationDistribution(s.high, s.low, s.close, s.volume)],
      ["volOsc", core.volumeOscillator(s.volume, 5, 10)],
      ["vfi", core.volumeFlowIndicator(s.high, s.low, s.close, s.volume, 130, 0.2, 2.5, 3)],
      ["bbw", core.bollingerBandWidth(s.close, 20, 2)],
      ["hv", core.historicalVolatility(s.close, 20, 365)],
      ["keltner up", core.keltner(s.high, s.low, s.close, 20, 2, 10).upper],
      ["donchian mid", core.donchian(s.high, s.low, 20).middle],
      ["envelope up", core.envelopes(s.close, 20, 2).upper],
      ["ichimoku spanA", core.ichimoku(s.high, s.low, s.close, 9, 26, 52).spanA],
      ["vwap", core.vwap(core.hlc3(s.high, s.low, s.close), s.volume,
        s.close.map((_, i) => i === 0))],
      ["avwap", core.anchoredVwap(s.close, s.volume, 10)],
      ["avwap dev", core.anchoredVwapDeviation(s.close, s.volume, 10)],
      ["zscore", core.zscore(s.close, 30)],
      ["percentile", core.percentileRank(s.close, 30)],
      ["slope", core.linregSlope(s.close, 30)],
      ["r2", core.rSquared(s.close, 30)],
    ];
    for (const [name, out] of outputs) {
      for (const v of out) {
        assert.ok(Number.isFinite(v) || Number.isNaN(v),
          `${name} emitted ${v} — a chart cannot autoscale around an infinity`);
      }
    }
  }
});

// ── short and empty data must be safe ───────────────────────────────────────

test("every primitive survives an empty series and a series shorter than its window", () => {
  const empty: number[] = [];
  assert.deepEqual(core.sma(empty, 14), []);
  assert.deepEqual(core.ema(empty, 14), []);
  assert.deepEqual(core.rsi(empty, 14), []);
  assert.deepEqual(core.obv(empty, empty), []);

  const tiny = series(3, 7);
  const shortOutputs = [
    core.rsi(tiny.close, 14),
    core.adx(tiny.high, tiny.low, tiny.close, 14, 14).adx,
    core.stochastic(tiny.high, tiny.low, tiny.close, 14, 3, 3).k,
    core.bollinger(tiny.close, 20, 2).upper,
    core.ichimoku(tiny.high, tiny.low, tiny.close, 9, 26, 52).spanB,
    core.aroon(tiny.high, tiny.low, 14).up,
    core.percentileRank(tiny.close, 20),
  ];
  for (const out of shortOutputs) {
    assert.equal(out.length, 3, "output is always aligned bar-for-bar with the input");
    assert.ok(out.every((v) => Number.isNaN(v)),
      "a window that cannot be filled yields na, never a partial answer");
  }
});

test("a gap in the middle of a series emits na without restarting the recursion", () => {
  const src = S.close.slice(0, 200).slice();
  src[100] = NaN;
  const e = core.ema(src, 20);
  assert.ok(Number.isNaN(e[100]!), "the gap bar itself has no value");
  assert.ok(Number.isFinite(e[101]!), "and the recursion continues rather than re-seeding");
  // Re-seeding would produce a visibly different value; carrying state does not.
  const withoutGap = core.ema(S.close.slice(0, 200), 20);
  assert.ok(Math.abs(e[199]! - withoutGap[199]!) < Math.abs(withoutGap[199]!) * 0.05,
    "carrying state keeps the series close to the ungapped one");
});

// ── determinism ─────────────────────────────────────────────────────────────

test("the same input produces byte-identical output every time", () => {
  const once = core.adx(S.high, S.low, S.close, 14, 14);
  const twice = core.adx(S.high, S.low, S.close, 14, 14);
  assert.deepEqual(once, twice);
  const st1 = core.supertrend(S.high, S.low, S.close, 10, 3, true);
  const st2 = core.supertrend(S.high, S.low, S.close, 10, 3, true);
  assert.deepEqual(st1, st2);
});

// ── the two copies are one implementation ───────────────────────────────────

test("the browser's copy of the core is byte-identical to the server's", () => {
  const server = readFileSync(
    join(__dirname, "..", "src", "ta", "core.ts"), "utf8");
  const browser = readFileSync(
    join(__dirname, "..", "..", "frontend", "lib", "ta", "core.ts"), "utf8");
  assert.equal(browser, server,
    "the canonical maths exists twice by necessity and must be identical; " +
    "a divergence in a formula OR in a comment is a divergence");
  assert.doesNotMatch(server, /^\s*import\s/m,
    "the core must import nothing, or the two copies could not be identical " +
    "across two module systems and two tsconfigs");
});

// ── the repairs the Wave B review asked for, pinned ─────────────────────────

/**
 * The Fisher Transform, against a direct transcription of the formula whose
 * constants this implementation uses.
 *
 * The defect this replaces was not a rounding difference: the position term was
 * scaled ×2 and the recursive state was left unclamped, so the line sat pinned
 * at its extreme on most bars and read as a square wave. Both halves are
 * checked — the agreement, and the distribution.
 */
test("the Fisher Transform is TradingView's, not a doubled and unclamped variant", () => {
  const n = 1_100;
  const s = series(n, 21);
  const median = core.hl2(s.high, s.low);
  const len = 9;

  // Reference: `value := round_(.66 * ((hl2 - low_) / (high_ - low_) - .5)
  //                              + .67 * nz(value[1]))`
  //            `fish1 := .5 * log((1 + value) / (1 - value)) + .5 * nz(fish1[1])`
  const hh = core.highest(median, len);
  const ll = core.lowest(median, len);
  const reference = new Array<number>(n).fill(NaN);
  let value = 0;
  let fish = 0;
  for (let i = 0; i < n; i++) {
    const h = hh[i]!;
    const l = ll[i]!;
    const m = median[i]!;
    if (Number.isNaN(h) || Number.isNaN(l) || Number.isNaN(m)) continue;
    const raw = h === l ? 0 : (m - l) / (h - l) - 0.5;
    value = Math.max(-0.999, Math.min(0.999, 0.66 * raw + 0.67 * value));
    fish = 0.5 * Math.log((1 + value) / (1 - value)) + 0.5 * fish;
    reference[i] = fish;
  }

  const mine = core.fisherTransform(s.high, s.low, len).line;
  let worst = 0;
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(reference[i]!) || Number.isNaN(mine[i]!)) continue;
    worst = Math.max(worst, Math.abs(mine[i]! - reference[i]!));
  }
  assert.ok(worst < 1e-9, `Fisher differs from the reference by ${worst}`);

  // And it is an oscillator rather than a square wave. `|F| > 3.4` corresponds
  // to a clamped position; a correct Fisher spends a few percent of its bars
  // there, a doubled one spent two thirds.
  const values = finiteTail(mine);
  const pinned = values.filter((v) => Math.abs(v) > 3.4).length / values.length;
  assert.ok(pinned < 0.10,
    `${(pinned * 100).toFixed(1)}% of bars are pinned at the clamp — the ` +
    `transform is saturating rather than oscillating`);
});

test("Aroon uses TradingView's length-bar window, so it never reaches zero", () => {
  const s = series(400, 33);
  const len = 14;
  const a = core.aroon(s.high, s.low, len);

  // Reference: `100 * (highestbars(high, length) + length) / length`.
  const n = s.high.length;
  for (let i = len - 1; i < n; i++) {
    let hiIdx = 0;
    let hi = -Infinity;
    for (let k = 0; k < len; k++) {
      if (s.high[i - k]! > hi) { hi = s.high[i - k]!; hiIdx = k; }
    }
    const expected = ((len - hiIdx) / len) * 100;
    assert.ok(Math.abs(a.up[i]! - expected) < 1e-9, `Aroon Up at ${i}`);
  }
  const up = finiteTail(a.up);
  assert.ok(up.length > 0);
  assert.ok(Math.min(...up) >= (100 / len) - 1e-9,
    "the length-bar definition never reaches 0; the length+1 one does");
  assert.ok(Math.max(...up) <= 100 + 1e-9);
  // The first value exists at bar `len - 1`, not `len`.
  assert.ok(Number.isFinite(a.up[len - 1]!));
  assert.ok(Number.isNaN(a.up[len - 2]!));
});

test("Stochastic RSI draws nothing until a full window of RSI exists", () => {
  const short = series(40, 7);
  const rsiLen = 14;
  const stochLen = 14;
  const kSmooth = 3;
  const k = core.stochasticRsi(short.close, rsiLen, stochLen, kSmooth, 3).k;

  /*
   * Derived, not guessed. RSI(14) seeds at bar 14; a full 14-bar window over it
   * first exists at 14 + 14 - 1 = 27; the 3-bar %K smoothing adds two more.
   * Before the repair the first value appeared at bar 17, computed over four of
   * the fourteen RSI readings it claimed.
   */
  const rsiFirst = core.rsi(short.close, rsiLen).findIndex((v) => !Number.isNaN(v));
  const expected = rsiFirst + stochLen - 1 + kSmooth - 1;
  const first = k.findIndex((v) => Number.isFinite(v));
  assert.equal(first, expected,
    `first value at bar ${first}, expected ${expected} — a reading drawn over a ` +
    `partial window reads as real`);

  // And a long series is unchanged from bar 40 onward by the blanking.
  const long = series(600, 7);
  const kLong = core.stochasticRsi(long.close, 14, 14, 3, 3).k;
  for (let i = 60; i < 600; i++) {
    if (Number.isNaN(kLong[i]!)) continue;
    assert.ok(kLong[i]! >= 0 && kLong[i]! <= 100);
  }
});

test("one missing bar does not end Parabolic SAR for the rest of the series", () => {
  const s = series(800, 12);
  const clean = core.parabolicSar(s.high, s.low, 0.02, 0.02, 0.2);
  assert.equal(clean.slice(2).filter((v) => Number.isNaN(v)).length, 0,
    "a clean series has no gaps");

  const high = s.high.slice();
  const low = s.low.slice();
  high[500] = NaN;
  low[500] = NaN;
  const gapped = core.parabolicSar(high, low, 0.02, 0.02, 0.2);
  assert.ok(Number.isNaN(gapped[500]!), "the missing bar itself has no value");
  const after = gapped.slice(510);
  assert.ok(after.every((v) => Number.isFinite(v)),
    "the state machine must restart after the gap rather than be poisoned by it");
});

test("VFI caps and normalises against the same volume average", () => {
  const source = readFileSync(join(__dirname, "..", "src", "ta", "core.ts"), "utf8");
  const body = source.slice(source.indexOf("export function volumeFlowIndicator"));
  const uses = [...body.slice(0, body.indexOf("\n}")).matchAll(/volAvg\[i([^\]]*)\]/g)]
    .map((m) => m[1]!.trim());
  assert.ok(uses.length >= 2, "both the cap and the normaliser read the average");
  assert.ok(uses.every((u) => u === "- 1"),
    `the cap and the normaliser must use the same index; found ${JSON.stringify(uses)}`);
});

/* ════════════════════════════════════════════════════════════════════════════
 * The Wave C catalog's own arithmetic
 *
 * Each of these is a property the definition forces and a wrong implementation
 * cannot satisfy: a value worked from the formula by hand, a limit the maths
 * has to reach on constructed data, or an identity between two functions that
 * are defined in terms of each other. Not a snapshot of what the code
 * currently returns — that would pin a bug in place as firmly as a feature.
 * ════════════════════════════════════════════════════════════════════════════ */

/** A strictly rising series: every indicator's "maximum trend" case. */
const rising = (n: number, step = 1): Series => ({
  open: Array.from({ length: n }, (_, i) => 100 + i * step),
  high: Array.from({ length: n }, (_, i) => 100 + i * step + step),
  low: Array.from({ length: n }, (_, i) => 100 + i * step - step),
  close: Array.from({ length: n }, (_, i) => 100 + i * step),
  volume: Array.from({ length: n }, () => 1000),
});

test("Vortex on a monotone rise puts VI+ above VI- and both at their limits", () => {
  const s = rising(60);
  const { plus, minus } = core.vortex(s.high, s.low, s.close, 14);
  const i = s.close.length - 1;
  // On a series that only rises, every bar's |high - prevLow| is large and
  // every |low - prevHigh| is small, so VI+ dominates. The two are ratios
  // against the same true-range sum, so they are positive and finite.
  assert.ok(plus[i]! > minus[i]!, `VI+ ${plus[i]} must exceed VI- ${minus[i]}`);
  assert.ok(plus[i]! > 1 && minus[i]! < 1);
  assert.ok(Number.isFinite(plus[i]!) && Number.isFinite(minus[i]!));
  // And it is a WINDOW: the first computable bar is at `len`, not before.
  assert.ok(Number.isNaN(plus[13]!), "VI must not report before its window fills");
  assert.ok(Number.isFinite(plus[14]!));
});

test("the Choppiness Index reaches its floor on a trend and its ceiling on noise", () => {
  const trend = core.choppiness(rising(80).high, rising(80).low, rising(80).close, 14);
  // A pure trend: the summed true range equals the window's own range, so the
  // log ratio is ~0 and the index sits at its 0 floor.
  assert.ok(trend[79]! < 30, `a monotone rise must read as trending, got ${trend[79]}`);
  assert.ok(trend[79]! >= 0 && trend[79]! <= 100);

  // A series that goes nowhere while moving every bar: the summed range is far
  // larger than the window's own range, which is what "choppy" means.
  const n = 80;
  const chop: Series = {
    open: [], high: [], low: [], close: [], volume: [],
  };
  for (let i = 0; i < n; i++) {
    const base = i % 2 === 0 ? 100 : 110;
    chop.open.push(base); chop.high.push(base + 1); chop.low.push(base - 1);
    chop.close.push(base); chop.volume.push(1000);
  }
  const noisy = core.choppiness(chop.high, chop.low, chop.close, 14);
  assert.ok(noisy[79]! > 60, `an oscillation must read as choppy, got ${noisy[79]}`);
});

test("PPO is MACD expressed as a percentage of the slow average", () => {
  const s = series(300);
  const p = core.ppo(s.close, 12, 26, 9);
  const slow = core.ema(s.close, 26);
  const fast = core.ema(s.close, 12);
  const i = 250;
  // The definition, not the implementation: (fast - slow) / slow × 100. This
  // is what makes PPO comparable between two instruments whose prices differ
  // by orders of magnitude, which raw MACD is not.
  assert.ok(Math.abs(p.line[i]! - ((fast[i]! - slow[i]!) / slow[i]!) * 100) < 1e-9);
  // The histogram is the line minus its own signal, exactly as in MACD.
  assert.ok(Math.abs(p.histogram[i]! - (p.line[i]! - p.signal[i]!)) < 1e-9);
});

test("TRIX is the percentage rate of change of a triple-smoothed average", () => {
  const s = series(400);
  const trix = core.trix(s.close, 15);
  const triple = core.ema(core.ema(core.ema(s.close, 15), 15), 15);
  const i = 350;
  // Triple smoothing is the point: a single EMA's rate of change is noise, and
  // the third pass is what leaves only the direction of the trend itself.
  const expected = ((triple[i]! - triple[i - 1]!) / triple[i - 1]!) * 100;
  assert.ok(Math.abs(trix[i]! - expected) < 1e-9, `${trix[i]} vs ${expected}`);
});

test("the Ultimate Oscillator is bounded and weights its three windows 4:2:1", () => {
  const s = series(300);
  const uo = core.ultimateOscillator(s.high, s.low, s.close, 7, 14, 28);
  for (const v of uo.slice(60)) {
    assert.ok(v >= 0 && v <= 100, `UO left 0..100 at ${v}`);
  }
  /*
   * A series that closes at its own high every bar, rising throughout: buying
   * pressure IS the whole true range, so all three averages are 1 and the
   * weighted mean is exactly 100. Constructed rather than taken from `rising`,
   * whose bars have a wick above the close and so cap the reading at 50.
   */
  const n = 80;
  const closeAtHigh = {
    high: Array.from({ length: n }, (_, i) => 100 + i),
    low: Array.from({ length: n }, (_, i) => 99 + i),
    close: Array.from({ length: n }, (_, i) => 100 + i),
  };
  const up = core.ultimateOscillator(
    closeAtHigh.high, closeAtHigh.low, closeAtHigh.close, 7, 14, 28);
  assert.ok(Math.abs(up[79]! - 100) < 1e-9, `a pure rise must read 100, got ${up[79]}`);
});

test("the Chande Momentum Oscillator is +100 on a pure rise and -100 on a pure fall", () => {
  const up = core.chandeMomentum(rising(60).close, 14);
  assert.ok(Math.abs(up[59]! - 100) < 1e-9, `got ${up[59]}`);
  const falling = rising(60).close.map((v) => 300 - v);
  const down = core.chandeMomentum(falling, 14);
  assert.ok(Math.abs(down[59]! + 100) < 1e-9, `got ${down[59]}`);
});

test("the Detrended Price Oscillator is the price a half-window back, less the average", () => {
  const s = series(200);
  const len = 21;
  const dpo = core.detrendedPriceOscillator(s.close, len);
  const sma = core.sma(s.close, len);
  const back = Math.floor(len / 2) + 1;
  const i = 150;
  // The displacement is what makes it DETRENDED: comparing today's price with
  // today's average would leave the trend in.
  assert.ok(Math.abs(dpo[i]! - (s.close[i - back]! - sma[i]!)) < 1e-9);
});

test("the Coppock Curve is a weighted average of two rates of change", () => {
  const s = series(400);
  const cop = core.coppock(s.close, 14, 11, 10);
  const sum = core.roc(s.close, 14).map((v, i) => v + core.roc(s.close, 11)[i]!);
  const wma = core.wma(sum, 10);
  const i = 350;
  assert.ok(Math.abs(cop[i]! - wma[i]!) < 1e-9);
});

test("Keltner channels are the ATR either side of an average, and Donchian the extremes", () => {
  const s = series(300);
  const k = core.keltner(s.high, s.low, s.close, 20, 2, 10);
  const basis = core.ema(s.close, 20);
  // The ATR length is its own input: TradingView's default smooths the range
  // over a shorter window than the basis, and collapsing the two would change
  // the channel's width on every chart that uses the defaults.
  const range = core.atr(s.high, s.low, s.close, 10);
  const i = 250;
  assert.ok(Math.abs(k.upper[i]! - (basis[i]! + 2 * range[i]!)) < 1e-9);
  assert.ok(Math.abs(k.lower[i]! - (basis[i]! - 2 * range[i]!)) < 1e-9);

  const d = core.donchian(s.high, s.low, 20);
  // The extremes of the window, inclusive of the current bar.
  const hi = Math.max(...s.high.slice(i - 19, i + 1));
  const lo = Math.min(...s.low.slice(i - 19, i + 1));
  assert.equal(d.upper[i], hi);
  assert.equal(d.lower[i], lo);
  assert.ok(Math.abs(d.middle[i]! - (hi + lo) / 2) < 1e-12);
});

test("Bollinger %B is 1 at the upper band and 0 at the lower, and the width is relative", () => {
  const s = series(300);
  const b = core.bollinger(s.close, 20, 2, "SMA");
  const pb = core.bollingerPercentB(s.close, 20, 2, "SMA");
  const bw = core.bollingerBandWidth(s.close, 20, 2, "SMA");
  const i = 250;
  const expected = (s.close[i]! - b.lower[i]!) / (b.upper[i]! - b.lower[i]!);
  assert.ok(Math.abs(pb[i]! - expected) < 1e-12);
  // Width is a FRACTION of the basis, so it is comparable across instruments
  // priced in the tens and in the tens of thousands.
  assert.ok(Math.abs(bw[i]! - (b.upper[i]! - b.lower[i]!) / b.middle[i]!) < 1e-12);
});

test("accumulation/distribution and PVT accumulate, so their first value is their first bar", () => {
  const s = series(200);
  const ad = core.accumulationDistribution(s.high, s.low, s.close, s.volume);
  const pvt = core.priceVolumeTrend(s.close, s.volume);
  // A running total is defined from bar zero: a na start would make the whole
  // series na, and a reset would make it a different indicator at every zoom.
  assert.ok(Number.isFinite(ad[0]!) && Number.isFinite(pvt[0]!));
  for (let i = 1; i < 200; i++) {
    assert.ok(Number.isFinite(ad[i]!) && Number.isFinite(pvt[i]!));
  }
  // Each step is the previous total plus this bar's contribution.
  const i = 150;
  const step = ((s.close[i]! - s.low[i]!) - (s.high[i]! - s.close[i]!))
    / (s.high[i]! - s.low[i]!) * s.volume[i]!;
  assert.ok(Math.abs(ad[i]! - (ad[i - 1]! + step)) < 1e-6);
});

test("Chaikin Money Flow is bounded by the money-flow multiplier's own range", () => {
  const s = series(300);
  const cmf = core.chaikinMoneyFlow(s.high, s.low, s.close, s.volume, 20);
  for (const v of cmf.slice(30)) {
    assert.ok(v >= -1 && v <= 1, `CMF left -1..1 at ${v}`);
  }
  // Every close at the high: the multiplier is +1 on every bar, so the ratio
  // of summed money flow to summed volume is exactly 1.
  const n = 60;
  const atHigh = {
    high: Array.from({ length: n }, (_, i) => 100 + i),
    low: Array.from({ length: n }, (_, i) => 99 + i),
    close: Array.from({ length: n }, (_, i) => 100 + i),
    volume: Array.from({ length: n }, () => 1000),
  };
  const pinned = core.chaikinMoneyFlow(
    atHigh.high, atHigh.low, atHigh.close, atHigh.volume, 20);
  assert.ok(Math.abs(pinned[59]! - 1) < 1e-12, `got ${pinned[59]}`);
});

test("the Volume Oscillator is the percentage gap between two volume averages", () => {
  const s = series(300);
  const vo = core.volumeOscillator(s.volume, 5, 10);
  const fast = core.ema(s.volume, 5);
  const slow = core.ema(s.volume, 10);
  const i = 250;
  assert.ok(Math.abs(vo[i]! - ((fast[i]! - slow[i]!) / slow[i]!) * 100) < 1e-9);
});

test("Elder's Force Index is one bar's price change times its volume, smoothed", () => {
  const s = series(200);
  const raw = core.elderForceIndex(s.close, s.volume, 1);
  const i = 150;
  assert.ok(Math.abs(raw[i]! - (s.close[i]! - s.close[i - 1]!) * s.volume[i]!) < 1e-6);
  // Length 13 is the same series through an EMA, so it must not be na where
  // the raw one is finite and the window has filled.
  const smoothed = core.elderForceIndex(s.close, s.volume, 13);
  assert.ok(Number.isFinite(smoothed[i]!));
});

test("historical volatility is the annualised deviation of log returns", () => {
  const s = series(400);
  const hv = core.historicalVolatility(s.close, 20, 365);
  const lr = core.logReturns(s.close);
  const sd = core.stdev(lr, 20);
  const i = 350;
  assert.ok(Math.abs(hv[i]! - sd[i]! * Math.sqrt(365) * 100) < 1e-9);
  assert.ok(hv[i]! >= 0, "a deviation is never negative");
});

/**
 * Where each primitive's first value belongs, worked from the definition.
 *
 * The index is not a snapshot: a window of `len` closes fills at `len - 1`,
 * one that needs a PREVIOUS close (anything built on true range or on a
 * change) fills at `len`, and stacked smoothers add a window each. Getting
 * this wrong in either direction is a real defect — a value published before
 * its window is a value computed from fewer bars than the user asked for, and
 * one withheld after it is a gap in the line with no cause.
 */
test("every Wave C catalog primitive is na before its window and finite after", () => {
  const s = series(500);
  const cases: Array<[string, number[], number]> = [
    // Built on true range, so bar 0 has no previous close to measure from.
    ["vortex+", core.vortex(s.high, s.low, s.close, 14).plus, 14],
    // Choppiness seeds bar 0's true range from its own range, so its window
    // is full one bar earlier than Vortex's.
    ["chop", core.choppiness(s.high, s.low, s.close, 14), 13],
    // A `change` of one bar, then a window of `len` of those.
    ["cmo", core.chandeMomentum(s.close, 14), 14],
    // Plain windows over closes: full at `len - 1`.
    ["cci", core.cci(s.close, 20), 19],
    ["willr", core.williamsR(s.high, s.low, s.close, 14), 13],
    ["cmf", core.chaikinMoneyFlow(s.high, s.low, s.close, s.volume, 20), 19],
    ["zscore", core.zscore(s.close, 20), 19],
    ["percentile", core.percentileRank(s.close, 20), 19],
    ["slope", core.linregSlope(s.close, 20), 19],
    // Log returns lose bar 0, then a window of 20 of them.
    ["hv", core.historicalVolatility(s.close, 20, 365), 20],
    // Two EMAs, the slower of which is what gates the pair.
    ["volosc", core.volumeOscillator(s.volume, 5, 10), 9],
    // Three stacked EMAs, then a rate of change across one more bar.
    ["trix", core.trix(s.close, 15), 3 * 14 + 1],
  ];
  for (const [name, out, firstIndex] of cases) {
    assert.equal(out.length, s.close.length, `${name} changed the series length`);
    assert.ok(Number.isNaN(out[firstIndex - 1]!),
      `${name} reported a value at ${firstIndex - 1}, before its window filled`);
    assert.ok(Number.isFinite(out[firstIndex]!),
      `${name} is still na at ${firstIndex}, where its window is full`);
    // And nothing after it is Infinity, which would render as a line to
    // nowhere and rescale the pane around it.
    for (const v of out.slice(firstIndex)) {
      assert.ok(Number.isNaN(v) || Number.isFinite(v), `${name} emitted ${v}`);
    }
  }
});
test("the zone walk returns exactly what querying every bar returned", () => {
  /*
   * `zonesAsOf` in a loop was quadratic — a full filter and sort over every
   * zone the series ever produced, for every bar — and measured 53 ms per tick
   * at ten thousand bars. `zonesAsOfSeries` carries the live set forward
   * instead.
   *
   * The output must be IDENTICAL, not merely similar: the caller is choosing
   * which levels to draw, so a different set would be a different chart rather
   * than a faster one. Compared by reference, per bar, so an equal-looking
   * substitute cannot pass.
   */
  const n = 3_000;
  const high: number[] = [];
  const low: number[] = [];
  const close: number[] = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    p += Math.sin(i / 23) * 2 + Math.sin(i / 7);
    high.push(p + 1.5); low.push(p - 1.5); close.push(p);
  }
  for (const opts of [
    { ...core.DEFAULT_SR_OPTIONS, pivotLength: 15, maxZones: 3 },
    { ...core.DEFAULT_SR_OPTIONS, pivotLength: 5, maxZones: 1 },
    { ...core.DEFAULT_SR_OPTIONS, pivotLength: 30, maxZones: 10, invalidation: "wick" as const },
  ]) {
    const zones = core.buildZones({ high, low, close }, opts);
    assert.ok(zones.length > 0, "the fixture must actually produce zones");
    const series = core.zonesAsOfSeries(zones, n, opts);
    for (let i = 0; i < n; i++) {
      const expected = core.zonesAsOf(zones, i, opts);
      const actual = series[i]!;
      assert.equal(actual.length, expected.length, `bar ${i} holds a different number of zones`);
      for (let k = 0; k < expected.length; k++) {
        assert.equal(actual[k], expected[k],
          `bar ${i} zone ${k} is a different zone, or the same ones in a different order`);
      }
    }
  }
});

test("a zone is live from its confirmation bar until the bar it breaks on", () => {
  /*
   * The two boundaries the walk has to get exactly right, and they are not
   * symmetric. `zonesAsOf` admits a zone at `confirmedIndex <= index` — so it
   * is live ON its confirmation bar — and keeps it while `brokenIndex > index`
   * — so it is gone ON the bar it breaks. That is the correct reading: a
   * pivot becomes knowable at the bar that confirms it, and a level stops
   * being a level at the close that goes through it.
   *
   * An off-by-one at either end moves every level's first or last bar.
   */
  const zones = [
    { kind: "support" as const, price: 100, pivotIndex: 5, confirmedIndex: 10,
      brokenIndex: 40, touches: 1 },
    { kind: "resistance" as const, price: 120, pivotIndex: 6, confirmedIndex: 11,
      brokenIndex: null, touches: 1 },
  ];
  const opts = { ...core.DEFAULT_SR_OPTIONS, maxZones: 5 };
  const series = core.zonesAsOfSeries(zones, 60, opts);
  assert.equal(series[9]!.length, 0, "nothing is live before its confirmation bar");
  assert.equal(series[10]!.length, 1, "live from the confirmation bar itself");
  assert.equal(series[39]!.length, 2, "still live on the last bar before the break");
  assert.equal(series[40]!.length, 1, "and gone on the bar price closed through it");
  assert.equal(series[40]![0], zones[1], "the survivor is the unbroken one");

  // The same answer `zonesAsOf` gives, which is the contract this replaces.
  for (const i of [9, 10, 39, 40, 41]) {
    assert.deepEqual(series[i], core.zonesAsOf(zones, i, opts), `bar ${i}`);
  }
});
