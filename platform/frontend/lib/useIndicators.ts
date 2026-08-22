"use client";
/**
 * Owns the chart's applied-indicator list: add, remove, retune, re-run.
 *
 * Every instance re-runs whenever the chart context (symbol / timeframe /
 * range) changes or its own inputs change, so what's drawn always matches the
 * bars on screen. Runs are keyed by a monotonic token so a slow response for
 * an old symbol can never overwrite a newer one.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChartMarker, ChartOverlay } from "@/components/CandleChart";
import type { PineDrawings } from "@/lib/api";
import type { Interval, Trade } from "@/lib/types";
import {
  NO_DRAWINGS, hydrate, loadStored, newKey, runIndicator, saveStored,
  type AppliedIndicator, type PineParams,
} from "@/lib/indicators";

export interface IndicatorContext {
  symbol: string;
  timeframe: Interval;
  startTime: string;
  endTime: string;
}

export interface AddIndicatorInput {
  scriptId: string | null;
  name: string;
  source: string;
  params?: PineParams;
}

export function useIndicators(ctx: IndicatorContext) {
  const [list, setList] = useState<AppliedIndicator[]>([]);
  const runToken = useRef(0);
  /** keys whose inputs changed and therefore need a re-run */
  const [dirtyKeys, setDirtyKeys] = useState<string[]>([]);

  // Restore the previous session's studies once, on mount, then queue them —
  // stored rows carry no run output, so each needs a first run to draw.
  useEffect(() => {
    const restored = loadStored().map(hydrate);
    if (restored.length === 0) return;
    setList(restored);
    setDirtyKeys(restored.map((i) => i.key));
  }, []);

  // Skip the first pass: on mount `list` is still empty while the restore
  // effect is landing, and saving there would wipe the stored studies.
  const restored = useRef(false);
  useEffect(() => {
    if (!restored.current) { restored.current = true; return; }
    saveStored(list);
  }, [list]);

  /** Replace one instance in place, ignoring stale results for removed rows. */
  const settle = useCallback((next: AppliedIndicator, token: number) => {
    if (token !== runToken.current) return;
    setList((cur) => cur.map((i) => (i.key === next.key ? next : i)));
  }, []);

  const runOne = useCallback((ind: AppliedIndicator, token: number) => {
    void runIndicator(ind, ctx).then((res) => settle(res, token));
  }, [ctx, settle]);

  // A ref mirror of the list, so the run effects can read the current
  // instances without taking `list` as a dependency (which would re-run them
  // on every settled result and loop forever).
  const listRef = useRef<AppliedIndicator[]>([]);
  useEffect(() => { listRef.current = list; }, [list]);

  // Chart context changed: re-run everything under a fresh token.
  const ctxKey = `${ctx.symbol}|${ctx.timeframe}|${ctx.startTime}|${ctx.endTime}`;
  useEffect(() => {
    const pending = listRef.current;
    if (pending.length === 0) return;
    const token = ++runToken.current;
    setList((cur) => cur.map((i) => ({ ...i, loading: true, error: null })));
    for (const ind of pending) runOne(ind, token);
    // runOne closes over ctx, which ctxKey already covers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctxKey]);

  // Inputs changed on specific instances: re-run just those.
  useEffect(() => {
    if (dirtyKeys.length === 0) return;
    const wanted = new Set(dirtyKeys);
    const token = runToken.current;
    const pending = listRef.current.filter((i) => wanted.has(i.key));
    setList((cur) => cur.map((i) => (wanted.has(i.key) ? { ...i, loading: true, error: null } : i)));
    setDirtyKeys([]);
    for (const ind of pending) runOne(ind, token);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirtyKeys]);

  const add = useCallback((input: AddIndicatorInput): string => {
    const ind: AppliedIndicator = {
      key: newKey(),
      scriptId: input.scriptId,
      name: input.name,
      kind: "indicator",
      source: input.source,
      inputs: [],
      params: input.params ?? {},
      visible: true,
      loading: true,
      error: null,
      overlays: [], markers: [], drawings: NO_DRAWINGS, trades: [],
    };
    setList((cur) => [...cur, ind]);
    runOne(ind, runToken.current);
    return ind.key;
  }, [runOne]);

  const remove = useCallback((key: string) => {
    setList((cur) => cur.filter((i) => i.key !== key));
  }, []);

  const clear = useCallback(() => setList([]), []);

  const toggleVisible = useCallback((key: string) => {
    setList((cur) => cur.map((i) => (i.key === key ? { ...i, visible: !i.visible } : i)));
  }, []);

  const setParam = useCallback((key: string, param: string, value: number | string | boolean) => {
    setList((cur) => cur.map((i) =>
      (i.key === key ? { ...i, params: { ...i.params, [param]: value } } : i)));
    setDirtyKeys((d) => (d.includes(key) ? d : [...d, key]));
  }, []);

  const resetParams = useCallback((key: string) => {
    setList((cur) => cur.map((i) => (i.key === key ? { ...i, params: {} } : i)));
    setDirtyKeys((d) => (d.includes(key) ? d : [...d, key]));
  }, []);

  const rerun = useCallback((key: string) => {
    setDirtyKeys((d) => (d.includes(key) ? d : [...d, key]));
  }, []);

  /** Union of every visible instance's output, for the chart. */
  const overlays = useMemo<ChartOverlay[]>(
    () => list.filter((i) => i.visible).flatMap((i) => i.overlays),
    [list]
  );
  const markers = useMemo<ChartMarker[]>(
    () => list.filter((i) => i.visible).flatMap((i) => i.markers),
    [list]
  );
  /** Union of every visible instance's drawing objects. */
  const drawings = useMemo<PineDrawings>(() => {
    const vis = list.filter((i) => i.visible);
    return {
      lines: vis.flatMap((i) => i.drawings.lines),
      boxes: vis.flatMap((i) => i.drawings.boxes),
      labels: vis.flatMap((i) => i.drawings.labels),
      tables: vis.flatMap((i) => i.drawings.tables),
    };
  }, [list]);

  /** Trades come from strategy instances only; the newest applied one wins. */
  const trades = useMemo<Trade[] | null>(() => {
    const withTrades = list.filter((i) => i.visible && i.trades.length > 0);
    return withTrades.length > 0 ? withTrades[withTrades.length - 1]!.trades : null;
  }, [list]);

  return { list, add, remove, clear, toggleVisible, setParam, resetParams, rerun,
    overlays, markers, drawings, trades };
}

export type IndicatorsApi = ReturnType<typeof useIndicators>;
