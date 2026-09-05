"use client";
/**
 * The chart workspace page.
 *
 * ── What this file is now ──────────────────────────────────────────────────
 *
 * Orchestration. It owns the things that are genuinely workspace-wide — the
 * pane layout, which pane is focused, the replay clock, the drawing tool, the
 * strategy tester's configuration, alerts, trading evidence and the order
 * ticket's target — and it hands each pane what that pane needs.
 *
 * It does not own a chart. `ChartToolbar` is the global control bar,
 * `ChartWorkspace` is the layout host, and `ChartPane` is one full chart. Each
 * of those can be worked on without opening this file, which was the point:
 * this page was 1,795 lines and every chart change collided in it.
 *
 * ── The pane model in one paragraph ────────────────────────────────────────
 *
 * `lib/workspace` holds one to sixteen panes, each with an id and its own
 * symbol, interval, presentation, history depth and moving averages. There is
 * no "main chart" and no "split pane" any more; there is a focused pane, and
 * focus is only focus. In particular it does not move a staged order — see
 * `lib/tradingTarget`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type ChartMarker, type ChartPriceLine } from "@/components/CandleChart";
import { ChartPane } from "@/components/tv/ChartPane";
import { ChartToolbar } from "@/components/tv/ChartToolbar";
import { ChartWorkspace } from "@/components/tv/ChartWorkspace";
import { ChartBottomPanel } from "@/components/tv/ChartBottomPanel";
import { ChartSidePanel } from "@/components/tv/ChartSidePanel";
import { ChartDialogs } from "@/components/tv/ChartDialogs";
import { DEFAULT_PROPERTIES, type StrategyProperties } from "@/components/tv/StrategySettingsModal";
import type { IndicatorKind } from "@/components/tv/IndicatorAlertModal";
import type { IndicatorsApi } from "@/lib/useIndicators";
import { clearStored, copyStoredForScope, type AppliedIndicator } from "@/lib/indicators";
import { alertColor, describeAlert, isAlertActive } from "@/lib/alerts";
import {
  describeApply, parseApplyLink, STRATEGY_LABELS, type ApplyRequest,
} from "@/lib/deepLink";
import { useIsMobile } from "@/lib/useIsMobile";
import {
  crosshairForPane, crosshairSyncActive, DEFAULT_SYNC, followEdgeForPane, loadSync,
  rangeSyncActive, saveSync, visibleRangeForPane,
  type CrosshairSignal, type RangeSignal, type SyncOptions,
} from "@/lib/paneSync";
import { loadChartType, saveChartType, type ChartType } from "@/lib/chartType";
import { DrawingToolbar } from "@/components/tv/DrawingToolbar";
import { ReplayControls } from "@/components/tv/ReplayControls";
import { TradingOverlayDetails } from "@/components/tv/TradingOverlays";
import { drawingStore } from "@/lib/drawingStore";
import { useFullscreen } from "@/lib/fullscreen";
import type { Drawing, DrawingTool } from "@/lib/drawings";
import { api, type MaAlert, type ManualTradingState, type OptimizerBest, type PineScript } from "@/lib/api";
import { currentMaValues, defaultMaLines, type MaType } from "@/lib/movingAverages";
import { defaultParamsFor } from "@/lib/paramSchema";
import * as layoutStore from "@/lib/layouts";
import type { WorkspaceState } from "@/lib/layouts";
import { useSavedLayouts } from "@/lib/useSavedLayouts";
import type { Candle, Interval, OpenTrade, Strategy, StrategyParams, SymbolInfo, Trade } from "@/lib/types";
import { fmtPrice } from "@/lib/format";
import { parseScannerChartTarget } from "@/lib/spotScene";
import { sameSymbol } from "@/lib/manualTicket";
import { resolveTradingTarget, tradingTargetNotice, type TradingTarget } from "@/lib/tradingTarget";
import { datasetKey } from "@/lib/liveDataset";
import { useCandleHistory } from "@/lib/useCandleHistory";
import { useLivePrice } from "@/lib/useLivePrice";
import { lastPriceLabel, lastPriceNotice, resolveLastPrice } from "@/lib/lastPrice";
import {
  activePane as focusedPane, applyPaneInterval, applyPaneSymbol, createWorkspace, loadWorkspace,
  paneById, removePane, saveWorkspace, setActivePane, setPaneMaVisibility, setPreset,
  setWorkspaceBars, togglePaneMa, toggleMaximize, updatePane,
  type ChartWorkspace as Workspace, type PaneState,
} from "@/lib/workspace";
import {
  activeReplayQuote, liveActionsDisabled, reconcileReplay, replayCandles, replayDelayMs,
  replayTick, startReplay, stepReplay,
  type ReplaySession, type ReplaySpeed,
} from "@/lib/replay";
import { useTradingOverlays } from "@/lib/useTradingOverlays";

type Panel = "watchlist" | "alerts" | "indicators" | "ma" | "manual" | null;

/** Standard auto-backtest window: 2025-11-01 → today (handoff §7). */
const BACKTEST_START = "2025-11-01";
const todayISO = (): string => new Date().toISOString().slice(0, 10);
const endOfTodayISO = (): string => `${todayISO()}T23:59:59.999Z`;

const DEFAULT_SYMBOL = "SOLUSDT";
const DEFAULT_INTERVAL: Interval = "15m";

const NO_MARKERS: ChartMarker[] = [];
const NO_PRICE_LINES: ChartPriceLine[] = [];
const NO_TRADES: Trade[] = [];

/** What one pane is handed for its instrument, recomputed as a batch. */
interface PaneDecorations {
  markers: ChartMarker[];
  priceLines: ChartPriceLine[];
  trades: Trade[];
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

  // ── the workspace: panes, layout, focus ──
  const [workspace, setWorkspace] = useState<Workspace>(
    () => createWorkspace({ symbol: DEFAULT_SYMBOL, interval: DEFAULT_INTERVAL }));
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const active = focusedPane(workspace);
  const symbol = active.symbol;
  const interval = active.interval;
  const bars = active.bars;
  const paneCount = workspace.panes.length;

  useEffect(() => {
    setWorkspace(loadWorkspace({
      symbol: DEFAULT_SYMBOL, interval: DEFAULT_INTERVAL, chartType: loadChartType(),
    }));
    setWorkspaceReady(true);
  }, []);
  useEffect(() => {
    // Persisted only after the restore has landed, or the initial default
    // would be written straight over the stored workspace.
    if (workspaceReady) saveWorkspace(workspace);
  }, [workspace, workspaceReady]);

  // ── replay: one clock for the whole workspace ──
  const [replay, setReplay] = useState<ReplaySession | null>(null);
  const [replayPickerOpen, setReplayPickerOpen] = useState(false);
  const [replayDrawings, setReplayDrawings] = useState<Drawing[]>([]);
  const replayActive = replay !== null;
  const replayBlocksLiveActions = liveActionsDisabled(replay);

  /*
   * The focused pane's history, read through the SAME shared cache the pane
   * itself uses — so this costs no extra request. The page needs it for the
   * replay picker, the replay quote and the moving-average readout, all of
   * which are questions about the chart the user is looking at.
   */
  const activeHistory = useCandleHistory({ symbol, interval, bars });
  const candles = activeHistory.candles;
  const visibleCandles = useMemo(() => replayCandles(candles, replay), [candles, replay]);
  const replayLast = visibleCandles[visibleCandles.length - 1];
  const replayFirst = visibleCandles[0];

  /*
   * The workspace's Last price.
   *
   * `activeHistory` is a SECOND reader of the shared cache: it is loaded once
   * and never receives live klines, because only the pane's own copy is fed by
   * `mergeLiveBars`. Reading its final close as "Last" is how the toolbar and
   * the price-alert prefill both came to show the close of whatever bar the
   * history happened to end on — hours old on a stale window.
   *
   * The live frame comes from the SAME kline subscription the focused pane is
   * already drawing from (`lib/useLivePrice`), so there is no second market
   * store and no extra socket. Replay outranks it absolutely; before any live
   * frame the newest stored close is used and labelled as exactly that.
   */
  const livePrice = useLivePrice(symbol, interval, { enabled: !replayActive });
  /*
   * While a new window loads, `candles` deliberately still hold the PREVIOUS
   * instrument's bars so the chart does not blank between two symbols — and
   * `activeHistory.dataset` says so. Without this check the history fallback
   * would report BTC's close under SOL's name for the whole of that load, and
   * prefill a SOL alert with it. `ChartPane` holds itself to the same rule for
   * the same readout.
   */
  const holdingRequested =
    datasetKey(activeHistory.dataset) === datasetKey({ symbol, interval });
  const lastPrice = useMemo(() => resolveLastPrice({
    replayActive,
    replayClose: replayLast?.close ?? null,
    liveClose: livePrice.price,
    historyClose: holdingRequested ? candles[candles.length - 1]?.close ?? null : null,
    historyStale: holdingRequested && activeHistory.stale,
  }), [replayActive, replayLast, livePrice.price, candles, holdingRequested, activeHistory.stale]);
  const pineStartTime = replayActive && replayFirst
    ? new Date(replayFirst.openTime).toISOString()
    : `${BACKTEST_START}T00:00:00.000Z`;
  const pineEndTime = replay
    ? new Date(replay.horizonCloseTime).toISOString()
    : endOfTodayISO();

  /*
   * Keep the replay horizon meaningful when the underlying window changes.
   * Guarded on the array identity rather than on `replay`, because
   * `reconcileReplay` returns a fresh session object and an effect keyed on
   * the session would reconcile itself forever.
   */
  const reconciledFrom = useRef<Candle[] | null>(null);
  useEffect(() => {
    if (reconciledFrom.current === candles) return;
    reconciledFrom.current = candles;
    setReplay((current) => (current ? reconcileReplay(current, candles) : null));
  }, [candles]);

  const [err, setErr] = useState<string | null>(null);

  // ── strategy tester (workspace-wide: one tester, on the focused chart) ──
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

  // ── the order ticket's target ──
  /** True while the ticket holds anything an operator typed, chose or attested. */
  const [ticketStaged, setTicketStaged] = useState(false);
  const [tradingTarget, setTradingTarget] = useState<TradingTarget | null>(null);
  useEffect(() => {
    setTradingTarget((previous) => {
      const next = resolveTradingTarget({ workspace, previous, ticketStaged });
      return previous
        && previous.paneId === next.paneId
        && previous.symbol === next.symbol
        && previous.pinned === next.pinned ? previous : next;
    });
  }, [workspace, ticketStaged]);
  const tradingSymbol = tradingTarget?.symbol ?? symbol;
  const tradingNotice = tradingTarget ? tradingTargetNotice(tradingTarget, workspace) : null;

  const [manualState, setManualState] = useState<ManualTradingState | null>(null);
  /** When `manualState` was last read successfully (ms since epoch); null until then. */
  const [manualReadAt, setManualReadAt] = useState<number | null>(null);
  /**
   * Why the latest read failed, for the bottom strip; the ticket has its own.
   * Set beside a retained `manualState` it means "what you see is from
   * `manualReadAt`, not now" — the strip says so rather than passing the last
   * good positions and P&L off as current.
   */
  const [manualUnavailable, setManualUnavailable] = useState<string | null>(null);
  /** Every successful read — the poll's or the ticket's — lands through here. */
  const recordManualState = useCallback((next: ManualTradingState | null) => {
    setManualState(next);
    setManualReadAt(Date.now());
    setManualUnavailable(null);
  }, []);
  // Read-only state hydration draws existing server-authoritative levels. It
  // never submits, retries, or mutates an order on page load/reconnect.
  useEffect(() => {
    if (replayActive) return;
    let live = true;
    const refreshManual = async () => {
      try {
        const next = await api.manualState(tradingSymbol);
        if (live) recordManualState(next);
      } catch (e) {
        // Normally the feature is disabled on this install; the strip says
        // so in the Bot's own words rather than showing an empty table.
        if (live) setManualUnavailable((e as Error).message);
      }
    };
    void refreshManual();
    const timer = window.setInterval(() => void refreshManual(), 30_000);
    return () => { live = false; window.clearInterval(timer); };
  }, [tradingSymbol, replayActive, recordManualState]);

  // ── authoritative read-only trading evidence, for the focused instrument ──
  const overlays = useTradingOverlays({
    symbol, interval, visibleCandles, replayCutoff: replay?.horizonCloseTime ?? null,
  });

  // ── phone chrome: everything optional starts closed so the chart gets the screen ──
  const isMobile = useIsMobile();
  /** Drawing rail — a floating drawer on phones, always-on column on desktop. */
  const [toolsOpen, setToolsOpen] = useState(false);
  /** Second row of the toolbar (history depth, overlays, automation, strategy). */
  const [moreOpen, setMoreOpen] = useState(false);
  /** The indicator library dialog. Separate from the applied-studies panel. */
  const [indicatorBrowserOpen, setIndicatorBrowserOpen] = useState(false);
  /*
   * Fullscreen for the chart workspace — the drawing rail, the charts and the
   * side panels, but not the site's own navigation bar, which is chrome the
   * chart does not need. The browser's own API, so Escape and the OS
   * affordance both work and the page is told when they are used.
   */
  const fullscreen = useFullscreen<HTMLDivElement>();
  /** Site navigation, which is hidden on the phone chart to reclaim a whole row. */
  const [navOpen, setNavOpen] = useState(false);

  // ── pane synchronisation ──
  const [sync, setSyncState] = useState<SyncOptions>(DEFAULT_SYNC);
  useEffect(() => { setSyncState(loadSync()); }, []);
  const setSync = useCallback((next: SyncOptions) => {
    setSyncState(next);
    saveSync(next);
  }, []);

  /**
   * Where the pointer is and what is on screen, each tagged with the pane that
   * produced it. One piece of state, read through `lib/paneSync`, which never
   * returns a pane its own signal — the rule that makes mirroring safe for any
   * number of panes rather than exactly two.
   */
  const [cross, setCross] = useState<CrosshairSignal | null>(null);
  const [range, setRange] = useState<RangeSignal | null>(null);
  const emitCrosshair = useCallback(
    (paneId: string, time: number | null) => setCross({ paneId, time }), []);
  const emitRange = useCallback(
    (paneId: string, r: { from: number; to: number }) => setRange({ paneId, ...r }), []);

  // On phones the side panel is an overlay drawer, so start it closed —
  // otherwise it covers the chart on first load.
  useEffect(() => {
    if (typeof window !== "undefined" && window.innerWidth < 768) setPanel(null);
  }, []);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [alertOpen, setAlertOpen] = useState(false);
  /** Which pane the symbol dialog will retarget, or null when it is closed. */
  const [searchPaneId, setSearchPaneId] = useState<string | null>(null);

  // ── drawings (persisted per symbol, shared by every pane on it) ──
  const [tool, setTool] = useState<DrawingTool>("cursor");
  const [magnet, setMagnet] = useState(false);
  const [drawLocked, setDrawLocked] = useState(false);
  const [drawHidden, setDrawHidden] = useState(false);
  const [activeDrawings, setActiveDrawings] = useState<Drawing[]>([]);
  useEffect(() => drawingStore.subscribe(symbol, setActiveDrawings), [symbol]);

  /** A library script the bottom panel's editor was asked to open. */
  const [editorScript, setEditorScript] = useState<PineScript | null>(null);
  /** Applied instance being edited; null means Add creates a new instance. */
  const [editingIndicatorKey, setEditingIndicatorKey] = useState<string | null>(null);

  // ── each pane's applied studies, registered for the workspace panel ──
  /*
   * Studies belong to a pane, so the hook that owns them lives in the pane.
   * The Indicators panel and the Pine editor are workspace surfaces that act
   * on the FOCUSED pane's studies, so each pane registers a getter (stable, so
   * the registration effect does not run every render) and reports its list
   * (identity changes only when the list really does).
   */
  const indicatorApis = useRef(new Map<string, () => IndicatorsApi>());
  const [indicatorLists, setIndicatorLists] = useState<Record<string, AppliedIndicator[]>>({});
  const registerIndicatorsApi = useCallback(
    (paneId: string, get: (() => IndicatorsApi) | null) => {
      if (get) indicatorApis.current.set(paneId, get);
      else {
        indicatorApis.current.delete(paneId);
        setIndicatorLists((current) => {
          if (!(paneId in current)) return current;
          const next = { ...current };
          delete next[paneId];
          return next;
        });
      }
    }, []);
  const registerIndicatorList = useCallback((paneId: string, list: AppliedIndicator[]) => {
    setIndicatorLists((current) => (current[paneId] === list
      ? current : { ...current, [paneId]: list }));
  }, []);

  const activeIndicatorList = useMemo(
    () => indicatorLists[active.id] ?? [], [indicatorLists, active.id]);
  const activeIndicators = useMemo<IndicatorsApi | null>(() => {
    const get = indicatorApis.current.get(active.id);
    if (!get) return null;
    // The list is taken from the reported copy rather than the getter's, which
    // is one render behind on the frame a study settles.
    return { ...get(), list: activeIndicatorList };
  }, [active.id, activeIndicatorList]);

  /** Replay must not outrun the studies drawn on any pane. */
  const replayIndicatorLoading = useMemo(
    () => Object.values(indicatorLists).some((list) => list.some((i) => i.loading)),
    [indicatorLists]);

  // ── moving averages, per pane ──
  const maLines = active.maLines;
  const [maAlerts, setMaAlerts] = useState<MaAlert[]>([]);
  const [armLine, setArmLine] = useState<{ type: MaType; length: number } | null>(null);
  /** The armed alert opened for editing from the rail, or null. */
  const [editingAlert, setEditingAlert] = useState<MaAlert | null>(null);
  /** The instance whose settings the Indicators panel should open on. */
  const [indicatorFocusKey, setIndicatorFocusKey] = useState<string | null>(null);
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
    setWorkspace((ws) => togglePaneMa(ws, ws.activePaneId, type, length));
  }, []);

  const toggleAllMa = useCallback((visible: boolean) => {
    setWorkspace((ws) => setPaneMaVisibility(ws, ws.activePaneId, visible));
  }, []);

  const maValues = useMemo(
    () => currentMaValues(visibleCandles, maLines), [visibleCandles, maLines]);

  /** Editor apply either replaces one stable instance or creates a new one. */
  const applyPine = useCallback((payload: { name: string; source: string; params: Record<string, number | string | boolean> }) => {
    const indicators = indicatorApis.current.get(active.id)?.();
    if (!indicators) return;
    if (editingIndicatorKey) {
      indicators.updateSource(editingIndicatorKey, payload);
      setEditingIndicatorKey(null);
    } else {
      indicators.add({ scriptId: null, name: payload.name, source: payload.source, params: payload.params });
    }
    setOpenTrade(null);
    setPanel("indicators");
  }, [editingIndicatorKey, active.id]);

  const openInEditor = useCallback((s: PineScript) => {
    setEditingIndicatorKey(null);
    setEditorScript(s);
  }, []);

  const editIndicator = useCallback((indicator: AppliedIndicator) => {
    setEditingIndicatorKey(indicator.key);
    setEditorScript({
      id: indicator.scriptId ?? "",
      name: indicator.name,
      source: indicator.source,
      kind: indicator.kind,
      createdAt: "",
      updatedAt: "",
    });
  }, []);

  /**
   * A pane asked the workspace to open the Indicators panel on one instance.
   *
   * Focusing the pane first is what makes the panel show the right list: the
   * panel acts on the focused pane, and the request came from a pane the user
   * just clicked inside.
   */
  const focusIndicator = useCallback((paneId: string, key: string) => {
    setWorkspace((ws) => setActivePane(ws, paneId));
    setIndicatorFocusKey(key);
    setPanel("indicators");
  }, []);

  const updateReplayDrawings = useCallback((next: Drawing[]) => setReplayDrawings(next), []);
  const [toast, setToast] = useState<string | null>(null);
  const [loadingBest, setLoadingBest] = useState(false);
  const [bestRange, setBestRange] = useState<{ start: string; end: string; nonce: number; run?: boolean } | null>(null);
  /** An optimizer link's request, waiting for the user to accept it. See FE-06. */
  const [pendingApply, setPendingApply] = useState<ApplyRequest | null>(null);

  // ── saved layouts (server-side; the pane arrangement is device-local) ──
  const workspaceState = useMemo<WorkspaceState>(
    () => ({ symbol, interval, bars, strategyKey, params, properties, movingAverages: maLines }),
    [symbol, interval, bars, strategyKey, params, properties, maLines]
  );

  /** A saved layout describes one chart; it is applied to the focused pane. */
  const applyState = useCallback((s: WorkspaceState) => {
    setWorkspace((ws) => setWorkspaceBars(updatePane(ws, ws.activePaneId, {
      symbol: s.symbol,
      interval: s.interval,
      maLines: s.movingAverages?.length ? s.movingAverages : defaultMaLines(),
    }), s.bars));
    setStrategyKey(s.strategyKey);
    setParams(s.params);
    setProperties(s.properties);
    setTrades([]);
  }, []);

  /** Opening a layout always backtests 2025-11-01 → today automatically. */
  const queueAutoBacktest = useCallback(() => {
    setBestRange({ start: BACKTEST_START, end: todayISO(), nonce: Date.now(), run: true });
  }, []);

  /*
   * A deep link owns the workspace on the load it arrives with, so the stored
   * layout must not fight it. Read once, at mount, from the URL the page was
   * opened with — `applyDeepLink` rewrites that URL when the user accepts.
   */
  const [deepLinkOwnsLoad] = useState(() => typeof window !== "undefined"
    && (parseApplyLink(window.location.search) !== null
      || parseScannerChartTarget(window.location.search) !== null));

  const savedLayouts = useSavedLayouts({
    workspaceState,
    applyLayout: applyState,
    onRestored: queueAutoBacktest,
    skipRestore: deepLinkOwnsLoad,
    defaultName: `${symbol} ${interval}`,
    onToast: setToast,
    onError: setErr,
  });
  const refreshLayouts = savedLayouts.refresh;
  const setCurrentLayoutId = savedLayouts.setCurrentId;

  const applyBestConfig = useCallback(async () => {
    setLoadingBest(true);
    setErr(null);
    try {
      const best = await api.optimizerBest(symbol, 1, strategyKey, interval);
      setStrategyKey(best.strategyKey);
      setParams(best.params);
      setProperties((prev) => withOptimizerProperties(prev, best.properties));
      setWorkspace((ws) => applyPaneInterval(ws, ws.activePaneId, best.timeframe, sync));
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
  }, [symbol, strategyKey, interval, sync]);

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

  // Scanner navigation is a read-only workspace prefill. It selects the exact
  // existing Platform Spot symbol and, for Trade, opens the normal manual ticket.
  // It never chooses a side/size or submits an order.
  useEffect(() => {
    const target = parseScannerChartTarget(window.location.search);
    if (!target) return;
    setWorkspace((ws) => applyPaneSymbol(ws, ws.activePaneId, target.symbol, DEFAULT_SYNC));
    setTrades([]);
    if (target.panel === "manual") setPanel("manual");
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
      setWorkspace((ws) => applyPaneInterval(
        applyPaneSymbol(ws, ws.activePaneId, request.symbol, sync),
        ws.activePaneId, best.timeframe, sync));
      setStrategyKey(best.strategyKey);
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
  }, [properties, bars, maLines, refreshLayouts, setCurrentLayoutId, sync]);

  const dismissDeepLink = useCallback(() => {
    setPendingApply(null);
    window.history.replaceState({}, "", "/chart");
  }, []);

  // Mount: the tradable symbols and the strategy list.
  const refreshSymbols = useCallback(() => {
    api.listSymbols().then(setSymbols).catch(() => {});
  }, []);

  useEffect(() => {
    refreshSymbols();
    api.listStrategies().then((s) => {
      setStrategies(s);
      if (s.length > 0 && !s.some((x) => x.key === "ma_rr_v9")) setStrategyKey(s[0].key);
    }).catch(() => {});
  }, [refreshSymbols]);

  // "/" opens symbol search, like TV. ⌘S is the saved-layout hook's.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Never while typing in a field.
      const el = e.target as HTMLElement | null;
      const typing = !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setSearchPaneId(active.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active.id]);


  // ── workspace actions ──
  const pauseReplayForNavigation = useCallback(() => {
    if (!replayActive) return;
    setReplay((current) => (current ? { ...current, playing: false } : null));
    setReplayDrawings([]);
  }, [replayActive]);

  const changePaneSymbol = useCallback((paneId: string, next: string) => {
    pauseReplayForNavigation();
    setWorkspace((ws) => applyPaneSymbol(ws, paneId, next, sync));
    setTrades([]);
  }, [pauseReplayForNavigation, sync]);

  const changePaneInterval = useCallback((paneId: string, next: Interval) => {
    pauseReplayForNavigation();
    setWorkspace((ws) => applyPaneInterval(ws, paneId, next, sync));
    setTrades([]);
  }, [pauseReplayForNavigation, sync]);

  const activatePane = useCallback((paneId: string) => {
    setWorkspace((ws) => setActivePane(ws, paneId));
  }, []);

  const clearDrawingTool = useCallback(() => setTool("cursor"), []);

  /**
   * Change the layout, and copy the focused pane's studies into any pane the
   * change created.
   *
   * A new pane clones the chart the user was looking at, which is what asking
   * for another chart means. The copy is explicit and by value — the new pane
   * gets its own stored list and its own params objects, so retuning a study
   * on one chart cannot retune it on another.
   */
  const changePreset = useCallback((presetId: string) => {
    const next = setPreset(workspace, presetId);
    const existing = new Set(workspace.panes.map((p) => p.id));
    for (const pane of next.panes) {
      if (!existing.has(pane.id)) copyStoredForScope(workspace.activePaneId, pane.id);
    }
    setWorkspace(next);
  }, [workspace]);

  /**
   * Close a pane.
   *
   * Its studies go with it — they were that pane's, and a later pane reusing
   * the id would otherwise inherit them. Its DRAWINGS do not: those are stored
   * per instrument and belong to the symbol, not to a view of it.
   */
  const closePane = useCallback((paneId: string) => {
    setWorkspace((ws) => {
      const next = removePane(ws, paneId);
      if (next !== ws) clearStored(paneId);
      return next;
    });
  }, []);

  const toggleMaximizePane = useCallback((paneId: string) => {
    setWorkspace((ws) => toggleMaximize(ws, paneId));
  }, []);

  const changeChartType = useCallback((next: ChartType) => {
    setWorkspace((ws) => updatePane(ws, ws.activePaneId, { chartType: next }));
    // Also the default for panes created later, which is what a workspace-level
    // presentation preference has always meant here.
    saveChartType(next);
  }, []);

  const changeBars = useCallback((next: number) => {
    setWorkspace((ws) => setWorkspaceBars(ws, next));
  }, []);

  const beginReplay = useCallback((requestedTime: number) => {
    const next = startReplay(candles, requestedTime);
    if (!next) { setErr("No completed candle exists at or before that replay point."); return; }
    setReplay(next);
    setReplayPickerOpen(false);
    setReplayDrawings([]);
    setTrades([]); setOpenTrade(null);
    setToast(null); setPendingApply(null);
    setPickingLevel(false); setPriceAlertOpen(false);
    setLevelKind(null); setOscillatorKind(null); setEditingAlert(null); setArmLine(null);
    setAlertOpen(false);
    setPanel((current) => current === "indicators" || current === "watchlist" ? current : null);
  }, [candles]);

  const exitReplay = useCallback(() => {
    setReplay(null); setReplayPickerOpen(false); setReplayDrawings([]);
  }, []);
  const setReplayPlaying = useCallback((playing: boolean) => {
    setReplay((current) => current ? { ...current, playing } : null);
  }, []);
  const setReplaySpeed = useCallback((speed: ReplaySpeed) => {
    setReplay((current) => current ? { ...current, speed } : null);
  }, []);

  useEffect(() => {
    if (!replay?.playing || replayIndicatorLoading) return;
    const timer = window.setTimeout(() => {
      setReplay((current) => current ? replayTick(current, candles) : null);
    }, replayDelayMs(replay.speed));
    return () => window.clearTimeout(timer);
  }, [candles, replay, replayIndicatorLoading]);

  /**
   * Armed price alerts, drawn as horizontal levels on the chart.
   *
   * Only the ones for the timeframe being looked at: an alert armed on the 1d
   * chart is not a level the 5m chart is watching, and drawing it there would
   * imply a line that will fire from what is on screen.
   */
  const alertLinesFor = useCallback((paneInterval: Interval): ChartPriceLine[] =>
    maAlerts
      .filter((a) => a.conditionKind === "price" && a.targetPrice !== null &&
                     a.timeframe === paneInterval && isAlertActive(a))
      .map((a) => ({
        price: a.targetPrice!,
        color: alertColor(a),
        // Text, not an emoji: this is drawn into the price scale by the chart
        // canvas, where a platform emoji renders at its own size and colour and
        // cannot inherit the line's.
        title: `Alert · ${describeAlert(a).replace("price ", "")}`,
        dashed: true,
      })), [maAlerts]);

  /** Server-authoritative manual entry and bot-managed TP/SL levels. */
  const manualPriceLines = useMemo<ChartPriceLine[]>(() => {
    const lines: ChartPriceLine[] = [];
    for (const position of manualState?.positions.filter((p) => p.pair === tradingSymbol && p.status === "active") ?? []) {
      const tag = position.id.slice(0, 4);
      // Entry is rendered by the normalized explicit ManualPosition overlay;
      // these remain the separate Bot-managed protection levels.
      if (position.manualTpPrice != null) lines.push({ price: position.manualTpPrice, color: "#2ebd85", title: `MANUAL TP · BOT · ${tag}`, dashed: true });
      if (position.manualSlPrice != null) lines.push({ price: position.manualSlPrice, color: "#f6465d", title: `MANUAL SL · BOT · ${tag}`, dashed: true });
    }
    return lines;
  }, [manualState, tradingSymbol]);

  /**
   * What each pane draws that came from outside it.
   *
   * Everything here is scoped by INSTRUMENT, not by focus. Alert levels, open
   * positions and trading evidence belong to a symbol; drawing another pane's
   * evidence on this chart because it happens to be focused would put lines on
   * a price series they were never about. Panes on an instrument the workspace
   * has no evidence for simply get nothing.
   */
  const paneDecorations = useMemo(() => {
    const map = new Map<string, PaneDecorations>();
    for (const pane of workspace.panes) {
      const onEvidenceSymbol = sameSymbol(pane.symbol, symbol);
      const onTradingSymbol = sameSymbol(pane.symbol, tradingSymbol);
      const markers = onEvidenceSymbol ? overlays.markers : NO_MARKERS;
      if (replayActive) {
        map.set(pane.id, {
          markers,
          priceLines: onEvidenceSymbol ? overlays.priceLines : NO_PRICE_LINES,
          trades: NO_TRADES,
        });
        continue;
      }
      const lines: ChartPriceLine[] = [];
      // The tester runs one strategy on one chart; its levels belong only to
      // the pane that matches what was tested.
      if (onEvidenceSymbol && pane.interval === interval) lines.push(...priceLines);
      if (onEvidenceSymbol) lines.push(...alertLinesFor(pane.interval));
      if (onTradingSymbol) lines.push(...manualPriceLines);
      if (onEvidenceSymbol) lines.push(...overlays.priceLines);
      map.set(pane.id, {
        markers,
        priceLines: lines.length > 0 ? lines : NO_PRICE_LINES,
        trades: onEvidenceSymbol && pane.interval === interval ? trades : NO_TRADES,
      });
    }
    return map;
  }, [workspace.panes, symbol, tradingSymbol, interval, replayActive, overlays.markers,
    overlays.priceLines, priceLines, alertLinesFor, manualPriceLines, trades]);

  /** One definition, rendered twice: as the desktop column and the phone drawer. */
  const drawingToolbarProps = {
    tool, onTool: setTool,
    magnet, onMagnet: setMagnet,
    locked: drawLocked, onLocked: setDrawLocked,
    hidden: drawHidden, onHidden: setDrawHidden,
    onDeleteAll: () => {
      if (window.confirm(`Remove all drawings on ${symbol}?`)) {
        if (replayActive) updateReplayDrawings([]); else drawingStore.set(symbol, []);
      }
    },
    count: replayActive ? replayDrawings.length : activeDrawings.length,
  };


  const publishCrosshair = paneCount > 1 && crosshairSyncActive(sync) ? emitCrosshair : undefined;
  const publishRange = paneCount > 1 && rangeSyncActive(sync) ? emitRange : undefined;

  const renderPane = useCallback((pane: PaneState, context: { maximized: boolean }) => {
    const decorations = paneDecorations.get(pane.id);
    const isActive = pane.id === workspace.activePaneId;
    return (
      <ChartPane
        pane={pane}
        active={isActive}
        maximized={context.maximized}
        canMaximize={paneCount > 1}
        canClose={paneCount > 1}
        onActivate={activatePane}
        onInterval={changePaneInterval}
        onOpenSymbolSearch={setSearchPaneId}
        onToggleMaximize={toggleMaximizePane}
        onClose={closePane}
        replay={replay}
        replayDrawings={replayDrawings}
        onReplayDrawingsChange={updateReplayDrawings}
        crosshairTime={crosshairForPane(cross, pane.id, sync)}
        visibleRange={visibleRangeForPane(range, pane.id, sync)}
        followEdgeTime={followEdgeForPane(range, pane.id, sync)}
        onCrosshairMove={publishCrosshair}
        onVisibleRangeChange={publishRange}
        drawingTool={tool}
        onDrawingToolDone={clearDrawingTool}
        magnet={magnet}
        drawingsLocked={drawLocked}
        drawingsHidden={drawHidden}
        markers={decorations?.markers ?? NO_MARKERS}
        priceLines={decorations?.priceLines ?? NO_PRICE_LINES}
        strategyTrades={decorations?.trades ?? NO_TRADES}
        onAnnotationSelect={overlays.select}
        onPriceSelect={pickingLevel && isActive ? pickLevel : undefined}
        onViewportChange={isActive ? overlays.setViewport : undefined}
        startTime={pineStartTime}
        endTime={pineEndTime}
        onIndicatorsApi={registerIndicatorsApi}
        onIndicatorList={registerIndicatorList}
        onFocusIndicator={focusIndicator}
        compact={isMobile}
      />
    );
  }, [paneDecorations, workspace.activePaneId, paneCount, activatePane, changePaneInterval,
    toggleMaximizePane, closePane, replay, replayDrawings, updateReplayDrawings, cross, range,
    sync, publishCrosshair, publishRange, tool, clearDrawingTool, magnet, drawLocked,
    drawHidden, pickingLevel, pickLevel, pineStartTime, pineEndTime, registerIndicatorsApi,
    registerIndicatorList, focusIndicator, isMobile, overlays.select, overlays.setViewport]);

  return (
    <div ref={fullscreen.ref} className="flex h-full bg-bg pb-[52px] md:pb-0">
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
        <h1 className="sr-only">
          {symbol} {interval} chart{paneCount > 1 ? ` — ${paneCount}-chart layout` : ""}
        </h1>

        <ChartToolbar
          symbol={symbol}
          interval={interval}
          onOpenSearch={() => setSearchPaneId(active.id)}
          onInterval={(i) => changePaneInterval(active.id, i)}
          chartType={active.chartType}
          onChartType={changeChartType}
          presetId={workspace.presetId}
          onPreset={changePreset}
          sync={sync}
          onSync={setSync}
          syncDisabled={paneCount < 2}
          bars={bars}
          onBars={changeBars}
          indicatorCount={activeIndicatorList.length}
          onOpenIndicators={() => setIndicatorBrowserOpen(true)}
          replayActive={replayActive}
          replayPickerOpen={replayPickerOpen}
          onToggleReplayPicker={() => setReplayPickerOpen((open) => replayActive ? open : !open)}
          replayBlocksLiveActions={replayBlocksLiveActions}
          fullscreen={fullscreen.active}
          fullscreenSupported={fullscreen.supported}
          onToggleFullscreen={fullscreen.toggle}
          overlayMenuOpen={overlays.menuOpen}
          onOverlayMenuOpen={overlays.setMenuOpen}
          overlayPrefs={overlays.prefs}
          onOverlayPrefs={overlays.setPrefs}
          overlayData={overlays.data}
          overlaysLoading={overlays.loading}
          overlayError={overlays.error}
          overlayItems={overlays.items}
          onSelectOverlay={overlays.select}
          onOpenPriceAlert={openPriceAlert}
          onOpenAutomation={() => setAlertOpen(true)}
          onOpenManual={() => setPanel((p) => p === "manual" ? null : "manual")}
          /* Exactly the condition under which ChartSidePanel renders the
             ticket, and therefore under which the toolbar's row is 341px
             narrower than the viewport it is measured against. */
          ticketOpen={panel === "manual" && !replayActive}
          onOpenStrategy={() => setSettingsOpen(true)}
          onApplyBest={() => void applyBestConfig()}
          loadingBest={loadingBest}
          readout={
            <span className="tabular whitespace-nowrap text-xs text-ink-muted">
              {lastPrice.price !== null && (
                <span title={lastPriceNotice(lastPrice) ?? undefined}>
                  {lastPriceLabel(lastPrice)}{" "}
                  <span className="text-ink">{fmtPrice(lastPrice.price)}</span>
                </span>
              )}
              <span className="ml-3 text-ink-faint">
                {visibleCandles.length.toLocaleString()} bars{activeHistory.loading ? " · loading…" : ""}
              </span>
            </span>
          }
          layouts={savedLayouts.layouts}
          currentLayoutId={savedLayouts.currentId}
          autosave={savedLayouts.autosave}
          layoutDirty={savedLayouts.dirty}
          autosaveError={savedLayouts.autosaveError}
          layoutHandlers={savedLayouts.handlers}
          moreOpen={moreOpen}
          onMoreOpen={setMoreOpen}
          onOpenNav={() => setNavOpen(true)}
        />

        <ReplayControls
          candles={candles} session={replay} pickerOpen={replayPickerOpen}
          onStart={beginReplay} onCancel={() => setReplayPickerOpen(false)}
          onPrevious={() => setReplay((current) => current ? stepReplay(current, candles, -1) : null)}
          onNext={() => setReplay((current) => current ? stepReplay(current, candles, 1) : null)}
          onPlaying={setReplayPlaying} onSpeed={setReplaySpeed} onExit={exitReplay}
        />

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

        {pickingLevel && (
          <div className="flex items-center justify-between gap-3 border-b border-accent/40 bg-accent/10 px-3 py-1.5 text-xs text-accent">
            <span>Click the focused chart at the price you want the alert on.</span>
            <button
              onClick={() => { setPickingLevel(false); setPriceAlertOpen(true); }}
              className="rounded px-2 py-0.5 hover:bg-accent/20"
            >
              Cancel
            </button>
          </div>
        )}

        {/* the panes */}
        <div className="relative flex min-h-0 flex-1 flex-col">
          <ChartWorkspace workspace={workspace} renderPane={renderPane} />
          {overlays.selected && <TradingOverlayDetails item={overlays.selected}
            onClose={() => overlays.select(null)} />}
        </div>

        <ChartBottomPanel
          symbol={symbol}
          interval={interval}
          replayActive={replayActive}
          strategies={strategies}
          strategy={strategy}
          onStrategyChange={(k) => {
            setStrategyKey(k); setParams(defaultParamsFor(k)); setTrades([]); setOpenTrade(null);
          }}
          onOpenSettings={() => setSettingsOpen(true)}
          properties={properties}
          params={params}
          requestedRange={bestRange}
          onTrades={setTrades}
          onOpenTrade={setOpenTrade}
          startTime={pineStartTime}
          endTime={pineEndTime}
          indicatorCount={activeIndicatorList.length}
          onOpenIndicators={() => setPanel("indicators")}
          openScript={editorScript}
          openParams={editingIndicatorKey
            ? activeIndicatorList.find((item) => item.key === editingIndicatorKey)?.params
            : undefined}
          onOpenScriptConsumed={() => setEditorScript(null)}
          onApplyToChart={applyPine}
          editingApplied={editingIndicatorKey !== null}
          manualState={manualState}
          manualReadAt={manualReadAt}
          manualUnavailable={manualUnavailable}
          tradingSymbol={tradingSymbol}
          onOpenTicket={() => setPanel("manual")}
        />
      </div>

      <ChartSidePanel
        panel={panel}
        onPanel={setPanel}
        onClosePanel={() => setPanel(null)}
        symbol={symbol}
        interval={interval}
        replayActive={replayActive}
        replayBlocksLiveActions={replayBlocksLiveActions}
        symbols={symbols}
        onSelectSymbol={(s) => changePaneSymbol(active.id, s)}
        onSymbolsChanged={refreshSymbols}
        replayQuote={activeReplayQuote(candles, replay)}
        onOpenAutomation={() => setAlertOpen(true)}
        indicators={activeIndicators}
        indicatorCount={activeIndicatorList.length}
        indicatorFocusKey={indicatorFocusKey}
        onOpenInEditor={openInEditor}
        onEditIndicator={editIndicator}
        tradingSymbol={tradingSymbol}
        tradingLastPrice={sameSymbol(tradingSymbol, symbol) ? lastPrice.price : null}
        tradingNotice={tradingNotice}
        onTicketStagedChange={setTicketStaged}
        onManualState={recordManualState}
        maLines={maLines}
        maValues={maValues}
        maAlerts={maAlerts}
        onToggleMa={toggleMa}
        onToggleAllMa={toggleAllMa}
        onArmMa={(type, length) => setArmLine({ type, length })}
        onArmPrice={openPriceAlert}
        onArmLevel={setLevelKind}
        onArmOscillator={setOscillatorKind}
        onOpenAlert={setEditingAlert}
        onToast={setToast}
        toolsOpen={toolsOpen}
        onToolsOpen={setToolsOpen}
        navOpen={navOpen}
        onCloseNav={() => setNavOpen(false)}
      />

      <ChartDialogs
        symbol={symbol}
        interval={interval}
        settingsOpen={settingsOpen}
        onCloseSettings={() => setSettingsOpen(false)}
        strategy={strategy}
        strategyKey={strategyKey}
        strategies={strategies}
        params={params}
        properties={properties}
        onApplyStrategy={(p, props) => { setParams(p); setProperties(props); }}
        indicatorBrowserOpen={indicatorBrowserOpen}
        onCloseIndicatorBrowser={() => setIndicatorBrowserOpen(false)}
        indicators={activeIndicators}
        onOpenInEditor={openInEditor}
        searchPaneId={searchPaneId}
        searchSymbol={(searchPaneId ? paneById(workspace, searchPaneId)?.symbol : symbol) ?? symbol}
        onCloseSearch={() => setSearchPaneId(null)}
        onSelectSymbol={(s) => { if (searchPaneId) changePaneSymbol(searchPaneId, s); }}
        onSymbolAdded={refreshSymbols}
        maAlerts={maAlerts}
        priceAlertOpen={priceAlertOpen}
        onClosePriceAlert={() => setPriceAlertOpen(false)}
        priceAlertLevel={priceAlertLevel}
        lastPrice={lastPrice.price}
        lastPriceNotice={lastPriceNotice(lastPrice)}
        onPickFromChart={() => { setPriceAlertOpen(false); setPickingLevel(true); }}
        levelKind={levelKind}
        onCloseLevel={() => setLevelKind(null)}
        oscillatorKind={oscillatorKind}
        onCloseOscillator={() => setOscillatorKind(null)}
        editingAlert={editingAlert}
        onCloseEditingAlert={() => setEditingAlert(null)}
        armLine={armLine}
        onCloseArmLine={() => setArmLine(null)}
        alertOpen={alertOpen}
        onCloseAlert={() => setAlertOpen(false)}
        onAutomationCreated={(name) => {
          setToast(`Automation live — ${name} on ${symbol} ${interval}, sending real orders`);
          setPanel("alerts");
        }}
        onAlertSaved={(message) => { setToast(message); void refreshMaAlerts(); }}
        toast={toast}
        onDismissToast={() => setToast(null)}
      />
    </div>
  );
}
