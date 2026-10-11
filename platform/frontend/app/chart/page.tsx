"use client";
import { applyTemplateTo } from "@/lib/indicatorTemplates";
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
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { captureLayoutWorkspace, restoreLayoutWorkspace } from "@/lib/layoutWorkspace";
import { describeAction, type FailureCopy } from "@/lib/errorCopy";
import { useAsk } from "@/components/AskDialog";
import { type ChartMarker, type ChartPriceLine } from "@/components/CandleChart";
import { ChartPane } from "@/components/tv/ChartPane";
import { ChartToolbar } from "@/components/tv/ChartToolbar";
import { ProductMenu } from "@/components/tv/ProductMenu";
import { ChartWorkspace } from "@/components/tv/ChartWorkspace";
import { ChartBottomPanel } from "@/components/tv/ChartBottomPanel";
import { ChartSidePanel, type ChartPanel } from "@/components/tv/ChartSidePanel";
import { recall, remember } from "@/lib/browserStorage";
import { ChartDialogs } from "@/components/tv/ChartDialogs";
import { GoToDateModal } from "@/components/tv/GoToDateModal";
import { CommandPalette } from "@/components/tv/CommandPalette";
import {
  compositePane, copyCanvasToClipboard, downloadCanvas, snapshotFilename,
} from "@/lib/chartSnapshot";
import { NativeStudySettings, PineStudySettings } from "@/components/tv/NativeStudySettings";
import { ChartSettingsModal, type ChartSettingsTab } from "@/components/tv/ChartSettingsModal";
import { DrawingSettingsModal } from "@/components/tv/DrawingSettingsModal";
import { DEFAULT_PROPERTIES, type StrategyProperties } from "@/components/tv/StrategySettingsModal";
import type { IndicatorKind } from "@/components/tv/IndicatorAlertModal";
import type { IndicatorAlertSeed } from "@/lib/studyAlertSeed";
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
  crosshairForPane, DEFAULT_SYNC, followEdgeForPane, loadSync,
  rangeSyncActive, saveSync, visibleRangeForPane,
  type CrosshairSignal, type RangeSignal, type SyncOptions,
} from "@/lib/paneSync";
import { loadChartType, saveChartType, type ChartType } from "@/lib/chartType";
import { DrawingToolbar, type MagnetMode } from "@/components/tv/DrawingToolbar";
import { ReplayControls } from "@/components/tv/ReplayControls";
import { TradingOverlayDetails } from "@/components/tv/TradingOverlays";
import { drawingStore } from "@/lib/drawingStore";
import { cloneDrawing } from "@/lib/drawingHistory";
import { ContextMenu } from "@/components/tv/ContextMenu";
import type { MenuEntry } from "@/lib/contextMenu";
import {
  CHART_ADD_TO_LIST_PREFIX, DRAWING_TEMPLATE_APPLY_PREFIX, SERIES_ADD_TO_LIST_PREFIX, chartMenu, drawingMenu,
  drawingToolName, priceAxisMenu,
  seriesLegendMenu, TIME_ZONE_MENU_PREFIX, timeAxisMenu,
  LEGEND_MENU_SETTING, legendDisplayMenu, type LegendMenuSettingKey,
} from "@/lib/menuPayloads";
import { CHART_TIME_ZONES } from "@/lib/chartClock";
import { useShortcuts } from "@/lib/useShortcuts";
import { ChromeTooltip } from "@/components/ui";
import { ShortcutsSheet } from "@/components/tv/ShortcutsSheet";
import { useFullscreen } from "@/lib/fullscreen";
import {
  applyDrawingTemplate, defaultDrawingTemplate, intervalVisibilityOf, loadDrawingTemplates, newId,
  templatesForTool, visibleOnFor, type Drawing, type DrawingTool, type IntervalVisibility,
} from "@/lib/drawings";
import { saveDrawingTemplateAs } from "@/components/tv/DrawingTemplateMenu";
import {
  api, type MaAlert, type ManualTradingState, type OptimizerBest, type PineScript,
} from "@/lib/api";
import {
  currentMaValues, defaultMaLines, MA_INSTANCE_ID, MA_INSTANCE_TITLE, type MaType,
} from "@/lib/movingAverages";
import { defaultParamsFor } from "@/lib/paramSchema";
import * as layoutStore from "@/lib/layouts";
import type { WorkspaceState } from "@/lib/layouts";
import { resolutionMs, type Resolution } from "@/lib/resolution";
import { fmtChartBarTime } from "@/lib/chartClock";
import { storedIntervalFor } from "@/lib/timeframes";
import { useResolutionPreferences } from "@/components/tv/TimeframePicker";
import { useSavedLayouts } from "@/lib/useSavedLayouts";
import {
  type Candle, type Interval, type OpenTrade, type Strategy, type StrategyParams,
  type SymbolInfo, type Trade,
} from "@/lib/types";
import { fmtPrice } from "@/lib/format";
import type { ChartOverlay } from "@/lib/chartSeries";
import { dataWindowSeriesRows, dataWindowStudies } from "@/lib/dataWindow";
import {
  DEFAULT_PRICE_SCALE, resetPriceScale, setPriceScaleMode,
  togglePriceScaleAuto, togglePriceScaleInvert, togglePriceScaleMode,
  type PriceScaleState,
} from "@/lib/priceScale";
import { parseScannerChartTarget } from "@/lib/spotScene";
import { sameSymbol } from "@/lib/manualTicket";
import { resolveTradingTarget, tradingTargetNotice, type TradingTarget } from "@/lib/tradingTarget";
import { datasetKey } from "@/lib/liveDataset";
import { useCandleHistory } from "@/lib/useCandleHistory";
import { useLivePrice } from "@/lib/useLivePrice";
import { lastPriceNotice, resolveLastPrice } from "@/lib/lastPrice";
import { displayTicker, isCanonicalInstrumentId, legacyBinanceSpotTicker } from "@/lib/instrument";
import { useBookQuote } from "@/lib/useBookQuote";
import { alertCapability } from "@/lib/workstation";
import type { ChartSettings } from "@/lib/chartSettings";
import {
  DEFAULT_COMPARE_LENGTH,
  activePane as focusedPane, applyPaneInterval, applyPaneSymbol, createWorkspace, loadWorkspace,
  paneById, removePane, saveWorkspace, setActivePane, setPaneCompare, setPaneCount, setPaneMaVisibility,
  setPanePriceScale, paneChartSettings, setPaneChartSettings, setPaneStudyLayout, setPaneViewport,
  setPreset, setWorkspaceBars, togglePaneMa, togglePaneMaSet, removePaneMaSet, toggleMaximize, updatePane,
  type ChartWorkspace as Workspace, type PaneCompare, type PaneState, type PaneViewport,
} from "@/lib/workspace";
import type { SavedPaneLayout } from "@/lib/indicatorPaneLayout";
import { MAX_PANES } from "@/lib/layoutPresets";
import { isMacPlatform, type ShortcutAction } from "@/lib/shortcuts";
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

/**
 * ── FG-01: which side panel the workstation opens with ────────────────────
 *
 * Stored as three states, not two, because "closed" and "not yet said" are
 * different facts. A user who shuts the watchlist has expressed a preference
 * and must get the bare rail back on every reload; a user who has never
 * touched it has not, and gets the reference's own opening shape.
 */
const PANEL_KEY = "tv.sidePanel.v1";
/** The sentinel for a panel the user closed deliberately. */
const PANEL_CLOSED = "none";
const PANELS: readonly Exclude<ChartPanel, null>[] =
  ["watchlist", "alerts", "objects", "indicators", "ma", "manual", "correlation"];

/**
 * What TradingView opens with, and therefore what this opens with before the
 * user has said otherwise: the instrument list, docked beside the chart.
 */
const DEFAULT_PANEL: ChartPanel = "watchlist";

function openingPanel(): ChartPanel {
  const stored = recall(PANEL_KEY);
  if (stored === PANEL_CLOSED) return null;
  const known = PANELS.find((p) => p === stored);
  return known ?? DEFAULT_PANEL;
}

function rememberPanel(panel: ChartPanel): void {
  remember(PANEL_KEY, panel ?? PANEL_CLOSED);
}

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
  const ask = useAsk();
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

  /*
   * B-08: each pane's last window, kept BESIDE the workspace state.
   *
   * It is written whenever the reader stops panning, and putting it in
   * `workspace` re-rendered every pane each time — which re-ran every study
   * pane's data pass in the middle of a drag. It is merged in only on the way
   * to storage; a restored pane reads its window from the loaded record.
   */
  const paneViewports = useRef<Record<string, PaneViewport>>({});
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const workspaceReadyRef = useRef(false);
  const persistWorkspace = useCallback((ws: Workspace) => {
    saveWorkspace(Object.entries(paneViewports.current).reduce(
      (next, [paneId, viewport]) => setPaneViewport(next, paneId, viewport), ws));
  }, []);
  useEffect(() => {
    const loaded = loadWorkspace({
      symbol: DEFAULT_SYMBOL, interval: DEFAULT_INTERVAL, chartType: loadChartType(),
    });
    paneViewports.current = Object.fromEntries(loaded.panes.flatMap((p) =>
      p.viewport ? [[p.id, p.viewport] as const] : []));
    setWorkspace(loaded);
    setWorkspaceReady(true);
    workspaceReadyRef.current = true;
  }, []);
  useEffect(() => {
    // Persisted only after the restore has landed, or the initial default
    // would be written straight over the stored workspace.
    if (workspaceReady) persistWorkspace(workspace);
  }, [workspace, workspaceReady, persistWorkspace]);

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
  const activeHistory = useCandleHistory({ symbol, interval, bars },
    // IO-A2: loaded, not streamed, while a replay is running — the same rule
    // `useLivePrice` below has always followed. Replay outranks live absolutely.
    { live: !replayActive });
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
    /*
     * B-18: a canonical instrument's live price arrives on the history hook's
     * provider candle stream, not through `useLivePrice` (which is the legacy
     * Binance feed and declines canonical ids). Without this, the alert dialog
     * said "No live frame yet" under a Last price that was ticking every
     * second. Only while that stream is actually delivering frames.
     */
    liveClose: livePrice.price
      ?? (activeHistory.streamLive && holdingRequested ? candles[candles.length - 1]?.close ?? null : null),
    historyClose: holdingRequested ? candles[candles.length - 1]?.close ?? null : null,
    historyStale: holdingRequested && activeHistory.stale,
  }), [replayActive, replayLast, livePrice.price, candles, holdingRequested, activeHistory.stale,
    activeHistory.streamLive]);
  /*
   * C8: Replay runs Pine from the same start as the live chart, so a study
   * replayed is the study traded — warmed up over the same history — rather
   * than one that starts cold at the first replayed bar and ramps. Only the
   * END guards against lookahead, and it stays the replay horizon. A replay
   * window that begins before that start keeps its own first bar.
   */
  const pineStart = `${BACKTEST_START}T00:00:00.000Z`;
  const pineStartTime = replayActive && replayFirst && replayFirst.openTime < Date.parse(pineStart)
    ? new Date(replayFirst.openTime).toISOString()
    : pineStart;
  const pineEndTime = replay
    ? new Date(replay.horizonCloseTime).toISOString()
    : endOfTodayISO();

  /*
   * Keep the replay horizon meaningful when the underlying window changes.
   * Guarded on the array identity rather than on `replay`, because
   * `reconcileReplay` returns a fresh session object and an effect keyed on
   * the session would reconcile itself forever.
   *
   * ── IO-A2: the array changes for two different reasons ────────────────────
   *
   * A new array means the user navigated — or it means the window they are
   * already in was refreshed, which a feed returning from stale, a depth
   * repair and a canonical instrument's live merge all do. This effect could
   * not tell those apart and `reconcileReplay` took the navigation answer for
   * both, so a session the user had just started playing stopped itself.
   *
   * The dataset is what knows: same symbol and same resolution is a refresh.
   */
  const reconciledFrom = useRef<Candle[] | null>(null);
  const reconciledDataset = useRef<string | null>(null);
  useEffect(() => {
    if (reconciledFrom.current === candles) return;
    reconciledFrom.current = candles;
    const dataset = datasetKey(activeHistory.dataset);
    const sameWindow = reconciledDataset.current === dataset;
    reconciledDataset.current = dataset;
    setReplay((current) => (
      current ? reconcileReplay(current, candles, { sameWindow }) : null));
  }, [candles, activeHistory.dataset]);

  /*
   * REV-UX-01: a FailureCopy, so the band cannot be a place a raw cause lands.
   * The render used to sanitise this string with a regular expression, which
   * is a filter over copy that should never have been unsafe in the first
   * place — and which mangled the one message that was already a sentence.
   */
  const [err, setErr] = useState<FailureCopy | null>(null);

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

  /*
   * ── FG-01: the right side of the screen was empty ─────────────────────────
   *
   * The comment that used to be here said "TradingView opens on a narrow icon
   * rail; a panel is selected on demand", and that the closed default
   * "preserves the user's last explicit choice". Both halves were wrong.
   *
   * Measured live at 1440×900, signed in: TradingView gives its right side 346
   * pixels — a 302px watchlist panel plus a 45px icon rail — and 1034 to the
   * chart. Trading Scene gave the right side 52px of bare icon rail and 1336 to
   * the chart, a slab 29% wider than the reference with nothing beside it.
   * That is the single loudest thing about a first glance at this product, and
   * `ChartSidePanel` has had a 300px watchlist ready to open the whole time.
   *
   * And nothing was preserved: `useState(null)` remembers nothing between
   * loads, so a user who opened the watchlist got the bare rail back on every
   * reload. The choice is stored now — INCLUDING the choice to close it, which
   * is why the stored value distinguishes "closed on purpose" from "never
   * said". A default is what you get before you have an opinion; it must not
   * overrule one you have expressed.
   */
  /*
   * Starts from what the SERVER rendered — the default — and takes the stored
   * choice in a layout effect, before the first client paint.
   *
   * `useState(openingPanel)` read storage during the first render: the server
   * (no storage) drew the watchlist open, a client whose user had closed it
   * drew the bare rail, and React threw the whole tree away as a hydration
   * mismatch and rebuilt it client-side on every load.
   */
  const [panel, setPanel] = useState<Panel>(DEFAULT_PANEL);
  /** The stored choice has been applied; until then nothing may overwrite it. */
  const [panelRestored, setPanelRestored] = useState(false);
  useLayoutEffect(() => { setPanel(openingPanel()); setPanelRestored(true); }, []);

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
    /*
     * The Bot addresses Binance Spot by its provider ticker, so a canonical
     * `instrument:v1:…` id has to be reduced before it is asked about — which
     * is what `ChartSidePanel` already does for the right-rail panel
     * (`${base}${quote}`). This effect instead blanked on ANY canonical id,
     * and a canonical id is what the symbol search writes, so in ordinary use
     * the bottom workstation's Positions & Orders tab held `manualState` at
     * null with no `unavailable` string — and `TradingStateStrip` reads that
     * pair as "unread", printing "Reading positions and orders from the
     * execution bot…" for ever, over a read that was never going to happen.
     *
     * `legacyBinanceSpotTicker` is the same reduction, and it answers null for
     * anything that is not Binance Spot — the case the Bot genuinely cannot be
     * asked about. Each branch now says which one it is, because a state this
     * panel will never read is not a state it is still reading.
     */
    const manualTicker = replayActive ? null : legacyBinanceSpotTicker(tradingSymbol);
    if (manualTicker === null) {
      setManualState(null); setManualReadAt(null);
      setManualUnavailable(replayActive
        ? "Positions and orders are not read during Bar Replay. Exit Replay to see live state."
        : `Positions and orders are read from the Binance Spot execution bot, which cannot be asked about ${displayTicker(tradingSymbol)}.`);
      return;
    }
    let live = true;
    const refreshManual = async () => {
      if (!manualTradingPollingAllowed()) return;
      try {
        const next = await api.manualState(manualTicker);
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
    // R6 T-2: the only positions in this product that prove a P&L.
    manualPositions: manualState?.positions ?? [],
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

  // Below the desktop breakpoint the persisted desktop panel preference must
  // not reclaim the chart. The Watchlist bottom tab can reopen it as a sheet.
  useEffect(() => {
    if (isMobile) setPanel(null);
  }, [isMobile]);

  /* FG-01: desktop panel preference survives reloads; phone sheets are transient. */
  useEffect(() => {
    // Not before the stored choice is on screen: the default the first render
    // carries is not a choice, and writing it would erase the one that is.
    if (panelRestored && !isMobile) rememberPanel(panel);
  }, [isMobile, panel, panelRestored]);
  /** FG-04: bumped to toggle the bottom workstation from the keyboard. */
  const [bottomToggle, setBottomToggle] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [chartSettingsOpen, setChartSettingsOpen] = useState(false);
  // W2A-11: the tab it opens on, for a caller that names one; cleared on close.
  const [chartSettingsTab, setChartSettingsTab] = useState<ChartSettingsTab | undefined>(undefined);
  /*
   * R6 SC-4: whether the Scales tab may offer a `Bid and ask` row.
   *
   * The rule the dialog states about itself is that a control which moves
   * nothing must not exist, so the row appears only for a feed that has
   * actually answered with a quote. Subscribed only while the dialog is open:
   * asking the question costs a socket, and nobody is asking it the rest of
   * the time. `lib/marketStream`'s registry shares the connection with the
   * ticket and with any pane already drawing the levels.
   */
  const settingsQuote = useBookQuote(
    chartSettingsOpen && !isCanonicalInstrumentId(symbol) ? symbol : "");
  /*
   * TVP8: "Go to…" on the time axis.
   *
   * `goTo` is a counter alongside the time, so asking for the same date twice
   * still scrolls back to it — the pane compares the counter, not the moment.
   */
  const [goToOpen, setGoToOpen] = useState(false);
  /*
   * TVP8: the command palette. The reference has one behind the magnifier
   * beside the settings gear; the previous campaign recorded it as
   * not-applicable. See `components/tv/CommandPalette.tsx`.
   */
  const [paletteOpen, setPaletteOpen] = useState(false);

  /*
   * TVP8: a picture of the chart.
   *
   * The reference has a camera in this toolbar — Save chart image, Copy chart
   * image — and this had none of it, so the only way to share a chart was the
   * operating system's screen capture, which takes the browser chrome and the
   * desktop with it. See `lib/chartSnapshot.ts` for what a pane's several
   * canvases composite into and what deliberately does not.
   */
  const snapshot = useCallback(async (mode: "save" | "copy") => {
    const host = document.querySelector<HTMLElement>(
      `[data-pane-id="${workspace.activePaneId}"]`);
    if (!host) { setToast("There is no chart to capture yet."); return; }
    const canvas = compositePane(host, { symbol: displayTicker(symbol), interval });
    if (!canvas) { setToast("The chart has not finished drawing."); return; }
    try {
      if (mode === "copy") {
        await copyCanvasToClipboard(canvas);
        setToast("Chart image copied.");
      } else {
        await downloadCanvas(canvas, snapshotFilename(displayTicker(symbol), interval));
        setToast("Chart image saved.");
      }
    } catch (e) {
      // These throw a sentence rather than a DOMException, on purpose.
      setToast((e as Error).message);
    }
  }, [workspace.activePaneId, symbol, interval]);
  const [goTo, setGoTo] = useState<{ time: number; signal: number } | null>(null);
  const [drawingSettingsOpen, setDrawingSettingsOpen] = useState(false);
  const [alertOpen, setAlertOpen] = useState(false);
  /** Which pane the symbol dialog will retarget, or null when it is closed. */
  const [searchPaneId, setSearchPaneId] = useState<string | null>(null);
  /**
   * The letter that opened the dialog, when a letter is what opened it.
   *
   * R4b-05: TradingView opens its symbol search on any bare letter with that
   * character already in the box. Cleared when the dialog closes, so the next
   * open from the pill starts on the chart's own ticker again.
   */
  const [searchSeed, setSearchSeed] = useState<string | undefined>(undefined);
  /**
   * Which pane a typed letter retargets, read at the moment of the keystroke.
   *
   * `useShortcuts` subscribes once and holds its handlers in a ref, so the
   * opener must not close over a pane id captured when the page first
   * rendered — a user who focuses a second chart and types a letter means
   * THAT chart.
   */
  const activeIdRef = useRef("");

  // ── drawings (persisted per symbol, shared by every pane on it) ──
  const [tool, setTool] = useState<DrawingTool>("cursor");
  /*
   * TVP8 (R2): the magnet has the reference's three modes. "weak" snaps an
   * anchor to O/H/L/C only when the pointer is already within a few pixels of
   * one; "strong" always takes the nearest. The M shortcut toggles between
   * off and the mode last chosen, which is how the reference's cell behaves.
   */
  const [magnetMode, setMagnetMode] = useState<MagnetMode>("off");
  const lastMagnetMode = useRef<Exclude<MagnetMode, "off">>("weak");
  const magnet = magnetMode !== "off";
  const setMagnet = useCallback((on: boolean | ((current: boolean) => boolean)) => {
    setMagnetMode((current) => {
      const next = typeof on === "function" ? on(current !== "off") : on;
      return next ? lastMagnetMode.current : "off";
    });
  }, []);
  const chooseMagnetMode = useCallback((mode: MagnetMode) => {
    if (mode !== "off") lastMagnetMode.current = mode;
    setMagnetMode(mode);
  }, []);
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
   * The Pine instance whose Inputs dialog is open, and the pane that owns it.
   *
   * Keyed and resolved fresh for the same reasons as the built-in above — and
   * by PANE as well, because Pine lists are per pane and the gear that opened
   * the dialog belongs to one of them; removing the study or closing its pane
   * closes the dialog rather than editing a ghost.
   */
  const [editingPine, setEditingPine] = useState<{ paneId: string; key: string } | null>(null);
  const editingPineStudy = useMemo(
    () => (editingPine
      ? indicatorLists[editingPine.paneId]?.find((i) => i.key === editingPine.key) ?? null
      : null),
    [editingPine, indicatorLists]);
  const editPine = useCallback((paneId: string, key: string) => {
    setWorkspace((ws) => setActivePane(ws, paneId));
    setEditingPine({ paneId, key });
  }, []);

  /**
   * The price-alert dialog, and the level it opened with.
   *
   * `pickingLevel` is the intermediate state: the user asked to place a level
   * and the next chart click supplies it. Keeping it separate from the dialog
   * means the chart is only click-armed while that mode is on, and behaves
   * exactly as before at every other moment.
   */
  const [priceAlertOpen, setPriceAlertOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  /** Which level family the dialog is open on, or null when it is closed. */
  const [levelKind, setLevelKind] = useState<"sr_zone" | "pivot_level" | null>(null);
  /** Which oscillator family the dialog is open on, or null when closed. */
  const [oscillatorKind, setOscillatorKind] = useState<IndicatorKind | null>(null);
  /**
   * C-04: the clicked study's own inputs when the dialog was opened from its
   * legend, so the alert watches that line; null from the toolbar, which keeps
   * the family's defaults.
   */
  const [oscillatorSeed, setOscillatorSeed] = useState<IndicatorAlertSeed | null>(null);
  const [priceAlertLevel, setPriceAlertLevel] = useState<number | null>(null);
  const [pickingLevel, setPickingLevel] = useState(false);
  /**
   * C14: the price alert being edited when its dialog stepped aside so the
   * chart could supply a level — the edit to return to after the click,
   * rather than a fresh create — and the level that click supplied.
   */
  const [pickReturn, setPickReturn] = useState<MaAlert | null>(null);
  const [editingAlertLevel, setEditingAlertLevel] = useState<number | null>(null);

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
    if (pickReturn) {
      setEditingAlertLevel(price);
      setEditingAlert(pickReturn);
      setPickReturn(null);
      return;
    }
    setPriceAlertLevel(price);
    setPriceAlertOpen(true);
  }, [pickReturn]);

  /** Open the dialog with no level picked; it falls back to the last price. */
  const openPriceAlert = useCallback(() => {
    const capability = alertCapability(symbol);
    if (!capability.supported) {
      setToast(capability.reason);
      return;
    }
    setPriceAlertLevel(null);
    // A create started mid-pick replaces the edit that was waiting on it, so
    // the next chart click arms THIS dialog rather than reopening the edit.
    setPickReturn(null);
    setPriceAlertOpen(true);
  }, [symbol]);

  const openAutomation = useCallback(() => {
    const capability = alertCapability(symbol);
    if (!capability.supported) {
      setToast(capability.reason);
      return;
    }
    setAlertOpen(true);
  }, [symbol]);

  const toggleMa = useCallback((type: MaType, length: number) => {
    setWorkspace((ws) => togglePaneMa(ws, ws.activePaneId, type, length));
  }, []);

  const toggleAllMa = useCallback((visible: boolean) => {
    setWorkspace((ws) => setPaneMaVisibility(ws, ws.activePaneId, visible));
  }, []);

  /**
   * A1: the price legend's `Moving averages` row, acted on like any study row.
   *
   * Hide is the legend's eye (it remembers which lines were on, and the dimmed
   * row it leaves brings exactly those back); Settings is the panel where the
   * lines are chosen; Remove is that panel's `Hide all`, which its `Show all`
   * undoes — the same reversibility the panel has always had, no confirmation
   * because the panel asks for none either.
   */
  const maAction = useCallback((paneId: string, action: "hide" | "settings" | "remove") => {
    if (action === "settings") {
      setWorkspace((ws) => setActivePane(ws, paneId));
      setPanel("ma");
      return;
    }
    setWorkspace((ws) => (action === "hide"
      ? togglePaneMaSet(ws, paneId) : removePaneMaSet(ws, paneId)));
  }, []);

  /** A5: `Add alert on RSI…` from a study's legend, through the same gate as the MA panel's rows. */
  const latestWorkspace = useRef(workspace);
  latestWorkspace.current = workspace;
  const studyAlert = useCallback((paneId: string, kind: IndicatorKind, seed: IndicatorAlertSeed | null) => {
    // Read through a ref so the callback the panes hold stays stable.
    const target = paneById(latestWorkspace.current, paneId)?.symbol;
    setWorkspace((ws) => setActivePane(ws, paneId));
    if (!target) return;
    if (!alertCapability(target).supported) { setToast(alertCapability(target).reason); return; }
    setOscillatorSeed(seed);
    setOscillatorKind(kind);
  }, []);

  /**
   * W2A-04: `Add alert on Moving averages › SMA 20…` from the set's legend —
   * the MA panel's own per-line dialog, behind the same capability gate.
   */
  const maAlert = useCallback((paneId: string, line: { type: MaType; length: number }) => {
    const target = paneById(latestWorkspace.current, paneId)?.symbol;
    setWorkspace((ws) => setActivePane(ws, paneId));
    if (!target) return;
    if (!alertCapability(target).supported) { setToast(alertCapability(target).reason); return; }
    setArmLine(line);
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
  /*
   * TVP8: a layout carries the arrangement, not just the symbol.
   *
   * `captureLayoutWorkspace` is called at SAVE time rather than memoised with
   * the rest: the studies and drawings live in their own stores and change
   * without this component re-rendering, so a memo keyed on React state would
   * save a stale arrangement. `useSavedLayouts` reads this object when it
   * saves, which is the moment the answer has to be current.
   */
  const workspaceState = useMemo<WorkspaceState>(
    () => ({
      symbol, interval, bars, strategyKey, params, properties, movingAverages: maLines,
      get workspace() { return captureLayoutWorkspace(); },
    }),
    [symbol, interval, bars, strategyKey, params, properties, maLines]
  );

  /** A saved layout describes one chart; it is applied to the focused pane. */
  const applyState = useCallback((s: WorkspaceState, how: "open" | "restore" = "open") => {
    /*
     * TVP8: the arrangement first, then the chart.
     *
     * The studies and drawings go back into their own stores, and the pane
     * record into the key `lib/workspace.ts` reads at mount. That record is
     * read ONCE, so a layout that changes the pane grid needs the page to
     * re-read it — which is what the reload below is for. When the layout
     * carries no pane record (one saved before TVP8, or by the deployment
     * sync) nothing reloads and this behaves exactly as it always did.
     *
     * Phase 2: only when the user OPENS a layout. At mount, reopening the one
     * they left, every store this would write already holds what they left in
     * it — and the page writes the live arrangement back to that same key as
     * it renders, so the saved copy and the live one never agreed and the
     * reload below ran on every load, about eight times a second, forever.
     * The chart, the timeframe and the strategy below still restore.
     */
    const panesRestored = how === "open" && restoreLayoutWorkspace(s.workspace);
    setWorkspace((ws) => setWorkspaceBars(updatePane(ws, ws.activePaneId, {
      symbol: s.symbol,
      interval: s.interval,
      maLines: s.movingAverages?.length ? s.movingAverages : defaultMaLines(),
    }), s.bars));
    setStrategyKey(s.strategyKey);
    setParams(s.params);
    setProperties(s.properties);
    setTrades([]);
    if (panesRestored) window.location.reload();
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
    defaultName: `${displayTicker(symbol)} ${interval}`,
    onToast: setToast,
    onError: setErr,
  });
  const refreshLayouts = savedLayouts.refresh;
  const setCurrentLayoutId = savedLayouts.setCurrentId;

  const applyBestConfig = useCallback(async () => {
    setLoadingBest(true);
    setErr(null);
    try {
      const optimizerSymbol = legacyBinanceSpotTicker(symbol);
      if (!optimizerSymbol) throw new Error("Optimizer configurations are available for Binance Spot instruments only.");
      /*
       * The optimizer's leaderboard is keyed by a STORED interval. A derived
       * chart resolution has no row there, so the request is made without a
       * timeframe filter — the reply then names the timeframe it found, and
       * `applyPaneInterval` moves the chart onto it, which is visible rather
       * than silent.
       */
      const best = await api.optimizerBest(
        optimizerSymbol, 1, strategyKey, storedIntervalFor(interval) ?? undefined);
      setStrategyKey(best.strategyKey);
      setParams(best.params);
      setProperties((prev) => withOptimizerProperties(prev, best.properties));
      setWorkspace((ws) => applyPaneInterval(ws, ws.activePaneId, best.timeframe, sync));
      setBestRange(optimizerRange(best.properties));
      setTrades([]);
      const net = best.metrics.net_pct;
      const dd = best.metrics.dd_pct;
      setToast(
        `Best ${displayTicker(symbol)} config applied${net != null ? ` · +${net.toFixed(1)}%` : ""}${dd != null ? ` · DD ${dd.toFixed(1)}%` : ""}`
      );
    } catch (e) {
      setErr(describeAction(e, "apply the best configuration"));
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
      setErr(describeAction(e, "apply that configuration"));
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

  /*
   * ── R4b-05: a letter over the chart opens the symbol search ──────────────
   *
   * TradingView's shortcut sheet says it in four words — "Change symbol: any
   * letter" — and it is one of the three ways into that dialog, beside the
   * pill and ⌘K. This product had only the pill and `/`; a letter over the
   * chart armed a drawing tool instead, because `lib/shortcuts` spent eleven
   * bare letters on tools. Those letters are now the reference's ⌥ chords
   * (see §7c-i of the UI contract), which leaves the alphabet free.
   *
   * The listener itself is `useShortcuts` — one window listener and one
   * table, which is the property that file exists to have. A second listener
   * of this page's own would have had to re-implement the typing guard, the
   * dialog guard and the interval buffer, and would have raced the first one
   * for the key. `onTypeSymbol` below is what it calls; the effect this
   * replaced was the `/`-only opener.
   */
  const openSearchWithLetter = useCallback((letter: string) => {
    setSearchSeed(letter);
    setSearchPaneId(activeIdRef.current);
  }, []);


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
  /** Which pane's comparison dialog is open, if any — the toolbar's `+` sets it. */
  const [comparePaneId, setComparePaneId] = useState<string | null>(null);

  const changePaneCompare = useCallback((paneId: string, next: PaneCompare | null) => {
    setWorkspace((ws) => setPaneCompare(ws, paneId, next));
  }, []);

  const changePaneSymbol = useCallback((paneId: string, next: string) => {
    pauseReplayForNavigation();
    setWorkspace((ws) => applyPaneSymbol(ws, paneId, next, sync));
    // B-03: the open trade's ENTRY / TP / SL are the previous instrument's
    // levels, and were left drawn across the new one until a rerun landed.
    setTrades([]); setOpenTrade(null);
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
    setTrades([]); setOpenTrade(null);
  }, [pauseReplayForNavigation, sync, resolutions]);

  const activatePane = useCallback((paneId: string) => {
    setWorkspace((ws) => setActivePane(ws, paneId));
  }, []);

  /*
   * TVP8: stay in drawing mode.
   *
   * Finishing a drawing dropped the rail back to the cursor, every time. The
   * reference has a toggle for exactly this, and it is the difference between
   * marking up a chart with eight trend lines in one pass and going back to
   * the rail eight times. Off by default, which is the reference's default too.
   */
  const [stayInDrawingMode, setStayInDrawingMode] = useState(false);
  const stayRef = useRef(stayInDrawingMode);
  stayRef.current = stayInDrawingMode;
  const clearDrawingTool = useCallback(() => {
    if (!stayRef.current) setTool("cursor");
  }, []);

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
    /*
     * The FIRST-RUN default, and only that.
     *
     * This comment used to say "also the default for panes created later",
     * which is not true and has not been since panes were added: `setPreset`
     * grows the workspace with `clonePane(activePane)`, so a new pane inherits
     * the pane it was split from — which is the behaviour a user expects and
     * the one the reference has. `tv.chartType` seeds `loadWorkspace` on a
     * browser that has no stored workspace at all, so somebody who prefers
     * Heikin Ashi gets it on a new machine rather than candles.
     */
    saveChartType(next);
  }, []);

  const changeBars = useCallback((next: number) => {
    setWorkspace((ws) => setWorkspaceBars(ws, next));
  }, []);

  /** The live-state panel a Replay session closed, to reopen when it ends. */
  const panelBeforeReplay = useRef<Panel>(null);
  const beginReplay = useCallback((requestedTime: number) => {
    // A new session starts with an empty, un-undoable Replay history: undoing
    // "the session began" is meaningless, and the previous session's steps
    // must not be reachable from this one.
    drawingStore.resetReplay(symbol, []);
    const next = startReplay(candles, requestedTime);
    if (!next) { setErr({ headline: "No completed candle exists at or before that replay point.", detail: "" }); return; }
    setReplay(next);
    setReplayPickerOpen(false);
    setReplayDrawings([]);
    setTrades([]); setOpenTrade(null);
    setToast(null); setPendingApply(null);
    setPickingLevel(false); setPriceAlertOpen(false); setPickReturn(null);
    setLevelKind(null); setOscillatorKind(null); setEditingAlert(null); setArmLine(null);
    setAlertOpen(false);
    /*
     * B-14: only the panels that act on LIVE state close, and they come back.
     *
     * This closed every panel but the watchlist and the indicators — the
     * Objects / Data window included, which is the panel a person reading
     * replayed bars wants most — and exiting reopened none of them. Alerts and
     * the order ticket render nothing during a session (`ChartSidePanel` gates
     * both on Replay), so those two close; everything else is left alone.
     */
    setPanel((current) => {
      if (current === "alerts" || current === "manual") {
        panelBeforeReplay.current = current;
        return null;
      }
      panelBeforeReplay.current = null;
      return current;
    });
    // `symbol` because the Replay history is scoped to it: a session begun on
    // one instrument must not seed another's scope.
  }, [candles, symbol]);

  const exitReplay = useCallback(() => {
    setReplay(null); setReplayPickerOpen(false); setReplayDrawings([]);
    // Reopened only onto an empty side: a panel chosen during the session wins.
    const reopen = panelBeforeReplay.current;
    panelBeforeReplay.current = null;
    if (reopen) setPanel((current) => current ?? reopen);
  }, []);

  /**
   * The toolbar's Replay chip, and the `b` key, and the palette row.
   *
   * TVP8 round two: this was `setReplayPickerOpen(open => replayActive ? open
   * : !open)` — a control drawn with `aria-pressed={replayActive}` that could
   * be pressed but never un-pressed. Every other pressed chip in this toolbar
   * releases, and the only way out of a session was a 12px × at the far right
   * of a strip below the chart. A toggle that will not toggle is the kind of
   * thing a user tries twice and then stops trusting.
   */
  const toggleReplay = useCallback(() => {
    if (replayActive) { exitReplay(); return; }
    setReplayPickerOpen((open) => !open);
  }, [replayActive, exitReplay]);
  const setReplayPlaying = useCallback((playing: boolean) => {
    setReplay((current) => current ? { ...current, playing } : null);
  }, []);
  const setReplaySpeed = useCallback((speed: ReplaySpeed) => {
    setReplay((current) => current ? { ...current, speed } : null);
  }, []);

  /*
   * ── TVP8 round two: Play advanced nothing ─────────────────────────────────
   *
   * This effect listed `candles` and the whole `replay` object. `candles` is a
   * new array on every poll and on every live tick, so the cleanup cleared the
   * pending timeout and the effect scheduled a fresh one — over and over,
   * faster than the replay delay. The button said Pause and the chart sat
   * still. On a canonical instrument, which streams, it could never advance at
   * all.
   *
   * The bars are read through a ref: which bars exist is not a reason to
   * restart the clock. The effect now re-runs only when the session's own
   * state changes — and `horizonCloseTime` changing after each tick is
   * precisely what schedules the next one.
   */
  const replayCandlesRef = useRef(candles);
  replayCandlesRef.current = candles;
  /*
   * B-04: and it no longer waits for the studies. It used to skip every tick
   * while any Pine study was loading, so Play at 10× advanced one bar per
   * round trip. A forward step keeps the previous output and studies coalesce
   * their reruns (`useIndicators`'s `runForward`), so the clock runs at the
   * speed chosen and the studies catch up — never ahead of the horizon.
   */
  useEffect(() => {
    if (!replay?.playing) return;
    const timer = window.setTimeout(() => {
      setReplay((current) => current ? replayTick(current, replayCandlesRef.current) : null);
    }, replayDelayMs(replay.speed));
    return () => window.clearTimeout(timer);
  }, [replay?.playing, replay?.speed, replay?.horizonCloseTime]);

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

  /*
   * R6 A-1: `Only active alerts` is a pane setting, so the filter is a
   * parameter.
   *
   * `isAlertActive` was applied unconditionally, which meant a paused alert
   * and a spent `once_only` alert both vanished from the chart with no way to
   * see the levels they are still sitting at. The dialog's dependent row turns
   * the filter off; the rows themselves are still only the FIXED-price ones,
   * because an alert stated relative to a moving average has no single price
   * to draw.
   */
  const alertLinesFor = useCallback((paneInterval: Resolution, onlyActive: boolean): ChartPriceLine[] =>
    maAlerts
      .filter((a) => a.conditionKind === "price" && a.targetPrice !== null &&
                     a.timeframe === paneInterval && (!onlyActive || isAlertActive(a)))
      .map((a) => ({
        price: a.targetPrice!,
        color: alertColor(a),
        // Text, not an emoji: this is drawn into the price scale by the chart
        // canvas, where a platform emoji renders at its own size and colour and
        // cannot inherit the line's.
        title: `Alert · ${describeAlert(a).replace("price ", "")}`,
        dashed: true,
        // So `showTrading` cannot take these away with the position lines.
        kind: "alert" as const,
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
      if (onEvidenceSymbol) {
        lines.push(...alertLinesFor(
          pane.interval, paneChartSettings(workspace, pane.id).onlyActiveAlerts));
      }
      if (onTradingSymbol) lines.push(...manualPriceLines);
      if (onEvidenceSymbol) lines.push(...overlays.priceLines);
      map.set(pane.id, {
        markers,
        priceLines: lines.length > 0 ? lines : NO_PRICE_LINES,
        trades: onEvidenceSymbol && pane.interval === interval ? trades : NO_TRADES,
      });
    }
    return map;
  }, [workspace, symbol, tradingSymbol, interval, replayActive, overlays.markers,
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
        kind: "chart" | "drawing" | "axis" | "time" | "series" | "legend"; paneId: string; price: number | null;
        drawingId: string | null;
        /** An exact panel width, for a payload the reference measures. */
        width?: number }
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
  /** B-08: the window a pane was left on, persisted with the pane. */
  const setPaneWindow = useCallback((paneId: string, next: PaneViewport) => {
    // Not `setWorkspace` — see `paneViewports` for why this stays out of state.
    paneViewports.current = { ...paneViewports.current, [paneId]: next };
    if (workspaceReadyRef.current) persistWorkspace(workspaceRef.current);
  }, [persistWorkspace]);
  /** B-09/B-15: the order and heights of a pane's study stack, persisted with it. */
  const setPaneStack = useCallback((paneId: string, next: SavedPaneLayout) => {
    setWorkspace((ws) => setPaneStudyLayout(ws, paneId, next));
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
  /**
   * The workspace's watchlists, for the chart menu's `Add {TICKER} to
   * watchlist` row (R8-17).
   *
   * Read here rather than lifted out of `Watchlist`: that component owns the
   * list editing surface and its state is already large, and a right-click on
   * the chart must be able to offer the row whether or not the watchlist panel
   * has ever been opened. One GET, at mount, refreshed when the menu is about
   * to need it — a stale name on a submenu row is a cosmetic error; a missing
   * route is a functional one.
   */
  const [watchlists, setWatchlists] = useState<{ id: string; name: string }[]>([]);
  const refreshWatchlists = useCallback(() => {
    api.listWatchlists()
      .then((rows) => setWatchlists(rows.map((r) => ({ id: r.id, name: r.name }))))
      // A workspace whose watchlists cannot be read still has a chart. The row
      // is simply absent, which is what `lists: []` already means in the payload.
      .catch(() => setWatchlists([]));
  }, []);
  useEffect(() => { refreshWatchlists(); }, [refreshWatchlists]);
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

  /** D-03: one real model shared by the Objects and Data window tabs. */
  const objectStudies = [
    /*
     * A1: the moving-average set is on the chart, so it is in the Object
     * tree, as every study row is on the reference. Listed while any line is
     * drawn or the legend's eye is holding a set to bring back; its eye and
     * trash are the legend row's own.
     */
    ...(active.maLines.some((line) => line.visible) || (active.maHiddenSet?.length ?? 0) > 0 ? [{
      id: MA_INSTANCE_ID,
      label: MA_INSTANCE_TITLE,
      visible: active.maLines.some((line) => line.visible),
      onToggleVisible: () => maAction(active.id, "hide"),
      onRemove: () => maAction(active.id, "remove"),
    }] : []),
    ...(activeNativeStudies?.rows ?? []).map((row) => ({
      id: row.study.key,
      label: row.name,
      visible: row.study.visible,
      onToggleVisible: () => activeNativeStudies?.toggleVisible(row.study.key),
      onRemove: () => activeNativeStudies?.remove(row.study.key),
    })),
    ...activeIndicatorList.map((study) => ({
      id: study.key,
      label: study.name,
      visible: study.visible,
      onToggleVisible: () => activeIndicators?.toggleVisible(study.key),
      onRemove: () => activeIndicators?.remove(study.key),
    })),
  ];
  const objectDrawings = currentDrawings.map((drawing) => {
    const fallback = drawingToolName(drawing.tool);
    const label = drawing.name ?? `${fallback.charAt(0).toUpperCase()}${fallback.slice(1)}`;
    const replace = (patch: Partial<Drawing>, gesture: string) => writeDrawings(
      currentDrawings.map((item) => item.id === drawing.id ? { ...item, ...patch } : item), gesture);
    return {
      id: drawing.id,
      label,
      visible: drawing.hidden !== true,
      locked: drawing.locked === true,
      onToggleVisible: () => replace({ hidden: !drawing.hidden }, "object-tree-hide"),
      onToggleLock: () => replace({ locked: !drawing.locked }, "object-tree-lock"),
      onRemove: () => writeDrawings(
        currentDrawings.filter((item) => item.id !== drawing.id), "object-tree-remove"),
    };
  });
  /** W2D-05: what the focused pane last reported drawing, for the Data window. */
  const [dataWindowSource, setDataWindowSource] = useState<
    { paneId: string; overlays: readonly ChartOverlay[] } | null>(null);
  const reportDataWindowPlots = useCallback(
    (paneId: string, overlays: readonly ChartOverlay[]) => setDataWindowSource({ paneId, overlays }),
    []);
  const dataWindowTime = cross?.time ?? null;
  const dataWindowCandle = dataWindowTime === null
    ? visibleCandles[visibleCandles.length - 1] ?? null
    : visibleCandles.find((candle) => Math.floor(candle.openTime / 1000) === dataWindowTime) ?? null;
  /*
   * W2D-05: every study the focused pane DRAWS, read at the hovered bar.
   *
   * This was the page's own two lists — the built-in list's overlays as they
   * stood when a study was added (before it had computed anything, so RSI and
   * ATR were absent) and the Pine overlays — so the window showed Pine plots
   * and nothing else. The pane reports the set its legends are built from
   * (`onDataWindowPlots`) while this panel is open; until it has, the old two
   * lists stand in rather than an empty window.
   */
  const dataWindowOverlays = dataWindowSource?.paneId === active.id
    ? dataWindowSource.overlays
    : [
        ...(activeNativeStudies?.overlays ?? []),
        ...activeIndicatorList.filter((study) => study.visible).flatMap((study) => study.overlays),
      ];
  const objects = {
    seriesLabel: displayTicker(symbol),
    studies: objectStudies,
    drawings: objectDrawings,
    data: {
      /*
       * B-10: in the CHART's zone, the one its time axis is drawn in. This
       * was `toLocaleString()` — the browser's zone — so a UTC axis reading
       * 00:45 sat above a Data window reading 20:45 the evening before.
       */
      time: dataWindowCandle
        ? fmtChartBarTime(dataWindowCandle.openTime, resolutionMs(interval),
          paneChartSettings(workspace, active.id).timeZone)
        : "Move the crosshair over a loaded bar",
      ohlc: ([
        ["Open", dataWindowCandle?.open], ["High", dataWindowCandle?.high],
        ["Low", dataWindowCandle?.low], ["Close", dataWindowCandle?.close],
      ] as const).map(([label, value]) => ({ label, value: fmtPrice(value) })),
      series: dataWindowSeriesRows(visibleCandles, dataWindowCandle),
      studies: dataWindowStudies(dataWindowOverlays, dataWindowTime),
    },
  };

  const openChartMenu = useCallback((
    paneId: string,
    event: {
      x: number; y: number; drawingId: string | null; price: number | null;
      /** Which strip was clicked: the plot, the price axis, or the time axis. */
      region: "plot" | "axis" | "time" | "series" | "legend";
    }
  ) => {
    activatePane(paneId);
    const pane = paneById(workspace, paneId);
    const paneSymbol = pane?.symbol ?? symbol;
    const drawings = replayActive ? replayDrawings : drawingStore.get(paneSymbol);
    if (event.region === "legend") {
      // W2A-11: a legend row's right-click is the legend's own display menu.
      const settings = paneChartSettings(workspace, paneId);
      setMenu({
        at: { x: event.x, y: event.y },
        label: "Legend",
        kind: "legend",
        paneId,
        price: null,
        drawingId: null,
        entries: legendDisplayMenu({
          showStatusLine: settings.showStatusLine,
          values: Object.fromEntries(Object.values(LEGEND_MENU_SETTING)
            .map((key) => [key, settings[key]])) as Record<LegendMenuSettingKey, boolean>,
          mac: isMacPlatform(),
        }),
      });
      return;
    }
    if (event.region === "series") {
      /*
       * A4: the series legend's `⋯`. It opened the chart's own menu; Premium
       * opens one about the INSTRUMENT, priced at its last value. Same 325px
       * panel as the chart menu, whose widest row is the same alert row.
       */
      setMenu({
        at: { x: event.x, y: event.y },
        label: `${displayTicker(paneSymbol)} series`,
        kind: "series",
        paneId,
        price: event.price,
        drawingId: null,
        width: 325,
        entries: seriesLegendMenu({
          ticker: paneSymbol,
          mac: isMacPlatform(),
          canPaste: clipboard.current !== null,
          lists: watchlists,
          price: event.price,
          priceLabel: event.price === null ? "" : fmtPrice(event.price),
          replayActive,
          tradingEnabled: manualState?.enabled === true,
        }),
      });
      return;
    }
    if (event.region === "time") {
      setMenu({
        at: { x: event.x, y: event.y },
        label: "Time scale",
        kind: "time",
        paneId,
        price: null,
        drawingId: null,
        entries: timeAxisMenu({
          mac: isMacPlatform(),
          timeZone: paneChartSettings(workspace, paneId).timeZone,
        }),
      });
      return;
    }
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
          mac: isMacPlatform(),
          // R8-20: the reference's `Move scale to left` and its `Labels ›` /
          // `Lines ›` submenus, over the Scales-tab settings this pane holds.
          onLeft: paneChartSettings(workspace, paneId).scalePlacement === "left",
          labels: {
            lastValue: paneChartSettings(workspace, paneId).lastValueLabel,
            indicatorValue: paneChartSettings(workspace, paneId).indicatorLastValue,
            dayOfWeek: paneChartSettings(workspace, paneId).dayOfWeekOnLabels,
          },
          lines: {
            lastValue: paneChartSettings(workspace, paneId).lastValueLine,
            bidAsk: paneChartSettings(workspace, paneId).bidAskLines !== "hidden",
          },
          plusButton: paneChartSettings(workspace, paneId).plusButton,
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
          // R8-21: the reference writes `Add alert on trendline…`; this wrote
          // "Add alert on this level" whatever had been right-clicked.
          toolName: drawing ? drawingToolName(drawing.tool) : "drawing",
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
          // W2A-10: this tool's saved templates, and which of the four
          // interval shortcuts the drawing's allow-list already is.
          templates: drawing
            ? templatesForTool(loadDrawingTemplates(), drawing.tool).map((t) => t.name) : [],
          intervalVisibility: drawing ? intervalVisibilityOf(drawing.visibleOn, interval) : "all",
        }),
      });
      return;
    }
    setMenu({
      at: { x: event.x, y: event.y },
      /*
       * R8-18, contract §5: this was `${paneSymbol} chart`, and on a canonical
       * instrument `paneSymbol` IS the storage key — so the menu announced
       * itself to a screen reader as
       * "instrument:v1:BINANCE:spot:BTC:USDT:USDT:spot chart". The DOM test
       * passed only because its fixture symbol happens to be a plain ticker.
       */
      label: `${displayTicker(paneSymbol)} chart`,
      kind: "chart",
      paneId,
      price: event.price,
      drawingId: null,
      entries: chartMenu({
        ticker: paneSymbol,
        mac: isMacPlatform(),
        canPaste: clipboard.current !== null,
        lists: watchlists,
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
        indicatorCount: activeIndicatorList.length + (activeNativeStudies?.rows?.length ?? 0),
      }),
    });
  }, [activatePane, workspace, symbol, replayActive, replayDrawings, drawHidden, drawLocked,
    paneScale, manualState, candleOverlays, classicalOverlays, watchlists, activeIndicatorList.length,
    activeNativeStudies?.rows?.length, interval]);

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
    const paneSymbol = paneById(workspace, paneId)?.symbol ?? symbol;
    /** The pane's Scales-tab settings, which the axis submenus toggle. */
    const chartSettings = paneChartSettings(workspace, paneId);
    const writeSettings = (next: Partial<ChartSettings>): void => {
      setWorkspace((ws) => setPaneChartSettings(
        ws, paneId, { ...paneChartSettings(ws, paneId), ...next }));
    };
    /*
     * A6: the time axis's `Time zone ›` rows, one per zone the setting offers.
     * Anything else after the prefix is not a zone this product can label in,
     * and is ignored rather than written.
     */
    if (id.startsWith(TIME_ZONE_MENU_PREFIX)) {
      const zone = CHART_TIME_ZONES.find((item) => item.value === id.slice(TIME_ZONE_MENU_PREFIX.length));
      if (zone) writeSettings({ timeZone: zone.value });
      return;
    }
    /*
     * R8-17: `Add {TICKER} to watchlist ›`. With one list the parent row is
     * the action, so it carries the list's own id here.
     */
    if (id === "chart:add-to-watchlist" || id.startsWith(CHART_ADD_TO_LIST_PREFIX)
      // A4: the series menu's copy of the row, answered by the same code.
      || id === "series:add-to-watchlist" || id.startsWith(SERIES_ADD_TO_LIST_PREFIX)) {
      const listId = id === "chart:add-to-watchlist" || id === "series:add-to-watchlist"
        ? watchlists[0]?.id ?? null
        : id.slice((id.startsWith(SERIES_ADD_TO_LIST_PREFIX)
          ? SERIES_ADD_TO_LIST_PREFIX : CHART_ADD_TO_LIST_PREFIX).length);
      const list = watchlists.find((l) => l.id === listId);
      if (!list) { setToast("This workspace has no watchlist to add to"); return; }
      api.listWatchlists()
        .then(async (rows) => {
          const row = rows.find((r) => r.id === list.id);
          if (!row) throw new Error("that list no longer exists");
          if (row.symbols.some((s) => sameSymbol(s, paneSymbol))) {
            setToast(`${displayTicker(paneSymbol)} is already in ${row.name}`);
            return;
          }
          await api.updateWatchlist(row.id, { symbols: [...row.symbols, paneSymbol] });
          setToast(`${displayTicker(paneSymbol)} added to ${row.name}`);
          refreshWatchlists();
        })
        .catch((e: Error) => setToast(describeAction(e, "add the symbol to that list").headline));
      return;
    }
    switch (id) {
      case "chart:copy-price":
      case "series:copy-price":
        if (price !== null) copyPrice(price);
        return;
      case "chart:add-alert":
      case "series:add-alert":
        if (price !== null) pickLevel(price);
        return;
      case "chart:trade-at-price":
      case "series:trade-at-price":
        // PREPARES a ticket. It does not submit, and no context-menu item in
        // this product ever will — that is the alert/automation boundary.
        setPanel("manual");
        return;
      case "chart:indicators":
      // R8-17: the reference's own row, which reaches the same browser the
      // toolbar's `Indicators` control does. One dialog, three routes.
      // falls through
      case "chart:add-indicator":
      case "series:add-indicator":
        setIndicatorBrowserOpen(true);
        return;
      case "chart:symbol-info":
      case "series:symbol-info":
        /*
         * The reference's `Symbol info…` is a read-only card about the
         * instrument. This product's equivalent is the watchlist panel's
         * details view, which the panel opens on the focused symbol.
         */
        setPanel("watchlist");
        return;
      case "chart:paste":
      case "series:paste":
        // The same clipboard ⌘V reads. `pasteDrawing` is the keyboard's own
        // handler, so the two routes cannot drift apart.
        shortcutActionRef.current?.("paste");
        return;
      case "chart:text-note":
      case "series:text-note":
        /*
         * The reference's `Add text note for {TICKER} ⌥N` arms a text tool at
         * the price under the pointer. Arming the tool is what this product
         * has; the next click places the note, which is one gesture more than
         * the reference and zero guesses about where the user wants it.
         */
        setTool("text");
        setToast("Click the chart to place the note");
        return;
      case "chart:chart-settings":
      case "series:chart-settings": setChartSettingsOpen(true); return;
      /*
       * W2A-11: the legend menu's rows are the Status line tab's own keys,
       * written to the pane the menu was opened on, and its `Settings…` opens
       * the dialog on that tab rather than on Symbol.
       */
      case "legend:toggle-symbol":
      case "legend:toggle-market-status":
      case "legend:toggle-ohlc":
      case "legend:toggle-bar-change":
      case "legend:toggle-volume":
      case "legend:toggle-day-change":
      case "legend:toggle-indicator-titles":
      case "legend:toggle-indicator-inputs":
      case "legend:toggle-indicator-values": {
        const key = LEGEND_MENU_SETTING[id];
        writeSettings({ [key]: !chartSettings[key] });
        return;
      }
      case "legend:settings":
        setChartSettingsTab("status");
        setChartSettingsOpen(true);
        return;
      case "chart:object-tree": setPanel("objects"); return;
      case "chart:table-view":
      case "series:table-view": setPanel("objects"); return;
      case "chart:remove-indicators": activeIndicators?.clear(); activeNativeStudies?.clear(); return;
      case "chart:toggle-drawings-hidden": setDrawHidden((v) => !v); return;
      case "chart:toggle-drawings-locked": setDrawLocked((v) => !v); return;
      case "chart:toggle-candle-patterns":
        candleOverlays[paneId]?.setEnabled(!candleOverlays[paneId]?.enabled);
        return;
      case "chart:toggle-classical-patterns":
        classicalOverlays[paneId]?.setEnabled(!classicalOverlays[paneId]?.enabled);
        return;
      case "time:chart-settings": setChartSettingsOpen(true); return;
      case "time:go-to": setGoToOpen(true); return;
      case "chart:reset-view":
      case "time:reset-view":
      case "axis:reset":
        setPaneScale(paneId, resetPriceScale());
        setPaneResets((current) => ({ ...current, [paneId]: (current[paneId] ?? 0) + 1 }));
        return;
      case "chart:toggle-auto":
      case "axis:toggle-auto":
        setPaneScale(paneId, togglePriceScaleAuto(scale));
        return;
      case "chart:toggle-log":
        setPaneScale(paneId, togglePriceScaleMode(scale));
        return;
      /*
       * ── R8-20: the axis's four readings are a RADIO group ────────────────
       *
       * On the axis menu these four SET a mode rather than toggling one, which
       * is what `menuitemradio` promises the reader. `chart:toggle-log` above
       * keeps toggling, because on the chart menu it is a lone switch with no
       * siblings to be exclusive against.
       */
      case "axis:mode-regular":
        setPaneScale(paneId, setPriceScaleMode(scale, "normal"));
        return;
      case "axis:toggle-log":
        setPaneScale(paneId, setPriceScaleMode(scale, "logarithmic"));
        return;
      case "axis:toggle-percent":
        setPaneScale(paneId, setPriceScaleMode(scale, "percentage"));
        return;
      case "axis:toggle-indexed":
        setPaneScale(paneId, setPriceScaleMode(scale, "indexedTo100"));
        return;
      case "axis:toggle-invert":
        setPaneScale(paneId, togglePriceScaleInvert(scale));
        return;
      case "axis:move-left":
        writeSettings({
          scalePlacement: chartSettings.scalePlacement === "left" ? "right" : "left",
        });
        return;
      case "axis:label-last-value":
        writeSettings({ lastValueLabel: !chartSettings.lastValueLabel });
        return;
      case "axis:label-indicator-value":
        writeSettings({ indicatorLastValue: !chartSettings.indicatorLastValue });
        return;
      case "axis:label-day-of-week":
        writeSettings({ dayOfWeekOnLabels: !chartSettings.dayOfWeekOnLabels });
        return;
      case "axis:line-last-value":
        writeSettings({ lastValueLine: !chartSettings.lastValueLine });
        return;
      case "axis:line-bid-ask":
        writeSettings({
          bidAskLines: chartSettings.bidAskLines === "hidden" ? "line" : "hidden",
        });
        return;
      case "axis:toggle-plus-button":
        writeSettings({ plusButton: !chartSettings.plusButton });
        return;
      case "axis:more-settings": setChartSettingsOpen(true); return;
      default: break;
    }
    if (menu.kind !== "drawing" || !menu.drawingId) return;
    const drawings = currentDrawings;
    const target = drawings.find((d) => d.id === menu.drawingId);
    if (!target) return;
    if (id.startsWith(DRAWING_TEMPLATE_APPLY_PREFIX)) {
      // A saved template, by name, on this tool — read fresh, as the menu was.
      const name = id.slice(DRAWING_TEMPLATE_APPLY_PREFIX.length);
      const found = templatesForTool(loadDrawingTemplates(), target.tool).find((t) => t.name === name);
      if (!found || target.locked) return;
      writeDrawings(drawings.map((d) => (d.id === target.id
        ? { ...d, style: applyDrawingTemplate(d.style, found.style) } : d)));
      return;
    }
    switch (id) {
      case "drawing:settings":
        // The quick style bar remains available, while Settings opens the
        // deeper shared editor for coordinates/text and style.
        setDrawingSettingsOpen(true);
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
      /*
       * W2A-10: the reference's middle block. Each is the same operation the
       * toolbar or the settings dialog already performs — a template is
       * `applyDrawingTemplate`, a visibility shortcut writes the `visibleOn`
       * list the Visibility tab edits, and Object tree is the chart menu's.
       */
      case "drawing:object-tree": setPanel("objects"); return;
      case "drawing:template-save": void saveDrawingTemplateAs(ask, target); return;
      case "drawing:template-default":
        if (target.locked) return;
        writeDrawings(drawings.map((d) => (d.id === target.id
          ? { ...d, style: applyDrawingTemplate(d.style, defaultDrawingTemplate()) } : d)));
        return;
      case "drawing:visibility-above":
      case "drawing:visibility-below":
      case "drawing:visibility-only":
      case "drawing:visibility-all": {
        if (target.locked) return;
        const choice = id.slice("drawing:visibility-".length) as IntervalVisibility;
        const visibleOn = visibleOnFor(choice, interval);
        writeDrawings(drawings.map((d) => (d.id === target.id ? { ...d, visibleOn } : d)));
        return;
      }
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
    copyPrice, candleOverlays, classicalOverlays, workspace, symbol, watchlists,
    refreshWatchlists, setTool, activeIndicators, activeNativeStudies, ask]);

  /*
   * What the palette can reach. Every one of these is the SAME handler the
   * rail, the browser, the menu or the keyboard uses — a palette that had its
   * own copy of "add this study" would be a second way for the two to disagree.
   */
  const paletteHandlers = useMemo(() => ({
    drawing: (next: DrawingTool) => setTool(next),
    indicator: (studyId: string) => { activeNativeStudies?.add(studyId); },
    chartType: (next: ChartType) => changeChartType(next),
    // The keyboard's own dispatcher, through a ref: it is declared below (it
    // closes over half this component) and the palette must reach the same one.
    action: (action: ShortcutAction) => { shortcutActionRef.current?.(action); },
  }), [activeNativeStudies, changeChartType]);

  const shortcutActionRef = useRef<((action: ShortcutAction) => boolean) | null>(null);

  /*
   * Named rather than inline, so the command palette can run the SAME
   * dispatcher the keyboard does. Two copies of "what Ctrl+Z means" is two
   * things to keep in step.
   */
  const runShortcutAction = (action: ShortcutAction): boolean => {
    {
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
        case "tool:cursor":
          /*
           * Escape unwinds one layer at a time, outward. The replay picker is
           * the outermost thing Escape can reach here — `CalendarField`'s own
           * popover stops the event at the capture phase while it is open — so
           * a first Escape closes the calendar and a second closes the picker.
           */
          if (replayPickerOpen) { setReplayPickerOpen(false); return true; }
          setTool("cursor");
          return true;
        case "tool:trend": setTool("trend"); return true;
        case "tool:horizontal": setTool("hline"); return true;
        case "tool:vertical": setTool("vline"); return true;
        case "tool:fib": setTool("fib"); return true;
        case "tool:horizontal-ray": setTool("hray"); return true;
        case "tool:crossline": setTool("crossline"); return true;
        case "tool:rectangle": setTool("rect"); return true;
        case "tool:text": setTool("text"); return true;
        case "magnet": setMagnet((v) => !v); return true;
        case "stay-in-drawing-mode": setStayInDrawingMode((v) => !v); return true;
        case "lock-drawings": setDrawLocked((v) => !v); return true;
        case "hide-drawings": setDrawHidden((v) => !v); return true;
        case "symbol-search": setSearchPaneId(workspace.activePaneId); return true;
        case "indicators": setIndicatorBrowserOpen(true); return true;
        case "chart-settings": setChartSettingsOpen(true); return true;
        case "shortcuts-sheet": setShortcutsOpen(true); return true;
        case "command-palette": setPaletteOpen(true); return true;
        case "snapshot-save": void snapshot("save"); return true;
        case "snapshot-copy": void snapshot("copy"); return true;
        case "fullscreen":
          if (!fullscreen.supported) return false;
          fullscreen.toggle();
          return true;
        case "replay-toggle": toggleReplay(); return true;
        // FG-04: the bottom panel is absent when collapsed, so this is the
        // way back to it — and the palette and shortcuts sheet both list it,
        // because all three read `BINDINGS`.
        case "bottom-panel": setBottomToggle((n) => n + 1); return true;
        case "replay-step-back":
          setReplay((current) => (current ? stepReplay(current, candles, -1) : null));
          return true;
        case "replay-step-forward":
          setReplay((current) => (current ? stepReplay(current, candles, 1) : null));
          return true;
        case "replay-play-pause":
          setReplayPlaying(!(replay?.playing ?? false));
          return true;
        /*
         * Phase 3P: ⌥R, ⌥L and ⌘⇧A are printed on the shortcuts sheet, in the
         * palette and as hints on the axis and chart menus, and none of them
         * had an arm here — a printed cap that did nothing. Each acts on the
         * focused pane exactly as the menu row with the same hint does.
         */
        case "reset-view": {
          const paneId = workspace.activePaneId;
          setPaneScale(paneId, resetPriceScale());
          setPaneResets((current) => ({ ...current, [paneId]: (current[paneId] ?? 0) + 1 }));
          return true;
        }
        case "toggle-log": {
          const paneId = workspace.activePaneId;
          setPaneScale(paneId, togglePriceScaleMode(paneScale(paneId)));
          return true;
        }
        case "toggle-auto": {
          const paneId = workspace.activePaneId;
          setPaneScale(paneId, togglePriceScaleAuto(paneScale(paneId)));
          return true;
        }
        default:
          return false;
      }
    }
  };
  shortcutActionRef.current = runShortcutAction;

  const shortcuts = useShortcuts({
    onAction: runShortcutAction,
    onInterval: (next) => changePaneInterval(workspace.activePaneId, next),
    onTypeSymbol: openSearchWithLetter,
    /*
     * ── TVP8 round two: the picker used to switch the keyboard off ───────────
     *
     * This was `enabled: !replayPickerOpen`, written when the picker WAS an
     * `<input type="datetime-local">` and the whole strip therefore wanted the
     * keyboard. It is a `CalendarField` now: a button, with its only text
     * input inside a popover that `isTypingTarget` already covers from the
     * event's own target.
     *
     * A 38px strip is not a modal, and turning off every shortcut for it cost
     * more than it protected — Escape did not close the picker, `?` did not
     * open the shortcut sheet, and once Replay had a key of its own, `b` could
     * open the picker but never close it.
     */
  }, { replayActive });
  activeIdRef.current = active.id;

  /**
   * "Hide indicators" (R2b-03): every study on the focused pane hidden at
   * once, through the pane's own visibility toggles, so the Indicators
   * panel's per-study eyes and this scope agree. Hidden means "none of the
   * studies is visible"; the rail's row toggles all of them together.
   */
  const studiesHidden = activeIndicatorList.length > 0 && activeIndicatorList.every((i) => i.visible === false);
  const setStudiesHidden = (hidden: boolean): void => {
    for (const item of activeIndicatorList) {
      if ((item.visible !== false) === hidden) activeIndicators?.toggleVisible(item.key);
    }
  };

  /** The trading-overlay layer is "hidden" when none of its three kinds is shown. */
  const overlaysHidden = !overlays.prefs.activity && !overlays.prefs.activeOrders && !overlays.prefs.positions;
  const setOverlaysHidden = (hidden: boolean): void =>
    overlays.setPrefs({ ...overlays.prefs, activity: !hidden, activeOrders: !hidden, positions: !hidden });

  const drawingToolbarProps = {
    tool, onTool: setTool,
    magnet, onMagnet: setMagnet,
    magnetMode, onMagnetMode: chooseMagnetMode,
    /*
     * Hide scopes (R2): drawings is the drawing layer; positions is the
     * trading-overlay layer, which the More strip's overlay menu also governs
     * — one preference, two ways in. Indicators have no whole-chart hide yet,
     * so that row is not offered rather than offered inert.
     */
    hideScope: (drawHidden && overlaysHidden && studiesHidden ? "all" : drawHidden ? "drawings"
      : studiesHidden ? "indicators" : overlaysHidden ? "positions" : "none") as "none" | "drawings" | "indicators" | "positions" | "all",
    onHideScope: (scope: "drawings" | "indicators" | "positions" | "all") => {
      if (scope === "drawings") setDrawHidden((v) => !v);
      else if (scope === "indicators") setStudiesHidden(!studiesHidden);
      else if (scope === "positions") setOverlaysHidden(!overlaysHidden);
      else if (scope === "all") {
        const next = !(drawHidden && overlaysHidden && studiesHidden);
        setDrawHidden(next); setOverlaysHidden(next); setStudiesHidden(next);
      }
    },
    /*
     * Remove scopes (R2b-03). Drawings go through the existing confirmation;
     * indicators clear the focused pane's study list through its own api,
     * behind the same confirmation, so "Remove N indicators" is exactly as
     * reversible as the Indicators panel's own remove (it is not undoable —
     * the confirmation says so).
     */
    indicatorCount: activeIndicatorList.length,
    onRemove: (scope: "drawings" | "indicators" | "all") => {
      const drawingCount = replayActive ? replayDrawings.length : activeDrawings.length;
      const studyCount = activeIndicatorList.length;
      const parts = [
        scope !== "indicators" ? `${drawingCount} drawing${drawingCount === 1 ? "" : "s"}` : null,
        scope !== "drawings" ? `${studyCount} indicator${studyCount === 1 ? "" : "s"}` : null,
      ].filter((p): p is string => p !== null);
      void ask.confirm({
        title: `Remove ${parts.join(" and ")} on ${displayTicker(symbol)}?`,
        body: scope === "drawings"
          ? "Undo brings drawings back."
          : "Removing indicators cannot be undone; drawings can be brought back with Undo.",
        confirmLabel: "Remove", tone: "danger",
      }).then((ok) => {
        if (!ok) return;
        if (scope !== "indicators") {
          if (replayActive) updateReplayDrawings([]); else drawingStore.set(symbol, []);
        }
        if (scope !== "drawings") activeIndicators?.clear();
      });
    },
    stayInDrawingMode, onStayInDrawingMode: setStayInDrawingMode,
    locked: drawLocked, onLocked: setDrawLocked,
    hidden: drawHidden, onHidden: setDrawHidden,
    onDeleteAll: () => {
      const count = replayActive ? replayDrawings.length : activeDrawings.length;
      void ask.confirm({
        title: `Remove all drawings on ${displayTicker(symbol)}?`,
        body: `${count} drawing${count === 1 ? "" : "s"} on this symbol. Undo brings them back.`,
        confirmLabel: "Remove all", tone: "danger",
      }).then((ok) => {
        if (!ok) return;
        if (replayActive) updateReplayDrawings([]); else drawingStore.set(symbol, []);
      });
    },
    count: replayActive ? replayDrawings.length : activeDrawings.length,
  };


  // The Data window needs the focused pane's cursor even in a one-pane layout.
  // `crosshairForPane` still decides whether sibling panes mirror this signal.
  const publishCrosshair = emitCrosshair;
  const publishRange = paneCount > 1 && rangeSyncActive(sync) ? emitRange : undefined;

  /*
   * ── C11: one range row for the whole layout ──────────────────────────────
   *
   * Every pane at `large` density drew its own 38px `1D 5D 1M …` row and its
   * own clock, so a 2×2 showed four of each. The reference draws ONE row under
   * the whole layout, acting on the focused chart. While more than one pane
   * is on screen this host is that row's place: the focused pane renders its
   * row into it (`CandleChart`'s `rangeRowTarget`) and the others draw none.
   * The host keeps its 38px whichever pane is focused, so moving focus moves
   * no chart. A maximised pane is one chart again and draws its own; phones
   * keep the rule they had, because a compact pane draws no row at all.
   */
  const [rangeRowHost, setRangeRowHost] = useState<HTMLDivElement | null>(null);
  const sharedRangeRow = paneCount > 1 && workspace.maximizedPaneId === null && !isMobile;

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
        magnet={magnetMode}
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
        onDataWindowPlots={isActive && panel === "objects" ? reportDataWindowPlots : undefined}
        onDrawingSelection={noteDrawingSelection}
        onChartContextMenu={openChartMenu}
        priceScale={paneScale(pane.id)}
        onPriceScaleChange={setPaneScale}
        onViewportSettled={setPaneWindow}
        onStudyLayoutChange={setPaneStack}
        resetSignal={paneResets[pane.id] ?? 0}
        goTo={pane.id === workspace.activePaneId ? goTo : null}
        onGoToDate={() => setGoToOpen(true)}
        drawingStyleFocusSignal={paneStyleFocus[pane.id] ?? 0}
        onDrawingSettings={(id) => { noteDrawingSelection(pane.id, id); setDrawingSettingsOpen(true); }}
        onCompareChange={changePaneCompare}
        comparePaneId={comparePaneId}
        onComparePaneId={setComparePaneId}
        // The pane fetches its OWN fired events, scoped to its instrument and
        // timeframe, and places them against its own bars. It needs only the
        // armed alerts from here, to attribute an event to one.
        maAlerts={maAlerts}
        candleOverlay={candleOverlays[pane.id]}
        classicalOverlay={classicalOverlays[pane.id]}
        onBarSelect={replayPickerOpen && isActive ? beginReplay : undefined}
        onAxisAlert={isActive && !replayActive && alertCapability(pane.symbol).supported
          ? pickLevel : undefined}
        replayStrip={isActive ? (
          <ReplayControls
            candles={candles}
            interval={pane.interval}
            bars={pane.bars}
            session={replay}
            pickerOpen={replayPickerOpen}
            onStart={beginReplay}
            onCancel={() => setReplayPickerOpen(false)}
            onPrevious={() => setReplay((current) => current ? stepReplay(current, candles, -1) : null)}
            onNext={() => setReplay((current) => current ? stepReplay(current, candles, 1) : null)}
            onPlaying={setReplayPlaying}
            onSpeed={setReplaySpeed}
            onDeepen={changeBars}
            onRepick={() => setReplayPickerOpen(true)}
            onExit={exitReplay}
            timeZone={paneChartSettings(workspace, pane.id).timeZone}
          />
        ) : null}
        onIndicatorList={registerIndicatorList}
        onFocusIndicator={focusIndicator}
        /* The same destination the chart menu's own `Object tree` row uses. */
        onOpenObjectTree={() => setPanel("objects")}
        onEditNative={setEditingNativeKey}
        onEditPine={editPine}
        onMaAction={maAction}
        onStudyAlert={studyAlert}
        onMaAlert={maAlert}
        compact={isMobile}
        rangeRowTarget={sharedRangeRow ? (isActive ? rangeRowHost : null) : undefined}
      />
    );
  }, [sharedRangeRow, rangeRowHost, comparePaneId, paneDecorations, workspace, paneCount, activatePane, changePaneInterval,
    toggleMaximizePane, closePane, replay, replayDrawings, updateReplayDrawings, cross, range,
    sync, publishCrosshair, publishRange, tool, clearDrawingTool, magnetMode, drawLocked,
    drawHidden, pickingLevel, pickLevel, pineStartTime, pineEndTime, registerIndicatorsApi,
    registerNativeApi, registerNativeChanged, panel, reportDataWindowPlots, noteDrawingSelection, openChartMenu,
    registerIndicatorList, focusIndicator, editPine, maAction, studyAlert, maAlert, isMobile, overlays.select, overlays.setViewport,
    paneScale, setPaneScale, setPaneWindow, setPaneStack, paneResets, goTo, paneStyleFocus, changePaneCompare,
    maAlerts, candleOverlays, classicalOverlays, resolutions, replayPickerOpen, beginReplay,
    replayActive, candles, setReplayPlaying, setReplaySpeed, changeBars,
    exitReplay]);

  return (
    <div ref={fullscreen.ref} className="flex min-h-0 flex-1 flex-col bg-bg pb-[52px] md:pb-0 tv-workstation">
      {/*
        One tooltip for the whole workstation. Every chrome control names
        itself with `data-tooltip` and this draws the chip, so the operating
        system never draws one in the middle of the product.
      */}
      <ChromeTooltip />
      {/*
        ── row 1: the account cell and the toolbar, full width ──

        TVP8 owner veto (OV-B / OV-L). The toolbar used to be the first row of
        the CHART COLUMN, boxed between the left rail and the watchlist, so the
        watchlist's own header and the right rail's first cell sat in the same
        38px band as the toolbar and the row ended 350px short of the window.
        The reference's bar spans the window above the rails, the chart and
        the panel, with the account entry as a 52×38 cell at the top of the
        left-rail column — and so does this one now. The rails and the panel
        start below it, on the second row.
      */}
      {/*
        ── TVP8 R1c-13: `min-h`, not `h` ──────────────────────────────────────

        This row was a HARD 38px, and `ChartToolbar` renders two rows: the
        primary bar, and the `More` strip under it when it is open. The strip
        was laid out at y=43 inside a 38px box and painted over by the chart
        canvas below — `elementFromPoint` on every one of its five groups
        returned the CANVAS, and the screenshot with `More` open was pixel
        identical to the one without it except for the pressed chip. A toggle
        that does nothing visible is worse than an absent one.

        A minimum rather than a fixed height: the bar is 38px at rest, exactly
        as measured, and the workspace below moves down by the strip's own
        height only while the strip is open.
      */}
      <div className="relative flex min-h-[38px] shrink-0 items-stretch bg-surface">
        <ProductMenu variant="rail" onOpenShortcuts={() => setShortcutsOpen(true)}
          onOpenBottomPanel={() => setBottomToggle((n) => n + 1)} />
        {/*
          The chart's title is the symbol and timeframe already shown in the
          toolbar, so a visible heading would repeat it and cost a row of a
          screen this page spends its whole design reclaiming. It is announced
          instead: a screen-reader user navigating by headings otherwise lands
          on a page with no top-level heading at all.
        */}
        <h1 className="sr-only">
          {displayTicker(symbol)} {interval} chart{paneCount > 1 ? ` — ${paneCount}-chart layout` : ""}
        </h1>
        <ChartToolbar
          symbol={symbol}
          interval={interval}
          resolutions={resolutions}
          onOpenSearch={() => setSearchPaneId(active.id)}
          onOpenCompare={() => setComparePaneId(active.id)}
          onInterval={(i) => changePaneInterval(active.id, i)}
          chartType={active.chartType}
          chartSettings={paneChartSettings(workspace, workspace.activePaneId)}
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
          onAddFavoriteIndicator={(id) => { activeNativeStudies?.add(id); }}
          indicatorTemplateStudies={{ indicators: activeIndicatorList, native: activeNativeStudies?.list ?? [] }}
          onApplyIndicatorTemplate={(t) => applyTemplateTo(t, activeIndicators, activeNativeStudies)}
          canUndo={replayActive
            ? drawingStore.replayHistoryState(symbol).canUndo
            : drawingStore.historyState(symbol).canUndo}
          canRedo={replayActive
            ? drawingStore.replayHistoryState(symbol).canRedo
            : drawingStore.historyState(symbol).canRedo}
          onUndo={() => {
            if (replayActive) {
              const restored = drawingStore.undoReplay(symbol);
              if (restored) setReplayDrawings(restored);
            } else {
              drawingStore.undo(symbol);
            }
          }}
          onRedo={() => {
            if (replayActive) {
              const restored = drawingStore.redoReplay(symbol);
              if (restored) setReplayDrawings(restored);
            } else {
              drawingStore.redo(symbol);
            }
          }}
          replayActive={replayActive}
          replayPickerOpen={replayPickerOpen}
          onToggleReplayPicker={toggleReplay}
          replayBlocksLiveActions={replayBlocksLiveActions}
          fullscreen={fullscreen.active}
          fullscreenSupported={fullscreen.supported}
          onToggleFullscreen={fullscreen.toggle}
          onOpenChartSettings={() => setChartSettingsOpen(true)}
          onOpenCommandPalette={() => setPaletteOpen(true)}
          onSnapshot={snapshot}
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
          onOpenAutomation={openAutomation}
          onOpenManual={() => setPanel((p) => p === "manual" ? null : "manual")}
          onOpenStrategy={() => setSettingsOpen(true)}
          onApplyBest={() => void applyBestConfig()}
          loadingBest={loadingBest}
          loadedBars={visibleCandles.length}
          layouts={savedLayouts.layouts}
          layoutRecents={savedLayouts.recents}
          currentLayoutId={savedLayouts.currentId}
          autosave={savedLayouts.autosave}
          layoutDirty={savedLayouts.dirty}
          autosaveError={savedLayouts.autosaveError}
          layoutHandlers={{
            ...savedLayouts.handlers,
            onDownload: () => {
              if (typeof document === "undefined") return;
              const rows = ["time,open,high,low,close,volume", ...visibleCandles.map((c) => [
                new Date(c.openTime).toISOString(), c.open, c.high, c.low, c.close, c.volume,
              ].join(","))];
              const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8" });
              const url = URL.createObjectURL(blob);
              const link = document.createElement("a");
              link.href = url;
              link.download = `${displayTicker(symbol).toLowerCase()}-chart-data.csv`;
              link.click();
              URL.revokeObjectURL(url);
            },
          }}
          moreOpen={moreOpen}
          onMoreOpen={setMoreOpen}
        />
      </div>

      {/*
        ── row 2: the desktop rail, the chart column and the side panel ──

        TVP8 R1b-02: the reference separates its regions with 4px gutters of
        the page background — under the toolbar, right of the rail, either side
        of the watchlist — not with hairlines. The gutter is the `gap` and the
        `pt`; the regions draw no borders of their own on those edges. The
        rails' first cell lands at y=48 (38 + 4 + 6px of rail padding).
      */}
      <div className="flex min-h-0 flex-1 gap-1 bg-bg pt-1">
      {/*
        ── left drawing rail — desktop column; phone uses the Draw sheet ──

        It used to be `hidden md:flex` beside a phone-only modal drawer: a 50%
        black backdrop over the whole viewport, a close cell, and the same
        fifteen cells at 52×44 because of the coarse-pointer minimum. Three
        costs came with that. The rail was MODAL on the surface where drawing
        needs the chart visible underneath it; the cells moved, so the muscle
        memory a rail exists for did not survive the rotation; and the last
        cell fell off the bottom of an 844px screen.

        At phone widths the desktop column is omitted so the chart can use the
        available width; the Draw tab opens the same wired toolbar as a sheet.
      */}
      {!isMobile && (
        <div className="hidden md:flex">
          <DrawingToolbar {...drawingToolbarProps} />
        </div>
      )}

      {toolsOpen && (
        <div
          role="dialog"
          aria-label="Drawing tools"
          className="fixed inset-y-0 left-0 z-40 flex md:hidden"
        >
          <DrawingToolbar {...drawingToolbarProps} />
        </div>
      )}

      {/* ── main column ── */}
      <div data-chart-column className="flex min-w-0 flex-1 flex-col">
        {/*
          TVP8: the raw thrown message WAS this band. Two of the three things
          that set `err` are `(e as Error).message` straight from `lib/api`, so
          a failed "apply best config" printed a status line or a URL-encoded
          route across the top of the chart — which is the exact defect the
          contract names, on the exact surface it names it for.

          The cause is not discarded: it is the `title`, which is where a bug
          report gets it from.
        */}
        {err && (
          <div title={err.detail || undefined}
            className="border-b border-down/30 bg-down/10 px-3 py-1.5 text-xs text-down">
            {err.headline}
          </div>
        )}

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

        {/* accent-is-meaning: the app is waiting for a click and saying so — an
            in-progress primary action, not a selected row. */}
        {pickingLevel && (
          <div className="flex items-center justify-between gap-3 border-b border-accent/40 bg-accent/10 px-3 py-1.5 text-xs text-accent">
            <span>Click the focused chart at the price you want the alert on.</span>
            <button
              onClick={() => {
                setPickingLevel(false);
                // Back to whichever dialog stepped aside: the edit, or a create.
                if (pickReturn) { setEditingAlert(pickReturn); setPickReturn(null); }
                else setPriceAlertOpen(true);
              }}
              className="rounded px-2 py-0.5 hover:bg-accent/20"
            >
              Cancel
            </button>
          </div>
        )}

        {/* the panes */}
        <div className="relative flex min-h-0 flex-1 flex-col">
          <ChartWorkspace workspace={workspace} renderPane={renderPane} />
          {sharedRangeRow && (
            <div ref={setRangeRowHost} data-shared-range-row="" className="flex min-h-[38px] shrink-0 flex-col" />
          )}
          {overlays.selected && <TradingOverlayDetails item={overlays.selected}
            onClose={() => overlays.select(null)} />}
        </div>

        <ChartBottomPanel
          toggleSignal={bottomToggle}
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
        /*
         * TVP8 F-05: the watchlist row's `Add SYMBOL to compare`.
         *
         * The focused pane's OWN compare state — `changePaneCompare` is the
         * same call the legend's `vs …` chip and the compare dialog make — so
         * the row adds a real overlay rather than opening a picker that asks
         * for the symbol the user just right-clicked.
         */
        onAddSymbolCompare={(s) => changePaneCompare(active.id, {
          symbol: displayTicker(s),
          mode: active.compare?.mode ?? "percent",
          length: active.compare?.length ?? DEFAULT_COMPARE_LENGTH,
        })}
        onAddSymbolAlert={(s) => {
          changePaneSymbol(active.id, s);
          if (!alertCapability(s).supported) {
            setToast(alertCapability(s).reason);
          } else {
            setPriceAlertOpen(true);
          }
        }}
        onSymbolsChanged={refreshSymbols}
        replayQuote={activeReplayQuote(candles, replay)}
        objects={objects}
        onOpenAutomation={openAutomation}
        indicators={activeIndicators}
        nativeStudies={activeNativeStudies}
        onEditNative={setEditingNativeKey}
        onEditPine={(key) => editPine(active.id, key)}
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
        onArmMa={(type, length) => !alertCapability(symbol).supported
          ? setToast(alertCapability(symbol).reason)
          : setArmLine({ type, length })}
        onArmPrice={openPriceAlert}
        onArmLevel={(kind) => !alertCapability(symbol).supported
          ? setToast(alertCapability(symbol).reason)
          : setLevelKind(kind)}
        onArmOscillator={(kind) => {
          if (!alertCapability(symbol).supported) { setToast(alertCapability(symbol).reason); return; }
          // The toolbar names a family, not a study: the family's defaults.
          setOscillatorSeed(null);
          setOscillatorKind(kind);
        }}
        onOpenAlert={setEditingAlert}
        onToast={setToast}
        toolsOpen={toolsOpen}
        onToolsOpen={setToolsOpen}
        onMaximizeFocused={() => toggleMaximizePane(workspace.activePaneId)}
      />
      </div>

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
          className="pointer-events-none fixed bottom-16 left-1/2 z-[80] -translate-x-1/2 rounded-md border border-border bg-surface px-4 py-2 text-lg tabular text-ink shadow-xl"
        >
          {shortcuts.intervalBuffer}
          <span className="ml-2 text-xs text-ink-faint">Enter to apply</span>
        </div>
      )}

      <ContextMenu
        at={menu?.at ?? null}
        label={menu?.label ?? "Chart"}
        entries={menu?.entries ?? []}
        width={menu?.width}
        onSelect={onMenuSelect}
        onClose={() => setMenu(null)}
      />

      <NativeStudySettings
        study={editingNativeStudy}
        values={editingNativeValues}
        onClose={() => setEditingNativeKey(null)}
        onParam={(key, param, value) => activeNativeStudies?.setParam(key, param, value)}
        onStyle={(key, plotId, style) => activeNativeStudies?.setStyle(key, plotId, style)}
        onDisplay={(key, patch) => activeNativeStudies?.setDisplay(key, patch)}
        onReset={(key) => activeNativeStudies?.resetParams(key)}
        /* R6b-29: the study dialog's Visibility tab, backed by the pane. */
        onVisibleOn={(key, visibleOn) => activeNativeStudies?.setVisibleOn(key, visibleOn)}
        sourceOptions={(key) => activeNativeStudies?.sourceOptions(key) ?? []}
      />
      {/* The same dialog family, for a Pine study: its gear lands here too. */}
      <PineStudySettings
        study={editingPineStudy}
        onClose={() => setEditingPine(null)}
        onParam={(key, param, value) => editingPine
          && indicatorApis.current.get(editingPine.paneId)?.().setParam(key, param, value)}
        onReset={(key) => editingPine
          && indicatorApis.current.get(editingPine.paneId)?.().resetParams(key)}
      />

      {/*
        TVP8: "Go to…", from the time-axis menu. The reference puts a date
        picker on exactly this menu; the calendar is the same one Replay uses
        to choose its starting bar.
      */}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        handlers={paletteHandlers}
        // What can act right now: the palette does not offer a Replay step
        // with no session, or a drawing command with nothing selected.
        context={{ replayActive, drawingSelected: selectedDrawing !== null }}
      />
      <GoToDateModal
        open={goToOpen}
        onClose={() => setGoToOpen(false)}
        onGo={(time) => {
          setGoTo((current) => ({ time, signal: (current?.signal ?? 0) + 1 }));
          setGoToOpen(false);
        }}
      />
      <ChartSettingsModal
        open={chartSettingsOpen}
        onClose={() => { setChartSettingsOpen(false); setChartSettingsTab(undefined); }}
        initialTab={chartSettingsTab}
        symbol={symbol}
        interval={interval}
        chartType={active.chartType}
        scale={paneScale(workspace.activePaneId)}
        onScale={(next) => setPaneScale(workspace.activePaneId, next)}
        onReset={() => {
          setPaneScale(workspace.activePaneId, resetPriceScale());
          setPaneResets((current) => ({
            ...current, [workspace.activePaneId]: (current[workspace.activePaneId] ?? 0) + 1,
          }));
        }}
        settings={paneChartSettings(workspace, workspace.activePaneId)}
        onSettings={(next: ChartSettings) => setWorkspace((ws) => setPaneChartSettings(ws, ws.activePaneId, next))}
        hasBidAsk={settingsQuote !== null}
      />
      <DrawingSettingsModal
        open={drawingSettingsOpen && selectedDrawing !== null}
        drawing={selectedDrawing}
        interval={interval}
        onClose={() => setDrawingSettingsOpen(false)}
        onChange={(next) => {
          if (!selectedDrawing) return;
          writeDrawings(currentDrawings.map((item) => item.id === next.id ? next : item), "settings");
        }}
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
        searchSeed={searchSeed}
        onCloseSearch={() => { setSearchPaneId(null); setSearchSeed(undefined); }}
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
        oscillatorSeed={oscillatorSeed}
        onCloseOscillator={() => setOscillatorKind(null)}
        editingAlert={editingAlert}
        onCloseEditingAlert={() => { setEditingAlert(null); setEditingAlertLevel(null); }}
        editingAlertLevel={editingAlertLevel}
        onPickFromChartForEdit={() => {
          setPickReturn(editingAlert);
          setEditingAlert(null);
          setEditingAlertLevel(null);
          setPickingLevel(true);
        }}
        armLine={armLine}
        onCloseArmLine={() => setArmLine(null)}
        alertOpen={alertOpen}
        onCloseAlert={() => setAlertOpen(false)}
        onAutomationCreated={(name) => {
          setToast(`Automation live — ${name} on ${displayTicker(symbol)} ${interval}, sending real orders`);
          setPanel("alerts");
        }}
        onAlertSaved={(message) => { setToast(message); void refreshMaAlerts(); }}
        toast={toast}
        onDismissToast={() => setToast(null)}
      />
    </div>
  );
}
