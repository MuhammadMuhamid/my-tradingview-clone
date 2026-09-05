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
import { candleHistory, historyKey, type HistoryRequest } from "./candleHistory";
import {
  claimTailRepair, isTailStale, spliceTail, tailRepairRange,
} from "./historyFreshness";
import { datasetKey } from "./liveDataset";
import { CancellableRequest, isAbortError, LatestRequest } from "./requestGuard";
import { INTERVAL_MS, type Candle, type Interval } from "./types";

/**
 * Fetch a window, repairing thin history once and a stale tail once.
 *
 * Two different defects, deliberately checked in this order.
 *
 * DEPTH: too few bars for the requested window. Repaired by backfilling the
 * whole lookback, which is what a chart with no stored history needs.
 *
 * FRESHNESS: enough bars, but the newest of them is slots behind the interval
 * grid — a machine that slept, a backend that was down, a pair last backfilled
 * yesterday. Count says nothing about this, which is exactly why the chart
 * could show a complete-looking series that ended hours ago. Repaired by
 * fetching only the missing TAIL: see `lib/historyFreshness`.
 *
 * A depth repair already backfills through `now`, so a window that took that
 * path is normally fresh by the time freshness is asked about. When it is not
 * — an upstream that answered short — the tail repair is still bounded and
 * still claimed against the cooldown, so neither path can loop.
 *
 * Exported so the acceptance tests can drive the cache with a stub instead of
 * this, and so both repair rules have one home.
 */
export async function loadCandleWindow(
  request: HistoryRequest, signal: AbortSignal
): Promise<Candle[]> {
  const { symbol, interval, bars } = request;
  let data = await api.candles(symbol, interval, bars, signal);

  if (data.length < Math.min(bars, 500) * 0.98) {
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
  }

  return repairStaleTail(request, data, signal);
}

/**
 * Bring a long-but-stale window up to the interval grid, once.
 *
 * Separate from the loader so the rule can be tested against a stubbed `api`
 * without a cache, a hook or a chart. Returns the window unchanged when it is
 * already current, when the cooldown has not elapsed, or when the repair
 * itself failed — the last of which is deliberate: a failed refresh leaves
 * honest stale data on screen and lets `useCandleHistory` say so, rather than
 * throwing away a real window or presenting the failure as a fresh load.
 */
export async function repairStaleTail(
  request: HistoryRequest, data: Candle[], signal: AbortSignal
): Promise<Candle[]> {
  const { symbol, interval, bars } = request;
  const now = Date.now();
  if (!isTailStale(data, interval, now)) return data;
  if (!claimTailRepair(historyKey(request), now)) return data;

  const last = data.length > 0 ? data[data.length - 1]!.openTime : null;
  const range = tailRepairRange(last, interval, now, bars);
  try {
    await api.backfill(
      symbol, interval,
      new Date(range.from).toISOString(), new Date(range.to).toISOString()
    );
    const tail = await api.candlesRange(
      symbol, interval, range.from, range.to, bars, signal
    );
    return spliceTail(data, tail, bars);
  } catch (cause) {
    // An abort is this pane superseding itself and must propagate; a genuine
    // upstream failure is not a reason to discard the window we do have.
    if (isAbortError(cause)) throw cause;
    return data;
  }
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
  /**
   * The newest bar held is slots behind the interval grid and the repair could
   * not close the distance — the window is real but behind the market.
   *
   * Recomputed with the bars themselves, so a live tick that reaches the
   * current slot clears it without anything else having to notice.
   */
  stale: boolean;
  /** Merge a live bar (and the bar it closed) into this pane's series. */
  mergeLiveBars: (closed: Candle | null, current: Candle) => void;
  /** Force a reload of this window, bypassing the cache. */
  reload: () => void;
}

export interface HeldWindow {
  candles: Candle[];
  dataset: HistoryRequest;
  /**
   * Carried in the same object as the bars it describes, so no render can see
   * a fresh series under a stale flag or the reverse.
   */
  stale: boolean;
}

/**
 * One window, with its freshness measured against the grid at `now`.
 *
 * Exported so a test can build a held window the same way the hook does,
 * rather than hand-assembling one whose `stale` flag disagrees with its bars.
 */
export function heldWindow(
  candles: Candle[], dataset: HistoryRequest, now = Date.now()
): HeldWindow {
  return { candles, dataset, stale: isTailStale(candles, dataset.interval, now) };
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
  // A tick that reaches the current slot is exactly what makes a stale window
  // current again, so freshness is re-measured here rather than left behind.
  return heldWindow(next.length > bars ? next.slice(-bars) : next, held.dataset);
}

export function useCandleHistory(
  request: HistoryRequest, options: { enabled?: boolean } = {}
): CandleHistoryState {
  const enabled = options.enabled !== false;
  const { symbol, interval, bars } = request;
  // Candles and their identity change together, in one state, so a render
  // can never see new candles under an old identity or the reverse.
  const [held, setHeld] = useState<HeldWindow>(
    () => heldWindow(candleHistory.peek(request) ?? [], { symbol, interval, bars }));
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
      setHeld(heldWindow(cached, window_));
      setError(null); setLoading(false); return;
    }
    const signal = inFlight.current.start();
    setLoading(true);
    setError(null);
    try {
      const data = await candleHistory.load(window_, loadCandleWindow, signal);
      // The response is applied ONLY if it is still the one being waited for.
      if (!requestSeq.current.isCurrent(token)) return;
      setHeld(heldWindow(data, window_));
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
    () => ({
      candles: held.candles, dataset: held.dataset, stale: held.stale,
      loading, error, mergeLiveBars, reload,
    }),
    [held, loading, error, mergeLiveBars, reload]
  );
}

export type { Interval };
