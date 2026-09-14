"use client";
import { useCallback, useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

/*
 * ── TVP8: which dialog the keyboard belongs to ─────────────────────────────
 *
 * Every Modal binds Escape and Tab on `document` in the capture phase, and
 * `stopPropagation` does not stop a SIBLING listener on the same target in the
 * same phase — both run. With two open at once, which the product now does
 * routinely (a confirm raised from inside the chart-settings dialog, the
 * Go-to picker over the chart), Escape closed both of them and Shift+Tab was
 * pulled out of the inner one by the outer one's trap.
 *
 * `stopImmediatePropagation` is not the fix: listeners run in REGISTRATION
 * order, so the outer dialog's handler runs first and would silence the inner
 * one — exactly backwards.
 *
 * So: a stack. Only the dialog on top of it answers the keyboard, which is
 * what "innermost first" actually means.
 */
const openDialogs: symbol[] = [];

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
  headerClassName = "", footerClassName = "", scrollBody = true,
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
  /** Optional header sizing for a dialog with a measured header height. */
  headerClassName?: string;
  /**
   * Optional footer sizing for a dialog with a measured footer height.
   *
   * R6b-02: the reference's settings footer is 67px — a 34px button with 17
   * above it and 16 below, against this component's `py-3` 12/12, so every
   * dialog in the product sat 8px shallower than the one it is copied from.
   * Passed rather than re-tokened here because 59px is right for the small
   * confirms (`AskDialog`) and 67 is right for the measured settings dialogs.
   */
  footerClassName?: string;
  /**
   * Whether the body is the scroller.
   *
   * True for every dialog in the product, and it must stay true: a dialog
   * whose body does not scroll and whose child does not either simply clips.
   *
   * The indicator browser is the one dialog with a measured two-column body in
   * which ONLY the list scrolls — the library rail and the tab row are fixed,
   * the way the reference has them. With the body as the scroller, the rail
   * and the tabs scrolled away with the list. Opting out here is narrower than
   * overriding `overflow-y-auto` from a `contentClassName`, which cannot win
   * against a class of the same specificity that comes later in the sheet.
   */
  scrollBody?: boolean;
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

  /** This dialog's place in the stack above. */
  const dialogId = useRef<symbol>(Symbol("dialog"));
  useEffect(() => {
    if (!open) return;
    const id = dialogId.current;
    openDialogs.push(id);
    return () => {
      const at = openDialogs.indexOf(id);
      if (at >= 0) openDialogs.splice(at, 1);
    };
  }, [open]);

  // Escape closes; Tab cycles inside the panel rather than wandering behind it.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      // Only the innermost dialog answers. See `openDialogs`.
      if (openDialogs[openDialogs.length - 1] !== dialogId.current) return;
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
        <div className={`flex items-center justify-between px-5 py-3 ${headerClassName}`}>
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
        <div className={`min-h-0 flex-1 ${scrollBody ? "overflow-y-auto" : "flex flex-col"} px-5 py-4 ${contentClassName}`}>{children}</div>
        {footer && (
          <div className={`flex flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-3 ${footerClassName}`}>
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
