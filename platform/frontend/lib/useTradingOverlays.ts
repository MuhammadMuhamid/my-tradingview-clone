"use client";
/**
 * Read-only trading evidence for the focused instrument.
 *
 * ── Why this is a hook and not page code ───────────────────────────────────
 *
 * It is a hundred and sixty lines of request sequencing whose whole purpose is
 * to make sure the chart never shows evidence belonging to a different symbol,
 * a different visible range, or a different Replay horizon than the one on
 * screen. That reasoning is self-contained, and leaving it inline in the chart
 * page meant every unrelated chart change had to be made around it.
 *
 * Nothing here executes anything. It reads what the platform and the bot
 * already recorded and returns chart primitives; the disclosure it feeds says
 * so explicitly.
 *
 * ── Scope in a multi-pane workspace ────────────────────────────────────────
 *
 * Evidence is fetched for ONE instrument — the focused pane's — and the
 * workspace draws it only on panes showing that instrument. Fetching for
 * sixteen instruments at once is a bounded-cost question this wave did not
 * take on; a pane on another symbol shows no evidence rather than another
 * symbol's.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChartMarker, ChartPriceLine } from "@/components/CandleChart";
import { api } from "./api";
import { CancellableRequest, isAbortError, LatestRequest } from "./requestGuard";
import { useExclusivePopover } from "./useExclusivePopover";
import { INTERVAL_MS, type Candle, type Interval } from "./types";
import {
  anchorTradingOverlays, compactOverlaySource, DEFAULT_OVERLAY_PREFERENCES, loadOverlayPreferences,
  mergeOverlayResponses, overlayChartContextKey, overlayItemVisible, overlayRequestKey,
  requestedOverlayRange, saveOverlayPreferences, splitOverlayResponse, TradingOverlayCache,
  type TradingOverlayItem, type TradingOverlayPreferences, type TradingOverlayResponse,
} from "./tradingOverlays";

export interface TradingOverlaysInput {
  /** The focused pane's instrument and resolution. */
  symbol: string;
  interval: Interval;
  /** The focused pane's bars, already clipped to any replay horizon. */
  visibleCandles: Candle[];
  /** The workspace replay horizon, or null when replay is off. */
  replayCutoff: number | null;
}

export interface TradingOverlaysApi {
  prefs: TradingOverlayPreferences;
  setPrefs: (next: TradingOverlayPreferences) => void;
  menuOpen: boolean;
  setMenuOpen: (open: boolean) => void;
  data: TradingOverlayResponse | null;
  loading: boolean;
  error: string | null;
  items: TradingOverlayItem[];
  markers: ChartMarker[];
  priceLines: ChartPriceLine[];
  selected: TradingOverlayItem | null;
  select: (id: string | null) => void;
  /** The focused pane reports its viewport so a bounded range can be fetched. */
  setViewport: (range: { from: number; to: number } | null) => void;
}

export function useTradingOverlays(input: TradingOverlaysInput): TradingOverlaysApi {
  const { symbol, interval, visibleCandles } = input;
  const replay = { horizonCloseTime: input.replayCutoff };
  const replayActive = input.replayCutoff !== null;

  const [overlayPrefs, setOverlayPrefsState] = useState<TradingOverlayPreferences>(DEFAULT_OVERLAY_PREFERENCES);
  // Through the registry: this menu sits in the same toolbar as the others.
  const [overlayMenuOpen, setOverlayMenuOpen] = useExclusivePopover("trading-overlays");
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
    let live = true;
    const flight = overlayCurrentFlight.current;
    const sequence = overlayCurrentSeq.current;
    const refresh = async () => {
      const token = sequence.next();
      const signal = flight.start();
      try {
        const response = await api.tradingOverlays({ symbol, ...settledOverlayRange,
          limit: 300, scope: "current" }, signal);
        if (!live || overlayContextRef.current !== requestContext
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
      live = false;
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
  return useMemo(() => ({
    prefs: overlayPrefs,
    setPrefs: setOverlayPrefs,
    menuOpen: overlayMenuOpen,
    setMenuOpen: setOverlayMenuOpen,
    data: tradingOverlayData,
    loading: overlaysLoading,
    error: overlayError,
    items: visibleTradingOverlays,
    markers: tradingMarkers,
    priceLines: tradingPriceLines,
    selected: selectedOverlay,
    select: setSelectedOverlayId,
    setViewport: setOverlayViewport,
  }), [overlayPrefs, setOverlayPrefs, overlayMenuOpen, setOverlayMenuOpen, tradingOverlayData,
    overlaysLoading, overlayError, visibleTradingOverlays, tradingMarkers, tradingPriceLines,
    selectedOverlay]);
}
