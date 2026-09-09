"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { api as scannerApi } from "@/lib/scanner/api";
import type { Candle } from "@/lib/types";
import type { Resolution } from "@/lib/resolution";
import type {
  ClassicalAnalysis, ClassicalCatalog, ClassicalFormation, ClassicalStatus,
} from "@/lib/classicalPatterns";

export const CLASSICAL_OVERLAY_KEY = "tv.classicalPatterns.v1";

export interface ClassicalOverlayState {
  enabled: boolean;
  setEnabled: (next: boolean) => void;
  catalog: ClassicalCatalog | null;
  includeDeveloping: boolean;
  setIncludeDeveloping: (next: boolean) => void;
  status: "all" | ClassicalStatus | ClassicalFormation;
  setStatus: (next: "all" | ClassicalStatus | ClassicalFormation) => void;
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
  const [includeDeveloping, setIncludeDeveloping] = useState(false);
  // Formed/unbroken structures are honestly awaiting resolution and therefore
  // appear in the restrained default view.
  const [status, setStatus] = useState<"all" | ClassicalStatus | ClassicalFormation>("awaiting");
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

interface PaneClassicalSettings {
  enabled: boolean;
  includeDeveloping: boolean;
  status: "all" | ClassicalStatus | ClassicalFormation;
  selectedIds: readonly string[] | null;
  showTargets: boolean;
}

const defaultPaneSettings = (): PaneClassicalSettings => ({
  enabled: false, includeDeveloping: false, status: "awaiting",
  selectedIds: null, showTargets: true,
});

const paneKey = (paneId: string): string => `${CLASSICAL_OVERLAY_KEY}:${paneId}`;

/** One independent classical-pattern study instance per chart pane. */
export function usePaneClassicalOverlays(
  paneIds: readonly string[],
): Record<string, ClassicalOverlayState> {
  const idsKey = paneIds.join("\u0000");
  const [settings, setSettings] = useState<Record<string, PaneClassicalSettings>>({});
  const [catalog, setCatalog] = useState<ClassicalCatalog | null>(null);
  useEffect(() => {
    setSettings((current) => {
      const next = { ...current };
      for (const paneId of paneIds) {
        if (next[paneId]) continue;
        let enabled = false;
        try { enabled = window.localStorage.getItem(paneKey(paneId)) === "1"; }
        catch { /* use disabled default */ }
        next[paneId] = { ...defaultPaneSettings(), enabled };
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);
  const anyEnabled = paneIds.some((paneId) => settings[paneId]?.enabled);
  useEffect(() => {
    if (!anyEnabled || catalog) return;
    let live = true;
    void scannerApi.classicalCatalog().then((value) => { if (live) setCatalog(value); }).catch(() => {});
    return () => { live = false; };
  }, [anyEnabled, catalog]);
  return useMemo(() => Object.fromEntries(paneIds.map((paneId) => {
    const value = settings[paneId] ?? defaultPaneSettings();
    const update = (patch: Partial<PaneClassicalSettings>) =>
      setSettings((current) => ({
        ...current, [paneId]: { ...(current[paneId] ?? defaultPaneSettings()), ...patch },
      }));
    return [paneId, {
      ...value, catalog,
      setEnabled: (enabled: boolean) => {
        update({ enabled });
        try {
          if (enabled) window.localStorage.setItem(paneKey(paneId), "1");
          else window.localStorage.removeItem(paneKey(paneId));
        } catch { /* in-memory state remains authoritative */ }
      },
      setIncludeDeveloping: (includeDeveloping: boolean) => update({ includeDeveloping }),
      setStatus: (status: PaneClassicalSettings["status"]) => update({ status }),
      setSelectedIds: (selectedIds: readonly string[] | null) => update({ selectedIds }),
      setShowTargets: (showTargets: boolean) => update({ showTargets }),
    } satisfies ClassicalOverlayState];
  })), [catalog, paneIds, settings]);
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
