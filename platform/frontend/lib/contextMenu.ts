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
 * One context-menu row, used to decide whether sliding a menu up has left the
 * pointer sitting ON the menu rather than beside its first item.
 *
 * The contract's context-menu pitch (`docs/TRADING_SCENE_UI_UX_CONTRACT.md`,
 * and `.tvc-menu--compact` in `globals.css`), so the rule below is expressed in
 * the same unit the reader sees.
 */
export const MENU_ROW_HEIGHT = 32;

/**
 * Place a menu so it is fully visible, preferring down-and-right of the pointer.
 *
 * ── R8-28: slide before you flip ───────────────────────────────────────────
 *
 * This used to flip first and clamp second, and the comment defending that
 * said clamping alone would leave the pointer in the middle of the menu. For a
 * SHORT menu near the bottom edge that is true. For a TALL one it is exactly
 * backwards: a 570px menu opened at y=420 in a 900px viewport cannot flip (the
 * flipped top would be −150), so the old rule flipped nothing, clamped to
 * `maxTop`… but only after having already decided `flippedY` from a test the
 * geometry could not satisfy. Worse, on the builds where the flip DID apply,
 * the whole menu jumped above the pointer and the item under the cursor was
 * the LAST one — `Remove`, on the drawing menu.
 *
 * Live TradingView slides: the menu's bottom edge stops at the viewport's, the
 * first row stays under the pointer, and nothing is reordered. So: slide first,
 * and flip only when sliding would still leave the pointer more than one row
 * deep inside the panel — which is the short-menu-at-the-bottom case the old
 * comment was really about.
 */
export function placeMenu(geometry: MenuGeometry): MenuPlacement {
  const margin = geometry.margin ?? DEFAULT_MARGIN;
  const maxLeft = geometry.viewportWidth - geometry.width - margin;
  const maxTop = geometry.viewportHeight - geometry.height - margin;

  const flippedX = geometry.x + geometry.width + margin > geometry.viewportWidth
    && geometry.x - geometry.width >= margin;

  // Where sliding alone would put it: never above the top margin, never lower
  // than the point at which the menu's own bottom edge reaches the viewport's.
  const slid = Math.max(margin, Math.min(geometry.y, Math.max(margin, maxTop)));
  /*
   * Flipping is the fallback, not the default. Two conditions, both necessary:
   * the slide left the pointer buried in the panel by more than one row, and
   * the flipped menu actually fits above the pointer.
   */
  const flippedY = geometry.y - slid > MENU_ROW_HEIGHT
    && geometry.y - geometry.height >= margin;

  const left = flippedX ? geometry.x - geometry.width : geometry.x;
  const placedTop = flippedY ? geometry.y - geometry.height : slid;

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

/**
 * The drawn marks a menu row may carry in its 20px leading column.
 *
 * A KEY, not an SVG. `lib/menuPayloads` is pure and testable precisely because
 * it contains no markup, and a payload that returned React elements could not
 * be asserted on by `tests/powerUx.test.ts` without a renderer. `ContextMenu`
 * owns the paths; this names them.
 *
 * The column is shared with the check mark, which wins: a row that is both
 * glyphed and checked is a toggle, and its state is the thing the reader needs.
 */
export type MenuGlyph =
  | "alarm" | "order" | "indicator" | "info" | "copy" | "paste" | "note"
  | "watchlist" | "gear" | "clone" | "lock" | "eye" | "trash" | "reset"
  | "template" | "tree" | "clock" | "calendar" | "flag"
  // F-04: the study pane's `Manage panes` menu.
  | "maximize" | "restore" | "collapse" | "expand" | "arrowUp" | "arrowDown"
  // F-05 / F-06: the Manage layouts and Indicator templates dropdowns.
  | "rename" | "folder" | "newLayout" | "save" | "close";

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
  /**
   * Radio semantics rather than checkbox.
   *
   * R8-20: the reference's price axis offers `Regular / Percent / Indexed to
   * 100 / Logarithmic` as FOUR MUTUALLY EXCLUSIVE readings of one scale, and
   * this product drew them as four independent checkboxes — so a reader was
   * told "Percent is on" and "Logarithmic is off" as two separate facts rather
   * than as one choice with four positions. `menuitemradio` says the true
   * thing, and it is the role assistive technology announces as "1 of 4".
   */
  radio?: boolean;
  /** Destructive items are tinted and are never the initially focused item. */
  destructive?: boolean;
  /** The row's 28px leading mark (W2A-07). Suppressed while `checked` is true. */
  glyph?: MenuGlyph;
  /**
   * A submenu, drawn with `›` and opened on hover or `→`.
   *
   * One level deep, deliberately: the reference's own menus never go further,
   * and each additional level is a fresh placement, focus-restore and
   * keyboard contract rather than more of the same one.
   */
  children?: readonly MenuEntry[];
}

export interface MenuSeparator {
  id: string;
  separator: true;
}

/**
 * A row of colour swatches, as one entry.
 *
 * TVP8 F-05: the reference's watchlist row menu puts seven flag colours on a
 * single 32px row, and seven `MenuItem`s would be seven rows. It is a RADIO
 * over a palette — one flag at a time, and picking the one already on clears
 * it — so the row carries `selected` rather than seven `checked` flags.
 *
 * It owns one keyboard cursor position: Left and Right move between the
 * swatches, Enter picks the one under the cursor. Seven cursor stops in a
 * nine-row menu would make arrowing past the palette the slow way through.
 */
export interface MenuSwatches {
  id: string;
  /** Announced as the group's accessible name. */
  label: string;
  swatches: readonly { id: string; label: string; hex: string }[];
  /** The swatch currently on, or null. */
  selected: string | null;
  disabled?: boolean;
}

export type MenuEntry = MenuItem | MenuSeparator | MenuSwatches;

export function isSeparator(entry: MenuEntry): entry is MenuSeparator {
  return (entry as MenuSeparator).separator === true;
}

export function isSwatches(entry: MenuEntry): entry is MenuSwatches {
  return Array.isArray((entry as MenuSwatches).swatches);
}

/** The id a swatch selection reports: the row's id, then the swatch's. */
export function swatchId(rowId: string, swatch: string): string {
  return `${rowId}:${swatch}`;
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
    if (isSeparator(entry) || isSwatches(entry)) continue;
    if (!entry.destructive) return index;
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
