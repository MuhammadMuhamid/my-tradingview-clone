"use client";
/**
 * The live best bid and ask for one symbol.
 *
 * ── Which authority this is, and why ────────────────────────────────────────
 *
 * The same one the chart and the watchlist already use: Binance's public market
 * stream, straight from the browser, through the one registry in
 * `lib/marketStream` (so it gets the origin fallback, the reconnect ladder and
 * the silence watchdog the chart's kline feed has). `@bookTicker` pushes exactly
 * best-bid and best-ask and nothing else — it is a quote feed, not an order
 * book, so this adds no depth or DOM infrastructure and keeps no book state.
 *
 * It is deliberately NOT derived from candle OHLC. A spread invented from a
 * last-trade price would be a fabrication presented as a quote, and the whole
 * point of showing a spread is to tell the operator something true about the
 * cost of crossing it. When the stream is unavailable — refused, dropped or
 * silent — the quote is null, and the ticket says it has no quote rather than
 * showing a stale or made-up one.
 */
import { useEffect, useState } from "react";
import {
  bookTickerStreamName, marketStreams, singleStreamPath, type StreamState,
} from "./marketStream";

export interface BookQuote { bid: number; ask: number; at: number }

export function bookQuoteStreamKey(symbol: string): string {
  return `book|${symbol.toUpperCase()}`;
}

export function useBookQuote(symbol: string): BookQuote | null {
  return useBookQuoteState(symbol).quote;
}

export function useBookQuoteState(symbol: string): { quote: BookQuote | null; stream: StreamState } {
  const [quote, setQuote] = useState<BookQuote | null>(null);
  const [stream, setStream] = useState<StreamState>(
    { status: "idle", origin: null, attempt: 0, everLive: false, refused: [] });

  useEffect(() => {
    // A symbol change invalidates the previous quote immediately. Showing the
    // last instrument's bid beside this instrument's ticket would be worse
    // than showing nothing.
    setQuote(null);
    if (!symbol || typeof window === "undefined") return;
    const release = marketStreams.subscribe(
      bookQuoteStreamKey(symbol), singleStreamPath(bookTickerStreamName(symbol)), {
        onState: (state) => {
          setStream(state);
          // A quote is only as current as the socket that delivered it.
          if (state.status === "reconnecting" || state.status === "stale") setQuote(null);
        },
        onMessage: (data) => {
          try {
            const msg = JSON.parse(data) as { b?: string; a?: string };
            const bid = Number(msg.b);
            const ask = Number(msg.a);
            if (bid > 0 && ask > 0) setQuote({ bid, ask, at: Date.now() });
          } catch { /* ignore a malformed tick; the next one replaces it */ }
        },
      });
    return release;
  }, [symbol]);

  return { quote, stream };
}
