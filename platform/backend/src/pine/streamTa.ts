/**
 * Streaming state for the *recursive* TA functions.
 *
 * The interpreter keeps the full history of every expression node, so window
 * functions (sma, wma, highest, linreg, …) are evaluated by slicing that
 * history and calling the array implementations in `engine/ta.ts` directly —
 * no second implementation to drift.
 *
 * Recursive functions can't be windowed: their value depends on all prior
 * bars. Those get the small state machines below, which reproduce
 * `engine/ta.ts:recursiveMa` bar for bar (seed with the SMA of the first full
 * window of non-NaN input, then recurse; an NaN input emits NaN but preserves
 * state). `tests/pineStreamTa.test.ts` asserts that equivalence on random data.
 */

/** ema/rma core — mirrors engine/ta.ts recursiveMa. */
export class RecursiveMa {
  private len: number;
  private alpha: number;
  private run = 0;
  private seedBuf: number[] = [];
  private seeded = false;
  private prev = NaN;

  constructor(len: number, alpha: number) {
    this.len = len;
    this.alpha = alpha;
  }

  next(v: number): number {
    if (!this.seeded) {
      if (Number.isNaN(v)) {
        this.run = 0;
        this.seedBuf.length = 0;
        return NaN;
      }
      this.run += 1;
      this.seedBuf.push(v);
      if (this.seedBuf.length > this.len) this.seedBuf.shift();
      if (this.run >= this.len) {
        this.seeded = true;
        this.prev = this.seedBuf.reduce((a, b) => a + b, 0) / this.len;
        return this.prev;
      }
      return NaN;
    }
    if (Number.isNaN(v)) return NaN; // gap: carry state, emit NaN
    this.prev = this.alpha * v + (1 - this.alpha) * this.prev;
    return this.prev;
  }
}

export const emaState = (len: number): RecursiveMa =>
  new RecursiveMa(len, 2 / (len + 1));
export const rmaState = (len: number): RecursiveMa => new RecursiveMa(len, 1 / len);

/** ta.ema with Pine's len==1 passthrough. */
export class Ema {
  private inner: RecursiveMa | null;
  constructor(len: number) {
    this.inner = len === 1 ? null : emaState(len);
  }
  next(v: number): number {
    return this.inner ? this.inner.next(v) : v;
  }
}

/** ta.atr — rma of true range, with high-low on the very first bar. */
export class Atr {
  private rma: RecursiveMa;
  private prevClose = NaN;
  private first = true;
  constructor(len: number) {
    this.rma = rmaState(len);
  }
  next(high: number, low: number, close: number): number {
    let tr: number;
    if (this.first) {
      tr = high - low;
      this.first = false;
    } else {
      const pc = this.prevClose;
      tr = Math.max(high - low, Math.abs(high - pc), Math.abs(low - pc));
    }
    this.prevClose = close;
    return this.rma.next(tr);
  }
}

/** ta.tr(handleNa) — NaN on the first bar unless handleNa is true. */
export class TrueRange {
  private prevClose = NaN;
  private first = true;
  constructor(private handleNa = false) {}
  next(high: number, low: number, close: number): number {
    let tr: number;
    if (this.first) {
      tr = this.handleNa ? high - low : NaN;
      this.first = false;
    } else {
      const pc = this.prevClose;
      tr = Math.max(high - low, Math.abs(high - pc), Math.abs(low - pc));
    }
    this.prevClose = close;
    return tr;
  }
}

/** ta.rsi — rma of gains / rma of losses. */
export class Rsi {
  private up: RecursiveMa;
  private dn: RecursiveMa;
  private prev = NaN;
  private first = true;
  constructor(len: number) {
    this.up = rmaState(len);
    this.dn = rmaState(len);
  }
  next(v: number): number {
    if (this.first) {
      this.first = false;
      this.prev = v;
      // Pine's first bar has no change; feed NaN so the seed window matches.
      this.up.next(NaN);
      this.dn.next(NaN);
      return NaN;
    }
    const ch = v - this.prev;
    this.prev = v;
    const u = this.up.next(Math.max(ch, 0));
    const d = this.dn.next(Math.max(-ch, 0));
    if (Number.isNaN(u) || Number.isNaN(d)) return NaN;
    if (d === 0) return 100;
    return 100 - 100 / (1 + u / d);
  }
}

/** ta.cum — running sum, treating na as 0 (Pine's behaviour). */
export class Cum {
  private acc = 0;
  next(v: number): number {
    if (!Number.isNaN(v)) this.acc += v;
    return this.acc;
  }
}

/** ta.barssince — bars elapsed since the condition was last true. */
export class BarsSince {
  private count = NaN;
  next(cond: boolean): number {
    if (cond) this.count = 0;
    else if (!Number.isNaN(this.count)) this.count += 1;
    return this.count;
  }
}

/** ta.valuewhen(cond, src, occurrence) — remembers the last N hits. */
export class ValueWhen {
  private hits: number[] = [];
  constructor(private occurrence: number) {}
  next(cond: boolean, src: number): number {
    if (cond) {
      this.hits.unshift(src);
      if (this.hits.length > this.occurrence + 1) this.hits.pop();
    }
    const v = this.hits[this.occurrence];
    return v === undefined ? NaN : v;
  }
}
