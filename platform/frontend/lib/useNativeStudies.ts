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
import type { ChartDecoration, ChartOverlay } from "./chartSeries";
import type { Candle, Interval } from "./types";

/** What survives a reload. Run output is always recomputed, never stored. */
export interface StoredNativeStudy {
  key: string;
  defId: string;
  params: NativeParams;
  visible: boolean;
  styles: Record<string, PlotStyleOverride>;
}

const STORAGE_KEY = "tv.nativeStudies.v1";

/**
 * Per pane, like Pine studies.
 *
 * The first pane keeps the unsuffixed key for the same reason
 * `lib/indicators` does: it is the chart an existing user already has.
 */
export const PRIMARY_SCOPE = "p1";

export function nativeStorageKey(scope: string): string {
  return scope === PRIMARY_SCOPE ? STORAGE_KEY : `${STORAGE_KEY}.${scope}`;
}

export function newStudyKey(): string {
  return `nat_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Read a pane's stored studies.
 *
 * Total. A corrupt entry, a hand-edited file, a study id this build does not
 * have: each row is dropped individually rather than losing the whole list,
 * because losing eleven good studies because the twelfth named something
 * unknown is the worst possible response to a forward-compatible file.
 */
export function loadStoredNative(scope: string = PRIMARY_SCOPE): StoredNativeStudy[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(nativeStorageKey(scope));
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((row) => {
      const entry = row as Partial<StoredNativeStudy>;
      if (typeof entry?.defId !== "string") return [];
      const def = studyById(entry.defId);
      if (!def) return [];
      return [{
        key: typeof entry.key === "string" && entry.key ? entry.key : newStudyKey(),
        defId: def.id,
        params: normalizeParams(def, entry.params as NativeParams | undefined),
        visible: entry.visible !== false,
        styles: sanitizeStyles(def.plots.map((p) => p.id), entry.styles),
      }];
    });
  } catch {
    return [];
  }
}

/** Keep only overrides for plots this build's definition actually declares. */
function sanitizeStyles(
  plotIds: readonly string[], raw: unknown
): Record<string, PlotStyleOverride> {
  const out: Record<string, PlotStyleOverride> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!plotIds.includes(id) || !value || typeof value !== "object") continue;
    const style = value as PlotStyleOverride;
    const kept: PlotStyleOverride = {};
    if (typeof style.color === "string") kept.color = style.color;
    if (typeof style.width === "number" && Number.isFinite(style.width)) {
      kept.width = Math.max(1, Math.min(8, Math.round(style.width)));
    }
    if (typeof style.visible === "boolean") kept.visible = style.visible;
    if (typeof style.style === "string") kept.style = style.style;
    if (Object.keys(kept).length > 0) out[id] = kept;
  }
  return out;
}

export function saveStoredNative(
  list: readonly AppliedNativeStudy[], scope: string = PRIMARY_SCOPE
): void {
  if (typeof window === "undefined") return;
  const slim: StoredNativeStudy[] = list.map((s) => ({
    key: s.key, defId: s.defId, params: s.params, visible: s.visible, styles: s.styles,
  }));
  try { window.localStorage.setItem(nativeStorageKey(scope), JSON.stringify(slim)); }
  catch { /* quota — the list is a convenience until Wave C's server store */ }
}

export function clearStoredNative(scope: string): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.removeItem(nativeStorageKey(scope)); }
  catch { /* nothing to do */ }
}

/** A copy of one pane's studies for another, with params and styles cloned. */
export function copyStoredNativeForScope(from: string, to: string): void {
  if (typeof window === "undefined" || from === to) return;
  try {
    window.localStorage.setItem(nativeStorageKey(to), JSON.stringify(
      loadStoredNative(from).map((s) => ({
        ...s, key: newStudyKey(), params: { ...s.params }, styles: { ...s.styles },
      }))
    ));
  } catch { /* quota — the new pane starts with no built-in studies */ }
}

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

  // Restore once, on mount. The scope cannot change under a mounted pane,
  // because a pane's id is its identity.
  useEffect(() => {
    const restored = loadStoredNative(scope);
    if (restored.length > 0) setList(restored.map((s) => ({ ...s })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Skip the first pass: on mount `list` is still empty while the restore is
  // landing, and saving there would wipe the stored studies.
  const restored = useRef(false);
  useEffect(() => {
    if (!restored.current) { restored.current = true; return; }
    saveStoredNative(list, scope);
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
