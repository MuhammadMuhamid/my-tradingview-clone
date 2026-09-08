"use client";
/**
 * Bars for several instruments at once, for the correlation table.
 *
 * ── Why this is not `useCompareSeries` in a loop ───────────────────────────
 *
 * That hook exists to align ONE second instrument to a base chart's bars, and
 * calling it n times would need n hooks, which React does not allow to vary.
 * More importantly it returns closes already aligned to a base chart, and a
 * matrix has no base: every instrument in it is a peer, and the alignment is
 * done pairwise inside `lib/correlationMatrix` precisely so that one thin
 * history cannot rewrite every other cell.
 *
 * ── What it costs, and what bounds it ──────────────────────────────────────
 *
 * One request per instrument, through the same loader a pane's own history
 * takes — so each gets the backfill and stale-tail repair a chart gets, rather
 * than whatever happened to be stored. That is not free, so:
 *
 *   the set is CAPPED, and the panel says when it truncated a longer list;
 *   requests run a few at a time rather than all at once;
 *   a change of symbol, interval or depth cancels what is in flight;
 *   nothing loads at all while the panel is closed.
 *
 * A symbol that fails to load is reported by name and left out of the table.
 * It is not retried in a loop and it does not empty the table: eleven
 * instruments that answered are still a useful matrix.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { tryStoredSymbol } from "./instrument";
import { CancellableRequest, isAbortError, LatestRequest } from "./requestGuard";
import { loadCandleWindow, repairStaleTail } from "./useCandleHistory";
import type { MatrixSeries } from "./correlationMatrix";
import type { Resolution } from "./resolution";

/**
 * How many instruments one table may cover.
 *
 * Twelve is a request per instrument and 66 pairs, which is both readable on
 * screen and defensible as a cost. A longer watchlist is truncated and said to
 * be, rather than quietly opening forty requests.
 */
export const MAX_CORRELATION_SYMBOLS = 12;

/** How many of those requests are in flight at once. */
const CONCURRENCY = 3;

export interface CorrelationSet {
  series: MatrixSeries[];
  loading: boolean;
  /** Exact request identity the series (or loading state) belongs to. */
  key: string;
  interval: Resolution | null;
  bars: number;
  /** Instruments that could not be loaded, and why. */
  errors: { symbol: string; message: string }[];
  /** How many instruments were dropped for being past the cap. */
  truncated: number;
}

const EMPTY: CorrelationSet = {
  series: [], loading: false, key: "", interval: null, bars: 0,
  errors: [], truncated: 0,
};

export function useCorrelationSet(
  symbols: readonly string[], interval: Resolution, bars: number,
  options: { enabled?: boolean } = {}
): CorrelationSet {
  const enabled = options.enabled !== false;

  /*
   * Canonical, deduped and capped, as ONE string.
   *
   * A string rather than an array because the effect below must re-run when
   * the SET changes and not when the caller happens to build a new array — a
   * watchlist re-render would otherwise reload every instrument in the table.
   */
  const wanted = useMemo(() => {
    const seen: string[] = [];
    for (const raw of symbols) {
      const ticker = tryStoredSymbol(raw);
      if (ticker && !seen.includes(ticker)) seen.push(ticker);
    }
    return seen;
  }, [symbols]);
  const key = wanted.slice(0, MAX_CORRELATION_SYMBOLS).join(",");
  const truncated = Math.max(0, wanted.length - MAX_CORRELATION_SYMBOLS);

  const [state, setState] = useState<CorrelationSet>(EMPTY);
  const seq = useRef(new LatestRequest());
  const inFlight = useRef(new CancellableRequest());

  const load = useCallback(async () => {
    const list = key.length > 0 ? key.split(",") : [];
    if (!enabled || list.length === 0) {
      setState({ ...EMPTY, key, interval, bars, truncated });
      return;
    }
    const token = seq.current.next();
    const signal = inFlight.current.start();
    // Identity and values move together. Retaining the old series here made a
    // 1h matrix appear under a new 15m heading until this request completed.
    setState({
      series: [], loading: true, key, interval, bars, errors: [], truncated,
    });

    const series: MatrixSeries[] = [];
    const errors: { symbol: string; message: string }[] = [];
    let cursor = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = cursor++;
        const symbol = list[index];
        if (symbol === undefined) return;
        try {
          const request = { symbol, interval, bars };
          const loaded = await loadCandleWindow(request, signal);
          const candles = await repairStaleTail(request, loaded, signal);
          series.push({
            symbol,
            openTimes: candles.map((c) => c.openTime),
            closes: candles.map((c) => c.close),
          });
        } catch (cause) {
          if (isAbortError(cause)) return;
          errors.push({ symbol, message: (cause as Error).message });
        }
      }
    };

    try {
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, list.length) }, worker));
    } catch (cause) {
      if (!isAbortError(cause)) throw cause;
    }
    // A response is applied only if it is still the one being waited for:
    // switching interval twice quickly must not leave the first answer on
    // screen under the second interval's heading.
    if (!seq.current.isCurrent(token)) return;
    setState({
      // Back into the order asked for. The workers finish out of order, and a
      // table whose rows moved between refreshes would be unreadable.
      series: list.flatMap((symbol) => series.filter((s) => s.symbol === symbol)),
      key,
      interval,
      bars,
      errors,
      loading: false,
      truncated,
    });
  }, [enabled, key, interval, bars, truncated]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const controller = inFlight.current;
    const tokens = seq.current;
    return () => { controller.cancel(); tokens.invalidate(); };
  }, []);

  return state;
}
