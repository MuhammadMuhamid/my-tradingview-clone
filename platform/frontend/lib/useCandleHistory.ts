"use client";
/**
 * A pane's candles, loaded through the shared history cache.
 *
 * Every pane calls this. Panes on the same symbol, interval and depth share one
 * request and one array; panes on different windows are isolated by the cache
 * key. The stale-response guard is the same `LatestRequest` token comparison
 * the single-chart loader used, and for the same reason: a user who switches
 * away and back lands on identical parameters, so comparing parameters instead
 * of tokens would wrongly accept the first, slower response.
 *
 * The backfill repair also moved here from the page. The old split pane had a
 * copy of it that re-requested the *whole* window after backfilling instead of
 * only the missing head, and had no abort and no stale-response guard at all.
 * There is now one implementation, so a second pane cannot drift from it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { candleHistory, type HistoryRequest } from "./candleHistory";
import { CancellableRequest, isAbortError, LatestRequest } from "./requestGuard";
import { INTERVAL_MS, type Candle, type Interval } from "./types";

/**
 * Fetch a window, repairing thin history once.
 *
 * Exported so the acceptance tests can drive the cache with a stub instead of
 * this, and so the repair rule has one home.
 */
export async function loadCandleWindow(
  request: HistoryRequest, signal: AbortSignal
): Promise<Candle[]> {
  const { symbol, interval, bars } = request;
  let data = await api.candles(symbol, interval, bars, signal);
  if (data.length >= Math.min(bars, 500) * 0.98) return data;

  // Not enough history stored: backfill, then fetch only what is missing
  // rather than the whole window again.
  const lookbackMs = Math.ceil(bars * 1.1) * INTERVAL_MS[interval];
  await api.backfill(
    symbol, interval,
    new Date(Date.now() - lookbackMs).toISOString(),
    new Date().toISOString()
  );
  const haveFrom = data.length > 0 ? data[0]!.openTime : Date.now();
  const missing = await api.candlesRange(
    symbol, interval, Date.now() - lookbackMs, haveFrom - 1, bars, signal
  );
  data = missing.length > 0
    ? [...missing, ...data]
    : await api.candles(symbol, interval, bars, signal);
  return data;
}

export interface CandleHistoryState {
  candles: Candle[];
  loading: boolean;
  error: string | null;
  /** Merge a live bar (and the bar it closed) into this pane's series. */
  mergeLiveBars: (closed: Candle | null, current: Candle) => void;
  /** Force a reload of this window, bypassing the cache. */
  reload: () => void;
}

export function useCandleHistory(
  request: HistoryRequest, options: { enabled?: boolean } = {}
): CandleHistoryState {
  const enabled = options.enabled !== false;
  const { symbol, interval, bars } = request;
  const [candles, setCandles] = useState<Candle[]>(
    () => candleHistory.peek(request) ?? []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  const requestSeq = useRef(new LatestRequest());
  const inFlight = useRef(new CancellableRequest());

  const load = useCallback(async () => {
    if (!enabled) return;
    const window_ = { symbol, interval, bars };
    const token = requestSeq.current.next();
    const cached = candleHistory.peek(window_);
    if (cached) { setCandles(cached); setError(null); setLoading(false); return; }
    const signal = inFlight.current.start();
    setLoading(true);
    setError(null);
    try {
      const data = await candleHistory.load(window_, loadCandleWindow, signal);
      // The response is applied ONLY if it is still the one being waited for.
      if (!requestSeq.current.isCurrent(token)) return;
      setCandles(data);
    } catch (cause) {
      // An abort is this pane superseding itself, not a failure to report.
      if (isAbortError(cause)) return;
      if (!requestSeq.current.isCurrent(token)) return;
      setError((cause as Error).message);
    } finally {
      if (requestSeq.current.isCurrent(token)) setLoading(false);
    }
    // `reloadNonce` is a deliberate trigger, not a value this body reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, interval, bars, enabled, reloadNonce]);

  useEffect(() => { void load(); }, [load]);

  // Unmounting must not leave a request running against a dead pane. The cache
  // only cancels upstream when the LAST waiter has gone, so a pane closing
  // mid-load cannot pull the data out from under another pane.
  useEffect(() => {
    const controller = inFlight.current;
    const seq = requestSeq.current;
    return () => { controller.cancel(); seq.invalidate(); };
  }, []);

  const mergeLiveBars = useCallback((closed: Candle | null, current: Candle) => {
    setCandles((existing) => {
      const next = existing.slice();
      for (const bar of [closed, current]) {
        if (!bar) continue;
        const index = next.findIndex((candidate) => candidate.openTime === bar.openTime);
        if (index >= 0) next[index] = bar;
        else if (next.length === 0 || bar.openTime > next[next.length - 1]!.openTime) next.push(bar);
      }
      return next.length > bars ? next.slice(-bars) : next;
    });
    // Keep the shared window fresh so a pane opened a moment later does not
    // paint a bar that has already closed.
    if (closed) candleHistory.applyLiveBar(symbol, interval, closed);
    candleHistory.applyLiveBar(symbol, interval, current);
  }, [symbol, interval, bars]);

  const reload = useCallback(() => {
    candleHistory.invalidate({ symbol, interval, bars });
    setReloadNonce((n) => n + 1);
  }, [symbol, interval, bars]);

  return useMemo(
    () => ({ candles, loading, error, mergeLiveBars, reload }),
    [candles, loading, error, mergeLiveBars, reload]
  );
}

export type { Interval };
