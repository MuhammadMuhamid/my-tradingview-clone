"use client";
/**
 * Last price and 24h change for the symbols a watchlist shows.
 *
 * ── Two sources, one row ────────────────────────────────────────────────────
 *
 * The rows used to be blank until the first `@miniTicker` frame arrived, and
 * stayed blank forever on a network where the stream host is fenced. Now the
 * list is SEEDED through this app's own server (`/api/symbols/tickers`, which
 * proxies Binance's public 24h ticker through the backend's configured
 * market-data host) and then kept moving by the stream. A seeded value is a
 * real exchange quote a few seconds old, and the row says which it has.
 *
 * ── Stream lifecycle ────────────────────────────────────────────────────────
 *
 * The socket is `lib/marketStream`'s: origin fallback, bounded reconnect and
 * the silence watchdog come with it. The old per-component socket had none of
 * those — a closed socket stayed closed until the symbol set changed.
 */
import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import {
  combinedStreamPath, marketStreams, miniTickerStreamName, type StreamState,
} from "./marketStream";
import { canonicalDisplayParts, isCanonicalInstrumentId } from "./instrument";
import { subscribeCanonicalMarket } from "./canonicalMarketStream";

export interface WatchlistTicker {
  last: number;
  chg: number;
  chgPct: number;
  /** `stream` once a frame has arrived for this symbol; `seed` before then. */
  source: "seed" | "stream" | "poll";
  stale?: boolean;
  changeKnown?: boolean;
  providerId?: string;
}

interface RawMiniTicker {
  data?: { s: string; c: string; o: string };
}

export function watchlistStreamKey(symbols: readonly string[]): string {
  return `watchlist|${symbols.map((s) => s.toUpperCase()).sort().join(",")}`;
}

export function tickerFrom(last: number, open: number, source: WatchlistTicker["source"]): WatchlistTicker {
  return { last, chg: last - open, chgPct: open ? ((last - open) / open) * 100 : 0,
    source, changeKnown: true };
}

const IDLE: StreamState = { status: "idle", origin: null, attempt: 0, everLive: false, refused: [] };
export const MAX_CANONICAL_WATCHLIST_STREAMS = 12;
const DIRECT_STREAM_VENUES = new Set(["COINBASE", "BYBIT", "OKX", "KRAKEN", "KUCOIN", "GATEIO"]);

/** Catalog-only/auth-gated markets deliberately stay on the shared snapshot.
 * Asking their stream endpoint only to receive an expected 422 turns an
 * honest capability limitation into noisy console/network failures. */
export function directWatchlistStreamSupported(instrument: string): boolean {
  const parts = canonicalDisplayParts(instrument);
  return Boolean(parts && DIRECT_STREAM_VENUES.has(parts.venue) &&
    (parts.type === "spot" || parts.type === "perpetual" || parts.type === "future"));
}

/**
 * The rows that survive a change of membership: only symbols still on the
 * list. A symbol removed and later re-added must not come back wearing the
 * quote it had when it left — a `stream`-tagged value the seed would then
 * refuse to refresh — so its entry is dropped with it, and the row is `—`
 * until the seed or the next frame gives it a current value.
 */
export function retainTickers(
  current: Record<string, WatchlistTicker>, symbols: readonly string[],
): Record<string, WatchlistTicker> {
  const keep = new Set(symbols.map((s) => isCanonicalInstrumentId(s) ? s : s.toUpperCase()));
  const next: Record<string, WatchlistTicker> = {};
  for (const [symbol, ticker] of Object.entries(current)) if (keep.has(symbol)) next[symbol] = ticker;
  return next;
}

export function useWatchlistTickers(symbols: readonly string[]): {
  tickers: Record<string, WatchlistTicker>;
  stream: StreamState;
  issues: string[];
} {
  const [tickers, setTickers] = useState<Record<string, WatchlistTicker>>({});
  const [stream, setStream] = useState<StreamState>(IDLE);
  const [canonicalStates, setCanonicalStates] = useState<Record<string, StreamState>>({});
  const [issues, setIssues] = useState<string[]>([]);
  const [canonicalStreamEligible, setCanonicalStreamEligible] = useState<string[]>([]);
  // Identity by content, so a re-rendered parent with the same list does not
  // re-open the socket.
  const contentKey = symbols.map((s) => isCanonicalInstrumentId(s) ? s : s.toUpperCase()).join("\u0000");
  const list = useMemo(() => contentKey ? contentKey.split("\u0000") : [], [contentKey]);
  const canonical = useMemo(() => list.filter((s) => s.toLowerCase().startsWith("instrument:v1:")), [list]);
  const legacy = useMemo(() => list.filter((s) => !s.toLowerCase().startsWith("instrument:v1:")), [list]);
  // Migrated Binance Spot rows keep the economical combined mini-ticker
  // socket. Canonical persistence must not turn one legacy socket into one
  // socket per row after reload.
  const combined = useMemo(() => list.flatMap((storageKey) => {
    const parts = canonicalDisplayParts(storageKey);
    if (parts) return parts.venue === "BINANCE" && parts.type === "spot"
      ? [{ storageKey, providerSymbol: `${parts.base}${parts.quote}` }] : [];
    return [{ storageKey, providerSymbol: storageKey.toUpperCase() }];
  }), [list]);
  const combinedByProviderSymbol = useMemo(() => new Map(combined.map((item) =>
    [item.providerSymbol, item.storageKey])), [combined]);
  const key = useMemo(() => watchlistStreamKey(combined.map((item) => item.storageKey)), [combined]);
  const directCanonicalKey = canonicalStreamEligible.join("\u0000");
  const directCanonical = useMemo(() => directCanonicalKey ? directCanonicalKey.split("\u0000") : [],
    [directCanonicalKey]);
  const canonicalLive = useMemo(() => directCanonical.slice(0, MAX_CANONICAL_WATCHLIST_STREAMS), [directCanonical]);

  // Seed: one same-origin request per symbol-set change. A stream tick that
  // arrives first is never overwritten by the slower seed.
  useEffect(() => {
    setTickers((current) => retainTickers(current, list));
    setCanonicalStreamEligible([]);
    if (list.length === 0) return;
    const controller = new AbortController();
    const legacyRead = (legacy.length > 0 ? api.tickers(legacy, controller.signal) : Promise.resolve([]))
      .then((rows) => ({ rows, error: null as string | null }))
      .catch((cause) => ({ rows: [], error: `Binance ticker refresh failed: ${(cause as Error).message}` }));
    const canonicalRead = (canonical.length > 0 ? api.marketTickers(canonical, controller.signal) : Promise.resolve(null))
      .then((market) => ({ market, error: null as string | null }))
      .catch((cause) => ({ market: null, error: `Provider ticker refresh failed: ${(cause as Error).message}` }));
    void Promise.all([legacyRead, canonicalRead]).then(([legacyResult, canonicalResult]) => {
      if (controller.signal.aborted) return;
      const rows = legacyResult.rows;
      const market = canonicalResult.market;
      setCanonicalStreamEligible(market?.providers.flatMap((group) => group.observations)
        .map((row) => row.canonicalInstrumentId).filter(directWatchlistStreamSupported) ?? []);
      setIssues([...(market?.errors ?? []).map((item) => `${item.providerId}: ${item.error}`),
        ...((market?.missing ?? []).length ? [`${market!.missing.length} saved instrument(s) unavailable`] : []),
        ...[legacyResult.error, canonicalResult.error].filter((item): item is string => item !== null)]);
      setTickers((current) => {
        const next = { ...current };
        for (const row of rows) {
          if (next[row.symbol]?.source === "stream") continue;
          next[row.symbol] = tickerFrom(row.last, row.open, "seed");
        }
        for (const group of market?.providers ?? []) for (const row of group.observations) {
          const last = row.values.last;
          if (last === undefined || !Number.isFinite(last)) continue;
          next[row.canonicalInstrumentId] = { ...tickerFrom(last, last, "seed"),
            changeKnown: false, stale: row.freshness.state === "stale", providerId: group.providerId };
        }
        return next;
      });
    });
    return () => controller.abort();
  }, [list, legacy, canonical]);

  useEffect(() => {
    if (combined.length === 0) { setStream(IDLE); return; }
    const path = combinedStreamPath(combined.map((item) => miniTickerStreamName(item.providerSymbol)));
    const release = marketStreams.subscribe(key, path, {
      onState: setStream,
      onMessage: (data) => {
        let msg: RawMiniTicker;
        try { msg = JSON.parse(data) as RawMiniTicker; }
        catch { return; /* a malformed frame is dropped; the next one replaces it */ }
        const row = msg.data;
        if (!row) return;
        const last = parseFloat(row.c), open = parseFloat(row.o);
        if (!Number.isFinite(last) || !Number.isFinite(open)) return;
        const storageKey = combinedByProviderSymbol.get(row.s);
        if (!storageKey) return;
        setTickers((t) => ({ ...t, [storageKey]: tickerFrom(last, open, "stream") }));
      },
    });
    return release;
  }, [key, combined, combinedByProviderSymbol]);

  useEffect(() => {
    if (directCanonical.length === 0) return;
    const controller = new AbortController();
    const releases: Array<() => void> = [];
    let stopped = false;
    for (const instrument of canonicalLive) {
      void api.marketStream(instrument, "ticker", "1m", controller.signal).then((config) => {
        if (stopped) return;
        releases.push(subscribeCanonicalMarket(config, "ticker", "1m", {
          onState: (state) => setCanonicalStates((current) => ({ ...current, [instrument]: state })),
          onEvent: (event) => {
            if (event.kind !== "ticker") return;
            setTickers((current) => {
              const previous = current[instrument];
              const reference = previous && previous.changeKnown !== false ? previous.last - previous.chg : event.last;
              return { ...current, [instrument]: { ...tickerFrom(event.last, reference, "stream"),
                changeKnown: previous?.changeKnown ?? false, stale: false, providerId: config.providerId } };
            });
          },
        }));
      }).catch((cause) => {
        if (!controller.signal.aborted) setIssues((current) => [...new Set([...current,
          `Stream unavailable for ${instrument}: ${(cause as Error).message}`])]);
      });
    }
    const poll = () => void api.marketTickers(canonical, controller.signal).then((market) => {
      setIssues([...market.errors.map((item) => `${item.providerId}: ${item.error}`),
        ...(market.missing.length ? [`${market.missing.length} saved instrument(s) unavailable`] : [])]);
      setTickers((current) => {
        const next = { ...current };
        for (const group of market.providers) for (const row of group.observations) {
          const last = row.values.last;
          if (last !== undefined && Number.isFinite(last)) {
            const previous = next[row.canonicalInstrumentId];
            const reference = previous && previous.changeKnown !== false ? previous.last - previous.chg : last;
            next[row.canonicalInstrumentId] = { ...tickerFrom(last, reference, "poll"),
              changeKnown: previous?.changeKnown ?? false, stale: row.freshness.state === "stale",
              providerId: group.providerId };
          }
        }
        return next;
      });
    }).catch((cause) => setIssues([`Ticker refresh failed: ${(cause as Error).message}`]));
    const timer = window.setInterval(poll, 15_000);
    return () => { stopped = true; controller.abort(); for (const release of releases) release();
      setCanonicalStates({}); window.clearInterval(timer); };
  }, [canonical, directCanonical, canonicalLive]);

  const states = [
    ...(combined.length > 0 && stream.status !== "idle" ? [stream] : []),
    ...Object.values(canonicalStates),
  ];
  const aggregateStream = states.some((state) => state.status === "stale")
    ? states.find((state) => state.status === "stale")!
    : states.some((state) => state.status === "reconnecting")
      ? states.find((state) => state.status === "reconnecting")!
      : states.some((state) => state.status === "connecting" || state.status === "open")
        ? states.find((state) => state.status === "connecting" || state.status === "open")!
        : states.some((state) => state.status === "live") ? states.find((state) => state.status === "live")! : IDLE;
  const boundedIssues = directCanonical.length > MAX_CANONICAL_WATCHLIST_STREAMS
    ? [...issues, `${directCanonical.length - MAX_CANONICAL_WATCHLIST_STREAMS} additional instruments use the shared 15-second provider snapshot to avoid excess subscriptions.`]
    : issues;
  return { tickers, stream: aggregateStream, issues: boundedIssues };
}
