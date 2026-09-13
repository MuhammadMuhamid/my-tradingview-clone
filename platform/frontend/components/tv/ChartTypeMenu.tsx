"use client";
import { useEffect, useRef } from "react";
import { useExclusivePopover } from "@/lib/useExclusivePopover";
import {
  CHART_TYPES, SYNTHETIC_DISCLOSURE_HINT, syntheticDisclosure,
  type ChartType, type TransformSettings,
} from "@/lib/chartType";
import { TOOL_BUTTON } from "@/components/tv/toolbarChrome";
import { menuItems, moveMenuFocus } from "@/lib/menuKeyboard";

/** 14px glyphs, one per type, drawn rather than imported. */
const ICONS: Record<ChartType, React.ReactNode> = {
  candles: (
    <>
      <path d="M8 4v16M16 4v16" />
      <rect x="5.5" y="8" width="5" height="8" rx="0.5" />
      <rect x="13.5" y="6" width="5" height="7" rx="0.5" />
    </>
  ),
  // The same glyph as candles, with the up body unfilled — which is the
  // only difference between the two types.
  hollowCandles: (
    <>
      <path d="M8 4v16M16 4v16" />
      <rect x="5.5" y="8" width="5" height="8" rx="0.5" fill="none" />
      <rect x="13.5" y="6" width="5" height="7" rx="0.5" fill="currentColor" />
    </>
  ),
  volumeCandles: (
    <>
      <path d="M8 4v16M16 4v16" />
      <rect x="5.5" y="8" width="5" height="8" rx="0.5" fill="currentColor" fillOpacity="0.25" />
      <rect x="13.5" y="6" width="5" height="7" rx="0.5" fill="currentColor" fillOpacity="0.8" />
    </>
  ),
  bars: (
    <>
      <path d="M8 4v16M16 5v14" />
      <path d="M5 8h3M8 14h3M13 9h3M16 16h3" />
    </>
  ),
  stepLine: <path d="M3 17h4v-5h4v3h4v-6h6" />,
  // A dashed reference with fill above and below it, which is the idea.
  baseline: (
    <>
      <path d="M3 12h18" strokeDasharray="2 2" />
      <path d="M3 16l5-6 4 4 3-5 6 6" />
    </>
  ),
  columns: <path d="M4 20V12h3v8zM10 20V7h3v13zM16 20V4h3v16z" fill="currentColor" />,
  highLow: <><path d="M8 4v16M16 4v16" /><path d="M5 8h6M13 15h6" /></>,
  sessionVolumeProfile: <><path d="M4 4v16M20 4v16" /><path d="M20 7h-6M20 11h-10M20 15h-7" /></>,
  tpo: <><path d="M4 4v16M20 4v16" /><path d="M7 7h10M7 11h7M7 15h10" /><circle cx="9" cy="7" r="1" fill="currentColor" /><circle cx="12" cy="11" r="1" fill="currentColor" /><circle cx="15" cy="15" r="1" fill="currentColor" /></>,
  range: <><rect x="4" y="13" width="6" height="7" /><rect x="10" y="6" width="6" height="7" /><rect x="16" y="10" width="4" height="6" /></>,
  footprint: <><path d="M5 4v16M19 4v16" /><path d="M5 7h9M5 11h13M5 15h7" /><circle cx="16" cy="7" r="1" fill="currentColor" /><circle cx="10" cy="15" r="1" fill="currentColor" /></>,
  line: <path d="M3 16l5-6 4 4 3-5 6 6" />,
  lineWithMarkers: (
    <><path d="M3 16l5-6 4 4 3-5 6 6" /><circle cx="8" cy="10" r="1.5" fill="currentColor" /><circle cx="15" cy="9" r="1.5" fill="currentColor" /></>
  ),
  area: (
    <>
      <path d="M3 16l5-6 4 4 3-5 6 6" />
      <path d="M3 16l5-6 4 4 3-5 6 6V20H3z" fill="currentColor" fillOpacity="0.25" stroke="none" />
    </>
  ),
  hlcArea: (
    <><path d="M3 16l5-6 4 4 3-5 6 6V20H3z" fill="currentColor" fillOpacity="0.2" stroke="none" /><path d="M3 16l5-6 4 4 3-5 6 6" /><path d="M3 19l5-4 4 2 3-3 6 4" strokeDasharray="2 2" /></>
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
  lineBreak: <><path d="M4 18h5v-5h5V8h6" /><path d="M4 13h5V8h5V4h6" /></>,
  kagi: <path d="M5 19V8h5v8h5V5h4" />,
  pointAndFigure: <><circle cx="7" cy="17" r="2.5" /><path d="M7 14V7h10" /><path d="M17 4v6" /></>,
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
 * Only implemented types appear; trade-driven types remain truthful when
 * their public execution feed is temporarily unavailable by drawing no data.
 */
export function ChartTypeMenu({
  value, onChange, settings,
}: {
  value: ChartType;
  onChange: (next: ChartType) => void;
  /**
   * The focused pane's settings, so the trigger's disclosure text names the
   * parameters actually in force rather than the build's defaults.
   */
  settings?: TransformSettings;
}) {
  // One popover open at a time across the whole toolbar — these menus
  // hang off buttons a few pixels apart, so two open at once overlap and
  // compete for the same clicks. See `lib/popoverGroup`.
  const [open, setOpen] = useExclusivePopover("chart-type");
  const boxRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setOpen(false); buttonRef.current?.focus(); }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onEsc);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onEsc);
    };
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

  const active = CHART_TYPES.find((t) => t.value === value) ?? CHART_TYPES[0]!;
  const synthetic = syntheticDisclosure(active.value, settings);

  /*
   * ── Why the hint moved into the tooltip ───────────────────────────────────
   *
   * Every row used to be two lines: the type's name, and a sentence of prose
   * under it explaining what it draws. Twenty-one of those made a 900px-tall
   * menu that did not fit the viewport it opens in, and turned a control a
   * trader uses reflexively into something that has to be read.
   *
   * The prose is genuinely useful and none of it is gone — it is the row's
   * `title`, which is where a workstation puts an explanation it does not
   * want in the way. The rows are now 40px, single-line, icon-then-label,
   * which is the measured shape of TradingView's own.
   */
  const row = (t: typeof CHART_TYPES[number]) => (
    <button
      key={t.value}
      role="menuitemradio"
      aria-checked={t.value === value}
      title={`${t.label} — ${t.hint}`}
      onClick={() => { onChange(t.value); setOpen(false); }}
      className="tvc-menu-row gap-2.5 px-2.5 text-left text-sm text-ink"
    >
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="shrink-0" aria-hidden="true">
        {ICONS[t.value]}
      </svg>
      <span className="min-w-0 flex-1 truncate">{t.label}</span>
    </button>
  );

  /*
   * The presentation shelf, divided the way TradingView divides it: price
   * bars, then line forms, then filled forms, then discrete forms, then the
   * trade-driven profiles. A hairline and no heading — the shapes of the
   * glyphs already say what each group is, and five headings in a menu this
   * size would cost more rows than they explain.
   */
  const SHELF_BREAKS = new Set(["line", "area", "columns", "sessionVolumeProfile"]);
  const presentationRows = PRESENTATIONS.flatMap((t) => (
    SHELF_BREAKS.has(t.value)
      ? [<div key={`sep-${t.value}`} className="tvc-menu-sep" role="separator" />, row(t)]
      : [row(t)]
  ));

  return (
    <div ref={boxRef} className="relative shrink-0">
      <button
        ref={buttonRef}
        onClick={() => setOpen(!open)}
        title={synthetic
          ? `Chart type — ${active.label}. ${SYNTHETIC_DISCLOSURE_HINT}`
          : `Chart type — ${active.label}`}
        aria-label={synthetic
          ? `Chart type — currently ${active.label}, a synthetic display transform`
          : `Chart type — currently ${active.label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`${TOOL_BUTTON} gap-1`}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
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
          ref={menuRef}
          role="menu"
          aria-label="Chart type"
          onKeyDown={onMenuKeyDown}
          className="absolute left-0 top-full z-50 max-h-[calc(100vh-52px)] w-[264px] overflow-y-auto tvc-menu"
        >
          {presentationRows}
          {/*
            The transform shelf keeps its heading where the presentation
            shelves do not, and that asymmetry is the point: a Kagi chart is
            not another way of drawing the market's bars, it is bars that never
            traded. The sentence that used to sit under this heading is now its
            tooltip — one line of chrome instead of three, with the disclosure
            itself still on screen and the full statement one hover away. The
            trigger button also grows a written label whenever a transform is
            active, which is the disclosure that cannot be missed.
          */}
          <div className="tvc-menu-sep" role="separator" />
          <div
            title="Derived bars. Orders, alerts, strategies and backtests keep using the exchange's own candles."
            className="px-2.5 pb-0.5 pt-1 text-[10px] uppercase leading-tight tracking-wide text-ink-faint"
          >
            Transforms · display only
          </div>
          {TRANSFORMS.map(row)}
        </div>
      )}
    </div>
  );
}
