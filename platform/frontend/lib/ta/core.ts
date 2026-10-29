/* ────────────────────────────────────────────────────────────────────────────
 * CANONICAL TECHNICAL-ANALYSIS AND QUANT PRIMITIVES
 *
 * This file is the single mathematical authority for the whole product, and it
 * exists TWICE, byte for byte:
 *
 *   backend/src/ta/core.ts     server: strategies, alerts, Pine, Backtester
 *   frontend/lib/ta/core.ts    browser: native studies, legends, compare
 *
 * The duplication is deliberate and it is CHECKED. There is no shared package
 * in this repository, the two sides compile under different module systems and
 * different tsconfigs, and adding a workspace package to solve it would change
 * the build and the lockfile for every consumer. Instead this file is
 * dependency-free — no imports at all, of anything — so the two copies can be
 * compared as bytes. `backend/tests/taCore.test.ts` and
 * `frontend/tests/taCore.test.ts` both fail if a single character differs.
 *
 * That is a stronger guarantee than a shared module would give, because it
 * catches a divergence in a comment as readily as one in a formula.
 *
 * ── Conventions, mirrored from Pine Script ────────────────────────────────
 *
 *   - `na` is NaN. Comparisons with NaN are false in JS exactly as
 *     na-comparisons are falsy in Pine conditions.
 *   - Window functions (sma, wma, highest, lowest, stdev, linreg …) return NaN
 *     until a full window of non-NaN values exists.
 *   - Recursive functions (ema, rma) seed with the SMA of the first full window
 *     and recurse from there, Wilder-style.
 *   - A NaN INPUT to a recursive function emits NaN but preserves state, so a
 *     gap does not restart the recursion.
 *   - pivothigh/pivotlow confirm `right` bars after the pivot bar and place the
 *     pivot PRICE at the confirmation bar.
 *   - Nothing here ever returns Infinity. A division that cannot be taken
 *     returns NaN, which the chart draws as a break in the line; an Infinity
 *     would autoscale a pane into uselessness.
 *
 * ── What must not change ──────────────────────────────────────────────────
 *
 * Everything above `NEW PRIMITIVES` was moved here VERBATIM from
 * `backend/src/engine/ta.ts`. Strategies, alert evaluators, the Pine
 * interpreter and the Backtester consume these exact semantics and own
 * leaderboard history computed with them; `engine/ta.ts` now re-exports from
 * here so those consumers are reading the same code they always were.
 * ──────────────────────────────────────────────────────────────────────────── */

export const nz = (v: number, repl = 0): number => (Number.isNaN(v) ? repl : v);

export function shift(src: number[], n: number): number[] {
  const out = new Array<number>(src.length).fill(NaN);
  for (let i = n; i < src.length; i++) out[i] = src[i - n]!;
  return out;
}

export function change(src: number[]): number[] {
  const out = new Array<number>(src.length).fill(NaN);
  for (let i = 1; i < src.length; i++) out[i] = src[i]! - src[i - 1]!;
  return out;
}

export function sma(src: number[], len: number): number[] {
  const n = src.length;
  const out = new Array<number>(n).fill(NaN);
  if (len <= 0) return out;
  let sum = 0;
  let naCount = 0;
  for (let i = 0; i < n; i++) {
    const v = src[i]!;
    if (Number.isNaN(v)) naCount++; else sum += v;
    if (i >= len) {
      const old = src[i - len]!;
      if (Number.isNaN(old)) naCount--; else sum -= old;
    }
    if (i >= len - 1 && naCount === 0) out[i] = sum / len;
  }
  return out;
}

/** Rolling sum with Pine's math.sum semantics (NaN in window → NaN). */
export function rollSum(src: number[], len: number): number[] {
  const n = src.length;
  const out = new Array<number>(n).fill(NaN);
  let sum = 0;
  let naCount = 0;
  for (let i = 0; i < n; i++) {
    const v = src[i]!;
    if (Number.isNaN(v)) naCount++; else sum += v;
    if (i >= len) {
      const old = src[i - len]!;
      if (Number.isNaN(old)) naCount--; else sum -= old;
    }
    if (i >= len - 1 && naCount === 0) out[i] = sum;
  }
  return out;
}

function recursiveMa(src: number[], len: number, alpha: number): number[] {
  const n = src.length;
  const out = new Array<number>(n).fill(NaN);
  // Seed at the first index with `len` consecutive non-NaN values ending there.
  let run = 0;
  let seedIdx = -1;
  for (let i = 0; i < n; i++) {
    run = Number.isNaN(src[i]!) ? 0 : run + 1;
    if (run >= len) { seedIdx = i; break; }
  }
  if (seedIdx < 0) return out;
  let seed = 0;
  for (let k = seedIdx - len + 1; k <= seedIdx; k++) seed += src[k]!;
  let prev = seed / len;
  out[seedIdx] = prev;
  for (let i = seedIdx + 1; i < n; i++) {
    const v = src[i]!;
    if (Number.isNaN(v)) { out[i] = NaN; continue; } // gap: carry state, emit NaN
    prev = alpha * v + (1 - alpha) * prev;
    out[i] = prev;
  }
  return out;
}

export const ema = (src: number[], len: number): number[] =>
  len === 1 ? src.slice() : recursiveMa(src, len, 2 / (len + 1));

export const rma = (src: number[], len: number): number[] =>
  recursiveMa(src, len, 1 / len);

export function wma(src: number[], len: number): number[] {
  const n = src.length;
  const out = new Array<number>(n).fill(NaN);
  const norm = (len * (len + 1)) / 2;
  outer: for (let i = len - 1; i < n; i++) {
    let acc = 0;
    for (let k = 0; k < len; k++) {
      const v = src[i - k]!;
      if (Number.isNaN(v)) continue outer;
      acc += v * (len - k);
    }
    out[i] = acc / norm;
  }
  return out;
}

export function vwma(src: number[], volume: number[], len: number): number[] {
  const pv = src.map((v, i) => v * volume[i]!);
  const a = sma(pv, len);
  const b = sma(volume, len);
  return a.map((v, i) => (b[i]! !== 0 ? v / b[i]! : NaN));
}

/** HMA exactly as the Pine source builds it: int() truncates, floor(sqrt(len)). */
export function hma(src: number[], len: number): number[] {
  const half = Math.trunc(Math.max(1, len / 2));
  const sq = Math.trunc(Math.max(1, Math.floor(Math.sqrt(len))));
  const w1 = wma(src, half);
  const w2 = wma(src, len);
  const diff = w1.map((v, i) => 2 * v - w2[i]!);
  return wma(diff, sq);
}

export type MaType = "SMA" | "EMA" | "WMA" | "RMA" | "VWMA" | "HMA";

export function maByType(
  type: MaType, src: number[], len: number, volume: number[]
): number[] {
  switch (type) {
    case "SMA": return sma(src, len);
    case "EMA": return ema(src, len);
    case "WMA": return wma(src, len);
    case "RMA": return rma(src, len);
    case "VWMA": return vwma(src, volume, len);
    case "HMA": return hma(src, len);
  }
}

/** ta.tr — NaN on the first bar (no prior close). */
export function trueRange(high: number[], low: number[], close: number[]): number[] {
  const n = high.length;
  const out = new Array<number>(n).fill(NaN);
  for (let i = 1; i < n; i++) {
    const pc = close[i - 1]!;
    out[i] = Math.max(high[i]! - low[i]!, Math.abs(high[i]! - pc), Math.abs(low[i]! - pc));
  }
  return out;
}

/** ta.atr = rma(tr(true), len); tr(true) uses high-low on the first bar. */
export function atr(high: number[], low: number[], close: number[], len: number): number[] {
  const tr = trueRange(high, low, close);
  if (tr.length > 0) tr[0] = high[0]! - low[0]!;
  return rma(tr, len);
}

export function rsi(src: number[], len: number): number[] {
  const n = src.length;
  const up = new Array<number>(n).fill(NaN);
  const dn = new Array<number>(n).fill(NaN);
  for (let i = 1; i < n; i++) {
    const ch = src[i]! - src[i - 1]!;
    up[i] = Math.max(ch, 0);
    dn[i] = Math.max(-ch, 0);
  }
  const ru = rma(up, len);
  const rd = rma(dn, len);
  return ru.map((u, i) => {
    const d = rd[i]!;
    if (Number.isNaN(u) || Number.isNaN(d)) return NaN;
    if (d === 0) return 100;
    return 100 - 100 / (1 + u / d);
  });
}

/** The two oscillator/signal smoothings TradingView's built-in MACD offers. */
export type MacdMaType = "ema" | "sma";

export interface Macd {
  /** Fast MA minus slow MA. */
  macd: number[];
  /** The smoothing of `macd`. */
  signal: number[];
  /** `macd - signal`. */
  histogram: number[];
}

/**
 * ta.macd, with the MA type separable for the oscillator and the signal
 * exactly as the built-in indicator exposes it.
 *
 * The signal is smoothed from the MACD line **including its leading NaNs**:
 * `ema`/`sma` here seed the same way they do for price, so the first signal
 * value appears at the same bar TradingView produces one. Computing it from a
 * NaN-stripped array instead would shift every signal value earlier and quietly
 * change where a crossover lands.
 */
export function macd(
  src: number[],
  fastLen: number,
  slowLen: number,
  signalLen: number,
  oscType: MacdMaType = "ema",
  signalType: MacdMaType = "ema"
): Macd {
  const smooth = (s: number[], len: number, t: MacdMaType): number[] =>
    t === "ema" ? ema(s, len) : sma(s, len);

  const fast = smooth(src, fastLen, oscType);
  const slow = smooth(src, slowLen, oscType);
  const line = fast.map((f, i) => {
    const s = slow[i]!;
    return Number.isNaN(f) || Number.isNaN(s) ? NaN : f - s;
  });
  const signal = smooth(line, signalLen, signalType);
  const histogram = line.map((m, i) => {
    const s = signal[i]!;
    return Number.isNaN(m) || Number.isNaN(s) ? NaN : m - s;
  });
  return { macd: line, signal, histogram };
}

/** ta.mfi exactly as Pine defines it (src is typically hlc3). */
export function mfi(src: number[], volume: number[], len: number): number[] {
  const n = src.length;
  const upFlow = new Array<number>(n).fill(NaN);
  const dnFlow = new Array<number>(n).fill(NaN);
  for (let i = 1; i < n; i++) {
    const ch = src[i]! - src[i - 1]!;
    upFlow[i] = volume[i]! * (ch <= 0 ? 0 : src[i]!);
    dnFlow[i] = volume[i]! * (ch >= 0 ? 0 : src[i]!);
  }
  const su = rollSum(upFlow, len);
  const sd = rollSum(dnFlow, len);
  return su.map((u, i) => {
    const d = sd[i]!;
    if (Number.isNaN(u) || Number.isNaN(d)) return NaN;
    if (d === 0) return 100;
    return 100 - 100 / (1 + u / d);
  });
}

/**
 * Sliding-window extreme in O(n) via a monotonic deque of indices.
 *
 * Replaces an O(n × len) rescan that dominated backtest cost on long feeds
 * (measured: 196ms → 22ms for highest(high, 50) over 544k 1m bars).
 *
 * Semantics are preserved EXACTLY, which is what makes this safe to change
 * underneath strategies that already own leaderboard history:
 *   - NaN inputs are skipped, never poisoning the window
 *   - bars before the window is full stay NaN
 *   - a window holding only NaN yields NaN
 * Verified bit-identical against the previous implementation on a real 544k-bar
 * 1m series plus a NaN-riddled synthetic series, at len ∈ {2,10,20,30,50,200}.
 *
 * The deque holds indices whose values are monotone from the head, so the head
 * is always the window's extreme. `dq` is sized n because entries are appended
 * monotonically; only `len` of them are live at any moment.
 */
function monotonicWindow(src: number[], len: number, wantMax: boolean): number[] {
  const n = src.length;
  const out = new Array<number>(n).fill(NaN);
  if (len <= 0) return out;
  const dq = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < n; i++) {
    const v = src[i]!;
    if (!Number.isNaN(v)) {
      // Drop tail entries that can never be the extreme again.
      while (tail > head && (wantMax ? src[dq[tail - 1]!]! <= v : src[dq[tail - 1]!]! >= v)) tail--;
      dq[tail++] = i;
    }
    const oldest = i - len + 1;
    while (tail > head && dq[head]! < oldest) head++;
    if (i >= len - 1) out[i] = tail > head ? src[dq[head]!]! : NaN;
  }
  return out;
}

export function highest(src: number[], len: number): number[] {
  return monotonicWindow(src, len, true);
}

export function lowest(src: number[], len: number): number[] {
  return monotonicWindow(src, len, false);
}

/** ta.linreg(src, len, offset): least-squares line value at the window end. */
export function linreg(src: number[], len: number, offset: number): number[] {
  const n = src.length;
  const out = new Array<number>(n).fill(NaN);
  // x = 0..len-1 over the window (oldest→newest); value at x = len-1-offset.
  const sumX = (len * (len - 1)) / 2;
  const sumX2 = ((len - 1) * len * (2 * len - 1)) / 6;
  outer: for (let i = len - 1; i < n; i++) {
    let sumY = 0;
    let sumXY = 0;
    for (let k = 0; k < len; k++) {
      const v = src[i - len + 1 + k]!;
      if (Number.isNaN(v)) continue outer;
      sumY += v;
      sumXY += k * v;
    }
    const denom = len * sumX2 - sumX * sumX;
    const slope = denom !== 0 ? (len * sumXY - sumX * sumY) / denom : 0;
    const intercept = sumY / len - (slope * sumX) / len;
    out[i] = intercept + slope * (len - 1 - offset);
  }
  return out;
}

/**
 * ta.stdev(src, len) — population standard deviation over the window, which is
 * the divisor Pine uses (biased, /len, not /(len-1)).
 */
export function stdev(src: number[], len: number): number[] {
  const n = src.length;
  const out = new Array<number>(n).fill(NaN);
  const means = sma(src, len);
  outer: for (let i = len - 1; i < n; i++) {
    const mean = means[i]!;
    if (Number.isNaN(mean)) continue;
    let acc = 0;
    for (let k = 0; k < len; k++) {
      const v = src[i - k]!;
      if (Number.isNaN(v)) continue outer;
      const d = v - mean;
      acc += d * d;
    }
    out[i] = Math.sqrt(acc / len);
  }
  return out;
}

/** ta.crossover(a, b): a crosses above b (previous values must be valid). */
export function crossover(a: number[], b: number[]): boolean[] {
  const n = a.length;
  const out = new Array<boolean>(n).fill(false);
  for (let i = 1; i < n; i++) {
    out[i] = a[i]! > b[i]! && a[i - 1]! <= b[i - 1]!;
  }
  return out;
}

export function crossunder(a: number[], b: number[]): boolean[] {
  const n = a.length;
  const out = new Array<boolean>(n).fill(false);
  for (let i = 1; i < n; i++) {
    out[i] = a[i]! < b[i]! && a[i - 1]! >= b[i - 1]!;
  }
  return out;
}

/**
 * ta.pivothigh(src, left, right): the pivot PRICE appears at the confirmation
 * bar (pivot index + right); NaN elsewhere. Strict inequality, matching Pine.
 */
export function pivothigh(src: number[], left: number, right: number): number[] {
  const n = src.length;
  const out = new Array<number>(n).fill(NaN);
  for (let p = left; p + right < n; p++) {
    const v = src[p]!;
    if (Number.isNaN(v)) continue;
    let isPivot = true;
    for (let k = p - left; k <= p + right && isPivot; k++) {
      if (k === p) continue;
      if (!(v > src[k]!)) isPivot = false;
    }
    if (isPivot) out[p + right] = v;
  }
  return out;
}

export function pivotlow(src: number[], left: number, right: number): number[] {
  const n = src.length;
  const out = new Array<number>(n).fill(NaN);
  for (let p = left; p + right < n; p++) {
    const v = src[p]!;
    if (Number.isNaN(v)) continue;
    let isPivot = true;
    for (let k = p - left; k <= p + right && isPivot; k++) {
      if (k === p) continue;
      if (!(v < src[k]!)) isPivot = false;
    }
    if (isPivot) out[p + right] = v;
  }
  return out;
}

/**
 * ta.valuewhen(cond, src, occurrence) — value of src at the occurrence-th most
 * recent bar where cond was true (0 = latest).
 */
export function valuewhen(cond: boolean[], src: number[], occurrence: number): number[] {
  const n = cond.length;
  const out = new Array<number>(n).fill(NaN);
  const hits: number[] = []; // most recent last
  for (let i = 0; i < n; i++) {
    if (cond[i]) {
      hits.push(src[i]!);
      if (hits.length > occurrence + 4) hits.shift();
    }
    const k = hits.length - 1 - occurrence;
    out[i] = k >= 0 ? hits[k]! : NaN;
  }
  return out;
}

/** ta.barssince(cond) — NaN until cond has been true at least once. */
export function barssince(cond: boolean[]): number[] {
  const n = cond.length;
  const out = new Array<number>(n).fill(NaN);
  let last = -1;
  for (let i = 0; i < n; i++) {
    if (cond[i]) last = i;
    out[i] = last >= 0 ? i - last : NaN;
  }
  return out;
}

// ── Source helpers ─────────────────────────────────────────────────────────────

export function hl2(high: number[], low: number[]): number[] {
  return high.map((h, i) => (h + low[i]!) / 2);
}

export function hlc3(high: number[], low: number[], close: number[]): number[] {
  return high.map((h, i) => (h + low[i]! + close[i]!) / 3);
}

export function ohlc4(open: number[], high: number[], low: number[], close: number[]): number[] {
  return open.map((o, i) => (o + high[i]! + low[i]! + close[i]!) / 4);
}

/**
 * Supertrend — an ATR band that ratchets one way until price closes through it.
 *
 * A direct port of the v4 study this platform's users already read on their
 * charts, and the port is deliberately literal rather than tidied:
 *
 *  - The bands are STATEFUL. `up` may only rise while the previous close was
 *    above it, and `dn` may only fall while the previous close was below it.
 *    Recomputing them from the current bar alone gives a line that wanders back
 *    and forth and a flip count several times the real one.
 *  - The flip test compares this bar's close against the PREVIOUS bar's band
 *    (`up1`/`dn1`), not against the band it is currently computing. Using the
 *    current one makes the condition partly self-referential and shifts every
 *    signal by a bar.
 *  - `changeAtr` picks which average of true range is used: Wilder's RMA (the
 *    study's default, matching `ta.atr`) or a simple mean. They are different
 *    indicators, not a rounding difference — the SMA branch also inherits the
 *    study's `tr` rather than `tr(true)`, so its first bar is NaN.
 *
 * `trend` is +1 in an uptrend and -1 in a downtrend; `line` is whichever band
 * is currently drawn, which is the price a notification should name.
 */
export interface Supertrend {
  /** +1 uptrend, -1 downtrend. NaN while the ATR has not warmed up. */
  trend: number[];
  /** The band being drawn at this bar: `up` in an uptrend, `dn` in a downtrend. */
  line: number[];
  up: number[];
  dn: number[];
}

export function supertrend(
  high: number[],
  low: number[],
  close: number[],
  period: number,
  multiplier: number,
  changeAtr = true
): Supertrend {
  const n = close.length;
  const atrSeries = changeAtr
    ? atr(high, low, close, period)
    : sma(trueRange(high, low, close), period);
  const src = hl2(high, low);

  const up = new Array<number>(n).fill(NaN);
  const dn = new Array<number>(n).fill(NaN);
  const trend = new Array<number>(n).fill(NaN);
  const line = new Array<number>(n).fill(NaN);

  let prevUp = NaN;
  let prevDn = NaN;
  // The study seeds `trend` at 1 and carries it with nz(), so the first bars
  // with a usable ATR continue from an uptrend rather than from "unknown".
  let prevTrend = 1;

  for (let i = 0; i < n; i++) {
    const a = atrSeries[i]!;
    // No ATR yet: leave the bar NaN. The alert layer treats a NaN trend as
    // "not resolved" and neither fires nor rewrites its stored side.
    if (!Number.isFinite(a)) continue;

    let u = src[i]! - multiplier * a;
    let d = src[i]! + multiplier * a;
    const up1 = Number.isFinite(prevUp) ? prevUp : u;
    const dn1 = Number.isFinite(prevDn) ? prevDn : d;
    const prevClose = i > 0 ? close[i - 1]! : NaN;

    if (Number.isFinite(prevClose) && prevClose > up1) u = Math.max(u, up1);
    if (Number.isFinite(prevClose) && prevClose < dn1) d = Math.min(d, dn1);

    let t = prevTrend;
    if (t === -1 && close[i]! > dn1) t = 1;
    else if (t === 1 && close[i]! < up1) t = -1;

    up[i] = u;
    dn[i] = d;
    trend[i] = t;
    line[i] = t === 1 ? u : d;
    prevUp = u;
    prevDn = d;
    prevTrend = t;
  }

  return { trend, line, up, dn };
}

/* ════════════════════════════════════════════════════════════════════════════
 * NEW PRIMITIVES
 *
 * Everything below is added by the native-study platform. Nothing above it
 * changed, so no existing consumer's numbers moved.
 * ════════════════════════════════════════════════════════════════════════════ */

/** A finite number, or NaN. Never Infinity — see the conventions above. */
function finite(v: number): number {
  return Number.isFinite(v) ? v : NaN;
}

/** `a / b`, NaN when the division is not defined rather than ±Infinity. */
function div(a: number, b: number): number {
  if (Number.isNaN(a) || Number.isNaN(b) || b === 0) return NaN;
  return finite(a / b);
}

/** Element-wise, NaN-propagating combination of two series. */
function zip(a: number[], b: number[], f: (x: number, y: number) => number): number[] {
  const n = Math.min(a.length, b.length);
  const out = new Array<number>(a.length).fill(NaN);
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    out[i] = Number.isNaN(x) || Number.isNaN(y) ? NaN : finite(f(x, y));
  }
  return out;
}

export const addSeries = (a: number[], b: number[]): number[] => zip(a, b, (x, y) => x + y);
export const subSeries = (a: number[], b: number[]): number[] => zip(a, b, (x, y) => x - y);
export const mulSeries = (a: number[], b: number[]): number[] => zip(a, b, (x, y) => x * y);
export const divSeries = (a: number[], b: number[]): number[] => zip(a, b, (x, y) => div(x, y));

/** Scale every finite element; NaN stays NaN. */
export function scaleSeries(src: number[], k: number): number[] {
  return src.map((v) => (Number.isNaN(v) ? NaN : finite(v * k)));
}

/** Add a constant to every finite element. */
export function offsetSeries(src: number[], k: number): number[] {
  return src.map((v) => (Number.isNaN(v) ? NaN : finite(v + k)));
}

// ── Moving averages ─────────────────────────────────────────────────────────

/**
 * Double exponential moving average: 2·EMA − EMA(EMA).
 *
 * The inner EMA is fed the OUTER EMA including its leading NaNs, so the first
 * DEMA value appears where TradingView's does. Stripping the NaNs first would
 * shift the whole line earlier by `len − 1` bars.
 */
export function dema(src: number[], len: number): number[] {
  const e1 = ema(src, len);
  const e2 = ema(e1, len);
  return zip(e1, e2, (a, b) => 2 * a - b);
}

/** Triple exponential moving average: 3·EMA − 3·EMA² + EMA³. */
export function tema(src: number[], len: number): number[] {
  const e1 = ema(src, len);
  const e2 = ema(e1, len);
  const e3 = ema(e2, len);
  const n = src.length;
  const out = new Array<number>(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const a = e1[i]!;
    const b = e2[i]!;
    const c = e3[i]!;
    if (Number.isNaN(a) || Number.isNaN(b) || Number.isNaN(c)) continue;
    out[i] = finite(3 * a - 3 * b + c);
  }
  return out;
}

/**
 * Kaufman's Adaptive Moving Average.
 *
 * The smoothing constant is driven by the efficiency ratio — direction over
 * total travel across the window — so the line tracks a trend closely and
 * flattens in chop. Seeded with the source value at the first bar where a full
 * efficiency window exists, which is how the reference implementation starts:
 * seeding with an SMA instead would make the first hundred bars of a fast KAMA
 * visibly wrong.
 */
export function kama(src: number[], len: number, fast = 2, slow = 30): number[] {
  const n = src.length;
  const out = new Array<number>(n).fill(NaN);
  if (len <= 0) return out;
  const fastSc = 2 / (fast + 1);
  const slowSc = 2 / (slow + 1);
  let prev = NaN;
  for (let i = 0; i < n; i++) {
    const v = src[i]!;
    if (i < len || Number.isNaN(v)) continue;
    const anchor = src[i - len]!;
    if (Number.isNaN(anchor)) continue;
    let volatility = 0;
    let usable = true;
    for (let k = 0; k < len; k++) {
      const a = src[i - k]!;
      const b = src[i - k - 1]!;
      if (Number.isNaN(a) || Number.isNaN(b)) { usable = false; break; }
      volatility += Math.abs(a - b);
    }
    if (!usable) continue;
    const ratio = volatility === 0 ? 0 : Math.abs(v - anchor) / volatility;
    const sc = (ratio * (fastSc - slowSc) + slowSc) ** 2;
    prev = Number.isNaN(prev) ? v : prev + sc * (v - prev);
    out[i] = finite(prev);
  }
  return out;
}

/**
 * McGinley Dynamic — an EMA whose speed adapts to how far price has run from
 * it, so it lags less on impulses without overshooting on reversals.
 *
 * The denominator is clamped away from zero: a ratio of exactly zero (price at
 * zero, which no spot instrument reaches, or a NaN-poisoned state) would
 * otherwise divide by nothing and put Infinity on a chart.
 */
export function mcginley(src: number[], len: number): number[] {
  const n = src.length;
  const out = new Array<number>(n).fill(NaN);
  if (len <= 0) return out;
  const seed = sma(src, len);
  let prev = NaN;
  for (let i = 0; i < n; i++) {
    const v = src[i]!;
    if (Number.isNaN(v)) continue;
    if (Number.isNaN(prev)) {
      const s = seed[i]!;
      if (Number.isNaN(s)) continue;
      prev = s;
      out[i] = prev;
      continue;
    }
    const ratio = div(v, prev);
    if (Number.isNaN(ratio) || ratio === 0) { out[i] = prev; continue; }
    prev = finite(prev + (v - prev) / (len * ratio ** 4));
    if (Number.isNaN(prev)) { out[i] = NaN; break; }
    out[i] = prev;
  }
  return out;
}

/** Every moving average the generic MA study offers. */
export type GenericMaType = "SMA" | "EMA" | "RMA" | "WMA" | "HMA" | "VWMA" | "DEMA" | "TEMA";

export function genericMa(
  type: GenericMaType, src: number[], len: number, volume: number[]
): number[] {
  switch (type) {
    case "SMA": return sma(src, len);
    case "EMA": return ema(src, len);
    case "RMA": return rma(src, len);
    case "WMA": return wma(src, len);
    case "HMA": return hma(src, len);
    case "VWMA": return vwma(src, volume, len);
    case "DEMA": return dema(src, len);
    case "TEMA": return tema(src, len);
  }
}

// ── Rolling statistics ──────────────────────────────────────────────────────

/** Rolling arithmetic mean. The same function as `sma`, named for what it is. */
export const rollingMean = sma;

/**
 * Rolling POPULATION variance (÷ len).
 *
 * Population rather than sample, because that is the divisor `stdev` above
 * already uses and the two must be consistent: `variance` must be exactly
 * `stdev²` or a Bollinger width and a variance plot of the same window would
 * disagree.
 */
export function variance(src: number[], len: number): number[] {
  const s = stdev(src, len);
  return s.map((v) => (Number.isNaN(v) ? NaN : finite(v * v)));
}

/**
 * Rolling population covariance of two series over the same window.
 *
 * A shared primitive, not a chart indicator. It exists because correlation and
 * beta are defined in terms of it; plotting covariance itself would be a line
 * in units of price-squared that answers no question a chart asks.
 */
export function covariance(a: number[], b: number[], len: number): number[] {
  const n = Math.min(a.length, b.length);
  const out = new Array<number>(Math.max(a.length, b.length)).fill(NaN);
  if (len <= 0) return out;
  const ma = sma(a, len);
  const mb = sma(b, len);
  outer: for (let i = len - 1; i < n; i++) {
    const meanA = ma[i]!;
    const meanB = mb[i]!;
    if (Number.isNaN(meanA) || Number.isNaN(meanB)) continue;
    let acc = 0;
    for (let k = 0; k < len; k++) {
      const x = a[i - k]!;
      const y = b[i - k]!;
      if (Number.isNaN(x) || Number.isNaN(y)) continue outer;
      acc += (x - meanA) * (y - meanB);
    }
    out[i] = finite(acc / len);
  }
  return out;
}

/**
 * Rolling Pearson correlation, in [-1, 1].
 *
 * A window in which either series does not move has no correlation to report:
 * the denominator is zero and the answer is NaN, not 0 and not 1. Clamped
 * because floating-point accumulation can produce 1.0000000000000002, and a
 * correlation plotted above 1 is a bug the eye cannot unsee.
 */
export function correlation(a: number[], b: number[], len: number): number[] {
  const cov = covariance(a, b, len);
  const sa = stdev(a, len);
  const sb = stdev(b, len);
  return cov.map((c, i) => {
    const x = sa[i]!;
    const y = sb[i]!;
    if (Number.isNaN(c) || Number.isNaN(x) || Number.isNaN(y)) return NaN;
    if (x === 0 || y === 0) return NaN;
    const r = c / (x * y);
    return Number.isFinite(r) ? Math.max(-1, Math.min(1, r)) : NaN;
  });
}

/**
 * Rolling beta of `asset` against `benchmark`.
 *
 * Covariance over the benchmark's variance — so it is computed from RETURNS by
 * the caller, never from raw prices. Beta of a price against a price is a
 * number with no meaning, and this file is not the place to hide that
 * distinction: `logReturns`/`simpleReturns` are right here.
 */
export function beta(asset: number[], benchmark: number[], len: number): number[] {
  const cov = covariance(asset, benchmark, len);
  const varB = variance(benchmark, len);
  return cov.map((c, i) => {
    const v = varB[i]!;
    if (Number.isNaN(c) || Number.isNaN(v) || v === 0) return NaN;
    return finite(c / v);
  });
}

/** Rolling z-score: how many standard deviations the value is from its mean. */
export function zscore(src: number[], len: number): number[] {
  const mean = sma(src, len);
  const sd = stdev(src, len);
  return src.map((v, i) => {
    const m = mean[i]!;
    const s = sd[i]!;
    if (Number.isNaN(v) || Number.isNaN(m) || Number.isNaN(s) || s === 0) return NaN;
    return finite((v - m) / s);
  });
}

/**
 * Where the current value sits within its window, as a percentage.
 *
 * Ties count as half, which is the standard mid-rank convention: a window of
 * identical values scores 50, not 0 and not 100.
 */
export function percentileRank(src: number[], len: number): number[] {
  const n = src.length;
  const out = new Array<number>(n).fill(NaN);
  if (len <= 0) return out;
  outer: for (let i = len - 1; i < n; i++) {
    const v = src[i]!;
    if (Number.isNaN(v)) continue;
    let below = 0;
    let equal = 0;
    for (let k = 0; k < len; k++) {
      const w = src[i - k]!;
      if (Number.isNaN(w)) continue outer;
      if (w < v) below += 1;
      else if (w === v) equal += 1;
    }
    out[i] = finite(((below + equal / 2) / len) * 100);
  }
  return out;
}

/** Rolling least-squares slope, in source units per bar. */
export function linregSlope(src: number[], len: number): number[] {
  const n = src.length;
  const out = new Array<number>(n).fill(NaN);
  if (len < 2) return out;
  const sumX = (len * (len - 1)) / 2;
  const sumX2 = ((len - 1) * len * (2 * len - 1)) / 6;
  const denom = len * sumX2 - sumX * sumX;
  if (denom === 0) return out;
  outer: for (let i = len - 1; i < n; i++) {
    let sumY = 0;
    let sumXY = 0;
    for (let k = 0; k < len; k++) {
      const v = src[i - len + 1 + k]!;
      if (Number.isNaN(v)) continue outer;
      sumY += v;
      sumXY += k * v;
    }
    out[i] = finite((len * sumXY - sumX * sumY) / denom);
  }
  return out;
}

/**
 * Coefficient of determination of the rolling least-squares fit, in [0, 1].
 *
 * A window with no variance in the source has no fit to score: R² is NaN
 * there, not 1. Reporting a perfect fit for a flat line would say the trend is
 * maximally reliable at exactly the moment there is no trend.
 */
export function rSquared(src: number[], len: number): number[] {
  const n = src.length;
  const out = new Array<number>(n).fill(NaN);
  if (len < 2) return out;
  const sumX = (len * (len - 1)) / 2;
  const sumX2 = ((len - 1) * len * (2 * len - 1)) / 6;
  const denom = len * sumX2 - sumX * sumX;
  if (denom === 0) return out;
  outer: for (let i = len - 1; i < n; i++) {
    let sumY = 0;
    let sumXY = 0;
    for (let k = 0; k < len; k++) {
      const v = src[i - len + 1 + k]!;
      if (Number.isNaN(v)) continue outer;
      sumY += v;
      sumXY += k * v;
    }
    const slope = (len * sumXY - sumX * sumY) / denom;
    const mean = sumY / len;
    const intercept = mean - (slope * sumX) / len;
    let ssRes = 0;
    let ssTot = 0;
    for (let k = 0; k < len; k++) {
      const v = src[i - len + 1 + k]!;
      const fit = intercept + slope * k;
      ssRes += (v - fit) ** 2;
      ssTot += (v - mean) ** 2;
    }
    if (ssTot === 0) continue;
    const r2 = 1 - ssRes / ssTot;
    out[i] = Number.isFinite(r2) ? Math.max(0, Math.min(1, r2)) : NaN;
  }
  return out;
}

/** Bar-over-bar simple returns. NaN on the first bar and across any gap. */
export function simpleReturns(src: number[]): number[] {
  const n = src.length;
  const out = new Array<number>(n).fill(NaN);
  for (let i = 1; i < n; i++) {
    const prev = src[i - 1]!;
    const v = src[i]!;
    if (Number.isNaN(prev) || Number.isNaN(v) || prev === 0) continue;
    out[i] = finite(v / prev - 1);
  }
  return out;
}

/** Bar-over-bar log returns. NaN wherever a price is non-positive. */
export function logReturns(src: number[]): number[] {
  const n = src.length;
  const out = new Array<number>(n).fill(NaN);
  for (let i = 1; i < n; i++) {
    const prev = src[i - 1]!;
    const v = src[i]!;
    if (!(prev > 0) || !(v > 0)) continue;
    out[i] = finite(Math.log(v / prev));
  }
  return out;
}

/**
 * Annualised close-to-close historical volatility, in percent.
 *
 * `annualFactor` is supplied by the caller because it is a property of the
 * TIMEFRAME, not of the maths.
 *
 * TVP8: it used to be bars-per-year — a true annualisation, and not the
 * reference's. The reference's Historical Volatility is
 *
 *     hv = 100 * stdev(log(close / close[1]), length) * sqrt(annual / per)
 *
 * with `annual = 365` and `per` 1 on intraday and daily bars, 7 above them.
 * On 4h that is sqrt(365) ≈ 19.1 against bars-per-year's sqrt(2190) ≈ 46.8 —
 * the same series scaled by 2.45, and on 1m by about 38. Both are defensible
 * as statistics and only one of them is the number a TradingView user is
 * comparing against, which is what this study is for. See `hvStudy`.
 */
export function historicalVolatility(
  close: number[], len: number, annualFactor: number
): number[] {
  const sd = stdev(logReturns(close), len);
  const k = Math.sqrt(Math.max(0, annualFactor));
  return sd.map((v) => (Number.isNaN(v) ? NaN : finite(v * k * 100)));
}

// ── Bands and channels ──────────────────────────────────────────────────────

export interface Bands {
  upper: number[];
  middle: number[];
  lower: number[];
}

/** Bollinger Bands: an MA with symmetric standard-deviation envelopes. */
export function bollinger(
  src: number[], len: number, mult: number, maType: GenericMaType = "SMA",
  volume: number[] = []
): Bands {
  const middle = genericMa(maType, src, len, volume);
  const dev = stdev(src, len);
  const upper = zip(middle, dev, (m, d) => m + mult * d);
  const lower = zip(middle, dev, (m, d) => m - mult * d);
  return { upper, middle, lower };
}

/**
 * %B — where price sits across the Bollinger band, 0 at the lower and 1 at the
 * upper. NaN when the bands have collapsed onto each other.
 */
export function bollingerPercentB(
  src: number[], len: number, mult: number, maType: GenericMaType = "SMA",
  volume: number[] = []
): number[] {
  const b = bollinger(src, len, mult, maType, volume);
  return src.map((v, i) => {
    const u = b.upper[i]!;
    const l = b.lower[i]!;
    if (Number.isNaN(v) || Number.isNaN(u) || Number.isNaN(l) || u === l) return NaN;
    return finite((v - l) / (u - l));
  });
}

/** Band width as a fraction of the middle band. */
export function bollingerBandWidth(
  src: number[], len: number, mult: number, maType: GenericMaType = "SMA",
  volume: number[] = []
): number[] {
  const b = bollinger(src, len, mult, maType, volume);
  return b.middle.map((m, i) => {
    const u = b.upper[i]!;
    const l = b.lower[i]!;
    if (Number.isNaN(u) || Number.isNaN(l) || Number.isNaN(m) || m === 0) return NaN;
    return finite((u - l) / m);
  });
}

/** Keltner Channels: an EMA with ATR envelopes. */
export function keltner(
  high: number[], low: number[], close: number[],
  len: number, mult: number, atrLen: number
): Bands {
  const middle = ema(close, len);
  const range = atr(high, low, close, atrLen);
  return {
    middle,
    upper: zip(middle, range, (m, a) => m + mult * a),
    lower: zip(middle, range, (m, a) => m - mult * a),
  };
}

/** Donchian Channels: the highest high and lowest low of the window. */
export function donchian(high: number[], low: number[], len: number): Bands {
  const upper = highest(high, len);
  const lower = lowest(low, len);
  return { upper, lower, middle: zip(upper, lower, (u, l) => (u + l) / 2) };
}

/** Envelopes: an MA displaced by a fixed percentage. */
export function envelopes(
  src: number[], len: number, percent: number, maType: GenericMaType = "SMA",
  volume: number[] = []
): Bands {
  const middle = genericMa(maType, src, len, volume);
  const k = percent / 100;
  return {
    middle,
    upper: middle.map((m) => (Number.isNaN(m) ? NaN : finite(m * (1 + k)))),
    lower: middle.map((m) => (Number.isNaN(m) ? NaN : finite(m * (1 - k)))),
  };
}

// ── Oscillators ─────────────────────────────────────────────────────────────

export interface Stochastic {
  k: number[];
  d: number[];
}

/**
 * Raw stochastic %K: where close sits in the high-low range of the window.
 *
 * A window whose high equals its low has no range to place the close within;
 * the value is NaN rather than the 50 that some implementations invent.
 */
export function stochasticRaw(
  high: number[], low: number[], close: number[], len: number
): number[] {
  const hh = highest(high, len);
  const ll = lowest(low, len);
  return close.map((c, i) => {
    const h = hh[i]!;
    const l = ll[i]!;
    if (Number.isNaN(c) || Number.isNaN(h) || Number.isNaN(l) || h === l) return NaN;
    return finite(Math.max(0, Math.min(100, ((c - l) / (h - l)) * 100)));
  });
}

/**
 * Clamp a definitionally bounded series back inside its bounds.
 *
 *  accumulates a rolling sum by adding the new value and subtracting the
 * one leaving the window, which is what makes it O(n) — and which lets the sum
 * drift by an ulp or two over a long series. Smoothing three values that are
 * all exactly 100 can therefore produce 100.00000000000001, and an oscillator
 * plotted a hair above its own 100 line reads as a bug to every user who sees
 * it. The bound here is not a guess about the data; it is the definition.
 */
function clampSeries(src: number[], lo: number, hi: number): number[] {
  return src.map((v) => (Number.isNaN(v) ? NaN : Math.max(lo, Math.min(hi, v))));
}

/** Stochastic oscillator: smoothed %K with its own %D signal. */
export function stochastic(
  high: number[], low: number[], close: number[],
  kLen: number, kSmooth: number, dSmooth: number
): Stochastic {
  const k = clampSeries(sma(stochasticRaw(high, low, close, kLen), kSmooth), 0, 100);
  return { k, d: clampSeries(sma(k, dSmooth), 0, 100) };
}

/**
 * Stochastic RSI: the stochastic formula applied to RSI rather than to price.
 *
 * The stochastic is taken over the RSI series INCLUDING its leading NaNs, so
 * the first value lands where TradingView's does.
 */
export function stochasticRsi(
  src: number[], rsiLen: number, stochLen: number, kSmooth: number, dSmooth: number
): Stochastic {
  const r = rsi(src, rsiLen);
  const raw = stochasticRaw(r, r, r, stochLen);
  /*
   * `highest`/`lowest` SKIP na rather than propagating it — baseline semantics
   * existing consumers rely on, which must not change. Composed over a series
   * that begins with na, that means the stochastic emits as soon as two
   * distinct RSI values exist, so on a short history the first readings are
   * computed over a two- or three-bar window and drawn as if they were real.
   * Blank the region the composition cannot support.
   */
  const firstValid = r.findIndex((v) => !Number.isNaN(v));
  if (firstValid >= 0) {
    const until = Math.min(raw.length, firstValid + Math.max(1, stochLen) - 1);
    for (let i = 0; i < until; i++) raw[i] = NaN;
  }
  const k = clampSeries(sma(raw, kSmooth), 0, 100);
  return { k, d: clampSeries(sma(k, dSmooth), 0, 100) };
}

/** Commodity Channel Index, on the classic 0.015 mean-deviation scaling. */
export function cci(src: number[], len: number): number[] {
  const n = src.length;
  const out = new Array<number>(n).fill(NaN);
  const mean = sma(src, len);
  outer: for (let i = len - 1; i < n; i++) {
    const m = mean[i]!;
    if (Number.isNaN(m)) continue;
    let dev = 0;
    for (let k = 0; k < len; k++) {
      const v = src[i - k]!;
      if (Number.isNaN(v)) continue outer;
      dev += Math.abs(v - m);
    }
    const meanDev = dev / len;
    if (meanDev === 0) continue; // no dispersion: the index is undefined here
    out[i] = finite((src[i]! - m) / (0.015 * meanDev));
  }
  return out;
}

/** Williams %R: the stochastic, expressed from the top of the range down. */
export function williamsR(
  high: number[], low: number[], close: number[], len: number
): number[] {
  const hh = highest(high, len);
  const ll = lowest(low, len);
  return close.map((c, i) => {
    const h = hh[i]!;
    const l = ll[i]!;
    if (Number.isNaN(c) || Number.isNaN(h) || Number.isNaN(l) || h === l) return NaN;
    return finite(((h - c) / (h - l)) * -100);
  });
}

/** Rate of change, in percent. */
export function roc(src: number[], len: number): number[] {
  const n = src.length;
  const out = new Array<number>(n).fill(NaN);
  for (let i = len; i < n; i++) {
    const prev = src[i - len]!;
    const v = src[i]!;
    if (Number.isNaN(prev) || Number.isNaN(v) || prev === 0) continue;
    out[i] = finite(((v - prev) / prev) * 100);
  }
  return out;
}

/** Momentum: the plain difference over `len` bars, in price units. */
export function momentum(src: number[], len: number): number[] {
  const n = src.length;
  const out = new Array<number>(n).fill(NaN);
  for (let i = len; i < n; i++) {
    const prev = src[i - len]!;
    const v = src[i]!;
    if (Number.isNaN(prev) || Number.isNaN(v)) continue;
    out[i] = finite(v - prev);
  }
  return out;
}

/** TRIX: the rate of change of a triple-smoothed EMA, in percent. */
export function trix(src: number[], len: number): number[] {
  const e3 = ema(ema(ema(src, len), len), len);
  const n = e3.length;
  const out = new Array<number>(n).fill(NaN);
  for (let i = 1; i < n; i++) {
    const prev = e3[i - 1]!;
    const v = e3[i]!;
    if (Number.isNaN(prev) || Number.isNaN(v) || prev === 0) continue;
    out[i] = finite(((v - prev) / prev) * 100);
  }
  return out;
}

export interface Oscillator {
  line: number[];
  signal: number[];
  histogram: number[];
}

/** Percentage Price Oscillator: MACD expressed as a percentage of the slow MA. */
export function ppo(
  src: number[], fastLen: number, slowLen: number, signalLen: number
): Oscillator {
  const fast = ema(src, fastLen);
  const slow = ema(src, slowLen);
  const line = fast.map((f, i) => {
    const s = slow[i]!;
    if (Number.isNaN(f) || Number.isNaN(s) || s === 0) return NaN;
    return finite(((f - s) / s) * 100);
  });
  const signal = ema(line, signalLen);
  return { line, signal, histogram: subSeries(line, signal) };
}

/** True Strength Index: double-smoothed momentum over double-smoothed |momentum|. */
export function tsi(
  src: number[], longLen: number, shortLen: number, signalLen: number
): Oscillator {
  const ch = change(src);
  const abs = ch.map((v) => (Number.isNaN(v) ? NaN : Math.abs(v)));
  const num = ema(ema(ch, longLen), shortLen);
  const den = ema(ema(abs, longLen), shortLen);
  const line = num.map((v, i) => {
    const d = den[i]!;
    if (Number.isNaN(v) || Number.isNaN(d) || d === 0) return NaN;
    return finite((v / d) * 100);
  });
  const signal = ema(line, signalLen);
  return { line, signal, histogram: subSeries(line, signal) };
}

/**
 * Ultimate Oscillator: buying pressure over true range, weighted 4:2:1 across
 * three windows so no single period dominates the reading.
 */
export function ultimateOscillator(
  high: number[], low: number[], close: number[],
  len1: number, len2: number, len3: number
): number[] {
  const n = close.length;
  const bp = new Array<number>(n).fill(NaN);
  const tr = new Array<number>(n).fill(NaN);
  for (let i = 1; i < n; i++) {
    const pc = close[i - 1]!;
    if (Number.isNaN(pc)) continue;
    bp[i] = close[i]! - Math.min(low[i]!, pc);
    tr[i] = Math.max(high[i]!, pc) - Math.min(low[i]!, pc);
  }
  const avg = (len: number): number[] => {
    const sbp = rollSum(bp, len);
    const str = rollSum(tr, len);
    return sbp.map((v, i) => div(v, str[i]!));
  };
  const a1 = avg(len1);
  const a2 = avg(len2);
  const a3 = avg(len3);
  const out = new Array<number>(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const x = a1[i]!;
    const y = a2[i]!;
    const z = a3[i]!;
    if (Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(z)) continue;
    out[i] = finite((100 * (4 * x + 2 * y + z)) / 7);
  }
  return out;
}

/** Awesome Oscillator: the difference between two SMAs of the median price. */
export function awesomeOscillator(
  high: number[], low: number[], fastLen = 5, slowLen = 34
): number[] {
  const median = hl2(high, low);
  return subSeries(sma(median, fastLen), sma(median, slowLen));
}

/**
 * Fisher Transform: the price position in its range, mapped through
 * `atanh` so that extremes become sharply peaked rather than merely high.
 *
 * The position is clamped strictly inside (−1, 1): `atanh(±1)` is infinite,
 * and an unclamped Fisher spikes to Infinity the first time price touches the
 * exact high of its window — which it does constantly.
 */
export function fisherTransform(
  high: number[], low: number[], len: number
): Oscillator {
  const n = high.length;
  const median = hl2(high, low);
  const hh = highest(median, len);
  const ll = lowest(median, len);
  const line = new Array<number>(n).fill(NaN);
  const signal = new Array<number>(n).fill(NaN);
  let value = 0;
  let fish = 0;
  let started = false;
  for (let i = 0; i < n; i++) {
    const h = hh[i]!;
    const l = ll[i]!;
    const m = median[i]!;
    if (Number.isNaN(h) || Number.isNaN(l) || Number.isNaN(m)) continue;
    /*
     * The position term is `pos - 0.5`, in [-0.5, 0.5] — NOT doubled.
     *
     * The 0.66 / 0.67 / 0.5 constants below are TradingView's, so the
     * normalisation must be TradingView's too. Scaling the position to
     * [-1, 1] doubles the driving signal, which drives `value` to a
     * steady-state magnitude of about 0.66 / (1 - 0.67) = 2 — twice the
     * domain `atanh` is defined on.
     *
     * And it is `value`, the RECURSIVE STATE, that is clamped. Clamping a
     * throwaway copy leaves the state itself to grow without bound, and the
     * clamp then bites on almost every bar: the line becomes a square wave
     * pinned at its extreme rather than an oscillator.
     */
    const raw = h === l ? 0 : (m - l) / (h - l) - 0.5;
    value = Math.max(-0.999, Math.min(0.999, 0.66 * raw + 0.67 * value));
    const prevFish = fish;
    fish = 0.5 * Math.log((1 + value) / (1 - value)) + 0.5 * fish;
    line[i] = finite(fish);
    signal[i] = started ? finite(prevFish) : NaN;
    started = true;
  }
  return { line, signal, histogram: subSeries(line, signal) };
}

/** Chande Momentum Oscillator: net momentum over total momentum, in percent. */
export function chandeMomentum(src: number[], len: number): number[] {
  const n = src.length;
  const up = new Array<number>(n).fill(NaN);
  const dn = new Array<number>(n).fill(NaN);
  for (let i = 1; i < n; i++) {
    const ch = src[i]! - src[i - 1]!;
    if (Number.isNaN(ch)) continue;
    up[i] = Math.max(ch, 0);
    dn[i] = Math.max(-ch, 0);
  }
  const su = rollSum(up, len);
  const sd = rollSum(dn, len);
  return su.map((u, i) => {
    const d = sd[i]!;
    if (Number.isNaN(u) || Number.isNaN(d) || u + d === 0) return NaN;
    return finite(((u - d) / (u + d)) * 100);
  });
}

/**
 * Detrended Price Oscillator: price minus a displaced SMA.
 *
 * The PRICE is read from `len/2 + 1` bars back and compared with the average
 * ending at this bar, which is what "detrended" means here: the comparison is
 * against the middle of the window rather than its end, and the displacement
 * is the tool. It is a cycle-spotting instrument, not a signal generator.
 *
 * Every input is at or before the bar it is plotted on, so it looks ahead at
 * nothing — an earlier comment here called it "non-causal", which described a
 * variant that plots the result BACKWARD by the same displacement. This one
 * does not, and the difference matters: a non-causal series on a chart a
 * backtest reads would be reading the future.
 */
export function detrendedPriceOscillator(
  src: number[], len: number, centered = false
): number[] {
  /*
   * TVP8: this computed only the CENTERED variant, and plotted it uncentered.
   *
   * The reference's DPO has an `isCentered` input and defaults it OFF:
   *
   *     barsback = length / 2 + 1
   *     dpo = isCentered ? close[barsback] - ma : close - ma[barsback]
   *
   * The default compares THIS bar's price against an average taken
   * `barsback` bars ago. What was here compared the price `barsback` bars ago
   * against THIS bar's average — the centered formula — and then drew it on
   * this bar rather than shifted back, which is neither variant. Both are now
   * available and the default is the reference's.
   *
   * Both remain causal: the centered branch reads an OLD price against a
   * current average, so it looks ahead at nothing. (An earlier comment here
   * called that variant "non-causal"; that describes plotting the result
   * BACKWARD by the displacement, which this has never done.)
   */
  const displacement = Math.floor(len / 2) + 1;
  const mean = sma(src, len);
  const n = src.length;
  const out = new Array<number>(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const price = centered ? src[i - displacement] : src[i];
    const average = centered ? mean[i] : mean[i - displacement];
    if (price === undefined || average === undefined) continue;
    if (Number.isNaN(price) || Number.isNaN(average)) continue;
    out[i] = finite(price - average);
  }
  return out;
}

/** Coppock Curve: a WMA of two rates of change, long-horizon by design. */
export function coppock(
  src: number[], longRoc = 14, shortRoc = 11, wmaLen = 10
): number[] {
  return wma(addSeries(roc(src, longRoc), roc(src, shortRoc)), wmaLen);
}

/** Elder Force Index: signed price change scaled by the volume behind it. */
export function elderForceIndex(
  close: number[], volume: number[], len: number
): number[] {
  const raw = close.map((c, i) => {
    const prev = close[i - 1];
    const v = volume[i]!;
    if (i === 0 || prev === undefined || Number.isNaN(prev) || Number.isNaN(c) || Number.isNaN(v)) {
      return NaN;
    }
    return finite((c - prev) * v);
  });
  return ema(raw, len);
}

/**
 * Choppiness Index: how much ground price covered against how far it travelled,
 * on a 0–100 log scale. High is chop, low is trend.
 */
export function choppiness(
  high: number[], low: number[], close: number[], len: number
): number[] {
  const tr = trueRange(high, low, close);
  if (tr.length > 0) tr[0] = high[0]! - low[0]!;
  const sumTr = rollSum(tr, len);
  const hh = highest(high, len);
  const ll = lowest(low, len);
  const scale = Math.log10(len);
  if (!Number.isFinite(scale) || scale === 0) return new Array<number>(high.length).fill(NaN);
  return sumTr.map((s, i) => {
    const range = hh[i]! - ll[i]!;
    if (Number.isNaN(s) || Number.isNaN(range) || range <= 0 || s <= 0) return NaN;
    return finite((100 * Math.log10(s / range)) / scale);
  });
}

// ── Directional movement ────────────────────────────────────────────────────

export interface Adx {
  adx: number[];
  plusDi: number[];
  minusDi: number[];
}

/**
 * Wilder's ADX / DMI.
 *
 * Directional movement is one-sided per bar: only the larger of the two moves
 * counts, and only when it is positive. Both the DI pair and the ADX itself
 * are Wilder-smoothed (`rma`), which is what makes the classic 14/14 settings
 * behave the way every reference implementation does.
 */
export function adx(
  high: number[], low: number[], close: number[], diLen: number, adxLen: number
): Adx {
  const n = close.length;
  const plusDm = new Array<number>(n).fill(NaN);
  const minusDm = new Array<number>(n).fill(NaN);
  for (let i = 1; i < n; i++) {
    const up = high[i]! - high[i - 1]!;
    const down = low[i - 1]! - low[i]!;
    if (Number.isNaN(up) || Number.isNaN(down)) continue;
    plusDm[i] = up > down && up > 0 ? up : 0;
    minusDm[i] = down > up && down > 0 ? down : 0;
  }
  const tr = trueRange(high, low, close);
  if (tr.length > 0) tr[0] = high[0]! - low[0]!;
  const smoothTr = rma(tr, diLen);
  const plusDi = rma(plusDm, diLen).map((v, i) => {
    const t = smoothTr[i]!;
    if (Number.isNaN(v) || Number.isNaN(t) || t === 0) return NaN;
    return finite((v / t) * 100);
  });
  const minusDi = rma(minusDm, diLen).map((v, i) => {
    const t = smoothTr[i]!;
    if (Number.isNaN(v) || Number.isNaN(t) || t === 0) return NaN;
    return finite((v / t) * 100);
  });
  const dx = plusDi.map((p, i) => {
    const m = minusDi[i]!;
    if (Number.isNaN(p) || Number.isNaN(m) || p + m === 0) return NaN;
    return finite((Math.abs(p - m) / (p + m)) * 100);
  });
  return { adx: rma(dx, adxLen), plusDi, minusDi };
}

/** Vortex Indicator: opposing trend movements measured against true range. */
export function vortex(
  high: number[], low: number[], close: number[], len: number
): { plus: number[]; minus: number[] } {
  const n = close.length;
  const vmPlus = new Array<number>(n).fill(NaN);
  const vmMinus = new Array<number>(n).fill(NaN);
  for (let i = 1; i < n; i++) {
    vmPlus[i] = Math.abs(high[i]! - low[i - 1]!);
    vmMinus[i] = Math.abs(low[i]! - high[i - 1]!);
  }
  const tr = trueRange(high, low, close);
  const sumTr = rollSum(tr, len);
  return {
    plus: rollSum(vmPlus, len).map((v, i) => div(v, sumTr[i]!)),
    minus: rollSum(vmMinus, len).map((v, i) => div(v, sumTr[i]!)),
  };
}

export interface Aroon {
  up: number[];
  down: number[];
  oscillator: number[];
}

/**
 * Aroon: how recently the window's extreme occurred, as a percentage of the
 * window. 100 means the extreme is this bar; 0 means it is the oldest bar in
 * the window.
 */
export function aroon(high: number[], low: number[], len: number): Aroon {
  const n = high.length;
  const up = new Array<number>(n).fill(NaN);
  const down = new Array<number>(n).fill(NaN);
  if (len < 1) return { up, down, oscillator: subSeries(up, down) };
  /*
   * `length` bars, not `length + 1`.
   *
   * TradingView's built-in is `100 * (ta.highestbars(high, length) + length) /
   * length`, whose range is [100/length, 100] — it never reaches zero. The
   * classical StockCharts definition looks back over `length + 1` bars and does
   * reach zero. They are different indicators at exactly the extremes Aroon
   * exists to flag, and this product's posture is parity with the chart a user
   * is comparing against.
   */
  outer: for (let i = len - 1; i < n; i++) {
    let hiIdx = 0;
    let loIdx = 0;
    let hi = -Infinity;
    let lo = Infinity;
    for (let k = 0; k < len; k++) {
      const h = high[i - k]!;
      const l = low[i - k]!;
      if (Number.isNaN(h) || Number.isNaN(l)) continue outer;
      if (h > hi) { hi = h; hiIdx = k; }
      if (l < lo) { lo = l; loIdx = k; }
    }
    up[i] = finite(((len - hiIdx) / len) * 100);
    down[i] = finite(((len - loIdx) / len) * 100);
  }
  return { up, down, oscillator: subSeries(up, down) };
}

/**
 * Parabolic SAR.
 *
 * Genuinely stateful: the stop accelerates toward price while the trend holds
 * and flips to the other side of the recent extreme when price crosses it. The
 * clamp against the previous two bars' extremes is part of the definition, not
 * a safety measure — without it the stop can jump inside the current bar's
 * range and flip on noise.
 */
export function parabolicSar(
  high: number[], low: number[], start: number, increment: number, maximum: number
): number[] {
  const n = high.length;
  const out = new Array<number>(n).fill(NaN);
  if (n < 2) return out;
  let long = high[1]! >= high[0]!;
  let af = start;
  let extreme = long ? high[0]! : low[0]!;
  let sar = long ? low[0]! : high[0]!;
  for (let i = 1; i < n; i++) {
    const h = high[i]!;
    const l = low[i]!;
    /*
     * A gap RESTARTS the state machine rather than carrying it across.
     *
     * Skipping only the output leaves the next bar to read the na bar through
     * the two-bar clamp below, which poisons `sar` permanently: one missing bar
     * silently ends the indicator for the rest of the series.
     */
    if (Number.isNaN(h) || Number.isNaN(l)) {
      out[i] = NaN;
      sar = NaN;
      extreme = NaN;
      af = start;
      continue;
    }
    if (Number.isNaN(sar) || Number.isNaN(extreme)) {
      // Re-seed from the first clean bar after the gap. The first value is
      // still na: a stop needs a prior bar to have accelerated from.
      long = true;
      extreme = h;
      sar = l;
      out[i] = NaN;
      continue;
    }
    const prevLow = low[i - 1]!;
    const prevHigh = high[i - 1]!;
    if (Number.isNaN(prevLow) || Number.isNaN(prevHigh)) { out[i] = NaN; continue; }
    const prevLow2 = i >= 2 && !Number.isNaN(low[i - 2]!) ? low[i - 2]! : prevLow;
    const prevHigh2 = i >= 2 && !Number.isNaN(high[i - 2]!) ? high[i - 2]! : prevHigh;
    sar = sar + af * (extreme - sar);
    if (long) {
      sar = Math.min(sar, prevLow, prevLow2);
      if (l < sar) {
        long = false;
        sar = extreme;
        extreme = l;
        af = start;
      } else if (h > extreme) {
        extreme = h;
        af = Math.min(af + increment, maximum);
      }
    } else {
      sar = Math.max(sar, prevHigh, prevHigh2);
      if (h > sar) {
        long = true;
        sar = extreme;
        extreme = h;
        af = start;
      } else if (l < extreme) {
        extreme = l;
        af = Math.min(af + increment, maximum);
      }
    }
    out[i] = finite(sar);
  }
  return out;
}

export interface Ichimoku {
  conversion: number[];
  base: number[];
  /** Leading span A, UNSHIFTED. The study applies the forward displacement. */
  spanA: number[];
  /** Leading span B, UNSHIFTED. */
  spanB: number[];
  /** The close series, to be displaced BACKWARD by the study. */
  lagging: number[];
}

/**
 * Ichimoku Cloud, with every line at its natural bar.
 *
 * The displacements — spans forward, lagging span backward — are deliberately
 * NOT applied here. Shifting a series inside the maths would make the values
 * disagree with the bars they were computed from, which is exactly how a cloud
 * ends up rendered one displacement out. The study layer shifts at PLOT time,
 * where a shift is a drawing decision.
 */
export function ichimoku(
  high: number[], low: number[], close: number[],
  conversionLen: number, baseLen: number, spanBLen: number
): Ichimoku {
  const mid = (len: number): number[] =>
    zip(highest(high, len), lowest(low, len), (h, l) => (h + l) / 2);
  const conversion = mid(conversionLen);
  const base = mid(baseLen);
  return {
    conversion,
    base,
    spanA: zip(conversion, base, (c, b) => (c + b) / 2),
    spanB: mid(spanBLen),
    lagging: close.slice(),
  };
}

// ── Volume and flow ─────────────────────────────────────────────────────────

/**
 * On-Balance Volume: volume signed by the direction of the close.
 *
 * A running total, so it starts at zero on the first bar with a comparable
 * close. The absolute level is meaningless; the slope is the indicator.
 */
export function obv(close: number[], volume: number[]): number[] {
  const n = close.length;
  const out = new Array<number>(n).fill(NaN);
  let acc = 0;
  let started = false;
  for (let i = 1; i < n; i++) {
    const c = close[i]!;
    const prev = close[i - 1]!;
    const v = volume[i]!;
    if (Number.isNaN(c) || Number.isNaN(prev) || Number.isNaN(v)) {
      out[i] = started ? finite(acc) : NaN;
      continue;
    }
    if (!started) { started = true; out[i - 1] = 0; }
    acc += c > prev ? v : c < prev ? -v : 0;
    out[i] = finite(acc);
  }
  return out;
}

/**
 * Session VWAP: volume-weighted average price, reset at each session boundary.
 *
 * `sessionStart[i]` is true on the first bar of a session. The caller owns that
 * decision because a session is a calendar fact about the instrument, not a
 * property of the numbers — and for 24/7 crypto spot it is the UTC day
 * boundary, which is what the chart's own clock already uses.
 */
export function vwap(
  src: number[], volume: number[], sessionStart: boolean[]
): number[] {
  const n = src.length;
  const out = new Array<number>(n).fill(NaN);
  let pv = 0;
  let vol = 0;
  for (let i = 0; i < n; i++) {
    if (sessionStart[i]) { pv = 0; vol = 0; }
    const p = src[i]!;
    const v = volume[i]!;
    if (Number.isNaN(p) || Number.isNaN(v)) { out[i] = div(pv, vol); continue; }
    pv += p * v;
    vol += v;
    out[i] = div(pv, vol);
  }
  return out;
}

/**
 * Anchored VWAP: the same accumulation, from one chosen bar forward.
 *
 * Bars before the anchor are NaN rather than zero — the measure does not exist
 * before its anchor, and drawing a flat line there would invite the reader to
 * treat it as one.
 */
export function anchoredVwap(
  src: number[], volume: number[], anchorIndex: number
): number[] {
  const n = src.length;
  const out = new Array<number>(n).fill(NaN);
  if (anchorIndex < 0 || anchorIndex >= n) return out;
  let pv = 0;
  let vol = 0;
  for (let i = anchorIndex; i < n; i++) {
    const p = src[i]!;
    const v = volume[i]!;
    if (!Number.isNaN(p) && !Number.isNaN(v)) { pv += p * v; vol += v; }
    out[i] = div(pv, vol);
  }
  return out;
}

/**
 * The volume-weighted standard deviation of price around the anchored VWAP,
 * for the ±σ bands. NaN until there is volume to weight by.
 */
export function anchoredVwapDeviation(
  src: number[], volume: number[], anchorIndex: number
): number[] {
  const n = src.length;
  const out = new Array<number>(n).fill(NaN);
  if (anchorIndex < 0 || anchorIndex >= n) return out;
  let pv = 0;
  let pv2 = 0;
  let vol = 0;
  for (let i = anchorIndex; i < n; i++) {
    const p = src[i]!;
    const v = volume[i]!;
    if (!Number.isNaN(p) && !Number.isNaN(v)) { pv += p * v; pv2 += p * p * v; vol += v; }
    if (vol <= 0) continue;
    const mean = pv / vol;
    const varr = pv2 / vol - mean * mean;
    out[i] = varr > 0 ? finite(Math.sqrt(varr)) : 0;
  }
  return out;
}

/** Accumulation/Distribution: the money-flow multiplier, accumulated. */
export function accumulationDistribution(
  high: number[], low: number[], close: number[], volume: number[]
): number[] {
  const n = close.length;
  const out = new Array<number>(n).fill(NaN);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const h = high[i]!;
    const l = low[i]!;
    const c = close[i]!;
    const v = volume[i]!;
    if (Number.isNaN(h) || Number.isNaN(l) || Number.isNaN(c) || Number.isNaN(v)) {
      out[i] = NaN;
      continue;
    }
    // A bar with no range has no location within it to weight by.
    const mult = h === l ? 0 : ((c - l) - (h - c)) / (h - l);
    acc += mult * v;
    out[i] = finite(acc);
  }
  return out;
}

/** Chaikin Money Flow: the money-flow multiplier, averaged over a window. */
export function chaikinMoneyFlow(
  high: number[], low: number[], close: number[], volume: number[], len: number
): number[] {
  const n = close.length;
  const mfv = new Array<number>(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const h = high[i]!;
    const l = low[i]!;
    const c = close[i]!;
    const v = volume[i]!;
    if (Number.isNaN(h) || Number.isNaN(l) || Number.isNaN(c) || Number.isNaN(v)) continue;
    mfv[i] = h === l ? 0 : (((c - l) - (h - c)) / (h - l)) * v;
  }
  const sumMfv = rollSum(mfv, len);
  const sumVol = rollSum(volume, len);
  return sumMfv.map((v, i) => div(v, sumVol[i]!));
}

/** Volume Oscillator: the spread between two volume MAs, in percent. */
export function volumeOscillator(
  volume: number[], fastLen: number, slowLen: number
): number[] {
  const fast = ema(volume, fastLen);
  const slow = ema(volume, slowLen);
  return fast.map((f, i) => {
    const s = slow[i]!;
    if (Number.isNaN(f) || Number.isNaN(s) || s === 0) return NaN;
    return finite(((f - s) / s) * 100);
  });
}

/** Price Volume Trend: OBV weighted by the SIZE of the move, not just its sign. */
export function priceVolumeTrend(close: number[], volume: number[]): number[] {
  const n = close.length;
  const out = new Array<number>(n).fill(NaN);
  let acc = 0;
  let started = false;
  for (let i = 1; i < n; i++) {
    const c = close[i]!;
    const prev = close[i - 1]!;
    const v = volume[i]!;
    if (Number.isNaN(c) || Number.isNaN(prev) || Number.isNaN(v) || prev === 0) {
      out[i] = started ? finite(acc) : NaN;
      continue;
    }
    if (!started) { started = true; out[i - 1] = 0; }
    acc += ((c - prev) / prev) * v;
    out[i] = finite(acc);
  }
  return out;
}

/**
 * Volume Flow Indicator.
 *
 * Cutoff-filtered, volume-capped money flow: intrabar moves smaller than a
 * volatility-scaled threshold are ignored, and a single outsized volume bar is
 * capped so it cannot dominate the series. Both are part of the definition.
 */
export function volumeFlowIndicator(
  high: number[], low: number[], close: number[], volume: number[],
  len: number, coef: number, volumeCoef: number, smoothLen: number
): number[] {
  const n = close.length;
  const typical = hlc3(high, low, close);
  const inter = new Array<number>(n).fill(NaN);
  for (let i = 1; i < n; i++) {
    const a = typical[i]!;
    const b = typical[i - 1]!;
    if (!(a > 0) || !(b > 0)) continue;
    inter[i] = Math.log(a) - Math.log(b);
  }
  const cutoff = stdev(inter, len).map((v) => (Number.isNaN(v) ? NaN : v * coef));
  const volAvg = sma(volume, len);
  const raw = new Array<number>(n).fill(NaN);
  for (let i = 1; i < n; i++) {
    const c = cutoff[i]!;
    const avg = volAvg[i - 1];
    const move = inter[i]!;
    const v = volume[i]!;
    if (Number.isNaN(c) || avg === undefined || Number.isNaN(avg) ||
        Number.isNaN(move) || Number.isNaN(v)) {
      continue;
    }
    const capped = Math.min(v, avg * volumeCoef);
    raw[i] = move > c ? capped : move < -c ? -capped : 0;
  }
  const sumRaw = rollSum(raw, len);
  const normalised = sumRaw.map((v, i) => {
    // The PREVIOUS bar's average, matching the cap above. Katsanos's VFI uses
    // `sma(volume, length)[1]` for both; using the current bar's here made the
    // two disagree systematically whenever volume was trending.
    const avg = volAvg[i - 1];
    if (avg === undefined || Number.isNaN(v) || Number.isNaN(avg) || avg === 0) return NaN;
    return finite(v / avg);
  });
  return ema(normalised, smoothLen);
}

// ── Structure and levels ────────────────────────────────────────────────────

/*
 * Pivot levels live further down, in `pivotLevels`.
 *
 * There used to be a second implementation here — `pivotPoints`, returning a
 * fixed six levels — and the two disagreed about Woodie: this one weighted the
 * CLOSE twice, `pivotLevels` weights the OPEN, which is the definition. It was
 * dead code, imported by nothing, sitting in the file this project calls its
 * single mathematical authority. Two answers to one question in that file is
 * worse than no answer, because the next author has no way to tell which one
 * the product actually uses.
 *
 * `pivotLevels` is the survivor because it is what the alert engine fires on
 * and what the chart draws, and because its per-type level list is the honest
 * shape: Fibonacci defines three levels either side, Camarilla four,
 * Traditional five, and a fixed six forced every family into the same mould.
 */

/** The value of the least-squares fit at every point of the final window. */
export function linregLine(
  src: number[], len: number
): { start: number; end: number; slope: number; intercept: number } | null {
  const n = src.length;
  if (len < 2 || n < len) return null;
  let sumY = 0;
  let sumXY = 0;
  for (let k = 0; k < len; k++) {
    const v = src[n - len + k]!;
    if (Number.isNaN(v)) return null;
    sumY += v;
    sumXY += k * v;
  }
  const sumX = (len * (len - 1)) / 2;
  const sumX2 = ((len - 1) * len * (2 * len - 1)) / 6;
  const denom = len * sumX2 - sumX * sumX;
  if (denom === 0) return null;
  const slope = (len * sumXY - sumX * sumY) / denom;
  const intercept = sumY / len - (slope * sumX) / len;
  return { start: intercept, end: intercept + slope * (len - 1), slope, intercept };
}

/**
 * Confirmed swing points.
 *
 * A swing is only a swing once `right` bars have failed to beat it, so the
 * marker belongs at the CONFIRMATION bar and carries the price of the bar it
 * confirms. Reporting it at the pivot bar would be a claim the chart could not
 * have made at the time — the definition of lookahead.
 */
export interface SwingPoint {
  /** Index of the bar that made the extreme. */
  pivotIndex: number;
  /** Index of the bar at which it became confirmed. */
  confirmIndex: number;
  price: number;
  kind: "high" | "low";
}

export function swingPoints(
  high: number[], low: number[], left: number, right: number
): SwingPoint[] {
  const out: SwingPoint[] = [];
  const n = high.length;
  for (let p = left; p + right < n; p++) {
    const h = high[p]!;
    const l = low[p]!;
    if (!Number.isNaN(h)) {
      let isHigh = true;
      for (let k = p - left; k <= p + right && isHigh; k++) {
        if (k !== p && !(h > high[k]!)) isHigh = false;
      }
      if (isHigh) out.push({ pivotIndex: p, confirmIndex: p + right, price: h, kind: "high" });
    }
    if (!Number.isNaN(l)) {
      let isLow = true;
      for (let k = p - left; k <= p + right && isLow; k++) {
        if (k !== p && !(l < low[k]!)) isLow = false;
      }
      if (isLow) out.push({ pivotIndex: p, confirmIndex: p + right, price: l, kind: "low" });
    }
  }
  return out;
}

// ── Crossing helpers ────────────────────────────────────────────────────────

/** True at the bar where `src` crosses above the constant `level`. */
export function crossoverLevel(src: number[], level: number): boolean[] {
  const out = new Array<boolean>(src.length).fill(false);
  for (let i = 1; i < src.length; i++) {
    out[i] = src[i]! > level && src[i - 1]! <= level;
  }
  return out;
}

/** True at the bar where `src` crosses below the constant `level`. */
export function crossunderLevel(src: number[], level: number): boolean[] {
  const out = new Array<boolean>(src.length).fill(false);
  for (let i = 1; i < src.length; i++) {
    out[i] = src[i]! < level && src[i - 1]! >= level;
  }
  return out;
}

/** True at either crossing. */
export function cross(a: number[], b: number[]): boolean[] {
  const up = crossover(a, b);
  const dn = crossunder(a, b);
  return up.map((v, i) => v || dn[i]!);
}


/* ════════════════════════════════════════════════════════════════════════════
 * CANONICAL MARKET STRUCTURE
 *
 * Pivot levels and support/resistance zones, moved here VERBATIM from
 * `backend/src/engine/pivotLevels.ts` and `backend/src/engine/srZones.ts`.
 *
 * They are here for the same reason the rest of this file is: the browser must
 * draw exactly the level an alert fires on. A pivot alert says "price reached
 * Fibonacci S1"; if the chart drew S1 from a second implementation, the user
 * would be told price reached a line that is not where they can see it. The
 * engines were already pure and dependency-free, so moving them costs nothing
 * and closes the gap by construction.
 *
 * Both files now re-export from here, and the parity test asserts that by
 * reference equality — there is one implementation, not two that agree today.
 * ════════════════════════════════════════════════════════════════════════════ */

export const PIVOT_TYPES = [
  "Traditional", "Fibonacci", "Woodie", "Classic", "Camarilla",
] as const;
export type PivotType = (typeof PIVOT_TYPES)[number];

export const isPivotType = (v: string): v is PivotType =>
  (PIVOT_TYPES as readonly string[]).includes(v);

/** A completed period. */
export interface Period {
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface PivotLevel {
  /** "P", "S1"…"S5", "R1"…"R5". */
  name: string;
  price: number;
}

/**
 * The levels for one completed period, in the order a chart lists them.
 * Levels a type does not define are simply absent.
 */
export function pivotLevels(period: Period, type: PivotType): PivotLevel[] {
  const { open: o, high: h, low: l, close: c } = period;
  if (![o, h, l, c].every((v) => Number.isFinite(v))) return [];
  const range = h - l;

  const p = type === "Woodie" ? (h + l + 2 * o) / 4 : (h + l + c) / 3;
  const out: PivotLevel[] = [{ name: "P", price: p }];
  const add = (name: string, price: number): void => { out.push({ name, price }); };

  switch (type) {
    case "Fibonacci":
      // Retracements of the period's range around the pivot. No 4th or 5th.
      add("R1", p + 0.382 * range); add("S1", p - 0.382 * range);
      add("R2", p + 0.618 * range); add("S2", p - 0.618 * range);
      add("R3", p + 1.000 * range); add("S3", p - 1.000 * range);
      break;
    case "Camarilla":
      // Anchored on the close rather than the pivot.
      add("R1", c + range * 1.1 / 12); add("S1", c - range * 1.1 / 12);
      add("R2", c + range * 1.1 / 6);  add("S2", c - range * 1.1 / 6);
      add("R3", c + range * 1.1 / 4);  add("S3", c - range * 1.1 / 4);
      add("R4", c + range * 1.1 / 2);  add("S4", c - range * 1.1 / 2);
      break;
    case "Classic":
      add("R1", 2 * p - l);       add("S1", 2 * p - h);
      add("R2", p + range);       add("S2", p - range);
      add("R3", p + 2 * range);   add("S3", p - 2 * range);
      add("R4", p + 3 * range);   add("S4", p - 3 * range);
      break;
    default:
      // Traditional, and Woodie which differs only in how P is anchored.
      add("R1", 2 * p - l);               add("S1", 2 * p - h);
      add("R2", p + range);               add("S2", p - range);
      add("R3", h + 2 * (p - l));         add("S3", l - 2 * (h - p));
      add("R4", h + 3 * (p - l));         add("S4", l - 3 * (h - p));
      if (type === "Traditional") {
        add("R5", h + 4 * (p - l));       add("S5", l - 4 * (h - p));
      }
      break;
  }
  return out;
}

/** The level closest to `price`, or null when the period yields none. */
export function nearestLevel(levels: PivotLevel[], price: number): PivotLevel | null {
  let best: PivotLevel | null = null;
  let bestDist = Infinity;
  for (const lv of levels) {
    if (!Number.isFinite(lv.price)) continue;
    const d = Math.abs(lv.price - price);
    if (d < bestDist) { bestDist = d; best = lv; }
  }
  return best;
}

/** Look one level up by name, e.g. "S1". Names are case-insensitive. */
export function levelByName(levels: PivotLevel[], name: string): PivotLevel | null {
  const want = name.trim().toUpperCase();
  return levels.find((lv) => lv.name.toUpperCase() === want) ?? null;
}

// ── Support and resistance ─────────────────────────────────────────────────

export type ZoneKind = "support" | "resistance";

export interface Zone {
  kind: ZoneKind;
  /** The pivot price this zone sits at. */
  price: number;
  /** Index of the bar the pivot formed on. */
  pivotIndex: number;
  /** Index at which the pivot became knowable (`pivotIndex + length`). */
  confirmedIndex: number;
  /** Index where price closed through it, or null while it still holds. */
  brokenIndex: number | null;
  /** How many times price returned to the level without breaking it. */
  touches: number;
}

export interface SrOptions {
  /** Bars either side of a swing that must not exceed it. */
  pivotLength: number;
  /** A wick through the level, or only a close through it, invalidates. */
  invalidation: "close" | "wick";
  /** Levels within this fraction of ATR of an existing one are merged. */
  mergeAtrFraction: number;
  /** Newest N live zones of each kind are kept. */
  maxZones: number;
}

export const DEFAULT_SR_OPTIONS: SrOptions = {
  pivotLength: 15,
  invalidation: "close",
  mergeAtrFraction: 1 / 8,
  maxZones: 10,
};

export interface Bars {
  high: number[];
  low: number[];
  close: number[];
}

/** True when `high[i]` is the highest of the window `length` bars either side. */
export function isPivotHigh(high: number[], i: number, length: number): boolean {
  if (i - length < 0 || i + length >= high.length) return false;
  const v = high[i]!;
  for (let j = i - length; j <= i + length; j++) {
    if (j === i) continue;
    // `>=` on the left half and `>` on the right breaks ties toward the EARLIER
    // bar, so a flat top yields one pivot rather than one per equal bar.
    if (j < i ? high[j]! >= v : high[j]! > v) return false;
  }
  return true;
}

export function isPivotLow(low: number[], i: number, length: number): boolean {
  if (i - length < 0 || i + length >= low.length) return false;
  const v = low[i]!;
  for (let j = i - length; j <= i + length; j++) {
    if (j === i) continue;
    if (j < i ? low[j]! <= v : low[j]! < v) return false;
  }
  return true;
}

/**
 * Average true range, used only to decide when two levels are "the same".
 *
 * Deliberately NOT `atr` above: this one is seeded progressively from the
 * first bar rather than after a full window, because it is a merge tolerance
 * rather than a volatility reading, and leaving it na through the warmup
 * stacked levels a trader would read as one. The two are different functions
 * with different jobs, which is why they have different names.
 */
export function srMergeAtr(bars: Bars, length = 20): number[] {
  const out: number[] = new Array(bars.close.length).fill(NaN);
  let sum = 0;
  const trs: number[] = [];
  for (let i = 0; i < bars.close.length; i++) {
    const prevClose = i > 0 ? bars.close[i - 1]! : bars.close[i]!;
    const tr = Math.max(
      bars.high[i]! - bars.low[i]!,
      Math.abs(bars.high[i]! - prevClose),
      Math.abs(bars.low[i]! - prevClose)
    );
    trs.push(tr);
    sum += tr;
    if (i >= length) sum -= trs[i - length]!;
    out[i] = i >= length - 1 ? sum / length : sum / (i + 1);
  }
  return out;
}

/**
 * Every zone the series produced, each carrying the bar it became knowable on
 * and the bar it broke on. Computed once per feed; `zonesAsOf` then answers
 * "what was live at bar t" without recomputing.
 */
export function buildZones(bars: Bars, opts: SrOptions = DEFAULT_SR_OPTIONS): Zone[] {
  const n = bars.close.length;
  const { pivotLength: L, invalidation, mergeAtrFraction } = opts;
  const atrSeries = srMergeAtr(bars);
  const zones: Zone[] = [];

  for (let i = 0; i < n; i++) {
    const confirmedAt = i + L;
    if (confirmedAt >= n) break;

    const near = (a: number, b: number): boolean => {
      const scale = atrSeries[confirmedAt];
      // Before ATR is seeded, fall back to a relative tolerance so early bars
      // still merge sensibly instead of stacking near-identical levels.
      const tol = Number.isFinite(scale) ? scale! * mergeAtrFraction : Math.abs(b) * 0.001;
      return Math.abs(a - b) <= tol;
    };

    for (const kind of ["support", "resistance"] as ZoneKind[]) {
      const hit = kind === "support"
        ? isPivotLow(bars.low, i, L)
        : isPivotHigh(bars.high, i, L);
      if (!hit) continue;
      const price = kind === "support" ? bars.low[i]! : bars.high[i]!;

      // Merge into a live zone of the same kind at effectively the same price.
      const existing = zones.find(
        (z) => z.kind === kind && z.brokenIndex === null && near(z.price, price)
      );
      if (existing) {
        existing.touches += 1;
        continue;
      }
      zones.push({
        kind, price, pivotIndex: i, confirmedIndex: confirmedAt,
        brokenIndex: null, touches: 1,
      });
    }

    // Invalidate live zones against the bar that has just printed.
    const level = invalidation === "close" ? bars.close[i]! : null;
    for (const z of zones) {
      if (z.brokenIndex !== null || i < z.confirmedIndex) continue;
      const through = z.kind === "support"
        ? (level !== null ? level < z.price : bars.low[i]! < z.price)
        : (level !== null ? level > z.price : bars.high[i]! > z.price);
      if (through) z.brokenIndex = i;
    }
  }
  return zones;
}

/** The zones that were live and knowable at bar `index`, newest first. */
export function zonesAsOf(
  zones: Zone[], index: number, opts: SrOptions = DEFAULT_SR_OPTIONS
): Zone[] {
  return zones
    .filter((z) => z.confirmedIndex <= index && (z.brokenIndex === null || z.brokenIndex > index))
    .sort((a, b) => b.confirmedIndex - a.confirmedIndex)
    .slice(0, opts.maxZones * 2);
}

/**
 * The live zones at EVERY bar, in one forward walk.
 *
 * `zonesAsOf` answers the question for one bar, and answering it in a loop is
 * quadratic: a full `filter` plus a `sort` over every zone the series ever
 * produced, for every bar, re-derived from scratch on each tick. At the
 * product's default ten thousand bars that measured 53 ms per tick — several
 * dropped frames a second while a tick stream is live — and it grew
 * super-linearly beyond that.
 *
 * The observation that removes it: as the bar index advances, the live set
 * only gains zones (at their confirmation bar) and loses zones (at the bar
 * they break on). So it can be carried forward instead of rebuilt, and the
 * per-bar cost becomes the cap rather than the history.
 *
 * The output is deliberately identical to calling `zonesAsOf` per bar,
 * including the newest-first ordering and the `maxZones * 2` cap — the caller
 * is choosing which levels to DRAW, and a different set would be a different
 * chart, not a faster one.
 */
export function zonesAsOfSeries(
  zones: readonly Zone[], barCount: number, opts: SrOptions = DEFAULT_SR_OPTIONS
): Zone[][] {
  const cap = Math.max(0, opts.maxZones * 2);
  const out: Zone[][] = new Array(barCount);
  if (barCount <= 0) return out;

  // Confirmations grouped by the bar they happen on, so a bar's arrivals are
  // added as a batch — `zonesAsOf`'s sort is stable, so zones confirmed on the
  // same bar keep the order `buildZones` produced them in.
  const arriving = new Map<number, Zone[]>();
  for (const zone of zones) {
    if (zone.brokenIndex !== null && zone.brokenIndex <= zone.confirmedIndex) continue;
    const at = zone.confirmedIndex;
    if (at >= barCount) continue;
    const batch = arriving.get(at);
    if (batch) batch.push(zone); else arriving.set(at, [zone]);
  }

  // Newest first, which is the order `zonesAsOf` sorts into.
  let live: Zone[] = [];
  for (let i = 0; i < barCount; i++) {
    const born = arriving.get(i);
    if (born) live = [...born].reverse().concat(live);
    // A zone that broke on an earlier bar is not live at this one:
    // `zonesAsOf` keeps only `brokenIndex === null || brokenIndex > index`.
    if (live.some((z) => z.brokenIndex !== null && z.brokenIndex <= i)) {
      live = live.filter((z) => z.brokenIndex === null || z.brokenIndex > i);
    }
    out[i] = live.length > cap ? live.slice(0, cap) : live;
  }
  return out;
}

/**
 * The nearest live support at or below `price`, and the nearest live
 * resistance at or above it.
 *
 * "Nearest support" deliberately means the closest one BELOW: a support that
 * price has already risen far above is not what a trader means by the level
 * they are approaching, and one above current price has been broken.
 */
export function nearestZones(
  zones: Zone[], index: number, price: number, opts: SrOptions = DEFAULT_SR_OPTIONS
): { support: Zone | null; resistance: Zone | null } {
  const live = zonesAsOf(zones, index, opts);
  let support: Zone | null = null;
  let resistance: Zone | null = null;
  for (const z of live) {
    if (z.kind === "support" && z.price <= price) {
      if (!support || z.price > support.price) support = z;
    } else if (z.kind === "resistance" && z.price >= price) {
      if (!resistance || z.price < resistance.price) resistance = z;
    }
  }
  return { support, resistance };
}

// ── Support & Resistance (MTF) | Flux Charts: one timeframe's levels ───────

/**
 * The level list of the Flux Charts "Support & Resistance (MTF)" script
 * (S&R V2.12) on one timeframe: its detection and break/strength/retest blocks,
 * line for line. The chart study (`lib/native/fluxSr.ts`) draws from this, and
 * the `sr_touch` alert gate reads it, so the support an alert names is the
 * zone the chart shows.
 */
export const FLUX_SR = {
  maxInfo: 10,
  maxDistanceToLastBar: 500,
  tooCloseAtr: 1 / 8,
  atrLength: 20,
} as const;

export interface FluxSrConfig {
  pivotLength: number;
  strength: number;
  invalidation: "Wick" | "Close";
  avoidFalseBreaks: boolean;
  breakVolumeThreshold: number;
  inverseBrokenLineColor: boolean;
}

export const FLUX_SR_DEFAULTS: FluxSrConfig = {
  pivotLength: 15, strength: 1, invalidation: "Close",
  avoidFalseBreaks: false, breakVolumeThreshold: 0.3, inverseBrokenLineColor: false,
};

export interface FluxSrBar { time: number; high: number; low: number; close: number; volume: number }

export interface FluxSrInfo {
  startTime: number;
  price: number;
  srType: "Support" | "Resistance";
  strength: number;
  tf: string;
  ephemeral: boolean;
  /** NaN while unbroken — Pine's `na`. */
  breakTime: number;
  /** Newest first. */
  retestTimes: number[];
  /** Bar index (in this context's bars) the level entered the list on. */
  addedIndex: number;
}

/** `allSRInfoList` on one timeframe. `step(i)` advances to bar i. */
export class FluxSrContext {
  readonly list: FluxSrInfo[] = [];
  private readonly atr: number[];
  private readonly avgVolume: number[];
  private readonly ph: number[];
  private readonly pl: number[];

  constructor(
    private readonly bars: readonly FluxSrBar[],
    private readonly opts: FluxSrConfig,
    private readonly tf: string,
  ) {
    const high = bars.map((b) => b.high);
    const low = bars.map((b) => b.low);
    const close = bars.map((b) => b.close);
    this.atr = atr(high, low, close, FLUX_SR.atrLength);
    this.avgVolume = sma(bars.map((b) => b.volume), FLUX_SR.atrLength);
    this.ph = pivothigh(high, opts.pivotLength, opts.pivotLength);
    this.pl = pivotlow(low, opts.pivotLength, opts.pivotLength);
  }

  step(i: number, confirmed: boolean): void {
    const { opts } = this;
    const b = this.bars[i]!;
    const n = this.bars.length;
    const insideBounds = i > n - 1 - FLUX_SR.maxDistanceToLastBar;
    const atrNow = this.atr[i]!;
    const pivotLow = this.pl[i]!;
    const pivotHigh = this.ph[i]!;
    const len = opts.pivotLength;
    const add = (price: number, srType: FluxSrInfo["srType"]): void => {
      this.list.unshift({
        startTime: this.bars[i - len]!.time, price, srType, strength: 1,
        tf: this.tf, ephemeral: false, breakTime: NaN, retestTimes: [], addedIndex: i,
      });
    };

    if (insideBounds && confirmed) {
      if (!Number.isNaN(pivotLow)) {
        let valid = true;
        for (const cur of this.list) {
          if (Math.abs(cur.price - pivotLow) < atrNow * FLUX_SR.tooCloseAtr && Number.isNaN(cur.breakTime)) {
            valid = false;
            break;
          }
        }
        if (valid && i - len >= 0) {
          add(pivotLow, "Support");
          while (this.list.length > FLUX_SR.maxInfo) this.list.pop();
        }
      }
      if (!Number.isNaN(pivotHigh)) {
        let valid = true;
        for (const cur of this.list) {
          // The published script compares against pivotLow here, not pivotHigh.
          if (Math.abs(cur.price - pivotLow) < atrNow * FLUX_SR.tooCloseAtr && Number.isNaN(cur.breakTime)) {
            valid = false;
            break;
          }
        }
        if (valid && i - len >= 0) {
          add(pivotHigh, "Resistance");
          if (this.list.length > FLUX_SR.maxInfo) this.list.pop();
        }
      }
    }

    if (insideBounds && (opts.invalidation === "Wick" || confirmed)) {
      const invHigh = opts.invalidation === "Close" ? b.close : b.high;
      const invLow = opts.invalidation === "Close" ? b.close : b.low;
      const volumeOk = !opts.avoidFalseBreaks
        || b.volume > this.avgVolume[i]! * opts.breakVolumeThreshold;
      const flip = (cur: FluxSrInfo, srType: FluxSrInfo["srType"]): void => {
        if (opts.inverseBrokenLineColor && !cur.ephemeral && cur.strength >= opts.strength) {
          this.list.unshift({
            startTime: b.time, price: cur.price, srType, strength: cur.strength,
            tf: cur.tf, ephemeral: true, breakTime: NaN, retestTimes: [], addedIndex: i,
          });
        }
      };
      for (const cur of [...this.list]) {
        if (Number.isNaN(cur.breakTime)) {
          if (cur.srType === "Resistance" && invHigh > cur.price) {
            if (volumeOk) { cur.breakTime = b.time; flip(cur, "Support"); }
          } else if (cur.srType === "Support" && invLow < cur.price) {
            if (volumeOk) { cur.breakTime = b.time; flip(cur, "Resistance"); }
          }
        }
        if (Number.isNaN(cur.breakTime) && b.time > cur.startTime && confirmed) {
          const touches = cur.srType === "Resistance"
            ? b.high >= cur.price && b.close <= cur.price
            : b.low <= cur.price && b.close >= cur.price;
          if (touches) {
            const last = cur.retestTimes[0] ?? 0;
            if (last !== b.time) {
              if (!cur.ephemeral) cur.strength += 1;
              cur.retestTimes.unshift(b.time);
            }
          }
        }
      }
    }
  }
}

/**
 * Whether price recently retested a live Flux support and bounced (or a live
 * Flux resistance and was rejected), as of the LAST bar of `bars`.
 *
 * A retest is the script's own: a bar whose wick reached the level and whose
 * close held on the near side of it — the bar the chart marks "R". With
 * `tolerancePct` above 0 a wick that stopped that close short of the level
 * counts too. The level must be one the chart shows (strength at least the
 * configured Strength), still unbroken now, with price on its near side, and
 * the touch must be within the last `lookback` bars and no earlier than the
 * bar the level appeared on. The most recent touch wins.
 */
export function fluxSrTouchBounce(
  bars: readonly FluxSrBar[], opts: FluxSrConfig, kind: "support" | "resistance",
  lookback: number, tolerancePct: number,
): { price: number; touchIndex: number } | null {
  const n = bars.length;
  if (n === 0) return null;
  const ctx = new FluxSrContext(bars, opts, "");
  for (let i = 0; i < n; i++) ctx.step(i, true);
  const tol = tolerancePct / 100;
  const last = n - 1;
  const now = bars[last]!.close;
  const want = kind === "support" ? "Support" : "Resistance";
  let best: { price: number; touchIndex: number } | null = null;
  for (const lv of ctx.list) {
    if (lv.srType !== want || !Number.isNaN(lv.breakTime) || lv.strength < opts.strength) continue;
    if (want === "Support" ? now < lv.price : now > lv.price) continue;
    const from = Math.max(lv.addedIndex, last - lookback + 1, 0);
    for (let j = last; j >= from; j--) {
      const b = bars[j]!;
      if (!(b.time > lv.startTime)) break;
      const touched = want === "Support"
        ? b.low <= lv.price * (1 + tol) && b.close >= lv.price
        : b.high >= lv.price * (1 - tol) && b.close <= lv.price;
      if (touched) {
        if (!best || j > best.touchIndex) best = { price: lv.price, touchIndex: j };
        break;
      }
    }
  }
  return best;
}

/* ════════════════════════════════════════════════════════════════════════════
 * COMPARE AND SECOND-SERIES MATHS
 *
 * Two-series concepts, kept here rather than in a study because the alignment
 * rule is the hard part and it must be identical wherever it is used.
 * ════════════════════════════════════════════════════════════════════════════ */

/**
 * Align a second series onto a base series by OPEN TIME.
 *
 * Never by index. Two instruments can have different histories — a newer
 * listing, an exchange outage, a pair that does not trade a particular
 * minute — and lining them up by position would compare Tuesday's BTC against
 * Monday's SOL and call the result a correlation. Bars the second series does
 * not have become `na` rather than being forward-filled: an invented price is
 * a fabricated observation, and a correlation computed against fabrications is
 * a number with no meaning that looks exactly like one that has meaning.
 */
export function alignByOpenTime(
  baseTimes: readonly number[],
  otherTimes: readonly number[],
  otherValues: readonly number[]
): number[] {
  const byTime = new Map<number, number>();
  for (let i = 0; i < otherTimes.length && i < otherValues.length; i++) {
    byTime.set(otherTimes[i]!, otherValues[i]!);
  }
  return baseTimes.map((t) => {
    const v = byTime.get(t);
    return v === undefined ? NaN : v;
  });
}

/**
 * Both series rebased to 0 % at the first bar where BOTH have a value.
 *
 * Rebasing each at its own first value would start them at different points in
 * time and make the whole comparison a lie about which outperformed. The
 * reference is the first COMMON bar, and everything before it is `na`.
 */
export function normalizedCompare(
  base: readonly number[], other: readonly number[]
): { base: number[]; other: number[]; referenceIndex: number } {
  const n = Math.min(base.length, other.length);
  let ref = -1;
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(base[i]!) && base[i]! > 0
      && Number.isFinite(other[i]!) && other[i]! > 0) { ref = i; break; }
  }
  const outBase = new Array<number>(base.length).fill(NaN);
  const outOther = new Array<number>(other.length).fill(NaN);
  if (ref < 0) return { base: outBase, other: outOther, referenceIndex: -1 };
  const b0 = base[ref]!;
  const o0 = other[ref]!;
  for (let i = ref; i < base.length; i++) {
    const v = base[i]!;
    if (Number.isFinite(v)) outBase[i] = (v / b0 - 1) * 100;
  }
  for (let i = ref; i < other.length; i++) {
    const v = other[i]!;
    if (Number.isFinite(v)) outOther[i] = (v / o0 - 1) * 100;
  }
  return { base: outBase, other: outOther, referenceIndex: ref };
}

// ── Auto Fib Retracement ────────────────────────────────────────────────────

/**
 * One confirmed swing of the zig-zag Auto Fib draws its levels from.
 *
 * `start` is the previous pivot and `end` the latest; a leg is `isHigh` when
 * it ENDS on a high. `index` is the pivot bar's position in the input arrays.
 */
export interface ZigZagPoint { index: number; price: number }
export interface ZigZagLeg { start: ZigZagPoint; end: ZigZagPoint; isHigh: boolean }

/**
 * TradingView's `ZigZag/7` library, as "Auto fib retracement" drives it.
 *
 * Ported from the library's behaviour rather than approximated, because the
 * chart and the alert must agree on WHICH swing is being retraced, and a zig-zag
 * is path-dependent — one differently-classified pivot changes every leg after.
 *
 *  - The pivot window is `max(2, floor(depth / 2))` bars on EACH side: a high
 *    at bar `c` needs every newer bar's high `<=` it and every older bar's high
 *    strictly `<` it (Pine's `findPivotPoint`), and is only knowable `window`
 *    bars later. That delay is what keeps it free of lookahead.
 *  - The threshold is re-set every bar BEFORE the update, exactly as the
 *    script does: `ATR(10) / close * 100 * deviation`, in percent.
 *  - A pivot in the SAME direction as the last leg's end replaces that end when
 *    it is more extreme; an OPPOSITE pivot starts a new leg only when it moved at
 *    least the threshold from the last end. During ATR warm-up the threshold is
 *    NaN, every comparison is false, and no reversal is taken — as in Pine.
 *  - Highs are tried before lows on the same bar (`allowZigZagOnOneBar`).
 *
 * Returns every leg; Auto Fib reads only the last. Fewer than two legs is
 * "not enough data", the case the script reports with `runtime.error`.
 */
export function zigZagLegs(
  high: readonly number[], low: readonly number[], close: readonly number[],
  deviation: number, depth: number, atrLength = 10,
): ZigZagLeg[] {
  const n = close.length;
  const w = Math.max(2, Math.floor(depth / 2));
  const atrs = atr(high as number[], low as number[], close as number[], atrLength);
  const legs: ZigZagLeg[] = [];

  const pivotAt = (src: readonly number[], i: number, isHigh: boolean): ZigZagPoint | null => {
    if (w * 2 > i) return null;
    const c = i - w;
    const p = src[c]!;
    if (!Number.isFinite(p)) return null;
    for (let k = 0; k < w; k++) {
      const v = src[i - k]!;
      if (isHigh ? v > p : v < p) return null;
    }
    for (let k = w + 1; k <= 2 * w; k++) {
      const v = src[i - k]!;
      if (isHigh ? v >= p : v <= p) return null;
    }
    return { index: c, price: p };
  };

  const found = (isHigh: boolean, point: ZigZagPoint, threshold: number): void => {
    const last = legs[legs.length - 1];
    if (!last) { legs.push({ start: point, end: point, isHigh }); return; }
    if (last.isHigh === isHigh) {
      if (isHigh ? point.price > last.end.price : point.price < last.end.price) last.end = point;
      return;
    }
    const dev = 100 * (point.price - last.end.price) / Math.abs(last.end.price);
    if ((!last.isHigh && dev >= threshold) || (last.isHigh && dev <= -threshold)) {
      legs.push({ start: last.end, end: point, isHigh });
    }
  };

  for (let i = 0; i < n; i++) {
    const threshold = (atrs[i]! / close[i]!) * 100 * deviation;
    const h = pivotAt(high, i, true);
    if (h) found(true, h, threshold);
    const l = pivotAt(low, i, false);
    if (l) found(false, l, threshold);
  }
  return legs;
}

/** The anchor of an Auto Fib drawing: the swing it retraces. */
export interface AutoFib {
  leg: ZigZagLeg;
  /** Price of level 0. */
  startPrice: number;
  /** Signed distance from level 0 to level 1. */
  height: number;
}

/**
 * The script's `update()`: the latest leg, oriented, or null when there are
 * fewer than two legs. Level `m` sits at `startPrice + height * m`.
 *
 * Not reversed, level 0 is the swing's END (the most recent pivot) and 1 its
 * start — a leg up from 100 to 200 puts 0 at 200, 1 at 100 and 0.618 at 138.2.
 */
export function autoFib(
  high: readonly number[], low: readonly number[], close: readonly number[],
  deviation: number, depth: number, reverse = false,
): AutoFib | null {
  const legs = zigZagLegs(high, low, close, deviation, depth);
  if (legs.length < 2) return null;
  const leg = legs[legs.length - 1]!;
  const startPrice = reverse ? leg.start.price : leg.end.price;
  const endPrice = reverse ? leg.end.price : leg.start.price;
  const height = (startPrice > endPrice ? -1 : 1) * Math.abs(startPrice - endPrice);
  return { leg, startPrice, height };
}

export const autoFibLevelPrice = (fib: AutoFib, level: number): number =>
  fib.startPrice + fib.height * level;

/**
 * The levels the indicator offers, in the script's order, with the defaults
 * the owner's own chart uses: on for 0 through 1 (bar 0.65), off for the
 * extensions and the negatives.
 */
export const AUTO_FIB_LEVELS: readonly { value: number; on: boolean }[] = [
  { value: -0.65, on: false }, { value: -0.618, on: false },
  { value: -0.382, on: false }, { value: -0.236, on: false },
  { value: 0, on: true }, { value: 0.236, on: true }, { value: 0.382, on: true },
  { value: 0.5, on: true }, { value: 0.618, on: true }, { value: 0.65, on: false },
  { value: 0.786, on: true }, { value: 1, on: true },
  { value: 1.272, on: false }, { value: 1.414, on: false },
  { value: 1.618, on: false }, { value: 1.65, on: false },
  { value: 2.618, on: false }, { value: 2.65, on: false },
  { value: 3.618, on: false }, { value: 3.65, on: false },
  { value: 4.236, on: false }, { value: 4.618, on: false },
];

/** The owner's chart settings: Deviation 3, Depth 30. */
export const AUTO_FIB_DEFAULTS = { deviation: 3, depth: 30, reverse: false } as const;

// ── Market Structure Break & Order Block (EmreKb "MSB-OB") ─────────────────
//
// A port of the published Pine v5 script, statement for statement, because the
// chart draws with it and the alert runner fires on it: the two must be one
// computation. Its quirks are kept on purpose — they are what TradingView
// shows:
//   - the zig-zag point arrays start with five `na` entries;
//   - a broken zone SHIFTS THE OLDEST entry out of its list, not the broken
//     one (so the first five breaks pop the `na` placeholders);
//   - a bullish zone is not extended on bars where price sits inside it;
//   - the bearish order block tests "above the top" and "above the bottom"
//     independently (no `else`), as the script does.

export type MsbZoneKind = "bu_ob" | "be_ob" | "bu_bb" | "be_bb";

export interface MsbZone {
  id: number;
  kind: MsbZoneKind;
  /** "Bu-OB", "Be-OB", "Bu-BB"/"Bu-MB", "Be-BB"/"Be-MB". */
  text: string;
  left: number;
  top: number;
  bottom: number;
  /** Bar index of the right edge as last set. */
  right: number;
  created: number;
  /** Bar on which the zone was shifted out of its list (broken), or null. */
  removed: number | null;
}

export interface MsbBreak {
  /** Bar the structure broke on. */
  index: number;
  /** +1 bullish (MSB up), -1 bearish. */
  direction: 1 | -1;
  /** The broken level, drawn from `x1` to `x2`. */
  price: number;
  x1: number;
  x2: number;
  /** Where the "MSB" label sits. */
  labelX: number;
}

export interface MsbZoneHit {
  index: number;
  zoneId: number;
  kind: MsbZoneKind;
  top: number;
  bottom: number;
}

export interface MarketStructure {
  /** +1 / -1 market state per bar. */
  market: number[];
  /** Zig-zag segments, in bar-index coordinates. */
  zigzag: { x1: number; y1: number; x2: number; y2: number }[];
  breaks: MsbBreak[];
  zones: MsbZone[];
  /** Every bar a zone reported "price in zone" — the script's `alert()` calls. */
  hits: MsbZoneHit[];
}

export const MSB_DEFAULTS = { zigzagLength: 9, fibFactor: 0.33 } as const;

export function marketStructure(
  open: number[], high: number[], low: number[], close: number[],
  zigzagLength: number, fibFactor: number,
): MarketStructure {
  const n = close.length;
  const len = Math.max(1, Math.floor(zigzagLength));
  const hh = highest(high, len);
  const ll = lowest(low, len);
  const toUp = high.map((h, i) => h >= hh[i]!);
  const toDown = low.map((l, i) => l <= ll[i]!);

  // ta.barssince(cond) with cond evaluated per bar.
  const sinceLast = (cond: (i: number) => boolean): number[] => {
    const out = new Array<number>(n).fill(NaN);
    let last = -1;
    for (let i = 0; i < n; i++) {
      if (cond(i)) last = i;
      out[i] = last < 0 ? NaN : i - last;
    }
    return out;
  };
  const upSince = sinceLast((i) => i > 0 && toUp[i - 1]!);
  const downSince = sinceLast((i) => i > 0 && toDown[i - 1]!);
  // ta.lowest / ta.highest with a per-bar length; na until the window fits.
  const windowExtreme = (src: number[], lens: number[], max: boolean): number[] =>
    src.map((_, i) => {
      const L = lens[i]!;
      if (i - L + 1 < 0) return NaN;
      let v = src[i]!;
      for (let k = i - L + 1; k <= i; k++) v = max ? Math.max(v, src[k]!) : Math.min(v, src[k]!);
      return v;
    });
  const lenOf = (since: number[]) => since.map((s) => (s > 0 ? s : 1));
  const lowVal = windowExtreme(low, lenOf(upSince), false);
  const highVal = windowExtreme(high, lenOf(downSince), true);
  const lastTrue = (cond: (i: number) => boolean): number[] => {
    const out = new Array<number>(n).fill(NaN);
    let last = NaN;
    for (let i = 0; i < n; i++) { if (cond(i)) last = i; out[i] = last; }
    return out;
  };
  const lowIndex = lastTrue((i) => low[i] === lowVal[i]);
  const highIndex = lastTrue((i) => high[i] === highVal[i]);

  const highPts: number[] = [NaN, NaN, NaN, NaN, NaN];
  const highIdx: number[] = [NaN, NaN, NaN, NaN, NaN];
  const lowPts: number[] = [NaN, NaN, NaN, NaN, NaN];
  const lowIdx: number[] = [NaN, NaN, NaN, NaN, NaN];
  const at = (a: number[], k: number): number => a[a.length - 1 - k] ?? NaN;

  const out: MarketStructure = { market: new Array<number>(n).fill(1), zigzag: [], breaks: [], zones: [], hits: [] };
  const l0iHist: number[] = new Array<number>(n).fill(NaN);
  const h0iHist: number[] = new Array<number>(n).fill(NaN);
  let trend = 1;
  let market = 1;
  let lastL0 = NaN, lastH0 = NaN;
  let buOb = 0, beOb = 0, buBb = 0, beBb = 0;
  let zoneId = 0;
  type Slot = MsbZone | null;
  const lists: Record<MsbZoneKind, Slot[]> = {
    bu_ob: [null, null, null, null, null], be_ob: [null, null, null, null, null],
    bu_bb: [null, null, null, null, null], be_bb: [null, null, null, null, null],
  };
  const bearish = (k: number) => k >= 0 && k < n && open[k]! > close[k]!;
  const bullish = (k: number) => k >= 0 && k < n && open[k]! < close[k]!;
  // `for i = a to b` (either direction); the LAST match in iteration order wins.
  const lastMatch = (a: number, b: number, test: (k: number) => boolean, carry: number): number => {
    if (!Number.isFinite(a) || !Number.isFinite(b)) return carry;
    let found = carry;
    const step = a <= b ? 1 : -1;
    for (let k = a; step > 0 ? k <= b : k >= b; k += step) if (test(k)) found = k;
    return found;
  };

  for (let i = 0; i < n; i++) {
    const prevTrend = trend;
    if (trend === 1 && toDown[i]) trend = -1;
    else if (trend === -1 && toUp[i]) trend = 1;
    const trendChanged = i > 0 && trend !== prevTrend;
    if (trendChanged) {
      if (trend === 1) { lowPts.push(lowVal[i]!); lowIdx.push(lowIndex[i]!); }
      else { highPts.push(highVal[i]!); highIdx.push(highIndex[i]!); }
    }
    const h0 = at(highPts, 0), h0i = at(highIdx, 0), h1 = at(highPts, 1), h1i = at(highIdx, 1);
    const l0 = at(lowPts, 0), l0i = at(lowIdx, 0), l1 = at(lowPts, 1), l1i = at(lowIdx, 1);
    l0iHist[i] = l0i;
    h0iHist[i] = h0i;

    if (trendChanged) {
      const seg = trend === 1 ? { x1: h0i, y1: h0, x2: l0i, y2: l0 } : { x1: l0i, y1: l0, x2: h0i, y2: h0 };
      if ([seg.x1, seg.y1, seg.x2, seg.y2].every(Number.isFinite)) out.zigzag.push(seg);
    }

    /*
     * `last_l0 = ta.valuewhen(ta.change(market) != 0, l0, 0)` runs BEFORE this
     * bar's market is decided, so `ta.change` sees the value passed to it —
     * last bar's final market — against the one passed the bar before. It
     * fires the bar AFTER a break, and the guard then holds the market until
     * both a new low and a new high pivot exist: without it the market would
     * flip back and forth on every bar over the same two pivots.
     */
    if (i >= 2 && out.market[i - 1] !== out.market[i - 2]) { lastL0 = l0; lastH0 = h0; }
    const prevMarket = market;
    if (!(lastL0 === l0 || lastH0 === h0)) {
      if (market === 1 && l0 < l1 && l0 < l1 - Math.abs(h0 - l1) * fibFactor) market = -1;
      else if (market === -1 && h0 > h1 && h0 > h1 + Math.abs(h1 - l0) * fibFactor) market = 1;
    }
    out.market[i] = market;

    const lagged = (hist: number[]) => (i - len >= 0 ? hist[i - len]! : NaN);
    buOb = lastMatch(h1i, lagged(l0iHist), bearish, i === 0 ? 0 : buOb);
    beOb = lastMatch(l1i, lagged(h0iHist), bullish, i === 0 ? 0 : beOb);
    beBb = lastMatch(h1i - len, l1i, bearish, i === 0 ? 0 : beBb);
    buBb = lastMatch(l1i - len, h1i, bullish, i === 0 ? 0 : buBb);

    if (market !== prevMarket) {
      const zone = (kind: MsbZoneKind, k: number, text: string): MsbZone => ({
        id: ++zoneId, kind, text, left: k, top: high[k] ?? NaN, bottom: low[k] ?? NaN,
        right: i + 10, created: i, removed: null,
      });
      if (market === 1) {
        out.breaks.push({ index: i, direction: 1, price: h1, x1: h1i, x2: h0i, labelX: Math.trunc((h1i + l0i) / 2) });
        const a = zone("bu_ob", buOb, "Bu-OB");
        const b = zone("bu_bb", buBb, l0 < l1 ? "Bu-BB" : "Bu-MB");
        out.zones.push(a, b);
        lists.bu_ob.push(a);
        lists.bu_bb.push(b);
      } else {
        out.breaks.push({ index: i, direction: -1, price: l1, x1: l1i, x2: l0i, labelX: Math.trunc((l1i + h0i) / 2) });
        const a = zone("be_ob", beOb, "Be-OB");
        const b = zone("be_bb", beBb, h0 > h1 ? "Be-BB" : "Be-MB");
        out.zones.push(a, b);
        lists.be_ob.push(a);
        lists.be_bb.push(b);
      }
    }

    const c = close[i]!;
    const shift = (kind: MsbZoneKind): void => {
      const gone = lists[kind].shift();
      if (gone && gone.removed === null) gone.removed = i;
    };
    const hit = (z: MsbZone): void => {
      out.hits.push({ index: i, zoneId: z.id, kind: z.kind, top: z.top, bottom: z.bottom });
    };
    for (const z of [...lists.bu_ob]) {
      if (!z) continue;
      if (c < z.bottom) shift("bu_ob");
      else if (c < z.top) hit(z);
      else z.right = i + 10;
    }
    for (const z of [...lists.be_ob]) {
      if (!z) continue;
      if (c > z.top) shift("be_ob");
      if (c > z.bottom) hit(z);
      else z.right = i + 10;
    }
    for (const z of [...lists.be_bb]) {
      if (!z) continue;
      if (c > z.top) shift("be_bb");
      else if (c > z.bottom) hit(z);
      else z.right = i + 10;
    }
    for (const z of [...lists.bu_bb]) {
      if (!z) continue;
      if (c < z.bottom) shift("bu_bb");
      else if (c < z.top) hit(z);
      else z.right = i + 10;
    }
  }
  return out;
}

/** Which zones an order-block alert watches. */
export type ObZoneChoice = MsbZoneKind | "bullish" | "bearish" | "any";

const zoneMatches = (choice: ObZoneChoice, kind: MsbZoneKind): boolean =>
  choice === "any" || choice === kind
  || (choice === "bullish" && (kind === "bu_ob" || kind === "bu_bb"))
  || (choice === "bearish" && (kind === "be_ob" || kind === "be_bb"));

/**
 * The zone price ENTERED on bar `i`: one reporting "price in zone" on `i`
 * that did not on `i - 1`. The script's own `alert()` repeats on every bar
 * inside a zone; a notification that repeats every bar is noise, so the
 * alert fires on entry.
 */
export function enteredZone(ms: MarketStructure, i: number, choice: ObZoneChoice): MsbZoneHit | null {
  const before = new Set(ms.hits.filter((h) => h.index === i - 1).map((h) => h.zoneId));
  return ms.hits.find((h) => h.index === i && !before.has(h.zoneId) && zoneMatches(choice, h.kind)) ?? null;
}

// ── Liquidity Swings [LuxAlgo] ──────────────────────────────────────────────
//
// The published Pine v5 script's state machine: each confirmed pivot high
// (low) opens a swing level at the pivot bar's high (low) and an area down to
// its body top (or its low, with "Full Range"); the level stays live until a
// close beyond it, and each later bar overlapping the area adds to its count
// and volume. Intrabar precision (lower-timeframe volume) is not part of this
// port: counts use the chart's own bars.

export type SwingArea = "wick" | "full";

export interface LiquiditySwing {
  side: "high" | "low";
  /** Bar the pivot is at (n − length when it is confirmed). */
  x: number;
  confirmed: number;
  /** The level: the pivot's high (swing high) or low (swing low). */
  level: number;
  /** The area's other edge. */
  edge: number;
  /** Bar a close crossed the level, or null while live. */
  crossed: number | null;
  /** Overlapping bars and their volume, as of the last bar the swing was current. */
  count: number;
  volume: number;
  /** Count at each bar while current — for the area's width and the filter crossover. */
  countAt: Map<number, number>;
  volumeAt: Map<number, number>;
}

export interface LiquiditySwingsResult {
  swings: LiquiditySwing[];
  /** The live (uncrossed) level at the START of each bar: what price is approaching. */
  liveHigh: number[];
  liveLow: number[];
}

export const LIQUIDITY_SWING_DEFAULTS = { length: 20, area: "full" as SwingArea } as const;

export function liquiditySwings(
  open: number[], high: number[], low: number[], close: number[], volume: number[],
  length: number, area: SwingArea,
): LiquiditySwingsResult {
  const n = close.length;
  const L = Math.max(1, Math.floor(length));
  const ph = pivothigh(high, L, L);
  const pl = pivotlow(low, L, L);
  const swings: LiquiditySwing[] = [];
  const liveHigh = new Array<number>(n).fill(NaN);
  const liveLow = new Array<number>(n).fill(NaN);
  let top: LiquiditySwing | null = null;
  let btm: LiquiditySwing | null = null;
  let topCount = 0, topVol = 0, btmCount = 0, btmVol = 0;

  for (let i = 0; i < n; i++) {
    liveHigh[i] = top && top.crossed === null ? top.level : NaN;
    liveLow[i] = btm && btm.crossed === null ? btm.level : NaN;
    const k = i - L;

    // get_counts(ph, ph_top, ph_btm) — before this bar's pivot is applied.
    if (!Number.isNaN(ph[i]!)) { topCount = 0; topVol = 0; }
    else if (top && k >= 0) {
      const inside = low[k]! < top.level && high[k]! > top.edge;
      topVol += inside ? volume[k]! : 0;
      topCount += inside ? 1 : 0;
    }
    if (!Number.isNaN(ph[i]!) && k >= 0) {
      top = {
        side: "high", x: k, confirmed: i, level: high[k]!,
        edge: area === "full" ? low[k]! : Math.max(close[k]!, open[k]!),
        crossed: null, count: 0, volume: 0, countAt: new Map(), volumeAt: new Map(),
      };
      swings.push(top);
    } else if (top && top.crossed === null && close[i]! > top.level) {
      top.crossed = i;
    }
    if (top) {
      top.count = topCount; top.volume = topVol;
      top.countAt.set(i, topCount); top.volumeAt.set(i, topVol);
    }

    if (!Number.isNaN(pl[i]!)) { btmCount = 0; btmVol = 0; }
    else if (btm && k >= 0) {
      const inside = low[k]! < btm.edge && high[k]! > btm.level;
      btmVol += inside ? volume[k]! : 0;
      btmCount += inside ? 1 : 0;
    }
    if (!Number.isNaN(pl[i]!) && k >= 0) {
      btm = {
        side: "low", x: k, confirmed: i, level: low[k]!,
        edge: area === "full" ? high[k]! : Math.min(close[k]!, open[k]!),
        crossed: null, count: 0, volume: 0, countAt: new Map(), volumeAt: new Map(),
      };
      swings.push(btm);
    } else if (btm && btm.crossed === null && close[i]! < btm.level) {
      btm.crossed = i;
    }
    if (btm) {
      btm.count = btmCount; btm.volume = btmVol;
      btm.countAt.set(i, btmCount); btm.volumeAt.set(i, btmVol);
    }
  }
  return { swings, liveHigh, liveLow };
}
