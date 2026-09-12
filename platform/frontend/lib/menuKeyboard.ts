/** Keyboard plumbing shared by the chart's non-context menus. */

/** Enabled controls that represent an actionable menu entry. */
export const MENU_ITEM_SELECTOR =
  '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], ' +
  '[role="switch"], button:not([disabled]), input:not([disabled])';

export function menuItems(menu: HTMLElement | null): HTMLElement[] {
  if (!menu) return [];
  // jsdom (used by the interaction suite) does not calculate offsetParent;
  // disabled controls are excluded by the selector, and menus only render
  // their visible sections, so no geometry filter is needed here.
  return [...menu.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR)];
}

/** Move focus according to the familiar menu key bindings. */
export function moveMenuFocus(
  items: readonly HTMLElement[],
  active: Element | null,
  key: string,
): boolean {
  if (items.length === 0) return false;
  const current = Math.max(0, items.indexOf(active as HTMLElement));
  const next = key === "Home"
    ? 0
    : key === "End"
      ? items.length - 1
      : (current + (key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
  items[next]?.focus();
  return true;
}
