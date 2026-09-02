/**
 * The live best bid and ask for one symbol.
 *
 * ── Which authority this is, and why ────────────────────────────────────────
 *
 * The same one the chart and the watchlist already use: Binance's public market
 * stream, straight from the browser, already allowed by this app's
 * `connect-src`. `@bookTicker` pushes exactly best-bid and best-ask and nothing
 * else — it is a quote feed, not an order book, so this adds no depth or DOM
 * infrastructure and keeps no book state.
 *
 * It is deliberately NOT derived from candle OHLC. A spread invented from a
 * last-trade price would be a fabrication presented as a quote, and the whole
 * point of showing a spread is to tell the operator something true about the
 * cost of crossing it. When the stream is unavailable this hook returns null,
 * and the ticket says it has no quote rather than showing a made-up one.
 */
import { useEffect, useState } from "react";

export interface BookQuote { bid: number; ask: number; at: number }

export function useBookQuote(symbol: string): BookQuote | null {
  const [quote, setQuote] = useState<BookQuote | null>(null);

  useEffect(() => {
    // A symbol change invalidates the previous quote immediately. Showing the
    // last instrument's bid beside this instrument's ticket would be worse
    // than showing nothing.
    setQuote(null);
    if (!symbol || typeof window === "undefined") return;
    let closed = false;
    const ws = new WebSocket(
      `wss://stream.binance.com:9443/ws/${symbol.toLowerCase()}@bookTicker`);
    ws.onmessage = (event) => {
      if (closed) return;
      try {
        const msg = JSON.parse(event.data as string) as { b?: string; a?: string };
        const bid = Number(msg.b);
        const ask = Number(msg.a);
        if (bid > 0 && ask > 0) setQuote({ bid, ask, at: Date.now() });
      } catch { /* ignore a malformed tick; the next one replaces it */ }
    };
    ws.onerror = () => { if (!closed) setQuote(null); };
    return () => { closed = true; ws.close(); };
  }, [symbol]);

  return quote;
}
