"use client";
import { useEffect, useRef, useState } from "react";
import { SYNC_LABELS, type SyncOptions } from "@/lib/paneSync";

/**
 * Which properties the charts in this layout follow from one another.
 *
 * Each row is an independent toggle, because the useful combinations are not
 * nested — syncing the crosshair while keeping several different timeframes is
 * the whole point of a multi-chart layout.
 *
 * ── Only what works appears here ───────────────────────────────────────────
 *
 * Every switch changes behaviour. That is worth stating because it was not
 * true: four of the five used to be decorative, writing state nothing read
 * (see `lib/paneSync` for what was wrong and what replaced it). The list is
 * `SYNC_LABELS` and nothing else, so a switch cannot be added to this menu
 * without a mechanism behind it.
 *
 * There is deliberately no "drawings" switch, even though TradingView has one.
 * Drawings in this product are stored per SYMBOL, not per pane, so every chart
 * showing the same instrument already shows the same drawings and a toggle
 * would either do nothing or promise a per-pane isolation the store cannot
 * provide. The footnote says so rather than leaving a conspicuous gap.
 */
export function SyncMenu({
  value, onChange, disabled = false,
}: {
  value: SyncOptions;
  onChange: (next: SyncOptions) => void;
  /** Only one pane in the layout, so there is nothing to synchronise with. */
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };
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
        ref={buttonRef}
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={disabled
          ? "Sync across charts — unavailable with one chart"
          : `Sync across charts — ${activeCount} of ${SYNC_LABELS.length} on`}
        title={disabled
          ? "Add a second chart to synchronise it"
          : "What every chart in this layout follows"}
        className={`flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[13px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
          open ? "bg-surface-2 text-accent" : "text-ink-muted hover:bg-surface-2 hover:text-ink"
        }`}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <path d="M4 8h11a4 4 0 010 8H9" /><path d="M7 5L4 8l3 3" />
        </svg>
        <span className="hidden xl:inline">Sync</span>
        {!disabled && activeCount > 0 && (
          <span className="rounded-full bg-accent px-1.5 text-[10px] font-semibold text-white">
            {activeCount}
          </span>
        )}
      </button>

      {open && (
        <div role="menu" aria-label="Sync across charts"
          className="absolute right-0 top-[34px] z-50 w-[300px] rounded-md border border-border bg-surface py-1 shadow-xl">
          <div className="px-3 pb-1 pt-2">
            <div className="text-[10px] uppercase tracking-wide text-ink-faint">
              Sync across charts
            </div>
            <p className="mt-0.5 text-[11px] leading-tight text-ink-faint">
              Applies to every chart in this layout, not just the focused one.
            </p>
          </div>
          {SYNC_LABELS.map((o) => {
            const on = value[o.id];
            return (
              <button
                key={o.id}
                role="switch"
                aria-checked={on}
                onClick={() => onChange({ ...value, [o.id]: !on })}
                className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-surface-2"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] text-ink">
                    {o.label}
                    {/*
                      The state in words as well as in the switch's position:
                      a pill that is simply a different colour when on is state
                      told by colour alone.
                    */}
                    <span className={`ml-1.5 text-[10px] font-semibold uppercase tracking-wide ${
                      on ? "text-accent" : "text-ink-faint"
                    }`}>
                      {on ? "On" : "Off"}
                    </span>
                  </span>
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
          <p className="border-t border-border px-3 py-2 text-[11px] leading-tight text-ink-faint">
            Drawings are stored per instrument, so every chart on the same symbol already shares
            them — there is nothing to switch.
          </p>
        </div>
      )}
    </div>
  );
}
