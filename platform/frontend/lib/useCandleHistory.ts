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
  barsBehind, claimTailRepair, isTailStale, releaseTailRepair, spliceTail,
  TAIL_TOLERANCE_BARS, tailRepairRange,
} from "./historyFreshness";
import { marketFeed } from "./marketFeed";
import { datasetKey } from "./liveDataset";
import { CancellableRequest, isAbortError, LatestRequest } from "./requestGuard";
import type { Candle } from "./types";
import { resolutionMs, type Resolution } from "./resolution";
import { isCanonicalInstrumentId, isEquityInstrumentId, isTraditionalInstrumentId } from "./instrument";
import { subscribeCanonicalMarket } from "./canonicalMarketStream";

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

  let backfilled = false;
  if (!isCanonicalInstrumentId(symbol) && data.length < Math.min(bars, 500) * 0.98) {
    backfilled = true;
    // Not enough history stored: backfill, then fetch only what is missing
    // rather than the whole window again.
    const lookbackMs = Math.ceil(bars * 1.1) * resolutionMs(interval);
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

  /*
   * A symbol with nothing stored has just had its whole window backfilled and
   * still came back empty — the venue has no bars for it. Asking the tail
   * repair to fetch the same window again would double the cost of the worst
   * case the depth path already handled, and would find the same nothing.
   */
  if (backfilled && data.length === 0) return data;
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
  // A stock/ETF night's empty UTC buckets are a market closure, not a broken
  // 24/7 stream. Server-side calendar completeness remains the authority.
  if (isEquityInstrumentId(symbol)) return data;
  const now = Date.now();
  if (!isTailStale(data, interval, now)) return data;
  if (!claimTailRepair(historyKey(request), now)) return data;

  const last = data.length > 0 ? data[data.length - 1]!.openTime : null;
  const range = tailRepairRange(last, interval, now, bars);
  try {
    if (!isCanonicalInstrumentId(symbol)) {
      await api.backfill(
        symbol, interval,
        new Date(range.from).toISOString(), new Date(range.to).toISOString()
      );
    }
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
  return { candles, dataset, stale: isEquityInstrumentId(dataset.symbol)
    ? false : isTailStale(candles, dataset.interval, now) };
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
      /*
       * A bar far past the tail is the FIRST frame after a sleep, an outage or
       * a backend restart, and appending it would stitch the series across a
       * multi-hour hole — then make the window measure as current, because its
       * newest bar now is. Refuse the append and say the window is behind
       * instead: the repair path is what closes a hole, not the tick that
       * revealed it.
       */
      const behind = barsBehind(next[next.length - 1]?.openTime ?? null,
        held.dataset.interval, bar.openTime);
      if (next.length > 0 && behind > TAIL_TOLERANCE_BARS) {
        return held.stale ? held : { ...held, stale: true };
      }
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
  const [streamWarning, setStreamWarning] = useState<string | null>(null);
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
    // X5 credential/subscription-gated markets commonly fail before returning
    // their first bar. Keeping the previous symbol's window under the new FX,
    // futures or index legend would falsely relabel those prices. Clear only
    // this market family at the identity transition; the explicit feed error
    // then appears over an empty plot rather than over somebody else's bars.
    if (isTraditionalInstrumentId(symbol)) setHeld(heldWindow([], window_));
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
    const window_ = { symbol, interval, bars };
    candleHistory.invalidate(window_);
    // A reload is the user (or a recovering feed) saying "try again now", so
    // the repair cooldown is released for this window rather than making the
    // refresh a no-op after one failed attempt.
    releaseTailRepair(historyKey(window_));
    setReloadNonce((n) => n + 1);
  }, [symbol, interval, bars]);

  /*
   * A feed coming back to life is the moment a window that fell behind can be
   * repaired.
   *
   * A chart left open across a sleep, an outage or a backend restart is never
   * re-loaded by anything: `load` runs on symbol, interval, depth and an
   * explicit reload, and none of those happen. The stream registry already
   * tells every consumer when its socket reaches `live`, so that transition is
   * the trigger — and only while the window is actually behind, so a normal
   * reconnect on a healthy chart costs nothing.
   *
   * Bounded twice over: once per transition rather than per frame, and the
   * repair itself still claims the per-window cooldown.
   */
  const staleRef = useRef(held.stale);
  staleRef.current = held.stale;
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  useEffect(() => {
    if (!enabled || typeof window === "undefined" || isCanonicalInstrumentId(symbol)) return;
    let seenFirst = false;
    let wasLive = false;
    return marketFeed.subscribe(symbol, interval, {
      onStatus: (status) => {
        const live = status === "live" || status === "open";
        // The first callback is the CURRENT state, delivered synchronously on
        // subscribe. It is not a transition, and acting on it would re-fetch
        // the window the load that just ran has already repaired or failed to.
        if (seenFirst && live && !wasLive && staleRef.current) reloadRef.current();
        seenFirst = true;
        wasLive = live;
      },
    });
  }, [symbol, interval, enabled]);

  /* Canonical instruments stream through the provider contract. A slow REST
   * tail poll remains as an explicit degraded-mode fallback. */
  useEffect(() => {
    if (!enabled || !isCanonicalInstrumentId(symbol)) return;
    let stopped = false;
    let release: (() => void) | null = null;
    const controller = new AbortController();
    const refresh = async () => {
      const now = Date.now();
      try {
        const tail = await api.candlesRange(symbol, interval,
          now - resolutionMs(interval) * 2, now, 3, controller.signal);
        if (stopped || tail.length === 0) return;
        const current = tail[tail.length - 1]!;
        mergeLiveBars(tail.length > 1 ? tail[tail.length - 2]! : null, current);
      } catch (cause) { if (!isAbortError(cause)) setStreamWarning(`Live tail unavailable: ${(cause as Error).message}`); }
    };
    void api.marketStream(symbol, "candle", interval, controller.signal).then((config) => {
      if (stopped) return;
      release = subscribeCanonicalMarket(config, "candle", interval, {
        onEvent: (event) => {
          if (event.kind !== "candle") return;
          setStreamWarning(null);
          mergeLiveBars(null, event.candle);
        },
        onState: (state) => {
          if (state.status === "live") setStreamWarning(null);
          else if (state.status === "stale" || (state.status === "reconnecting" && state.everLive)) {
            setStreamWarning("Provider stream is stale; REST tail refresh remains active.");
          }
        },
      });
    }).catch((cause) => {
      if (!isAbortError(cause)) setStreamWarning(`Streaming unavailable; using REST refresh. ${(cause as Error).message}`);
    });
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 15_000);
    return () => { stopped = true; controller.abort(); release?.(); window.clearInterval(timer); };
  }, [enabled, symbol, interval, mergeLiveBars]);

  return useMemo(
    () => ({
      candles: held.candles, dataset: held.dataset, stale: held.stale,
      loading, error: error ?? streamWarning, mergeLiveBars, reload,
    }),
    [held, loading, error, streamWarning, mergeLiveBars, reload]
  );
}

export type { Resolution };
