"use client";
import { useEdgeClamp } from "@/lib/useEdgeClamp";
import { useEffect, useRef } from "react";
import { useAsk } from "@/components/AskDialog";
import { useExclusivePopover } from "@/lib/useExclusivePopover";
import type { Layout } from "@/lib/layouts";
import { TOOL_BUTTON, TOOL_CARET_BUTTON, TOOL_CARET_GLYPH } from "@/components/tv/toolbarChrome";
import { displayTicker } from "@/lib/instrument";
import { isMacPlatform } from "@/lib/shortcuts";
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
 * "Make a copy…" and "Create new layout…" were collapsed into one "Save as…"
 * row once, on the grounds that both prompt for a name and both write the
 * CURRENT workspace to a new record. TVP8 R1c-11 measured the reference and
 * found both rows, in separate groups — because they answer different
 * questions ("keep this arrangement and a copy of it" against "start a new
 * arrangement"), and "Save as…" answers neither out loud. Both are back, each
 * on the handler it always had.
 *
 * Opening a different layout while this one has unsaved changes now asks
 * first. Nothing is overwritten either way — the danger is the opposite one,
 * losing the drift you have not saved — and it is silent without this.
 *
 * This component decides nothing about persistence: `lib/useSavedLayouts` owns
 * the writes, the autosave and the authority over what a layout is.
 */
/**
 * The three glyphs the reference draws in this menu's left gutter.
 *
 * 15-unit boxes at 15px and a 1px stroke, on the same one-unit-one-pixel grid
 * as every other icon in the workstation (R1c-02): two overlapping sheets for
 * a copy, a pencil for a rename, a framed plus for a new layout. The rows that
 * carry no glyph still reserve the gutter, which is what keeps the labels in
 * one column.
 */
const GUTTER_GLYPH = {
  width: 15, height: 15, viewBox: "0 0 15 15", fill: "none",
  stroke: "currentColor", strokeWidth: 1,
  strokeLinecap: "round", strokeLinejoin: "round",
} as const;

const COPY_GLYPH = (
  <svg {...GUTTER_GLYPH}>
    <rect x="5.5" y="1.5" width="8" height="8" rx="1.5" />
    <path d="M10.5 12.5h-7a1 1 0 0 1-1-1v-7" />
  </svg>
);

const RENAME_GLYPH = (
  <svg {...GUTTER_GLYPH}>
    <path d="M2.5 12.5v-2.5l7.5-7.5 2.5 2.5-7.5 7.5z" />
    <path d="M9 3.5l2.5 2.5" />
  </svg>
);

const NEW_GLYPH = (
  <svg {...GUTTER_GLYPH}>
    <rect x="1.5" y="2.5" width="12" height="10" rx="1.5" />
    <path d="M7.5 5.5v4M5.5 7.5h4" />
  </svg>
);

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
  /*
   * The cap printed beside `Save layout` (R1c-11).
   *
   * `useSavedLayouts` binds `metaKey || ctrlKey` + S, so both platforms
   * genuinely have the chord and the cap has to name the right one — a menu
   * that prints ⌘S to a Windows user is advertising a key they do not have.
   */
  const saveCap = isMacPlatform() ? "⌘S" : "Ctrl+S";

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
        help: "This workspace is not stored as a named layout yet. Make a copy… creates one.",
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

  /*
   * One 32px verb row (R1c-11).
   *
   * The reference's manage-layouts menu is a CONTEXT menu — a list of verbs
   * you already know the names of — and it runs at 32px, not at the 40px
   * dropdown pitch. Three of its rows carry a glyph in the left gutter and two
   * carry a hotkey cap at the right; the rest carry neither, and the column
   * they share is what makes the list scannable.
   */
  const Item = ({ onClick, children, disabled = false, glyph, cap }: {
    onClick: () => void;
    children: React.ReactNode;
    disabled?: boolean;
    glyph?: React.ReactNode;
    cap?: string;
  }) => (
    <button
      role="menuitem"
      onClick={() => { if (!disabled) { setOpen(false); onClick(); } }}
      disabled={disabled}
      className="tvc-menu-row w-full gap-2 px-2.5 text-left text-sm text-ink disabled:opacity-40"
    >
      <span className="flex w-[18px] shrink-0 items-center justify-center" aria-hidden="true">
        {glyph}
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {cap !== undefined && (
        <span className="shrink-0 text-[12px] text-ink-faint">{cap}</span>
      )}
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
        {/* R1c-19: the 18.9px line box the interval chips use. `text-sm`'s own
            20px box put the layout name's caps at y=13 where every other word
            on the row sits at 15. */}
        <span className="hidden min-w-0 max-w-[160px] truncate text-sm font-normal leading-[18.9px] text-ink sm:inline">
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
          <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor"
            strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
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
      {/*
        R1c-11: the caret owns the positioning context.

        The menu is anchored `left-0` to THIS box rather than to the group, so
        it opens at the caret's own left edge as the reference's does. Anchored
        to the group it would start at the layout NAME's left edge, and the
        name's width is the user's own — the menu would move whenever they
        renamed their workspace.
      */}
      <div className="relative flex shrink-0 items-center">
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
          {/*
            ── TVP8 R1c-11 / R8: the box, and where it hangs ────────────────

            `tradingview/layouts-menu-1440-dark.png` +
            `measurements/tv-layouts-menu-20260914.md`: [1106,40,201,523] — 201
            wide, its LEFT edge on the caret's left edge, 2px under the 38px
            bar, 32px rows, 12px hotkey caps.

            Ours was 288 wide with `right-0`, so it hung 264px to the LEFT of
            the caret that opened it, and it opened with a two-line header —
            `Unnamed layout / Not saved — …` — that is the name button's own
            tooltip printed twice. A menu is a list of things you can do; a
            paragraph at the top of one is a paragraph in the way of them.
          */}
          <div ref={menuRef} role="menu" aria-label="Saved layouts" onKeyDown={onMenuKeyDown}
            style={edgeClamp}
            className="tvc-menu tvc-menu--compact absolute left-0 top-full z-40 mt-[2px] w-[201px]">
            <Item onClick={onSaveNow} disabled={!current} cap={saveCap}>Save layout</Item>
            <button
              onClick={onToggleAutosave}
              role="switch"
              aria-checked={autosave}
              className="tvc-menu-row w-full gap-2 px-2.5 text-left text-sm text-ink"
            >
              <span className="w-[18px] shrink-0" aria-hidden="true" />
              {/*
                R1c-11: the switch says it, so the word does not.

                This row carried an accent `ON` / `OFF` badge BESIDE the switch
                track that already reports the same state: the accent colour
                spent twice on one fact, on a row the reference draws as a
                label and a track. An autosave failure is still said, because
                that is a different fact and a silent one.
              */}
              <span className="min-w-0 flex-1">
                <span className="block truncate">Autosave</span>
                {autosaveError && (
                  <span className="mt-0.5 block truncate text-[11px] font-normal text-warn">
                    Last autosave failed: {autosaveError}
                  </span>
                )}
              </span>
              {/* accent-is-meaning: a SWITCH track. */}
              <span className={`relative h-4 w-8 shrink-0 rounded-full transition-colors ${autosave ? "bg-accent" : "bg-border"}`}>
                <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${autosave ? "left-[18px]" : "left-0.5"}`} />
              </span>
            </button>

            <div role="separator" className="tvc-menu-sep" />

            {/*
              `Make a copy…`, which is what `Save as…` always did: write the
              CURRENT workspace to a new record and open it. The reference's
              name for the operation is the honest one — nothing is being saved
              somewhere else, a copy is being made.
            */}
            <Item onClick={current ? onCopy : onCreate} glyph={COPY_GLYPH}>Make a copy…</Item>
            <Item onClick={onRename} disabled={!current} glyph={RENAME_GLYPH}>Rename…</Item>
            {/*
              `Download chart data…` is deliberately absent. The reference's row
              exports the loaded window as CSV and this product has no such
              export — not in the More strip's history group, not anywhere. A
              row that cannot do what it says is worse than a missing one.
              Recorded for the owner in the round-4 report.
            */}

            <div role="separator" className="tvc-menu-sep" />

            <Item onClick={onCreate} glyph={NEW_GLYPH}>Create new layout…</Item>

            {layouts.length > 0 && (
              <>
                <div className="tvc-menu-heading">Recently used</div>
                <div className="max-h-[240px] overflow-y-auto">
                  {layouts.map((l) => (
                    <div key={l.id} className="group flex items-center">
                      <button
                        role="menuitem"
                        onClick={() => void selectLayout(l.id, l.name)}
                        aria-current={l.id === currentId ? "true" : undefined}
                        data-active={l.id === currentId ? "true" : undefined}
                        /*
                          ── R8: the row was BROKEN, not merely wrong ────────

                          `.tvc-menu-row` is `display:flex; align-items:center`,
                          and this row's two lines were plain `<div>`s — so
                          they became flex COLUMNS side by side: the name was
                          squeezed to 42px and wrapped one word per line, and
                          the subtitle ran 294px wide out of a 288px menu.
                          `flex-col` and a `min-w-0 truncate` on each line is
                          the whole repair, and it is why the pitch below is a
                          real 48px rather than whatever the wrap produced.
                        */
                        className="tvc-menu-row !min-h-[48px] min-w-0 flex-1 flex-col items-start justify-center gap-0 px-2.5 text-left"
                      >
                        <span className="w-full truncate text-sm">{l.name}</span>
                        {/*
                          R8: `displayTicker`, never the canonical id.

                          This subtitle printed `instrument:v1:BINANCE:spot:…`
                          — the id policy's single prohibition (contract §5),
                          in the menu a user opens to recognise their own
                          workspaces by.
                        */}
                        <span className="w-full truncate text-[12px] text-ink-faint">
                          {displayTicker(l.symbol)}, {l.interval}
                        </span>
                      </button>
                      {layouts.length > 1 && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            /*
                              R8: close FIRST, then ask.

                              `onDelete` opens a confirm dialog, and it was
                              being opened underneath this menu's own
                              click-away overlay — so the reviewer's two
                              deletions "closed the menu and deleted nothing".
                              The confirmation is `useSavedLayouts`' and is
                              unchanged; what changed is that the menu is out
                              of the way before it appears.
                            */
                            setOpen(false);
                            onDelete(l.id);
                          }}
                          className="mr-1.5 hidden rounded p-1 text-ink-faint hover:text-down focus-visible:block group-hover:block"
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
    </div>
  );
}
