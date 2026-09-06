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
 * Total. A corrupt entry or a hand-edited file loses that row rather than the
 * whole list, because losing eleven good studies because the twelfth was
 * malformed is the worst possible response to a forward-compatible file.
 *
 * ── An id this build does not have ─────────────────────────────────────────
 *
 * That is a different case from a corrupt one, and it used to be treated the
 * same: the row was dropped, and the very next save wrote the pruned list
 * back — so an older build permanently deleted a newer build's study, from
 * disk and then from the shared server row. A study this build cannot draw is
 * still a study the USER applied, and losing it is not this build's decision
 * to make.
 *
 * So unknown rows are carried through unchanged, kept out of everything that
 * would try to compute them, and written back exactly as they were found.
 * `unknownStoredNative` returns them; `loadStoredNative` returns only what
 * this build can run.
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

/**
 * The stored rows this build cannot run, exactly as they were found.
 *
 * Preserved so a save does not delete a study a newer build applied. They are
 * never normalised, never styled and never computed — this build has no
 * definition to do any of that against, and inventing one would be worse than
 * carrying the row.
 */
export function unknownStoredNative(scope: string = PRIMARY_SCOPE): unknown[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(nativeStorageKey(scope));
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((row) => {
      const entry = row as Partial<StoredNativeStudy>;
      // A row with no id at all is malformed rather than from the future, and
      // there is nothing to preserve it FOR.
      if (typeof entry?.defId !== "string") return false;
      return studyById(entry.defId) === null;
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

/**
 * Write this pane's studies, keeping the ones this build cannot run.
 *
 * The unknown rows are read back from storage and appended, so a save is never
 * the act that deletes a newer build's study. They are appended rather than
 * interleaved because their original position is not recoverable from a list
 * this build has already filtered — and order only decides layering, which is
 * a smaller loss than the study itself.
 */
export function saveStoredNative(
  list: readonly StoredNativeStudy[], scope: string = PRIMARY_SCOPE
): void {
  if (typeof window === "undefined") return;
  const slim: unknown[] = list.map((s) => ({
    key: s.key, defId: s.defId, params: s.params, visible: s.visible, styles: s.styles,
  }));
  const preserved = unknownStoredNative(scope);
  try {
    window.localStorage.setItem(
      nativeStorageKey(scope), JSON.stringify([...slim, ...preserved]));
  } catch { /* quota — the list is a convenience; the server store is the truth */ }
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

