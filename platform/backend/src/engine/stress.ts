/**
 * Stress-regime discovery: finding the market's worst stretches, from market
 * data alone.
 *
 * ── What this is, and what it is NOT ──────────────────────────────────────
 *
 * A strategy can look healthy across a development window and a validation
 * window and still be a strategy that has never met a bad market. Stress
 * analysis asks the adversarial question instead: take the periods in which
 * the market itself behaved worst, and see what the strategy did in them.
 *
 * Those periods are chosen by SEARCHING HISTORY for the worst benchmark
 * windows. That is ex-post by construction. It is the right way to probe
 * robustness and it is emphatically NOT unbiased out-of-sample evidence: the
 * windows were picked because of what happened in them, so a result over them
 * carries no confidence interval and supports no claim about the future. The
 * product must never present a stress score beside a holdout score as though
 * the two were the same kind of number. `engine/holdout.ts` holds the
 * validation half of that distinction; this module holds the stress half, and
 * `STRESS_EPISTEMIC_NOTE` below is the sentence that travels with every
 * result.
 *
 * ── The one invariant that makes it worth anything ────────────────────────
 *
 * Stress windows are discovered from BENCHMARK MARKET DATA and from nothing
 * else. If strategy performance could influence which windows are selected,
 * the analysis would be selecting the windows where the strategy already does
 * badly (or well) and reporting that as a finding — circular, and worse than
 * no analysis. The guarantee here is structural rather than documentary: every
 * function in this module takes candles and a configuration, and there is no
 * parameter through which a trade, an equity curve or a metric could reach it.
 * `tests/stressWindows.test.ts` pins that the signature stays that way.
 *
 * ── Why the benchmark may differ from the traded instrument ───────────────
 *
 * "How does my SOL 15-minute strategy behave when BTC is falling apart?" is a
 * different and often better question than "how does it behave when SOL is".
 * Crypto drawdowns are substantially common-factor, and a strategy on an alt
 * meets the market's stress through the major. So the benchmark is named
 * independently of the traded symbol, and may be the traded symbol.
 */
import { INTERVAL_MS, type Candle, type Interval } from "../types/market";

/** Travels with every stress result. It is not decoration. */
export const STRESS_EPISTEMIC_NOTE =
  "Stress windows are chosen by searching history for the benchmark's worst "
  + "periods, so they are selected with hindsight. This measures robustness "
  + "against known-bad conditions; it is not out-of-sample evidence and does "
  + "not support a claim about future performance. Compare it with the "
  + "development and holdout windows, never as though it were one of them.";

/** How the worst windows are identified. All read the benchmark only. */
export type StressMethod =
  /** The most negative close-to-close return over the window length. */
  | "worst_return"
  /** The deepest peak-to-trough fall within the window. */
  | "deepest_drawdown"
  /** The highest realised volatility of bar returns over the window. */
  | "highest_volatility"
  /** Windows the user named. Discovery does nothing; ranking is by date. */
  | "manual";

export interface StressWindowConfig {
  method: StressMethod;
  /** Window length in benchmark BARS. Snapping to bars is what makes it exact. */
  lengthBars: number;
  /** How many windows to keep, after separation is applied. */
  topN: number;
  /**
   * Minimum gap, in bars, between the STARTS of two selected windows.
   *
   * Without it the top N of any method is N shifts of the same crash, because
   * a rolling window one bar to the left of the worst window is the
   * second-worst. Defaulting it to the window length means selected windows
   * never overlap; a smaller value permits deliberate overlap.
   */
  minSeparationBars?: number;
  /** Windows supplied by the user. Required by `manual`, ignored otherwise. */
  manualWindows?: { startMs: number; endMs: number; label?: string }[];
}

/** One discovered adverse period, with the reason it was selected. */
export interface StressWindow {
  /** 1-based, most severe first. `manual` ranks by date. */
  rank: number;
  startMs: number;
  endMs: number;
  /** Benchmark bars the window spans. */
  bars: number;
  /**
   * The benchmark's own return across the window, as a percentage. Reported
   * for every method so a reader can see what "worst" meant here.
   */
  benchmarkReturnPct: number;
  /** The benchmark's deepest peak-to-trough fall inside the window, percent. */
  benchmarkDrawdownPct: number;
  /** Annualisation-free realised volatility of the benchmark's bar returns. */
  benchmarkVolatilityPct: number;
  /** The metric this window was RANKED on, named so the ranking is auditable. */
  selectedBy: { metric: StressMethod; value: number };
  label?: string;
}

export class StressDiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StressDiscoveryError";
  }
}

/** Percentage change from `from` to `to`, or 0 when `from` is not positive. */
function changePct(from: number, to: number): number {
  return from > 0 ? ((to - from) / from) * 100 : 0;
}

/** The benchmark's own behaviour across `[i, j]`, independent of any method. */
function describe(candles: readonly Candle[], i: number, j: number): {
  returnPct: number; drawdownPct: number; volatilityPct: number;
} {
  const first = candles[i]!;
  const last = candles[j]!;
  let peak = first.close;
  let worst = 0;
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let k = i; k <= j; k += 1) {
    const bar = candles[k]!;
    // Drawdown is measured against the running peak using the bar's LOW, so a
    // fall that reversed inside one bar is not rounded away.
    if (bar.close > peak) peak = bar.close;
    if (peak > 0) {
      const fall = ((peak - bar.low) / peak) * 100;
      if (fall > worst) worst = fall;
    }
    if (k > i) {
      const previous = candles[k - 1]!.close;
      if (previous > 0) {
        const r = ((bar.close - previous) / previous) * 100;
        sum += r; sumSq += r * r; n += 1;
      }
    }
  }
  const mean = n > 0 ? sum / n : 0;
  const variance = n > 1 ? Math.max(0, sumSq / n - mean * mean) : 0;
  return {
    returnPct: changePct(first.close, last.close),
    drawdownPct: worst,
    volatilityPct: Math.sqrt(variance),
  };
}

/**
 * Keep the top N window positions that respect separation.
 *
 * Ordering is total and deterministic: by severity, then by the EARLIER start.
 * Two windows with an identical metric — which happens on flat or synthetic
 * data far more often than on real data — must not be ordered by whatever
 * order the array happened to be built in, or the same inputs would produce
 * different reports on different days.
 *
 * This was a full sort of every position followed by a greedy walk. The walk
 * takes, at each step, the first candidate in that order that clashes with
 * nothing already taken — which is exactly the most severe non-clashing
 * candidate. So it is found directly, N linear passes, instead of sorting
 * three quarters of a million positions to read ten of them. A scan in
 * ascending index that replaces only on STRICTLY greater severity is the
 * sort's tie-break: the earlier window wins. A score that is not a number is
 * never selected; the sort used to place it arbitrarily.
 */
function rankAndSeparate(
  severity: Float64Array,
  values: Float64Array,
  candles: readonly Candle[],
  lengthBars: number,
  topN: number,
  minSeparationBars: number,
  method: StressMethod,
): StressWindow[] {
  const chosen: number[] = [];
  while (chosen.length < topN) {
    let best = -1;
    for (let index = 0; index < severity.length; index += 1) {
      const candidate = severity[index]!;
      if (best >= 0 ? !(candidate > severity[best]!) : Number.isNaN(candidate)) continue;
      if (chosen.some((taken) => Math.abs(taken - index) < minSeparationBars)) continue;
      best = index;
    }
    if (best < 0) break;
    chosen.push(best);
  }
  return chosen.map((index, i) => {
    const j = index + lengthBars - 1;
    const stats = describe(candles, index, j);
    return {
      rank: i + 1,
      startMs: candles[index]!.openTime,
      endMs: candles[j]!.closeTime,
      bars: lengthBars,
      benchmarkReturnPct: stats.returnPct,
      benchmarkDrawdownPct: stats.drawdownPct,
      benchmarkVolatilityPct: stats.volatilityPct,
      selectedBy: { metric: method, value: values[index]! },
    };
  });
}

/*
 * ── Bounds, and why they are where they are ───────────────────────────────
 *
 * Discovery runs on the request thread. Unbounded, one request for 540 days of
 * 1-minute bars with a one-day window held the event loop for 8.2 seconds,
 * during which every other caller of the API — a chart's history, a live
 * order — waited behind it.
 *
 * `worst_return` is now linear in the series, so a long search is cheap.
 * `deepest_drawdown` and `highest_volatility` are still a pass over every bar
 * of every window position, and they stay exact on purpose: a rolling sum
 * drifts in the last bits, and a stored run's windows must be reproducible
 * from its provenance BYTE FOR BYTE — two near-equal windows trading places
 * because of an add-then-subtract would change which crash the report is
 * about. Their work is bounded instead: positions × window length may not
 * exceed `MAX_STRESS_SCAN_CELLS` (a few hundred milliseconds at worst), and
 * the refusal says what to change.
 *
 * `topN` is a ceiling on the number of BACKTESTS one stress run queues, one
 * per window, so it is bounded by what one click should hand the worker as
 * well as by what a person can read in one table. Manual windows count
 * against the same ceiling for the same reason.
 */
export const MAX_STRESS_TOP_N = 10;
export const MAX_STRESS_LENGTH_BARS = 20_000;
export const MAX_STRESS_SCAN_CELLS = 20_000_000;

/** Methods whose cost is positions × window length rather than positions. */
function scansEveryBar(method: StressMethod): boolean {
  return method === "deepest_drawdown" || method === "highest_volatility";
}

const count = (n: number): string => n.toLocaleString("en-US");

/**
 * Refuse a configuration before any candle is read for it.
 *
 * `positions` is the number of window positions the search will score. The
 * route passes an ESTIMATE from the requested period and interval, so an
 * oversized request is refused before it downloads a year of minute bars;
 * discovery passes the real count.
 */
export function validateStressConfig(config: StressWindowConfig, positions?: number): void {
  const { method, lengthBars, topN } = config;
  if (!Number.isInteger(lengthBars) || lengthBars < 2) {
    throw new StressDiscoveryError(
      `a stress window must span at least 2 benchmark bars, got ${lengthBars}`);
  }
  if (lengthBars > MAX_STRESS_LENGTH_BARS) {
    throw new StressDiscoveryError(
      `a stress window may span at most ${count(MAX_STRESS_LENGTH_BARS)} benchmark bars, `
      + `got ${count(lengthBars)}. Choose a coarser benchmark interval for a window that long.`);
  }
  if (!Number.isInteger(topN) || topN < 1) {
    throw new StressDiscoveryError(`topN must be a positive whole number, got ${topN}`);
  }
  if (topN > MAX_STRESS_TOP_N) {
    throw new StressDiscoveryError(
      `at most ${MAX_STRESS_TOP_N} windows can be kept, got ${topN}: `
      + "each window queues a backtest of its own");
  }
  if ((config.manualWindows?.length ?? 0) > MAX_STRESS_TOP_N) {
    throw new StressDiscoveryError(
      `at most ${MAX_STRESS_TOP_N} manual windows can be named, got `
      + `${config.manualWindows!.length}: each window queues a backtest of its own`);
  }
  const minSeparationBars = config.minSeparationBars ?? lengthBars;
  if (!Number.isInteger(minSeparationBars) || minSeparationBars < 1) {
    throw new StressDiscoveryError(
      `minSeparationBars must be a positive whole number, got ${minSeparationBars}`);
  }
  if (positions !== undefined && scansEveryBar(method)
    && positions * lengthBars > MAX_STRESS_SCAN_CELLS) {
    throw new StressDiscoveryError(
      `ranking by ${method.replace(/_/g, " ")} reads every bar of every window position, and `
      + `${count(positions)} positions × ${count(lengthBars)} bars is more than one search `
      + `may read (${count(MAX_STRESS_SCAN_CELLS)}). Choose a coarser benchmark interval, a `
      + "shorter period or a shorter window — or rank by worst return, which has no such limit.");
  }
}

/*
 * The ranked statistic alone, for one window position.
 *
 * Each is `describe`'s own arithmetic for that statistic — the same
 * expressions in the same order — so the value a window was RANKED on is bit
 * for bit the value it REPORTS, and a stored run replays to the same windows.
 * `tests/stressWindows.test.ts` holds the old all-statistics implementation as
 * the oracle for that.
 */
function drawdownOf(candles: readonly Candle[], i: number, j: number): number {
  let peak = candles[i]!.close;
  let worst = 0;
  for (let k = i; k <= j; k += 1) {
    const bar = candles[k]!;
    if (bar.close > peak) peak = bar.close;
    if (peak > 0) {
      const fall = ((peak - bar.low) / peak) * 100;
      if (fall > worst) worst = fall;
    }
  }
  return worst;
}

function volatilityOf(candles: readonly Candle[], i: number, j: number): number {
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let k = i + 1; k <= j; k += 1) {
    const previous = candles[k - 1]!.close;
    if (previous > 0) {
      const r = ((candles[k]!.close - previous) / previous) * 100;
      sum += r; sumSq += r * r; n += 1;
    }
  }
  const mean = n > 0 ? sum / n : 0;
  const variance = n > 1 ? Math.max(0, sumSq / n - mean * mean) : 0;
  return Math.sqrt(variance);
}

/**
 * Discover the benchmark's worst windows.
 *
 * `candles` must be the BENCHMARK's series, ascending and contiguous at its
 * own interval. Nothing about the strategy is available here, by design.
 */
export function discoverStressWindows(
  candles: readonly Candle[], config: StressWindowConfig,
): StressWindow[] {
  const { method, lengthBars, topN } = config;
  validateStressConfig(config);
  const minSeparationBars = config.minSeparationBars ?? lengthBars;

  if (method === "manual") return manualWindows(candles, config);

  if (candles.length < lengthBars) {
    throw new StressDiscoveryError(
      `the benchmark has ${candles.length} bars, which cannot contain a `
      + `${lengthBars}-bar window. Widen the benchmark period, shorten the window, `
      + "or choose a finer benchmark interval.");
  }
  const positions = candles.length - lengthBars + 1;
  validateStressConfig(config, positions);

  /*
   * Only the statistic being ranked is computed per position; all three are
   * computed for the windows actually kept, by `describe`. `worst_return`
   * needs two closes per position, so it is linear in the series however long
   * the window is.
   */
  const severity = new Float64Array(positions);
  const values = new Float64Array(positions);
  for (let i = 0; i < positions; i += 1) {
    const j = i + lengthBars - 1;
    const value = method === "worst_return" ? changePct(candles[i]!.close, candles[j]!.close)
      : method === "deepest_drawdown" ? drawdownOf(candles, i, j)
        : volatilityOf(candles, i, j);
    values[i] = value;
    // Severity is always "larger is worse", whatever the metric's own sign.
    severity[i] = method === "worst_return" ? -value : value;
  }
  return rankAndSeparate(severity, values, candles, lengthBars, topN, minSeparationBars, method);
}

/**
 * Windows the user named, snapped to benchmark bars.
 *
 * Snapping is not a courtesy: a window that starts mid-bar would run the
 * strategy over a boundary the benchmark's own statistics were never computed
 * across, and the two numbers in the report would then describe slightly
 * different periods. A window naming a period the benchmark does not cover is
 * refused rather than silently clipped.
 */
function manualWindows(
  candles: readonly Candle[], config: StressWindowConfig,
): StressWindow[] {
  const requested = config.manualWindows ?? [];
  if (requested.length === 0) {
    throw new StressDiscoveryError(
      "the manual method needs at least one window; none was given");
  }
  if (candles.length === 0) {
    throw new StressDiscoveryError("the benchmark has no bars in this period");
  }
  const ordered = [...requested].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  return ordered.map((window, rank) => {
    if (!(window.endMs > window.startMs)) {
      throw new StressDiscoveryError(
        `a manual window must end after it starts: ${new Date(window.startMs).toISOString()}`
        + ` .. ${new Date(window.endMs).toISOString()}`);
    }
    const i = candles.findIndex((bar) => bar.closeTime > window.startMs);
    let j = -1;
    for (let k = candles.length - 1; k >= 0; k -= 1) {
      if (candles[k]!.openTime < window.endMs) { j = k; break; }
    }
    if (i < 0 || j < i) {
      throw new StressDiscoveryError(
        `the benchmark has no bars between ${new Date(window.startMs).toISOString()} and `
        + `${new Date(window.endMs).toISOString()}. A window must name a period the `
        + "benchmark actually covers.");
    }
    /*
     * PARTIAL overlap is refused too, and it was not.
     *
     * Only a window lying wholly outside the benchmark raised; one that
     * straddled an edge was silently clipped to whatever the benchmark had —
     * so a request for five days across a year boundary came back as nine
     * hours, reported as the window the user asked for, with its return,
     * drawdown and volatility all computed over the wrong period. That is the
     * same class of defect as clipping without saying so anywhere else in this
     * product, and the docstring, the documentation and the test name all
     * already claimed it was refused.
     *
     * A whole bar of slack at each end, because snapping to bar boundaries is
     * expected and is not clipping.
     */
    const first = candles[i]!;
    const last = candles[j]!;
    const slack = last.closeTime - last.openTime + 1;
    if (first.openTime > window.startMs + slack || last.closeTime < window.endMs - slack) {
      throw new StressDiscoveryError(
        `the benchmark covers only ${new Date(first.openTime).toISOString()} to `
        + `${new Date(last.closeTime).toISOString()} of the window `
        + `${new Date(window.startMs).toISOString()} .. ${new Date(window.endMs).toISOString()}. `
        + "A partly covered window is refused rather than clipped: its statistics would "
        + "describe a period you did not ask about.");
    }
    const stats = describe(candles, i, j);
    return {
      rank: rank + 1,
      startMs: candles[i]!.openTime,
      endMs: candles[j]!.closeTime,
      bars: j - i + 1,
      benchmarkReturnPct: stats.returnPct,
      benchmarkDrawdownPct: stats.drawdownPct,
      benchmarkVolatilityPct: stats.volatilityPct,
      selectedBy: { metric: "manual", value: stats.returnPct },
      ...(window.label === undefined ? {} : { label: window.label }),
    };
  });
}

/**
 * Everything needed to produce the same windows again.
 *
 * A stress report whose windows cannot be regenerated is an anecdote. This is
 * stored beside the results so the discovery can be repeated exactly — the
 * benchmark's identity and provider included, because "BTC's worst week" means
 * a different week on a different venue's series.
 */
export interface StressProvenance {
  schemaVersion: "stress-discovery.v1";
  benchmark: {
    symbol: string;
    canonicalInstrument: string | null;
    interval: Interval;
    providerId: string;
    feedId: string;
  };
  /** The period discovery searched — not the periods it returned. */
  searched: { startMs: number; endMs: number; bars: number };
  config: Required<Pick<StressWindowConfig, "method" | "lengthBars" | "topN">>
    & { minSeparationBars: number; manualWindows: StressWindowConfig["manualWindows"] };
  /** Restated on the record itself, so a stored result cannot lose it. */
  epistemicNote: string;
}

export function stressProvenance(
  benchmark: StressProvenance["benchmark"],
  candles: readonly Candle[],
  config: StressWindowConfig,
): StressProvenance {
  return {
    schemaVersion: "stress-discovery.v1",
    benchmark,
    searched: {
      startMs: candles[0]?.openTime ?? 0,
      endMs: candles[candles.length - 1]?.closeTime ?? 0,
      bars: candles.length,
    },
    config: {
      method: config.method,
      lengthBars: config.lengthBars,
      topN: config.topN,
      minSeparationBars: config.minSeparationBars ?? config.lengthBars,
      manualWindows: config.manualWindows,
    },
    epistemicNote: STRESS_EPISTEMIC_NOTE,
  };
}

/** How many benchmark bars a window length of `ms` is at `interval`. */
export function barsForDuration(ms: number, interval: Interval): number {
  return Math.max(2, Math.round(ms / INTERVAL_MS[interval]));
}
