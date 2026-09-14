"use client";
/**
 * The daily-bar series the details block's 30-day average and Performance
 * tiles are computed from.
 *
 * ── Why a hook of its own ──────────────────────────────────────────────────
 *
 * `useWatchlistTickers` answers for the whole LIST at 24h resolution; this
 * answers for the SELECTED row at daily resolution. Folding the second into
 * the first would put a 400-bar read per instrument behind a hook that runs
 * for every row in the panel — eight reads to paint one block.
 *
 * One request per selected symbol, cached for the life of the page so moving
 * back and forth between two rows does not re-read either, refreshed every
 * five minutes (a daily bar does not move faster than that), and aborted when
 * the selection changes so a slow answer for the row the user has left cannot
 * land on the row they are looking at.
 */
import { useEffect, useState } from "react";
import { api } from "./api";
import { isAbortError } from "./requestGuard";
import type { StatBar } from "./instrumentStats";

/** How many daily bars to ask for: a 1Y period needs 366 of them. */
const DAILY_BARS = 400;
const REFRESH_MS = 5 * 60_000;

interface CacheEntry {
  bars: StatBar[];
  at: number;
}

/** Module-scoped, so two panels asking about one symbol make one request. */
const cache = new Map<string, CacheEntry>();

/** Test seam: the cache is a module singleton and outlives a test. */
export function resetInstrumentStatsCache(): void {
  cache.clear();
}

export interface InstrumentStatsState {
  bars: StatBar[] | null;
  /** Set when the series could not be read at all, for the `—`'s tooltip. */
  unavailable: string | null;
}

export function useInstrumentStats(symbol: string | null): InstrumentStatsState {
  const [state, setState] = useState<InstrumentStatsState>(
    () => ({ bars: symbol ? cache.get(symbol)?.bars ?? null : null, unavailable: null }));

  useEffect(() => {
    if (!symbol) { setState({ bars: null, unavailable: null }); return undefined; }
    const controller = new AbortController();
    let stopped = false;

    const read = (force: boolean): void => {
      const hit = cache.get(symbol);
      if (hit && !force && Date.now() - hit.at < REFRESH_MS) {
        setState({ bars: hit.bars, unavailable: null });
        return;
      }
      // A cached-but-stale series is shown while the refresh is in flight;
      // blanking it would make the block flicker every five minutes.
      if (hit) setState({ bars: hit.bars, unavailable: null });
      void api.candles(symbol, "1d", DAILY_BARS, controller.signal).then((rows) => {
        if (stopped) return;
        const bars: StatBar[] = rows.map((bar) => ({
          openTime: bar.openTime, close: bar.close, volume: bar.volume,
        }));
        cache.set(symbol, { bars, at: Date.now() });
        setState({ bars, unavailable: null });
      }).catch((cause: unknown) => {
        if (stopped || isAbortError(cause) || controller.signal.aborted) return;
        /*
         * REV-UX-01 applies here too: the provider's own words are not the
         * copy. What the block needs to know is only whether it may compute,
         * and the reason it names is the product's own sentence.
         */
        setState((current) => ({ bars: current.bars,
          unavailable: "Daily bars for this instrument could not be read." }));
      });
    };

    read(false);
    const timer = window.setInterval(() => read(true), REFRESH_MS);
    return () => { stopped = true; controller.abort(); window.clearInterval(timer); };
  }, [symbol]);

  return state;
}
