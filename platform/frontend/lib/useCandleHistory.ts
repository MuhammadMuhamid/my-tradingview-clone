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
import { describeFailure, type FailureCopy } from "./errorCopy";
import { canonicalDisplayParts, isCanonicalInstrumentId, isEquityInstrumentId, isTraditionalInstrumentId } from "./instrument";
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
  /**
   * What to TELL the user, in the user's own vocabulary.
   *
   * TVP7: this used to carry a provider's raw exception text straight to a
   * full-width red band across the top of the chart, so a perfectly working
   * chart could be captioned "Streaming unavailable; using REST refresh.
   * fixture server has no route for GET /api/market/v1/stream/instrument%3Av1
   * %3ABINANCE%3Aspot%3ABTC%3AUSDT%3AUSDT%3Aspot". Two things were wrong with
   * that and only one of them was the wording: a stream that has fallen back
   * to polling is a DEGRADED state, not a failure, and painting it the same
   * red as "this chart has no data" teaches a trader to ignore both.
   *
   * So the sentence here is the one a user can act on, `errorDetail` carries
   * the technical cause for the tooltip and for a bug report, and `errorLevel`
   * says which of the two this is. Nothing is hidden — it moved.
   */
  error: string | null;
  /** The provider's own words, for a tooltip and for diagnostics. */
  errorDetail: string | null;
  /** `error` means the chart cannot be trusted; `notice` means it is degraded. */
  errorLevel: "error" | "notice" | null;
  /**
   * The newest bar held is slots behind the interval grid and the repair could
   * not close the distance — the window is real but behind the market.
   *
   * Recomputed with the bars themselves, so a live tick that reaches the
   * current slot clears it without anything else having to notice.
   */
  stale: boolean;
  /**
   * The provider's live CANDLE stream for a canonical instrument is delivering
   * frames right now. False before the first frame, while stale or
   * reconnecting, and for a legacy Binance ticker (whose live price comes from
   * `lib/useLivePrice` instead).
   */
  streamLive: boolean;
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

const STREAM_INTERVALS: Readonly<Record<string, readonly Resolution[]>> = {
  COINBASE: ["5m"],
  BYBIT: ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d"],
  OKX: ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d"],
  KRAKEN: ["1m", "5m", "15m", "30m", "1h", "4h", "1d"],
  KUCOIN: ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h", "1d"],
  GATEIO: ["1m", "5m", "15m", "30m", "1h", "4h", "8h", "1d"],
  HYPERLIQUID: ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "8h", "12h", "1d"],
};

/** Avoid asking for a stream the provider contract says cannot exist. */
export function canonicalCandleStreamSupported(symbol: string, interval: Resolution): boolean {
  const parts = canonicalDisplayParts(symbol);
  if (!parts || !["spot", "perpetual", "future"].includes(parts.type)) return false;
  if (parts.venue === "BINANCE") return true;
  return STREAM_INTERVALS[parts.venue]?.includes(interval) === true;
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
  request: HistoryRequest,
  options: {
    enabled?: boolean;
    /**
     * IO-A2: whether this reader wants the window kept CURRENT, as well as
     * loaded. Default true.
     *
     * `enabled` gated everything at once, so the only way to stop a live merge
     * was to stop loading, and a caller that needed the bars but not the ticks
     * could not say so. The chart page is exactly that caller during replay:
     * `useLivePrice` has been mounted `{ enabled: !replayActive }` for as long
     * as replay has existed, and the comment above `activeHistory` asserted it
     * "never receives live klines" — which was true of a legacy symbol and
     * false of a canonical one, where this hook runs its own provider stream
     * and a fifteen-second REST tail.
     *
     * A replay is a window onto history. Streaming new bars into it is work
     * nobody asked for even when it is harmless, and it was not harmless.
     */
    live?: boolean;
  } = {}
): CandleHistoryState {
  const enabled = options.enabled !== false;
  const live = enabled && options.live !== false;
  const { symbol, interval, bars } = request;
  // Candles and their identity change together, in one state, so a render
  // can never see new candles under an old identity or the reverse.
  const [held, setHeld] = useState<HeldWindow>(
    () => heldWindow(candleHistory.peek(request) ?? [], { symbol, interval, bars }));
  const [loading, setLoading] = useState(false);
  /*
   * REV-UX-01: the headline and the cause are SEPARATE, and always have been
   * in this hook's own documented contract above — the stream-warning path
   * honoured it and the hard-error path did not, so a 502 from the candles
   * route put `invalid SOLUSDT 15m backfill: invalid_close_time` across the
   * top of the plot as the most prominent sentence on the page.
   *
   * Holding one object rather than two pieces of state is what makes that
   * impossible rather than merely discouraged: there is no way to set the
   * headline without having said what the cause was.
   */
  const [failure, setFailure] = useState<FailureCopy | null>(null);
  const [streamWarning, setStreamWarning] =
    useState<{ message: string; detail: string | null } | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  /*
   * Which dataset's stream last delivered a frame, rather than a bare flag: a
   * key cannot go stale across a symbol or interval switch — another dataset's
   * stream simply is not this one's — so nothing has to remember to reset it.
   */
  const [liveStreamKey, setLiveStreamKey] = useState<string | null>(null);
  const streamLive = liveStreamKey === datasetKey({ symbol: request.symbol, interval: request.interval });

  const requestSeq = useRef(new LatestRequest());
  const inFlight = useRef(new CancellableRequest());

  const load = useCallback(async () => {
    if (!enabled) return;
    const window_ = { symbol, interval, bars };
    const token = requestSeq.current.next();
    const cached = candleHistory.peek(window_);
    if (cached) {
      setHeld(heldWindow(cached, window_));
      setFailure(null); setLoading(false); return;
    }
    // X5 credential/subscription-gated markets commonly fail before returning
    // their first bar. Keeping the previous symbol's window under the new FX,
    // futures or index legend would falsely relabel those prices. Clear only
    // this market family at the identity transition; the explicit feed error
    // then appears over an empty plot rather than over somebody else's bars.
    if (isTraditionalInstrumentId(symbol)) setHeld(heldWindow([], window_));
    const signal = inFlight.current.start();
    setLoading(true);
    setFailure(null);
    try {
      const data = await candleHistory.load(window_, loadCandleWindow, signal);
      // The response is applied ONLY if it is still the one being waited for.
      if (!requestSeq.current.isCurrent(token)) return;
      setHeld(heldWindow(data, window_));
    } catch (cause) {
      // An abort is this pane superseding itself, not a failure to report.
      if (isAbortError(cause)) return;
      if (!requestSeq.current.isCurrent(token)) return;
      setFailure(describeFailure(cause, "Price history"));
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
    if (!live || typeof window === "undefined" || isCanonicalInstrumentId(symbol)) return;
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
  }, [symbol, interval, live]);

  /* Canonical instruments stream through the provider contract. A slow REST
   * tail poll remains as an explicit degraded-mode fallback. */
  const canonicalStreamReady = datasetKey(held.dataset) === datasetKey({ symbol, interval }) &&
    held.candles.length > 0;
  useEffect(() => {
    if (!live || !isCanonicalInstrumentId(symbol) || !canonicalStreamReady ||
      !canonicalCandleStreamSupported(symbol, interval)) return;
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
      } catch (cause) {
        if (!isAbortError(cause)) {
          setStreamWarning({
            message: "The latest bars could not be refreshed.",
            detail: (cause as Error).message,
          });
        }
      }
    };
    void api.marketStream(symbol, "candle", interval, controller.signal).then((config) => {
      if (stopped) return;
      release = subscribeCanonicalMarket(config, "candle", interval, {
        onEvent: (event) => {
          if (event.kind !== "candle") return;
          setStreamWarning(null);
          setLiveStreamKey(datasetKey({ symbol, interval }));
          mergeLiveBars(null, event.candle);
        },
        onState: (state) => {
          if (state.status === "live") setStreamWarning(null);
          else setLiveStreamKey(null);
          if (state.status === "stale" || (state.status === "reconnecting" && state.everLive)) {
            setStreamWarning({
              message: "Live updates are behind — refreshing on a timer.",
              detail: "The provider's stream went stale. The REST tail refresh remains active, "
                + "so bars keep arriving, just less promptly.",
            });
          }
        },
      });
    }).catch((cause) => {
      if (!isAbortError(cause)) {
        setStreamWarning({
          message: "Live updates unavailable — refreshing on a timer.",
          detail: (cause as Error).message,
        });
      }
    });
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 15_000);
    return () => { stopped = true; controller.abort(); release?.(); window.clearInterval(timer); };
  }, [live, symbol, interval, canonicalStreamReady, mergeLiveBars]);

  return useMemo(
    () => ({
      candles: held.candles, dataset: held.dataset, stale: held.stale,
      loading,
      error: failure?.headline ?? streamWarning?.message ?? null,
      errorDetail: failure?.detail ?? (failure ? null : streamWarning?.detail ?? null),
      errorLevel: failure ? "error" : streamWarning ? "notice" : null,
      streamLive,
      mergeLiveBars, reload,
    }),
    [held, loading, failure, streamWarning, streamLive, mergeLiveBars, reload]
  );
}

export type { Resolution };
