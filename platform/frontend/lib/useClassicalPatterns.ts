"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { api as scannerApi } from "@/lib/scanner/api";
import type { Candle } from "@/lib/types";
import type { Resolution } from "@/lib/resolution";
import type {
  ClassicalAnalysis, ClassicalCatalog, ClassicalStatus,
} from "@/lib/classicalPatterns";

export const CLASSICAL_OVERLAY_KEY = "tv.classicalPatterns.v1";

export interface ClassicalOverlayState {
  enabled: boolean;
  setEnabled: (next: boolean) => void;
  catalog: ClassicalCatalog | null;
  includeDeveloping: boolean;
  setIncludeDeveloping: (next: boolean) => void;
  status: "all" | ClassicalStatus | "completed";
  setStatus: (next: "all" | ClassicalStatus | "completed") => void;
  selectedIds: readonly string[] | null;
  setSelectedIds: (next: readonly string[] | null) => void;
  showTargets: boolean;
  setShowTargets: (next: boolean) => void;
}

function remembered(): boolean {
  if (typeof window === "undefined") return false;
  try { return window.localStorage.getItem(CLASSICAL_OVERLAY_KEY) === "1"; }
  catch { return false; }
}

export function useClassicalOverlay(): ClassicalOverlayState {
  const [enabled, setEnabledState] = useState(false);
  const [catalog, setCatalog] = useState<ClassicalCatalog | null>(null);
  const [includeDeveloping, setIncludeDeveloping] = useState(true);
  // Mirror the benchmark's restrained first view: show actionable completed
  // structures by default, while every lifecycle state remains selectable.
  const [status, setStatus] = useState<"all" | ClassicalStatus | "completed">("awaiting");
  const [selectedIds, setSelectedIds] = useState<readonly string[] | null>(null);
  const [showTargets, setShowTargets] = useState(true);
  useEffect(() => setEnabledState(remembered()), []);
  useEffect(() => {
    if (!enabled || catalog) return;
    let live = true;
    void scannerApi.classicalCatalog().then((value) => { if (live) setCatalog(value); }).catch(() => {});
    return () => { live = false; };
  }, [enabled, catalog]);
  return {
    enabled, catalog, includeDeveloping, setIncludeDeveloping, status, setStatus,
    selectedIds, setSelectedIds, showTargets, setShowTargets,
    setEnabled: (next) => {
      setEnabledState(next);
      try {
        if (next) window.localStorage.setItem(CLASSICAL_OVERLAY_KEY, "1");
        else window.localStorage.removeItem(CLASSICAL_OVERLAY_KEY);
      } catch { /* in-memory state remains authoritative for this session */ }
    },
  };
}

export interface ClassicalAnalysisState {
  analysis: ClassicalAnalysis | null; loading: boolean; error: string | null;
}

export function useClassicalAnalysis(input: {
  enabled: boolean; symbol: string; timeframe: Resolution; candles: readonly Candle[];
  includeDeveloping: boolean; status: ClassicalOverlayState["status"];
}): ClassicalAnalysisState {
  const closed = useMemo(() => {
    const now = Date.now();
    return input.candles.filter((bar) => bar.closeTime <= now).slice(-600);
  }, [input.candles]);
  const latest = useRef(closed);
  latest.current = closed;
  const key = closed.length
    ? `${closed.length}:${closed[0]!.openTime}:${closed[closed.length-1]!.openTime}` : "empty";
  const [state, setState] = useState<ClassicalAnalysisState>({
    analysis: null, loading: false, error: null,
  });
  useEffect(() => {
    if (!input.enabled || key === "empty") {
      setState({ analysis: null, loading: false, error: null });
      return;
    }
    const controller = new AbortController();
    setState((current) => ({ ...current, loading: true, error: null }));
    void scannerApi.analyzeClassical({
      symbol: input.symbol, timeframe: input.timeframe, asOf: Date.now(), candles: latest.current,
      settings: { include_developing: input.includeDeveloping, status_filter: input.status },
    }).then((analysis) => {
      if (!controller.signal.aborted) setState({ analysis, loading: false, error: null });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setState({
        analysis: null, loading: false,
        error: error instanceof Error ? error.message : "request failed",
      });
    });
    return () => controller.abort();
  }, [input.enabled, input.symbol, input.timeframe, input.includeDeveloping, input.status, key]);
  return state;
}
