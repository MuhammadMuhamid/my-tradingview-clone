"use client";
import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { CandleChart, INTERVAL_MS, type ChartPriceLine } from "@/components/CandleChart";
import { PineEditor } from "@/components/tv/PineEditor";
import { IndicatorsPanel } from "@/components/tv/IndicatorsPanel";
import { SplitPane } from "@/components/tv/SplitPane";
import { useIndicators } from "@/lib/useIndicators";
import { Watchlist } from "@/components/tv/Watchlist";
import { AlertsPanel } from "@/components/tv/AlertsPanel";
import { LayoutMenu } from "@/components/tv/LayoutMenu";
import { StrategyTester } from "@/components/tv/StrategyTester";
import { StrategySettingsModal, StrategyProperties, DEFAULT_PROPERTIES } from "@/components/tv/StrategySettingsModal";
import { AlertModal } from "@/components/tv/AlertModal";
import { MaPanel } from "@/components/tv/MaPanel";
import { MaAlertModal } from "@/components/tv/MaAlertModal";
import { PushSetup } from "@/components/tv/PushSetup";
import { SymbolSearch } from "@/components/tv/SymbolSearch";
import { DrawingToolbar } from "@/components/tv/DrawingToolbar";
import * as drawStore from "@/lib/drawings";
import type { Drawing, DrawingTool } from "@/lib/drawings";
import { api, type MaAlert, type OptimizerBest, type PineScript } from "@/lib/api";
import {
  buildMaOverlays, currentMaValues, defaultMaLines, type MaLine, type MaType,
} from "@/lib/movingAverages";
import { defaultParamsFor } from "@/lib/paramSchema";
import * as layoutStore from "@/lib/layouts";
import type { Layout, WorkspaceState } from "@/lib/layouts";
import type { Candle, Interval, OpenTrade, Strategy, StrategyParams, SymbolInfo, Trade } from "@/lib/types";
import { fmtPrice } from "@/lib/format";

const INTERVALS: Interval[] = ["1m", "5m", "15m", "1h", "4h", "1d"];
const HISTORY_OPTIONS = [
  { label: "2K", bars: 2000 },
  { label: "10K", bars: 10000 },
  { label: "50K", bars: 50000 },
  { label: "All", bars: 200000 },
];

type Panel = "watchlist" | "alerts" | "indicators" | "ma" | null;

/** Standard auto-backtest window: 2025-11-01 → today (handoff §7). */
const BACKTEST_START = "2025-11-01";
const todayISO = (): string => new Date().toISOString().slice(0, 10);

/** JSON.stringify with recursively sorted keys — server JSONB reorders keys. */
function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as Record<string, unknown>).sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

export default function TvWorkspace() {
  const [symbols, setSymbols] = useState<SymbolInfo[]>([]);
  const [symbol, setSymbol] = useState("SOLUSDT");
  const [interval, setInterval] = useState<Interval>("15m");
  const [bars, setBars] = useState(10000);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [strategyKey, setStrategyKey] = useState("ma_rr_v9");
  const strategy = useMemo(
    () => strategies.find((s) => s.key === strategyKey) ?? null,
    [strategies, strategyKey]
  );
  const [params, setParams] = useState<StrategyParams>(defaultParamsFor("ma_rr_v9"));
  const [properties, setProperties] = useState<StrategyProperties>(DEFAULT_PROPERTIES);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [openTrade, setOpenTrade] = useState<OpenTrade | null>(null);

  /** Live SL / TP / entry levels for a still-running position. */
  const priceLines = useMemo<ChartPriceLine[]>(() => {
    if (!openTrade) return [];
    const lines: ChartPriceLine[] = [
      { price: openTrade.entryPrice, color: "#f0b90b", title: "ENTRY", dashed: true },
    ];
    if (openTrade.target !== null) lines.push({ price: openTrade.target, color: "#2ebd85", title: "TP" });
    if (openTrade.stop !== null) lines.push({ price: openTrade.stop, color: "#f6465d", title: "SL" });
    return lines;
  }, [openTrade]);

  const [panel, setPanel] = useState<Panel>("watchlist");

  // On phones the side panel is an overlay drawer, so start it closed —
  // otherwise it covers the chart on first load.
  useEffect(() => {
    if (typeof window !== "undefined" && window.innerWidth < 768) setPanel(null);
  }, []);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [alertOpen, setAlertOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  // ── drawings (persisted per symbol, like TradingView) ──
  const [tool, setTool] = useState<DrawingTool>("cursor");
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  const [magnet, setMagnet] = useState(false);
  const [drawLocked, setDrawLocked] = useState(false);
  const [drawHidden, setDrawHidden] = useState(false);

  // ── bottom panel: strategy tester / pine editor ──
  const [bottomTab, setBottomTab] = useState<"tester" | "pine">("tester");
  /** collapsed to just its tab strip, so the chart gets the full height */
  const [bottomCollapsed, setBottomCollapsed] = useState(false);

  // ── split view: a second pane on the same symbol, its own timeframe ──
  const [splitOpen, setSplitOpen] = useState(false);
  const [splitInterval, setSplitInterval] = useState<Interval>("1h");

  // Both preferences are workspace furniture rather than analysis state, so
  // they live in localStorage instead of the saved layout.
  useEffect(() => {
    if (typeof window === "undefined") return;
    setBottomCollapsed(window.localStorage.getItem("tv.bottomCollapsed") === "1");
    const split = window.localStorage.getItem("tv.split");
    if (split) {
      try {
        const s = JSON.parse(split) as { open?: boolean; interval?: Interval };
        if (s.open) setSplitOpen(true);
        if (s.interval) setSplitInterval(s.interval);
      } catch { /* ignore malformed */ }
    }
  }, []);
  useEffect(() => {
    window.localStorage.setItem("tv.bottomCollapsed", bottomCollapsed ? "1" : "0");
  }, [bottomCollapsed]);
  useEffect(() => {
    window.localStorage.setItem("tv.split", JSON.stringify({ open: splitOpen, interval: splitInterval }));
  }, [splitOpen, splitInterval]);
  /** a library script the panel asked the editor to open */
  const [editorScript, setEditorScript] = useState<PineScript | null>(null);

  // ── applied Pine studies (TradingView "Indicators") ──
  const indicators = useIndicators({
    symbol, timeframe: interval, startTime: BACKTEST_START, endTime: todayISO(),
  });

  // ── moving averages (first-class chart lines, armable one at a time) ──
  const [maLines, setMaLines] = useState<MaLine[]>(defaultMaLines);
  const [maAlerts, setMaAlerts] = useState<MaAlert[]>([]);
  const [armLine, setArmLine] = useState<{ type: MaType; length: number } | null>(null);

  const refreshMaAlerts = useCallback(async () => {
    try {
      setMaAlerts(await api.listMaAlerts({ symbol }));
    } catch { /* backend offline — keep the current list */ }
  }, [symbol]);

  useEffect(() => { void refreshMaAlerts(); }, [refreshMaAlerts]);

  const toggleMa = useCallback((type: MaType, length: number) => {
    setMaLines((prev) => prev.map((l) =>
      l.type === type && l.length === length ? { ...l, visible: !l.visible } : l));
  }, []);

  const toggleAllMa = useCallback((visible: boolean) => {
    setMaLines((prev) => prev.map((l) => ({ ...l, visible })));
  }, []);

  /** Editor "Add to chart" becomes a normal study instance. */
  const applyPine = useCallback((payload: { name: string; source: string; params: Record<string, number | string | boolean> }) => {
    indicators.add({ scriptId: null, name: payload.name, source: payload.source, params: payload.params });
    setOpenTrade(null);
    setPanel("indicators");
  }, [indicators]);

  const openInEditor = useCallback((s: PineScript) => {
    setEditorScript(s);
    setBottomTab("pine");
  }, []);

  useEffect(() => { setDrawings(drawStore.loadDrawings(symbol)); }, [symbol]);
  const updateDrawings = useCallback((next: Drawing[]) => {
    setDrawings(next);
    drawStore.saveDrawings(symbol, next);
  }, [symbol]);
  const [toast, setToast] = useState<string | null>(null);
  const [loadingBest, setLoadingBest] = useState(false);
  const [bestRange, setBestRange] = useState<{ start: string; end: string; nonce: number; run?: boolean } | null>(null);

  // ── layouts ──
  const [layouts, setLayouts] = useState<Layout[]>([]);
  const [currentLayoutId, setCurrentLayoutId] = useState<string | null>(null);
  const [autosave, setAutosaveState] = useState(true);
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const workspaceState = useMemo<WorkspaceState>(
    () => ({ symbol, interval, bars, strategyKey, params, properties, movingAverages: maLines }),
    [symbol, interval, bars, strategyKey, params, properties, maLines]
  );

  const currentLayout = useMemo(
    () => layouts.find((l) => l.id === currentLayoutId) ?? null,
    [layouts, currentLayoutId]
  );

  const dirty = useMemo(() => {
    if (!currentLayout) return false;
    const { id: _i, name: _n, updatedAt: _u, ...saved } = currentLayout;
    return stableStringify(saved) !== stableStringify(workspaceState);
  }, [currentLayout, workspaceState]);

  const applyState = useCallback((s: WorkspaceState) => {
    setSymbol(s.symbol);
    setInterval(s.interval);
    setBars(s.bars);
    setStrategyKey(s.strategyKey);
    setParams(s.params);
    setProperties(s.properties);
    setMaLines(s.movingAverages?.length ? s.movingAverages : defaultMaLines());
    setTrades([]);
  }, []);

  const refreshLayouts = useCallback(async () => {
    try {
      setLayouts(await layoutStore.listLayouts());
    } catch { /* backend offline — keep the current list */ }
  }, []);

  /** Opening a layout always backtests 2025-11-01 → today automatically. */
  const queueAutoBacktest = useCallback(() => {
    setBestRange({ start: BACKTEST_START, end: todayISO(), nonce: Date.now(), run: true });
  }, []);

  const applyBestConfig = useCallback(async () => {
    setLoadingBest(true);
    setErr(null);
    try {
      const best = await api.optimizerBest(symbol, 1, strategyKey, interval);
      setStrategyKey(best.strategyKey);
      setParams(best.params);
      setProperties((prev) => ({
        ...prev,
        initialCapital: best.properties.initialCapital,
        commissionPct: best.properties.commissionPct,
        slippageTicks: best.properties.slippageTicks,
        qtyCash: best.properties.qtyCash,
        qtyType: best.properties.qtyType,
        qtyValue: best.properties.qtyValue,
      }));
      setInterval(best.timeframe);
      setBestRange({
        start: best.properties.rangeStart,
        end: best.properties.rangeEnd,
        nonce: Date.now(),
      });
      setTrades([]);
      const net = best.metrics.net_pct;
      const dd = best.metrics.dd_pct;
      setToast(
        `Best ${symbol} config applied${net != null ? ` · +${net.toFixed(1)}%` : ""}${dd != null ? ` · DD ${dd.toFixed(1)}%` : ""}`
      );
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoadingBest(false);
    }
  }, [symbol, strategyKey, interval]);

  // Optimizer deep link: load an exact ranked MA+RR or SRTrend result and,
  // optionally, persist it as a named TradingView-style layout.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const applyStrategy = q.get("applyStrategy");
    if (applyStrategy !== "srtrend_v10" && applyStrategy !== "ma_rr_v9" && applyStrategy !== "mtf_lean") return;
    const applySymbol = (q.get("applySymbol") ?? "").toUpperCase();
    const applyTf = (q.get("applyTf") === "5m" ? "5m" : "15m") as Interval;
    const applyRank = Math.max(1, Number(q.get("applyRank") ?? 1));
    const layoutName = q.get("layoutName")?.trim() ?? "";
    if (!applySymbol) return;
    setLoadingBest(true);
    let frozen: OptimizerBest | null = null;
    const encoded = q.get("applyPayload");
    if (encoded) {
      try {
        const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        frozen = JSON.parse(new TextDecoder().decode(bytes)) as OptimizerBest;
      } catch { /* fall back to ranked lookup */ }
    }
    (frozen ? Promise.resolve(frozen) : api.optimizerBest(applySymbol, applyRank, applyStrategy, applyTf))
      .then(async (best) => {
        const appliedProperties = { ...properties,
          initialCapital: best.properties.initialCapital, commissionPct: best.properties.commissionPct,
          slippageTicks: best.properties.slippageTicks, qtyCash: best.properties.qtyCash,
          qtyType: best.properties.qtyType, qtyValue: best.properties.qtyValue,
        };
        setSymbol(applySymbol); setInterval(best.timeframe); setStrategyKey(best.strategyKey);
        setParams(best.params); setProperties(appliedProperties);
        setBestRange({ start: best.properties.rangeStart, end: best.properties.rangeEnd, nonce: Date.now(), run: true });
        setTrades([]);
        if (layoutName) {
          // createLayout is an atomic name-based upsert, making this safe when
          // React development Strict Mode invokes the effect twice.
          const layout = await layoutStore.createLayout(layoutName, {
            symbol: applySymbol, interval: best.timeframe, bars,
            strategyKey: best.strategyKey, params: best.params, properties: appliedProperties,
            movingAverages: maLines,
          });
          setCurrentLayoutId(layout.id);
          await refreshLayouts();
        }
        const strategyLabel = applyStrategy === "srtrend_v10" ? "SRTrend" : applyStrategy === "mtf_lean" ? "MTF Lean" : "MA+R:R";
        setToast(`${strategyLabel} ${applyTf} ${applySymbol} rank #${applyRank} applied${layoutName ? " · layout saved" : ""}`);
        window.history.replaceState({}, "", "/chart");
      })
      .catch((e) => setErr((e as Error).message))
      .finally(() => setLoadingBest(false));
  }, []);

  // Mount: symbols, strategies, layouts (+ restore last layout).
  const refreshSymbols = useCallback(() => {
    api.listSymbols().then(setSymbols).catch(() => {});
  }, []);

  useEffect(() => {
    refreshSymbols();
    api.listStrategies().then((s) => {
      setStrategies(s);
      if (s.length > 0 && !s.some((x) => x.key === "ma_rr_v9")) setStrategyKey(s[0].key);
    }).catch(() => {});
    setAutosaveState(layoutStore.getAutosave());
    // A deep link owns the workspace this load — don't fight it with the
    // restored layout; still sync + list layouts for the menu.
    const isDeepLink = new URLSearchParams(window.location.search).has("applyStrategy");
    (async () => {
      await layoutStore.migrateLegacyLayouts();
      await layoutStore.syncDeploymentLayouts();
      let all: Layout[] = [];
      try {
        all = await layoutStore.listLayouts();
      } catch { return; }
      setLayouts(all);
      if (isDeepLink) return;
      const curId = layoutStore.getCurrentLayoutId();
      const l = curId ? all.find((x) => x.id === curId) ?? null : null;
      if (l) {
        setCurrentLayoutId(l.id);
        applyState(l);
        queueAutoBacktest();
      }
    })();
  }, [refreshSymbols, applyState, queueAutoBacktest]);

  // Autosave (debounced) when enabled and the workspace drifts from the layout.
  useEffect(() => {
    if (!autosave || !currentLayoutId || !dirty) return;
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = setTimeout(() => {
      void layoutStore.saveLayout(currentLayoutId, workspaceState).then(refreshLayouts);
    }, 800);
    return () => { if (autosaveTimer.current) clearTimeout(autosaveTimer.current); };
  }, [autosave, currentLayoutId, dirty, workspaceState, refreshLayouts]);

  // ⌘S / Ctrl+S saves the current layout, like TV.
  const saveNow = useCallback(async () => {
    if (currentLayoutId) {
      await layoutStore.saveLayout(currentLayoutId, workspaceState);
      await refreshLayouts();
      setToast("Layout saved");
    } else {
      const name = window.prompt("Layout name:", `${symbol} ${interval}`);
      if (name !== null) {
        const l = await layoutStore.createLayout(name, workspaceState);
        setCurrentLayoutId(l.id);
        await refreshLayouts();
      }
    }
  }, [currentLayoutId, workspaceState, symbol, interval, refreshLayouts]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void saveNow();
        return;
      }
      // "/" opens symbol search, like TV — but never while typing in a field.
      const el = e.target as HTMLElement | null;
      const typing = !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [saveNow]);

  const layoutHandlers = {
    onSelect: (id: string) => {
      const l = layouts.find((x) => x.id === id);
      if (!l) return;
      layoutStore.setCurrentLayoutId(id);
      setCurrentLayoutId(id);
      applyState(l);
      queueAutoBacktest();
    },
    onSaveNow: () => { void saveNow(); },
    onToggleAutosave: () => {
      const next = !autosave;
      layoutStore.setAutosave(next);
      setAutosaveState(next);
    },
    onCreate: () => {
      const name = window.prompt("New layout name:", `${symbol} ${interval}`);
      if (name === null) return;
      void layoutStore.createLayout(name, workspaceState).then(async (l) => {
        setCurrentLayoutId(l.id);
        await refreshLayouts();
      }).catch((e) => setErr((e as Error).message));
    },
    onCopy: () => {
      const name = window.prompt("Copy name:", `${currentLayout?.name ?? "Layout"} copy`);
      if (name === null) return;
      void layoutStore.createLayout(name, workspaceState).then(async (l) => {
        setCurrentLayoutId(l.id);
        await refreshLayouts();
      }).catch((e) => setErr((e as Error).message));
    },
    onRename: () => {
      if (!currentLayoutId) return;
      const name = window.prompt("Rename layout:", currentLayout?.name ?? "");
      if (name === null) return;
      void layoutStore.renameLayout(currentLayoutId, name).then(refreshLayouts);
    },
    onDelete: (id: string) => {
      if (!window.confirm("Delete this layout?")) return;
      void layoutStore.deleteLayout(id).then(async () => {
        if (id === currentLayoutId) setCurrentLayoutId(null);
        await refreshLayouts();
      });
    },
  };

  // ── candles ──
  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      let data = await api.candles(symbol, interval, bars);
      if (data.length < Math.min(bars, 500) * 0.98) {
        const lookbackMs = Math.ceil(bars * 1.1) * INTERVAL_MS[interval];
        await api.backfill(symbol, interval, new Date(Date.now() - lookbackMs).toISOString(), new Date().toISOString());
        data = await api.candles(symbol, interval, bars);
      }
      setCandles(data);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [symbol, interval, bars]);

  useEffect(() => { load(); }, [load]);

  const changeSymbol = (s: string) => { setSymbol(s); setTrades([]); };
  const changeInterval = (i: Interval) => { setInterval(i); setTrades([]); };
  const last = candles[candles.length - 1];

  /** MA lines drawn beneath any Pine overlays, so scripts stay on top. */
  const maOverlays = useMemo(() => buildMaOverlays(candles, maLines), [candles, maLines]);
  const maValues = useMemo(() => currentMaValues(candles, maLines), [candles, maLines]);
  const chartOverlays = useMemo(
    () => [...maOverlays, ...indicators.overlays],
    [maOverlays, indicators.overlays]
  );

  const railBtn = (active: boolean): string =>
    `flex h-9 w-9 items-center justify-center rounded-md transition-colors ${
      active ? "bg-surface-2 text-accent" : "text-ink-muted hover:bg-surface-2 hover:text-ink"
    }`;

  return (
    <div className="flex h-full">
      {/* ── left drawing rail ── */}
      <DrawingToolbar
        tool={tool}
        onTool={setTool}
        magnet={magnet}
        onMagnet={setMagnet}
        locked={drawLocked}
        onLocked={setDrawLocked}
        hidden={drawHidden}
        onHidden={setDrawHidden}
        onDeleteAll={() => { if (window.confirm("Remove all drawings on this symbol?")) updateDrawings([]); }}
        count={drawings.length}
      />

      {/* ── main column ── */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* top toolbar */}
        <div className="flex flex-nowrap items-center gap-2 overflow-x-auto border-b border-border bg-surface px-3 py-1.5 sm:flex-wrap sm:overflow-x-visible">
          <button
            onClick={() => setSearchOpen(true)}
            title="Change symbol (/)"
            className="flex items-center gap-1.5 rounded-md bg-surface-2 px-2.5 py-1 text-sm font-semibold text-ink transition-colors hover:bg-border"
          >
            {symbol}
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" className="text-ink-faint">
              <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" />
            </svg>
          </button>
          <span className="text-ink-faint">·</span>
          <div className="flex items-center gap-0.5">
            {INTERVALS.map((i) => (
              <button key={i} onClick={() => changeInterval(i)}
                className={`rounded px-2 py-1 text-[13px] transition-colors ${
                  interval === i ? "bg-surface-2 font-semibold text-ink" : "text-ink-muted hover:text-ink"
                }`}>
                {i}
              </button>
            ))}
          </div>
          <span className="text-ink-faint">·</span>
          <div className="flex items-center gap-0.5">
            {HISTORY_OPTIONS.map((h) => (
              <button key={h.label} onClick={() => setBars(h.bars)}
                title={`Show up to ${h.bars.toLocaleString()} bars`}
                className={`rounded px-2 py-1 text-xs transition-colors ${
                  bars === h.bars ? "bg-surface-2 text-ink" : "text-ink-muted hover:text-ink"
                }`}>
                {h.label}
              </button>
            ))}
          </div>
          <span className="text-ink-faint">·</span>
          <button onClick={() => setPanel((p) => (p === "indicators" ? null : "indicators"))}
            title="Pine indicators on this chart"
            className="flex items-center gap-1.5 rounded px-2 py-1 text-[13px] text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M3 17l5-6 4 4 3-4 6 6" /><path d="M3 20h18" />
            </svg>
            Indicators
            {indicators.list.length > 0 && (
              <span className="rounded-full bg-accent px-1.5 text-[10px] font-semibold text-white">
                {indicators.list.length}
              </span>
            )}
          </button>
          <button
            onClick={() => setSplitOpen((v) => !v)}
            title={splitOpen ? "Close the second chart" : "Split view — same symbol, second timeframe"}
            className={`flex items-center gap-1.5 rounded px-2 py-1 text-[13px] transition-colors hover:bg-surface-2 hover:text-ink ${
              splitOpen ? "bg-surface-2 text-accent" : "text-ink-muted"
            }`}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <rect x="3" y="4" width="18" height="16" rx="1.5" /><path d="M12 4v16" />
            </svg>
            Split
          </button>
          <button onClick={() => setAlertOpen(true)}
            className="flex items-center gap-1.5 rounded px-2 py-1 text-[13px] text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 01-3.46 0" />
            </svg>
            Alert
          </button>
          <button onClick={() => setSettingsOpen(true)}
            className="flex items-center gap-1.5 rounded px-2 py-1 text-[13px] text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M3 12h4l2-7 4 14 2-7h6" />
            </svg>
            Strategy
          </button>
          <button onClick={applyBestConfig} disabled={loadingBest}
            title={`Apply the local optimizer's best saved config for ${symbol}`}
            className="flex items-center gap-1.5 rounded border border-amber-400/30 bg-amber-400/10 px-2 py-1 text-[13px] font-medium text-amber-300 transition-colors hover:bg-amber-400/20 disabled:cursor-wait disabled:opacity-60">
            <span aria-hidden>★</span>
            {loadingBest ? "Loading…" : "Best"}
          </button>
          <div className="ml-auto flex items-center gap-3">
            <span className="tabular text-xs text-ink-muted">
              {last && <>Last <span className="text-ink">{fmtPrice(last.close)}</span></>}
              <span className="ml-3 text-ink-faint">
                {candles.length.toLocaleString()} bars{loading ? " · loading…" : ""}
              </span>
            </span>
            <LayoutMenu
              layouts={layouts}
              currentId={currentLayoutId}
              autosave={autosave}
              dirty={dirty}
              {...layoutHandlers}
            />
          </div>
        </div>

        {err && <div className="border-b border-down/30 bg-down/10 px-3 py-1.5 text-xs text-down">{err}</div>}

        {/* charts — one pane, or two side by side sharing the symbol */}
        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
          {loading && candles.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-ink-faint">
              Loading {symbol} {interval}…
            </div>
          ) : (
            <CandleChart symbol={symbol} interval={interval} candles={candles}
              trades={indicators.trades ?? trades}
              overlays={chartOverlays}
              markers={indicators.markers}
              pineDrawings={indicators.drawings}
              priceLines={priceLines} live fill
              drawingTool={tool}
              onDrawingToolDone={() => setTool("cursor")}
              drawings={drawings}
              onDrawingsChange={updateDrawings}
              magnet={magnet}
              drawingsLocked={drawLocked}
              drawingsHidden={drawHidden}
            />
          )}
          </div>
          {splitOpen && (
            <SplitPane
              symbol={symbol}
              timeframe={splitInterval}
              onTimeframe={setSplitInterval}
              bars={bars}
              indicators={indicators.list}
              startTime={BACKTEST_START}
              endTime={todayISO()}
              onClose={() => setSplitOpen(false)}
            />
          )}
        </div>

        {/* bottom panel: strategy tester / pine editor (TradingView layout) */}
        <div className="shrink-0 border-t border-border bg-surface">
          <div className="flex items-center gap-4 border-b border-border px-3 py-1">
            {([["tester", "Strategy Tester"], ["pine", "Pine Editor"]] as const).map(([id, label]) => (
              <button
                key={id}
                onClick={() => {
                  // Clicking the active tab while collapsed reopens it, which
                  // is what a collapsed tab strip invites you to do.
                  if (bottomTab === id) setBottomCollapsed((v) => !v);
                  else { setBottomTab(id); setBottomCollapsed(false); }
                }}
                className={`border-b-2 pb-1 text-xs font-medium ${
                  bottomTab === id && !bottomCollapsed
                    ? "border-accent text-ink"
                    : "border-transparent text-ink-muted hover:text-ink"
                }`}
              >
                {label}
              </button>
            ))}
            <div className="ml-auto flex items-center gap-3">
              {indicators.list.length > 0 && (
                <button
                  onClick={() => setPanel("indicators")}
                  className="flex items-center gap-2 text-[11px] text-ink-faint hover:text-ink"
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                  {indicators.list.length} indicator{indicators.list.length === 1 ? "" : "s"} on chart
                </button>
              )}
              <button
                onClick={() => setBottomCollapsed((v) => !v)}
                title={bottomCollapsed ? "Expand panel" : "Minimize panel"}
                aria-label={bottomCollapsed ? "Expand panel" : "Minimize panel"}
                className="flex h-5 w-5 items-center justify-center rounded text-ink-faint hover:bg-surface-2 hover:text-ink"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
                  {bottomCollapsed ? <path d="M6 15l6-6 6 6" /> : <path d="M6 9l6 6 6-6" />}
                </svg>
              </button>
            </div>
          </div>
          {/* Collapsed: the tab strip stays as the handle to bring it back.
              The body unmounts rather than hiding, so a collapsed Pine Editor
              stops compiling on every keystroke. */}
          {bottomCollapsed ? null : bottomTab === "tester" ? (
            <StrategyTester
              symbol={symbol}
              timeframe={interval}
              strategies={strategies}
              strategy={strategy}
              onStrategyChange={(k) => { setStrategyKey(k); setParams(defaultParamsFor(k)); setTrades([]); setOpenTrade(null); }}
              onOpenSettings={() => setSettingsOpen(true)}
              properties={properties}
              params={params}
              requestedRange={bestRange}
              onTrades={setTrades}
              onOpenTrade={setOpenTrade}
            />
          ) : (
            <div className="h-[380px]">
              <PineEditor
                symbol={symbol}
                timeframe={interval}
                startTime={BACKTEST_START}
                endTime={todayISO()}
                appliedCount={indicators.list.length}
                openScript={editorScript}
                onOpenScriptConsumed={() => setEditorScript(null)}
                onApplyToChart={applyPine}
              />
            </div>
          )}
        </div>
      </div>

      {/* ── right panel (watchlist / alerts) ── */}
      {panel && (
        <>
          {/* Phone: dim the chart and let a tap outside dismiss the drawer. */}
          <button
            aria-label="Close panel"
            onClick={() => setPanel(null)}
            className="fixed inset-0 z-30 bg-black/50 md:hidden"
          />
          <div className="fixed right-12 top-0 z-40 h-full md:static md:right-auto md:z-auto md:h-auto">
            {panel === "watchlist" && (
              <Watchlist symbols={symbols} selected={symbol} onSelect={changeSymbol} onSymbolsChanged={refreshSymbols} />
            )}
            {panel === "alerts" && <AlertsPanel onCreateAlert={() => setAlertOpen(true)} />}
            {panel === "indicators" && (
              <IndicatorsPanel indicators={indicators} onOpenInEditor={openInEditor} />
            )}
            {panel === "ma" && (
              <aside className="flex h-full w-[85vw] max-w-[300px] shrink-0 flex-col border-l border-border bg-surface md:w-[300px]">
                <MaPanel
                  lines={maLines}
                  values={maValues}
                  alerts={maAlerts}
                  timeframe={interval}
                  onToggle={toggleMa}
                  onToggleAll={toggleAllMa}
                  onArm={(type, length) => setArmLine({ type, length })}
                  onOpenAlert={(a) => setArmLine({ type: a.maType, length: a.maLength })}
                  push={<PushSetup onMessage={setToast} />}
                />
              </aside>
            )}
          </div>
        </>
      )}

      {/* ── far-right icon rail (TV-style) ── */}
      <div className="flex w-12 shrink-0 flex-col items-center gap-1 border-l border-border bg-surface py-2">
        <button
          onClick={() => setPanel((p) => (p === "watchlist" ? null : "watchlist"))}
          className={railBtn(panel === "watchlist")}
          title="Watchlist"
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
            <path d="M4 6h16M4 12h16M4 18h10" />
          </svg>
        </button>
        <button
          onClick={() => setPanel((p) => (p === "indicators" ? null : "indicators"))}
          className={railBtn(panel === "indicators")}
          title="Indicators"
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
            <path d="M3 17l5-6 4 4 3-4 6 6" /><path d="M3 20h18" />
          </svg>
          {indicators.list.length > 0 && (
            <span className="absolute ml-6 -mt-4 rounded-full bg-accent px-1 text-[9px] font-semibold text-white">
              {indicators.list.length}
            </span>
          )}
        </button>
        <button
          onClick={() => setPanel((p) => (p === "ma" ? null : "ma"))}
          className={railBtn(panel === "ma")}
          title="Moving averages & price alerts"
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
            <path d="M3 15c3-7 6 3 9-4s6 2 9-3" />
          </svg>
          {maAlerts.length > 0 && (
            <span className="absolute ml-6 -mt-4 rounded-full bg-accent px-1 text-[9px] font-semibold text-white">
              {maAlerts.length}
            </span>
          )}
        </button>
        <button
          onClick={() => setPanel((p) => (p === "alerts" ? null : "alerts"))}
          className={railBtn(panel === "alerts")}
          title="Alerts"
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
            <circle cx="12" cy="13" r="7" /><path d="M12 10v3l2 2M5 4L3 6M19 4l2 2" />
          </svg>
        </button>
      </div>

      {/* dialogs */}
      <StrategySettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        strategyName={strategy?.name ?? strategyKey}
        strategyKey={strategyKey}
        params={params}
        properties={properties}
        onApply={(p, props) => { setParams(p); setProperties(props); }}
      />
      <SymbolSearch
        open={searchOpen}
        current={symbol}
        onClose={() => setSearchOpen(false)}
        onSelect={changeSymbol}
        onSymbolAdded={refreshSymbols}
      />
      <MaAlertModal
        open={armLine !== null}
        onClose={() => setArmLine(null)}
        symbol={symbol}
        chartTimeframe={interval}
        maType={armLine?.type ?? "sma"}
        maLength={armLine?.length ?? 200}
        existing={maAlerts.filter(
          (a) => a.maType === armLine?.type && a.maLength === armLine?.length
        )}
        onSaved={(message) => { setToast(message); void refreshMaAlerts(); }}
      />
      <AlertModal
        open={alertOpen}
        onClose={() => setAlertOpen(false)}
        symbol={symbol}
        timeframe={interval}
        strategy={strategy}
        strategies={strategies}
        params={params}
        onCreated={(name) => { setToast(`Alert created — ${name} live on ${symbol} ${interval}`); setPanel("alerts"); }}
      />
      {toast && (
        <div className="fixed bottom-4 right-16 z-50 flex items-center gap-3 rounded-md border border-up/30 bg-surface px-4 py-2.5 text-sm shadow-xl">
          <span className="h-2 w-2 rounded-full bg-up" />
          {toast}
          <button onClick={() => setToast(null)} className="text-ink-faint hover:text-ink">✕</button>
        </div>
      )}
    </div>
  );
}
