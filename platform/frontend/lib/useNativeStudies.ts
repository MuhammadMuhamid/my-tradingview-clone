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
import { pushPaneStudies, syncPaneStudies } from "./chartStateSync";
import type { ChartDecoration, ChartOverlay } from "./chartSeries";
import type { Candle, Interval } from "./types";

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
}

export interface NativeStudiesContext {
  candles: readonly Candle[];
  interval: Interval;
  /**
   * Where the user is looking, in bars.
   *
   * Both halves matter: the SIZE decides how much each study computes, and the
   * POSITION decides which bars it computes over. Passing only a size anchored
   * every study to the newest bar, so panning back into loaded history left
   * them blank.
   */
  viewport?: Viewport;
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
  const outputs = useMemo(() => {
    const out = new Map<string, NativeStudyOutput>();
    for (const study of list) {
      const def = studyById(study.defId);
      if (!def) continue;
      // A hidden study is not computed at all. It used to be computed and then
      // filtered out, which is the opposite of what the windowing exists for.
      if (!study.visible) { out.set(study.key, HIDDEN_OUTPUT); continue; }
      const signature = studySignature(study, def, precision, viewport);
      const cached = cache.current.get(study, ctx.candles, signature);
      if (cached) { out.set(study.key, cached); continue; }
      const window = computeWindow(
        ctx.candles, def.warmup(normalizeParams(def, study.params)),
        viewport, def.unbounded === true);
      const result = runNativeStudy(def, study, window, ctx.interval, precision);
      cache.current.set(study, ctx.candles, signature, result);
      out.set(study.key, result);
    }
    return out;
  }, [list, ctx.candles, ctx.interval, precision, viewport]);

  const rows = useMemo<NativeStudyRow[]>(() => list.flatMap((study) => {
    const def = studyById(study.defId);
    if (!def) return [];
    const output = outputs.get(study.key);
    return [{
      study,
      name: def.name,
      category: def.category,
      overlay: def.overlay,
      values: output?.values ?? {},
      insufficient: output?.insufficient ?? false,
    }];
  }), [list, outputs]);

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

  return useMemo(() => ({
    list, rows, overlays, decorations,
    add, remove, clear, toggleVisible, setParam, setStyle, resetParams, move,
  }), [list, rows, overlays, decorations,
    add, remove, clear, toggleVisible, setParam, setStyle, resetParams, move]);
}
