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
import { datasetKey } from "./liveDataset";
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
  /**
   * What `candles` actually are.
   *
   * While a new window loads, `candles` still hold the PREVIOUS window (so the
   * chart does not blank between two symbols), and this says so. Everything
   * that writes a live bar into the series — the chart's tick path, the
   * merge below — checks against this identity rather than the requested
   * one, which is how a tick for the incoming symbol can never be drawn on
   * the outgoing symbol's bars. See `lib/liveDataset`.
   */
  dataset: HistoryRequest;
  loading: boolean;
  error: string | null;
  /** Merge a live bar (and the bar it closed) into this pane's series. */
  mergeLiveBars: (closed: Candle | null, current: Candle) => void;
  /** Force a reload of this window, bypassing the cache. */
  reload: () => void;
}

interface HeldWindow {
  candles: Candle[];
  dataset: HistoryRequest;
}

/**
 * Fold a live bar (and the bar it closed) into a held window.
 *
 * Returns the same object when nothing changed — including when the bar
 * belongs to a different symbol or interval than the window holds, which is
 * the cross-dataset write this refuses to make. Exported for the tests.
 */
export function mergeLiveBarsInto(
  held: HeldWindow, closed: Candle | null, current: Candle
): HeldWindow {
  if (datasetKey(current) !== datasetKey(held.dataset)) return held;
  const next = held.candles.slice();
  let changed = false;
  for (const bar of [closed, current]) {
    if (!bar || datasetKey(bar) !== datasetKey(held.dataset)) continue;
    const index = next.findIndex((candidate) => candidate.openTime === bar.openTime);
    if (index >= 0) { next[index] = bar; changed = true; }
    else if (next.length === 0 || bar.openTime > next[next.length - 1]!.openTime) {
      next.push(bar); changed = true;
    }
  }
  if (!changed) return held;
  const bars = held.dataset.bars;
  return { candles: next.length > bars ? next.slice(-bars) : next, dataset: held.dataset };
}

export function useCandleHistory(
  request: HistoryRequest, options: { enabled?: boolean } = {}
): CandleHistoryState {
  const enabled = options.enabled !== false;
  const { symbol, interval, bars } = request;
  // Candles and their identity change together, in one state, so a render
  // can never see new candles under an old identity or the reverse.
  const [held, setHeld] = useState<HeldWindow>(() => ({
    candles: candleHistory.peek(request) ?? [],
    dataset: { symbol, interval, bars },
  }));
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
    if (cached) {
      setHeld({ candles: cached, dataset: window_ });
      setError(null); setLoading(false); return;
    }
    const signal = inFlight.current.start();
    setLoading(true);
    setError(null);
    try {
      const data = await candleHistory.load(window_, loadCandleWindow, signal);
      // The response is applied ONLY if it is still the one being waited for.
      if (!requestSeq.current.isCurrent(token)) return;
      setHeld({ candles: data, dataset: window_ });
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
    setHeld((existing) => mergeLiveBarsInto(existing, closed, current));
    // Keep the shared window fresh so a pane opened a moment later does not
    // paint a bar that has already closed. Scoped by the BAR's own identity,
    // never by this pane's current request, which may be ahead of the bar.
    if (closed) candleHistory.applyLiveBar(closed.symbol, closed.interval, closed);
    candleHistory.applyLiveBar(current.symbol, current.interval, current);
  }, []);

  const reload = useCallback(() => {
    candleHistory.invalidate({ symbol, interval, bars });
    setReloadNonce((n) => n + 1);
  }, [symbol, interval, bars]);

  return useMemo(
    () => ({ candles: held.candles, dataset: held.dataset, loading, error, mergeLiveBars, reload }),
    [held, loading, error, mergeLiveBars, reload]
  );
}

export type { Interval };
