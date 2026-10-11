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
import type { ChartMarker } from "@/components/CandleChart";
import {
  mergeBarColorLayers, PRICE_PANE_ID, type ChartBarColor, type ChartDecoration, type ChartOverlay,
} from "@/lib/chartSeries";
import type { PineDrawings } from "@/lib/api";
import type { Trade } from "@/lib/types";
import type { Resolution } from "@/lib/resolution";
import {
  NO_DRAWINGS, PINE_RUN_LOADING, PRIMARY_INDICATOR_SCOPE, hydrate, invalidateReplayOutput,
  loadStored, newKey, pineRunStatus, runIndicator, saveStored, storable,
  type AppliedIndicator, type PineParams,
} from "@/lib/indicators";
import { pushPanePine, syncPanePine } from "@/lib/chartStateSync";
import { isAbortError } from "@/lib/requestGuard";

export interface IndicatorContext {
  symbol: string;
  timeframe: Resolution;
  startTime: string;
  endTime: string;
  replay?: boolean;
  /**
   * Which pane's study list this is. Studies are per pane, so the stored list
   * is too — see `indicatorStorageKey`. Omitted means the primary pane, which
   * keeps the original storage entry.
   */
  scope?: string;
}

export interface AddIndicatorInput {
  scriptId: string | null;
  name: string;
  source: string;
  params?: PineParams;
}

export function useIndicators(ctx: IndicatorContext) {
  const scope = ctx.scope ?? PRIMARY_INDICATOR_SCOPE;
  const [list, setList] = useState<AppliedIndicator[]>([]);
  const [preparedContextKey, setPreparedContextKey] = useState("");
  const runToken = useRef(0);
  /** Per-instance generation prevents an older same-context run settling last. */
  const runVersions = useRef(new Map<string, number>());
  /** keys whose inputs changed and therefore need a re-run */
  const [dirtyKeys, setDirtyKeys] = useState<string[]>([]);

  /*
   * Restore once, on mount, from local storage AND from the server.
   *
   * Local first and synchronously, so the pane paints what the user had
   * without waiting for a request — and because that is the answer if the
   * server cannot be reached. The remote reconciliation lands after and only
   * replaces the list when the server actually holds Pine studies;
   * `syncPanePine` owns that decision.
   *
   * Stored rows carry no run output, so each restored study needs a first run
   * to draw — whichever side it came from.
   */
  useEffect(() => {
    const local = loadStored(scope);
    if (local.length > 0) {
      const restored = local.map(hydrate);
      setList(restored);
      setDirtyKeys(restored.map((i) => i.key));
    }
    let live = true;
    void (async () => {
      const result = await syncPanePine(scope, local);
      if (!live) return;
      version.current = result.version;
      if (result.decision.action !== "adopt") return;
      // A row written by a newer build may name things this one cannot run;
      // `hydrate` is total and each row stands or falls on its own.
      const adopted = result.pine.filter(
        (row) => row && typeof (row as { source?: unknown }).source === "string");
      const hydrated = adopted.map(hydrate);
      setList(hydrated);
      setDirtyKeys(hydrated.map((i) => i.key));
    })();
    return () => { live = false; };
    // Restoring is a mount-time act for one pane; the scope cannot change
    // under a mounted pane, because a pane's id is its identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** The server version this pane's Pine half is written against. */
  const version = useRef(0);
  const pushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Skip the first pass: on mount `list` is still empty while the restore
  // effect is landing, and saving there would wipe the stored studies.
  const restored = useRef(false);
  useEffect(() => {
    if (!restored.current) { restored.current = true; return; }
    // Local storage immediately — the pane must survive a reload even offline.
    saveStored(list, scope);
    /*
     * The server after a pause, and only this pane's PINE half: the built-in
     * half belongs to `useNativeStudies`, and a writer that sends a list it
     * does not own deletes it.
     */
    if (pushTimer.current) clearTimeout(pushTimer.current);
    pushTimer.current = setTimeout(() => {
      void (async () => {
        const result = await pushPanePine(scope, storable(list), version.current);
        version.current = result.version;
      })();
    }, 1_200);
  }, [list, scope]);

  useEffect(() => () => { if (pushTimer.current) clearTimeout(pushTimer.current); }, []);

  /** Replace one instance in place, ignoring stale results for removed rows. */
  const settle = useCallback((next: AppliedIndicator, token: number, version: number) => {
    if (token !== runToken.current || runVersions.current.get(next.key) !== version) return;
    setList((cur) => cur.map((i) => (i.key === next.key ? next : i)));
  }, []);

  /*
   * The chart context, read when a run is STARTED rather than closed over.
   *
   * `add` does not only reach this hook from its own pane. The workspace hands
   * the focused pane's API to the Indicators dialog and the Pine editor through
   * a registry, and the page memoises that object on the pane's study list — so
   * a surface holding it can be one or many renders behind the chart. Closing
   * over `ctx` made every method carry the context of the render it was built
   * in, which is how a study applied DURING a Replay was run to end-of-day and
   * then drawn on a rewound chart: lookahead, with a plausible picture attached.
   * The same staleness applied after a pane changed symbol or timeframe.
   *
   * A ref cannot be stale: whatever object a caller is holding, the run it
   * starts uses the context the chart is on now.
   */
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  /*
   * ── W2D-01: one request in flight per study, and a superseded one cancelled
   *
   * A run whose answer would be discarded — another context, a newer version
   * of the same study — used to be left running. Each interval switch queued
   * another full Pine run in the server's two-worker pool, so a few quick
   * switches put the run the chart was actually waiting for behind thirty
   * seconds of work nobody wanted, and the Next proxy's 30-second ceiling cut
   * it off with a 500. Now the superseded request is aborted, the server
   * drops it (`runPineInWorker`'s `signal`), and an abort is never mistaken
   * for an outcome: the study stays listed, loading, until the run that
   * replaced it lands.
   */
  const runControllers = useRef(new Map<string, AbortController>());
  const startRun = useCallback((key: string): AbortSignal => {
    runControllers.current.get(key)?.abort();
    const controller = new AbortController();
    runControllers.current.set(key, controller);
    return controller.signal;
  }, []);
  const finishRun = useCallback((key: string, signal: AbortSignal) => {
    const held = runControllers.current.get(key);
    if (held?.signal === signal) runControllers.current.delete(key);
  }, []);
  const abortRuns = useCallback((key?: string) => {
    const controllers = runControllers.current;
    for (const [id, controller] of [...controllers]) {
      if (key !== undefined && id !== key) continue;
      controller.abort();
      controllers.delete(id);
    }
  }, []);
  useEffect(() => () => abortRuns(), [abortRuns]);

  const runOne = useCallback((ind: AppliedIndicator, token: number) => {
    const version = (runVersions.current.get(ind.key) ?? 0) + 1;
    runVersions.current.set(ind.key, version);
    const signal = startRun(ind.key);
    void runIndicator(ind, ctxRef.current, signal).then(
      (res) => settle(res, token, version),
      // Superseded: the run that replaced it settles the row instead.
      (cause) => { if (!isAbortError(cause)) throw cause; },
    ).finally(() => finishRun(ind.key, signal));
  }, [settle, startRun, finishRun]);

  /*
   * B-04: a Replay playing forward runs each study at most once at a time.
   *
   * Play at 10× advanced about one bar per Pine round trip, because the clock
   * waited for every study to finish before the next tick — and every tick
   * started a fresh run of every study, superseding the last. A forward step
   * keeps the previous output (it ends EARLIER than the new horizon, so it can
   * be incomplete but never prescient), so the clock no longer waits: while a
   * study's run is in flight, later steps only note that a rerun is wanted,
   * and when the run lands one more is started for the horizon the chart is on
   * by then. The forward step does not spend a new token, so the landing run
   * is not discarded; a rewind does, so nothing computed for a later horizon
   * can ever settle onto an earlier one.
   */
  const forwardRuns = useRef(new Map<string, boolean>());
  const runForward = useCallback((ind: AppliedIndicator) => {
    if (forwardRuns.current.has(ind.key)) { forwardRuns.current.set(ind.key, true); return; }
    forwardRuns.current.set(ind.key, false);
    const token = runToken.current;
    const version = (runVersions.current.get(ind.key) ?? 0) + 1;
    runVersions.current.set(ind.key, version);
    const signal = startRun(ind.key);
    void runIndicator(ind, ctxRef.current, signal).then((res) => {
      finishRun(ind.key, signal);
      settle(res, token, version);
      const again = forwardRuns.current.get(ind.key) === true;
      forwardRuns.current.delete(ind.key);
      if (!again || token !== runToken.current) return;
      const latest = listRef.current.find((i) => i.key === ind.key);
      if (latest) runForward(latest);
    }, (cause) => {
      finishRun(ind.key, signal);
      // A rewind or a context change cancelled it, and cleared the queue.
      if (!isAbortError(cause)) throw cause;
    });
  }, [settle, startRun, finishRun]);

  // A ref mirror of the list, so the run effects can read the current
  // instances without taking `list` as a dependency (which would re-run them
  // on every settled result and loop forever).
  const listRef = useRef<AppliedIndicator[]>([]);
  useEffect(() => { listRef.current = list; }, [list]);

  // Chart context changed: re-run everything under a fresh token.
  const ctxKey = `${ctx.symbol}|${ctx.timeframe}|${ctx.startTime}|${ctx.endTime}|${ctx.replay ? "replay" : "live"}`;
  /*
   * ── C8/C9: which context changes must blank the old output ───────────────
   *
   * A Replay REWIND must: output computed to a later horizon shows bars the
   * replayed moment has not reached — lookahead with a plausible picture. A
   * forward STEP must not: the old output ends earlier than the new horizon,
   * so it can only be incomplete, never prescient, and blanking it made every
   * study vanish and reappear on every step of the one workflow replay exists
   * for. Leaving Replay must blank too: what is on screen was computed for a
   * truncated window, and the live run is a different series.
   */
  const shownCtxRef = useRef(ctx);
  const forwardStep = ctx.replay && shownCtxRef.current.replay
    && shownCtxRef.current.symbol === ctx.symbol
    && shownCtxRef.current.timeframe === ctx.timeframe
    && shownCtxRef.current.startTime === ctx.startTime
    && Date.parse(ctx.endTime) >= Date.parse(shownCtxRef.current.endTime);
  const leavingReplay = !ctx.replay && shownCtxRef.current.replay;
  /*
   * B-03: and so must a new instrument or a new resolution. The old output
   * was kept on screen until the rerun landed — seven to nine seconds of SOL's
   * strategy values in the legend of a chart titled Bitcoin — and on another
   * resolution its times no longer name these bars at all, which is the
   * `∅ ∅` a reader saw after an interval change.
   */
  const contextMoved = shownCtxRef.current.symbol !== ctx.symbol
    || shownCtxRef.current.timeframe !== ctx.timeframe;
  useEffect(() => {
    const pending = listRef.current;
    const blank = (ctx.replay && !forwardStep) || leavingReplay || contextMoved;
    // A forward Replay step keeps the token, so in-flight runs still land
    // (`runForward`); every other change supersedes them.
    const coalesce = forwardStep && !blank;
    const token = coalesce ? runToken.current : ++runToken.current;
    if (!coalesce) {
      forwardRuns.current.clear();
      // Everything in flight was computed for a context the chart has left.
      abortRuns();
    }
    shownCtxRef.current = ctx;
    setPreparedContextKey(ctxKey);
    if (pending.length === 0) return;
    setList((cur) => cur.map((i) => blank
      ? invalidateReplayOutput(i)
      : { ...i, loading: true, error: null }));
    for (const ind of pending) {
      if (coalesce) runForward(ind);
      else runOne(ind, token);
    }
    // `runOne` is stable and reads the context itself; ctxKey covers ctx.replay.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctxKey]);

  // React paints once before effects clear stale state. Suppress the old
  // output synchronously on that render so rewind has no later-horizon flash —
  // and only then: a forward step keeps what it has until the rerun lands.
  const suppress = preparedContextKey !== ctxKey
    && ((ctx.replay && !forwardStep) || leavingReplay || contextMoved);
  // Suppressed output is not a removed study: each row stays, loading (W2D-01).
  const outputList = useMemo(
    () => suppress ? list.map(invalidateReplayOutput) : list, [suppress, list]);

  // Inputs changed on specific instances: re-run just those.
  useEffect(() => {
    if (dirtyKeys.length === 0) return;
    const timer = setTimeout(() => {
      const wanted = new Set(dirtyKeys);
      const token = runToken.current;
      const pending = listRef.current.filter((i) => wanted.has(i.key));
      setList((cur) => cur.map((i) => (wanted.has(i.key)
        ? { ...i, loading: true, error: null } : i)));
      setDirtyKeys([]);
      for (const ind of pending) runOne(ind, token);
    }, 250);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirtyKeys]);

  const add = useCallback((input: AddIndicatorInput): string => {
    const ind: AppliedIndicator = {
      key: newKey(),
      scriptId: input.scriptId,
      name: input.name,
      kind: "indicator",
      shortTitle: "",
      overlay: true,
      precision: null,
      source: input.source,
      inputs: [],
      params: input.params ?? {},
      visible: true,
      loading: true,
      error: null,
      warnings: [],
      overlays: [], decorations: [], barColors: [], markers: [], drawings: NO_DRAWINGS, trades: [],
    };
    setList((cur) => [...cur, ind]);
    runOne(ind, runToken.current);
    return ind.key;
  }, [runOne]);

  const remove = useCallback((key: string) => {
    runVersions.current.delete(key);
    abortRuns(key);
    setList((cur) => cur.filter((i) => i.key !== key));
  }, [abortRuns]);

  const clear = useCallback(() => {
    runVersions.current.clear();
    abortRuns();
    setList([]);
  }, [abortRuns]);

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

  /** Recompile an edited script into the same instance/pane/series namespace. */
  const updateSource = useCallback((
    key: string,
    input: { name: string; source: string; params: PineParams }
  ) => {
    setList((cur) => cur.map((item) => item.key === key ? {
      ...item,
      name: input.name,
      source: input.source,
      params: input.params,
      loading: true,
      error: null,
      warnings: [],
    } : item));
    setDirtyKeys((dirty) => dirty.includes(key) ? dirty : [...dirty, key]);
  }, []);

  const rerun = useCallback((key: string) => {
    setDirtyKeys((d) => (d.includes(key) ? d : [...d, key]));
  }, []);

  /** Refresh every visible instance, used once at a completed live-bar boundary. */
  const rerunAll = useCallback(() => {
    setDirtyKeys((current) => {
      const keys = listRef.current.filter((i) => i.visible).map((i) => i.key);
      return [...new Set([...current, ...keys])];
    });
  }, []);

  /** Union of every visible instance's output, for the chart. */
  /*
   * B-12: a study whose run failed still has a row in the legend, and the row
   * says so. It used to vanish into `∅ ∅` — the values of output that was
   * never produced — with nothing anywhere on the chart to say why. The row
   * is an empty overlay whose inputs text is the plain-language status; the
   * raw cause stays on `error` for the Indicators panel.
   */
  const overlays = useMemo<ChartOverlay[]>(
    () => outputList.filter((i) => i.visible).flatMap((i) => {
      /*
       * W2D-01: and a study whose run is IN FLIGHT has a row too. A context
       * switch clears the old output and the row went with it, so for as long
       * as the rerun took — tens of seconds behind a busy queue — the strategy
       * was simply gone from a chart whose toolbar still counted it.
       */
      const status = i.overlays.length > 0 ? null
        : i.loading ? PINE_RUN_LOADING : pineRunStatus(i.error);
      return status === null ? i.overlays : [{
        id: `${i.key}:status`, title: "", color: "#9c9c9c", data: [], paneId: PRICE_PANE_ID,
        instanceId: i.key, instanceTitle: i.name || "Script", instanceParams: status,
        statusValueVisible: false, priceScaleLabelVisible: false,
      }];
    }),
    [outputList]
  );
  const decorations = useMemo<ChartDecoration[]>(
    () => outputList.filter((i) => i.visible).flatMap((i) => i.decorations),
    [outputList]
  );
  const barColors = useMemo<ChartBarColor[]>(
    () => mergeBarColorLayers(outputList.filter((i) => i.visible).map((i) => i.barColors)),
    [outputList]
  );
  const markers = useMemo<ChartMarker[]>(
    () => outputList.filter((i) => i.visible).flatMap((i) => i.markers),
    [outputList]
  );
  /** Union of every visible instance's drawing objects. */
  const drawings = useMemo<PineDrawings>(() => {
    const vis = outputList.filter((i) => i.visible);
    return {
      lines: vis.flatMap((i) => i.drawings.lines),
      boxes: vis.flatMap((i) => i.drawings.boxes),
      labels: vis.flatMap((i) => i.drawings.labels),
      tables: vis.flatMap((i) => i.drawings.tables),
    };
  }, [outputList]);

  /** Trades come from strategy instances only; the newest applied one wins. */
  const trades = useMemo<Trade[] | null>(() => {
    const withTrades = outputList.filter((i) => i.visible && i.trades.length > 0);
    return withTrades.length > 0 ? withTrades[withTrades.length - 1]!.trades : null;
  }, [outputList]);

  return { list, add, remove, clear, toggleVisible, setParam, resetParams, updateSource, rerun,
    rerunAll, overlays, decorations, barColors, markers, drawings, trades };
}

export type IndicatorsApi = ReturnType<typeof useIndicators>;
