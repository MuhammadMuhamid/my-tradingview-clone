"use client";
import { useEffect, useRef, useState } from "react";
import type { Layout } from "@/lib/layouts";

/**
 * The saved layout this workspace is on, and what can be done with it.
 *
 * ── What changed and why ───────────────────────────────────────────────────
 *
 * The trigger said the layout's name and appended a bare "•" when the
 * workspace had drifted from it. That dot is the entire difference between
 * "your work is on the server" and "your work is only in this tab", and it was
 * a single character with no label, no tooltip and no announcement. The state
 * is now spelt out — Saved / Unsaved changes / Saving… / Autosave failing —
 * next to the name, so it can be read rather than decoded.
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
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
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
  }, [open]);

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
  const selectLayout = (id: string, name: string): void => {
    if (id !== currentId && dirty && !autosave && current) {
      const ok = window.confirm(
        `“${current.name}” has unsaved changes. Opening “${name}” discards them.\n\n`
        + "Cancel, then use Save layout first if you want to keep them."
      );
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
      className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-[13px] text-ink transition-colors hover:bg-surface-2 disabled:opacity-40"
    >
      {children}
    </button>
  );

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2 text-[13px] text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
        title={`${current?.name ?? "Unnamed layout"} — ${status.help}`}
        aria-label={`Saved layouts — ${current?.name ?? "not saved"}, ${status.label}`}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 12h18M12 3v18" />
        </svg>
        {/* Below xl the primary row is already full at 1024 with the watchlist
            open; the name is in the menu and the tooltip, the icon stays. */}
        <span className="hidden min-w-0 max-w-[130px] truncate xl:inline">{current?.name ?? "Unnamed"}</span>
        {/*
          "Not saved" is only worth a word once there is something to save: a
          fresh workspace with no layouts and no changes is not in a state that
          needs announcing, and "UNNAMED · NOT SAVED" on the primary row before
          the feature had ever been used read as an error.
        */}
        {(current !== null || dirty || autosaveError || layouts.length > 0) && (
          <span className={`hidden shrink-0 text-[10px] font-medium uppercase tracking-wide 2xl:inline ${status.tone}`}>
            {status.label}
          </span>
        )}
        {/* Below 2xl the words do not fit, so the state keeps a shape as well
            as a colour rather than disappearing entirely. */}
        {(dirty || autosaveError) && (
          <span className={`shrink-0 2xl:hidden ${status.tone}`} aria-hidden="true">
            {autosaveError ? (
              <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor"
                strokeWidth="1.3" strokeLinecap="round">
                <path d="M7 1.6L13 12H1L7 1.6Z" strokeLinejoin="round" />
                <path d="M7 5.6v3" /><path d="M7 10.4h.01" />
              </svg>
            ) : (
              <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
                <circle cx="4" cy="4" r="3" fill="currentColor" />
              </svg>
            )}
          </span>
        )}
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
          <path d="M2 3.5l3 3 3-3" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div role="menu" aria-label="Saved layouts"
            className="absolute right-0 top-full z-40 mt-1 w-72 rounded-lg border border-border bg-surface py-1.5 shadow-2xl">
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
              className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-[13px] text-ink transition-colors hover:bg-surface-2"
            >
              <span className="flex-1">
                Autosave
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
                    <div key={l.id} className="group flex items-center hover:bg-surface-2">
                      <button
                        onClick={() => selectLayout(l.id, l.name)}
                        aria-current={l.id === currentId ? "true" : undefined}
                        className="flex-1 px-3.5 py-1.5 text-left"
                      >
                        <div className={`text-[13px] ${l.id === currentId ? "font-semibold text-accent" : "text-ink"}`}>
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
