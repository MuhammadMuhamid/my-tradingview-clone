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

export interface WatchlistTicker {
  last: number;
  chg: number;
  chgPct: number;
  /** `stream` once a frame has arrived for this symbol; `seed` before then. */
  source: "seed" | "stream";
}

interface RawMiniTicker {
  data?: { s: string; c: string; o: string };
}

export function watchlistStreamKey(symbols: readonly string[]): string {
  return `watchlist|${symbols.map((s) => s.toUpperCase()).sort().join(",")}`;
}

export function tickerFrom(last: number, open: number, source: WatchlistTicker["source"]): WatchlistTicker {
  return { last, chg: last - open, chgPct: open ? ((last - open) / open) * 100 : 0, source };
}

const IDLE: StreamState = { status: "idle", origin: null, attempt: 0, everLive: false, refused: [] };

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
  const keep = new Set(symbols.map((s) => s.toUpperCase()));
  const next: Record<string, WatchlistTicker> = {};
  for (const [symbol, ticker] of Object.entries(current)) if (keep.has(symbol)) next[symbol] = ticker;
  return next;
}

export function useWatchlistTickers(symbols: readonly string[]): {
  tickers: Record<string, WatchlistTicker>;
  stream: StreamState;
} {
  const [tickers, setTickers] = useState<Record<string, WatchlistTicker>>({});
  const [stream, setStream] = useState<StreamState>(IDLE);
  // Identity by content, so a re-rendered parent with the same list does not
  // re-open the socket.
  const key = useMemo(() => watchlistStreamKey(symbols), [symbols]);
  const list = useMemo(() => symbols.map((s) => s.toUpperCase()), [symbols]);

  // Seed: one same-origin request per symbol-set change. A stream tick that
  // arrives first is never overwritten by the slower seed.
  useEffect(() => {
    setTickers((current) => retainTickers(current, list));
    if (list.length === 0) return;
    const controller = new AbortController();
    void api.tickers(list, controller.signal).then((rows) => {
      if (controller.signal.aborted) return;
      setTickers((current) => {
        const next = { ...current };
        for (const row of rows) {
          if (next[row.symbol]?.source === "stream") continue;
          next[row.symbol] = tickerFrom(row.last, row.open, "seed");
        }
        return next;
      });
    }).catch(() => { /* the stream, or the next seed, fills the rows */ });
    return () => controller.abort();
  }, [list]);

  useEffect(() => {
    if (list.length === 0) { setStream(IDLE); return; }
    const path = combinedStreamPath(list.map(miniTickerStreamName));
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
        setTickers((t) => ({ ...t, [row.s]: tickerFrom(last, open, "stream") }));
      },
    });
    return release;
  }, [key, list]);

  return { tickers, stream };
}
