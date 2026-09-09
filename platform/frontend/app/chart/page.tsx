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
import { ChartSidePanel, type ChartPanel } from "@/components/tv/ChartSidePanel";
import { ChartDialogs } from "@/components/tv/ChartDialogs";
import { NativeStudySettings } from "@/components/tv/NativeStudySettings";
import { DEFAULT_PROPERTIES, type StrategyProperties } from "@/components/tv/StrategySettingsModal";
import type { IndicatorKind } from "@/components/tv/IndicatorAlertModal";
import type { IndicatorsApi } from "@/lib/useIndicators";
import type { NativeStudiesApi } from "@/lib/useNativeStudies";
import { clearStoredNative, copyStoredNativeForScope } from "@/lib/useNativeStudies";
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
import { cloneDrawing } from "@/lib/drawingHistory";
import { ContextMenu } from "@/components/tv/ContextMenu";
import type { MenuEntry } from "@/lib/contextMenu";
import { chartMenu, drawingMenu, priceAxisMenu } from "@/lib/menuPayloads";
import { useShortcuts } from "@/lib/useShortcuts";
import { ShortcutsSheet } from "@/components/tv/ShortcutsSheet";
import { useFullscreen } from "@/lib/fullscreen";
import { newId, type Drawing, type DrawingTool } from "@/lib/drawings";
import {
  api, type MaAlert, type ManualTradingState, type OptimizerBest, type PineScript,
} from "@/lib/api";
import { currentMaValues, defaultMaLines, type MaType } from "@/lib/movingAverages";
import { defaultParamsFor } from "@/lib/paramSchema";
import * as layoutStore from "@/lib/layouts";
import type { WorkspaceState } from "@/lib/layouts";
import { resolutionMs, type Resolution } from "@/lib/resolution";
import { storedIntervalFor } from "@/lib/timeframes";
import { useResolutionPreferences } from "@/components/tv/TimeframePicker";
import { useSavedLayouts } from "@/lib/useSavedLayouts";
import {
  type Candle, type Interval, type OpenTrade, type Strategy, type StrategyParams,
  type SymbolInfo, type Trade,
} from "@/lib/types";
import { fmtPrice } from "@/lib/format";
import {
  DEFAULT_PRICE_SCALE, resetPriceScale, setPriceScaleMode, togglePercentScale,
  togglePriceScaleAuto, togglePriceScaleInvert, togglePriceScaleMode,
  type PriceScaleState,
} from "@/lib/priceScale";
import { parseScannerChartTarget } from "@/lib/spotScene";
import { sameSymbol } from "@/lib/manualTicket";
import { resolveTradingTarget, tradingTargetNotice, type TradingTarget } from "@/lib/tradingTarget";
import { datasetKey } from "@/lib/liveDataset";
import { useCandleHistory } from "@/lib/useCandleHistory";
import { useLivePrice } from "@/lib/useLivePrice";
import { lastPriceLabel, lastPriceNotice, resolveLastPrice } from "@/lib/lastPrice";
import {
  activePane as focusedPane, applyPaneInterval, applyPaneSymbol, createWorkspace, loadWorkspace,
  paneById, removePane, saveWorkspace, setActivePane, setPaneCompare, setPaneCount, setPaneMaVisibility,
  setPanePriceScale,
  setPreset, setWorkspaceBars, togglePaneMa, toggleMaximize, updatePane,
  type ChartWorkspace as Workspace, type PaneCompare, type PaneState,
} from "@/lib/workspace";
import { MAX_PANES } from "@/lib/layoutPresets";
import { isMacPlatform } from "@/lib/shortcuts";
import { pushDrawings, syncDrawings } from "@/lib/chartStateSync";
import { usePaneCandleOverlays } from "@/lib/useCandleOverlay";
import { usePaneClassicalOverlays } from "@/lib/useClassicalPatterns";
import {
  activeReplayQuote, liveActionsDisabled, reconcileReplay, replayCandles, replayDelayMs,
  replayTick, startReplay, stepReplay,
  type ReplaySession, type ReplaySpeed,
} from "@/lib/replay";
import { useTradingOverlays } from "@/lib/useTradingOverlays";
import {
  manualTradingPollingAllowed, noteManualTradingFailure,
} from "@/lib/manualTradingPolling";

type Panel = ChartPanel;

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
      if (!manualTradingPollingAllowed()) return;
      try {
        const next = await api.manualState(tradingSymbol);
        if (!next.enabled) noteManualTradingFailure("manual trading is disabled");
        if (live) recordManualState(next);
      } catch (e) {
        // Normally the feature is disabled on this install; the strip says
        // so in the Bot's own words rather than showing an empty table.
        const message = (e as Error).message;
        noteManualTradingFailure(message);
        if (live) setManualUnavailable(message);
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

  /*
   * ── Server-held drawings ────────────────────────────────────────────────
   *
   * The store is still the authority for this session — the canvas needs the
   * list synchronously, every frame — and the server is where it goes so a
   * second device sees it. `syncDrawings` decides which side wins on load and
   * never discards local work; see `lib/chartStateSync` for why each rule is
   * there. The version it returns is what the next save is written against.
   */
  const drawingVersion = useRef<Record<string, number>>({});
  /**
   * Symbols whose local list holds an edit the server has not accepted.
   *
   * Set the moment the store announces an edit, cleared only by a push the
   * server acknowledged. `syncDrawings` reads it: without it, a sync preferred
   * a non-empty server unconditionally and wrote the adopted list back through
   * `saveDrawings` — so an edit that missed its push window was destroyed on
   * the next reload, including the local copy.
   */
  const dirtySymbols = useRef<Set<string>>(new Set());

  /**
   * Send one symbol's drawings, now.
   *
   * Separate from the debounce so it can also be called when the debounce must
   * not be waited for — a symbol change, or the page going away.
   */
  const pushNow = useCallback(async (forSymbol: string): Promise<void> => {
    const base = drawingVersion.current[forSymbol] ?? 0;
    const result = await pushDrawings(forSymbol, drawingStore.get(forSymbol), base);
    drawingVersion.current[forSymbol] = result.version;
    // Still dirty if it did not actually land: an offline push has changed
    // nothing on the server, and the next sync must still treat this device's
    // copy as the newer one.
    if (!result.offline) dirtySymbols.current.delete(forSymbol);
    // A conflict means another device wrote first. Its list is now the truth,
    // so adopt it rather than writing over it.
    if (result.conflicted) drawingStore.adopt(forSymbol, result.drawings);
  }, []);

  /**
   * Push an edit up, after the store has already accepted it.
   *
   * Debounced, because a drag emits a change per pointer sample and a request
   * per sample would be a denial of service against the user's own server. The
   * store's own persistence is immediate; this is the slower, remote half.
   *
   * One timer PER SYMBOL. A single shared timer meant editing BTC and then
   * touching ETH within the debounce window cancelled the BTC push outright,
   * and nothing ever rescheduled it.
   */
  const pushTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const schedulePush = useCallback((forSymbol: string) => {
    dirtySymbols.current.add(forSymbol);
    const existing = pushTimers.current.get(forSymbol);
    if (existing) clearTimeout(existing);
    pushTimers.current.set(forSymbol, setTimeout(() => {
      pushTimers.current.delete(forSymbol);
      void pushNow(forSymbol);
    }, 1_200));
  }, [pushNow]);

  /** Send everything outstanding immediately, without waiting for a timer. */
  const flushPushes = useCallback(() => {
    for (const [pending, timer] of pushTimers.current) {
      clearTimeout(timer);
      pushTimers.current.delete(pending);
      void pushNow(pending);
    }
  }, [pushNow]);

  useEffect(() => {
    /*
     * The page going away is the last chance to send.
     *
     * `pagehide` rather than `beforeunload`: it is the one mobile browsers
     * actually fire when an app is backgrounded, which is exactly the case
     * where a pending 1200 ms timer would otherwise never run.
     */
    const onHide = (): void => flushPushes();
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onHide);
      flushPushes();
    };
  }, [flushPushes]);

  // Every user edit, from any surface: a pane's canvas, this page's context
  // menu, the keyboard. One subscription rather than a call at each site.
  useEffect(() => drawingStore.onEdit(schedulePush), [schedulePush]);

  /*
   * ── Server-held drawings ────────────────────────────────────────────────
   *
   * The store is still the authority for this session — the canvas needs the
   * list synchronously, every frame — and the server is where it goes so a
   * second device sees it. `syncDrawings` decides which side wins, and it is
   * told whether this device is holding unsent work; see `lib/chartStateSync`
   * for why each rule is there.
   */
  useEffect(() => {
    let live = true;
    void (async () => {
      const result = await syncDrawings(symbol, {
        localDirty: dirtySymbols.current.has(symbol),
        lastSeenVersion: drawingVersion.current[symbol] ?? 0,
      });
      if (!live) return;
      drawingVersion.current[symbol] = result.version;
      if (result.decision.action === "push" && !result.offline) {
        dirtySymbols.current.delete(symbol);
      }
      // `adopt` is the only outcome that changes what is on screen, and it is
      // adopted rather than recorded as an edit: undoing "the data arrived"
      // is meaningless, and it must not enter this session's undo stack.
      if (result.decision.action === "adopt") drawingStore.adopt(symbol, result.drawings);
    })();
    // Leaving this instrument sends whatever it is still holding, rather than
    // letting the next symbol's edit cancel it.
    return () => { live = false; flushPushes(); };
  }, [symbol, flushPushes]);

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

  /*
   * The same registration for the pane's BUILT-IN studies.
   *
   * A second map rather than one merged surface: a Pine study is compiled and
   * run on the server asynchronously, a built-in is a pure function of the
   * bars on screen, and giving either one the other's lifecycle would be worse
   * than keeping two small registries. The dialogs and the panel show them
   * together; the engines stay apart.
   */
  const nativeApis = useRef(new Map<string, () => NativeStudiesApi>());
  const [nativeVersions, setNativeVersions] = useState<Record<string, number>>({});
  const registerNativeApi = useCallback(
    (paneId: string, get: (() => NativeStudiesApi) | null) => {
      if (get) nativeApis.current.set(paneId, get);
      else {
        nativeApis.current.delete(paneId);
        setNativeVersions((current) => {
          if (!(paneId in current)) return current;
          const next = { ...current };
          delete next[paneId];
          return next;
        });
      }
    }, []);
  /**
   * A pane reports that its built-in list changed.
   *
   * A version counter rather than the list itself: the list is already inside
   * the API object the getter returns, and copying it into page state would
   * give two places to disagree about what is on the chart.
   */
  const registerNativeChanged = useCallback((paneId: string) => {
    setNativeVersions((current) => ({ ...current, [paneId]: (current[paneId] ?? 0) + 1 }));
  }, []);

  const activeNativeStudies = useMemo<NativeStudiesApi | null>(() => {
    const get = nativeApis.current.get(active.id);
    return get ? get() : null;
    // `nativeVersions` is the trigger: the getter's contents change without
    // its identity changing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active.id, nativeVersions]);

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
  /** Which built-in instance's Inputs/Style dialog is open, if any. */
  const [editingNativeKey, setEditingNativeKey] = useState<string | null>(null);

  /**
   * The built-in instance the settings dialog is editing, resolved fresh.
   *
   * By key rather than by object, so retuning it does not leave the dialog
   * bound to the value it had when it opened — and so closing a pane or
   * removing the study closes the dialog rather than editing a ghost.
   */
  const editingNativeStudy = useMemo(
    () => activeNativeStudies?.list.find((s) => s.key === editingNativeKey) ?? null,
    [activeNativeStudies, editingNativeKey]);
  const editingNativeValues = useMemo(
    () => activeNativeStudies?.rows.find((r) => r.study.key === editingNativeKey)?.values,
    [activeNativeStudies, editingNativeKey]);

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

  /**
   * An edit inside a Replay session.
   *
   * Recorded in the store's Replay scope so Cmd+Z works there too — it used to
   * be silently dead, while the shortcuts sheet listed Undo unconditionally.
   * The scope is separate from the instrument's, so an undo here can never
   * reach the chart's persisted drawings, and leaving Replay leaves the
   * history behind rather than merging it.
   */
  const updateReplayDrawings = useCallback((next: Drawing[], gesture: string | null = null) => {
    drawingStore.setReplay(symbol, next, gesture);
    setReplayDrawings(next);
  }, [symbol]);
  const [toast, setToast] = useState<string | null>(null);

  /*
   * The browser's favourite / recent / custom resolutions, read once here.
   *
   * The toolbar's picker and every pane's legend picker are handed the same
   * object, so starring `45m` from a pane puts it on the toolbar strip and vice
   * versa. Two components each keeping their own copy of a `localStorage` list
   * is two products that disagree after the first click.
   */
  const resolutions = useResolutionPreferences();
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
      /*
       * The optimizer's leaderboard is keyed by a STORED interval. A derived
       * chart resolution has no row there, so the request is made without a
       * timeframe filter — the reply then names the timeframe it found, and
       * `applyPaneInterval` moves the chart onto it, which is visible rather
       * than silent.
       */
      const best = await api.optimizerBest(
        symbol, 1, strategyKey, storedIntervalFor(interval) ?? undefined);
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

  /**
   * What one pane compares against.
   *
   * Never synced across panes, unlike symbol and interval: "compare SOL to
   * BTC" is a statement about THIS chart, and pushing it across a synced
   * layout would put the same second instrument on four charts a user was
   * using to look at four different things.
   */
  const changePaneCompare = useCallback((paneId: string, next: PaneCompare | null) => {
    setWorkspace((ws) => setPaneCompare(ws, paneId, next));
  }, []);

  const changePaneSymbol = useCallback((paneId: string, next: string) => {
    pauseReplayForNavigation();
    setWorkspace((ws) => applyPaneSymbol(ws, paneId, next, sync));
    setTrades([]);
  }, [pauseReplayForNavigation, sync]);

  /*
   * A resolution change is also a use: it feeds the picker's Recent list, so
   * `45m` typed once is one click away for the rest of the session however it
   * was reached — the toolbar strip, a pane legend, or the keyboard.
   */
  const changePaneInterval = useCallback((paneId: string, next: Resolution) => {
    resolutions.noteUsed(next);
    pauseReplayForNavigation();
    setWorkspace((ws) => applyPaneInterval(ws, paneId, next, sync));
    setTrades([]);
  }, [pauseReplayForNavigation, sync, resolutions]);

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
      if (!existing.has(pane.id)) {
        copyStoredForScope(workspace.activePaneId, pane.id);
        copyStoredNativeForScope(workspace.activePaneId, pane.id);
      }
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
      if (next !== ws) { clearStored(paneId); clearStoredNative(paneId); }
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
    // A new session starts with an empty, un-undoable Replay history: undoing
    // "the session began" is meaningless, and the previous session's steps
    // must not be reachable from this one.
    drawingStore.resetReplay(symbol, []);
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
    // `symbol` because the Replay history is scoped to it: a session begun on
    // one instrument must not seed another's scope.
  }, [candles, symbol]);

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
  const patternPaneIds = useMemo(() => workspace.panes.map((pane) => pane.id), [workspace.panes]);
  /** Each chart owns an independent study instance; detector truth remains shared. */
  const candleOverlays = usePaneCandleOverlays(patternPaneIds);
  const classicalOverlays = usePaneClassicalOverlays(patternPaneIds);

  const alertLinesFor = useCallback((paneInterval: Resolution): ChartPriceLine[] =>
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

  /* ────────────────────────────────────────────────────────────────────────
   * Right-click, and the keyboard
   *
   * Both are workspace-level for the same reason: what a menu may offer and
   * what a key may do are decisions about the WORKSPACE — whether Replay is
   * running, which pane is focused, whether a drawing is selected — and a
   * component that owns only part of that would have to guess at the rest.
   *
   * The menu payloads are pure (`lib/menuPayloads`) and the key table is pure
   * (`lib/shortcuts`); this is the wiring between them and the state they act
   * on, and nothing else.
   * ──────────────────────────────────────────────────────────────────────── */

  /** The open context menu: where it is, what it is about, and its items. */
  const [menu, setMenu] = useState<
    | null
    | { at: { x: number; y: number }; label: string; entries: MenuEntry[];
        kind: "chart" | "drawing" | "axis"; paneId: string; price: number | null;
        drawingId: string | null }
  >(null);
  /**
   * Each pane's price scale, and a counter that asks a pane to refit.
   *
   * Owned here rather than inside `CandleChart` because the chart's context
   * menu has to both REPORT the scale ("Auto ✓", "Log ✗") and change it. While
   * the chart kept the state privately the menu was built from literals — it
   * always claimed Auto on and Log off, whatever the axis was doing, and its
   * three scale items reached no handler at all.
   */
  /*
   * The price scale lives in the WORKSPACE now, not beside it.
   *
   * It used to be a `Record<paneId, PriceScaleState>` in component state, so a
   * chart deliberately put on a logarithmic axis came back linear on the next
   * reload, and a saved layout — which is supposed to be "the way I look at
   * this" — did not carry the way its axis was read. Moving it into the pane
   * gives it the workspace's own persistence, its saved layouts and its
   * validation, and costs nothing else: it is still per pane and still never
   * synced across panes.
   */
  /**
   * Bumped per pane to ask its chart to refit. See `CandleChart.resetSignal`.
   */
  const [paneResets, setPaneResets] = useState<Record<string, number>>({});
  /** Bumped per pane to move focus into the selected drawing's style bar. */
  const [paneStyleFocus, setPaneStyleFocus] = useState<Record<string, number>>({});
  const paneScale = useCallback((paneId: string): PriceScaleState =>
    workspace.panes.find((p) => p.id === paneId)?.priceScale ?? DEFAULT_PRICE_SCALE,
  [workspace]);
  const setPaneScale = useCallback((paneId: string, next: PriceScaleState) => {
    setWorkspace((ws) => setPanePriceScale(ws, paneId, next));
  }, []);

  /**
   * Copy a price the way the chart shows it, and say when the copy failed.
   *
   * `String(price)` produced `43021.500000001` — a float's decimal expansion,
   * not a price — and the clipboard promise's rejection was discarded, so on a
   * non-secure origin or with the permission denied the menu closed and
   * nothing was on the clipboard, with nothing said about it.
   */
  const copyPrice = useCallback((price: number) => {
    const text = fmtPrice(price);
    const write = navigator.clipboard?.writeText(text);
    if (!write) {
      setToast("This browser will not let the page use the clipboard");
      return;
    }
    write.then(() => setToast(`Copied ${text}`))
      .catch(() => setToast("The clipboard is not available here"));
  }, []);

  /** Which drawing each pane has selected, so the keyboard can act on it. */
  const [selectedDrawings, setSelectedDrawings] = useState<Record<string, string | null>>({});
  /** One clipboard for the workspace, so a copy can be pasted onto any chart. */
  const clipboard = useRef<Drawing | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  const selectedDrawingId = selectedDrawings[workspace.activePaneId] ?? null;
  const currentDrawings = replayActive ? replayDrawings : activeDrawings;
  const selectedDrawing = selectedDrawingId
    ? currentDrawings.find((d) => d.id === selectedDrawingId) ?? null
    : null;

  const noteDrawingSelection = useCallback((paneId: string, id: string | null) => {
    setSelectedDrawings((current) => (current[paneId] === id
      ? current : { ...current, [paneId]: id }));
  }, []);

  /** Replace the focused instrument's drawings, through the right authority. */
  const writeDrawings = useCallback((next: Drawing[], gesture: string | null = null) => {
    if (replayActive) {
      // Replay drawings are session state and are never persisted anywhere,
      // locally or remotely — that is what makes a Replay a scratch pad.
      updateReplayDrawings(next, gesture);
      return;
    }
    drawingStore.set(symbol, next, gesture);
  }, [replayActive, updateReplayDrawings, symbol]);

  const openChartMenu = useCallback((
    paneId: string,
    event: {
      x: number; y: number; drawingId: string | null; price: number | null;
      /** Which strip was clicked: the plot, or the price axis. */
      region: "plot" | "axis";
    }
  ) => {
    activatePane(paneId);
    const pane = paneById(workspace, paneId);
    const paneSymbol = pane?.symbol ?? symbol;
    const drawings = replayActive ? replayDrawings : drawingStore.get(paneSymbol);
    if (event.region === "axis") {
      // The price axis's own short menu. It used to show Chrome's instead:
      // the canvas returned before `preventDefault` for anything outside the
      // plot, so the browser menu opened over the chart.
      setMenu({
        at: { x: event.x, y: event.y },
        label: "Price scale",
        kind: "axis",
        paneId,
        price: null,
        drawingId: null,
        entries: priceAxisMenu({
          autoScale: paneScale(paneId).autoScale,
          logScale: paneScale(paneId).mode === "logarithmic",
          percentScale: paneScale(paneId).mode === "percentage",
          indexedScale: paneScale(paneId).mode === "indexedTo100",
          inverted: paneScale(paneId).invert === true,
        }),
      });
      return;
    }
    if (event.drawingId) {
      const drawing = drawings.find((d) => d.id === event.drawingId) ?? null;
      setMenu({
        at: { x: event.x, y: event.y },
        label: "Drawing",
        kind: "drawing",
        paneId,
        price: event.price,
        drawingId: event.drawingId,
        entries: drawingMenu({
          locked: drawing?.locked === true,
          hidden: drawing?.hidden === true,
          mac: isMacPlatform(),
          // Only a single-anchor horizontal level is a price an alert can watch.
          alertable: drawing?.tool === "hline" || drawing?.tool === "hray",
          // THIS drawing's state, not the workspace's — the menu used to
          // report the global "hide drawings" flag as the drawing's own.
          replayActive,
          // Order is the array order, which every drawing shares — but a
          // drawing already alone in the list has nothing to move past.
          canReorder: drawings.length > 1,
        }),
      });
      return;
    }
    setMenu({
      at: { x: event.x, y: event.y },
      label: `${paneSymbol} chart`,
      kind: "chart",
      paneId,
      price: event.price,
      drawingId: null,
      entries: chartMenu({
        price: event.price,
        priceLabel: event.price === null ? "" : fmtPrice(event.price),
        replayActive,
      // The pane's real persisted axis, not a literal.
        autoScale: paneScale(paneId).autoScale,
        logScale: paneScale(paneId).mode === "logarithmic",
        hasDrawings: drawings.length > 0,
        drawingsHidden: drawHidden,
        drawingsLocked: drawLocked,
        // Offering "prepare an order" where manual trading is switched off
        // stages a ticket the installation will not accept.
        tradingEnabled: manualState?.enabled === true,
        candlePatterns: candleOverlays[paneId]?.enabled === true,
        classicalPatterns: classicalOverlays[paneId]?.enabled === true,
      }),
    });
  }, [activatePane, workspace, symbol, replayActive, replayDrawings, drawHidden, drawLocked,
    paneScale, manualState, candleOverlays, classicalOverlays]);

  /*
   * One handler per menu, keyed by the menu's own namespace.
   *
   * The ids used to be bare, and `add-alert` belonged to two menus. The shared
   * switch ran first and returned unconditionally, so a drawing's "Add alert on
   * this level" armed at the POINTER's price and the branch that read the
   * drawing's own level was unreachable. Prefixed ids make that impossible to
   * write; every id a payload can emit is answered below, and
   * `tests/powerUx.test.ts` fails if one is not.
   */
  const onMenuSelect = useCallback((id: string) => {
    if (!menu) return;
    const price = menu.price;
    const paneId = menu.paneId;
    const scale = paneScale(paneId);
    switch (id) {
      case "chart:copy-price":
        if (price !== null) copyPrice(price);
        return;
      case "chart:add-alert":
        if (price !== null) pickLevel(price);
        return;
      case "chart:trade-at-price":
        // PREPARES a ticket. It does not submit, and no context-menu item in
        // this product ever will — that is the alert/automation boundary.
        setPanel("manual");
        return;
      case "chart:indicators": setIndicatorBrowserOpen(true); return;
      case "chart:chart-settings": setSettingsOpen(true); return;
      case "chart:toggle-drawings-hidden": setDrawHidden((v) => !v); return;
      case "chart:toggle-drawings-locked": setDrawLocked((v) => !v); return;
      case "chart:toggle-candle-patterns":
        candleOverlays[paneId]?.setEnabled(!candleOverlays[paneId]?.enabled);
        return;
      case "chart:toggle-classical-patterns":
        classicalOverlays[paneId]?.setEnabled(!classicalOverlays[paneId]?.enabled);
        return;
      case "chart:reset-view":
      case "axis:reset":
        setPaneScale(paneId, resetPriceScale());
        setPaneResets((current) => ({ ...current, [paneId]: (current[paneId] ?? 0) + 1 }));
        return;
      case "chart:toggle-auto":
      case "axis:toggle-auto":
        setPaneScale(paneId, togglePriceScaleAuto(scale));
        return;
      case "chart:toggle-log":
      case "axis:toggle-log":
        setPaneScale(paneId, togglePriceScaleMode(scale));
        return;
      case "axis:toggle-percent":
        setPaneScale(paneId, togglePercentScale(scale));
        return;
      case "axis:toggle-indexed":
        setPaneScale(paneId, setPriceScaleMode(
          scale, scale.mode === "indexedTo100" ? "normal" : "indexedTo100"));
        return;
      case "axis:toggle-invert":
        setPaneScale(paneId, togglePriceScaleInvert(scale));
        return;
      default: break;
    }
    if (menu.kind !== "drawing" || !menu.drawingId) return;
    const drawings = currentDrawings;
    const target = drawings.find((d) => d.id === menu.drawingId);
    if (!target) return;
    switch (id) {
      case "drawing:settings":
        // The style bar is already beside the drawing — right-clicking it
        // selects it. What this adds is a way IN from the keyboard, which the
        // bar had no other route to.
        setPaneStyleFocus((current) => ({ ...current, [paneId]: (current[paneId] ?? 0) + 1 }));
        return;
      case "drawing:clone": {
        const copy = cloneDrawing(target, newId, resolutionMs(interval) / 1000);
        writeDrawings([...drawings, copy], "clone");
        return;
      }
      case "drawing:copy": clipboard.current = target; return;
      case "drawing:toggle-lock":
        writeDrawings(drawings.map((d) =>
          (d.id === target.id ? { ...d, locked: !d.locked } : d)), "lock");
        return;
      case "drawing:toggle-hidden":
        // Per-drawing, unlike the chart menu's workspace-wide "Hide drawings".
        writeDrawings(drawings.map((d) =>
          (d.id === target.id ? { ...d, hidden: !d.hidden } : d)), "hide");
        return;
      case "drawing:remove":
        writeDrawings(drawings.filter((d) => d.id !== target.id), "remove");
        return;
      case "drawing:bring-front":
        writeDrawings([...drawings.filter((d) => d.id !== target.id), target], "reorder");
        return;
      case "drawing:send-back":
        writeDrawings([target, ...drawings.filter((d) => d.id !== target.id)], "reorder");
        return;
      case "drawing:add-alert": {
        // The DRAWING's level, never the pointer's price. That distinction is
        // the whole reason these ids are namespaced.
        const level = target.points[0]?.price;
        if (level !== undefined) pickLevel(level);
        return;
      }
      default: return;
    }
  }, [menu, currentDrawings, interval, writeDrawings, pickLevel, paneScale, setPaneScale,
    copyPrice, candleOverlays, classicalOverlays]);

  const shortcuts = useShortcuts({
    onAction: (action) => {
      switch (action) {
        case "undo": {
          if (replayActive) {
            const restored = drawingStore.undoReplay(symbol);
            if (restored) setReplayDrawings(restored);
            return restored !== null;
          }
          return drawingStore.undo(symbol) !== null;
        }
        case "redo": {
          if (replayActive) {
            const restored = drawingStore.redoReplay(symbol);
            if (restored) setReplayDrawings(restored);
            return restored !== null;
          }
          return drawingStore.redo(symbol) !== null;
        }
        case "clone": {
          if (!selectedDrawing) return false;
          writeDrawings([
            ...currentDrawings,
            cloneDrawing(selectedDrawing, newId, resolutionMs(interval) / 1000),
          ]);
          return true;
        }
        case "copy":
          if (!selectedDrawing) return false;
          clipboard.current = selectedDrawing;
          return true;
        case "paste": {
          const held = clipboard.current;
          if (!held) return false;
          writeDrawings([
            ...currentDrawings,
            cloneDrawing(held, newId, resolutionMs(interval) / 1000),
          ]);
          return true;
        }
        case "delete": {
          // The canvas already deletes its own selection on Delete; returning
          // false leaves that path alone rather than deleting twice.
          return false;
        }
        case "tool:cursor": setTool("cursor"); return true;
        case "tool:trend": setTool("trend"); return true;
        case "tool:horizontal": setTool("hline"); return true;
        case "tool:vertical": setTool("vline"); return true;
        case "tool:fib": setTool("fib"); return true;
        case "tool:text": setTool("text"); return true;
        case "magnet": setMagnet((v) => !v); return true;
        case "lock-drawings": setDrawLocked((v) => !v); return true;
        case "hide-drawings": setDrawHidden((v) => !v); return true;
        case "symbol-search": setSearchPaneId(workspace.activePaneId); return true;
        case "indicators": setIndicatorBrowserOpen(true); return true;
        case "chart-settings": setSettingsOpen(true); return true;
        case "shortcuts-sheet": setShortcutsOpen(true); return true;
        case "fullscreen":
          if (!fullscreen.supported) return false;
          fullscreen.toggle();
          return true;
        case "replay-step-back":
          setReplay((current) => (current ? stepReplay(current, candles, -1) : null));
          return true;
        case "replay-step-forward":
          setReplay((current) => (current ? stepReplay(current, candles, 1) : null));
          return true;
        case "replay-play-pause":
          setReplayPlaying(!(replay?.playing ?? false));
          return true;
        default:
          return false;
      }
    },
    onInterval: (next) => changePaneInterval(workspace.activePaneId, next),
  }, { replayActive, enabled: !replayPickerOpen });

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
        resolutions={resolutions}
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
        onNativeStudiesApi={registerNativeApi}
        onNativeStudiesChanged={registerNativeChanged}
        onDrawingSelection={noteDrawingSelection}
        onChartContextMenu={openChartMenu}
        priceScale={paneScale(pane.id)}
        onPriceScaleChange={setPaneScale}
        resetSignal={paneResets[pane.id] ?? 0}
        drawingStyleFocusSignal={paneStyleFocus[pane.id] ?? 0}
        onCompareChange={changePaneCompare}
        // The pane fetches its OWN fired events, scoped to its instrument and
        // timeframe, and places them against its own bars. It needs only the
        // armed alerts from here, to attribute an event to one.
        maAlerts={maAlerts}
        candleOverlay={candleOverlays[pane.id]}
        classicalOverlay={classicalOverlays[pane.id]}
        onIndicatorList={registerIndicatorList}
        onFocusIndicator={focusIndicator}
        compact={isMobile}
      />
    );
  }, [paneDecorations, workspace.activePaneId, paneCount, activatePane, changePaneInterval,
    toggleMaximizePane, closePane, replay, replayDrawings, updateReplayDrawings, cross, range,
    sync, publishCrosshair, publishRange, tool, clearDrawingTool, magnet, drawLocked,
    drawHidden, pickingLevel, pickLevel, pineStartTime, pineEndTime, registerIndicatorsApi,
    registerNativeApi, registerNativeChanged, noteDrawingSelection, openChartMenu,
    registerIndicatorList, focusIndicator, isMobile, overlays.select, overlays.setViewport,
    paneScale, setPaneScale, paneResets, paneStyleFocus, changePaneCompare,
    maAlerts, candleOverlays, classicalOverlays, resolutions]);

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
          resolutions={resolutions}
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
        bars={bars}
        onSelectSymbol={(s) => changePaneSymbol(active.id, s)}
        canOpenNewPane={paneCount < MAX_PANES}
        onOpenSymbolInNewPane={(s) => {
          // Grow the workspace by one pane and put the symbol on the new one,
          // which is what "open in a new pane" means with a preset layout.
          setWorkspace((ws) => {
            const grown = setPaneCount(ws, ws.panes.length + 1);
            const added = grown.panes[grown.panes.length - 1];
            return added
              ? setActivePane(applyPaneSymbol(grown, added.id, s, sync), added.id)
              : grown;
          });
        }}
        onAddSymbolAlert={(s) => {
          changePaneSymbol(active.id, s);
          setPriceAlertOpen(true);
        }}
        onSymbolsChanged={refreshSymbols}
        replayQuote={activeReplayQuote(candles, replay)}
        onOpenAutomation={() => setAlertOpen(true)}
        indicators={activeIndicators}
        nativeStudies={activeNativeStudies}
        onEditNative={setEditingNativeKey}
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

      {/*
        Inputs and Style for one built-in study.
        Rendered here rather than inside the panel so the gear on a pane can
        open it without the Studies panel having to be open first.
      */}
      <ShortcutsSheet open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />

      {/*
        What has been typed toward a timeframe.
        Shown because a buffer the user cannot see is a buffer they cannot
        correct: typing `1`, `5` and seeing nothing is indistinguishable from
        the keystrokes having been swallowed.
      */}
      {shortcuts.intervalBuffer.length > 0 && (
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none fixed bottom-16 left-1/2 z-[80] -translate-x-1/2 rounded-md border border-border bg-surface px-4 py-2 font-mono text-lg text-ink shadow-xl"
        >
          {shortcuts.intervalBuffer}
          <span className="ml-2 text-xs text-ink-faint">Enter to apply</span>
        </div>
      )}

      <ContextMenu
        at={menu?.at ?? null}
        label={menu?.label ?? "Chart"}
        entries={menu?.entries ?? []}
        onSelect={onMenuSelect}
        onClose={() => setMenu(null)}
      />

      <NativeStudySettings
        study={editingNativeStudy}
        values={editingNativeValues}
        onClose={() => setEditingNativeKey(null)}
        onParam={(key, param, value) => activeNativeStudies?.setParam(key, param, value)}
        onStyle={(key, plotId, style) => activeNativeStudies?.setStyle(key, plotId, style)}
        onReset={(key) => activeNativeStudies?.resetParams(key)}
        sourceOptions={(key) => activeNativeStudies?.sourceOptions(key) ?? []}
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
        nativeStudies={activeNativeStudies}
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
