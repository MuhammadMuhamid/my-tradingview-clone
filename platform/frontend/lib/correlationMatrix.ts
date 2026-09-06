"use client";
/**
 * How a set of instruments move together.
 *
 * ── Why this is not the compare pane ───────────────────────────────────────
 *
 * The compare pane answers "how does THIS chart relate to that one", as a
 * series through time. This answers a different question — "which of the
 * things I am watching are the same trade" — and the answer is not a series at
 * all: it is one number per pair, over one window, which is a table.
 *
 * That distinction decides where each lives. A rolling correlation belongs on
 * the chart, beside the bars it is rolling over. A correlation matrix belongs
 * in a panel beside the watchlist, because its subject is the watchlist.
 *
 * ── Pairwise complete, and said out loud ───────────────────────────────────
 *
 * Instruments have different histories: a newer listing, an outage, a pair
 * that did not trade a particular minute. Three ways to handle that, and only
 * one of them is honest.
 *
 *   Forward-filling a missing bar invents an observation — a return of exactly
 *   zero — and a correlation computed partly from invented zeros is a number
 *   with no meaning that looks exactly like one that has meaning.
 *
 *   Dropping every bar ANY instrument is missing (listwise deletion) makes the
 *   whole table hostage to its worst member: add one thinly-traded pair and
 *   every other correlation in the matrix silently changes.
 *
 *   So each pair is computed over the bars BOTH of its instruments have, and
 *   the count is reported with the number. Two cells in the same table may
 *   rest on different numbers of observations; that is a true fact about the
 *   data, and hiding it would be the only way to make the table look tidier.
 *
 * A pair with too few overlapping observations gets no number rather than a
 * confident one: a correlation of 0.98 from four bars is noise wearing a
 * decimal point.
 *
 * ── Returns, not prices ────────────────────────────────────────────────────
 *
 * Log returns, for the reason `lib/compare` gives at length: two instruments
 * that both drift upward correlate at nearly 1 whatever they have in common,
 * which is a fact about drift rather than about them.
 */

/** One instrument's bars, as the matrix needs them. */
export interface MatrixSeries {
  symbol: string;
  /** Bar open times, ascending, in epoch milliseconds. */
  openTimes: readonly number[];
  /** Closes, aligned to `openTimes`. */
  closes: readonly number[];
}

export interface PairStat {
  correlation: number | null;
  /** Covariance of the two return series, in units of return². */
  covariance: number | null;
  /** How many bars both instruments had a return for. */
  observations: number;
}

export interface CorrelationMatrix {
  symbols: string[];
  /** Row-major; `cells[i][j]` is symbol `i` against symbol `j`. */
  cells: PairStat[][];
  /** Per-bar standard deviation of each instrument's own returns. */
  volatility: (number | null)[];
  /** Bars on the shared time grid the window was taken from. */
  bars: number;
  /** Bars requested. */
  window: number;
  /** The most and fewest observations any pair rested on. */
  observationRange: { min: number; max: number };
}

/**
 * The fewest overlapping returns a correlation may be reported from.
 *
 * Ten is not a claim that ten is enough for inference; it is the point below
 * which the number is certainly meaningless. The observation count is shown
 * regardless, so a reader can apply their own threshold to the rest.
 */
export const MIN_OBSERVATIONS = 10;

const EMPTY_PAIR: PairStat = { correlation: null, covariance: null, observations: 0 };

/**
 * Every pairwise correlation and covariance over the last `window` bars.
 *
 * Total: no series, one series, a series of constants, and a pair with no
 * overlap at all each produce a well-formed table rather than a NaN or a
 * throw. The diagonal is 1 by construction and is computed rather than
 * asserted, so a series that cannot correlate with itself — a constant — says
 * so instead of claiming a perfect relationship it does not have.
 */
export function correlationMatrix(
  series: readonly MatrixSeries[], window: number
): CorrelationMatrix {
  const symbols = series.map((s) => s.symbol);
  const bounded = Math.max(2, Math.min(5_000, Math.floor(window)));
  if (series.length === 0) {
    return {
      symbols: [], cells: [], volatility: [], bars: 0, window: bounded,
      observationRange: { min: 0, max: 0 },
    };
  }

  const grid = sharedGrid(series);
  const returns = series.map((s) => logReturnsOnGrid(grid, s));
  // Only the tail matters: the window is "the last N bars", and taking it here
  // rather than inside every pair keeps the cost one pass per instrument.
  const tail = returns.map((r) => r.slice(Math.max(0, r.length - bounded)));

  const cells: PairStat[][] = [];
  let min = Number.POSITIVE_INFINITY;
  let max = 0;
  for (let i = 0; i < series.length; i++) {
    const row: PairStat[] = [];
    for (let j = 0; j < series.length; j++) {
      const stat = j < i ? cells[j]![i]! : pairStat(tail[i]!, tail[j]!);
      row.push(stat);
      if (i !== j) {
        min = Math.min(min, stat.observations);
        max = Math.max(max, stat.observations);
      }
    }
    cells.push(row);
  }

  return {
    symbols,
    cells,
    volatility: tail.map((r) => {
      const finite = r.filter(Number.isFinite);
      return finite.length >= MIN_OBSERVATIONS ? standardDeviation(finite) : null;
    }),
    bars: Math.min(grid.length, bounded + 1),
    window: bounded,
    observationRange: series.length < 2
      ? { min: 0, max: 0 }
      : { min: Number.isFinite(min) ? min : 0, max },
  };
}

/**
 * The union of every instrument's bar times.
 *
 * A union rather than an intersection, so one thin instrument cannot shorten
 * the window every other pair is computed over. Bars an instrument does not
 * have become `NaN` in its own row and are skipped by whichever pairs involve
 * it, which is exactly the pairwise-complete rule.
 */
function sharedGrid(series: readonly MatrixSeries[]): number[] {
  const times = new Set<number>();
  for (const s of series) for (const t of s.openTimes) times.add(t);
  return [...times].sort((a, b) => a - b);
}

/** One instrument's log returns, placed on the shared grid. */
function logReturnsOnGrid(grid: readonly number[], series: MatrixSeries): number[] {
  const byTime = new Map<number, number>();
  for (let i = 0; i < series.openTimes.length; i++) {
    const close = series.closes[i];
    if (close !== undefined && Number.isFinite(close) && close > 0) {
      byTime.set(series.openTimes[i]!, close);
    }
  }
  const out: number[] = [];
  for (let i = 1; i < grid.length; i++) {
    const now = byTime.get(grid[i]!);
    const before = byTime.get(grid[i - 1]!);
    /*
     * A return needs two CONSECUTIVE bars on the grid.
     *
     * Not "this close and the last one I have": a gap of six hours followed by
     * a print is a six-hour return, and putting it beside another
     * instrument's one-minute return as if the two were comparable is how a
     * correlation ends up describing the gaps rather than the market.
     */
    out.push(now !== undefined && before !== undefined ? Math.log(now / before) : Number.NaN);
  }
  return out;
}

/** Correlation and covariance over the bars both series have. */
function pairStat(a: readonly number[], b: readonly number[]): PairStat {
  const xs: number[] = [];
  const ys: number[] = [];
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (Number.isFinite(x) && Number.isFinite(y)) { xs.push(x); ys.push(y); }
  }
  const n = xs.length;
  if (n < MIN_OBSERVATIONS) return { ...EMPTY_PAIR, observations: n };

  const meanX = xs.reduce((s, v) => s + v, 0) / n;
  const meanY = ys.reduce((s, v) => s + v, 0) / n;
  let cov = 0;
  let varX = 0;
  let varY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - meanX;
    const dy = ys[i]! - meanY;
    cov += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }
  // Sample covariance, so it agrees with the sample standard deviations the
  // correlation is normalised by and with `stdev` elsewhere in the product.
  const denominator = n - 1;
  const covariance = cov / denominator;
  const spread = Math.sqrt(varX / denominator) * Math.sqrt(varY / denominator);
  return {
    // A constant series has no dispersion, so it has no correlation — not a
    // correlation of 1, which is what dividing by zero would have suggested.
    correlation: spread > 0 ? clamp(covariance / spread) : null,
    covariance,
    observations: n,
  };
}

/** Rounding can push a correlation a hair outside ±1; the number cannot be. */
function clamp(v: number): number {
  return Math.max(-1, Math.min(1, v));
}

function standardDeviation(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/**
 * Beta of `asset` against `benchmark`, from the same table.
 *
 * Derived rather than computed a second time, so it cannot disagree with the
 * covariance shown beside it. Undefined where the benchmark did not move: a
 * beta against a flat benchmark is a division by zero dressed as a number.
 */
export function betaFromMatrix(
  matrix: CorrelationMatrix, asset: string, benchmark: string
): number | null {
  const i = matrix.symbols.indexOf(asset);
  const j = matrix.symbols.indexOf(benchmark);
  if (i < 0 || j < 0) return null;
  const covariance = matrix.cells[i]![j]!.covariance;
  const benchmarkSigma = matrix.volatility[j];
  if (covariance === null || benchmarkSigma === null || benchmarkSigma === undefined) return null;
  const variance = benchmarkSigma * benchmarkSigma;
  return variance > 0 ? covariance / variance : null;
}

/**
 * The pairs that move together most, strongest first.
 *
 * Absolute value, because two instruments that move exactly oppositely are as
 * related as two that move together — and on a spot-only, long-only book a
 * strong negative correlation is the more interesting of the two.
 */
export function strongestPairs(
  matrix: CorrelationMatrix, limit = 5
): { a: string; b: string; correlation: number; observations: number }[] {
  const out: { a: string; b: string; correlation: number; observations: number }[] = [];
  for (let i = 0; i < matrix.symbols.length; i++) {
    for (let j = i + 1; j < matrix.symbols.length; j++) {
      const cell = matrix.cells[i]![j]!;
      if (cell.correlation === null) continue;
      out.push({
        a: matrix.symbols[i]!, b: matrix.symbols[j]!,
        correlation: cell.correlation, observations: cell.observations,
      });
    }
  }
  out.sort((x, y) => Math.abs(y.correlation) - Math.abs(x.correlation));
  return out.slice(0, limit);
}
