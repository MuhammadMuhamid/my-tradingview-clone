"use client";
/**
 * One pane's built-in studies: add, retune, restyle, reorder, remove.
 *
 * ── Why this is beside `useIndicators` rather than inside it ───────────────
 *
 * A Pine study and a native study are the same THING to a user — a study on a
 * chart, in one list, with inputs and a remove button — and two completely
 * different objects to the machine. A Pine study is compiled and run on the
 * server against an explicit time range, asynchronously, with a run token to
 * suppress stale results. A native study is a pure function of the bars the
 * pane already holds, evaluated synchronously during render.
 *
 * Merging them would mean giving the native path an async lifecycle it does
 * not have, or giving the Pine path a synchronous one it cannot have. So the
 * engines stay separate and the SURFACE is joined: `ChartPane` concatenates
 * the two lists of overlays, and the workspace panel shows one list. Nothing
 * about the Pine path changes, which is the point — it is the mature half.
 *
 * ── Cost ───────────────────────────────────────────────────────────────────
 *
 * Studies are recomputed when their bars, their inputs or their styles change,
 * and a live tick changes the bars once a second per pane. Two bounds, both in
 * `lib/native/compute`: each study sees only its declared warmup plus the
 * visible window, and a result is memoised against the exact bar array and
 * signature it came from. A crosshair move, a hover, or a sibling pane's
 * update therefore costs no arithmetic at all.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { noteRecent, studyById } from "./native/catalog";
import {
  normalizeParams, type NativeInputValue, type NativeParams,
} from "./native/registry";
import {
  computeWindow, HIDDEN_OUTPUT, newNativeStudy, runNativeStudy, StudyCache,
  studySignature,
  type AppliedNativeStudy, type NativeStudyOutput, type PlotStyleOverride,
  type Viewport,
} from "./native/compute";
import { pricePrecision } from "./movingAverages";
/*
 * Persistence lives in `native/storage` so the server sync can read and write
 * it without importing this hook, which imports the sync. Re-exported here
 * because every existing caller knows these names from this module.
 */
export {
  PRIMARY_SCOPE, clearStoredNative, copyStoredNativeForScope, loadStoredNative,
  nativeStorageKey, newStudyKey, saveStoredNative,
  type StoredNativeStudy,
} from "./native/storage";
import {
  PRIMARY_SCOPE, loadStoredNative, newStudyKey, saveStoredNative,
} from "./native/storage";
import {
  buildStudyGraph, sourceLabels, sourceOptionsFor, studySourceToken,
  type SourceIssue, type SourceOption,
} from "./native/graph";
import { pushPaneStudies, syncPaneStudies } from "./chartStateSync";
import type { ChartDecoration, ChartOverlay } from "./chartSeries";
import type { Candle } from "./types";
import type { Resolution } from "./resolution";

/** One study, as the panel and the legend want to read it. */
export interface NativeStudyRow {
  study: AppliedNativeStudy;
  name: string;
  category: string;
  overlay: boolean;
  /** Current value per plot id. */
  values: Record<string, number | null>;
  /** The window holds fewer bars than the study needs to say anything. */
  insufficient: boolean;
  /** Set when this study reads another and that reading cannot be honoured. */
  sourceIssue: SourceIssue | null;
}

export interface NativeStudiesApi {
  list: AppliedNativeStudy[];
  rows: NativeStudyRow[];
  overlays: ChartOverlay[];
  decorations: ChartDecoration[];
  add: (defId: string, params?: NativeParams) => string | null;
  remove: (key: string) => void;
  clear: () => void;
  toggleVisible: (key: string) => void;
  setParam: (key: string, param: string, value: NativeInputValue) => void;
  setStyle: (key: string, plotId: string, style: PlotStyleOverride) => void;
  resetParams: (key: string) => void;
  move: (key: string, direction: -1 | 1) => void;
  /**
   * Every source one study may legally be given, right now.
   *
   * A function of the pane rather than of the study, because whether reading
   * an RSI would close a cycle depends on what else is applied. The settings
   * dialog asks at the moment it opens the dropdown, so an option cannot be
   * offered and then refused.
   */
  sourceOptions: (key: string) => SourceOption[];
  /** Why a study cannot compute, keyed by instance. Empty on an ordinary pane. */
  issues: ReadonlyMap<string, SourceIssue>;
}

export interface NativeStudiesContext {
  candles: readonly Candle[];
  interval: Resolution;
  /**
   * Where the user is looking, in bars.
   *
   * Both halves matter: the SIZE decides how much each study computes, and the
   * POSITION decides which bars it computes over. Passing only a size anchored
   * every study to the newest bar, so panning back into loaded history left
   * them blank.
   */
  viewport?: Viewport;
  /**
   * Exactly which bars are on screen, in epoch milliseconds.
   *
   * `viewport` above is rounded to 200-bar buckets so a pan does not
   * invalidate every memoised study on every frame. That is right for a study
   * whose value at a bar is a function of that bar's history, and wrong for one
   * whose answer IS the range — a visible-range volume profile. Only studies
   * that declare `usesVisibleRange` see this, and only they key on it.
   */
  visibleRange?: { fromMs: number; toMs: number };
  scope?: string;
}

/**
 * The window assumed before the chart has reported one.
 *
 * Generous, and anchored at the newest bar, so the first paint is never short.
 */
const DEFAULT_VIEWPORT: Viewport = {
  firstVisibleIndex: Number.POSITIVE_INFINITY, visibleBars: 1_000,
};

export function useNativeStudies(ctx: NativeStudiesContext): NativeStudiesApi {
  const scope = ctx.scope ?? PRIMARY_SCOPE;
  const [list, setList] = useState<AppliedNativeStudy[]>([]);
  const cache = useRef(new StudyCache());

  /*
   * Restore once, on mount, from local storage AND from the server.
   *
   * Local first and synchronously, because the pane must paint what the user
   * had without waiting for a request — and because that is the answer if the
   * server cannot be reached. The remote reconciliation lands after, and only
   * replaces the list when the server actually has something (`syncPaneStudies`
   * owns that decision; see `lib/chartStateSync` for why each rule is there).
   *
   * The scope cannot change under a mounted pane, because a pane's id is its
   * identity.
   */
  useEffect(() => {
    const local = loadStoredNative(scope);
    if (local.length > 0) setList(local.map((s) => ({ ...s })));
    let live = true;
    void (async () => {
      const result = await syncPaneStudies(scope);
      if (!live) return;
      version.current = result.version;
      if (result.decision.action === "adopt") {
        setList(result.native.map((s) => ({ ...s })));
      }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** The server version this pane's next save is written against. */
  const version = useRef(0);
  const pushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (pushTimer.current) clearTimeout(pushTimer.current); }, []);

  // Skip the first pass: on mount `list` is still empty while the restore is
  // landing, and saving there would wipe the stored studies.
  const restored = useRef(false);
  useEffect(() => {
    if (!restored.current) { restored.current = true; return; }
    // Local storage immediately — the pane must survive a reload even offline.
    saveStoredNative(list, scope);
    /*
     * The server after a pause. Dragging a settings slider changes `list` on
     * every frame, and a request per frame would be a denial of service
     * against the user's own server.
     */
    if (pushTimer.current) clearTimeout(pushTimer.current);
    pushTimer.current = setTimeout(() => {
      void (async () => {
        // Only the built-in half. The Pine half belongs to `useIndicators`,
        // and sending `[]` for it would delete this pane's Pine studies.
        const result = await pushPaneStudies(scope, list, version.current);
        version.current = result.version;
        /*
         * Another device wrote first: its list is the truth now — but only
         * when the server actually holds this half. A refusal that carries an
         * empty list for a half nobody has ever written is not a deletion to
         * adopt, and adopting it would both wipe the user's studies and set
         * this effect writing an empty list on a loop. `adopted` is the one
         * thing that distinguishes those two refusals; `version` is now the
         * server's, so the next edit writes against the version that lands.
         */
        if (result.adopted) setList(result.native.map((s) => ({ ...s })));
      })();
    }, 1_200);
  }, [list, scope]);

  const precision = useMemo(
    () => pricePrecision(ctx.candles[ctx.candles.length - 1]?.close ?? 0),
    [ctx.candles]);
  const viewport = useMemo<Viewport>(() => {
    const requested = ctx.viewport ?? DEFAULT_VIEWPORT;
    const visibleBars = Math.max(1, Math.ceil(requested.visibleBars));
    // An unreported or out-of-range position means "the newest bars", which is
    // where a chart opens.
    const first = Number.isFinite(requested.firstVisibleIndex)
      ? Math.max(0, Math.trunc(requested.firstVisibleIndex))
      : Math.max(0, ctx.candles.length - visibleBars);
    return { firstVisibleIndex: first, visibleBars };
  }, [ctx.viewport, ctx.candles.length]);

  /*
   * Every visible study's output.
   *
   * `useMemo` on the bar array's identity, the list and the precision — the
   * three things that can change a result. The cache inside handles the case
   * this memo cannot: a re-render where only ONE study changed, so the other
   * eleven are returned without recomputation.
   */
  /**
   * The dependency graph of this pane's studies.
   *
   * Rebuilt whenever the list changes, which is cheap — it is a walk over at
   * most a few dozen instances — and it is what every other decision below
   * reads: compute order, which studies share a window, which cannot compute
   * at all, and what the settings dialog may offer as a source.
   */
  const graph = useMemo(
    () => buildStudyGraph(
      list, studyById,
      (study, def) => def.warmup(normalizeParams(def, study.params))),
    [list]);

  /*
   * Every visible study's output, in dependency order.
   *
   * ── Why the order and the windows are not per study ───────────────────────
   *
   * A study that reads another reads it BAR FOR BAR, so both must have been
   * computed over exactly the same bars — and the dependent needs more lead-in
   * than either alone, because its source has to have converged before its own
   * recursion starts. So a connected group is evaluated over ONE window, sized
   * by the deepest chain in it, in topological order, and each result's plot
   * arrays are handed to whatever reads them.
   *
   * A study with no chain — which is nearly all of them — is a group of one,
   * gets exactly the window it always got, and keeps exactly the memo key it
   * always had.
   *
   * ── What is still not computed ───────────────────────────────────────────
   *
   * A hidden study, UNLESS something reads it. Hiding an RSI that a moving
   * average is taken from is a statement about the RSI's line, not a request
   * to break the average — so it is computed and its overlays are dropped,
   * which is the one case where computing something invisible is right.
   */
  const outputs = useMemo(() => {
    const out = new Map<string, NativeStudyOutput>();
    const byKey = new Map(list.map((study) => [study.key, study]));
    const labels = sourceLabels(list, studyById);
    const readBy = new Set<string>();
    for (const edges of graph.edges.values()) {
      for (const edge of edges) readBy.add(edge.key);
    }
    const windows = graph.componentWarmup.map((warmup, index) => computeWindow(
      ctx.candles, warmup, viewport, graph.componentUnbounded[index] === true));

    /** Resolved plot arrays, keyed by the token a dependent names them with. */
    const series: Record<string, readonly number[]> = {};
    /** Each study's full signature, so a dependent's key follows its source's. */
    const signatures = new Map<string, string>();

    for (const key of graph.order) {
      const study = byKey.get(key);
      if (!study) continue;
      const def = studyById(study.defId);
      if (!def) continue;
      const index = graph.component.get(key) ?? 0;
      const edges = graph.edges.get(key) ?? [];

      /*
       * The group's shared window and this study's own sources are both part
       * of what produced the result, so both are part of its key. For a lone
       * study neither exists and the key is byte-identical to what it was
       * before any of this: an ordinary chart's cache behaviour is unchanged.
       */
      const grouped = (graph.componentSize[index] ?? 1) > 1;
      const sourceSignature = grouped
        ? `w${graph.componentWarmup[index]}:${
          edges.map((edge) => `${edge.token}=${signatures.get(edge.key) ?? "?"}`).join("+")}`
        : undefined;
      const signature = studySignature(
        study, def, precision, viewport, ctx.visibleRange, sourceSignature);
      signatures.set(key, signature);

      const issue = graph.issues.get(key);
      const needed = study.visible || readBy.has(key);
      if (issue || !needed) {
        out.set(key, HIDDEN_OUTPUT);
        continue;
      }

      const cached = cache.current.get(study, ctx.candles, signature);
      const result = cached ?? runNativeStudy(
        def, study, windows[index] ?? ctx.candles, ctx.interval, precision,
        {
          visibleRange: ctx.visibleRange,
          sources: series,
          sourceLabels: labels,
          captureSeries: readBy.has(key),
        });
      if (!cached) cache.current.set(study, ctx.candles, signature, result);
      out.set(key, result);
      if (result.series) {
        for (const [plotId, values] of Object.entries(result.series)) {
          series[studySourceToken(key, plotId)] = values;
        }
      }
    }
    return out;
  }, [list, graph, ctx.candles, ctx.interval, precision, viewport, ctx.visibleRange]);

  const rows = useMemo<NativeStudyRow[]>(() => list.flatMap((study) => {
    const def = studyById(study.defId);
    if (!def) return [];
    const output = outputs.get(study.key);
    const issue = graph.issues.get(study.key) ?? null;
    return [{
      study,
      name: def.name,
      category: def.category,
      overlay: def.overlay,
      values: output?.values ?? {},
      /*
       * A study that cannot compute is not a study without enough history.
       * Saying "not enough bars" about an average whose source was deleted
       * sends the reader to load more history, which will never help.
       */
      insufficient: issue === null && (output?.insufficient ?? false),
      sourceIssue: issue,
    }];
  }), [list, outputs, graph]);

  const overlays = useMemo<ChartOverlay[]>(
    () => list.filter((s) => s.visible).flatMap((s) => outputs.get(s.key)?.overlays ?? []),
    [list, outputs]);
  const decorations = useMemo<ChartDecoration[]>(
    () => list.filter((s) => s.visible).flatMap((s) => outputs.get(s.key)?.decorations ?? []),
    [list, outputs]);

  const add = useCallback((defId: string, params?: NativeParams): string | null => {
    const def = studyById(defId);
    if (!def) return null;
    const study = newNativeStudy(def, newStudyKey());
    if (params) study.params = normalizeParams(def, params);
    setList((current) => [...current, study]);
    noteRecent(def.id);
    return study.key;
  }, []);

  const remove = useCallback((key: string) => {
    cache.current.forget(key);
    setList((current) => current.filter((s) => s.key !== key));
  }, []);

  const clear = useCallback(() => {
    cache.current.clear();
    setList([]);
  }, []);

  const toggleVisible = useCallback((key: string) => {
    setList((current) => current.map(
      (s) => (s.key === key ? { ...s, visible: !s.visible } : s)));
  }, []);

  const setParam = useCallback((key: string, param: string, value: NativeInputValue) => {
    setList((current) => current.map((s) => {
      if (s.key !== key) return s;
      const def = studyById(s.defId);
      if (!def) return s;
      // Normalised on the way in, so an out-of-range value from a dragged
      // slider or a pasted string never reaches a study's arithmetic.
      return { ...s, params: normalizeParams(def, { ...s.params, [param]: value }) };
    }));
  }, []);

  const setStyle = useCallback((key: string, plotId: string, style: PlotStyleOverride) => {
    setList((current) => current.map((s) => (s.key === key
      ? { ...s, styles: { ...s.styles, [plotId]: { ...s.styles[plotId], ...style } } }
      : s)));
  }, []);

  const resetParams = useCallback((key: string) => {
    setList((current) => current.map((s) => {
      if (s.key !== key) return s;
      const def = studyById(s.defId);
      if (!def) return s;
      return { ...s, params: normalizeParams(def, undefined), styles: {} };
    }));
  }, []);

  /** Order decides layering, so it is a user-visible property. */
  const move = useCallback((key: string, direction: -1 | 1) => {
    setList((current) => {
      const index = current.findIndex((s) => s.key === key);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= current.length) return current;
      const next = current.slice();
      const [moved] = next.splice(index, 1);
      next.splice(target, 0, moved!);
      return next;
    });
  }, []);

  /*
   * Read through a ref so the callback identity is stable.
   *
   * The dialog holds it across renders; rebuilding it whenever the list
   * changed would remount the dropdown mid-choice, and the answer must be the
   * CURRENT list rather than the one at the last render regardless.
   */
  const listRef = useRef(list);
  listRef.current = list;
  const sourceOptions = useCallback(
    (key: string) => sourceOptionsFor(listRef.current, studyById, key), []);

  return useMemo(() => ({
    list, rows, overlays, decorations,
    add, remove, clear, toggleVisible, setParam, setStyle, resetParams, move,
    sourceOptions, issues: graph.issues,
  }), [list, rows, overlays, decorations,
    add, remove, clear, toggleVisible, setParam, setStyle, resetParams, move,
    sourceOptions, graph.issues]);
}
