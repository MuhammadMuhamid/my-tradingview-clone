/**
 * Reading and writing the arrangement a saved layout carries.
 *
 * ── Why this is separate ───────────────────────────────────────────────────
 *
 * TVP8: a saved layout held a symbol, a timeframe, a strategy and its
 * parameters — and its own docstring claimed it "snapshots the whole
 * workspace" and listed drawings among what it carries. It carried neither.
 * The applied studies, the drawings, the chart type, the per-pane chart
 * settings, the price scale and the pane grid were all localStorage-only, so
 * opening a saved layout restored a symbol onto whatever the browser happened
 * to be showing. Two independent reviews flagged the sentence as false before
 * anyone noticed the feature was.
 *
 * The pieces already have owners — `lib/workspace.ts` persists the panes,
 * `lib/native/storage.ts` the studies, `lib/drawingStore.ts` the drawings — so
 * this collects and restores what those own rather than defining a second view
 * model that would drift from all three.
 *
 * ── What it does NOT do ────────────────────────────────────────────────────
 *
 * It does not validate. Every read below goes back through the owner's own
 * normaliser, which is total by construction: a record this build cannot
 * understand restores what it can and drops the rest, exactly as the
 * localStorage path already does. A layout from a newer build must degrade,
 * never throw — a saved arrangement that can break the page it restores into
 * is worse than one that restores partially.
 */
import { loadStoredNative, nativeStorageKey, saveStoredNative } from "./native/storage";
import { drawingStore } from "./drawingStore";
import { parseWorkspace, WORKSPACE_STORAGE_KEY, type ChartWorkspace } from "./workspace";
import type { LayoutWorkspace } from "./layouts";
import type { Drawing } from "./drawings";

/** Every pane scope a workspace holds, so studies are collected per pane. */
function scopesOf(workspace: ChartWorkspace | null): string[] {
  return workspace ? workspace.panes.map((pane) => pane.id) : [];
}

/** The symbols the panes are showing, which is whose drawings a layout carries. */
function symbolsOf(workspace: ChartWorkspace | null): string[] {
  return [...new Set(workspace ? workspace.panes.map((pane) => pane.symbol) : [])];
}

/**
 * Collect the arrangement currently on screen.
 *
 * `panes` is taken from localStorage rather than from the live object so that
 * what is SAVED is exactly what a reload would restore — if the two ever
 * disagree, the stored one is the one the user would get back, and saving the
 * other would make a layout restore something the browser never shows.
 */
export function captureLayoutWorkspace(): LayoutWorkspace | undefined {
  if (typeof window === "undefined") return undefined;
  let panes: unknown = null;
  try {
    const raw = window.localStorage.getItem(WORKSPACE_STORAGE_KEY);
    panes = raw === null ? null : JSON.parse(raw);
  } catch { panes = null; }

  const workspace = panes as ChartWorkspace | null;
  const studies: Record<string, unknown> = {};
  for (const scope of scopesOf(workspace)) {
    const stored = loadStoredNative(scope);
    if (stored.length > 0) studies[scope] = stored;
  }
  const drawings: Record<string, Drawing[]> = {};
  for (const symbol of symbolsOf(workspace)) {
    const held = drawingStore.get(symbol);
    if (held.length > 0) drawings[symbol] = held;
  }

  if (panes === null && Object.keys(studies).length === 0
    && Object.keys(drawings).length === 0) return undefined;
  return { panes, studies, drawings };
}

/** The pane record as it currently stands, or null when there is none to read. */
function readStoredPanes(): unknown {
  try {
    const raw = window.localStorage.getItem(WORKSPACE_STORAGE_KEY);
    return raw === null ? null : JSON.parse(raw);
  } catch { return null; }
}

/**
 * Do two pane records describe the same workspace?
 *
 * Compared through `parseWorkspace` rather than as text, because the two sides
 * are never written by the same writer. A layout's copy has round-tripped
 * through the backend's `jsonb` column, which does not preserve key order, so
 * it re-serialises differently from the byte-identical record the browser
 * wrote — and `parseWorkspace` is the canonical form the page itself reads, so
 * two records it cannot tell apart are two records the user cannot either.
 *
 * Two unreadable records are the same answer, not a difference: both restore
 * the default, so there is nothing for a reload to find.
 */
function sameWorkspace(a: unknown, b: unknown): boolean {
  return JSON.stringify(parseWorkspace(a)) === JSON.stringify(parseWorkspace(b));
}

/**
 * Put a layout's arrangement back.
 *
 * Returns whether the pane record CHANGED, because that is the part the caller
 * has to reload to take effect — the studies and the drawings are read from
 * their stores on the next render, and the pane record is read once at mount.
 *
 * "Changed", not "was written". The layout the user left open is restored at
 * MOUNT, so answering "restored" for a record that already holds exactly what
 * `lib/workspace.ts` just read reloads into the same restore, which restores
 * and reloads again — the page never finishes loading. A reload the record
 * does not need buys nothing anyway: there is nothing new for the mount read
 * to find.
 */
export function restoreLayoutWorkspace(held: LayoutWorkspace | undefined): boolean {
  if (typeof window === "undefined" || !held) return false;

  if (held.studies && typeof held.studies === "object") {
    for (const [scope, list] of Object.entries(held.studies as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      try {
        // Through the owner's own writer, so the stored shape stays its
        // business and a malformed row is dropped by its reader on the way out.
        saveStoredNative(list as never, scope);
      } catch { /* one unreadable scope must not lose the others */ }
    }
  }

  if (held.drawings && typeof held.drawings === "object") {
    for (const [symbol, list] of Object.entries(held.drawings as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      try { drawingStore.set(symbol, list as Drawing[], "layout"); }
      catch { /* likewise */ }
    }
  }

  if (held.panes && typeof held.panes === "object") {
    try {
      const current = readStoredPanes();
      window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(held.panes));
      return !sameWorkspace(current, held.panes);
    } catch { /* private window: the symbol and timeframe still restore */ }
  }
  return false;
}

/** Study scopes a layout holds, for the tests and for a caller clearing first. */
export function layoutStudyScopes(held: LayoutWorkspace | undefined): string[] {
  if (!held?.studies || typeof held.studies !== "object") return [];
  return Object.keys(held.studies as Record<string, unknown>)
    .map((scope) => nativeStorageKey(scope));
}
