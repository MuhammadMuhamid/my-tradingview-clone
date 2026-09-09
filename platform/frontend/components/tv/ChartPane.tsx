"use client";
/**
 * One chart, with everything a chart in this product can do.
 *
 * ── The point of this file ─────────────────────────────────────────────────
 *
 * There used to be two kinds of chart. The main one, wired inline into the
 * page, had drawings, its own applied studies, a presentation type, replay
 * clipping, trading overlays and click-to-place-a-level. The "split pane" had
 * a symbol it could not change, no drawings at all, no presentation type, and
 * studies that were re-runs of the *other* chart's list under a `mirror_` key
 * prefix. A second chart was a lesser object.
 *
 * There is one kind now. Whatever a pane can do, every pane can do, because
 * every pane is this component. The workspace decides where panes go and which
 * one is focused; it does not decide which of them is the real one.
 *
 * ── What a pane owns and what it is told ───────────────────────────────────
 *
 * Owns: its candles (through the shared history cache), its applied studies
 * (its own storage scope), its moving-average overlays, its drawing layer's
 * connection to the per-symbol store, and its own size-derived density.
 *
 * Told: which pane is active, what the replay horizon is, what the sync
 * settings resolved to for it, and which workspace decorations apply to its
 * instrument. It reports events upwards tagged with its own id; it never
 * reaches for another pane.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { resolutionMs, type Resolution } from "@/lib/resolution";
import { CandleChart, type ChartMarker, type ChartPriceLine } from "@/components/CandleChart";
import type { PaneAction } from "@/components/tv/IndicatorPane";
import { useIndicators, type IndicatorsApi } from "@/lib/useIndicators";
import { useNativeStudies, type NativeStudiesApi } from "@/lib/useNativeStudies";
import type { Viewport } from "@/lib/native/compute";
import type { PriceScaleState } from "@/lib/priceScale";
import type { AppliedIndicator } from "@/lib/indicators";
import { buildMaOverlays } from "@/lib/movingAverages";
import { drawingStore } from "@/lib/drawingStore";
import type { Drawing, DrawingTool } from "@/lib/drawings";
import { useCandleHistory } from "@/lib/useCandleHistory";
import { datasetKey } from "@/lib/liveDataset";
import { paneDensity, type PaneDensity } from "@/lib/layoutPresets";
import type { PaneState } from "@/lib/workspace";
import { drawingsAtReplayHorizon, replayCandles, type ReplaySession } from "@/lib/replay";
import { anchoredVwapOverlays } from "@/lib/anchoredVwap";
import { fixedRangeDecorations, fixedRangeOverlays } from "@/lib/volumeProfileDrawing";
import { compareOverlays, useCompareSeries } from "@/lib/compare";
import { alertEventMarkers, placeAlertEvents } from "@/lib/alertMarkers";
import { useAlertEvents } from "@/lib/useAlertEvents";
import { overlayNotice, patternMarkers, placePatterns } from "@/lib/candleOverlay";
import { usePatternAnalysis, type CandleOverlayState } from "@/lib/useCandleOverlay";
import { PatternOverlayControls } from "@/components/tv/PatternOverlayControls";
import {
  classicalMarkers, classicalNotice, classicalOverlays,
} from "@/lib/classicalPatterns";
import {
  useClassicalAnalysis, type ClassicalOverlayState,
} from "@/lib/useClassicalPatterns";
import { ClassicalPatternControls } from "@/components/tv/ClassicalPatternControls";
import type { MaAlert } from "@/lib/api";

/** Stable empty list, so a pane with no fired alerts does not re-render. */
const NO_FIRED: ChartMarker[] = [];
import { PaneLegend } from "@/components/tv/PaneLegend";
import type { ResolutionPreferences } from "@/components/tv/TimeframePicker";
import type { PaneCompare } from "@/lib/workspace";
import { pricePrecision } from "@/lib/movingAverages";
import { type Candle, type Trade } from "@/lib/types";
import { useVolumeProfileRefinement } from "@/lib/useVolumeProfileRefinement";

export interface ChartPaneProps {
  pane: PaneState;
  active: boolean;
  /** True when this pane is currently maximised. */
  maximized: boolean;
  /** False in a one-pane workspace, where maximise would mean nothing. */
  canMaximize: boolean;
  /** Whether the pane may be closed — false when it is the only one. */
  canClose: boolean;

  onActivate: (paneId: string) => void;
  onInterval: (paneId: string, interval: Resolution) => void;
  onOpenSymbolSearch: (paneId: string) => void;
  onToggleMaximize: (paneId: string) => void;
  onClose: (paneId: string) => void;

  /** The workspace replay session, or null when replay is off. */
  replay: ReplaySession | null;
  /** In-session replay drawings, which are workspace-wide and not persisted. */
  replayDrawings: Drawing[];
  /** `gesture` collapses a drag into one undo step, as on the live chart. */
  onReplayDrawingsChange: (next: Drawing[], gesture?: string | null) => void;

  // ── synchronisation, already resolved for this pane ──
  crosshairTime: number | null;
  visibleRange: { from: number; to: number } | null;
  followEdgeTime: number | null;
  onCrosshairMove?: (paneId: string, time: number | null) => void;
  onVisibleRangeChange?: (paneId: string, range: { from: number; to: number }) => void;

  // ── drawing tools, which are workspace-wide controls ──
  drawingTool: DrawingTool;
  onDrawingToolDone: () => void;
  magnet: boolean;
  drawingsLocked: boolean;
  drawingsHidden: boolean;

  // ── decorations the workspace has already scoped to this pane's symbol ──
  markers: ChartMarker[];
  priceLines: ChartPriceLine[];
  strategyTrades: Trade[];
  onAnnotationSelect?: (id: string) => void;
  /** Set only while the workspace is waiting for a price to be clicked. */
  onPriceSelect?: (price: number) => void;
  /** This pane's drawing selection changed. */
  onDrawingSelection?: (paneId: string, id: string | null) => void;
  /** A right-click landed on this pane's plot. */
  onChartContextMenu?: (
    paneId: string,
    event: {
      x: number; y: number; drawingId: string | null; price: number | null;
      /** Which strip was clicked: the plot, or the price axis. */
      region: "plot" | "axis";
    }
  ) => void;
  /** The active pane reports its viewport so evidence can be fetched for it. */
  onViewportChange?: (range: { from: number; to: number }) => void;

  /**
   * The price scale, owned by the workspace.
   *
   * Controlled rather than internal because the chart's own context menu both
   * reports it ("Auto ✓") and changes it, and the menu is built one level up.
   */
  priceScale?: PriceScaleState;
  onPriceScaleChange?: (paneId: string, next: PriceScaleState) => void;
  /** Bumped by the workspace to refit this pane. */
  resetSignal?: number;
  /** Bumped to move focus into the selected drawing's style bar. */
  drawingStyleFocusSignal?: number;
  /** This pane's comparison changed. Never synced to other panes. */
  onCompareChange?: (paneId: string, next: PaneCompare | null) => void;

  /**
   * The alerts armed on this account, so a fired event can be attributed.
   *
   * The EVENTS are fetched by the pane itself, scoped to its own instrument
   * and timeframe — see `useAlertEvents` for why that scope has to be in SQL
   * rather than applied here. Placement also happens here, because it needs
   * this pane's own loaded window: an event outside it would be clamped onto
   * an edge bar and claim something happened there.
   */
  maAlerts?: readonly MaAlert[];

  /** This pane's candlestick-pattern study instance, off by default. */
  candleOverlay?: CandleOverlayState;
  /** This pane's causal classical-pattern study instance, off by default. */
  classicalOverlay?: ClassicalOverlayState;

  /** Pine run window, which follows the workspace replay horizon. */
  startTime: string;
  endTime: string;

  /** Registration for the workspace's Indicators panel and Pine editor. */
  onIndicatorsApi: (paneId: string, get: (() => IndicatorsApi) | null) => void;
  /** The same, for this pane's built-in studies. */
  onNativeStudiesApi?: (paneId: string, get: (() => NativeStudiesApi) | null) => void;
  /**
   * This pane's built-in list changed.
   *
   * The list lives inside the API object, whose identity does not change when
   * its contents do, so the workspace needs to be told rather than being able
   * to observe it — otherwise the Indicators dialog would show a stale count.
   */
  onNativeStudiesChanged?: (paneId: string) => void;
  onIndicatorList: (paneId: string, list: AppliedIndicator[]) => void;
  /** The pane opens the workspace Indicators panel on one instance. */
  onFocusIndicator: (paneId: string, key: string) => void;

  /** Force the smallest chrome regardless of measured size (phones). */
  compact?: boolean;

  /**
   * The browser's favourite / recent / custom resolutions.
   *
   * Passed down rather than read here so every pane's legend picker and the
   * toolbar's picker share one set of lists — starring `45m` on a pane puts it
   * on the toolbar strip immediately, which is what makes them one control
   * rather than two that look alike.
   */
  resolutions: ResolutionPreferences;
}

function ChartPaneImpl(props: ChartPaneProps) {
  const { pane, active, replay } = props;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<{ width: number; height: number }>(
    { width: 900, height: 520 });

  // Density is measured, not inferred from the preset: a dominant pane in an
  // asymmetric layout is large even though the layout has four panes in it.
  useEffect(() => {
    const node = rootRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (!box) return;
      setSize((current) =>
        Math.abs(current.width - box.width) < 4 && Math.abs(current.height - box.height) < 4
          ? current
          : { width: box.width, height: box.height });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const density: PaneDensity = props.compact
    ? "small" : paneDensity(size.width, size.height);

  /*
   * Where the user is looking, in bars — position as well as size.
   *
   * Built-in studies compute their declared warmup plus the visible window, so
   * this must be the REAL viewport rather than a guess. SIZE alone is not
   * enough: a pan changes where the user is looking without changing how much
   * they can see, so a window derived from size alone stays anchored to the
   * newest bar and every study goes blank a swipe or two back into a pane's own
   * ten thousand loaded bars.
   *
   * It starts generous and unanchored — `null` means "the newest bars" — and is
   * corrected on the first range report, so the first paint is never short.
   */
  const [viewport, setViewport] = useState<Viewport | null>(null);
  /*
   * The same fact at full resolution, for the one kind of study whose answer
   * IS the range.
   *
   * `viewport` above is deliberately coarse. A visible-range volume profile
   * rounded to the nearest two hundred bars would profile bars that are not on
   * screen and miss ones that are, which is precisely the claim it makes. This
   * is snapped to the bar grid instead — so it changes exactly when the set of
   * visible bars changes, and not once per scroll frame.
   */
  const [visibleRange, setVisibleRange] =
    useState<{ fromMs: number; toMs: number } | null>(null);

  // ── candles, through the shared cache ──
  const history = useCandleHistory({
    symbol: pane.symbol, interval: pane.interval, bars: pane.bars,
  });
  const visibleCandles = useMemo(
    () => replayCandles(history.candles, replay), [history.candles, replay]);
  /*
   * While an uncached window loads, the previous window stays on screen and
   * `history.dataset` says so. The readouts below must not present its last
   * price under the new symbol's name, and the chart is told which bars it
   * is actually holding so the live tick path cannot cross the boundary.
   */
  const holdingRequested =
    datasetKey(history.dataset) === datasetKey({ symbol: pane.symbol, interval: pane.interval });
  const last = holdingRequested ? visibleCandles[visibleCandles.length - 1] : undefined;

  /*
   * ── this pane's own BUILT-IN studies ──
   *
   * Computed in the browser from the bars above, by the canonical maths the
   * server alerts on. They update on the forming candle because they cost a
   * few hundred bars of arithmetic rather than a network round trip — see
   * `lib/native/compute` for the two bounds that make that true.
   */
  const nativeStudies = useNativeStudies({
    candles: visibleCandles, interval: pane.interval, scope: pane.id,
    viewport: viewport ?? undefined,
    visibleRange: visibleRange ?? undefined,
  });

  // ── this pane's own applied studies ──
  const indicators = useIndicators({
    symbol: pane.symbol, timeframe: pane.interval,
    startTime: props.startTime, endTime: props.endTime,
    replay: replay !== null,
    scope: pane.id,
  });

  // The workspace panel acts on the focused pane's studies. A getter is
  // registered rather than the API object itself: the object is rebuilt on
  // every render, and registering it would re-run this effect every render.
  const indicatorsRef = useRef(indicators);
  indicatorsRef.current = indicators;
  const { onIndicatorsApi, onIndicatorList } = props;
  const paneId = pane.id;
  useEffect(() => {
    const get = (): IndicatorsApi => indicatorsRef.current;
    onIndicatorsApi(paneId, get);
    return () => onIndicatorsApi(paneId, null);
  }, [paneId, onIndicatorsApi]);
  useEffect(() => {
    onIndicatorList(paneId, indicators.list);
  }, [paneId, onIndicatorList, indicators.list]);

  const nativeRef = useRef(nativeStudies);
  nativeRef.current = nativeStudies;
  const { onNativeStudiesApi, onNativeStudiesChanged } = props;
  useEffect(() => {
    if (!onNativeStudiesApi) return;
    onNativeStudiesApi(paneId, () => nativeRef.current);
    return () => onNativeStudiesApi(paneId, null);
  }, [paneId, onNativeStudiesApi]);
  useEffect(() => {
    onNativeStudiesChanged?.(paneId);
  }, [paneId, onNativeStudiesChanged, nativeStudies.list]);

  // ── drawings, shared with every other pane on this instrument ──
  const [drawings, setDrawings] = useState<Drawing[]>(() => drawingStore.get(pane.symbol));
  useEffect(() => drawingStore.subscribe(pane.symbol, setDrawings), [pane.symbol]);
  const updateDrawings = useCallback((next: Drawing[], gesture?: string | null) => {
    drawingStore.set(pane.symbol, next, gesture ?? null);
  }, [pane.symbol]);

  const maOverlays = useMemo(
    () => buildMaOverlays(visibleCandles, pane.maLines), [visibleCandles, pane.maLines]);
  /*
   * One chart, two engines, one series map.
   *
   * Built-in studies and Pine studies produce the identical `ChartOverlay`
   * shape, so the renderer has no branch that asks which engine drew a line.
   * Built-ins are laid down first so a Pine script applied afterwards paints
   * over them, which matches the order they appear in the panel.
   */
  /*
   * Anchored VWAP is a DRAWING that produces an overlay.
   *
   * Which means it is computed here, from the same replay-clipped bars the
   * chart is drawing, and rendered by the same renderer as every other series
   * — on the price scale, in the legend, at the right precision — rather than
   * painted by hand onto the drawing canvas. And because it accumulates over
   * exactly the bars it is given, it cannot see a bar a Replay has not reached:
   * that bar is not in the array.
   */
  const avwapOverlays = useMemo(
    () => anchoredVwapOverlays(
      drawingsAtReplayHorizon(replay, drawings, props.replayDrawings),
      visibleCandles,
      pricePrecision(visibleCandles[visibleCandles.length - 1]?.close ?? 0)),
    [replay, drawings, props.replayDrawings, visibleCandles]);

  /*
   * The second instrument, loaded once for this pane.
   *
   * One boundary rather than one per comparison: a normalized overlay, a
   * rolling correlation and a beta all need the same aligned second series,
   * and three studies each loading their own would open three requests for the
   * same bars. It is HISTORY on the base chart's own cadence, not a second
   * live feed — which is what keeps a websocket-per-study explosion from
   * happening.
   */
  const compare = pane.compare ?? null;
  const compareSeries = useCompareSeries(
    visibleCandles, compare?.symbol ?? "", pane.interval, pane.bars,
    { enabled: compare !== null });

  const compared = useMemo(
    () => (compare
      ? compareOverlays(
        visibleCandles, compareSeries, compare.mode, compare.length, pane.symbol)
      : { overlays: [], notice: null }),
    [compare, compareSeries, visibleCandles, pane.symbol]);

  /*
   * Fixed Range Volume Profile is a DRAWING that produces a profile.
   *
   * Same shape as Anchored VWAP above and for the same reason: its defining
   * input is a span of the chart, so it lives in the drawing store, and it is
   * computed here from the replay-clipped bars the chart is actually drawing.
   * The histogram is a decoration; its point of control and value-area edges
   * are overlays, so they land on the price scale and in the legend rather
   * than being painted by hand.
   */
  const fixedProfileDrawings = useMemo(
    () => drawingsAtReplayHorizon(replay, drawings, props.replayDrawings),
    [replay, drawings, props.replayDrawings]);
  const fixedProfileRange = useMemo(() => {
    const first = visibleCandles[0];
    const last = visibleCandles[visibleCandles.length - 1];
    if (!first || !last) return null;
    let fromMs = Number.POSITIVE_INFINITY;
    let toMs = Number.NEGATIVE_INFINITY;
    for (const drawing of fixedProfileDrawings) {
      if (drawing.tool !== "vprange" || drawing.hidden) continue;
      const a = drawing.points[0]?.time;
      const b = drawing.points[1]?.time ?? a;
      if (a === undefined || b === undefined) continue;
      fromMs = Math.min(fromMs, a * 1000, b * 1000);
      toMs = Math.max(toMs, a * 1000, b * 1000);
    }
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return null;
    const clippedFrom = Math.max(first.openTime, fromMs);
    const clippedTo = Math.min(
      last.closeTime,
      toMs + resolutionMs(pane.interval) - 1,
    );
    return clippedFrom <= clippedTo ? { fromMs: clippedFrom, toMs: clippedTo } : null;
  }, [fixedProfileDrawings, visibleCandles, pane.interval]);
  const fixedProfileRefinement = useVolumeProfileRefinement({
    enabled: fixedProfileRange !== null,
    symbol: pane.symbol,
    chartInterval: pane.interval,
    fromMs: fixedProfileRange?.fromMs ?? null,
    toMs: fixedProfileRange?.toMs ?? null,
  });
  const fixedRefinementInput = useMemo(
    () => fixedProfileRefinement.candles.length > 0 && fixedProfileRefinement.plan
      ? {
          candles: fixedProfileRefinement.candles,
          interval: fixedProfileRefinement.plan.sourceInterval,
        }
      : undefined,
    [fixedProfileRefinement.candles, fixedProfileRefinement.plan],
  );
  const fixedProfileDecorations = useMemo(
    () => fixedRangeDecorations(
      fixedProfileDrawings, visibleCandles, pane.interval, fixedRefinementInput),
    [fixedProfileDrawings, visibleCandles, pane.interval, fixedRefinementInput]);
  const fixedProfileOverlays = useMemo(
    () => fixedRangeOverlays(
      fixedProfileDrawings, visibleCandles, pane.interval,
      pricePrecision(visibleCandles[visibleCandles.length - 1]?.close ?? 0),
      fixedRefinementInput),
    [fixedProfileDrawings, visibleCandles, pane.interval, fixedRefinementInput]);

  const baseOverlays = useMemo(
    () => [
      ...maOverlays, ...avwapOverlays, ...fixedProfileOverlays, ...compared.overlays,
      ...nativeStudies.overlays, ...indicators.overlays,
    ],
    [maOverlays, avwapOverlays, fixedProfileOverlays, compared.overlays,
      nativeStudies.overlays, indicators.overlays]);
  const decorations = useMemo(
    () => [
      ...fixedProfileDecorations, ...nativeStudies.decorations, ...indicators.decorations,
    ],
    [fixedProfileDecorations, nativeStudies.decorations, indicators.decorations]);

  const markers = useMemo(
    () => [...indicators.markers, ...props.markers], [indicators.markers, props.markers]);

  const liveBarBoundary = useCallback((closed: Candle | null, current: Candle) => {
    history.mergeLiveBars(closed, current);
    // Custom Pine stays bar-close truthful without re-running 10k bars on
    // every one-second kline tick.
    indicators.rerunAll();
    // `history` and `indicators` are rebuilt each render; the two members used
    // here are stable callbacks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history.mergeLiveBars, indicators.rerunAll]);

  const paneAction = useCallback((subPaneId: string, action: PaneAction) => {
    const key = subPaneId.replace(/^indicator:/, "");
    if (action === "hide") { indicatorsRef.current.toggleVisible(key); return; }
    if (action === "remove") { indicatorsRef.current.remove(key); return; }
    props.onFocusIndicator(paneId, key);
    // `props.onFocusIndicator` is stable in the workspace.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId, props.onFocusIndicator]);

  const { onCrosshairMove, onVisibleRangeChange, onViewportChange } = props;
  const emitCrosshair = useMemo(
    () => (onCrosshairMove ? (time: number | null) => onCrosshairMove(paneId, time) : undefined),
    [onCrosshairMove, paneId]);
  const barsRef = useRef(visibleCandles);
  barsRef.current = visibleCandles;
  const emitRange = useMemo(() => {
    const step = resolutionMs(pane.interval) / 1000;
    return (range: { from: number; to: number }) => {
      const span = Math.ceil((range.to - range.from) / step);
      if (Number.isFinite(span) && span > 0) {
        /*
         * Both halves are rounded to a coarse step so an ordinary pan does not
         * invalidate every study's memoised result on every frame — a drag
         * emits a range per frame, and a per-bar key would recompute
         * everything sixty times a second.
         */
        const visibleBars = Math.max(200, Math.ceil(span / 200) * 200);
        const bars = barsRef.current;
        const fromMs = range.from * 1000;
        let first = bars.length - visibleBars;
        for (let i = 0; i < bars.length; i++) {
          if (bars[i]!.openTime >= fromMs) { first = i; break; }
        }
        const anchored = Math.max(0, Math.floor(first / 200) * 200);
        setViewport((current) => (
          current && current.visibleBars === visibleBars
            && current.firstVisibleIndex === anchored
            ? current : { visibleBars, firstVisibleIndex: anchored }));
      }
      /*
       * Snapped to the bar grid, so an identical set of visible bars produces
       * an identical range and nothing downstream recomputes. The chart's own
       * range is a continuous time, and a drag emits a slightly different one
       * sixty times a second.
       */
      const grid = resolutionMs(pane.interval);
      const fromMs = Math.floor((range.from * 1000) / grid) * grid;
      const toMs = Math.floor((range.to * 1000) / grid) * grid;
      if (Number.isFinite(fromMs) && Number.isFinite(toMs)) {
        setVisibleRange((current) => (
          current && current.fromMs === fromMs && current.toMs === toMs
            ? current : { fromMs, toMs }));
      }
      onVisibleRangeChange?.(paneId, range);
      onViewportChange?.(range);
    };
  }, [onVisibleRangeChange, onViewportChange, paneId, pane.interval]);

  const replayActive = replay !== null;

  const patternAnalysis = usePatternAnalysis({
    enabled: !replayActive && props.candleOverlay?.enabled === true && holdingRequested,
    symbol: pane.symbol, timeframe: pane.interval, candles: visibleCandles,
    direction: props.candleOverlay?.direction ?? "both",
  });
  const selectedPatternIds = useMemo(() => {
    const ids = props.candleOverlay?.selectedIds;
    return ids === null || ids === undefined ? null : new Set(ids);
  }, [props.candleOverlay?.selectedIds]);
  const classicalAnalysis = useClassicalAnalysis({
    enabled: !replayActive && props.classicalOverlay?.enabled === true && holdingRequested,
    symbol: pane.symbol, timeframe: pane.interval, candles: visibleCandles,
    includeDeveloping: props.classicalOverlay?.includeDeveloping ?? false,
    status: props.classicalOverlay?.status ?? "all",
  });
  const selectedClassicalIds = useMemo(() => {
    const ids = props.classicalOverlay?.selectedIds;
    return ids === null || ids === undefined ? null : new Set(ids);
  }, [props.classicalOverlay?.selectedIds]);
  const classicalDrawingOverlays = useMemo(() => {
    if (replayActive || !props.classicalOverlay?.enabled) return [];
    return classicalOverlays(
      classicalAnalysis.analysis, visibleCandles, selectedClassicalIds,
      props.classicalOverlay.showTargets,
    );
  }, [replayActive, props.classicalOverlay?.enabled, props.classicalOverlay?.showTargets,
    classicalAnalysis.analysis, visibleCandles, selectedClassicalIds]);
  const overlays = useMemo(
    () => [...baseOverlays, ...classicalDrawingOverlays],
    [baseOverlays, classicalDrawingOverlays]);

  /*
   * Fired-alert marks.
   *
   * Only what the runner recorded. Nothing is derived by re-evaluating a
   * condition against history — that produces marks where an alert WOULD have
   * fired, which is a different and much weaker claim than "this fired", and
   * it puts fabricated history on a chart read to decide what happened.
   *
   * Off during a Replay: a Replay is a reconstruction, and marking a live
   * delivery on a simulated bar would say the two are the same kind of thing.
   */
  const alertEvents = useAlertEvents(pane.symbol, pane.interval, !replayActive);
  const firedMarkers = useMemo(() => {
    if (replayActive || !props.maAlerts) return NO_FIRED;
    return alertEventMarkers(placeAlertEvents(
      alertEvents, props.maAlerts, pane.symbol, pane.interval, visibleCandles));
  }, [replayActive, alertEvents, props.maAlerts, pane.symbol, pane.interval, visibleCandles]);

  /*
   * Candlestick patterns — the Screener's, not a second opinion.
   *
   * This pane contains no pattern logic at all. There must be exactly one
   * implementation of "is this a hammer" and it already exists in the
   * Screener; a port here would agree on the day it was written and drift
   * after, and the failure mode is the worst kind — the Screener says a bar is
   * a Bullish Engulfing, the chart does not mark it, and the user has to
   * decide which of their own tools to believe.
   */
  const patternMarks = useMemo(() => {
    if (replayActive || !props.candleOverlay?.enabled) return NO_FIRED;
    return patternMarkers(placePatterns(patternAnalysis.analysis, visibleCandles, selectedPatternIds));
  }, [replayActive, props.candleOverlay?.enabled, patternAnalysis.analysis,
    visibleCandles, selectedPatternIds]);
  const classicalPatternMarks = useMemo(() => {
    if (replayActive || !props.classicalOverlay?.enabled) return NO_FIRED;
    return classicalMarkers(classicalAnalysis.analysis, selectedClassicalIds);
  }, [replayActive, props.classicalOverlay?.enabled, classicalAnalysis.analysis,
    selectedClassicalIds]);

  /*
   * Everything drawn ON a bar, in one list.
   *
   * A Pine study's own markers, whatever the workspace scoped to this pane,
   * then the two annotations this pane computes for itself. Built from
   * `markers` rather than from `props.markers`, because dropping the Pine
   * half here would silently un-draw every marker a script plots.
   */
  const paneMarkers = useMemo(
    () => (firedMarkers.length > 0 || patternMarks.length > 0 || classicalPatternMarks.length > 0
      ? [...markers, ...firedMarkers, ...patternMarks, ...classicalPatternMarks]
      : markers),
    [markers, firedMarkers, patternMarks, classicalPatternMarks]);

  /*
   * A legend shows less as the pane gets smaller, and stops entirely at tiny.
   *
   * `showIdentityDetail` is the old `showIntervals` under an honest name: it no
   * longer gates a strip of six buttons, because there is no strip — it gates
   * the price and the loading note, which are the parts of the legend a
   * hundred-pixel-tall pane in a 4×4 has no room for. The symbol and the
   * timeframe are never dropped: they are what a pane IS.
   */
  const showIdentityDetail = density === "large" || density === "medium";
  const showReadout = density !== "tiny";

  return (
    <div
      ref={rootRef}
      data-pane-id={pane.id}
      data-active={active ? "true" : "false"}
      onFocusCapture={() => props.onActivate(pane.id)}
      onPointerDownCapture={() => props.onActivate(pane.id)}
      /*
        `flex-1` is load-bearing, not decoration.

        The workspace hands every pane a grid cell that is itself a flex row
        (`ChartWorkspace`). A flex item defaults to `flex: 0 1 auto`, so without
        this the pane took its width from its CONTENT — a ~128px sliver of
        unreadable candles at the far left of a 1044px cell, identical at 1024,
        1440, 1920 and 2560, and identical again at 2, 4, 8 and 16 panes. The
        collapse also hid every control that only renders once the pane is wide
        enough: the synthetic-transform banner, the range shortcuts, the scale
        controls, the UTC clock and the history-depth readout.

        No automated test caught it because none of them measure rendered
        width. `tests/chartWorkspace.test.ts` now asserts this pairing so the
        class cannot be dropped again.
      */
      className={`group/pane relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-sm border bg-surface transition-colors ${
        active ? "border-accent/70" : "border-border"
      }`}
    >
      {/*
        The focused pane is named as well as tinted. A border colour alone is
        exactly the kind of state that disappears for a user who cannot see it,
        and this one decides where an order ticket points.
      */}
      <span className="sr-only">
        {pane.symbol} {pane.interval}{active ? " — focused pane" : ""}
      </span>
      {history.error && (
        <div className="border-b border-down/30 bg-down/10 px-2 py-1 text-[11px] text-down">
          {history.error}
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        {!replayActive && active
          && (props.candleOverlay?.enabled || props.classicalOverlay?.enabled) && (
          <div className="absolute right-2 top-2 z-20 flex max-h-[calc(100%-1rem)]
            max-w-[calc(100%-1rem)] flex-col items-end gap-2 overflow-y-auto">
            {props.candleOverlay?.enabled && (
              <>
                <PatternOverlayControls overlay={props.candleOverlay} result={patternAnalysis}
                  symbol={pane.symbol} timeframe={pane.interval} />
                <span className="sr-only" role="status" aria-live="polite">
                  {overlayNotice(patternAnalysis.analysis, patternAnalysis.loading,
                    patternAnalysis.error, pane.symbol)}
                </span>
              </>
            )}
            {props.classicalOverlay?.enabled && (
              <>
                <ClassicalPatternControls overlay={props.classicalOverlay}
                  result={classicalAnalysis} symbol={pane.symbol} timeframe={pane.interval} />
                <span className="sr-only" role="status" aria-live="polite">
                  {classicalNotice(classicalAnalysis.analysis, classicalAnalysis.loading,
                    classicalAnalysis.error, pane.symbol)}
                </span>
              </>
            )}
          </div>
        )}
        {history.loading && !holdingRequested && history.candles.length > 0 && (
          // The previous instrument's bars are still drawn underneath; say so
          // rather than let them pass for the new one for a few seconds.
          <div
            role="status"
            aria-live="polite"
            className="pointer-events-none absolute left-2 top-2 z-10 rounded border border-border bg-surface/90 px-2 py-0.5 font-mono text-[10px] text-ink-muted sm:text-[11px]"
          >
            Loading {pane.symbol} {pane.interval}… showing {history.dataset.symbol} {history.dataset.interval} until it arrives
          </div>
        )}
        {compared.notice && (
          /*
           * Said out loud, on the chart.
           *
           * The alternative to saying it is forward-filling the second
           * instrument's missing bars, and the alternative to forward-filling
           * is a reader who does not know their correlation was computed over
           * fewer bars than they asked for. Neither is acceptable, so the
           * number is honest and the gap is disclosed.
           */
          <div
            role="status"
            aria-live="polite"
            className="pointer-events-none absolute left-2 top-2 z-10 max-w-[80%] rounded border border-border bg-surface/90 px-2 py-0.5 text-[10px] text-ink-muted sm:text-[11px]"
          >
            {compared.notice}
          </div>
        )}
        {history.loading && history.candles.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-ink-faint">
            Loading {pane.symbol} {pane.interval}…
          </div>
        ) : (
          <CandleChart
            symbol={pane.symbol}
            interval={pane.interval}
            /*
              The pane's identity and its own controls, handed to the chart as a
              slot rather than drawn beside it.

              `CandleChart` stacks its overlays in ONE column at the plot's
              top-left and says in a comment why: a second overlay pinned to the
              same offset gets painted straight through the OHLC readout. This
              legend was that second overlay for one commit, and "SOLUSDT 15m"
              landed on top of "SOLUSDT · 15m O … H … L …". Passing it in puts
              it first in that column, and takes the symbol and the interval out
              of the row below, so they are named once.
            */
            identity={
              <PaneLegend
                paneId={paneId}
                symbol={pane.symbol}
                interval={pane.interval}
                lastClose={showReadout && last ? last.close : null}
                stale={history.stale}
                loading={density === "large" && history.loading}
                bars={visibleCandles.length}
                compare={compare}
                dense={!showIdentityDetail}
                onOpenSymbolSearch={props.onOpenSymbolSearch}
                onInterval={props.onInterval}
                {...(props.onCompareChange ? { onCompareChange: props.onCompareChange } : {})}
                resolutions={props.resolutions}
                canMaximize={props.canMaximize}
                canClose={props.canClose}
                maximized={props.maximized}
                onToggleMaximize={props.onToggleMaximize}
                onClose={props.onClose}
              />
            }
            candles={visibleCandles}
            dataset={history.dataset}
            chartType={pane.chartType}
            trades={indicators.trades ?? (replayActive ? [] : props.strategyTrades)}
            overlays={overlays}
            decorations={decorations}
            barColors={indicators.barColors}
            markers={paneMarkers}
            pineDrawings={indicators.drawings}
            priceLines={props.priceLines}
            live={!replayActive}
            fill
            compact={density !== "large"}
            onLiveBarBoundary={replayActive ? undefined : liveBarBoundary}
            onPriceSelect={props.onPriceSelect}
            onAnnotationSelect={props.onAnnotationSelect}
            onCrosshairMove={emitCrosshair}
            crosshairTime={props.crosshairTime}
            onVisibleRangeChange={emitRange}
            visibleRange={props.visibleRange}
            followEdgeTime={props.followEdgeTime}
            drawingTool={props.drawingTool}
            onDrawingToolDone={props.onDrawingToolDone}
            drawings={drawingsAtReplayHorizon(replay, drawings, props.replayDrawings)}
            onDrawingsChange={replayActive ? props.onReplayDrawingsChange : updateDrawings}
            onDrawingSelection={
              props.onDrawingSelection
                ? (id) => props.onDrawingSelection?.(paneId, id) : undefined}
            onChartContextMenu={
              props.onChartContextMenu
                ? (event) => props.onChartContextMenu?.(paneId, event) : undefined}
            magnet={props.magnet}
            drawingsLocked={props.drawingsLocked}
            drawingsHidden={props.drawingsHidden}
            priceScale={props.priceScale}
            onPriceScaleChange={
              props.onPriceScaleChange
                ? (next) => props.onPriceScaleChange?.(paneId, next) : undefined}
            resetSignal={props.resetSignal}
            drawingStyleFocusSignal={props.drawingStyleFocusSignal}
            paneActive={props.active}
            onIndicatorPaneAction={paneAction}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Memoised, because a workspace of sixteen panes re-renders on every mirrored
 * crosshair move. `lib/paneSync` returns `null` to the pane that produced the
 * signal, so the originating pane's props are unchanged and it skips the
 * render entirely — only the panes that must actually redraw do.
 */
export const ChartPane = memo(ChartPaneImpl);
