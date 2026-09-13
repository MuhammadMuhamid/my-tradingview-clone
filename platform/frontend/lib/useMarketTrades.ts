"use client";
import { useEffect, useRef, useState } from "react";
import { api, type MarketTrade } from "./api";
import { aggregateTradeStreamName, marketStreams, singleStreamPath } from "./marketStream";
import { canonicalDisplayParts } from "./instrument";

export interface MarketTradesState {
  /** Identity of the execution data currently published by this hook. */
  identity: string | null;
  trades: MarketTrade[];
  loading: boolean;
  error: string | null;
}

interface RawAggregateTrade { a?: number; p?: string; q?: string; T?: number; m?: boolean }

/** Historical + live ordered public executions for trade-driven charts. */
export function useMarketTrades(symbol: string, enabled: boolean, replayToMs?: number | null, scopeKey = ""): MarketTradesState {
  const replayMode = replayToMs != null;
  const parts = canonicalDisplayParts(symbol);
  const providerSymbol = parts?.venue === "BINANCE" && parts.base && parts.quote ? `${parts.base}${parts.quote}` : symbol;
  // Raw executions may be reusable across horizons, but published state is not.
  const normalizedHorizon = replayMode && Number.isFinite(replayToMs) ? String(replayToMs) : "";
  const identity = `${providerSymbol}|${symbol}|${scopeKey}|${replayMode ? "replay" : "live"}|${normalizedHorizon}`;
  const [state, setState] = useState<MarketTradesState>({ identity: null, trades: [], loading: false, error: null });
  const tapeRef = useRef<Map<number, MarketTrade>>(new Map());
  const loadedToRef = useRef(Number.NEGATIVE_INFINITY);
  const baseKeyRef = useRef<string | null>(null);
  const modeRef = useRef<boolean | null>(null);
  const generationRef = useRef(0);

  useEffect(() => {
    const generation = ++generationRef.current;
    const isCurrent = (): boolean => generationRef.current === generation;
    if (!enabled || !/^[A-Z0-9]{2,24}$/i.test(providerSymbol)) {
      tapeRef.current.clear(); loadedToRef.current = Number.NEGATIVE_INFINITY; baseKeyRef.current = null; modeRef.current = replayMode;
      setState({ identity, trades: [], loading: false, error: enabled ? "Trade data is unavailable for this venue." : null });
      return;
    }
    const controller = new AbortController();
    let disposed = false;
    let repairing = false;
    const tape = tapeRef.current;
    const lifecycleKey = `${providerSymbol}|${symbol}|${scopeKey}`;
    const previousBase = baseKeyRef.current;
    const baseChanged = previousBase !== null && previousBase !== lifecycleKey;
    const modeChanged = modeRef.current !== null && modeRef.current !== replayMode;
    if (baseKeyRef.current !== lifecycleKey || modeChanged) {
      tape.clear(); loadedToRef.current = Number.NEGATIVE_INFINITY;
    }
    baseKeyRef.current = lifecycleKey;
    modeRef.current = replayMode;
    if (replayMode && (baseChanged || modeChanged)) {
      tape.clear(); loadedToRef.current = Number.NEGATIVE_INFINITY;
    }
    // Reset published state before replacement history settles.
    setState({ identity, trades: [], loading: true, error: null });

    const horizon = () => replayToMs != null && Number.isFinite(replayToMs) ? replayToMs : Date.now();
    const merge = (rows: MarketTrade[]): MarketTrade[] => {
      for (const row of rows) {
        if (!Number.isFinite(row.timestamp) || !Number.isFinite(row.price) || !(row.quantity > 0)) continue;
        if (row.id !== undefined) tape.set(row.id, row); else tape.set((row.timestamp * 1e3) + tape.size, row);
      }
      const cutoff = replayMode ? horizon() : Number.POSITIVE_INFINITY;
      return [...tape.values()].filter((row) => row.timestamp <= cutoff)
        .sort((a, b) => a.timestamp - b.timestamp || (a.id ?? 0) - (b.id ?? 0)).slice(-50_000);
    };
    const fetchRange = async (from: number, to: number): Promise<void> => {
      if (!(to > from)) return;
      const rows = await api.marketTrades(providerSymbol, from, to, 50_000, controller.signal);
      if (!isCurrent() || controller.signal.aborted) return;
      const tail = rows[rows.length - 1];
      if (rows.length >= 50_000 && tail && tail.timestamp < to) throw new Error("Trade history is partial: provider page limit reached before the requested horizon.");
      for (const row of rows) if (row.id !== undefined && !tape.has(row.id)) tape.set(row.id, row);
      if (isCurrent()) loadedToRef.current = Math.max(loadedToRef.current, to);
    };
    const load = async (): Promise<void> => {
      try {
        const to = horizon();
        if (!Number.isFinite(loadedToRef.current)) await fetchRange(Math.max(0, to - 30 * 60_000), to);
        else if (replayMode && to > loadedToRef.current) await fetchRange(Math.max(0, loadedToRef.current), to);
        else if (!replayMode) await fetchRange(Math.max(0, to - 30 * 60_000), to);
        if (!disposed && isCurrent()) {
          const trades = merge([]);
          setState({ identity, trades, loading: false, error: trades.length === 0 ? "Trade data is unavailable for the requested replay window." : null });
        }
      } catch (error) {
        if (!disposed && isCurrent() && !controller.signal.aborted) setState({ identity, trades: [], loading: false, error: (error as Error).message });
      } finally { if (isCurrent()) repairing = false; }
    };
    void load();

    const stream = aggregateTradeStreamName(providerSymbol);
    const release = replayMode ? () => {} : marketStreams.subscribe(`trades:${providerSymbol.toUpperCase()}`, singleStreamPath(stream), {
      onMessage: (data) => {
        if (disposed || !isCurrent()) return;
        let raw: RawAggregateTrade;
        try { raw = JSON.parse(data) as RawAggregateTrade; } catch { return; }
        const id = raw.a, timestamp = raw.T, price = Number(raw.p), quantity = Number(raw.q);
        if (!Number.isInteger(id) || !Number.isFinite(timestamp) || !Number.isFinite(price) || !(quantity > 0)) return;
        if (replayMode && timestamp! > horizon()) return;
        setState((current) => {
          if (disposed || !isCurrent() || current.identity !== identity) return current;
          const last = current.trades[current.trades.length - 1];
          if (last && id! <= last.id) return current;
          if (last && id! !== last.id + 1) {
            if (!repairing) { repairing = true; queueMicrotask(() => { if (!disposed && isCurrent()) void load(); }); }
            return { ...current, loading: true, error: "Repairing a gap in the trade tape…" };
          }
          const trade: MarketTrade = { id: id!, timestamp: timestamp!, price, quantity, aggressor: raw.m === true ? "sell" : "buy" };
          tape.set(trade.id, trade);
          const trades = merge([]);
          return { identity, trades: trades.length > 50_000 ? trades.slice(-50_000) : trades, loading: false, error: null };
        });
      },
    });
    return () => { disposed = true; controller.abort(); release(); };
  }, [symbol, enabled, replayMode, replayToMs, scopeKey, identity, providerSymbol]);

  // Effects run after paint; this gate covers the pre-effect commit too.
  return state.identity === identity ? state : { identity, trades: [], loading: enabled, error: null };
}
