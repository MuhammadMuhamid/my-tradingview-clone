/**
 * Where a context menu goes, and what it means to be in one.
 *
 * ── Why the placement is arithmetic rather than CSS ───────────────────────
 *
 * A menu opened by a right-click near the bottom-right of a chart must not
 * open off-screen, and it must not be scrolled into view either — scrolling
 * the chart is exactly what a chart must not do while a user is aiming at a
 * price. The correct behaviour is to flip the menu back across the pointer,
 * and if it still does not fit, to clamp it inside the viewport. That is four
 * lines of arithmetic and no layout thrash, and it is testable without a
 * browser, which is why it lives here rather than in a component.
 *
 * ── Why one primitive and not one per menu ────────────────────────────────
 *
 * There are five payloads in this product — the chart, a drawing, an indicator,
 * the price axis and a watchlist row — and a menu is not the sum of its items.
 * Escape closing it, an outside click closing it, focus returning to whatever
 * opened it, arrow keys moving through only the ENABLED items, Home and End,
 * and the separator that is skipped rather than focused: those are the menu.
 * Written five times they would be right in two places and subtly wrong in
 * three, and the wrong ones would be the ones a keyboard user meets.
 */

export interface MenuGeometry {
  /** Where the pointer was, in viewport coordinates. */
  x: number;
  y: number;
  /** The menu's measured size. */
  width: number;
  height: number;
  /** The viewport it must stay inside. */
  viewportWidth: number;
  viewportHeight: number;
  /** Breathing room from the viewport edge. */
  margin?: number;
}

export interface MenuPlacement {
  left: number;
  top: number;
  /** The menu opens leftwards / upwards from the pointer. */
  flippedX: boolean;
  flippedY: boolean;
  /**
   * The tallest the panel may be, in pixels.
   *
   * A menu taller than the viewport used to be clamped to the top margin and
   * rendered `overflow-hidden` with no bound, so its bottom items were simply
   * cut off — and arrowing moved the cursor onto items that were not on
   * screen. The caller applies this with `overflow-y: auto`, which is the only
   * way a `position: fixed` panel can be scrolled at all.
   */
  maxHeight: number;
}

const DEFAULT_MARGIN = 8;

/**
 * Place a menu so it is fully visible, preferring down-and-right of the pointer.
 *
 * Flip first, clamp second. Clamping alone would slide the menu so that the
 * pointer sits in the middle of it, and the item under the cursor when the
 * button is released would be one the user never aimed at.
 */
export function placeMenu(geometry: MenuGeometry): MenuPlacement {
  const margin = geometry.margin ?? DEFAULT_MARGIN;
  const maxLeft = geometry.viewportWidth - geometry.width - margin;
  const maxTop = geometry.viewportHeight - geometry.height - margin;

  const flippedX = geometry.x + geometry.width + margin > geometry.viewportWidth
    && geometry.x - geometry.width >= margin;
  const flippedY = geometry.y + geometry.height + margin > geometry.viewportHeight
    && geometry.y - geometry.height >= margin;

  const left = flippedX ? geometry.x - geometry.width : geometry.x;
  const top = flippedY ? geometry.y - geometry.height : geometry.y;

  const placedTop = Math.max(margin, Math.min(top, Math.max(margin, maxTop)));
  return {
    left: Math.max(margin, Math.min(left, Math.max(margin, maxLeft))),
    top: placedTop,
    flippedX,
    flippedY,
    // Whatever is left below the panel's top edge, never more than the menu
    // actually needs — a short menu must not grow a scrollbar's worth of space.
    maxHeight: Math.max(0, geometry.viewportHeight - margin - placedTop),
  };
}

export interface MenuItem {
  id: string;
  label: string;
  /** Shown right-aligned: the keyboard shortcut that does the same thing. */
  hint?: string;
  disabled?: boolean;
  /** Why it is disabled, so a greyed item is not a mystery. */
  disabledReason?: string;
  /** A checked state, for toggles like Auto and Log. */
  checked?: boolean;
  /** Destructive items are tinted and are never the initially focused item. */
  destructive?: boolean;
}

export interface MenuSeparator {
  id: string;
  separator: true;
}

export type MenuEntry = MenuItem | MenuSeparator;

export function isSeparator(entry: MenuEntry): entry is MenuSeparator {
  return (entry as MenuSeparator).separator === true;
}

/** Indices a keyboard cursor may land on: enabled items, never separators. */
export function focusableIndices(entries: readonly MenuEntry[]): number[] {
  const out: number[] = [];
  entries.forEach((entry, index) => {
    if (!isSeparator(entry) && !entry.disabled) out.push(index);
  });
  return out;
}

export type MenuKey = "ArrowDown" | "ArrowUp" | "Home" | "End";

/**
 * Where the highlight lands after a key press.
 *
 * Wraps at both ends, which is what every native menu does, and returns `-1`
 * for a menu with nothing selectable rather than pointing at a disabled item
 * that Enter would silently ignore.
 */
export function moveMenuCursor(
  entries: readonly MenuEntry[], cursor: number, key: MenuKey
): number {
  const focusable = focusableIndices(entries);
  if (focusable.length === 0) return -1;
  if (key === "Home") return focusable[0]!;
  if (key === "End") return focusable[focusable.length - 1]!;
  const current = focusable.indexOf(cursor);
  if (current < 0) return key === "ArrowDown" ? focusable[0]! : focusable[focusable.length - 1]!;
  const next = key === "ArrowDown" ? current + 1 : current - 1;
  return focusable[(next + focusable.length) % focusable.length]!;
}

/**
 * The item a menu opens on.
 *
 * The first enabled, non-destructive item — so a menu whose first entry is
 * "Remove" does not open with Remove under the keyboard cursor, where a
 * reflexive Enter would delete the thing the user just right-clicked.
 */
export function initialMenuCursor(entries: readonly MenuEntry[]): number {
  const focusable = focusableIndices(entries);
  for (const index of focusable) {
    const entry = entries[index]!;
    if (!isSeparator(entry) && !entry.destructive) return index;
  }
  return focusable[0] ?? -1;
}

/** Trailing, leading and doubled separators carry no meaning; drop them. */
export function tidyEntries(entries: readonly MenuEntry[]): MenuEntry[] {
  const out: MenuEntry[] = [];
  for (const entry of entries) {
    if (isSeparator(entry)) {
      if (out.length === 0) continue;
      if (isSeparator(out[out.length - 1]!)) continue;
    }
    out.push(entry);
  }
  while (out.length > 0 && isSeparator(out[out.length - 1]!)) out.pop();
  return out;
}
