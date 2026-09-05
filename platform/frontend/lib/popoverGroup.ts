"use client";
/**
 * One popover open at a time, across components that do not know about each
 * other.
 *
 * ── The defect ─────────────────────────────────────────────────────────────
 *
 * The toolbar's popovers — layout preset, sync, saved layouts, chart type,
 * More — each held their own `open` boolean. Nothing coordinated them, so
 * clicking one while another was open left both on screen, overlapping, with
 * two sets of controls competing for the same clicks. Every one of them is a
 * menu attached to a button a few pixels from its neighbours, which is exactly
 * where that happens.
 *
 * ── Why a module-scope registry and not a context ──────────────────────────
 *
 * Because the popovers are not in one provider tree and never will be: the
 * chart type control lives in the toolbar's second row, the sync menu in the
 * first, and the workspace does not otherwise care that either exists. A
 * context would mean threading a provider around a component boundary for a
 * fact that is genuinely global to the tab: which single popover is open.
 *
 * This holds no DOM, no timers and no cleanup obligations beyond
 * unsubscribing. Closing everything is `closeAllPopovers()`, which the Escape
 * key and a route change can both call without knowing what is open.
 */

type Listener = (openId: string | null) => void;

let openId: string | null = null;
const listeners = new Set<Listener>();

function publish(): void {
  for (const listener of listeners) listener(openId);
}

/** Open this popover, closing whichever other one was open. */
export function openPopover(id: string): void {
  if (openId === id) return;
  openId = id;
  publish();
}

/** Close this popover, if it is the one that is open. */
export function closePopover(id: string): void {
  if (openId !== id) return;
  openId = null;
  publish();
}

export function closeAllPopovers(): void {
  if (openId === null) return;
  openId = null;
  publish();
}

export function currentPopover(): string | null {
  return openId;
}

export function subscribePopovers(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Test seam: the registry is module state, so a test must be able to clear it. */
export function resetPopovers(): void {
  openId = null;
  listeners.clear();
}
