"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  createChart, ColorType, CrosshairMode, IChartApi, ISeriesApi, Time, UTCTimestamp,
  SeriesMarker, MouseEventParams, LineStyle,
} from "lightweight-charts";
import type { Candle, Interval, Trade } from "@/lib/types";
import { fmtPrice } from "@/lib/format";
import { DrawingCanvas } from "@/components/tv/DrawingCanvas";
import { PineDrawingLayer, PineTables } from "@/components/tv/PineDrawingLayer";
import type { PineDrawings } from "@/lib/api";
import type { Drawing, DrawingTool } from "@/lib/drawings";

/** TradingView-style legend readout for the candle under the crosshair. */
interface LegendBar {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  /** change vs the previous candle's close (falls back to the bar's open) */
  chg: number;
  chgPct: number;
}

const INTERVAL_MS: Record<Interval, number> = {
  "1m": 60000, "3m": 180000, "5m": 300000, "15m": 900000, "30m": 1800000,
  "1h": 3600000, "2h": 7200000, "4h": 14400000, "6h": 21600000, "12h": 43200000, "1d": 86400000,
};

/**
 * The states the live feed can be in. `stale` and `unknown` exist so the chart
 * never presents a frozen price as current — which is precisely what FE-09
 * described.
 */
export type ChartFeedState = "idle" | "connecting" | "live" | "reconnecting" | "stale";

/**
 * Silence after which an open socket is treated as dead and rebuilt. An active
 * kline stream updates about once a second; 45 s of nothing is not a lull.
 */
export const WS_SILENCE_TIMEOUT_MS = 45_000;
const WS_WATCHDOG_INTERVAL_MS = 5_000;

/** Binance combined stream for one symbol/interval; updates the forming candle live. */
function streamUrl(symbol: string, interval: Interval): string {
  return `wss://stream.binance.com:9443/ws/${symbol.toLowerCase()}@kline_${interval}`;
}

/** A horizontal level drawn across the chart (live stop / target / entry). */
export interface ChartPriceLine {
  price: number;
  color: string;
  title: string;
  dashed?: boolean;
}

/** A bar marker plotted by a script (plotshape / plotchar). */
export interface ChartMarker {
  /** bar open time in seconds */
  time: number;
  position: "aboveBar" | "belowBar";
  color: string;
  text: string;
  shape: "arrowUp" | "arrowDown" | "circle" | "square";
}

/** Extra series a compiled Pine script asks the chart to plot. */
export interface ChartOverlay {
  id: string;
  title: string;
  color: string;
  width?: number;
  dashed?: boolean;
  /** [barTimeSec, value] pairs; NaN/null values break the line. */
  data: { time: number; value: number | null }[];
}

export function CandleChart({
  symbol, interval, candles, trades, priceLines, overlays, markers, pineDrawings,
  live = true, fill = false,
  drawingTool = "cursor", onDrawingToolDone, drawings, onDrawingsChange,
  magnet = false, drawingsLocked = false, drawingsHidden = false,
  compact = false,
}: {
  symbol: string;
  interval: Interval;
  candles: Candle[];
  trades?: Trade[];
  /** Live SL/TP/entry levels for a running position. */
  priceLines?: ChartPriceLine[];
  /** Line series plotted by a compiled Pine script. */
  overlays?: ChartOverlay[];
  /** Bar markers plotted by compiled scripts, merged with the trade markers. */
  markers?: ChartMarker[];
  /** line/box/label/table objects created by compiled Pine scripts */
  pineDrawings?: PineDrawings | null;
  live?: boolean;
  /** fill the parent container instead of the fixed 520px height */
  fill?: boolean;
  // ── drawing layer (omit to disable it entirely) ──
  drawingTool?: DrawingTool;
  onDrawingToolDone?: () => void;
  drawings?: Drawing[];
  onDrawingsChange?: (next: Drawing[]) => void;
  magnet?: boolean;
  drawingsLocked?: boolean;
  drawingsHidden?: boolean;
  /**
   * Phone layout: drop the per-series price-axis badges and shorten the
   * legend. Ten moving averages each stamp a label on the scale, which on a
   * 390px screen covers most of the price column.
   */
  compact?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const overlayRefs = useRef<Map<string, ISeriesApi<"Line">>>(new Map());
  const candlesRef = useRef<Candle[]>([]);
  const timeIndexRef = useRef<Map<number, number>>(new Map());
  const hoverTimeRef = useRef<number | null>(null);
  const [legend, setLegend] = useState<LegendBar | null>(null);
  /** FE-09: what the live feed is actually doing, so the UI can say so. */
  const [feedState, setFeedState] = useState<ChartFeedState>("idle");
  /** bumped once the chart/series exist, so the drawing layer can attach */
  const [chartReady, setChartReady] = useState(0);

  const legendFromIndex = useCallback((i: number): LegendBar | null => {
    const list = candlesRef.current;
    const c = list[i];
    if (!c) return null;
    const prevClose = i > 0 ? list[i - 1]!.close : c.open;
    const chg = c.close - prevClose;
    return {
      open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
      chg, chgPct: prevClose !== 0 ? (chg / prevClose) * 100 : 0,
    };
  }, []);

  // Create the chart once.
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: "#121722" },
        textColor: "#9aa4b6",
        fontFamily: "ui-monospace, monospace",
      },
      grid: {
        vertLines: { color: "#1a2030" },
        horzLines: { color: "#1a2030" },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: "#232b3a" },
      timeScale: { borderColor: "#232b3a", timeVisible: true, secondsVisible: false },
      autoSize: true,
    });
    const series = chart.addCandlestickSeries({
      upColor: "#2ebd85", downColor: "#f6465d",
      borderUpColor: "#2ebd85", borderDownColor: "#f6465d",
      wickUpColor: "#2ebd85", wickDownColor: "#f6465d",
    });
    const vol = chart.addHistogramSeries({
      priceFormat: { type: "volume" },
      priceScaleId: "vol",
      color: "#2a3346",
    });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });

    // OHLC legend follows the crosshair; off-chart it shows the latest bar.
    chart.subscribeCrosshairMove((param: MouseEventParams) => {
      const t = param.time as number | undefined;
      hoverTimeRef.current = t ?? null;
      if (t != null) {
        const i = timeIndexRef.current.get(t);
        if (i !== undefined) {
          setLegend(legendFromIndex(i));
          return;
        }
      }
      const n = candlesRef.current.length;
      setLegend(n > 0 ? legendFromIndex(n - 1) : null);
    });

    chartRef.current = chart;
    seriesRef.current = series;
    volRef.current = vol;
    setChartReady((n) => n + 1);
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      overlayRefs.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load historical candles + markers whenever the data changes.
  useEffect(() => {
    const series = seriesRef.current;
    const vol = volRef.current;
    if (!series || !vol) return;
    candlesRef.current = candles;
    timeIndexRef.current = new Map(candles.map((c, i) => [c.openTime / 1000, i]));
    setLegend(candles.length > 0 ? legendFromIndex(candles.length - 1) : null);
    const bars = candles.map((c) => ({
      time: (c.openTime / 1000) as UTCTimestamp,
      open: c.open, high: c.high, low: c.low, close: c.close,
    }));
    series.setData(bars);
    vol.setData(candles.map((c) => ({
      time: (c.openTime / 1000) as UTCTimestamp,
      value: c.volume,
      color: c.close >= c.open ? "#1c3a30" : "#3a1c24",
    })));

    // Entry/exit markers only: BUY at the fill, and the exit reason (TP / SL /
    // whatever the strategy named it) at the close. Nothing else is marked.
    //
    // A backtest usually spans more history than the chart currently holds.
    // lightweight-charts pins a marker whose time predates the loaded bars to
    // the first bar, which stacks old trades on the left edge at prices that
    // never occurred there — so drop anything outside the loaded window.
    const firstT = candles[0] ? candles[0].openTime / 1000 : 0;
    const lastT = candles[candles.length - 1]
      ? candles[candles.length - 1]!.openTime / 1000 : 0;
    const inWindow = (t: number): boolean => t >= firstT && t <= lastT;

    if (candles.length > 0 && ((trades?.length ?? 0) > 0 || (markers?.length ?? 0) > 0)) {
      const drawn: SeriesMarker<Time>[] = [];
      for (const t of trades ?? []) {
        const open = t.exitTime === null;
        if (inWindow(t.entryTime / 1000)) {
          drawn.push({
            time: (t.entryTime / 1000) as UTCTimestamp,
            position: "belowBar",
            color: open ? "#f0b90b" : "#2ebd85",
            shape: "arrowUp",
            text: `BUY ${fmtPrice(t.entryPrice)}${open ? " ●" : ""}`,
          });
        }
        if (t.exitTime !== null && inWindow(t.exitTime / 1000)) {
          const win = (t.pnl ?? 0) >= 0;
          const reason = (t.exitReason ?? "EXIT").toUpperCase();
          drawn.push({
            time: (t.exitTime / 1000) as UTCTimestamp,
            position: "aboveBar", color: win ? "#2ebd85" : "#f6465d", shape: "arrowDown",
            text: t.exitPrice !== null ? `${reason} ${fmtPrice(t.exitPrice)}` : reason,
          });
        }
      }
      for (const m of markers ?? []) {
        if (!inWindow(m.time)) continue;
        drawn.push({
          time: m.time as UTCTimestamp,
          position: m.position,
          color: m.color,
          shape: m.shape,
          text: m.text,
        });
      }
      drawn.sort((a, b) => (a.time as number) - (b.time as number));
      series.setMarkers(drawn);
    } else {
      series.setMarkers([]);
    }
    chartRef.current?.timeScale().fitContent();
  }, [candles, trades, markers]);

  // Live stop / target / entry levels for a running position.
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    const drawn = (priceLines ?? [])
      .filter((l) => Number.isFinite(l.price))
      .map((l) => series.createPriceLine({
        price: l.price,
        color: l.color,
        lineWidth: 1,
        lineStyle: l.dashed ? LineStyle.Dashed : LineStyle.Solid,
        axisLabelVisible: true,
        title: l.title,
      }));
    return () => { for (const line of drawn) series.removePriceLine(line); };
  }, [priceLines]);

  // Line series plotted by a compiled Pine script. Series are reused across
  // recompiles by plot id so the chart doesn't flicker on every edit.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    // Clip to the loaded candle window, so a script run over more history than
    // the chart holds doesn't stretch the time scale past the candles.
    const first = candles[0] ? candles[0].openTime / 1000 : -Infinity;
    const lastBar = candles[candles.length - 1];
    const lastTime = lastBar ? lastBar.openTime / 1000 : Infinity;
    const want = new Map((overlays ?? []).map((o) => [o.id, o]));
    for (const [id, s] of overlayRefs.current) {
      if (!want.has(id)) {
        chart.removeSeries(s);
        overlayRefs.current.delete(id);
      }
    }
    for (const o of want.values()) {
      let s = overlayRefs.current.get(o.id);
      if (!s) {
        s = chart.addLineSeries({ priceLineVisible: false, lastValueVisible: false });
        overlayRefs.current.set(o.id, s);
      }
      s.applyOptions({
        color: o.color,
        lineWidth: (o.width ?? 2) as 1 | 2 | 3 | 4,
        lineStyle: o.dashed ? LineStyle.Dashed : LineStyle.Solid,
        // The title is what lightweight-charts stamps onto the price scale.
        title: compact ? "" : o.title,
      });
      s.setData(
        o.data
          .filter((d) => d.value !== null && Number.isFinite(d.value) &&
            d.time >= first && d.time <= lastTime)
          .map((d) => ({ time: d.time as UTCTimestamp, value: d.value as number }))
      );
    }
  }, [overlays, chartReady, candles, compact]);

  /*
   * Live: update the forming candle from the Binance kline websocket.
   *
   * FE-09: this had `onmessage` and nothing else — no `onerror`, no `onclose`,
   * no reconnect and no watchdog. When the socket dropped, or stayed open while
   * delivering nothing (a half-open TCP connection, or a server that has
   * stopped sending), the last price simply froze on screen and kept being
   * displayed as if it were current. There was no way for a user to tell.
   *
   * Now: exponential-backoff reconnect, a silence watchdog, and a feed state
   * the caller can render. `unknown` and `stale` are real answers — nothing
   * here reports "live" without a recent message to justify it.
   */
  useEffect(() => {
    if (!live) { setFeedState("idle"); return; }
    const series = seriesRef.current;
    const vol = volRef.current;
    if (!series || !vol) return;

    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let watchdog: ReturnType<typeof setInterval> | null = null;
    let attempt = 0;
    let lastMessageAt = 0;
    let closed = false;

    const connect = (): void => {
      if (closed) return;
      setFeedState(attempt === 0 ? "connecting" : "reconnecting");
      const ws = new WebSocket(streamUrl(symbol, interval));
      socket = ws;
      wireHandlers(ws);
    };

    const scheduleReconnect = (): void => {
      if (closed) return;
      attempt += 1;
      setFeedState("reconnecting");
      // Capped exponential backoff: a Binance outage must not become a
      // reconnect storm from every open chart tab.
      const delay = Math.min(1000 * 2 ** Math.min(attempt, 5), 30_000);
      reconnectTimer = setTimeout(connect, delay);
    };

    const wireHandlers = (ws: WebSocket): void => {
    ws.onopen = () => {
      attempt = 0;
      lastMessageAt = Date.now();
      setFeedState("live");
    };
    ws.onerror = () => {
      // `onerror` is always followed by `onclose`, which does the reconnecting.
      setFeedState("reconnecting");
    };
    ws.onclose = () => {
      if (closed || socket !== ws) return;
      socket = null;
      scheduleReconnect();
    };
    ws.onmessage = (ev) => {
      lastMessageAt = Date.now();
      setFeedState("live");
      try {
        const msg = JSON.parse(ev.data as string) as {
          k?: { t: number; o: string; h: string; l: string; c: string; v: string };
        };
        if (!msg.k) return;
        const k = msg.k;
        const time = (k.t / 1000) as UTCTimestamp;
        series.update({ time, open: +k.o, high: +k.h, low: +k.l, close: +k.c });
        vol.update({ time, value: +k.v, color: +k.c >= +k.o ? "#1c3a30" : "#3a1c24" });

        // Mirror the forming candle into the legend source so the readout
        // stays live; only refresh the display when the user isn't pointing
        // at an older candle.
        const list = candlesRef.current;
        const liveBar: Candle = {
          symbol, interval, openTime: k.t, closeTime: k.t + INTERVAL_MS[interval] - 1,
          open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v,
        };
        const idx = timeIndexRef.current.get(k.t / 1000);
        if (idx !== undefined) list[idx] = liveBar;
        else if (list.length === 0 || k.t > list[list.length - 1]!.openTime) {
          list.push(liveBar);
          timeIndexRef.current.set(k.t / 1000, list.length - 1);
        }
        const hover = hoverTimeRef.current;
        if (hover === null || hover === k.t / 1000) {
          const i = timeIndexRef.current.get(k.t / 1000);
          if (i !== undefined) setLegend(legendFromIndex(i));
        }
      } catch { /* ignore malformed frames */ }
    };
    };

    connect();

    /*
     * The watchdog is the half of this that `isConnected()`-style checks miss:
     * a socket can sit in readyState OPEN and deliver nothing at all. An active
     * kline stream updates roughly once a second, so 45 seconds of complete
     * silence means the connection is not carrying data whatever its state
     * says.
     */
    watchdog = setInterval(() => {
      if (closed || lastMessageAt === 0) return;
      const silentFor = Date.now() - lastMessageAt;
      if (silentFor <= WS_SILENCE_TIMEOUT_MS) return;
      setFeedState("stale");
      // Rebuild rather than wait: the socket is not going to recover on its own.
      const dead = socket;
      socket = null;
      try { dead?.close(); } catch { /* already gone */ }
      lastMessageAt = Date.now();
      scheduleReconnect();
    }, WS_WATCHDOG_INTERVAL_MS);

    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (watchdog) clearInterval(watchdog);
      const open = socket;
      socket = null;
      try { open?.close(); } catch { /* already gone */ }
      setFeedState("idle");
    };
  }, [symbol, interval, live]);

  const up = legend ? legend.close >= legend.open : true;
  const chgUp = legend ? legend.chg >= 0 : true;
  const px = up ? "text-[#2ebd85]" : "text-[#f6465d]";

  return (
    <div className={`relative ${fill ? "h-full" : "h-[520px]"} w-full`}>
      <div ref={containerRef} className="h-full w-full" />
      {/* Script drawings sit under the user's own drawing layer, so the
          user's tools keep priority for clicks and hit-testing. */}
      <PineDrawingLayer
        key={chartReady}
        container={containerRef.current}
        chart={chartRef.current}
        series={seriesRef.current}
        candles={candles}
        drawings={pineDrawings ?? null}
      />
      <PineTables drawings={pineDrawings ?? null} />
      {drawings && onDrawingsChange && (
        <DrawingCanvas
          key={chartReady}
          container={containerRef.current}
          chart={chartRef.current}
          series={seriesRef.current}
          candles={candles}
          interval={interval}
          tool={drawingTool}
          onToolDone={onDrawingToolDone ?? (() => {})}
          drawings={drawings}
          onChange={onDrawingsChange}
          magnet={magnet}
          locked={drawingsLocked}
          hidden={drawingsHidden}
        />
      )}
      {legend && (
        <div className="pointer-events-none absolute left-2 top-1.5 z-10 flex flex-wrap items-baseline gap-x-2 rounded bg-[#121722]/75 px-1.5 py-0.5 font-mono text-[10px] leading-4 text-[#9aa4b6] sm:text-[11px]">
          <span className="font-semibold text-[#e5e9f0]">{symbol}</span>
          <span>· {interval} ·</span>
          {/* O/H/L and volume are the first things to go on a phone: the close
              and the change are what the eye actually reads at a glance. */}
          <span className="hidden sm:inline">O <span className={px}>{fmtPrice(legend.open)}</span></span>
          <span className="hidden sm:inline">H <span className={px}>{fmtPrice(legend.high)}</span></span>
          <span className="hidden sm:inline">L <span className={px}>{fmtPrice(legend.low)}</span></span>
          <span>C <span className={px}>{fmtPrice(legend.close)}</span></span>
          <span className={chgUp ? "text-[#2ebd85]" : "text-[#f6465d]"}>
            {chgUp ? "+" : ""}{fmtPrice(legend.chg)} ({chgUp ? "+" : ""}{legend.chgPct.toFixed(2)}%)
          </span>
          {legend.volume !== null && (
            <span className="hidden sm:inline">Vol <span className="text-[#e5e9f0]">{legend.volume.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span></span>
          )}
        </div>
      )}
      {/*
        FE-09: the feed's real state, next to the price it is supposed to be
        updating. A frozen price used to look exactly like a live one.
        `live` is not rendered — a green dot beside every chart is noise, and
        the states worth interrupting for are the ones where the number on
        screen is NOT current.
      */}
      {live && feedState !== "live" && (
        <div
          role="status"
          aria-live="polite"
          className={`pointer-events-none absolute right-2 top-1.5 z-10 flex items-center gap-1.5 rounded px-2 py-0.5 font-mono text-[10px] leading-4 sm:text-[11px] ${FEED_BADGE[feedState].className}`}
        >
          <span aria-hidden="true">●</span>
          {FEED_BADGE[feedState].label}
        </div>
      )}
    </div>
  );
}

/**
 * How each non-live feed state is presented.
 *
 * `stale` is the loudest: the socket is open and the price on screen is not
 * moving, which is the state a user is most likely to misread as calm.
 */
const FEED_BADGE: Record<ChartFeedState, { label: string; className: string }> = {
  idle: { label: "not live", className: "bg-[#121722]/75 text-[#9aa4b6]" },
  connecting: { label: "connecting…", className: "bg-[#121722]/75 text-[#9aa4b6]" },
  live: { label: "live", className: "bg-[#121722]/75 text-[#2ebd85]" },
  reconnecting: { label: "reconnecting…", className: "bg-[#3a2a12]/85 text-[#f0b90b]" },
  stale: { label: "feed stalled — price is not current", className: "bg-[#3a1c24]/85 text-[#f6465d]" },
};

export { INTERVAL_MS };
