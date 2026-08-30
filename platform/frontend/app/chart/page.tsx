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
import { alertColor, describeAlert, isAlertActive } from "@/lib/alerts";
import {
  describeApply, parseApplyLink, STRATEGY_LABELS, type ApplyRequest,
} from "@/lib/deepLink";
import { MaAlertModal } from "@/components/tv/MaAlertModal";
import { PriceAlertModal } from "@/components/tv/PriceAlertModal";
import { LevelAlertModal } from "@/components/tv/LevelAlertModal";
import { IndicatorAlertModal, type IndicatorKind } from "@/components/tv/IndicatorAlertModal";
import { PushSetup } from "@/components/tv/PushSetup";
import { useIsMobile } from "@/lib/useIsMobile";
import { SyncMenu } from "@/components/tv/SyncMenu";
import { DEFAULT_SYNC, loadSync, saveSync, type SyncOptions } from "@/lib/paneSync";
import { SymbolSearch } from "@/components/tv/SymbolSearch";
import { DrawingToolbar } from "@/components/tv/DrawingToolbar";
import * as drawStore from "@/lib/drawings";
import type { Drawing, DrawingTool } from "@/lib/drawings";
import { api, type MaAlert, type OptimizerBest, type PineScript } from "@/lib/api";
import { CancellableRequest, isAbortError, LatestRequest } from "@/lib/requestGuard";
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

/**
 * Bottom-panel preference key. Phones and desktops store it separately so one
 * form factor's choice never dictates the other's opening layout.
 */
const bottomKey = (): string =>
  typeof window !== "undefined" && window.innerWidth < 768
    ? "tv.bottomCollapsed.mobile"
    : "tv.bottomCollapsed";

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

/**
 * Apply only the properties the optimizer tree actually states.
 *
 * `OPT-11`: the API used to invent an order size (930) and a cost model for a
 * tree that never recorded one. Those fields are now `null` when unknown, and
 * an unknown field must leave the user's current setting alone rather than
 * silently resetting it to a fabricated number.
 */
function withOptimizerProperties(
  prev: StrategyProperties,
  p: OptimizerBest["properties"]
): StrategyProperties {
  return {
    ...prev,
    ...(p.initialCapital !== null ? { initialCapital: p.initialCapital } : {}),
    ...(p.commissionPct !== null ? { commissionPct: p.commissionPct } : {}),
    ...(p.slippageTicks !== null ? { slippageTicks: p.slippageTicks } : {}),
    ...(p.qtyCash !== null ? { qtyCash: p.qtyCash } : {}),
    qtyType: p.qtyType,
    ...(p.qtyValue !== null ? { qtyValue: p.qtyValue } : {}),
  };
}

/** The optimizer's window, or null when the tree does not record one. */
function optimizerRange(
  p: OptimizerBest["properties"],
  extra: { run?: boolean } = {}
): { start: string; end: string; nonce: number; run?: boolean } | null {
  if (!p.rangeStart || !p.rangeEnd) return null;
  return { start: p.rangeStart, end: p.rangeEnd, nonce: Date.now(), ...extra };
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
  // ── phone chrome: everything optional starts closed so the chart gets the screen ──
  const isMobile = useIsMobile();
  /** Drawing rail — a floating drawer on phones, always-on column on desktop. */
  const [toolsOpen, setToolsOpen] = useState(false);
  /** Second row of the toolbar (history depth, split, strategy, layouts…). */
  const [moreOpen, setMoreOpen] = useState(false);
  /** Site navigation, which is hidden on the phone chart to reclaim a whole row. */
  const [navOpen, setNavOpen] = useState(false);

  // ── split-pane synchronisation ──
  const [sync, setSyncState] = useState<SyncOptions>(DEFAULT_SYNC);
  useEffect(() => { setSyncState(loadSync()); }, []);
  const setSync = useCallback((next: SyncOptions) => {
    setSyncState(next);
    saveSync(next);
  }, []);

  /**
   * Which pane the pointer is in, and where. Held as one piece of state so a
   * pane never mirrors its own crosshair back onto itself.
   */
  const [cross, setCross] = useState<{ pane: 1 | 2; time: number | null } | null>(null);
  const [range, setRange] = useState<{ pane: 1 | 2; from: number; to: number } | null>(null);

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

  /**
   * Persist on the user's action rather than in an effect on the value.
   * An effect keyed to `bottomCollapsed` runs in the same commit as the
   * restore effect, before the restored state has been applied, so it writes
   * the initial `false` straight back over the stored preference.
   */
  const toggleBottom = useCallback(() => {
    setBottomCollapsed((v) => {
      const next = !v;
      window.localStorage.setItem(bottomKey(), next ? "1" : "0");
      return next;
    });
  }, []);

  // ── split view: a second pane on the same symbol, its own timeframe ──
  const [splitOpen, setSplitOpen] = useState(false);
  const [splitInterval, setSplitInterval] = useState<Interval>("1h");

  // Both preferences are workspace furniture rather than analysis state, so
  // they live in localStorage instead of the saved layout.
  useEffect(() => {
    if (typeof window === "undefined") return;
    // The Strategy Tester is a desktop working surface. Phone and desktop keep
    // SEPARATE preferences: a tester left open on a large screen must not open
    // itself on a phone, where it would take over half the chart.
    const storedBottom = window.localStorage.getItem(bottomKey());
    setBottomCollapsed(storedBottom === null ? window.innerWidth < 768 : storedBottom === "1");
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
  /**
   * The price-alert dialog, and the level it opened with.
   *
   * `pickingLevel` is the intermediate state: the user asked to place a level
   * and the next chart click supplies it. Keeping it separate from the dialog
   * means the chart is only click-armed while that mode is on, and behaves
   * exactly as before at every other moment.
   */
  const [priceAlertOpen, setPriceAlertOpen] = useState(false);
  /** Which level family the dialog is open on, or null when it is closed. */
  const [levelKind, setLevelKind] = useState<"sr_zone" | "pivot_level" | null>(null);
  /** Which oscillator family the dialog is open on, or null when closed. */
  const [oscillatorKind, setOscillatorKind] = useState<IndicatorKind | null>(null);
  const [priceAlertLevel, setPriceAlertLevel] = useState<number | null>(null);
  const [pickingLevel, setPickingLevel] = useState(false);

  const refreshMaAlerts = useCallback(async () => {
    try {
      setMaAlerts(await api.listMaAlerts({ symbol }));
    } catch { /* backend offline — keep the current list */ }
  }, [symbol]);

  useEffect(() => { void refreshMaAlerts(); }, [refreshMaAlerts]);

  /**
   * Ask for a level off the chart, then open the dialog with it.
   *
   * Two steps rather than one because the price a user means is the one they
   * can see, and a dialog opening first would cover it.
   */
  const pickLevel = useCallback((price: number) => {
    setPickingLevel(false);
    setPriceAlertLevel(price);
    setPriceAlertOpen(true);
  }, []);

  /** Open the dialog with no level picked; it falls back to the last price. */
  const openPriceAlert = useCallback(() => {
    setPriceAlertLevel(null);
    setPriceAlertOpen(true);
  }, []);

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
  /** An optimizer link's request, waiting for the user to accept it. See FE-06. */
  const [pendingApply, setPendingApply] = useState<ApplyRequest | null>(null);
  /** Last autosave failure. Shown quietly in the layout menu, not as a toast. */
  const [autosaveError, setAutosaveError] = useState<string | null>(null);

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
      setProperties((prev) => withOptimizerProperties(prev, best.properties));
      setInterval(best.timeframe);
      setBestRange(optimizerRange(best.properties));
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

  /*
   * FE-06: an optimizer deep link used to act on page load. It saved a named
   * layout to the server and started a backtest before the user had done
   * anything, so a link in a message or a stale bookmark wrote server state on
   * behalf of whoever opened it. Parsing now only DESCRIBES the request; the
   * banner below asks, and `applyDeepLink` is the click.
   */
  useEffect(() => {
    setPendingApply(parseApplyLink(window.location.search));
  }, []);

  const applyDeepLink = useCallback(async (request: ApplyRequest) => {
    setPendingApply(null);
    setLoadingBest(true);
    try {
      // A payload that failed validation is not used at all; the ranked lookup
      // asks the server instead, which is the trustworthy source.
      const best = request.payload
        ?? await api.optimizerBest(request.symbol, request.rank, request.strategy, request.timeframe);
      const appliedProperties = withOptimizerProperties(properties, best.properties);
      setSymbol(request.symbol); setInterval(best.timeframe); setStrategyKey(best.strategyKey);
      setParams(best.params); setProperties(appliedProperties);
      setBestRange(optimizerRange(best.properties, { run: true }));
      setTrades([]);
      if (request.layoutName) {
        // createLayout is an atomic name-based upsert, making this safe when
        // React development Strict Mode invokes the handler twice.
        const layout = await layoutStore.createLayout(request.layoutName, {
          symbol: request.symbol, interval: best.timeframe, bars,
          strategyKey: best.strategyKey, params: best.params, properties: appliedProperties,
          movingAverages: maLines,
        });
        setCurrentLayoutId(layout.id);
        await refreshLayouts();
      }
      setToast(
        `${STRATEGY_LABELS[request.strategy]} ${request.timeframe} ${request.symbol} ` +
        `rank #${request.rank} applied${request.layoutName ? " · layout saved" : ""}`
      );
      window.history.replaceState({}, "", "/chart");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoadingBest(false);
    }
  }, [properties, bars, maLines, refreshLayouts]);

  const dismissDeepLink = useCallback(() => {
    setPendingApply(null);
    window.history.replaceState({}, "", "/chart");
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
    // A pending deep link may own the workspace this load — don't fight it with
    // the restored layout; still sync + list layouts for the menu. The user may
    // dismiss the link, in which case the layout they left is what they get on
    // the next load rather than being silently replaced on this one.
    const isDeepLink = parseApplyLink(window.location.search) !== null;
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
      // Autosave is the one place a failure should not interrupt: the user did
      // not ask for this write and is mid-work. It is still SAID, in the
      // layout menu's own state, rather than discarded.
      void layoutStore.saveLayout(currentLayoutId, workspaceState)
        .then(refreshLayouts)
        .then(() => setAutosaveError(null))
        .catch((e: Error) => setAutosaveError(e.message));
    }, 800);
    return () => { if (autosaveTimer.current) clearTimeout(autosaveTimer.current); };
  }, [autosave, currentLayoutId, dirty, workspaceState, refreshLayouts]);

  // ⌘S / Ctrl+S saves the current layout, like TV.
  const saveNow = useCallback(async () => {
    try {
      if (currentLayoutId) {
        await layoutStore.saveLayout(currentLayoutId, workspaceState);
        await refreshLayouts();
        setAutosaveError(null);
        setToast("Layout saved");
      } else {
        const name = window.prompt("Layout name:", `${symbol} ${interval}`);
        if (name !== null) {
          const l = await layoutStore.createLayout(name, workspaceState);
          setCurrentLayoutId(l.id);
          await refreshLayouts();
          setToast("Layout saved");
        }
      }
    } catch (e) {
      // Previously this reported "Layout saved" whether or not anything was
      // saved, which is the one thing a save confirmation must never do.
      setErr(`Layout not saved: ${(e as Error).message}`);
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
      void layoutStore.renameLayout(currentLayoutId, name)
        .then(refreshLayouts)
        .catch((e: Error) => setErr(`Layout not renamed: ${e.message}`));
    },
    onDelete: (id: string) => {
      if (!window.confirm("Delete this layout?")) return;
      void layoutStore.deleteLayout(id).then(async () => {
        if (id === currentLayoutId) setCurrentLayoutId(null);
        await refreshLayouts();
      }).catch(async (e: Error) => {
        setErr(`Layout not deleted: ${e.message}`);
        await refreshLayouts();
      });
    },
  };

  // ── candles ──
  /*
   * Three things this load path did not do, all of which the audit found:
   *
   *  FE-07  no AbortSignal, so switching symbol left a 2.5 MB request running.
   *  ——     `setCandles(data)` was unconditional, so a slow FIRST response
   *         could land after a fast second one and paint the previous symbol's
   *         candles under the new symbol's label, with no error.
   *  ——     the backfill path re-requested the FULL window a second time.
   *
   * `LatestRequest` compares tokens rather than parameters, which matters: a
   * user who switches away and back lands on the same parameters, and a
   * parameter comparison would then wrongly accept the first, slower response.
   */
  const requestSeq = useRef(new LatestRequest());
  const inFlight = useRef(new CancellableRequest());

  const load = useCallback(async () => {
    const token = requestSeq.current.next();
    const signal = inFlight.current.start();
    setLoading(true);
    setErr(null);
    try {
      let data = await api.candles(symbol, interval, bars, signal);

      // Not enough history stored: backfill, then fetch only what is missing
      // rather than the whole window again.
      if (data.length < Math.min(bars, 500) * 0.98) {
        if (!requestSeq.current.isCurrent(token)) return;
        const lookbackMs = Math.ceil(bars * 1.1) * INTERVAL_MS[interval];
        await api.backfill(
          symbol, interval,
          new Date(Date.now() - lookbackMs).toISOString(),
          new Date().toISOString()
        );
        if (!requestSeq.current.isCurrent(token)) return;
        const haveFrom = data.length > 0 ? data[0]!.openTime : Date.now();
        const missing = await api.candlesRange(
          symbol, interval, Date.now() - lookbackMs, haveFrom - 1, bars, signal
        );
        data = missing.length > 0 ? [...missing, ...data] : await api.candles(symbol, interval, bars, signal);
      }

      // The response is applied ONLY if it is still the one being waited for.
      if (!requestSeq.current.isCurrent(token)) return;
      setCandles(data);
    } catch (e) {
      // An abort is this component superseding itself, not a failure to report.
      if (isAbortError(e)) return;
      if (!requestSeq.current.isCurrent(token)) return;
      setErr((e as Error).message);
    } finally {
      if (requestSeq.current.isCurrent(token)) setLoading(false);
    }
  }, [symbol, interval, bars]);

  useEffect(() => { load(); }, [load]);

  // Unmounting must not leave a request running against a dead component.
  useEffect(() => {
    const controller = inFlight.current;
    const seq = requestSeq.current;
    return () => { controller.cancel(); seq.invalidate(); };
  }, []);

  const changeSymbol = (s: string) => { setSymbol(s); setTrades([]); };
  const changeInterval = (i: Interval) => { setInterval(i); setTrades([]); };
  const last = candles[candles.length - 1];

  /**
   * Armed price alerts, drawn as horizontal levels on the chart.
   *
   * Only the ones for the timeframe being looked at: an alert armed on the 1d
   * chart is not a level the 5m chart is watching, and drawing it there would
   * imply a line that will fire from what is on screen.
   */
  const alertPriceLines = useMemo<ChartPriceLine[]>(
    () => maAlerts
      .filter((a) => a.conditionKind === "price" && a.targetPrice !== null &&
                     a.timeframe === interval && isAlertActive(a))
      .map((a) => ({
        price: a.targetPrice!,
        color: alertColor(a),
        title: `🔔 ${describeAlert(a).replace("price ", "")}`,
        dashed: true,
      })),
    [maAlerts, interval]
  );

  const allPriceLines = useMemo(
    () => [...priceLines, ...alertPriceLines],
    [priceLines, alertPriceLines]
  );

  /** MA lines drawn beneath any Pine overlays, so scripts stay on top. */
  const maOverlays = useMemo(() => buildMaOverlays(candles, maLines), [candles, maLines]);
  const maValues = useMemo(() => currentMaValues(candles, maLines), [candles, maLines]);
  const chartOverlays = useMemo(
    () => [...maOverlays, ...indicators.overlays],
    [maOverlays, indicators.overlays]
  );

  /** One definition, rendered twice: as the desktop column and the phone drawer. */
  const drawingToolbarProps = {
    tool, onTool: setTool,
    magnet, onMagnet: setMagnet,
    locked: drawLocked, onLocked: setDrawLocked,
    hidden: drawHidden, onHidden: setDrawHidden,
    onDeleteAll: () => {
      if (window.confirm("Remove all drawings on this symbol?")) updateDrawings([]);
    },
    count: drawings.length,
  };

  /** Phone drawers are mutually exclusive — two overlays at once hides the chart. */
  const togglePanel = (p: Panel) => {
    setToolsOpen(false);
    setPanel((cur) => (cur === p ? null : p));
  };

  const railBtn = (active: boolean): string =>
    `flex h-9 w-9 items-center justify-center rounded-md transition-colors ${
      active ? "bg-surface-2 text-accent" : "text-ink-muted hover:bg-surface-2 hover:text-ink"
    }`;

  return (
    <div className="flex h-full pb-[52px] md:pb-0">
      {/* ── left drawing rail — a column on desktop, a drawer on phones ── */}
      <div className="hidden md:flex">
        <DrawingToolbar {...drawingToolbarProps} />
      </div>
      {toolsOpen && (
        <>
          <button
            aria-label="Close drawing tools"
            onClick={() => setToolsOpen(false)}
            className="fixed inset-0 z-30 bg-black/50 md:hidden"
          />
          <div className="fixed left-0 top-0 z-40 h-full md:hidden">
            <DrawingToolbar {...drawingToolbarProps} floating onClose={() => setToolsOpen(false)} />
          </div>
        </>
      )}

      {/* ── main column ── */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/*
          The chart's title is the symbol and timeframe already shown in the
          toolbar, so a visible heading would repeat it and cost a row of a
          screen this page spends its whole design reclaiming. It is announced
          instead: a screen-reader user navigating by headings otherwise lands
          on a page with no top-level heading at all.
        */}
        <h1 className="sr-only">{symbol} {interval} chart</h1>
        {/* top toolbar */}
        <div className="flex flex-nowrap items-center gap-2 border-b border-border bg-surface px-2 py-1.5 sm:flex-wrap sm:overflow-x-visible sm:px-3">
          {/* Phone-only: site nav lives here, so the global bar can be hidden. */}
          <button
            onClick={() => setNavOpen(true)}
            aria-label="Menu"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-muted hover:bg-surface-2 hover:text-ink md:hidden"
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M4 7h16M4 12h16M4 17h16" />
            </svg>
          </button>
          <button
            onClick={() => setSearchOpen(true)}
            title="Change symbol (/)"
            className="flex shrink-0 items-center gap-1.5 rounded-md bg-surface-2 px-2.5 py-1 text-sm font-semibold text-ink transition-colors hover:bg-border"
          >
            {symbol}
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" className="text-ink-faint">
              <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" />
            </svg>
          </button>
          <span className="shrink-0 text-ink-faint">·</span>
          {/* The interval strip is the only thing allowed to overflow, so the
              ☰ and ⋯ buttons stay pinned at the edges of a narrow screen. */}
          <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto sm:flex-none sm:overflow-visible">
            {INTERVALS.map((i) => (
              <button key={i} onClick={() => changeInterval(i)}
                className={`shrink-0 rounded px-2 py-1 text-[13px] transition-colors ${
                  interval === i ? "bg-surface-2 font-semibold text-ink" : "text-ink-muted hover:text-ink"
                }`}>
                {i}
              </button>
            ))}
          </div>
          {/* Secondary controls: always inline on desktop, behind ⋯ on phones. */}
          <div className={`${moreOpen ? "flex" : "hidden"} order-last w-full flex-wrap items-center gap-2 border-t border-border pt-1.5 md:order-none md:flex md:w-auto md:border-0 md:pt-0`}>
          <span className="hidden text-ink-faint md:inline">·</span>
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
          <SyncMenu value={sync} onChange={setSync} disabled={!splitOpen} />
          {/*
            FE-01: this bell used to open the deployment dialog, which created
            AND activated a live 800 USDT strategy. A bell means "tell me when",
            in this product and in every other one; automation now has its own
            button, below, that says what it does.
          */}
          <button onClick={openPriceAlert}
            title="Notify me when price reaches a level"
            className="flex items-center gap-1.5 rounded px-2 py-1 text-[13px] text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 01-3.46 0" />
            </svg>
            Alert
          </button>
          <button onClick={() => setAlertOpen(true)}
            title="Run this strategy server-side and send live orders to your bot"
            className="flex items-center gap-1.5 rounded px-2 py-1 text-[13px] text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M13 2L4 14h7l-1 8 9-12h-7z" />
            </svg>
            Automate
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
            className="flex items-center gap-1.5 rounded border border-warn/30 bg-warn/10 px-2 py-1 text-[13px] font-medium text-warn transition-colors hover:bg-warn/20 disabled:cursor-wait disabled:opacity-60">
            <span aria-hidden>★</span>
            {loadingBest ? "Loading…" : "Best"}
          </button>
          <div className="flex items-center gap-3 md:ml-auto">
            <span className="tabular text-xs text-ink-muted">
              {last && <>Last <span className="text-ink">{fmtPrice(last.close)}</span></>}
              <span className="ml-3 text-ink-faint">
                {candles.length.toLocaleString()} bars{loading ? " · loading…" : ""}
              </span>
            </span>
            <LayoutMenu
              autosaveError={autosaveError}
              layouts={layouts}
              currentId={currentLayoutId}
              autosave={autosave}
              dirty={dirty}
              {...layoutHandlers}
            />
          </div>
          </div>

          {/* Phone-only overflow toggle for everything above. */}
          <button
            onClick={() => setMoreOpen((v) => !v)}
            aria-label={moreOpen ? "Fewer controls" : "More controls"}
            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md md:hidden ${
              moreOpen ? "bg-surface-2 text-accent" : "text-ink-muted hover:bg-surface-2 hover:text-ink"
            }`}
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
              <circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" />
            </svg>
          </button>
        </div>

        {err && <div className="border-b border-down/30 bg-down/10 px-3 py-1.5 text-xs text-down">{err}</div>}

        {/*
          FE-06: a link asked for something. It has not happened yet, and will
          not until this is accepted. Naming the layout write and the backtest
          explicitly is the point — a user who did not expect either should be
          able to see that before agreeing.
        */}
        {pendingApply && (
          <div
            role="alertdialog"
            aria-label="Apply an optimizer result from this link"
            className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-accent/40 bg-accent/10 px-3 py-2 text-xs text-ink"
          >
            <span className="min-w-0 flex-1">
              This link wants to apply <strong className="font-semibold">{describeApply(pendingApply)}</strong>.
              {pendingApply.payloadRejected && (
                <span className="text-warn">
                  {" "}Its embedded result was malformed and will be ignored; the ranked result
                  will be fetched from the server instead.
                </span>
              )}
            </span>
            <span className="flex shrink-0 items-center gap-2">
              <button
                onClick={() => void applyDeepLink(pendingApply)}
                className="rounded-md bg-accent px-3 py-1 text-xs font-medium text-white hover:bg-accent/90"
              >
                Apply
              </button>
              <button
                onClick={dismissDeepLink}
                className="rounded-md border border-border px-3 py-1 text-xs text-ink-muted hover:text-ink"
              >
                Dismiss
              </button>
            </span>
          </div>
        )}

        {/* charts — one pane, or two side by side sharing the symbol */}
        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
          {loading && candles.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-ink-faint">
              Loading {symbol} {interval}…
            </div>
          ) : (
            <>
            {pickingLevel && (
              <div className="flex items-center justify-between gap-3 border-b border-accent/40 bg-accent/10 px-3 py-1.5 text-xs text-accent">
                <span>Click the chart at the price you want the alert on.</span>
                <button
                  onClick={() => { setPickingLevel(false); setPriceAlertOpen(true); }}
                  className="rounded px-2 py-0.5 hover:bg-accent/20"
                >
                  Cancel
                </button>
              </div>
            )}
            <CandleChart symbol={symbol} interval={interval} candles={candles}
              trades={indicators.trades ?? trades}
              overlays={chartOverlays}
              markers={indicators.markers}
              pineDrawings={indicators.drawings}
              priceLines={allPriceLines} live fill compact={isMobile}
              onPriceSelect={pickingLevel ? pickLevel : undefined}
              drawingTool={tool}
              onDrawingToolDone={() => setTool("cursor")}
              drawings={drawings}
              onDrawingsChange={updateDrawings}
              magnet={magnet}
              drawingsLocked={drawLocked}
              drawingsHidden={drawHidden}
            />
            </>
          )}
          </div>
          {splitOpen && (
            <SplitPane
              symbol={symbol}
              timeframe={sync.interval ? interval : splitInterval}
              onTimeframe={(i) => (sync.interval ? changeInterval(i) : setSplitInterval(i))}
              bars={bars}
              indicators={indicators.list}
              maLines={maLines}
              startTime={BACKTEST_START}
              endTime={todayISO()}
              onClose={() => setSplitOpen(false)}
              onCrosshairMove={(t) => sync.crosshair && setCross({ pane: 2, time: t })}
              crosshairTime={sync.crosshair && cross?.pane === 1 ? cross.time : null}
              onVisibleRangeChange={(r) =>
                (sync.time || sync.dateRange) && setRange({ pane: 2, ...r })}
              visibleRange={sync.dateRange && range?.pane === 1
                ? { from: range.from, to: range.to } : null}
              followEdgeTime={sync.time && !sync.dateRange && range?.pane === 1
                ? range.to : null}
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
                  if (bottomTab === id) toggleBottom();
                  else {
                    setBottomTab(id);
                    setBottomCollapsed(false);
                    window.localStorage.setItem(bottomKey(), "0");
                  }
                }}
                // 22px measured on a phone. The tab strip is also the handle
                // that brings a collapsed panel back, so it has to be pressable
                // with a thumb, not only clickable with a pointer.
                className={`flex min-h-[32px] items-end border-b-2 pb-1.5 text-xs font-medium ${
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
                onClick={toggleBottom}
                title={bottomCollapsed ? "Expand panel" : "Minimize panel"}
                aria-label={bottomCollapsed ? "Expand panel" : "Minimize panel"}
                // 20x20 measured below the 24x24 minimum a pointer target
                // needs, and it is the control that hides the panel covering
                // the chart — the one a phone user reaches for most.
                className="flex h-7 w-7 items-center justify-center rounded text-ink-faint hover:bg-surface-2 hover:text-ink"
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
          <div className="fixed bottom-[52px] right-0 top-0 z-40 md:static md:bottom-auto md:right-auto md:z-auto md:h-auto">
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
                  onArmPrice={openPriceAlert}
                  onArmLevel={setLevelKind}
                  onArmOscillator={setOscillatorKind}
                  onOpenAlert={(a) => {
                    if (a.conditionKind === "price") {
                      setPriceAlertLevel(a.targetPrice);
                      setPriceAlertOpen(true);
                    } else if (a.conditionKind === "sr_zone" || a.conditionKind === "pivot_level") {
                      setLevelKind(a.conditionKind);
                    } else if (a.conditionKind === "rsi" || a.conditionKind === "macd") {
                      setOscillatorKind(a.conditionKind);
                    } else if (a.maType !== null && a.maLength !== null) {
                      setArmLine({ type: a.maType, length: a.maLength });
                    }
                  }}
                  push={<PushSetup onMessage={setToast} />}
                />
              </aside>
            )}
          </div>
        </>
      )}

      {/* ── far-right icon rail (TV-style) ── */}
      <div className="hidden w-12 shrink-0 flex-col items-center gap-1 border-l border-border bg-surface py-2 md:flex">
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
          title="Moving averages and the alerts armed on them"
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
          title="Automations — running strategies and their order log"
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
            <circle cx="12" cy="13" r="7" /><path d="M12 10v3l2 2M5 4L3 6M19 4l2 2" />
          </svg>
        </button>
      </div>

      {/* ── phone action bar (TradingView keeps its controls at the thumb) ── */}
      <nav className="fixed inset-x-0 bottom-0 z-30 flex items-stretch justify-around border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] md:hidden">
        {([
          ["tools", "Draw", toolsOpen, () => { setToolsOpen((v) => !v); setPanel(null); },
            <path d="M4 20l4-1 9-9-3-3-9 9zM15 5l3 3 2-2-3-3z" />],
          ["watchlist", "Watchlist", panel === "watchlist", () => togglePanel("watchlist"),
            <path d="M4 7h16M4 12h16M4 17h10" />],
          ["ma", "MAs", panel === "ma", () => togglePanel("ma"),
            <path d="M3 15c3-7 6 3 9-4s6 2 9-3" />],
          ["indicators", "Studies", panel === "indicators", () => togglePanel("indicators"),
            <><path d="M3 17l5-6 4 4 3-4 6 6" /><path d="M3 20h18" /></>],
          ["alerts", "Automate", panel === "alerts", () => togglePanel("alerts"),
            <path d="M13 2L4 14h7l-1 8 9-12h-7z" />],
        ] as const).map(([id, label, active, onClick, icon]) => (
          <button
            key={id}
            onClick={onClick}
            className={`relative flex flex-1 flex-col items-center gap-0.5 py-1.5 text-[10px] ${
              active ? "text-accent" : "text-ink-muted"
            }`}
          >
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              {icon}
            </svg>
            {label}
            {id === "ma" && maAlerts.length > 0 && (
              <span className="absolute right-1/4 top-0.5 rounded-full bg-accent px-1 text-[8px] font-semibold text-white">
                {maAlerts.length}
              </span>
            )}
          </button>
        ))}
      </nav>

      {/* Site navigation, reachable from the phone toolbar's ☰ */}
      {navOpen && (
        <>
          <button aria-label="Close menu" onClick={() => setNavOpen(false)}
            className="fixed inset-0 z-40 bg-black/60 md:hidden" />
          <div className="fixed left-0 top-0 z-50 flex h-full w-64 flex-col border-r border-border bg-surface p-3 md:hidden">
            <div className="mb-3 flex items-center justify-between">
              <span className="flex items-center gap-2 text-sm font-semibold">
                <span className="inline-block h-2 w-2 rounded-full bg-accent" />SR+Trend
              </span>
              <button onClick={() => setNavOpen(false)} aria-label="Close"
                className="rounded p-1 text-ink-muted hover:bg-surface-2 hover:text-ink">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M4 4l16 16M20 4L4 20" />
                </svg>
              </button>
            </div>
            {[["/chart", "Chart"], ["/alerts", "Alerts"], ["/optimizers", "Optimizers"],
              ["/backtests", "Backtests"], ["/deployments", "Live trading"]].map(([href, label]) => (
              <a key={href} href={href}
                className="rounded-md px-3 py-2 text-sm text-ink-muted hover:bg-surface-2 hover:text-ink">
                {label}
              </a>
            ))}
            <button
              onClick={async () => {
                await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
                window.location.href = "/login";
              }}
              className="mt-auto rounded-md px-3 py-2 text-left text-sm text-ink-muted hover:bg-surface-2 hover:text-ink"
            >
              Sign out
            </button>
          </div>
        </>
      )}

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
      <PriceAlertModal
        open={priceAlertOpen}
        onClose={() => setPriceAlertOpen(false)}
        symbol={symbol}
        chartTimeframe={interval}
        initialPrice={priceAlertLevel}
        lastPrice={last?.close ?? null}
        existing={maAlerts.filter((a) => a.conditionKind === "price")}
        onPickFromChart={() => { setPriceAlertOpen(false); setPickingLevel(true); }}
        onSaved={(message) => { setToast(message); void refreshMaAlerts(); }}
      />
      <LevelAlertModal
        open={levelKind !== null}
        onClose={() => setLevelKind(null)}
        symbol={symbol}
        defaultTimeframe={interval}
        initialKind={levelKind ?? "sr_zone"}
        onSaved={(message) => { setToast(message); void refreshMaAlerts(); }}
      />
      <IndicatorAlertModal
        open={oscillatorKind !== null}
        onClose={() => setOscillatorKind(null)}
        symbol={symbol}
        defaultTimeframe={interval}
        kind={oscillatorKind ?? "rsi"}
        onSaved={(message) => { setToast(message); void refreshMaAlerts(); }}
      />
      <MaAlertModal
        open={armLine !== null}
        onClose={() => setArmLine(null)}
        symbol={symbol}
        chartTimeframe={interval}
        maType={armLine?.type ?? "sma"}
        maLength={armLine?.length ?? 200}
        existing={maAlerts.filter(
          (a) => a.conditionKind === "ma" &&
                 a.maType === armLine?.type && a.maLength === armLine?.length
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
        onCreated={(name) => { setToast(`Automation live — ${name} on ${symbol} ${interval}, sending real orders`); setPanel("alerts"); }}
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
