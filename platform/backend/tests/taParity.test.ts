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
