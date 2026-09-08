"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { api as scannerApi } from "@/lib/scanner/api";
import type { Candle } from "@/lib/types";
import type { Resolution } from "@/lib/resolution";
import {
  CANDLE_OVERLAY_KEY, type PatternAnalysis, type PatternCatalog, type PatternDirection,
} from "@/lib/candleOverlay";

export function loadCandleOverlayEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try { return window.localStorage.getItem(CANDLE_OVERLAY_KEY) === "1"; }
  catch { return false; }
}

export function saveCandleOverlayEnabled(enabled: boolean): void {
  if (typeof window === "undefined") return;
  try {
    if (enabled) window.localStorage.setItem(CANDLE_OVERLAY_KEY, "1");
    else window.localStorage.removeItem(CANDLE_OVERLAY_KEY);
  } catch { /* session state still works */ }
}

export interface CandleOverlayState {
  enabled: boolean;
  setEnabled: (next: boolean) => void;
  catalog: PatternCatalog | null;
  direction: "both" | Exclude<PatternDirection, "none">;
  setDirection: (next: "both" | "bull" | "bear") => void;
  /** Null means the whole catalog; an empty list intentionally means none. */
  selectedIds: readonly string[] | null;
  setSelectedIds: (next: readonly string[] | null) => void;
}

export function useCandleOverlay(): CandleOverlayState {
  const [enabled, setEnabledState] = useState(false);
  const [catalog, setCatalog] = useState<PatternCatalog | null>(null);
  const [direction, setDirection] = useState<"both" | "bull" | "bear">("both");
  const [selectedIds, setSelectedIds] = useState<readonly string[] | null>(null);
  useEffect(() => { setEnabledState(loadCandleOverlayEnabled()); }, []);
  useEffect(() => {
    if (!enabled || catalog) return;
    let live = true;
    void scannerApi.patternCatalog().then((value) => { if (live) setCatalog(value); }).catch(() => {});
    return () => { live = false; };
  }, [enabled, catalog]);
  return {
    enabled, catalog, direction, setDirection, selectedIds, setSelectedIds,
    setEnabled: (next) => { setEnabledState(next); saveCandleOverlayEnabled(next); },
  };
}

export interface PatternAnalysisState {
  analysis: PatternAnalysis | null;
  loading: boolean;
  error: string | null;
}

/** Analyze only when the completed source window changes; forming ticks do not poll. */
export function usePatternAnalysis(input: {
  enabled: boolean; symbol: string; timeframe: Resolution; candles: readonly Candle[];
  direction: "both" | "bull" | "bear";
}): PatternAnalysisState {
  const closed = useMemo(() => {
    const now = Date.now();
    return input.candles.filter((bar) => bar.closeTime <= now).slice(-2_000);
  }, [input.candles]);
  const latestRef = useRef(closed);
  latestRef.current = closed;
  const key = closed.length
    ? `${closed.length}:${closed[0]!.openTime}:${closed[closed.length - 1]!.openTime}` : "empty";
  const [state, setState] = useState<PatternAnalysisState>({
    analysis: null, loading: false, error: null,
  });
  useEffect(() => {
    if (!input.enabled || key === "empty") {
      setState({ analysis: null, loading: false, error: null });
      return;
    }
    const controller = new AbortController();
    setState((current) => ({ ...current, loading: true, error: null }));
    void scannerApi.analyzePatterns({
      symbol: input.symbol, timeframe: input.timeframe, asOf: Date.now(),
      candles: latestRef.current, settings: { direction: input.direction },
    }).then((analysis) => {
      if (!controller.signal.aborted) setState({ analysis, loading: false, error: null });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setState({
        analysis: null, loading: false,
        error: error instanceof Error ? error.message : "request failed",
      });
    });
    return () => controller.abort();
  }, [input.enabled, input.symbol, input.timeframe, input.direction, key]);
  return state;
}
