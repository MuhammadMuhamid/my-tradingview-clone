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
export function useMarketTrades(symbol: string, enabled: boolean, replayToMs?: number | null): MarketTradesState {
  const [state, setState] = useState<MarketTradesState>({ trades: [], loading: false, error: null });
  const replayTargetRef = useRef<number | null>(replayToMs ?? null);
  const previousReplayMode = useRef(replayToMs != null);
  const previousSymbol = useRef(symbol);

  const replayMode = replayToMs != null;
  useEffect(() => {
    if (replayMode && (!previousReplayMode.current || previousSymbol.current !== symbol)) replayTargetRef.current = replayToMs ?? null;
    previousReplayMode.current = replayMode;
    previousSymbol.current = symbol;
    const parts = canonicalDisplayParts(symbol);
    const providerSymbol = parts?.venue === "BINANCE" && parts.base && parts.quote
      ? `${parts.base}${parts.quote}` : symbol;
    if (!enabled || !/^[A-Z0-9]{2,24}$/i.test(providerSymbol)) {
      setState({ trades: [], loading: false, error: enabled ? "Trade data is unavailable for this venue." : null });
      return;
    }
    const controller = new AbortController();
    let disposed = false;
    let reload = 0;
    let repairing = false;
    const load = async (): Promise<void> => {
      const generation = ++reload;
      setState((current) => ({ ...current, loading: true, error: null }));
      try {
        // A bounded recent tape is preferable to a silent partial seven-day
        // range on liquid markets. The response is ordered and capped at 50k.
        const to = replayMode && replayTargetRef.current && Number.isFinite(replayTargetRef.current)
          ? replayTargetRef.current : Date.now();
        const rows = await api.marketTrades(providerSymbol, to - 30 * 60_000, to, 50_000, controller.signal);
        if (!disposed && generation === reload) setState({ trades: rows, loading: false, error: null });
      } catch (error) {
        if (!disposed && generation === reload && !controller.signal.aborted) {
          setState({ trades: [], loading: false, error: (error as Error).message });
        }
      } finally { repairing = false; }
    };
    void load();

    const stream = aggregateTradeStreamName(providerSymbol);
    const release = marketStreams.subscribe(`trades:${providerSymbol.toUpperCase()}`, singleStreamPath(stream), {
      onMessage: (data) => {
        let raw: RawAggregateTrade;
        try { raw = JSON.parse(data) as RawAggregateTrade; } catch { return; }
        const id = raw.a, timestamp = raw.T, price = Number(raw.p), quantity = Number(raw.q);
        if (!Number.isInteger(id) || !Number.isFinite(timestamp) || !Number.isFinite(price)
          || !(quantity > 0)) return;
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
          const trades = [...current.trades, trade];
          return { trades: trades.length > 50_000 ? trades.slice(-50_000) : trades,
            loading: false, error: null };
        });
      },
    });
    return () => { disposed = true; controller.abort(); release(); };
  // replayToMs is intentionally sampled only when entering replay; subsequent
  // horizon steps clip the already-loaded tape without refetching.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, enabled, replayMode]);

  return state;
}
