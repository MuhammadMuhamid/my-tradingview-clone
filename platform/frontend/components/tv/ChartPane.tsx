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
import { CandleChart, type ChartMarker, type ChartPriceLine } from "@/components/CandleChart";
import type { PaneAction } from "@/components/tv/IndicatorPane";
import { useIndicators, type IndicatorsApi } from "@/lib/useIndicators";
import type { AppliedIndicator } from "@/lib/indicators";
import { buildMaOverlays } from "@/lib/movingAverages";
import { drawingStore } from "@/lib/drawingStore";
import type { Drawing, DrawingTool } from "@/lib/drawings";
import { useCandleHistory } from "@/lib/useCandleHistory";
import { paneDensity, type PaneDensity } from "@/lib/layoutPresets";
import type { PaneState } from "@/lib/workspace";
import { drawingsAtReplayHorizon, replayCandles, type ReplaySession } from "@/lib/replay";
import { fmtPrice } from "@/lib/format";
import type { Candle, Interval, Trade } from "@/lib/types";

/** The intervals offered in a pane's own header strip. */
const PANE_INTERVALS: readonly Interval[] = ["1m", "5m", "15m", "1h", "4h", "1d"];

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
  onInterval: (paneId: string, interval: Interval) => void;
  onOpenSymbolSearch: (paneId: string) => void;
  onToggleMaximize: (paneId: string) => void;
  onClose: (paneId: string) => void;

  /** The workspace replay session, or null when replay is off. */
  replay: ReplaySession | null;
  /** In-session replay drawings, which are workspace-wide and not persisted. */
  replayDrawings: Drawing[];
  onReplayDrawingsChange: (next: Drawing[]) => void;

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
  /** The active pane reports its viewport so evidence can be fetched for it. */
  onViewportChange?: (range: { from: number; to: number }) => void;

  /** Pine run window, which follows the workspace replay horizon. */
  startTime: string;
  endTime: string;

  /** Registration for the workspace's Indicators panel and Pine editor. */
  onIndicatorsApi: (paneId: string, get: (() => IndicatorsApi) | null) => void;
  onIndicatorList: (paneId: string, list: AppliedIndicator[]) => void;
  /** The pane opens the workspace Indicators panel on one instance. */
  onFocusIndicator: (paneId: string, key: string) => void;

  /** Force the smallest chrome regardless of measured size (phones). */
  compact?: boolean;
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

  // ── candles, through the shared cache ──
  const history = useCandleHistory({
    symbol: pane.symbol, interval: pane.interval, bars: pane.bars,
  });
  const visibleCandles = useMemo(
    () => replayCandles(history.candles, replay), [history.candles, replay]);
  const last = visibleCandles[visibleCandles.length - 1];

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

  // ── drawings, shared with every other pane on this instrument ──
  const [drawings, setDrawings] = useState<Drawing[]>(() => drawingStore.get(pane.symbol));
  useEffect(() => drawingStore.subscribe(pane.symbol, setDrawings), [pane.symbol]);
  const updateDrawings = useCallback((next: Drawing[]) => {
    drawingStore.set(pane.symbol, next);
  }, [pane.symbol]);

  const maOverlays = useMemo(
    () => buildMaOverlays(visibleCandles, pane.maLines), [visibleCandles, pane.maLines]);
  const overlays = useMemo(
    () => [...maOverlays, ...indicators.overlays], [maOverlays, indicators.overlays]);

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
  const emitRange = useMemo(() => {
    if (!onVisibleRangeChange && !onViewportChange) return undefined;
    return (range: { from: number; to: number }) => {
      onVisibleRangeChange?.(paneId, range);
      onViewportChange?.(range);
    };
  }, [onVisibleRangeChange, onViewportChange, paneId]);

  const replayActive = replay !== null;
  const showIntervals = density === "large" || density === "medium";
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
      className={`relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-sm border bg-surface transition-colors ${
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
      <div className="flex flex-nowrap items-center gap-1.5 border-b border-border px-1.5 py-0.5">
        <button
          onClick={() => props.onOpenSymbolSearch(pane.id)}
          title={`Change this pane's symbol — currently ${pane.symbol}`}
          aria-label={`Change symbol for the ${pane.symbol} pane`}
          className="flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-xs font-semibold text-ink hover:bg-surface-2"
        >
          {pane.symbol}
        </button>
        {showIntervals ? (
          <div className="flex items-center gap-0.5">
            {PANE_INTERVALS.map((i) => (
              <button
                key={i}
                onClick={() => props.onInterval(pane.id, i)}
                aria-pressed={pane.interval === i}
                className={`rounded px-1.5 py-0.5 text-[11px] transition-colors ${
                  pane.interval === i
                    ? "bg-surface-2 font-semibold text-ink"
                    : "text-ink-muted hover:text-ink"
                }`}
              >
                {i}
              </button>
            ))}
          </div>
        ) : (
          // Below the size where a whole strip fits, the timeframe is still
          // stated — it is half of what identifies what you are looking at.
          <span className="shrink-0 rounded bg-surface-2 px-1 text-[11px] font-semibold text-ink">
            {pane.interval}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1.5 tabular text-[11px] text-ink-muted">
          {showReadout && last && <span className="text-ink">{fmtPrice(last.close)}</span>}
          {density === "large" && (
            <span className="text-ink-faint">
              {history.loading ? "loading…" : `${visibleCandles.length.toLocaleString()} bars`}
            </span>
          )}
          {props.canMaximize && (
            <button
              onClick={() => props.onToggleMaximize(pane.id)}
              title={props.maximized ? "Restore the layout" : "Maximize this pane"}
              aria-label={props.maximized ? "Restore the layout" : "Maximize this pane"}
              aria-pressed={props.maximized}
              className="flex h-5 w-5 items-center justify-center rounded text-ink-faint hover:bg-surface-2 hover:text-ink"
            >
              <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor"
                strokeWidth="1.4" aria-hidden="true">
                {props.maximized
                  ? <path d="M4.5 1.5v3h-3M7.5 10.5v-3h3" />
                  : <path d="M1.5 4.5v-3h3M10.5 7.5v3h-3" />}
              </svg>
            </button>
          )}
          {props.canClose && (
            <button
              onClick={() => props.onClose(pane.id)}
              title="Close this pane"
              aria-label={`Close the ${pane.symbol} pane`}
              className="flex h-5 w-5 items-center justify-center rounded text-ink-faint hover:bg-surface-2 hover:text-ink"
            >
              <svg width="9" height="9" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                <path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" strokeWidth="1.5" />
              </svg>
            </button>
          )}
        </span>
      </div>

      {history.error && (
        <div className="border-b border-down/30 bg-down/10 px-2 py-1 text-[11px] text-down">
          {history.error}
        </div>
      )}

      <div className="min-h-0 flex-1">
        {history.loading && history.candles.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-ink-faint">
            Loading {pane.symbol} {pane.interval}…
          </div>
        ) : (
          <CandleChart
            symbol={pane.symbol}
            interval={pane.interval}
            candles={visibleCandles}
            chartType={pane.chartType}
            trades={indicators.trades ?? (replayActive ? [] : props.strategyTrades)}
            overlays={overlays}
            decorations={indicators.decorations}
            barColors={indicators.barColors}
            markers={markers}
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
            magnet={props.magnet}
            drawingsLocked={props.drawingsLocked}
            drawingsHidden={props.drawingsHidden}
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
