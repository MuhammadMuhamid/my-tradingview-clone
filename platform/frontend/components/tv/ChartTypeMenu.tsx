"use client";
import { useEffect, useRef, useState } from "react";
import { CHART_TYPES, type ChartType } from "@/lib/chartType";

/** 14px glyphs, one per presentation, drawn rather than imported. */
const ICONS: Record<ChartType, React.ReactNode> = {
  candles: (
    <>
      <path d="M8 4v16M16 4v16" />
      <rect x="5.5" y="8" width="5" height="8" rx="0.5" />
      <rect x="13.5" y="6" width="5" height="7" rx="0.5" />
    </>
  ),
  bars: (
    <>
      <path d="M8 4v16M16 5v14" />
      <path d="M5 8h3M8 14h3M13 9h3M16 16h3" />
    </>
  ),
  line: <path d="M3 16l5-6 4 4 3-5 6 6" />,
  area: (
    <>
      <path d="M3 16l5-6 4 4 3-5 6 6" />
      <path d="M3 16l5-6 4 4 3-5 6 6V20H3z" fill="currentColor" fillOpacity="0.25" stroke="none" />
    </>
  ),
};

/**
 * Chart-type selector, in TradingView's position: immediately after the
 * timeframe, because the two together are what the eye reads as "what am I
 * looking at".
 *
 * Every entry draws the same OHLC candles the chart already holds. There is
 * deliberately no Heikin-Ashi / Renko / Kagi / Range / P&F here — those invent
 * their own bars, and offering them without the engine to compute them would
 * put prices on screen that never traded.
 */
export function ChartTypeMenu({
  value, onChange,
}: {
  value: ChartType;
  onChange: (next: ChartType) => void;
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

  const active = CHART_TYPES.find((t) => t.value === value) ?? CHART_TYPES[0]!;

  return (
    <div ref={boxRef} className="relative shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        title={`Chart type — ${active.label}`}
        aria-label={`Chart type — currently ${active.label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 transition-colors ${
          open ? "bg-surface-2 text-accent" : "text-ink-muted hover:bg-surface-2 hover:text-ink"
        }`}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
          {ICONS[value]}
        </svg>
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="text-ink-faint" aria-hidden="true">
          <path d="M5 9l7 7 7-7" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Chart type"
          className="absolute left-0 top-[32px] z-50 w-[220px] rounded-md border border-border bg-surface py-1 shadow-xl"
        >
          {CHART_TYPES.map((t) => (
            <button
              key={t.value}
              role="menuitemradio"
              aria-checked={t.value === value}
              onClick={() => { onChange(t.value); setOpen(false); }}
              className={`flex w-full items-center gap-2.5 px-2.5 py-1.5 text-left transition-colors hover:bg-surface-2 ${
                t.value === value ? "text-accent" : "text-ink"
              }`}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="shrink-0" aria-hidden="true">
                {ICONS[t.value]}
              </svg>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] leading-tight">{t.label}</span>
                <span className="block text-[11px] leading-tight text-ink-faint">{t.hint}</span>
              </span>
              {t.value === value && (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="shrink-0" aria-hidden="true">
                  <path d="M4 12l5 5L20 6" />
                </svg>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
