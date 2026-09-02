"use client";
import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { CandleChart, INTERVAL_MS, type ChartMarker, type ChartPriceLine } from "@/components/CandleChart";
import { PineEditor } from "@/components/tv/PineEditor";
import { IndicatorsPanel } from "@/components/tv/IndicatorsPanel";
import type { PaneAction } from "@/components/tv/IndicatorPane";
import { SplitPane } from "@/components/tv/SplitPane";
import { useIndicators } from "@/lib/useIndicators";
import type { AppliedIndicator } from "@/lib/indicators";
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
import { AlertEditor } from "@/components/tv/AlertEditor";
import { PushSetup } from "@/components/tv/PushSetup";
import { Separator } from "@/components/ui";
import { useIsMobile } from "@/lib/useIsMobile";
import { SyncMenu } from "@/components/tv/SyncMenu";
import { DEFAULT_SYNC, loadSync, saveSync, type SyncOptions } from "@/lib/paneSync";
import { SymbolSearch } from "@/components/tv/SymbolSearch";
import { ChartTypeMenu } from "@/components/tv/ChartTypeMenu";
import { loadChartType, saveChartType, type ChartType } from "@/lib/chartType";
import { DrawingToolbar } from "@/components/tv/DrawingToolbar";
import { ManualTradingPanel } from "@/components/tv/ManualTradingPanel";
import { ReplayControls } from "@/components/tv/ReplayControls";
import { TradingOverlayDetails, TradingOverlayMenu } from "@/components/tv/TradingOverlays";
import * as drawStore from "@/lib/drawings";
import type { Drawing, DrawingTool } from "@/lib/drawings";
import { api, type MaAlert, type ManualTradingState, type OptimizerBest, type PineScript } from "@/lib/api";
import { CancellableRequest, isAbortError, LatestRequest } from "@/lib/requestGuard";
import {
  buildMaOverlays, currentMaValues, defaultMaLines, type MaLine, type MaType,
} from "@/lib/movingAverages";
import { defaultParamsFor } from "@/lib/paramSchema";
import * as layoutStore from "@/lib/layouts";
import type { Layout, WorkspaceState } from "@/lib/layouts";
import type { Candle, Interval, OpenTrade, Strategy, StrategyParams, SymbolInfo, Trade } from "@/lib/types";
import { fmtPrice } from "@/lib/format";
import { parseScannerChartTarget } from "@/lib/spotScene";
import {
  activeReplayQuote, drawingsAtReplayHorizon, liveActionsDisabled, reconcileReplay,
  replayCandles, replayDelayMs, replayTick, startReplay, stepReplay,
  type ReplaySession, type ReplaySpeed,
} from "@/lib/replay";
import {
  anchorTradingOverlays, compactOverlaySource, DEFAULT_OVERLAY_PREFERENCES, loadOverlayPreferences,
  mergeOverlayResponses, overlayChartContextKey, overlayItemVisible, overlayRequestKey, requestedOverlayRange,
  saveOverlayPreferences, splitOverlayResponse, TradingOverlayCache,
  type TradingOverlayPreferences, type TradingOverlayResponse,
} from "@/lib/tradingOverlays";

const INTERVALS: Interval[] = ["1m", "5m", "15m", "1h", "4h", "1d"];
const HISTORY_OPTIONS = [
  { label: "2K", bars: 2000 },
  { label: "10K", bars: 10000 },
  { label: "50K", bars: 50000 },
  { label: "All", bars: 200000 },
];

type Panel = "watchlist" | "alerts" | "indicators" | "ma" | "manual" | null;

/** Standard auto-backtest window: 2025-11-01 → today (handoff §7). */
const BACKTEST_START = "2025-11-01";
const todayISO = (): string => new Date().toISOString().slice(0, 10);
const endOfTodayISO = (): string => `${todayISO()}T23:59:59.999Z`;

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
  const [replay, setReplay] = useState<ReplaySession | null>(null);
  const [replayPickerOpen, setReplayPickerOpen] = useState(false);
  const [replayDrawings, setReplayDrawings] = useState<Drawing[]>([]);
  const replayActive = replay !== null;
  const replayBlocksLiveActions = liveActionsDisabled(replay);
  const visibleCandles = useMemo(() => replayCandles(candles, replay), [candles, replay]);
  const replayLast = visibleCandles[visibleCandles.length - 1];
  const replayFirst = visibleCandles[0];
  const pineStartTime = replayActive && replayFirst
    ? new Date(replayFirst.openTime).toISOString()
    : `${BACKTEST_START}T00:00:00.000Z`;
  const pineEndTime = replay
    ? new Date(replay.horizonCloseTime).toISOString()
    : endOfTodayISO();
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
  const [manualState, setManualState] = useState<ManualTradingState | null>(null);
  // Read-only state hydration draws existing server-authoritative levels. It
  // never submits, retries, or mutates an order on page load/reconnect.
  useEffect(() => {
    if (replayActive) return;
    let active = true;
    const refreshManual = async () => {
      try { const next = await api.manualState(symbol); if (active) setManualState(next); }
      catch { /* feature is normally disabled; the ticket shows the actionable error */ }
    };
    void refreshManual();
    const timer = window.setInterval(() => void refreshManual(), 30_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [symbol, replayActive]);

  // ── authoritative read-only trading overlays ──
  const [overlayPrefs, setOverlayPrefsState] = useState<TradingOverlayPreferences>(DEFAULT_OVERLAY_PREFERENCES);
  const [overlayMenuOpen, setOverlayMenuOpen] = useState(false);
  const [overlayViewport, setOverlayViewport] = useState<{ from: number; to: number } | null>(null);
  const [settledOverlayRange, setSettledOverlayRange] = useState<{ from: number; to: number } | null>(null);
  const [settledOverlayContext, setSettledOverlayContext] = useState<string | null>(null);
  const [historicalOverlays, setHistoricalOverlays] = useState<TradingOverlayResponse | null>(null);
  const [currentOverlays, setCurrentOverlays] = useState<TradingOverlayResponse | null>(null);
  const [overlaysLoading, setOverlaysLoading] = useState(false);
  const [overlayError, setOverlayError] = useState<string | null>(null);
  const [selectedOverlayId, setSelectedOverlayId] = useState<string | null>(null);
  const overlayCache = useRef(new TradingOverlayCache());
  const overlayHistorySeq = useRef(new LatestRequest());
  const overlayHistoryFlight = useRef(new CancellableRequest());
  const overlayCurrentSeq = useRef(new LatestRequest());
  const overlayCurrentFlight = useRef(new CancellableRequest());
  const overlayContext = overlayChartContextKey(symbol, interval, replay?.horizonCloseTime ?? null);
  const overlayContextRef = useRef(overlayContext);
  overlayContextRef.current = overlayContext;

  const setOverlayPrefs = useCallback((next: TradingOverlayPreferences) => {
    setOverlayPrefsState(next); saveOverlayPreferences(next);
  }, []);
  useEffect(() => { setOverlayPrefsState(loadOverlayPreferences()); }, []);

  const wantedOverlayRange = useMemo(() => requestedOverlayRange(
    visibleCandles, overlayViewport, INTERVAL_MS[interval], replay?.horizonCloseTime ?? null
  ), [visibleCandles, overlayViewport, interval, replay?.horizonCloseTime]);

  // Visible-range callbacks fire continuously during drag/zoom. Fetch only
  // after the range has settled, and skip an unchanged bounded range.
  useEffect(() => {
    if (!wantedOverlayRange) { setSettledOverlayRange(null); return; }
    const context = overlayContext;
    const timer = window.setTimeout(() => {
      setSettledOverlayContext(context);
      setSettledOverlayRange((current) =>
        current?.from === wantedOverlayRange.from && current.to === wantedOverlayRange.to
          ? current : wantedOverlayRange);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [wantedOverlayRange, overlayContext]);

  // A symbol/cutoff context change removes old evidence synchronously and
  // invalidates every response issued for the old chart or later Replay T.
  useEffect(() => {
    setHistoricalOverlays(null); setCurrentOverlays(null); setSelectedOverlayId(null);
    setOverlayError(null);
    setOverlayViewport(null); setSettledOverlayRange(null); setSettledOverlayContext(null);
    overlayHistorySeq.current.invalidate(); overlayHistoryFlight.current.cancel();
    overlayCurrentSeq.current.invalidate(); overlayCurrentFlight.current.cancel();
  }, [symbol, interval, replay?.horizonCloseTime]);

  useEffect(() => {
    if (!settledOverlayRange || settledOverlayContext !== overlayContext) return;
    const requestContext = overlayContext;
    const replayCutoff = replay?.horizonCloseTime ?? null;
    const scope = replayCutoff === null ? "all" : "historical";
    const request = { symbol, ...settledOverlayRange, replayCutoff, scope } as const;
    const key = overlayRequestKey(request);
    const cached = overlayCache.current.get(key);
    if (cached) { setHistoricalOverlays(cached); setOverlaysLoading(false); return; }
    const token = overlayHistorySeq.current.next();
    const signal = overlayHistoryFlight.current.start();
    setOverlaysLoading(true);
    setOverlayError(null);
    void api.tradingOverlays({ symbol, ...settledOverlayRange,
      ...(replayCutoff === null ? {} : { replayCutoff }), limit: 300, scope }, signal)
      .then((response) => {
        const responseCutoff = response.range.replayCutoff ? Date.parse(response.range.replayCutoff) : null;
        if (overlayContextRef.current !== requestContext
          || !overlayHistorySeq.current.isCurrent(token) || response.symbol !== symbol
          || responseCutoff !== replayCutoff) return;
        const { historical, current } = splitOverlayResponse(response);
        overlayCache.current.set(key, historical); setHistoricalOverlays(historical);
        if (replayCutoff === null) setCurrentOverlays(current);
      }).catch((cause) => { if (!isAbortError(cause) && overlayHistorySeq.current.isCurrent(token)) {
        // Keep the chart usable; the disclosure continues to show no evidence.
        setHistoricalOverlays(null); setOverlayError("Trading evidence is unavailable for this range.");
      }}).finally(() => { if (overlayHistorySeq.current.isCurrent(token)) setOverlaysLoading(false); });
  }, [settledOverlayRange, settledOverlayContext, overlayContext, symbol, replay?.horizonCloseTime]);

  // Current state has its own bounded refresh. Historical evidence is cached
  // and never polled; Replay clears this branch before any request is made.
  useEffect(() => {
    if (!settledOverlayRange || settledOverlayContext !== overlayContext || replayActive) {
      if (replayActive) setCurrentOverlays(null);
      return;
    }
    const requestContext = overlayContext;
    const historicalContextReady = historicalOverlays?.symbol === symbol
      && historicalOverlays.range.replayCutoff === null
      && Date.parse(historicalOverlays.range.from) === settledOverlayRange.from
      && Date.parse(historicalOverlays.range.to) === settledOverlayRange.to;
    // The first live read uses scope=all. Wait for that response (or a cached
    // historical range) before deciding whether a separate current read is needed.
    if (!historicalContextReady) return;
    if (overlaysLoading) return;
    let active = true;
    const flight = overlayCurrentFlight.current;
    const sequence = overlayCurrentSeq.current;
    const refresh = async () => {
      const token = sequence.next();
      const signal = flight.start();
      try {
        const response = await api.tradingOverlays({ symbol, ...settledOverlayRange,
          limit: 300, scope: "current" }, signal);
        if (!active || overlayContextRef.current !== requestContext
          || !sequence.isCurrent(token) || response.symbol !== symbol
          || response.range.replayCutoff !== null) return;
        setCurrentOverlays(splitOverlayResponse(response).current);
      } catch (cause) { if (!isAbortError(cause)) { /* retain timestamped last observation */ } }
    };
    const hasCurrentContext = currentOverlays?.symbol === symbol
      && currentOverlays.range.replayCutoff === null;
    if (!hasCurrentContext) void refresh();
    const timer = hasCurrentContext ? window.setInterval(() => void refresh(), 30_000) : null;
    return () => {
      active = false;
      if (timer !== null) window.clearInterval(timer);
      flight.cancel();
      sequence.invalidate();
    };
  }, [settledOverlayRange, settledOverlayContext, overlayContext, symbol, replayActive,
    overlaysLoading, historicalOverlays, currentOverlays]);

  const tradingOverlayData = useMemo(() => {
    const cutoff = replay?.horizonCloseTime ?? null;
    const historical = historicalOverlays?.symbol === symbol
      && (historicalOverlays.range.replayCutoff ? Date.parse(historicalOverlays.range.replayCutoff) : null) === cutoff
      ? historicalOverlays : null;
    const current = !replayActive && currentOverlays?.symbol === symbol
      && currentOverlays.range.replayCutoff === null ? currentOverlays : null;
    return mergeOverlayResponses(historical, current);
  }, [historicalOverlays, currentOverlays, replayActive, replay?.horizonCloseTime, symbol]);
  const visibleTradingOverlays = useMemo(() =>
    (tradingOverlayData?.items ?? []).filter((item) => overlayItemVisible(item, overlayPrefs)),
    [tradingOverlayData, overlayPrefs]);
  const tradingMarkers = useMemo<ChartMarker[]>(() =>
    anchorTradingOverlays(visibleTradingOverlays, visibleCandles).map((item) => {
      const paper = item.environment === "PAPER";
      const realization = item.kind === "REALIZATION_MARKER";
      return { id: item.id, time: item.anchorTime,
        position: item.side === "BUY" && !realization ? "belowBar" : "aboveBar",
        color: paper ? "#f0b90b" : item.source === "MANUAL" ? "#4f8cff"
          : item.side === "SELL" ? "#f6465d" : "#2ebd85",
        shape: realization ? "square" : item.side === "BUY" ? "arrowUp" : "arrowDown",
        text: `${compactOverlaySource(item)} · ${realization ? "REALIZE" : item.side ?? "EVENT"}` };
    }), [visibleTradingOverlays, visibleCandles]);
  const tradingPriceLines = useMemo<ChartPriceLine[]>(() => visibleTradingOverlays
    .filter((item) => item.kind === "ACTIVE_ORDER_LINE" || item.kind === "POSITION_LINE")
    .map((item) => ({ id: item.id, price: item.price,
      color: item.environment === "PAPER" ? "#f0b90b"
        : item.source === "MANUAL" ? "#4f8cff" : item.kind === "ACTIVE_ORDER_LINE"
          ? "#a78bfa" : "#2ebd85",
      title: item.kind === "ACTIVE_ORDER_LINE"
        ? `${compactOverlaySource(item)} ${item.side ?? ""} ACTIVE`
        : `${compactOverlaySource(item)} POSITION`,
      dashed: item.kind === "ACTIVE_ORDER_LINE" })), [visibleTradingOverlays]);
  const selectedOverlay = useMemo(() => visibleTradingOverlays.find((item) =>
    item.id === selectedOverlayId) ?? null, [visibleTradingOverlays, selectedOverlayId]);
  useEffect(() => { if (selectedOverlayId && !selectedOverlay) setSelectedOverlayId(null); },
    [selectedOverlayId, selectedOverlay]);
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

  /**
   * How the price series is drawn. Workspace furniture rather than analysis
   * state, so it lives beside the split/bottom preferences in localStorage
   * instead of the saved layout.
   */
  const [chartType, setChartType] = useState<ChartType>("candles");
  const changeChartType = useCallback((next: ChartType) => {
    setChartType(next);
    saveChartType(next);
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
    /*
     * Default closed on every form factor, not only on phones. The panel opens
     * on an empty placeholder that says "hit Run backtest", and it was taking
     * ~40% of the workspace to say it — on a chart-first product that is the
     * most expensive blank space on the screen. The tab strip stays visible as
     * the handle, and once a user opens it the preference is theirs.
     */
    setBottomCollapsed(storedBottom === null ? true : storedBottom === "1");
    setChartType(loadChartType());
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
  /** Applied instance being edited; null means Add creates a new instance. */
  const [editingIndicatorKey, setEditingIndicatorKey] = useState<string | null>(null);

  // ── applied Pine studies (TradingView "Indicators") ──
  const indicators = useIndicators({
    symbol, timeframe: interval, startTime: pineStartTime, endTime: pineEndTime,
    replay: replayActive,
  });

  // ── moving averages (first-class chart lines, armable one at a time) ──
  const [maLines, setMaLines] = useState<MaLine[]>(defaultMaLines);
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
    setMaLines((prev) => prev.map((l) =>
      l.type === type && l.length === length ? { ...l, visible: !l.visible } : l));
  }, []);

  const toggleAllMa = useCallback((visible: boolean) => {
    setMaLines((prev) => prev.map((l) => ({ ...l, visible })));
  }, []);

  /** Editor apply either replaces one stable instance or creates a new one. */
  const applyPine = useCallback((payload: { name: string; source: string; params: Record<string, number | string | boolean> }) => {
    if (editingIndicatorKey) {
      indicators.updateSource(editingIndicatorKey, payload);
      setEditingIndicatorKey(null);
    } else {
      indicators.add({ scriptId: null, name: payload.name, source: payload.source, params: payload.params });
    }
    setOpenTrade(null);
    setPanel("indicators");
  }, [editingIndicatorKey, indicators]);

  const openInEditor = useCallback((s: PineScript) => {
    setEditingIndicatorKey(null);
    setEditorScript(s);
    setBottomTab("pine");
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
    setBottomTab("pine");
    setBottomCollapsed(false);
  }, []);

  /**
   * Hide / settings / remove, from the controls overlaid on an oscillator pane.
   *
   * The pane id is `indicator:<instance key>` — the same key the applied list
   * is keyed by — so the pane can act on its own instance without the chart
   * having to be told which indicator each pane belongs to.
   */
  const paneAction = useCallback((paneId: string, action: PaneAction) => {
    const key = paneId.replace(/^indicator:/, "");
    if (action === "hide") { indicators.toggleVisible(key); return; }
    if (action === "remove") { indicators.remove(key); return; }
    setIndicatorFocusKey(key);
    setPanel("indicators");
  }, [indicators]);

  useEffect(() => { setDrawings(drawStore.loadDrawings(symbol)); }, [symbol]);
  const updateDrawings = useCallback((next: Drawing[]) => {
    setDrawings(next);
    drawStore.saveDrawings(symbol, next);
  }, [symbol]);
  const updateReplayDrawings = useCallback((next: Drawing[]) => setReplayDrawings(next), []);
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

  // Scanner navigation is a read-only workspace prefill. It selects the exact
  // existing Platform Spot symbol and, for Trade, opens the normal manual ticket.
  // It never chooses a side/size or submits an order.
  useEffect(() => {
    const target = parseScannerChartTarget(window.location.search);
    if (!target) return;
    setSymbol(target.symbol);
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
    const isDeepLink = parseApplyLink(window.location.search) !== null ||
      parseScannerChartTarget(window.location.search) !== null;
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
      setReplay((current) => current ? reconcileReplay(current, data) : null);
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

  const changeSymbol = (s: string) => {
    if (replayActive) {
      setReplay((current) => current ? { ...current, playing: false } : null);
      setReplayDrawings([]);
      setCandles([]);
    }
    setSymbol(s); setTrades([]);
  };
  const changeInterval = (i: Interval) => {
    if (replayActive) {
      setReplay((current) => current ? { ...current, playing: false } : null);
      setCandles([]);
    }
    setInterval(i); setTrades([]);
  };
  const last = replayLast;

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

  const replayIndicatorLoading = indicators.list.some((indicator) => indicator.loading);
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
  const alertPriceLines = useMemo<ChartPriceLine[]>(
    () => maAlerts
      .filter((a) => a.conditionKind === "price" && a.targetPrice !== null &&
                     a.timeframe === interval && isAlertActive(a))
      .map((a) => ({
        price: a.targetPrice!,
        color: alertColor(a),
        // Text, not an emoji: this is drawn into the price scale by the chart
        // canvas, where a platform emoji renders at its own size and colour and
        // cannot inherit the line's.
        title: `Alert · ${describeAlert(a).replace("price ", "")}`,
        dashed: true,
      })),
    [maAlerts, interval]
  );

  /** Server-authoritative manual entry and bot-managed TP/SL levels. */
  const manualPriceLines = useMemo<ChartPriceLine[]>(() => {
    const lines: ChartPriceLine[] = [];
    for (const position of manualState?.positions.filter((p) => p.pair === symbol && p.status === "active") ?? []) {
      const tag = position.id.slice(0, 4);
      // Entry is rendered by the normalized explicit ManualPosition overlay;
      // these remain the separate Bot-managed protection levels.
      if (position.manualTpPrice != null) lines.push({ price: position.manualTpPrice, color: "#2ebd85", title: `MANUAL TP · BOT · ${tag}`, dashed: true });
      if (position.manualSlPrice != null) lines.push({ price: position.manualSlPrice, color: "#f6465d", title: `MANUAL SL · BOT · ${tag}`, dashed: true });
    }
    return lines;
  }, [manualState, symbol]);

  const allPriceLines = useMemo(
    () => replayActive ? tradingPriceLines : [...priceLines, ...alertPriceLines, ...manualPriceLines, ...tradingPriceLines],
    [replayActive, priceLines, alertPriceLines, manualPriceLines, tradingPriceLines]
  );

  /** MA lines drawn beneath any Pine overlays, so scripts stay on top. */
  const maOverlays = useMemo(() => buildMaOverlays(visibleCandles, maLines), [visibleCandles, maLines]);
  const maValues = useMemo(() => currentMaValues(visibleCandles, maLines), [visibleCandles, maLines]);
  const chartOverlays = useMemo(
    () => [...maOverlays, ...indicators.overlays],
    [maOverlays, indicators.overlays]
  );

  const liveBarBoundary = useCallback((closed: Candle | null, current: Candle) => {
    setCandles((existing) => {
      const next = [...existing];
      for (const bar of [closed, current]) {
        if (!bar) continue;
        const index = next.findIndex((candidate) => candidate.openTime === bar.openTime);
        if (index >= 0) next[index] = bar;
        else if (next.length === 0 || bar.openTime > next[next.length - 1]!.openTime) next.push(bar);
      }
      return next.length > bars ? next.slice(-bars) : next;
    });
    // Custom Pine stays bar-close truthful without re-running 10k bars on
    // every one-second kline tick.
    indicators.rerunAll();
  }, [bars, indicators]);

  /** One definition, rendered twice: as the desktop column and the phone drawer. */
  const drawingToolbarProps = {
    tool, onTool: setTool,
    magnet, onMagnet: setMagnet,
    locked: drawLocked, onLocked: setDrawLocked,
    hidden: drawHidden, onHidden: setDrawHidden,
    onDeleteAll: () => {
      if (window.confirm("Remove all drawings on this symbol?")) {
        if (replayActive) updateReplayDrawings([]); else updateDrawings([]);
      }
    },
    count: replayActive ? replayDrawings.length : drawings.length,
  };

  /** Phone drawers are mutually exclusive — two overlays at once hides the chart. */
  const togglePanel = (p: Panel) => {
    setToolsOpen(false);
    setPanel((cur) => (cur === p ? null : p));
  };

  /**
   * Every secondary toolbar control, at one height.
   *
   * They were a mixture of `py-1` and `py-1.5` with three different text
   * sizes, so the row's baseline stepped up and down across it — the single
   * most visible difference between this toolbar and a professional one.
   */
  const toolBtn = "flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[13px] " +
    "text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink " +
    "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink-muted";

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
        <div className="flex flex-nowrap items-center gap-1.5 border-b border-border bg-surface px-2 py-1 sm:flex-wrap sm:overflow-x-visible sm:px-2.5">
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
            aria-label={`Change symbol — currently ${symbol}`}
            className="flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-surface-2 px-2.5 text-sm font-semibold text-ink transition-colors hover:bg-border"
          >
            {symbol}
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" className="text-ink-faint">
              <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" />
            </svg>
          </button>
          <Separator className="hidden sm:inline-block" />
          {/* The interval strip is the only thing allowed to overflow, so the
              ☰ and ⋯ buttons stay pinned at the edges of a narrow screen. */}
          <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto sm:flex-none sm:overflow-visible">
            {INTERVALS.map((i) => (
              <button key={i} onClick={() => changeInterval(i)}
                aria-pressed={interval === i}
                className={`flex h-7 shrink-0 items-center rounded px-2 text-[13px] transition-colors ${
                  interval === i
                    ? "bg-surface-2 font-semibold text-ink"
                    : "text-ink-muted hover:bg-surface-2/60 hover:text-ink"
                }`}>
                {i}
              </button>
            ))}
          </div>
          <Separator className="hidden sm:inline-block" />
          <ChartTypeMenu value={chartType} onChange={changeChartType} />
          <button
            onClick={() => setReplayPickerOpen((open) => replayActive ? open : !open)}
            aria-pressed={replayActive || replayPickerOpen}
            title={replayActive ? "Replay is active" : "Start Bar Replay from a historical point"}
            className={`${toolBtn} ${replayActive || replayPickerOpen ? "bg-accent/15 text-accent" : ""}`}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <path d="M8 5v14l11-7z" /><path d="M4 5v14" />
            </svg>
            Replay
          </button>
          <TradingOverlayMenu open={overlayMenuOpen} onOpen={setOverlayMenuOpen}
            value={overlayPrefs} onChange={setOverlayPrefs}
            data={tradingOverlayData} loading={overlaysLoading} error={overlayError}
            items={visibleTradingOverlays} onSelect={setSelectedOverlayId} />
          {/* Secondary controls: always inline on desktop, behind ⋯ on phones. */}
          {/*
            Secondary controls: inline on a wide screen, behind ⋯ below it.
            The threshold used to be 768px, which meant a 1024px laptop with
            the watchlist open laid these out across THREE wrapped rows —
            nearly a third of the viewport spent on chrome before the first
            candle. They cannot be put in a horizontal scroller instead: the
            layout and sync menus open downwards out of it, and a scroll
            container would clip them. So below `xl` they collapse behind the
            same ⋯ toggle the phone layout already uses.
          */}
          <div className={`${moreOpen ? "flex" : "hidden"} order-last w-full flex-wrap items-center gap-1.5 border-t border-border pt-1.5 xl:order-none xl:flex xl:w-auto xl:border-0 xl:pt-0`}>
          <Separator className="hidden xl:inline-block" />
          <div className="flex items-center gap-0.5">
            {HISTORY_OPTIONS.map((h) => (
              <button key={h.label} onClick={() => setBars(h.bars)}
                title={`Show up to ${h.bars.toLocaleString()} bars`}
                aria-pressed={bars === h.bars}
                className={`flex h-7 items-center rounded px-2 text-xs transition-colors ${
                  bars === h.bars
                    ? "bg-surface-2 text-ink"
                    : "text-ink-muted hover:bg-surface-2/60 hover:text-ink"
                }`}>
                {h.label}
              </button>
            ))}
          </div>
          <Separator />
          <button onClick={() => setPanel((p) => (p === "indicators" ? null : "indicators"))}
            title="Pine indicators on this chart"
            className={toolBtn}>
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
            aria-pressed={splitOpen}
            className={`${toolBtn} ${splitOpen ? "bg-surface-2 text-accent" : ""}`}>
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
          <button onClick={openPriceAlert} disabled={replayBlocksLiveActions}
            title={replayActive ? "Exit Replay to create live alerts" : "Notify me when price reaches a level"}
            className={toolBtn}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 01-3.46 0" />
            </svg>
            Alert
          </button>
          <button onClick={() => setAlertOpen(true)} disabled={replayBlocksLiveActions}
            title={replayActive ? "Exit Replay to invoke Bot automation" : "Run this strategy server-side and send live orders to your bot"}
            className={toolBtn}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M13 2L4 14h7l-1 8 9-12h-7z" />
            </svg>
            Automate
          </button>
          <button onClick={() => setPanel((p) => p === "manual" ? null : "manual")}
            disabled={replayBlocksLiveActions}
            title={replayActive ? "Exit Replay to trade" : "Manual Binance Spot order ticket"}
            className={toolBtn}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M4 7h16M7 12h10M9 17h6" /><path d="M17 4l3 3-3 3M7 14l-3 3 3 3" />
            </svg>
            Trade
          </button>
          <button onClick={() => setSettingsOpen(true)}
            className={toolBtn}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M3 12h4l2-7 4 14 2-7h6" />
            </svg>
            Strategy
          </button>
          <button onClick={applyBestConfig} disabled={loadingBest || replayActive}
            title={replayActive ? "Exit Replay to apply a full-range optimizer result" : `Apply the local optimizer's best saved config for ${symbol}`}
            className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-warn/30 bg-warn/10 px-2 text-[13px] font-medium text-warn transition-colors hover:bg-warn/20 disabled:cursor-wait disabled:opacity-60">
            <svg width="12" height="12" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
              <path d="M7 1l1.8 3.9 4.2.5-3.1 2.9.8 4.2L7 10.5 3.3 12.5l.8-4.2L1 5.4l4.2-.5L7 1Z" />
            </svg>
            {loadingBest ? "Loading…" : "Best"}
          </button>
          <div className="flex shrink-0 items-center gap-3 xl:ml-auto">
            <span className="tabular whitespace-nowrap text-xs text-ink-muted">
              {last && <>{replayActive ? "Replay" : "Last"} <span className="text-ink">{fmtPrice(last.close)}</span></>}
              <span className="ml-3 text-ink-faint">
                {visibleCandles.length.toLocaleString()} bars{loading ? " · loading…" : ""}
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

          {/* Overflow toggle for the secondary controls, below `xl`. */}
          <button
            onClick={() => setMoreOpen((v) => !v)}
            aria-label={moreOpen ? "Fewer controls" : "More controls"}
            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md xl:hidden ${
              moreOpen ? "bg-surface-2 text-accent" : "text-ink-muted hover:bg-surface-2 hover:text-ink"
            }`}
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
              <circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" />
            </svg>
          </button>
        </div>

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

        {/* charts — one pane, or two side by side sharing the symbol */}
        <div className="flex min-h-0 flex-1">
          <div className="relative flex min-w-0 flex-1 flex-col">
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
            <CandleChart symbol={symbol} interval={interval} candles={visibleCandles}
              trades={indicators.trades ?? (replayActive ? [] : trades)}
              overlays={chartOverlays}
              decorations={indicators.decorations}
              barColors={indicators.barColors}
              markers={[...indicators.markers, ...tradingMarkers]}
              pineDrawings={indicators.drawings}
              priceLines={allPriceLines} live={!replayActive} fill compact={isMobile}
              chartType={chartType}
              onLiveBarBoundary={replayActive ? undefined : liveBarBoundary}
              onPriceSelect={pickingLevel ? pickLevel : undefined}
              onAnnotationSelect={setSelectedOverlayId}
              onVisibleRangeChange={setOverlayViewport}
              drawingTool={tool}
              onDrawingToolDone={() => setTool("cursor")}
              drawings={drawingsAtReplayHorizon(replay, drawings, replayDrawings)}
              onDrawingsChange={replayActive ? updateReplayDrawings : updateDrawings}
              magnet={magnet}
              drawingsLocked={drawLocked}
              drawingsHidden={drawHidden}
              onIndicatorPaneAction={paneAction}
            />
            {selectedOverlay && <TradingOverlayDetails item={selectedOverlay}
              onClose={() => setSelectedOverlayId(null)} />}
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
              startTime={pineStartTime}
              endTime={pineEndTime}
              replayHorizonCloseTime={replay?.horizonCloseTime ?? null}
              replayAvailableThroughCloseTime={replay?.availableThroughCloseTime ?? null}
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
          {bottomCollapsed ? null : bottomTab === "tester" && replayActive ? (
            <div className="flex h-[180px] items-center justify-center px-6 text-center text-sm text-ink-muted">
              Strategy Tester is unavailable during Bar Replay. Exit Replay to run a full-range strategy test.
            </div>
          ) : bottomTab === "tester" ? (
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
                startTime={pineStartTime}
                endTime={pineEndTime}
                appliedCount={indicators.list.length}
                openScript={editorScript}
                openParams={editingIndicatorKey
                  ? indicators.list.find((item) => item.key === editingIndicatorKey)?.params
                  : undefined}
                onOpenScriptConsumed={() => setEditorScript(null)}
                onApplyToChart={applyPine}
                editingApplied={editingIndicatorKey !== null}
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
              <Watchlist symbols={symbols} selected={symbol} onSelect={changeSymbol}
                onSymbolsChanged={refreshSymbols} replayQuote={activeReplayQuote(candles, replay)} />
            )}
            {panel === "alerts" && !replayActive && <AlertsPanel onCreateAlert={() => setAlertOpen(true)} />}
            {panel === "indicators" && (
              <IndicatorsPanel
                indicators={indicators}
                onOpenInEditor={openInEditor}
                onEditIndicator={editIndicator}
                focusKey={indicatorFocusKey}
              />
            )}
            {panel === "manual" && !replayActive && <ManualTradingPanel symbol={symbol}
              lastPrice={last?.close ?? null}
              onClose={() => setPanel(null)}
              onStateChange={setManualState} />}
            {panel === "ma" && (
              <aside className="flex h-full w-[85vw] max-w-[300px] shrink-0 flex-col border-l border-border bg-surface md:w-[300px]">
                <MaPanel
                  lines={maLines}
                  values={maValues}
                  alerts={replayActive ? [] : maAlerts}
                  timeframe={interval}
                  onToggle={toggleMa}
                  onToggleAll={toggleAllMa}
                  onArm={(type, length) => setArmLine({ type, length })}
                  onArmPrice={openPriceAlert}
                  onArmLevel={setLevelKind}
                  onArmOscillator={setOscillatorKind}
                  // Clicking an armed alert opens THAT alert, not a fresh
                  // dialog for its family. Re-opening the create dialog was
                  // pre-filled by family only, so a user editing "RSI 14 > 70"
                  // was silently handed a blank RSI 50 > 50 form.
                  onOpenAlert={setEditingAlert}
                  liveActionsDisabled={replayBlocksLiveActions}
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
          onClick={() => setPanel((p) => (p === "manual" ? null : "manual"))}
          disabled={replayBlocksLiveActions}
          className={railBtn(panel === "manual")}
          title={replayBlocksLiveActions ? "Exit Replay to trade" : "Manual Binance Spot trading"}
          aria-label={replayBlocksLiveActions ? "Exit Replay to trade" : "Manual Binance Spot trading"}
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
            <path d="M4 7h16M7 12h10M9 17h6" /><path d="M17 4l3 3-3 3M7 14l-3 3 3 3" />
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
          disabled={replayBlocksLiveActions}
          className={railBtn(panel === "alerts")}
          title={replayBlocksLiveActions ? "Exit Replay to manage live automation" : "Automations — running strategies and their order log"}
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
            disabled={replayBlocksLiveActions && id === "alerts"}
            title={replayBlocksLiveActions && id === "alerts" ? "Exit Replay to manage live automation" : undefined}
            className={`relative flex flex-1 flex-col items-center gap-0.5 py-1.5 text-[10px] ${
              replayBlocksLiveActions && id === "alerts"
                ? "cursor-not-allowed text-ink-faint opacity-40"
                : active ? "text-accent" : "text-ink-muted"
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
      <AlertEditor
        alert={editingAlert}
        onClose={() => setEditingAlert(null)}
        onSaved={(_updated, message) => { setToast(message); void refreshMaAlerts(); }}
        onDeleted={(_deleted, message) => { setToast(message); void refreshMaAlerts(); }}
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
          <button
            onClick={() => setToast(null)}
            aria-label="Dismiss"
            className="flex h-6 w-6 items-center justify-center rounded text-ink-faint hover:bg-surface-2 hover:text-ink"
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
              <path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}
