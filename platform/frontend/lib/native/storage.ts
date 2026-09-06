"use client";
/**
 * Where a pane's built-in studies live between sessions.
 *
 * Split out of `useNativeStudies` when the server store arrived: the sync
 * client needs to read and write this, and the hook needs the sync client, so
 * leaving them in one module made a cycle. Storage is the smaller, purer half,
 * so it is the half that moved.
 *
 * Everything here is total. A corrupt entry, a hand-edited file, a study id
 * this build does not have: each is dropped individually rather than losing
 * the whole list, because losing eleven good studies because the twelfth named
 * something unknown is the worst possible response to a forward-compatible
 * file — and one written by a NEWER build is exactly that.
 */
import { studyById } from "./catalog";
import { normalizeParams, type NativeParams } from "./registry";
import type { PlotStyleOverride } from "./compute";

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
  list: readonly StoredNativeStudy[], scope: string = PRIMARY_SCOPE
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

