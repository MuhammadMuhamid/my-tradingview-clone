"use client";
import { useEffect, useRef, useState } from "react";
import { api, type MarketTrade } from "./api";
import {
  aggregateTradeStreamName, marketStreams, singleStreamPath,
} from "./marketStream";
import { canonicalDisplayParts } from "./instrument";

export interface MarketTradesState {
  trades: MarketTrade[];
  loading: boolean;
  error: string | null;
}

interface RawAggregateTrade { a?: number; p?: string; q?: string; T?: number; m?: boolean }

/** Historical + live ordered public executions for trade-driven charts. */
export function useMarketTrades(symbol: string, enabled: boolean, replayToMs?: number | null, scopeKey = ""): MarketTradesState {
  const [state, setState] = useState<MarketTradesState>({ trades: [], loading: false, error: null });
  const replayMode = replayToMs != null;
  const tapeRef = useRef<Map<number, MarketTrade>>(new Map());
  const loadedToRef = useRef(Number.NEGATIVE_INFINITY);
  const keyRef = useRef<string | null>(null);
  const modeRef = useRef<boolean>(replayMode);
  useEffect(() => {
    const parts = canonicalDisplayParts(symbol);
    const providerSymbol = parts?.venue === "BINANCE" && parts.base && parts.quote
      ? `${parts.base}${parts.quote}` : symbol;
    if (!enabled || !/^[A-Z0-9]{2,24}$/i.test(providerSymbol)) {
      tapeRef.current.clear(); loadedToRef.current = Number.NEGATIVE_INFINITY; keyRef.current = null;
      modeRef.current = replayMode;
      setState({ trades: [], loading: false, error: enabled ? "Trade data is unavailable for this venue." : null });
      return;
    }
    const controller = new AbortController();
    let disposed = false;
    let reload = 0;
    let repairing = false;
    const tape = tapeRef.current;
    const lifecycleKey = `${providerSymbol}|${scopeKey}|${enabled}`;
    if (keyRef.current !== lifecycleKey) {
      tapeRef.current.clear(); loadedToRef.current = Number.NEGATIVE_INFINITY; keyRef.current = lifecycleKey;
    }
    if (replayMode && !modeRef.current) {
      // A replay session has its own deterministic tape. Do not let a live
      // tail loaded immediately before entry make an earlier horizon appear
      // covered; refill the bounded window around the chosen cursor.
      tape.clear(); loadedToRef.current = Number.NEGATIVE_INFINITY;
    }
    modeRef.current = replayMode;
    const horizon = () => replayToMs != null && Number.isFinite(replayToMs) ? replayToMs : Date.now();
    const merge = (rows: MarketTrade[]): MarketTrade[] => {
      for (const row of rows) {
        if (!Number.isFinite(row.timestamp) || !Number.isFinite(row.price) || !(row.quantity > 0)) continue;
        if (row.id !== undefined) tape.set(row.id, row); else tape.set((row.timestamp * 1e3) + tape.size, row);
      }
      const cutoff = replayMode ? horizon() : Number.POSITIVE_INFINITY;
      return [...tape.values()].filter((row) => row.timestamp <= cutoff)
        .sort((a, b) => a.timestamp - b.timestamp || (a.id ?? 0) - (b.id ?? 0))
        .slice(-50_000);
    };
    const fetchRange = async (from: number, to: number): Promise<void> => {
      if (!(to > from)) return;
      const rows = await api.marketTrades(providerSymbol, from, to, 50_000, controller.signal);
      const tail = rows[rows.length - 1];
      if (rows.length >= 50_000 && tail && tail.timestamp < to) {
        throw new Error("Trade history is partial: provider page limit reached before the requested horizon.");
      }
      for (const row of rows) {
        if (row.id !== undefined && !tape.has(row.id)) tape.set(row.id, row);
      }
      loadedToRef.current = Math.max(loadedToRef.current, to);
    };
    const load = async (): Promise<void> => {
      const generation = ++reload;
      setState((current) => ({ ...current, loading: true, error: null }));
      try {
        const to = horizon();
        if (!Number.isFinite(loadedToRef.current)) {
          await fetchRange(Math.max(0, to - 30 * 60_000), to);
        } else if (replayMode && to > loadedToRef.current) {
          // Replay stepped forward: fetch only the newly exposed interval.
          await fetchRange(Math.max(0, loadedToRef.current), to);
        } else if (!replayMode) {
          await fetchRange(Math.max(0, to - 30 * 60_000), to);
        }
        if (!disposed && generation === reload) {
          const trades = merge([]);
          setState({ trades, loading: false, error: trades.length === 0 ? "Trade data is unavailable for the requested replay window." : null });
        }
      } catch (error) {
        if (!disposed && generation === reload && !controller.signal.aborted) {
          setState({ trades: [], loading: false, error: (error as Error).message });
        }
      } finally { repairing = false; }
    };
    void load();

    const stream = aggregateTradeStreamName(providerSymbol);
    const release = replayMode ? () => {} : marketStreams.subscribe(`trades:${providerSymbol.toUpperCase()}`, singleStreamPath(stream), {
      onMessage: (data) => {
        let raw: RawAggregateTrade;
        try { raw = JSON.parse(data) as RawAggregateTrade; } catch { return; }
        const id = raw.a, timestamp = raw.T, price = Number(raw.p), quantity = Number(raw.q);
        if (!Number.isInteger(id) || !Number.isFinite(timestamp) || !Number.isFinite(price)
          || !(quantity > 0)) return;
        if (replayMode && timestamp! > horizon()) return;
        setState((current) => {
          const last = current.trades[current.trades.length - 1];
          if (last && id! <= last.id) return current;
          if (last && id! !== last.id + 1) {
            // A missed execution invalidates range and footprint aggregation;
            // discard the partial append and refill the bounded tape.
            if (!repairing) {
              repairing = true;
              queueMicrotask(() => { if (!disposed) void load(); });
            }
            return { ...current, loading: true, error: "Repairing a gap in the trade tape…" };
          }
          const trade: MarketTrade = {
            id: id!, timestamp: timestamp!, price, quantity,
            aggressor: raw.m === true ? "sell" : "buy",
          };
          tape.set(trade.id, trade);
          const trades = merge([]);
          return { trades: trades.length > 50_000 ? trades.slice(-50_000) : trades,
            loading: false, error: null };
        });
      },
    });
    return () => { disposed = true; controller.abort(); release(); };
  }, [symbol, enabled, replayMode, replayToMs, scopeKey]);

  return state;
}
