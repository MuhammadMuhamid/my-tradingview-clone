"use client";
import { useEffect, useRef, useState } from "react";
import { SYNC_LABELS, type SyncOptions } from "@/lib/paneSync";

/**
 * TradingView's "Sync in layout" menu: which properties the second chart
 * follows from the first. Each row is an independent toggle, because the
 * useful combinations are not nested — syncing the crosshair while keeping
 * two different timeframes is the whole point of a split.
 */
export function SyncMenu({
  value, onChange, disabled = false,
}: {
  value: SyncOptions;
  onChange: (next: SyncOptions) => void;
  /** No second pane open, so there is nothing to synchronise with. */
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onEsc);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  const activeCount = SYNC_LABELS.filter((o) => value[o.id]).length;

  return (
    <div ref={boxRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        title={disabled ? "Open a split pane to synchronise it" : "Sync in layout"}
        className={`flex items-center gap-1.5 rounded px-2 py-1 text-[13px] transition-colors disabled:opacity-40 ${
          open ? "bg-surface-2 text-accent" : "text-ink-muted hover:bg-surface-2 hover:text-ink"
        }`}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M4 8h11a4 4 0 010 8H9" /><path d="M7 5L4 8l3 3" />
        </svg>
        Sync
        {!disabled && activeCount > 0 && (
          <span className="rounded-full bg-accent px-1.5 text-[10px] font-semibold text-white">
            {activeCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-[34px] z-50 w-[290px] rounded-md border border-border bg-surface py-1 shadow-xl">
          <div className="px-3 py-1.5 text-[10px] uppercase tracking-wide text-ink-faint">
            Sync in layout
          </div>
          {SYNC_LABELS.map((o) => {
            const on = value[o.id];
            return (
              <button
                key={o.id}
                onClick={() => onChange({ ...value, [o.id]: !on })}
                className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-surface-2"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] text-ink">{o.label}</span>
                  <span className="block text-[11px] leading-tight text-ink-faint">{o.help}</span>
                </span>
                {/* A switch, not a checkbox: these are continuing states. */}
                <span
                  aria-hidden
                  className={`relative h-[18px] w-[32px] shrink-0 rounded-full transition-colors ${
                    on ? "bg-accent" : "bg-border"
                  }`}
                >
                  <span
                    className={`absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white transition-all ${
                      on ? "left-[16px]" : "left-[2px]"
                    }`}
                  />
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
