"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CandleChart, INTERVAL_MS } from "@/components/CandleChart";
import { api } from "@/lib/api";
import type { AppliedIndicator } from "@/lib/indicators";
import { useMirroredIndicators } from "@/lib/useMirroredIndicators";
import { buildMaOverlays, type MaLine } from "@/lib/movingAverages";
import type { Candle, Interval } from "@/lib/types";
import { fmtPrice } from "@/lib/format";
import { replayCandles, type ReplaySession } from "@/lib/replay";

const INTERVALS: Interval[] = ["1m", "5m", "15m", "1h", "4h", "1d"];

/**
 * The second chart in a split layout: same symbol, its own timeframe.
 *
 * It loads its own candles rather than resampling pane 1's, so the bars are
 * the exchange's real ones for that resolution — a resample would disagree
 * with the indicators, which the backend computes from the same source.
 */
export function SplitPane({
  symbol, timeframe, onTimeframe, bars, indicators, maLines, startTime, endTime, onClose,
  onCrosshairMove, crosshairTime, onVisibleRangeChange, visibleRange, followEdgeTime,
  replayHorizonCloseTime, replayAvailableThroughCloseTime,
}: {
  symbol: string;
  timeframe: Interval;
  onTimeframe: (i: Interval) => void;
  bars: number;
  /** the chart's applied studies, re-run here at this pane's timeframe */
  indicators: AppliedIndicator[];
  /**
   * The moving averages pane 1 draws. Recomputed here from THIS pane's own
   * candles — a 200 EMA of 1h bars is a different line from a 200 EMA of 15m
   * bars, so copying pane 1's values across would draw a lie.
   */
  maLines: MaLine[];
  startTime: string;
  endTime: string;
  replayHorizonCloseTime?: number | null;
  replayAvailableThroughCloseTime?: number | null;
  onClose: () => void;
  onCrosshairMove?: (time: number | null) => void;
  crosshairTime?: number | null;
  onVisibleRangeChange?: (range: { from: number; to: number }) => void;
  visibleRange?: { from: number; to: number } | null;
  followEdgeTime?: number | null;
}) {
  const [candles, setCandles] = useState<Candle[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [liveRevision, setLiveRevision] = useState(0);
  const replaySession = useMemo<ReplaySession | null>(() =>
    replayHorizonCloseTime == null || replayAvailableThroughCloseTime == null ? null : {
      horizonCloseTime: replayHorizonCloseTime,
      availableThroughCloseTime: replayAvailableThroughCloseTime,
      playing: false, speed: 1,
    }, [replayHorizonCloseTime, replayAvailableThroughCloseTime]);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      let data = await api.candles(symbol, timeframe, bars);
      if (data.length < Math.min(bars, 500) * 0.98) {
        const lookbackMs = Math.ceil(bars * 1.1) * INTERVAL_MS[timeframe];
        await api.backfill(
          symbol, timeframe,
          new Date(Date.now() - lookbackMs).toISOString(), new Date().toISOString()
        );
        data = await api.candles(symbol, timeframe, bars);
      }
      setCandles(data);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [symbol, timeframe, bars]);

  useEffect(() => { void load(); }, [load]);

  const mirrored = useMirroredIndicators(
    indicators, { symbol, timeframe, startTime, endTime }, indicators.length > 0,
    liveRevision
  );

  const visibleCandles = useMemo(() => replayCandles(candles, replaySession), [candles, replaySession]);
  const maOverlays = useMemo(() => buildMaOverlays(visibleCandles, maLines), [visibleCandles, maLines]);
  /** MAs beneath the Pine studies, matching pane 1's draw order. */
  const overlays = useMemo(
    () => [...maOverlays, ...mirrored.overlays],
    [maOverlays, mirrored.overlays]
  );

  const last = visibleCandles[visibleCandles.length - 1];

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
    setLiveRevision((value) => value + 1);
  }, [bars]);

  return (
    <div className="flex min-w-0 flex-1 flex-col border-l border-border">
      <div className="flex flex-nowrap items-center gap-2 overflow-x-auto border-b border-border bg-surface px-2 py-1">
        <span className="text-xs font-semibold text-ink">{symbol}</span>
        <span className="text-ink-faint">·</span>
        <div className="flex items-center gap-0.5">
          {INTERVALS.map((i) => (
            <button
              key={i}
              onClick={() => onTimeframe(i)}
              className={`rounded px-1.5 py-0.5 text-[12px] transition-colors ${
                timeframe === i ? "bg-surface-2 font-semibold text-ink" : "text-ink-muted hover:text-ink"
              }`}
            >
              {i}
            </button>
          ))}
        </div>
        <span className="ml-auto flex items-center gap-2 tabular text-[11px] text-ink-muted">
          {last && <span className="text-ink">{fmtPrice(last.close)}</span>}
          <span className="text-ink-faint">
            {loading ? "loading…" : `${visibleCandles.length.toLocaleString()} bars`}
            {mirrored.loading ? " · indicators…" : ""}
          </span>
          <button
            onClick={onClose}
            title="Close this pane"
            aria-label="Close the second chart pane"
            className="flex h-5 w-5 items-center justify-center rounded text-ink-faint hover:bg-surface-2 hover:text-ink"
          >
            <svg width="9" height="9" viewBox="0 0 10 10" fill="none" aria-hidden="true">
              <path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </button>
        </span>
      </div>

      {err && <div className="border-b border-down/30 bg-down/10 px-2 py-1 text-[11px] text-down">{err}</div>}

      <div className="min-h-0 flex-1">
        {loading && candles.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-ink-faint">
            Loading {symbol} {timeframe}…
          </div>
        ) : (
          <CandleChart
            symbol={symbol}
            interval={timeframe}
            candles={visibleCandles}
            overlays={overlays}
            decorations={mirrored.decorations}
            barColors={mirrored.barColors}
            markers={mirrored.markers}
            pineDrawings={mirrored.drawings}
            live={replaySession === null}
            fill
            onLiveBarBoundary={replaySession === null ? liveBarBoundary : undefined}
            onCrosshairMove={onCrosshairMove}
            crosshairTime={crosshairTime}
            onVisibleRangeChange={onVisibleRangeChange}
            visibleRange={visibleRange}
            followEdgeTime={followEdgeTime}
          />
        )}
      </div>
    </div>
  );
}
