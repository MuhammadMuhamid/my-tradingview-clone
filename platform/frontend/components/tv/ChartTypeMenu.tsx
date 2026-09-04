"use client";
import { useEffect, useRef, useState } from "react";
import {
  CHART_TYPES, SYNTHETIC_DISCLOSURE_HINT, syntheticDisclosure, type ChartType,
} from "@/lib/chartType";

/** 14px glyphs, one per type, drawn rather than imported. */
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
  // Heikin Ashi: candle bodies that abut, because HA bars open at the previous
  // bar's midpoint rather than at a gap.
  heikinAshi: (
    <>
      <path d="M7 5v14M12 6v13M17 4v14" />
      <rect x="4.5" y="9" width="5" height="7" rx="0.5" />
      <rect x="9.5" y="8" width="5" height="7" rx="0.5" />
      <rect x="14.5" y="6" width="5" height="7" rx="0.5" />
    </>
  ),
  // Renko: equal bricks stepping on a diagonal, with no wicks and no gaps.
  renko: (
    <>
      <rect x="3" y="14" width="6" height="6" rx="0.5" />
      <rect x="9" y="8" width="6" height="6" rx="0.5" />
      <rect x="15" y="2" width="6" height="6" rx="0.5" />
    </>
  ),
};

const PRESENTATIONS = CHART_TYPES.filter((t) => t.group === "presentation");
const TRANSFORMS = CHART_TYPES.filter((t) => t.group === "transform");

/**
 * Chart-type selector, in TradingView's position: immediately after the
 * timeframe, because the two together are what the eye reads as "what am I
 * looking at".
 *
 * ── Why the menu has two shelves ───────────────────────────────────────────
 *
 * The first group draws the exchange's own candles. The second derives bars
 * that never traded. Those are not interchangeable choices and the menu does
 * not present them as one list: the transforms sit below a rule, under a
 * heading that says what they are, and the trigger button grows a written
 * label whenever one is active — a canonical chart shows only its glyph, so a
 * label on this button always means "you are not looking at raw candles".
 *
 * Only implemented types appear. There are no greyed-out placeholders for
 * Kagi, Range or Point & Figure: an entry that cannot be chosen teaches the
 * user nothing except that the menu lies about what the product does.
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
  const synthetic = syntheticDisclosure(active.value);

  const row = (t: typeof CHART_TYPES[number]) => (
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
  );

  return (
    <div ref={boxRef} className="relative shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        title={synthetic
          ? `Chart type — ${active.label}. ${SYNTHETIC_DISCLOSURE_HINT}`
          : `Chart type — ${active.label}`}
        aria-label={synthetic
          ? `Chart type — currently ${active.label}, a synthetic display transform`
          : `Chart type — currently ${active.label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 transition-colors ${
          open ? "bg-surface-2 text-accent" : "text-ink-muted hover:bg-surface-2 hover:text-ink"
        }`}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
          {ICONS[value]}
        </svg>
        {/* The label is the disclosure, so it is only ever drawn for a
            transform — and it is drawn even when the toolbar is tight. */}
        {synthetic && (
          <span className="whitespace-nowrap text-[11px] leading-none text-warn">{synthetic}</span>
        )}
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="text-ink-faint" aria-hidden="true">
          <path d="M5 9l7 7 7-7" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Chart type"
          className="absolute left-0 top-[32px] z-50 w-[248px] rounded-md border border-border bg-surface py-1 shadow-xl"
        >
          {PRESENTATIONS.map(row)}
          <div className="mt-1 border-t border-border pt-1">
            <div className="px-2.5 pb-0.5 text-[10px] uppercase leading-tight tracking-wide text-ink-faint">
              Transforms · display only
            </div>
            <p className="px-2.5 pb-1 text-[10px] leading-tight text-ink-faint">
              Derived bars. Orders, alerts, strategies and backtests keep using
              the exchange&rsquo;s own candles.
            </p>
            {TRANSFORMS.map(row)}
          </div>
        </div>
      )}
    </div>
  );
}
