"use client";
import { useEdgeClamp } from "@/lib/useEdgeClamp";
import { useEffect, useRef } from "react";
import { useAsk } from "@/components/AskDialog";
import { useExclusivePopover } from "@/lib/useExclusivePopover";
import type { Layout } from "@/lib/layouts";
import { TOOL_BUTTON, TOOL_CARET_BUTTON, TOOL_CARET_GLYPH } from "@/components/tv/toolbarChrome";
import { menuItems, moveMenuFocus } from "@/lib/menuKeyboard";

/**
 * The saved layout this workspace is on, and what can be done with it.
 *
 * ── What changed and why ───────────────────────────────────────────────────
 *
 * The trigger said the layout's name and appended a bare "•" when the
 * workspace had drifted from it. That dot is the entire difference between
 * "your work is on the server" and "your work is only in this tab", and it was
 * a single character with no label, no tooltip and no announcement. The state
 * is now a save CLOUD that is always on the bar, badged when the workspace is
 * ahead of what is stored and warn-tinted when autosave is failing, and the
 * sentence behind it — Saved / Unsaved changes / Saving… / Not saved /
 * Autosave failing — is the button's tooltip, its accessible name and the
 * menu's header rather than a second line of copy on the primary row.
 *
 * The control is split the way TradingView's is: a name button that saves,
 * and a 24px caret that opens this menu. One button doing both meant the only
 * way to write your changes was to open a menu and find "Save layout" in it.
 *
 * "Make a copy…" and "Create new layout…" were the same operation: both
 * prompted for a name, both wrote the CURRENT workspace to a new record, both
 * made it the open layout. The only difference was the default text in the
 * prompt. Two menu items for one action is not extra capability, it is a
 * question the user has to answer before they can act, so they are one item
 * now — "Save as…" — which still calls the same persistence, and still picks
 * the sensible default name for whichever situation you are in.
 *
 * Opening a different layout while this one has unsaved changes now asks
 * first. Nothing is overwritten either way — the danger is the opposite one,
 * losing the drift you have not saved — and it is silent without this.
 *
 * This component decides nothing about persistence: `lib/useSavedLayouts` owns
 * the writes, the autosave and the authority over what a layout is.
 */
export function LayoutMenu({
  layouts, currentId, autosave, dirty, autosaveError,
  onSelect, onSaveNow, onToggleAutosave, onCreate, onCopy, onRename, onDelete,
}: {
  layouts: Layout[];
  currentId: string | null;
  autosave: boolean;
  dirty: boolean;
  /**
   * Last autosave failure, or null.
   *
   * Autosave writes without being asked, so a failure must not interrupt with a
   * toast — but it must not be silent either. A user who believes autosave is
   * on stops saving deliberately, so an autosave that has quietly stopped
   * working loses more work than one that was never enabled.
   */
  autosaveError: string | null;
  onSelect: (id: string) => void;
  onSaveNow: () => void;
  onToggleAutosave: () => void;
  onCreate: () => void;
  onCopy: () => void;
  onRename: () => void;
  onDelete: (id: string) => void;
}) {
  // One popover open at a time across the whole toolbar — these menus
  // hang off buttons a few pixels apart, so two open at once overlap and
  // compete for the same clicks. See `lib/popoverGroup`.
  const [open, setOpen] = useExclusivePopover("saved-layouts");
  const ask = useAsk();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const edgeClamp = useEdgeClamp(menuRef, open);
  const current = layouts.find((l) => l.id === currentId) ?? null;

  useEffect(() => {
    if (!open) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [open, setOpen]);

  useEffect(() => {
    if (open) menuItems(menuRef.current)[0]?.focus();
  }, [open]);

  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      buttonRef.current?.focus();
      return;
    }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
      e.preventDefault();
      moveMenuFocus(menuItems(menuRef.current), document.activeElement, e.key);
    }
  };

  /** The one sentence about where this workspace's arrangement currently lives. */
  const status: { label: string; tone: string; help: string } = autosaveError
    ? {
      label: "Autosave failing",
      tone: "text-warn",
      help: `The last automatic save failed: ${autosaveError}. Use Save layout, or the changes `
        + "stay in this browser only.",
    }
    : !current
      ? {
        label: "Not saved",
        tone: "text-ink-faint",
        help: "This workspace is not stored as a named layout yet. Save as… creates one.",
      }
      : dirty
        ? autosave
          ? { label: "Saving…", tone: "text-ink-muted", help: "Autosave is writing these changes." }
          : {
            label: "Unsaved changes",
            tone: "text-warn",
            help: `“${current.name}” on the server is behind this workspace. Save layout writes it.`,
          }
        : { label: "Saved", tone: "text-ink-faint", help: `“${current.name}” matches this workspace.` };

  /**
   * Opening another layout replaces the focused chart's state. When the current
   * one has drift that autosave will not write, say so before discarding it.
   */
  const selectLayout = async (id: string, name: string): Promise<void> => {
    if (id !== currentId && dirty && !autosave && current) {
      const ok = await ask.confirm({
        title: `“${current.name}” has unsaved changes`,
        body: `Opening “${name}” discards them. Cancel, then Save layout first if you want to keep them.`,
        confirmLabel: `Discard and open “${name}”`, tone: "danger",
      });
      if (!ok) return;
    }
    onSelect(id);
    setOpen(false);
  };

  const Item = ({ onClick, children, disabled = false }: {
    onClick: () => void; children: React.ReactNode; disabled?: boolean;
  }) => (
    <button
      onClick={() => { if (!disabled) { onClick(); setOpen(false); } }}
      disabled={disabled}
      className="tvc-menu-row w-full gap-2.5 px-2.5 text-left text-sm text-ink disabled:opacity-40"
    >
      {children}
    </button>
  );

  return (
    <div className="group relative flex min-w-0 items-center">
      {/*
        The name, then the save state as a cloud, then a caret of its own.
        TradingView's shape, and the reason for it is not decoration: three
        different questions were being answered by one button. WHICH layout am
        I in (the name), IS IT SAFE (the cloud), and WHAT ELSE CAN I DO (the
        menu) — and the first of those was `hidden 2xl:inline`, so on a 1440
        screen the control was a nameless grid icon. The name is the only thing
        here a user can recognise their workspace by, so it is the part that
        stays.

        The status WORD moved off the bar. "UNSAVED CHANGES" set in 10px caps
        beside the name is a second sentence competing with the name itself,
        and the same fact is already carried by the cloud's badge, by the
        tooltip, by the accessible name and by the menu's own header. A word on
        the primary row is the most expensive place to say it and the least
        readable.
      */}
      <button
        onClick={() => { if (dirty && current) onSaveNow(); }}
        className={`${TOOL_BUTTON} min-w-0`}
        title={`${current?.name ?? "Unnamed layout"} — ${status.label}. ${status.help}`}
        aria-label={`Saved layout — ${current?.name ?? "Unnamed"}, ${status.label}`}
      >
        <span className="hidden min-w-0 max-w-[160px] truncate text-sm font-normal text-ink sm:inline">
          {current?.name ?? "Unnamed"}
        </span>
        {/*
          ── TVP8 R1b-06: the cloud is a STATE, not a permanent glyph ───────
          The cloud carries the state as a SHAPE — a dot badge when the
          workspace is ahead of what is stored, warn-tinted when autosave is
          failing — and clicking writes it. What it must not do is sit on the
          bar when there is nothing to say: measured on the reference, a saved
          layout at rest reads `M SR strategy ⌄` and no cloud, and ours drew a
          22px outline cloud in the most-looked-at part of the right group at
          all times. So it is drawn when there IS drift or an error, and
          otherwise only while the pointer is on the group — which is where a
          user reaching to save would be looking anyway.
        */}
        <span
          className={`relative shrink-0 items-center ${
            dirty || autosaveError ? "flex" : "hidden group-hover:flex"
          } ${autosaveError ? "text-warn" : ""}`}
          aria-hidden="true"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M7 18.5H17.2a4 4 0 0 0 .3-7.6 6 6 0 0 0-11.4-1.3 4.6 4.6 0 0 0 .9 8.9z" />
          </svg>
          {dirty && (
            <span className="absolute left-1/2 top-[11px] h-[5px] w-[5px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-current" />
          )}
        </span>
      </button>

      {/*
        The second half of the split control. 24px, its own accessible name,
        and it is the element the menu's Escape handler returns focus to —
        because it is the element that opened it.
      */}
      <button
        ref={buttonRef}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Manage layouts"
        title="Manage layouts"
        className={TOOL_CARET_BUTTON}
      >
        {/* the shared 8×4 ink caret — the interval and style controls' own */}
        <svg width={TOOL_CARET_GLYPH.width} height={TOOL_CARET_GLYPH.height}
          viewBox={TOOL_CARET_GLYPH.viewBox} fill="none" stroke="currentColor"
          strokeWidth={TOOL_CARET_GLYPH.stroke} strokeLinecap="round"
          strokeLinejoin="round" aria-hidden="true">
          <path d={TOOL_CARET_GLYPH.d} />
        </svg>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div ref={menuRef} role="menu" aria-label="Saved layouts" onKeyDown={onMenuKeyDown}
            style={edgeClamp}
          className="absolute right-0 top-full z-40 mt-1 w-72 tvc-menu">
            <div className="px-3.5 pb-2 pt-1">
              <div className="truncate text-[13px] font-semibold text-ink">
                {current?.name ?? "Unnamed layout"}
              </div>
              <div className={`text-[11px] leading-tight ${status.tone}`}>
                {status.label} — {status.help}
              </div>
            </div>
            <div className="my-1 border-t border-border" />
            <Item onClick={onSaveNow} disabled={!current}>
              <span className="flex-1">Save layout</span>
              <span className="text-xs text-ink-faint">⌘S</span>
            </Item>
            <Item onClick={current ? onCopy : onCreate}>
              <span className="flex-1">Save as…</span>
              <span className="text-xs text-ink-faint">new name</span>
            </Item>
            <Item onClick={onRename} disabled={!current}>Rename…</Item>
            <button
              onClick={onToggleAutosave}
              role="switch"
              aria-checked={autosave}
              className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-[13px] text-ink transition-colors hover:bg-state-hover"
            >
              <span className="flex-1">
                Autosave
                {/* accent-is-meaning: the word echoes its own switch, as in SyncMenu. */}
                <span className={`ml-1.5 text-[10px] font-semibold uppercase tracking-wide ${
                  autosave ? "text-accent" : "text-ink-faint"
                }`}>
                  {autosave ? "On" : "Off"}
                </span>
                {autosaveError && (
                  <span className="mt-0.5 block text-[11px] font-normal text-warn">
                    Last autosave failed: {autosaveError}
                  </span>
                )}
              </span>
              {/* accent-is-meaning: a SWITCH track. */}
              <span className={`relative h-4 w-8 shrink-0 rounded-full transition-colors ${autosave ? "bg-accent" : "bg-border"}`}>
                <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${autosave ? "left-[18px]" : "left-0.5"}`} />
              </span>
            </button>
            {layouts.length > 0 && (
              <>
                <div className="mt-1 border-t border-border px-3.5 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-ink-faint">
                  Open a layout
                </div>
                <div className="max-h-56 overflow-y-auto">
                  {layouts.map((l) => (
                    <div key={l.id} className="group flex items-center">
                      <button
                        onClick={() => selectLayout(l.id, l.name)}
                        aria-current={l.id === currentId ? "true" : undefined}
                        /*
                          `Item` above already uses `.tvc-menu-row`; this list
                          was the one part of the same popover that did not,
                          so its rows were ~28px in a 40px menu.
                        */
                        className="tvc-menu-row flex-1 px-3.5 text-left"
                      >
                        <div className={`text-[13px] text-ink ${l.id === currentId ? "font-semibold" : ""}`}>
                          {l.name}{l.id === currentId ? " — open" : ""}
                        </div>
                        <div className="text-xs text-ink-faint">{l.symbol}, {l.interval}</div>
                      </button>
                      {layouts.length > 1 && (
                        <button
                          onClick={(e) => { e.stopPropagation(); onDelete(l.id); }}
                          className="mr-2 hidden rounded p-1 text-ink-faint hover:text-down focus-visible:block group-hover:block"
                          title={`Delete “${l.name}”`}
                          aria-label={`Delete the layout “${l.name}”`}
                        >
                          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                            <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.4" />
                          </svg>
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
