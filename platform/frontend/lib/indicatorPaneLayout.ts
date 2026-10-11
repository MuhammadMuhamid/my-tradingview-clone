/**
 * How the stack of indicator panes under a chart is arranged.
 *
 * ── Why this is state and not a component's business ───────────────────────
 *
 * An indicator pane's *configuration* — its script, its inputs, its output —
 * belongs to `useIndicators` on the chart pane that owns the study. What is
 * held here is the far smaller question of how the stack is presented: the
 * order the panes are drawn in, which are collapsed, how tall each one is, and
 * whether one of them is currently taking the whole chart column.
 *
 * It lives outside the pane component for one reason: maximising a pane, or
 * collapsing it, must not be able to destroy anything. If the height and the
 * collapsed flag were `useState` inside `IndicatorPane`, then any presentation
 * change that unmounted a pane would silently throw them away, and "restore
 * returns to exactly the previous structure" would be false in a way nobody
 * would notice until they had arranged three oscillators by hand.
 *
 * Everything here is a pure transition over a plain record, so the whole of
 * collapse / expand / move / maximise / restore is testable without a chart.
 */

export interface PaneLayoutState {
  /**
   * Display order, by pane id. Ids the chart no longer has are pruned, and ids
   * it has gained are appended — so a newly added study lands at the bottom of
   * the stack, where a user who just added it expects to find it.
   */
  order: string[];
  collapsed: Record<string, boolean>;
  /** Heights the user has dragged to. Absent means "use the default". */
  heights: Record<string, number>;
  /** The pane currently given the whole chart column, or null. */
  maximizedId: string | null;
}

export const EMPTY_PANE_LAYOUT: PaneLayoutState = {
  order: [], collapsed: {}, heights: {}, maximizedId: null,
};

/** The height of a pane showing only its header. */
export const COLLAPSED_PANE_HEIGHT = 24;

export const MIN_PANE_HEIGHT = 72;
export const MAX_PANE_HEIGHT = 360;

export function clampPaneHeight(height: number): number {
  if (!Number.isFinite(height)) return MIN_PANE_HEIGHT;
  return Math.max(MIN_PANE_HEIGHT, Math.min(MAX_PANE_HEIGHT, Math.round(height)));
}

/**
 * The part of the arrangement that survives a reload (B-09, B-15).
 *
 * Order and dragged heights, by pane id. A comparison pane added last came
 * back first, because without this the order was whatever order the panes'
 * data happened to be assembled in — and every dragged height was forgotten.
 * Collapse and maximise are moment-to-moment and are deliberately not kept.
 */
export interface SavedPaneLayout {
  order: string[];
  heights: Record<string, number>;
}

/**
 * Bring the layout into line with the panes that actually exist.
 *
 * Returns the SAME object when nothing changed, so a caller can store this in
 * React state and re-run it on every render without causing one.
 *
 * With a `saved` arrangement, a pane arriving for the first time takes its
 * saved height, and every pane the saved order ranks is put in that order
 * within the slots ranked panes occupy — so panes landing one at a time in
 * any order still end up where they were. A pane the saved order has never
 * seen keeps the place it arrived in.
 */
export function reconcilePaneLayout(
  state: PaneLayoutState, presentIds: readonly string[],
  saved: SavedPaneLayout | null = null,
): PaneLayoutState {
  const present = new Set(presentIds);
  const kept = state.order.filter((id) => present.has(id));
  const known = new Set(kept);
  const added = presentIds.filter((id) => !known.has(id));
  let order = added.length === 0 && kept.length === state.order.length
    ? state.order : [...kept, ...added];
  if (saved && added.length > 0) {
    const rank = new Map(saved.order.map((id, i) => [id, i]));
    const slots = order.flatMap((id, i) => (rank.has(id) ? [i] : []));
    const ranked = slots.map((i) => order[i]!).sort((a, b) => rank.get(a)! - rank.get(b)!);
    if (ranked.some((id, i) => order[slots[i]!] !== id)) {
      order = [...order];
      slots.forEach((slot, i) => { order[slot] = ranked[i]!; });
    }
  }

  const collapsed = pruneRecord(state.collapsed, present);
  let heights = pruneRecord(state.heights, present);
  if (saved) {
    const restored = added.filter((id) =>
      heights[id] === undefined && typeof saved.heights[id] === "number");
    if (restored.length > 0) {
      heights = { ...heights };
      for (const id of restored) heights[id] = clampPaneHeight(saved.heights[id]!);
    }
  }
  const maximizedId = state.maximizedId !== null && !present.has(state.maximizedId)
    ? null : state.maximizedId;

  if (order === state.order && collapsed === state.collapsed
    && heights === state.heights && maximizedId === state.maximizedId) return state;
  return { order, collapsed, heights, maximizedId };
}

function pruneRecord<T>(
  record: Record<string, T>, present: Set<string>
): Record<string, T> {
  const keys = Object.keys(record);
  if (keys.every((key) => present.has(key))) return record;
  const next: Record<string, T> = {};
  for (const key of keys) if (present.has(key)) next[key] = record[key]!;
  return next;
}

/** At most this many ids are remembered; the oldest absent ones go first. */
const SAVED_ORDER_LIMIT = 40;

/**
 * The arrangement to persist, given what is on screen and what was saved.
 *
 * A pane that is in the saved order but not on screen is KEPT, after the
 * neighbour it followed — because mid-reload "not on screen" usually means
 * "its data has not landed yet", and writing back the partial stack would
 * lose the very places this exists to keep. A removed study's id lingers
 * harmlessly: a re-added study gets a new id, so the rank is never reused.
 */
export function savedPaneLayout(
  state: PaneLayoutState, previous: SavedPaneLayout | null,
): SavedPaneLayout {
  const order = [...state.order];
  if (previous) {
    const placed = new Set(order);
    let after: string | null = null;
    for (const id of previous.order) {
      if (!placed.has(id)) {
        order.splice(after === null ? 0 : order.indexOf(after) + 1, 0, id);
        placed.add(id);
      }
      after = id;
    }
  }
  const visible = new Set(state.order);
  while (order.length > SAVED_ORDER_LIMIT) {
    const stale = order.findIndex((id) => !visible.has(id));
    order.splice(stale >= 0 ? stale : 0, 1);
  }
  const kept = new Set(order);
  const heights: Record<string, number> = {};
  for (const [id, h] of Object.entries({ ...(previous?.heights ?? {}), ...state.heights })) {
    if (kept.has(id)) heights[id] = h;
  }
  return { order, heights };
}

/** Whether two saved arrangements say the same thing. */
export function sameSavedPaneLayout(
  a: SavedPaneLayout | null | undefined, b: SavedPaneLayout | null | undefined,
): boolean {
  if (!a || !b) return !a && !b;
  if (a.order.length !== b.order.length || a.order.some((id, i) => b.order[i] !== id)) return false;
  const ak = Object.keys(a.heights);
  return ak.length === Object.keys(b.heights).length
    && ak.every((id) => a.heights[id] === b.heights[id]);
}

/** The panes in display order. Anything the layout has not seen keeps its place. */
export function orderedPanes<T extends { id: string }>(
  state: PaneLayoutState, panes: readonly T[]
): T[] {
  if (state.order.length === 0) return [...panes];
  const byId = new Map(panes.map((pane) => [pane.id, pane]));
  const out: T[] = [];
  for (const id of state.order) {
    const pane = byId.get(id);
    if (pane) { out.push(pane); byId.delete(id); }
  }
  for (const pane of panes) if (byId.has(pane.id)) out.push(pane);
  return out;
}

export function canMovePane(
  state: PaneLayoutState, id: string, direction: -1 | 1
): boolean {
  const index = state.order.indexOf(id);
  if (index < 0) return false;
  const target = index + direction;
  return target >= 0 && target < state.order.length;
}

/** Move one pane up or down the stack. A move that would fall off is a no-op. */
export function movePane(
  state: PaneLayoutState, id: string, direction: -1 | 1
): PaneLayoutState {
  if (!canMovePane(state, id, direction)) return state;
  const index = state.order.indexOf(id);
  const order = [...state.order];
  const target = index + direction;
  [order[index], order[target]] = [order[target]!, order[index]!];
  return { ...state, order };
}

export function isPaneCollapsed(state: PaneLayoutState, id: string): boolean {
  return state.collapsed[id] === true;
}

/**
 * Collapse or expand one pane.
 *
 * Collapsing the maximised pane also restores the layout: a pane that is both
 * "taking the whole column" and "showing only its header" is not a state with
 * a meaning, and leaving it reachable would strand the chart column empty.
 */
export function togglePaneCollapsed(state: PaneLayoutState, id: string): PaneLayoutState {
  const next = !isPaneCollapsed(state, id);
  return {
    ...state,
    collapsed: { ...state.collapsed, [id]: next },
    maximizedId: next && state.maximizedId === id ? null : state.maximizedId,
  };
}

export function isPaneMaximized(state: PaneLayoutState, id: string): boolean {
  return state.maximizedId === id;
}

/**
 * Give one pane the whole chart column, or give the column back.
 *
 * Nothing is destroyed and nothing is recreated: this is one field, and every
 * pane's height, collapsed flag and position in the stack is exactly where it
 * was when the column is handed back. Maximising a collapsed pane expands it,
 * because the alternative is a full-height header.
 */
export function togglePaneMaximized(state: PaneLayoutState, id: string): PaneLayoutState {
  if (state.maximizedId === id) return { ...state, maximizedId: null };
  return {
    ...state,
    maximizedId: id,
    collapsed: isPaneCollapsed(state, id)
      ? { ...state.collapsed, [id]: false } : state.collapsed,
  };
}

export function restorePaneLayout(state: PaneLayoutState): PaneLayoutState {
  return state.maximizedId === null ? state : { ...state, maximizedId: null };
}

/** The height a pane should be drawn at, given the default for the stack. */
export function paneHeight(
  state: PaneLayoutState, id: string, defaultHeight: number
): number {
  if (isPaneCollapsed(state, id)) return COLLAPSED_PANE_HEIGHT;
  const stored = state.heights[id];
  return stored === undefined ? defaultHeight : stored;
}

export function setPaneHeight(
  state: PaneLayoutState, id: string, height: number
): PaneLayoutState {
  return { ...state, heights: { ...state.heights, [id]: clampPaneHeight(height) } };
}
