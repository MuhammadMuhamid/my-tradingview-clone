/**
 * Look-ahead and warm-up analysis.
 *
 * Two questions this answers mechanically, both of which the audit had to ask
 * by hand:
 *
 *  1. **Look-ahead.** Does any chart bar see a value that could not have been
 *     known at that bar's close? `BE-08` is exactly this question about the
 *     multi-timeframe merge, and it took a careful reading of three files plus
 *     a claim about an absent parity artifact to even state it. It should take
 *     one function call.
 *
 *  2. **Warm-up sensitivity.** Does the result depend on where the loaded
 *     window happens to start? `BE-09` is this: `ma_rr_v9` applies a 1500-bar
 *     floor before ratcheting indicators are trusted and `mtf_lean` applies
 *     none, so re-running `mtf_lean` after the candle table gains history
 *     silently changes which trades were taken.
 *
 * Modelled on Freqtrade's `lookahead-analysis` and `recursive-analysis`, which
 * the market report names as the closest comparable capability (`G6`).
 *
 * Everything here is pure and takes bars as arguments. No database, no network,
 * no strategy execution — so it can be run on a fixture, in a test, or against
 * a real feed, and it cannot itself introduce the bias it is looking for.
 */
import type { Bars, MergeConvention } from "./mtf";
import { buildMergeIndex } from "./mtf";

// ── Look-ahead ──────────────────────────────────────────────────────────────

export interface LookaheadViolation {
  chartBar: number;
  chartOpenTime: number;
  chartCloseTime: number;
  feedBar: number;
  feedOpenTime: number;
  feedCloseTime: number;
  /** How far past the chart bar's close the feed bar closed, in ms. */
  aheadByMs: number;
}

export interface LookaheadReport {
  convention: MergeConvention;
  chartInterval: string;
  feedInterval: string;
  barsChecked: number;
  violations: LookaheadViolation[];
  /** True when no chart bar sees a feed bar that closed after it. */
  clean: boolean;
  /**
   * Bars where the two conventions disagree. Not a defect on its own — it is
   * the measure of how much BE-08 actually matters for this pair of feeds.
   */
  conventionDisagreements: number;
  summary: string;
}

/**
 * Check a merge for look-ahead.
 *
 * A violation is a chart bar whose merged feed bar closed AFTER the chart bar
 * closed: information from the future. This is the definition regardless of
 * which convention is in use, which is what makes it a useful arbiter —
 * `chartOpen` is strictly more conservative than `chartClose`, so if
 * `chartClose` is clean by this test then neither convention leaks the future,
 * and the disagreement between them is about DELAY, not about look-ahead.
 *
 * That distinction is the substance of BE-08: the question is not "does the
 * code cheat" but "does TradingView delay by one bar". This function separates
 * the two so the second can be settled by comparison rather than by argument.
 */
export function analyseLookahead(
  chart: Bars,
  feed: Bars,
  convention: MergeConvention = "chartClose"
): LookaheadReport {
  const idx = buildMergeIndex(chart, feed, convention);
  const other: MergeConvention = convention === "chartClose" ? "chartOpen" : "chartClose";
  const idxOther = buildMergeIndex(chart, feed, other);

  const violations: LookaheadViolation[] = [];
  let disagreements = 0;

  for (let i = 0; i < chart.length; i++) {
    const j = idx[i]!;
    if (idx[i] !== idxOther[i]) disagreements++;
    if (j < 0) continue;
    const feedClose = feed.closeTime[j]!;
    const chartClose = chart.closeTime[i]!;
    if (feedClose > chartClose) {
      violations.push({
        chartBar: i,
        chartOpenTime: chart.time[i]!,
        chartCloseTime: chartClose,
        feedBar: j,
        feedOpenTime: feed.time[j]!,
        feedCloseTime: feedClose,
        aheadByMs: feedClose - chartClose,
      });
    }
  }

  const clean = violations.length === 0;
  return {
    convention,
    chartInterval: chart.interval,
    feedInterval: feed.interval,
    barsChecked: chart.length,
    violations,
    clean,
    conventionDisagreements: disagreements,
    summary: clean
      ? `no look-ahead under ${convention}: no chart bar sees a ${feed.interval} bar ` +
        `that closed after it. The two conventions disagree on ${disagreements} of ` +
        `${chart.length} bars, which is a question of DELAY, not of look-ahead (BE-08).`
      : `LOOK-AHEAD: ${violations.length} of ${chart.length} chart bars see a ` +
        `${feed.interval} bar that closed after the chart bar did, by up to ` +
        `${Math.max(...violations.map((v) => v.aheadByMs))} ms.`,
  };
}

/**
 * Compare the two conventions on one pair of feeds.
 *
 * The output is what a TradingView comparison should be checked against: for
 * the named chart bar, the value each convention produces. If they are equal
 * the bar cannot distinguish them; pick a bar where they differ.
 */
export interface ConventionComparison {
  chartBar: number;
  chartOpenTime: number;
  chartCloseTime: number;
  chartCloseIso: string;
  underChartClose: number | null;
  underChartOpen: number | null;
  distinguishing: boolean;
}

export function compareConventions(
  chart: Bars,
  feed: Bars,
  src: number[],
  opts: { limit?: number; onlyDistinguishing?: boolean } = {}
): ConventionComparison[] {
  const a = buildMergeIndex(chart, feed, "chartClose");
  const b = buildMergeIndex(chart, feed, "chartOpen");
  const out: ConventionComparison[] = [];
  const limit = opts.limit ?? chart.length;

  for (let i = 0; i < chart.length && out.length < limit; i++) {
    const ja = a[i]!;
    const jb = b[i]!;
    const va = ja >= 0 ? (src[ja] ?? null) : null;
    const vb = jb >= 0 ? (src[jb] ?? null) : null;
    const distinguishing = ja !== jb;
    if (opts.onlyDistinguishing && !distinguishing) continue;
    out.push({
      chartBar: i,
      chartOpenTime: chart.time[i]!,
      chartCloseTime: chart.closeTime[i]!,
      chartCloseIso: new Date(chart.closeTime[i]!).toISOString(),
      underChartClose: va,
      underChartOpen: vb,
      distinguishing,
    });
  }
  return out;
}

// ── Warm-up sensitivity ─────────────────────────────────────────────────────

export interface WarmupReport {
  /** Bars trimmed from the front for each probe. */
  offsets: number[];
  /** Value of the series at the FINAL bar, per offset. */
  finalValues: (number | null)[];
  /** Largest absolute difference between any two probes. */
  maxAbsDeviation: number;
  /** Largest relative difference, as a fraction of the baseline. */
  maxRelDeviation: number;
  /**
   * Bars of history after which every probe agrees to within `tolerance`.
   * `null` when they never do inside the offsets tried.
   */
  stableAfterBars: number | null;
  stable: boolean;
  summary: string;
}

/**
 * Measure how much a recursive indicator's newest value depends on where the
 * loaded window starts.
 *
 * `compute` is called with a trimmed copy of the source series and must return
 * the full output series. An indicator with no memory returns the same final
 * value for every offset; a ratcheting one (Supertrend, a trailing anchor, an
 * RMA-seeded average) does not, and the deviation is how much history it needs
 * before the answer is reproducible.
 *
 * This is the measurement `BE-09` calls for: `ma_rr_v9` chose 1500 bars,
 * `mtf_lean` chose nothing, and neither number was derived from anything.
 */
export function analyseWarmupSensitivity(
  src: number[],
  compute: (window: number[]) => (number | null)[],
  opts: { offsets?: number[]; tolerance?: number } = {}
): WarmupReport {
  const offsets = opts.offsets ?? [0, 50, 100, 250, 500, 1000, 1500];
  const tolerance = opts.tolerance ?? 1e-6;

  const finalValues: (number | null)[] = [];
  for (const offset of offsets) {
    if (offset >= src.length) { finalValues.push(null); continue; }
    const out = compute(src.slice(offset));
    const last = out.length > 0 ? out[out.length - 1] : null;
    finalValues.push(last === undefined ? null : last);
  }

  const usable = finalValues.filter((v): v is number => v !== null && Number.isFinite(v));
  if (usable.length < 2) {
    return {
      offsets, finalValues, maxAbsDeviation: 0, maxRelDeviation: 0,
      stableAfterBars: null, stable: false,
      summary: "not enough usable probes to judge warm-up sensitivity",
    };
  }

  // The baseline is the LONGEST window, i.e. the most history available.
  const baseline = usable[0]!;
  let maxAbs = 0;
  for (const v of usable) maxAbs = Math.max(maxAbs, Math.abs(v - baseline));
  const maxRel = Math.abs(baseline) > 0 ? maxAbs / Math.abs(baseline) : maxAbs;

  /*
   * Walk from the LONGEST window towards the shortest, stopping at the first
   * probe that disagrees with the baseline. The last agreeing probe is the
   * SHORTEST amount of history that still reproduces the answer — which is the
   * number a warm-up floor should be set from.
   *
   * Walking the other way and breaking on disagreement would stop before ever
   * reaching the baseline probe, and report `null` for a series that is
   * perfectly reproducible given enough history.
   */
  let stableAfterBars: number | null = null;
  for (let k = 0; k < offsets.length; k++) {
    const v = finalValues[k];
    if (v === null || v === undefined || !Number.isFinite(v)) continue;
    if (Math.abs(v - baseline) > tolerance) break;
    stableAfterBars = src.length - offsets[k]!;
  }

  const stable = maxAbs <= tolerance;
  return {
    offsets, finalValues,
    maxAbsDeviation: maxAbs,
    maxRelDeviation: maxRel,
    stableAfterBars,
    stable,
    summary: stable
      ? `warm-up insensitive: the final value varies by at most ${maxAbs.toExponential(2)} ` +
        "across every window tried"
      : `WARM-UP SENSITIVE: the final value varies by up to ${maxAbs.toExponential(2)} ` +
        `(${(maxRel * 100).toFixed(4)} %) depending on where the window starts. ` +
        (stableAfterBars !== null
          ? `It is reproducible with at least ${stableAfterBars} bars of history.`
          : "It did not stabilise within the offsets tried, so a floor cannot be derived from this run."),
  };
}
