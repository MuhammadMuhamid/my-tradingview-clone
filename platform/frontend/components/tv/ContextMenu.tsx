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
 * flips rather than scrolls: those are the menu. Written five times they would
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
 * do while a user is aiming at a price. So it flips back across the pointer,
 * and clamps only if flipping is not enough.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  initialMenuCursor, isSeparator, moveMenuCursor, placeMenu, tidyEntries,
  type MenuEntry, type MenuKey, type MenuPlacement,
} from "@/lib/contextMenu";

export interface ContextMenuProps {
  /** Where the pointer was, in viewport coordinates; null when closed. */
  at: { x: number; y: number } | null;
  entries: readonly MenuEntry[];
  /** What the menu is about, announced to a screen reader. */
  label: string;
  onSelect: (id: string) => void;
  onClose: () => void;
}

export function ContextMenu({ at, entries, label, onSelect, onClose }: ContextMenuProps) {
  const items = tidyEntries(entries);
  const panelRef = useRef<HTMLDivElement>(null);
  const [cursor, setCursor] = useState(-1);
  const [placement, setPlacement] = useState<MenuPlacement | null>(null);
  /** Whatever had focus before the menu opened, so it can be given back. */
  const restoreTo = useRef<HTMLElement | null>(null);

  const open = at !== null;

  useEffect(() => {
    if (!open) { setPlacement(null); return; }
    setCursor(initialMenuCursor(items));
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

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
    if (event.key === "Tab") {
      // A menu is modal for the keyboard; Tab closes it rather than escaping
      // into the page behind it with the menu still on screen.
      event.preventDefault();
      onClose();
      return;
    }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      setCursor((current) => moveMenuCursor(items, current, event.key as MenuKey));
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const entry = items[cursor];
      if (entry && !isSeparator(entry) && !entry.disabled) choose(entry.id);
    }
  };

  if (!open || items.length === 0) return null;

  return (
    <>
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
        style={{
          left: placement ? placement.left : at.x,
          top: placement ? placement.top : at.y,
          // Invisible until measured, so it is never seen at the wrong place.
          visibility: placement ? "visible" : "hidden",
        }}
        className="fixed z-[91] min-w-[200px] max-w-[280px] overflow-hidden rounded-md border border-border bg-surface py-1 shadow-2xl outline-none"
      >
        {items.map((entry, index) => {
          if (isSeparator(entry)) {
            return <div key={entry.id} role="separator" className="my-1 border-t border-border" />;
          }
          const focused = index === cursor;
          return (
            <button
              key={entry.id}
              role="menuitem"
              type="button"
              disabled={entry.disabled}
              aria-disabled={entry.disabled || undefined}
              aria-checked={entry.checked}
              title={entry.disabled ? entry.disabledReason : undefined}
              onMouseEnter={() => { if (!entry.disabled) setCursor(index); }}
              onClick={() => choose(entry.id)}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] transition-colors ${
                entry.disabled
                  ? "cursor-not-allowed text-ink-faint"
                  : entry.destructive
                    ? focused ? "bg-down/15 text-down" : "text-down"
                    : focused ? "bg-surface-2 text-ink" : "text-ink"
              }`}
            >
              {/*
                A checked item is marked as well as tinted. State told by colour
                alone disappears for a reader who cannot see it, and these are
                toggles that decide how a price scale behaves. The mark is drawn
                rather than typed: a dingbat renders as a different glyph, or as
                nothing at all, depending on the font that resolves.
              */}
              <span className="flex w-3 shrink-0 justify-center text-accent">
                {entry.checked && (
                  <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor"
                    strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M2 6.5l2.5 2.5L10 3.5" />
                  </svg>
                )}
              </span>
              <span className="min-w-0 flex-1 truncate">{entry.label}</span>
              {entry.hint && (
                <span className="shrink-0 text-[11px] text-ink-faint">{entry.hint}</span>
              )}
            </button>
          );
        })}
      </div>
    </>
  );
}
