/**
 * Pine-exact technical-analysis primitives over full arrays.
 *
 * Conventions mirrored from Pine Script:
 *   - `na` is represented as NaN. Comparisons with NaN are false in JS exactly
 *     as na-comparisons are falsy in Pine conditions.
 *   - sma/wma/highest/lowest return NaN until a full window of non-NaN values
 *     exists; ema/rma seed with the SMA of the first full window (Wilder-style)
 *     and recurse from there.
 *   - pivothigh/pivotlow confirm `right` bars after the pivot bar and place the
 *     pivot PRICE at the confirmation bar (like `ta.pivotlow(len, len)` used
 *     with `ta.valuewhen`).
 */

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
