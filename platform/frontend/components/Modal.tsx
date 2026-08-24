"use client";
import { useCallback, useEffect, useId, useRef, type ReactNode } from "react";

/** Everything that can hold keyboard focus inside the panel. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * TradingView-style dark modal: dimmed backdrop, titled panel, footer slot.
 *
 * ── Why this component owns keyboard behaviour ─────────────────────────────
 *
 * Every dialog in the application renders through here — arming an alert,
 * starting live trading, editing a deployment, saving a layout. Before Phase 6
 * none of them could be dismissed with Escape, none moved focus into the panel,
 * and none returned it afterwards, so a keyboard user opening a dialog was left
 * tabbing through the page behind an overlay they could not close. Fixing it
 * once here fixes it everywhere, and no dialog can be added later that forgets.
 *
 * Screen readers were told nothing at all: without `role="dialog"` the panel is
 * an ordinary div, announced as though the page had simply grown more content.
 */
export function Modal({
  title, open, onClose, children, footer, wide = false,
}: {
  title: ReactNode;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  /** Whatever had focus before the dialog opened, so it can be given back. */
  const restoreTo = useRef<HTMLElement | null>(null);
  const titleId = useId();

  const focusables = useCallback((): HTMLElement[] => {
    const panel = panelRef.current;
    if (!panel) return [];
    return [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)]
      // A control inside a collapsed section is in the DOM but cannot be
      // reached, and including it would put an invisible stop in the tab order.
      .filter((el) => el.offsetParent !== null || el === document.activeElement);
  }, []);

  // Move focus in on open, and back to where it came from on close. The
  // restore matters more than it sounds: a user who opens the alert dialog from
  // a moving-average bell and closes it should find themselves on that bell,
  // not at the top of the page.
  useEffect(() => {
    if (!open) return;
    restoreTo.current = document.activeElement as HTMLElement | null;
    const first = focusables()[0] ?? panelRef.current;
    first?.focus();
    return () => {
      // `isConnected` guards the case where the trigger itself was removed by
      // whatever the dialog just did — deleting the alert it was opened from.
      const target = restoreTo.current;
      if (target?.isConnected) target.focus();
    };
  }, [open, focusables]);

  // Escape closes; Tab cycles inside the panel rather than wandering behind it.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); return; }
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) { e.preventDefault(); return; }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !panelRef.current?.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open, onClose, focusables]);

  // Lock the page behind the dialog. On a phone this is the difference between
  // scrolling the form and scrolling the chart out from under it.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previous; };
  }, [open]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4">
      {/*
        The backdrop is presentational: closing by clicking it is a convenience,
        and the labelled close button plus Escape are the accessible paths, so it
        is hidden from assistive technology rather than announced as a control.
      */}
      <div className="absolute inset-0 bg-black/60" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`relative flex max-h-[85vh] w-full ${wide ? "max-w-2xl" : "max-w-lg"} flex-col rounded-lg border border-border bg-surface shadow-2xl outline-none`}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <h2 id={titleId} className="text-base font-semibold text-ink">{title}</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            // 40px, so it is reachable with a thumb rather than only a pointer.
            className="-mr-1.5 flex h-10 w-10 items-center justify-center rounded text-ink-muted hover:bg-surface-2 hover:text-ink focus-visible:ring-2 focus-visible:ring-accent"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
