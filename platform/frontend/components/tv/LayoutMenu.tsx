"use client";
import { useState } from "react";
import type { Layout } from "@/lib/layouts";

/**
 * TradingView-style layout menu (top-right): Save layout, Autosave toggle,
 * Make a copy, Rename, Create new layout, recently-used list, delete.
 */
export function LayoutMenu({
  layouts, currentId, autosave, dirty,
  onSelect, onSaveNow, onToggleAutosave, onCreate, onCopy, onRename, onDelete,
}: {
  layouts: Layout[];
  currentId: string | null;
  autosave: boolean;
  dirty: boolean;
  onSelect: (id: string) => void;
  onSaveNow: () => void;
  onToggleAutosave: () => void;
  onCreate: () => void;
  onCopy: () => void;
  onRename: () => void;
  onDelete: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = layouts.find((l) => l.id === currentId) ?? null;

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
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded px-2 py-1 text-[13px] text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
        title="Manage layouts"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 12h18M12 3v18" />
        </svg>
        <span className="max-w-[140px] truncate">{current?.name ?? "Unnamed"}{dirty && !autosave ? " •" : ""}</span>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 3.5l3 3 3-3" stroke="currentColor" strokeWidth="1.4" /></svg>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-40 mt-1 w-72 rounded-lg border border-border bg-surface py-1.5 shadow-2xl">
            <Item onClick={onSaveNow} disabled={!current}>
              <span className="flex-1">Save layout</span>
              <span className="text-xs text-ink-faint">⌘S</span>
            </Item>
            <button
              onClick={onToggleAutosave}
              className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-[13px] text-ink transition-colors hover:bg-surface-2"
            >
              <span className="flex-1">Autosave</span>
              <span className={`relative h-4 w-8 rounded-full transition-colors ${autosave ? "bg-accent" : "bg-border"}`}>
                <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${autosave ? "left-[18px]" : "left-0.5"}`} />
              </span>
            </button>
            <div className="my-1 border-t border-border" />
            <Item onClick={onCopy} disabled={!current}>Make a copy…</Item>
            <Item onClick={onRename} disabled={!current}>Rename…</Item>
            <div className="my-1 border-t border-border" />
            <Item onClick={onCreate}>
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M6.5 1v11M1 6.5h11" stroke="currentColor" strokeWidth="1.4" /></svg>
              Create new layout…
            </Item>
            {layouts.length > 0 && (
              <>
                <div className="mt-1 border-t border-border px-3.5 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-ink-faint">
                  Recently used
                </div>
                <div className="max-h-56 overflow-y-auto">
                  {layouts.map((l) => (
                    <div key={l.id} className="group flex items-center hover:bg-surface-2">
                      <button
                        onClick={() => { onSelect(l.id); setOpen(false); }}
                        className="flex-1 px-3.5 py-1.5 text-left"
                      >
                        <div className={`text-[13px] ${l.id === currentId ? "text-accent" : "text-ink"}`}>{l.name}</div>
                        <div className="text-xs text-ink-faint">{l.symbol}, {l.interval}</div>
                      </button>
                      {layouts.length > 1 && (
                        <button
                          onClick={(e) => { e.stopPropagation(); onDelete(l.id); }}
                          className="mr-2 hidden rounded p-1 text-ink-faint hover:text-down group-hover:block"
                          title="Delete layout"
                        >
                          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.4" /></svg>
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
