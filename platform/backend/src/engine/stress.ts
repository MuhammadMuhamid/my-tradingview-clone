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
 * Rank every window position, then keep the top N that respect separation.
 *
 * Ordering is total and deterministic: by severity, then by the EARLIER start.
 * Two windows with an identical metric — which happens on flat or synthetic
 * data far more often than on real data — must not be ordered by whatever
 * order the array happened to be built in, or the same inputs would produce
 * different reports on different days.
 */
function rankAndSeparate(
  scored: { index: number; severity: number; value: number }[],
  candles: readonly Candle[],
  lengthBars: number,
  topN: number,
  minSeparationBars: number,
  method: StressMethod,
): StressWindow[] {
  scored.sort((a, b) => b.severity - a.severity || a.index - b.index);
  const chosen: typeof scored = [];
  for (const candidate of scored) {
    if (chosen.length >= topN) break;
    const clashes = chosen.some(
      (taken) => Math.abs(taken.index - candidate.index) < minSeparationBars);
    if (clashes) continue;
    chosen.push(candidate);
  }
  return chosen.map((entry, i) => {
    const j = entry.index + lengthBars - 1;
    const stats = describe(candles, entry.index, j);
    return {
      rank: i + 1,
      startMs: candles[entry.index]!.openTime,
      endMs: candles[j]!.closeTime,
      bars: lengthBars,
      benchmarkReturnPct: stats.returnPct,
      benchmarkDrawdownPct: stats.drawdownPct,
      benchmarkVolatilityPct: stats.volatilityPct,
      selectedBy: { metric: method, value: entry.value },
    };
  });
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

  if (!Number.isInteger(lengthBars) || lengthBars < 2) {
    throw new StressDiscoveryError(
      `a stress window must span at least 2 benchmark bars, got ${lengthBars}`);
  }
  if (!Number.isInteger(topN) || topN < 1) {
    throw new StressDiscoveryError(`topN must be a positive whole number, got ${topN}`);
  }
  const minSeparationBars = config.minSeparationBars ?? lengthBars;
  if (!Number.isInteger(minSeparationBars) || minSeparationBars < 1) {
    throw new StressDiscoveryError(
      `minSeparationBars must be a positive whole number, got ${minSeparationBars}`);
  }

  if (method === "manual") return manualWindows(candles, config);

  if (candles.length < lengthBars) {
    throw new StressDiscoveryError(
      `the benchmark has ${candles.length} bars, which cannot contain a `
      + `${lengthBars}-bar window. Widen the benchmark period, shorten the window, `
      + "or choose a finer benchmark interval.");
  }

  const scored: { index: number; severity: number; value: number }[] = [];
  for (let i = 0; i + lengthBars <= candles.length; i += 1) {
    const stats = describe(candles, i, i + lengthBars - 1);
    // Severity is always "larger is worse", whatever the metric's own sign.
    const value = method === "worst_return" ? stats.returnPct
      : method === "deepest_drawdown" ? stats.drawdownPct
        : stats.volatilityPct;
    const severity = method === "worst_return" ? -stats.returnPct : value;
    scored.push({ index: i, severity, value });
  }
  return rankAndSeparate(scored, candles, lengthBars, topN, minSeparationBars, method);
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
