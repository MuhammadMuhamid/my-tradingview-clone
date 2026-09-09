"use client";
/**
 * Comparing one instrument against another.
 *
 * ── Why this is not three studies ──────────────────────────────────────────
 *
 * A normalized overlay, a rolling correlation and a beta all need the same
 * hard thing: a SECOND instrument's bars, aligned to the first's, on the same
 * timeframe, without inventing any. Written as three independent studies each
 * would load its own second series, and a chart with all three would open
 * three requests for the same bars and hold three copies of them.
 *
 * So there is one second-series boundary — `useCompareSeries` — and the three
 * studies read from it. That is also what keeps a websocket-per-study
 * explosion from happening: the compare series is HISTORY, refreshed on the
 * base chart's own cadence, not a second live feed.
 *
 * It loads through `loadCandleWindow` and `repairStaleTail`, which is the same
 * path a pane's own history takes — so a second instrument gets Wave A's
 * backfill and tail repair rather than whatever happened to be stored.
 *
 * ── Alignment, and the thing that must never be done ───────────────────────
 *
 * Bars are matched by OPEN TIME, never by index. Two instruments have
 * different histories — a newer listing, an exchange outage, a pair that did
 * not trade a particular minute — and lining them up by position would compare
 * Tuesday's BTC with Monday's SOL and call the result a correlation.
 *
 * A bar the second instrument does not have is `na`. It is NOT forward-filled.
 * A forward-filled price is a fabricated observation, and a correlation
 * computed partly from fabrications is a number with no meaning that looks
 * exactly like one that has meaning. The UI says how many bars were missing
 * rather than hiding it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { storedSymbol, tryStoredSymbol } from "./instrument";
import { CancellableRequest, isAbortError, LatestRequest } from "./requestGuard";
import { loadCandleWindow, repairStaleTail } from "./useCandleHistory";
import {
  alignByOpenTime, beta as betaOf, correlation as correlationOf, logReturns,
  normalizedCompare, zscore,
} from "./ta/core";
import type { ChartOverlay } from "./chartSeries";
import type { Candle } from "./types";
import type { Resolution } from "./resolution";
import type { PaneCompare } from "./workspace";

/**
 * The default benchmark.
 *
 * An INSTRUMENT, named as one, rather than a suffix rule that turns "SOLUSDT"
 * into "BTCUSDT" by string surgery. The day a second venue or a second quote
 * asset exists, a suffix rule silently produces a symbol that does not trade;
 * a named instrument produces a clear failure instead.
 */
export const DEFAULT_BENCHMARK = "BTCUSDT";

export interface CompareSeries {
  /** The instrument this series is of, as the canonical stored ticker. */
  symbol: string;
  /** Closes aligned to the base chart's bars; `NaN` where the bar is absent. */
  closes: number[];
  /** How many of the base chart's bars the second instrument does not have. */
  missing: number;
  loading: boolean;
  error: string | null;
}

const EMPTY: CompareSeries = {
  symbol: "", closes: [], missing: 0, loading: false, error: null,
};

/**
 * A second instrument's closes, aligned to `base`.
 *
 * One request per (symbol, interval, depth), through the same loader a pane's
 * own history uses — so a second instrument gets Wave A's backfill and tail
 * repair. It does NOT share a pane's in-memory window: comparing against an
 * instrument already open in another pane costs a request. Saying otherwise
 * would be describing a cache this function does not consult.
 */
export function useCompareSeries(
  base: readonly Candle[], symbol: string, interval: Resolution, bars: number,
  options: { enabled?: boolean } = {}
): CompareSeries {
  const enabled = options.enabled !== false && symbol.trim().length > 0;
  /*
   * What was loaded, and WHAT FOR.
   *
   * The interval and depth are part of the identity, not just the request:
   * switching 1h → 4h with the compared symbol unchanged re-runs the fetch,
   * and until it lands a symbol-only guard still matched — so the previous
   * interval's closes were aligned onto the new grid. Every fourth open time
   * coincides, so the result was a plausible partly-populated series and a
   * fabricated "375 bars missing", rather than an empty one.
   */
  const [raw, setRaw] = useState<
    { symbol: string; interval: Resolution; bars: number; candles: Candle[] } | null
  >(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(new LatestRequest());
  const inFlight = useRef(new CancellableRequest());

  const ticker = useMemo(() => tryStoredSymbol(symbol) ?? "", [symbol]);

  const load = useCallback(async () => {
    if (!enabled || !ticker) { setRaw(null); setError(null); return; }
    const token = seq.current.next();
    const signal = inFlight.current.start();
    setLoading(true);
    setError(null);
    try {
      /*
       * The same loader a pane uses, not a bare fetch.
       *
       * `loadCandleWindow` backfills an instrument whose history was never
       * stored at this depth, and `repairStaleTail` brings a tail that ends
       * hours ago up to the current bar — Wave A's whole point. Calling
       * `api.candles` directly got neither, so comparing against a pair the
       * server had not backfilled produced a mostly-`na` series that the UI
       * reported as "missing bars": true, and reading as a different problem.
       * A stale second series is worse, because a correlation computed against
       * a tail that stopped hours ago looks exactly like one that did not.
       */
      const request = { symbol: ticker, interval, bars };
      const loaded = await loadCandleWindow(request, signal);
      const candles = await repairStaleTail(request, loaded, signal);
      // A response is applied only if it is still the one being waited for —
      // otherwise switching the compared symbol twice quickly leaves the first
      // answer on screen under the second symbol's name.
      if (!seq.current.isCurrent(token)) return;
      setRaw({ symbol: ticker, interval, bars, candles });
    } catch (cause) {
      if (isAbortError(cause)) return;
      if (!seq.current.isCurrent(token)) return;
      setRaw(null);
      setError((cause as Error).message);
    } finally {
      if (seq.current.isCurrent(token)) setLoading(false);
    }
  }, [enabled, ticker, interval, bars]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const controller = inFlight.current;
    const tokens = seq.current;
    return () => { controller.cancel(); tokens.invalidate(); };
  }, []);

  return useMemo(() => {
    // Everything the request was made FOR has to match, not only the symbol.
    if (!raw || raw.symbol !== ticker || raw.interval !== interval || raw.bars !== bars) {
      return { ...EMPTY, symbol: ticker, loading, error };
    }
    const closes = alignByOpenTime(
      base.map((c) => c.openTime),
      raw.candles.map((c) => c.openTime),
      raw.candles.map((c) => c.close));
    const missing = closes.reduce((n, v) => (Number.isNaN(v) ? n + 1 : n), 0);
    return { symbol: ticker, closes, missing, loading, error };
  }, [raw, ticker, interval, bars, base, loading, error]);
}

// ── the three comparisons ──────────────────────────────────────────────────

export interface CompareResult {
  /** One plot per output, aligned to the base chart's bars. */
  plots: Record<string, number[]>;
  /** What the reader is owed about this comparison, or null. */
  notice: string | null;
}

/**
 * Both instruments rebased to 0 % at the first bar where BOTH have a price.
 *
 * Rebasing each at its own first value would start them at different points in
 * time and turn "which outperformed" into an artefact of when each series
 * happened to begin.
 */
export function comparePercent(
  base: readonly Candle[], other: CompareSeries
): CompareResult {
  const closes = base.map((c) => c.close);
  const { base: basePct, other: otherPct, referenceIndex } =
    normalizedCompare(closes, other.closes);
  return {
    plots: { base: basePct, other: otherPct },
    notice: referenceIndex < 0
      ? `${other.symbol} has no bar in common with this chart, so there is nothing to compare.`
      : missingNotice(other),
  };
}

/**
 * Rolling correlation of the two instruments' RETURNS.
 *
 * Returns, not prices. Two prices that both drift upward correlate at nearly 1
 * whatever their movements have in common, which is a fact about drift rather
 * than about the instruments — the number would sit near 1 permanently and
 * tell the reader nothing.
 */
export function compareCorrelation(
  base: readonly Candle[], other: CompareSeries, length: number
): CompareResult {
  const a = logReturns(base.map((c) => c.close));
  const b = logReturns(other.closes);
  return {
    plots: { correlation: correlationOf(a, b, length) },
    notice: missingNotice(other),
  };
}

/**
 * Rolling beta of this chart against the benchmark.
 *
 * Also from returns, for the same reason, and undefined where the benchmark
 * did not move — a beta against a flat benchmark is a division by zero dressed
 * as a number.
 */
export function compareBeta(
  base: readonly Candle[], other: CompareSeries, length: number
): CompareResult {
  const asset = logReturns(base.map((c) => c.close));
  const benchmark = logReturns(other.closes);
  return {
    plots: { beta: betaOf(asset, benchmark, length) },
    notice: missingNotice(other),
  };
}

/**
 * The pair ratio: this instrument priced in units of the other.
 *
 * PRICES here, not returns, because that is what the ratio IS — how many of
 * the second instrument one of the first is worth. It is the one comparison on
 * this list with no window and no parameter: at each bar it is a division, and
 * a bar either instrument is missing is `na` rather than carried forward.
 *
 * Its own pane, always. A ratio near 0.0004 drawn on an axis that runs to
 * 60,000 is a flat line on the floor.
 */
export function compareRatio(
  base: readonly Candle[], other: CompareSeries
): CompareResult {
  const ratio = base.map((candle, i) => {
    const divisor = other.closes[i];
    return divisor !== undefined && Number.isFinite(divisor) && divisor !== 0
      ? candle.close / divisor : Number.NaN;
  });
  return { plots: { ratio }, notice: missingNotice(other) };
}

/**
 * How unusual the pair is right now, against its own recent history.
 *
 * The z-score of the LOG ratio — `ln(A) − ln(B)` — over the rolling window.
 * Three choices in that sentence, each of which changes what the number means:
 *
 *   LOG, because a raw ratio's dispersion scales with its level, so the same
 *   move reads as a larger deviation the higher the ratio has drifted. In logs
 *   a 1 % divergence is the same distance wherever the pair is trading.
 *
 *   A HEDGE RATIO OF ONE. This is the spread of one unit against one unit, not
 *   `ln(A) − β·ln(B)` for a fitted β. A rolling regression hedge would be a
 *   different and more assumption-laden object — it re-fits every bar, so the
 *   series it produces is partly a record of the fit moving rather than of the
 *   pair moving — and calling both "spread" would hide which one was drawn.
 *
 *   Its OWN WINDOW. The z-score says "against the last `length` bars", so a
 *   value of 2 means two standard deviations of that window and nothing about
 *   any longer history. A short window makes everything look extreme; the
 *   window is the user's to choose and is shown in the legend.
 *
 * This is a description of where the pair has been, not a prediction that it
 * returns. Nothing here says the spread is mean-reverting.
 */
export function compareZSpread(
  base: readonly Candle[], other: CompareSeries, length: number
): CompareResult {
  const spread = base.map((candle, i) => {
    const divisor = other.closes[i];
    return divisor !== undefined && divisor > 0 && candle.close > 0
      ? Math.log(candle.close) - Math.log(divisor) : Number.NaN;
  });
  return { plots: { z: zscore(spread, length) }, notice: missingNotice(other) };
}

/**
 * What the reader is owed about a gappy second series.
 *
 * Said out loud rather than hidden, because the alternative to saying it is
 * forward-filling, and the alternative to forward-filling is a reader who does
 * not know their correlation was computed over fewer bars than they asked for.
 */
function missingNotice(other: CompareSeries): string | null {
  if (other.error) return `${other.symbol} could not be loaded: ${other.error}`;
  if (other.missing === 0) return null;
  return `${other.symbol} has no bar for ${other.missing} of these — those bars are ` +
    `left out rather than filled in with an invented price.`;
}

/**
 * Comparing an instrument with itself.
 *
 * Legal, and worth being explicit about: the correlation is 1 and the beta is
 * 1 by construction, which is a useful thing to be able to see rather than an
 * error to refuse. `lib/ta/core` produces those values without a special case,
 * so nothing here needs one either.
 */
export function isSelfCompare(baseSymbol: string, otherSymbol: string): boolean {
  const a = tryStoredSymbol(baseSymbol);
  const b = tryStoredSymbol(otherSymbol);
  return a !== null && a === b;
}

export { storedSymbol };

// ── as chart overlays ──────────────────────────────────────────────────────

/**
 * The comparison a pane is drawing, as chart overlays.
 *
 * Every comparison gets a unit-coherent pane. Percent change cannot share a
 * normal currency axis with raw candles: doing so puts values near zero and
 * prices near 60,000 on one scale and makes both unreadable. Its dedicated
 * pane keeps both rebased lines together on an axis explicitly labelled `%`.
 * Correlation and beta likewise use their own statistical scales.
 */
export function compareOverlays(
  base: readonly Candle[],
  other: CompareSeries,
  mode: PaneCompare["mode"],
  length: number,
  baseSymbol: string
): { overlays: ChartOverlay[]; notice: string | null } {
  if (base.length === 0 || other.symbol === "") return { overlays: [], notice: null };
  const times = base.map((c) => Math.floor(c.openTime / 1000));
  const point = (series: number[]) => times.map((time, i) => ({
    time, value: Number.isFinite(series[i]!) ? series[i]! : null,
  }));
  const instanceId = `compare:${other.symbol}:${mode}`;

  if (mode === "percent") {
    const { plots, notice } = comparePercent(base, other);
    const paneId = instanceId;
    return {
      notice,
      overlays: [
        {
          id: `${instanceId}:base`, title: `${baseSymbol} %`, color: COMPARE_BASE_COLOR,
          width: 2, style: "line", paneId,
          instanceId, instanceTitle: `Percent change vs ${other.symbol}`,
          instanceParams: "% from first shared bar",
          precision: 2, data: point(plots.base!),
        },
        {
          id: `${instanceId}:other`, title: `${other.symbol} %`, color: COMPARE_OTHER_COLOR,
          width: 2, style: "line", paneId,
          instanceId, instanceTitle: `Percent change vs ${other.symbol}`,
          instanceParams: "% from first shared bar",
          precision: 2, data: point(plots.other!),
        },
      ],
    };
  }

  /*
   * Everything else is a statistic on its own scale, so it gets its own pane.
   *
   * One shape for four modes rather than four near-identical blocks: what
   * differs is the arithmetic, the title, how many decimals the number
   * deserves, and — for the z-score — the reference lines that make it
   * readable. A ratio is a price-like number and takes the instrument's own
   * precision; a correlation is between −1 and 1 and takes two.
   */
  const computed = mode === "correlation" ? compareCorrelation(base, other, length)
    : mode === "beta" ? compareBeta(base, other, length)
      : mode === "ratio" ? compareRatio(base, other)
        : compareZSpread(base, other, length);
  const series = Object.values(computed.plots)[0]!;

  const spec = {
    correlation: {
      title: `Correlation ${length}`,
      instance: `Correlation vs ${other.symbol}`,
      params: `${length} bars`, precision: 2, levels: [] as number[],
    },
    beta: {
      title: `Beta ${length}`,
      instance: `Beta vs ${other.symbol}`,
      params: `${length} bars`, precision: 2, levels: [],
    },
    ratio: {
      title: `${baseSymbol} / ${other.symbol}`,
      instance: `${baseSymbol} priced in ${other.symbol}`,
      params: "ratio", precision: 6, levels: [],
    },
    zspread: {
      title: `Z-spread ${length}`,
      instance: `${baseSymbol} / ${other.symbol} spread, z-scored`,
      params: `${length} bars, log ratio`, precision: 2, levels: [2, 0, -2],
    },
    percent: { title: "", instance: "", params: "", precision: 2, levels: [] },
  }[mode];

  const overlays: ChartOverlay[] = [{
    id: `${instanceId}:value`,
    title: spec.title,
    color: COMPARE_OTHER_COLOR,
    width: 2,
    style: "line",
    // Its own pane: none of these is a price on this chart's scale.
    paneId: instanceId,
    instanceId,
    instanceTitle: spec.instance,
    instanceParams: spec.params,
    precision: spec.precision,
    data: point(series),
  }];

  /*
   * The z-score's reference lines.
   *
   * Two standard deviations either side and the mean, because a z-score with
   * no scale beside it is a wiggle: the whole content of the number is how far
   * out it is, and a reader should not have to count gridlines to find out.
   * They are hlines in the same shape a study's levels use, so the price scale
   * and the legend treat them identically.
   */
  for (const level of spec.levels) {
    overlays.push({
      id: `${instanceId}:level:${level}`,
      title: level === 0 ? "0" : `${level > 0 ? "+" : ""}${level}σ`,
      color: COMPARE_LEVEL_COLOR,
      dashed: true,
      lineStyle: "dashed",
      paneId: instanceId,
      instanceId,
      instanceTitle: spec.instance,
      instanceParams: spec.params,
      precision: 2,
      constantValue: level,
      data: times.length > 1
        ? [
            { time: times[0]!, value: level },
            { time: times[times.length - 1]!, value: level },
          ]
        : times.map((time) => ({ time, value: level })),
    });
  }

  return { notice: computed.notice, overlays };
}

/** Present but not the subject: a reference line, not a series. */
const COMPARE_LEVEL_COLOR = "#9c9c9c";

/** The base instrument keeps the chart's own accent; the second gets its own. */
const COMPARE_BASE_COLOR = "#4f8cff";
const COMPARE_OTHER_COLOR = "#f0b90b";
