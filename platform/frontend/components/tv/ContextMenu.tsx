"use client";
/**
 * One context menu, used by every right-click in the workspace.
 *
 * ── Why one ────────────────────────────────────────────────────────────────
 *
 * There are five payloads in this product — the chart, a drawing, an indicator,
 * the price axis and a watchlist row — and a menu is not the sum of its items.
 * Escape closing it, an outside click closing it, focus returning to whatever
 * opened it, arrow keys moving through only the ENABLED items, Home and End,
 * the separator that is skipped rather than focused, and the placement that
 * slides rather than scrolls: those are the menu. Written five times they would
 * be right in two places and quietly wrong in three, and the wrong ones would
 * be the ones a keyboard user meets.
 *
 * The geometry and the cursor rules are pure and live in `lib/contextMenu`, so
 * they are tested without a browser. This file is the rendering and the event
 * plumbing, and nothing else.
 *
 * ── Placement ──────────────────────────────────────────────────────────────
 *
 * Measured after the first paint, then positioned. A menu opened near the
 * bottom-right of a chart must not open off-screen, and it must not scroll the
 * page into view either — scrolling the chart is exactly what a chart must not
 * do while a user is aiming at a price. So it SLIDES up until its bottom edge
 * reaches the viewport's, keeping the first row under the pointer, and flips
 * across the pointer only when sliding would bury the pointer inside it
 * (R8-28; the arithmetic and the reason are in `placeMenu`).
 *
 * ── The three columns of a row ─────────────────────────────────────────────
 *
 * R8-17/20/21: the reference's rows are `[20px mark] [label] [cap] [›]`, and
 * this drew `[12px check] [label] [hint]`. Three things were missing and each
 * of them is information: the mark that says at a glance which row is the
 * alarm and which is the bin, the key cap that teaches the chord for the thing
 * the user is doing right now, and the chevron that says a row leads somewhere
 * rather than doing something. The mark column is SHARED with the check — a
 * row that is both is a toggle, and its state is what the reader needs.
 */
import {
  useCallback, useEffect, useId, useLayoutEffect, useRef, useState,
} from "react";
import { createPortal } from "react-dom";
import {
  initialMenuCursor, isSeparator, isSwatches, moveMenuCursor, placeMenu, swatchId, tidyEntries,
  type MenuEntry, type MenuGlyph, type MenuItem, type MenuKey, type MenuPlacement,
  type MenuSwatches,
} from "@/lib/contextMenu";

export interface ContextMenuProps {
  /** Where the pointer was, in viewport coordinates; null when closed. */
  at: { x: number; y: number } | null;
  entries: readonly MenuEntry[];
  /** What the menu is about, announced to a screen reader. */
  label: string;
  onSelect: (id: string) => void;
  onClose: () => void;
  /**
   * An exact panel width, for a payload the reference measures.
   *
   * TVP8 F-05: the watchlist row menu is 254px on the reference and its widest
   * row is short, so the shared `min-w/max-w` pair would have shrunk it to the
   * width of `Add section`.
   */
  width?: number;
}

/**
 * The 16px paths, one per `MenuGlyph`.
 *
 * Drawn rather than typed. A dingbat resolves to a different glyph — or to
 * nothing at all — depending on which font the platform picks, and the whole
 * point of the column is that the reader recognises the row by its shape.
 */
const GLYPH_PATHS: Record<MenuGlyph, React.ReactNode> = {
  alarm: <><circle cx="8" cy="9" r="5.2" /><path d="M8 6.4V9l1.8 1.2M3.2 2.6 1.6 4.2M12.8 2.6l1.6 1.6" /></>,
  order: <><path d="M2.5 12.5h11M4.5 12.5V7M8 12.5V3.5M11.5 12.5V9" /></>,
  indicator: <><path d="M2 12l3.5-5 2.5 3 2-6 4 8" /></>,
  info: <><circle cx="8" cy="8" r="6" /><path d="M8 7.2v4M8 5h.01" /></>,
  copy: <><rect x="5.5" y="5.5" width="8" height="8" rx="1" /><path d="M10.5 3.5H3.5a1 1 0 0 0-1 1v7" /></>,
  paste: <><rect x="3.5" y="3" width="9" height="11" rx="1" /><path d="M6 3V2h4v1" /></>,
  note: <><path d="M3 3h10v7l-3 3H3z" /><path d="M13 10h-3v3" /></>,
  watchlist: <><path d="M2.5 4h11M2.5 8h7M2.5 12h7" /><path d="M12.5 9.5v5M10 12h5" /></>,
  // A gear is a toothed RING around a hub. A small hub with eight long
  // radial rays — which this was — is a sun, and read as "brightness".
  gear: <><path d="M12.04 6.84L14.01 6.94L14.01 9.06L12.04 9.16L11.67 10.04L13.00 11.50L11.50 13.00L10.04 11.67L9.16 12.04L9.06 14.01L6.94 14.01L6.84 12.04L5.96 11.67L4.50 13.00L3.00 11.50L4.33 10.04L3.96 9.16L1.99 9.06L1.99 6.94L3.96 6.84L4.33 5.96L3.00 4.50L4.50 3.00L5.96 4.33L6.84 3.96L6.94 1.99L9.06 1.99L9.16 3.96L10.04 4.33L11.50 3.00L13.00 4.50L11.67 5.96Z" /><circle cx="8" cy="8" r="1.95" /></>,
  clone: <><rect x="5.5" y="5.5" width="8" height="8" rx="1" /><rect x="2.5" y="2.5" width="8" height="8" rx="1" /></>,
  lock: <><rect x="3.5" y="7" width="9" height="6.5" rx="1" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /></>,
  eye: <><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" /><circle cx="8" cy="8" r="2" /></>,
  trash: <><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9" /></>,
  reset: <><path d="M3 8a5 5 0 1 1 1.6 3.7" /><path d="M2.6 4.8v3.1h3.1" /></>,
  template: <><rect x="2.5" y="2.5" width="11" height="11" rx="1" /><path d="M2.5 6.5h11M6.5 6.5v7" /></>,
  tree: <><path d="M3 3.5h3M3 8h3M3 12.5h3" /><path d="M8 3.5h5M8 8h5M8 12.5h5" /></>,
  clock: <><circle cx="8" cy="8" r="6" /><path d="M8 4.8V8l2.3 1.6" /></>,
  calendar: <><rect x="2.5" y="3.5" width="11" height="10" rx="1" /><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" /></>,
  flag: <><path d="M3.5 14V2.5M3.5 3h8l-1.6 2.6L11.5 8.2h-8" /></>,
};

function Glyph({ name }: { name: MenuGlyph }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {GLYPH_PATHS[name]}
    </svg>
  );
}

/** The check, drawn for the same reason the glyphs are. */
function Check() {
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 6.5l2.5 2.5L10 3.5" />
    </svg>
  );
}

function Chevron() {
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor"
      strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4.5 2.5 8 6l-3.5 3.5" />
    </svg>
  );
}

/**
 * A row's ARIA role, which follows what the payload says the row IS.
 *
 * `aria-checked` is defined for `menuitemcheckbox` and `menuitemradio`, not for
 * a plain `menuitem` — on the latter assistive technology usually drops it, so
 * the state of Auto scale, Percent, Lock and Hide reached sighted users only.
 */
function roleOf(item: MenuItem): "menuitem" | "menuitemcheckbox" | "menuitemradio" {
  if (item.radio) return "menuitemradio";
  return item.checked === undefined ? "menuitem" : "menuitemcheckbox";
}

/*
 * Whether the input that opened a menu was the keyboard.
 *
 * The reference opens a right-click or `⋯` menu with NO row highlighted — a
 * highlighted first row under a pointer that is nowhere near it reads as a
 * hover that did not happen. A menu opened from the keyboard still lands its
 * cursor on the first safe row, because there a cursor is the only way to see
 * where Enter will go. Tracked once per document, in the capture phase, so no
 * caller has to say how its menu was summoned.
 */
let keyboardLast = false;
if (typeof window !== "undefined") {
  window.addEventListener("keydown", () => { keyboardLast = true; }, true);
  window.addEventListener("pointerdown", () => { keyboardLast = false; }, true);
}

export function ContextMenu({ at, entries, label, onSelect, onClose, width }: ContextMenuProps) {
  const items = tidyEntries(entries);
  /**
   * A stable prefix for this menu's item ids.
   *
   * `useId` rather than a counter so two menus mounted at once — a chart menu
   * and a panel's study menu — cannot produce the same `aria-activedescendant`
   * target.
   */
  const menuId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const [cursor, setCursor] = useState(-1);
  const [placement, setPlacement] = useState<MenuPlacement | null>(null);
  /** The open submenu's parent index, where it should be drawn, and its cursor. */
  const [sub, setSub] = useState<{ index: number; x: number; y: number } | null>(null);
  const [subCursor, setSubCursor] = useState(-1);
  /** Which swatch the keyboard is on, inside the focused swatch row. */
  const [swatchCursor, setSwatchCursor] = useState(0);
  /** Whatever had focus before the menu opened, so it can be given back. */
  const restoreTo = useRef<HTMLElement | null>(null);

  const open = at !== null;

  useEffect(() => {
    if (!open) { setPlacement(null); setSub(null); return; }
    setCursor(keyboardLast ? initialMenuCursor(items) : -1);
    restoreTo.current = typeof document === "undefined"
      ? null : (document.activeElement as HTMLElement | null);
    return () => {
      // A menu that drops focus to <body> restarts a keyboard user's tab order
      // at the top of the page, which for a chart workspace is a long way back.
      const target = restoreTo.current;
      if (target?.isConnected) target.focus();
    };
    // `items` is rebuilt every render; the payload changing is `at`'s job.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, at?.x, at?.y]);

  // Measure, then place. Before this runs the panel is rendered invisibly at
  // the pointer, so its size is real rather than guessed.
  useLayoutEffect(() => {
    if (!open || !panelRef.current) return;
    const box = panelRef.current.getBoundingClientRect();
    setPlacement(placeMenu({
      x: at.x, y: at.y, width: box.width, height: box.height,
      viewportWidth: window.innerWidth, viewportHeight: window.innerHeight,
    }));
  }, [open, at?.x, at?.y, items.length]);

  // Focus the panel so the keyboard handler below receives keys immediately,
  // without the user having to click into it first.
  useEffect(() => {
    if (open && placement) panelRef.current?.focus();
  }, [open, placement]);

  const choose = useCallback((id: string) => {
    onSelect(id);
    onClose();
  }, [onSelect, onClose]);

  const subEntries: readonly MenuEntry[] = sub
    ? (((items[sub.index] as MenuItem | undefined)?.children) ?? [])
    : [];

  /** Open the submenu on `index`, anchored to that row's right edge. */
  const openSub = useCallback((index: number, row: HTMLElement | null) => {
    const box = row?.getBoundingClientRect();
    setSub({ index, x: box ? box.right - 4 : 0, y: box ? box.top - 4 : 0 });
    setSubCursor(-1);
  }, []);

  const closeSub = useCallback(() => { setSub(null); setSubCursor(-1); }, []);

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      /*
       * And it stops here.
       *
       * `Escape` is also the global "back to the cursor" shortcut and every
       * pane's clear-selection key. Without this, dismissing a menu also
       * disarmed whatever drawing tool was in hand and dropped the selection —
       * three handlers for one press.
       */
      event.stopPropagation();
      if (sub) { closeSub(); return; }
      onClose();
      return;
    }
    if (event.key === "Tab") {
      // A menu is modal for the keyboard; Tab closes it rather than escaping
      // into the page behind it with the menu still on screen.
      event.preventDefault();
      onClose();
      return;
    }
    if (sub) {
      if (event.key === "ArrowLeft") { event.preventDefault(); closeSub(); return; }
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        setSubCursor((current) => moveMenuCursor(subEntries, current, event.key as MenuKey));
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        const entry = subEntries[subCursor];
        if (entry && !isSeparator(entry) && !entry.disabled) choose(entry.id);
        return;
      }
      return;
    }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      setSwatchCursor(0);
      // From "no row yet", Down lands where a keyboard-opened menu would have
      // started: the first SAFE row, never a destructive one.
      setCursor((current) => current < 0 && event.key === "ArrowDown"
        ? initialMenuCursor(items) : moveMenuCursor(items, current, event.key as MenuKey));
      return;
    }
    /*
     * F-05: inside a swatch row, Left and Right walk the palette.
     *
     * The row is ONE stop in the up/down sequence — seven would make arrowing
     * past the colours the slow way through a nine-row menu — so the second
     * axis is where the seven live.
     */
    const swatchRow = items[cursor];
    if (swatchRow && isSwatches(swatchRow)
      && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      const count = swatchRow.swatches.length;
      setSwatchCursor((current) =>
        (current + (event.key === "ArrowRight" ? 1 : -1) + count) % count);
      return;
    }
    if (event.key === "ArrowRight") {
      const entry = items[cursor];
      if (entry && !isSeparator(entry) && !isSwatches(entry)
        && entry.children?.length && !entry.disabled) {
        event.preventDefault();
        openSub(cursor, panelRef.current?.querySelector<HTMLElement>(
          `#${CSS.escape(`${menuId}-${entry.id}`)}`) ?? null);
      }
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const entry = items[cursor];
      if (!entry || isSeparator(entry) || entry.disabled) return;
      if (isSwatches(entry)) {
        const swatch = entry.swatches[swatchCursor];
        if (swatch) choose(swatchId(entry.id, swatch.id));
        return;
      }
      if (entry.children?.length) {
        openSub(cursor, panelRef.current?.querySelector<HTMLElement>(
          `#${CSS.escape(`${menuId}-${entry.id}`)}`) ?? null);
        return;
      }
      choose(entry.id);
    }
  };

  if (!open || items.length === 0) return null;

  /**
   * The palette row (TVP8 F-05).
   *
   * `role="group"` holding seven `menuitemradio`s: one flag at a time, and the
   * one already on is announced as checked. 14px circles at 8px pitch, on the
   * same 32px row the rest of the menu runs at, so the palette reads as part
   * of the list rather than as a widget dropped into it.
   */
  const renderSwatches = (
    entry: MenuSwatches, index: number, focused: boolean,
  ): React.ReactNode => (
    <div
      key={entry.id}
      role="group"
      aria-label={entry.label}
      className="tvc-menu-row w-full gap-2 px-2"
    >
      <span className="flex w-5 shrink-0" aria-hidden="true" />
      <span className="flex items-center gap-2">
        {entry.swatches.map((swatch, i) => {
          const on = entry.selected === swatch.id;
          return (
            <button
              key={swatch.id}
              id={`${menuId}-${swatchId(entry.id, swatch.id)}`}
              type="button"
              role="menuitemradio"
              aria-checked={on}
              aria-label={swatch.label}
              title={swatch.label}
              tabIndex={-1}
              onMouseEnter={() => { setCursor(index); setSwatchCursor(i); }}
              onClick={() => choose(swatchId(entry.id, swatch.id))}
              className="h-[14px] w-[14px] shrink-0 rounded-full"
              /*
                Which one is ON, and which one the KEYBOARD is on: two facts,
                two marks. Both are a gap ring — the popover's own ground, then
                the ink — drawn as a shadow rather than with `ring-offset-*`,
                whose utility name parses as a colour token it is not.
              */
              style={{
                backgroundColor: swatch.hex,
                boxShadow: on
                  ? "0 0 0 2px var(--ts-popover), 0 0 0 3px var(--ts-ink)"
                  : focused && swatchCursor === i
                    ? "0 0 0 2px var(--ts-popover), 0 0 0 3px var(--ts-line-strong)"
                    : undefined,
              }}
            />
          );
        })}
      </span>
    </div>
  );

  /** One row, shared by the panel and by any submenu it opens. */
  const renderRow = (
    entry: MenuEntry, index: number, focused: boolean, inSub: boolean,
  ): React.ReactNode => {
    if (isSeparator(entry)) {
      return <div key={entry.id} role="separator" className="tvc-menu-sep" />;
    }
    if (isSwatches(entry)) return renderSwatches(entry, index, focused);
    const hasChildren = !inSub && (entry.children?.length ?? 0) > 0;
    return (
      <button
        key={entry.id}
        id={`${menuId}-${entry.id}`}
        role={roleOf(entry)}
        type="button"
        disabled={entry.disabled}
        aria-disabled={entry.disabled || undefined}
        aria-checked={entry.checked}
        /*
          A toggle row draws its state as the ✓ in the mark column, so it opts
          out of the inverted selection chip (`globals.css`, "A CHECKED toggle
          is not a SELECTED row"). Premium shows `Auto ✓` with no fill.
        */
        data-check-mark={entry.checked !== undefined ? "" : undefined}
        aria-haspopup={hasChildren ? "menu" : undefined}
        aria-expanded={hasChildren ? sub?.index === index : undefined}
        // The reason a greyed item is greyed, for a reader as well as a
        // pointer: `title` alone never reaches a screen reader.
        aria-describedby={
          entry.disabled && entry.disabledReason
            ? `${menuId}-${entry.id}-why` : undefined}
        title={entry.disabled ? entry.disabledReason : undefined}
        onMouseEnter={(event) => {
          if (entry.disabled) return;
          if (inSub) { setSubCursor(index); return; }
          setCursor(index);
          if (hasChildren) openSub(index, event.currentTarget);
          else if (sub) closeSub();
        }}
        onClick={(event) => {
          if (hasChildren) {
            // A parent row is a door, not an action: clicking it opens the
            // submenu rather than closing the whole menu having done nothing.
            openSub(index, event.currentTarget);
            return;
          }
          choose(entry.id);
        }}
        data-highlighted={focused && !entry.disabled ? "true" : undefined}
        /*
          A destructive row is NOT tinted. Measured on the reference's indicator
          and drawing menus, `Remove` is the same rgb(219,219,219) ink as every
          other row: the trash glyph says what it does, and chromatic colour in
          this product means direction, never danger (§2). The flag still keeps
          the keyboard cursor from LANDING on it when the menu opens.
        */
        className={`tvc-menu-row w-full gap-2 px-2 text-left text-sm ${
          entry.disabled ? "cursor-not-allowed text-ink-faint" : "text-ink"
        }`}
      >
        {/*
          The 20px leading column: the check when the row is a toggle that is
          ON, otherwise the row's own mark. In ink, never accent — a tick beside
          "Logarithmic" is the row saying it is on, which is selection, and
          selection in this product is never blue.
        */}
        <span className="flex w-5 shrink-0 justify-center text-ink-muted">
          {entry.checked && <Check />}
          {!entry.checked && entry.glyph && <Glyph name={entry.glyph} />}
        </span>
        {/*
          TVP8 round two: the LABEL never truncates; the hint does.

          At `max-w-[280px]` the label was the thing that got cut, so "Prepare
          an order at 76,845.50" rendered as "Prepare an order at 7…" — hiding
          the price, which is the entire content of that item.
        */}
        <span className="shrink-0 whitespace-nowrap">{entry.label}</span>
        {entry.disabled && entry.disabledReason && (
          <span id={`${menuId}-${entry.id}-why`} className="sr-only">
            {entry.disabledReason}
          </span>
        )}
        {/*
          The key cap, right-aligned and muted, as the reference draws it: the
          chord for the thing the reader is doing at the moment they do it,
          which is the only moment anyone learns one.
        */}
        {entry.hint && (
          <span className="ml-auto min-w-0 shrink truncate pl-3 text-right text-[11px] tabular text-ink-faint">
            {entry.hint}
          </span>
        )}
        {hasChildren && (
          <span className={`${entry.hint ? "" : "ml-auto "}shrink-0 pl-2 text-ink-faint`}>
            <Chevron />
          </span>
        )}
      </button>
    );
  };

  /*
   * Portalled to <body>, inside its own `tv-workstation` root.
   *
   * Rendered in place, the panel sat inside whatever stacking context opened
   * it: the indicator legend's `z-[3]` capped the menu's `z-[91]`, so the NEXT
   * pane's legend painted over it, and the panel inherited the legend's 13px
   * type. A menu belongs to the viewport, not to the row that summoned it. The
   * scope class keeps the menu grammar matching outside the chart's subtree,
   * exactly as `Modal` does for dialogs. React still bubbles its events through
   * the component tree, so Escape stopping here behaves as before.
   */
  return createPortal(
    <div className="tv-workstation" data-context-menu-root="">
      {/*
        The outside-click catcher. `onPointerDown` rather than `onClick` so the
        menu closes on the press, before the element underneath can act on the
        release — a right-click menu over a chart must not also start a drag.
      */}
      <div
        className="fixed inset-0 z-[90]"
        onPointerDown={onClose}
        onContextMenu={(event) => { event.preventDefault(); onClose(); }}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="menu"
        aria-label={label}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        aria-activedescendant={
          // What a screen reader follows as the arrow keys move: focus stays
          // on the panel, so without this the cursor was a background colour
          // and nothing else.
          sub && subCursor >= 0 && subEntries[subCursor] && !isSeparator(subEntries[subCursor]!)
            ? `${menuId}-${subEntries[subCursor]!.id}`
            : cursor >= 0 && items[cursor] && isSwatches(items[cursor]!)
              ? `${menuId}-${swatchId(items[cursor]!.id,
                (items[cursor] as MenuSwatches).swatches[swatchCursor]?.id ?? "")}`
              : cursor >= 0 && items[cursor] && !isSeparator(items[cursor]!)
                ? `${menuId}-${items[cursor]!.id}` : undefined}
        style={{
          left: placement ? placement.left : at.x,
          top: placement ? placement.top : at.y,
          // Never taller than the space below it, and scrollable when the list
          // does not fit — a fixed panel cannot be scrolled by the page.
          maxHeight: placement ? placement.maxHeight : undefined,
          ...(width === undefined ? {} : { width, minWidth: width, maxWidth: width }),
          // Invisible until measured, so it is never seen at the wrong place.
          visibility: placement ? "visible" : "hidden",
        }}
        /*
          Wider than the old 330 cap: the reference's chart menu is 347px and
          its widest row — `Add alert on BTCUSDT at 77,581.72… ⌥A` — is the one
          that must never abbreviate.
        */
        className={`fixed z-[91] overflow-y-auto tvc-menu tvc-menu--compact outline-none ${
          width !== undefined ? ""
            : label.endsWith(" chart") ? "w-[325px] min-w-[325px] max-w-[325px]"
              : "min-w-[200px] max-w-[360px]"
        }`}
      >
        {items.map((entry, index) => renderRow(entry, index, index === cursor, false))}
      </div>
      {sub && subEntries.length > 0 && (
        <div
          role="menu"
          aria-label={`${(items[sub.index] as MenuItem).label.replace(/\s*›?\s*$/, "")}`}
          style={{
            left: Math.min(sub.x, Math.max(8, window.innerWidth - 240)),
            top: Math.min(sub.y, Math.max(8, window.innerHeight - 8 - subEntries.length * 32)),
          }}
          className="fixed z-[92] min-w-[180px] max-w-[320px] overflow-y-auto tvc-menu tvc-menu--compact outline-none"
        >
          {subEntries.map((entry, index) =>
            renderRow(entry, index, index === subCursor, true))}
        </div>
      )}
    </div>,
    document.body,
  );
}
