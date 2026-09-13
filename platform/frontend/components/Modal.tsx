"use client";
import { useCallback, useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

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
  title, open, onClose, children, footer, wide = false, panelClassName = "", contentClassName = "",
}: {
  title: ReactNode;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  /** Optional surface sizing for dialogs with a measured product contract. */
  panelClassName?: string;
  /** Optional content treatment when the child owns its own scroll regions. */
  contentClassName?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  /** Whatever had focus before the dialog opened, so it can be given back. */
  const restoreTo = useRef<HTMLElement | null>(null);
  /**
   * The last thing focused outside any dialog.
   *
   * Reading `document.activeElement` when the open-effect runs is too late: a
   * field with `autoFocus` has already taken focus by then, so the dialog
   * records one of its own children as the thing to restore to, finds it
   * removed on close, and drops focus to `<body>`. That is not visible in
   * review or in a unit test — it was found by driving a real browser.
   *
   * The test is `closest('[role="dialog"]')` rather than this panel's own ref
   * for two reasons. The ref is still null during the commit in which a child
   * autofocuses itself, so a ref test would record that child as "outside".
   * And every dialog in the application mounts one of these listeners, so each
   * must ignore focus landing in any dialog, not only its own.
   */
  const lastOutsideFocus = useRef<HTMLElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    const onFocusIn = (e: FocusEvent): void => {
      const target = e.target as HTMLElement | null;
      if (!target?.closest || target.closest('[role="dialog"]')) return;
      lastOutsideFocus.current = target;
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, []);

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
    const active = document.activeElement as HTMLElement | null;
    restoreTo.current =
      active && !panelRef.current?.contains(active) ? active : lastOutsideFocus.current;
    /*
     * The PANEL takes focus, not the first focusable.
     *
     * The close button is first in DOM order, so every dialog opened with a
     * 2px accent ring drawn around its X. The panel carries `tabIndex={-1}`
     * and `aria-labelledby`, so focusing it announces the dialog's title —
     * which is what a screen-reader user wants on open — and the first Tab
     * then lands on a real control instead of on "cancel this".
     */
    (panelRef.current ?? focusables()[0])?.focus();
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
  return createPortal(
    /*
     * ── `tv-workstation` on the portal root ───────────────────────────────
     *
     * Every dialog portals to `document.body`, which is OUTSIDE the
     * `.tv-workstation` element the whole dense grammar is scoped to
     * (`app/chart/page.tsx`). So `.tvc-control`, `.tvc-menu`, the 14px
     * workstation type and the 1px focus offset all stopped at the dialog's
     * edge: a button inside a modal carrying `tvc-control` had no hover state
     * at all, because the class it was relying on could not match. Naming the
     * portal root puts the dialog layer back inside the same grammar without
     * giving up the portal, which is what keeps a modal out of the chart's
     * stacking and overflow contexts.
     */
    <div className="tv-workstation pointer-events-auto fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4">
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
        className={`relative flex max-h-[92vh] w-full ${wide ? "max-w-[750px]" : "max-w-lg"} flex-col rounded-md bg-popover shadow-[0_8px_28px_rgba(0,0,0,0.5)] outline-none ${panelClassName}`}
      >
        <div className="flex items-center justify-between px-5 py-3">
          <h2 id={titleId} className="text-[20px] font-semibold leading-8 text-ink">{title}</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            // 40px, so it is reachable with a thumb rather than only a pointer.
            /*
              The most-clicked control in every dialog, and it was the one
              still doing what `.tvc-control` was written to replace: a
              full-bleed 4px tint. The ring went with it — `globals.css` draws
              one `:focus-visible` outline for the whole product, and this
              stacked a second on top of it, so keyboard focus here was a
              double halo nothing else has.
            */
            className="tvc-control -mr-1.5 flex h-10 w-10 items-center justify-center rounded-md text-ink-muted hover:text-ink"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </button>
        </div>
        <div className={`min-h-0 flex-1 overflow-y-auto px-5 py-4 ${contentClassName}`}>{children}</div>
        {footer && (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
