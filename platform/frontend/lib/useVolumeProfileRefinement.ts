"use client";
/**
 * Bounded lower-timeframe evidence for Volume Profile.
 *
 * A chart bar cannot locate its volume inside its own high/low. Profiles may
 * therefore request the finest native interval that covers the selected range
 * without exceeding a hard bar budget. Requests are debounced, cancellable,
 * replay-clipped by the caller, and held in a small LRU measured in bars.
 */
import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import {
  NATIVE_RESOLUTIONS, NATIVE_RESOLUTION_MS, resolutionMs, type Resolution,
} from "./resolution";
import { isAbortError } from "./requestGuard";
import type { Candle } from "./types";

export const MAX_PROFILE_REFINEMENT_BARS = 5_000;
export const MAX_PROFILE_CACHE_BARS = 20_000;
const DEBOUNCE_MS = 120;

export interface ProfileRefinementPlan {
  sourceInterval: Resolution;
  fromMs: number;
  toMs: number;
  expectedBars: number;
  key: string;
}

export interface ProfileRefinementState {
  plan: ProfileRefinementPlan | null;
  candles: readonly Candle[];
  loading: boolean;
  error: string | null;
  /** Changes when usable finer bars land; safe to include in a study memo key. */
  dataKey: string;
}

const cache = new Map<string, readonly Candle[]>();
let cachedBars = 0;

function cachePut(key: string, bars: readonly Candle[]): void {
  const previous = cache.get(key);
  if (previous) cachedBars -= previous.length;
  cache.delete(key);
  cache.set(key, bars);
  cachedBars += bars.length;
  while (cachedBars > MAX_PROFILE_CACHE_BARS && cache.size > 1) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    const removed = cache.get(oldest.value);
    cache.delete(oldest.value);
    cachedBars -= removed?.length ?? 0;
  }
}

export function resetVolumeProfileRefinementCache(): void {
  cache.clear();
  cachedBars = 0;
}

/** Finest native divisor of the chart interval that stays inside the budget. */
export function profileRefinementPlan(
  symbol: string, chartInterval: Resolution, fromMs: number, toMs: number,
  maxBars = MAX_PROFILE_REFINEMENT_BARS,
): ProfileRefinementPlan | null {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || maxBars < 1) return null;
  const lo = Math.min(fromMs, toMs);
  const hi = Math.max(fromMs, toMs);
  const chartMs = resolutionMs(chartInterval);
  for (const sourceInterval of NATIVE_RESOLUTIONS) {
    const sourceMs = NATIVE_RESOLUTION_MS[sourceInterval]!;
    if (sourceMs >= chartMs || chartMs % sourceMs !== 0) continue;
    const expectedBars = Math.floor((hi - lo) / sourceMs) + 1;
    if (expectedBars > maxBars) continue;
    return {
      sourceInterval,
      fromMs: lo,
      toMs: hi,
      expectedBars,
      key: `${symbol.toUpperCase()}|${sourceInterval}|${lo}|${hi}`,
    };
  }
  return null;
}

export function useVolumeProfileRefinement({
  enabled, symbol, chartInterval, fromMs, toMs,
}: {
  enabled: boolean;
  symbol: string;
  chartInterval: Resolution;
  fromMs: number | null;
  toMs: number | null;
}): ProfileRefinementState {
  const plan = useMemo(
    () => enabled && fromMs !== null && toMs !== null
      ? profileRefinementPlan(symbol, chartInterval, fromMs, toMs)
      : null,
    [enabled, symbol, chartInterval, fromMs, toMs],
  );
  const [state, setState] = useState<ProfileRefinementState>({
    plan: null, candles: [], loading: false, error: null, dataKey: "chart",
  });

  useEffect(() => {
    if (!plan) {
      setState({ plan: null, candles: [], loading: false, error: null, dataKey: "chart" });
      return;
    }
    const cached = cache.get(plan.key);
    if (cached) {
      // Touch for LRU order.
      cache.delete(plan.key); cache.set(plan.key, cached);
      setState({
        plan, candles: cached, loading: false, error: null,
        dataKey: `${plan.key}|${cached.length}`,
      });
      return;
    }

    const controller = new AbortController();
    let current = true;
    setState({ plan, candles: [], loading: true, error: null, dataKey: "chart" });
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          let bars = await api.candlesRange(
            symbol, plan.sourceInterval, plan.fromMs, plan.toMs,
            MAX_PROFILE_REFINEMENT_BARS, controller.signal,
          );
          // A thin local cache gets one bounded public-data repair. Sparse
          // venue series remain valid after that; missing bars are not filled.
          if (bars.length < plan.expectedBars * 0.9) {
            await api.backfill(
              symbol, plan.sourceInterval,
              new Date(plan.fromMs).toISOString(), new Date(plan.toMs).toISOString(),
              controller.signal,
            );
            bars = await api.candlesRange(
              symbol, plan.sourceInterval, plan.fromMs, plan.toMs,
              MAX_PROFILE_REFINEMENT_BARS, controller.signal,
            );
          }
          if (!current) return;
          if (bars.length === 0) {
            setState({
              plan, candles: [], loading: false,
              error: `No ${plan.sourceInterval} bars were available for this range.`,
              dataKey: "chart",
            });
            return;
          }
          const bounded = bars.length > MAX_PROFILE_REFINEMENT_BARS
            ? bars.slice(-MAX_PROFILE_REFINEMENT_BARS) : bars;
          cachePut(plan.key, bounded);
          setState({
            plan, candles: bounded, loading: false, error: null,
            dataKey: `${plan.key}|${bounded.length}`,
          });
        } catch (cause) {
          if (!current || isAbortError(cause)) return;
          setState({
            plan, candles: [], loading: false,
            error: (cause as Error).message, dataKey: "chart",
          });
        }
      })();
    }, DEBOUNCE_MS);
    return () => {
      current = false;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [plan, symbol]);

  return state;
}
