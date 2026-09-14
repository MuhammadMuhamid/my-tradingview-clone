"use client";
import { useEdgeClamp } from "@/lib/useEdgeClamp";
import { useCallback, useEffect, useRef, useState } from "react";
import { useExclusivePopover } from "@/lib/useExclusivePopover";
import {
  CHART_TYPES, SYNTHETIC_DISCLOSURE_HINT, isChartType, syntheticDisclosure,
  type ChartType, type ChartTypeSpec, type TransformSettings,
} from "@/lib/chartType";
import {
  TOOL_CARET_BUTTON, TOOL_CARET_GLYPH, TOOL_ICON_STROKE, TOOL_STATE, TOOLBAR_H,
} from "@/components/tv/toolbarChrome";
import { menuItems, moveMenuFocus } from "@/lib/menuKeyboard";

/**
 * 22px glyphs, one per type, drawn rather than imported.
 *
 * Ours, not the reference's: these are silhouettes of the same CHARTS — two
 * OHLC ticks, two candles, a staircase, a stack of bricks — which is the part
 * that has to be recognisable at 22px, and the drawing is original. Stroke
 * `TOOL_ICON_STROKE` with round caps, matching every other icon on this bar.
 *
 * ── TVP8 R1b-03: each silhouette has to be DISTINCT, and thin ──────────────
 *
 * Three of these were near-identical bold candle pairs (Candles / Hollow
 * candles / Volume candles), the strip's Heikin Ashi was a three-candle
 * cluster carrying 2.5× the reference's ink, and Columns was three FILLED
 * ascending bars — a signal-strength icon. The rule the reference follows and
 * this now follows: hollow bodies, one difference per type, and ~19–22px of
 * the 24-unit box rather than 16.
 */
const ICONS: Record<ChartType, React.ReactNode> = {
  bars: (
    <>
      <path d="M8 4v16M16 5v14" />
      <path d="M5 8h3M8 14h3M13 9h3M16 16h3" />
    </>
  ),
  // Two thin HOLLOW candles of different heights, each with both wicks.
  candles: (
    <>
      <path d="M7.6 2.2v19.6M16.4 3.8v16.4" />
      <rect x="4.6" y="6.4" width="6" height="11.2" rx="0.5" />
      <rect x="13.4" y="8.6" width="6" height="7" rx="0.5" />
    </>
  ),
  // The same glyph as candles, with the up body unfilled — which is the
  // only difference between the two types.
  hollowCandles: (
    <>
      <path d="M7.6 2.2v19.6M16.4 3.8v16.4" />
      <rect x="4.6" y="6.4" width="6" height="11.2" rx="0.5" fill="currentColor" />
      <rect x="13.4" y="8.6" width="6" height="7" rx="0.5" fill="none" />
    </>
  ),
  // Bodies of DIFFERENT WIDTHS, which is what a volume candle actually is:
  // the width carries the bar's traded volume.
  volumeCandles: (
    <>
      <path d="M6.4 2.6v18.8M16.6 4.6v15.4" />
      <rect x="2.4" y="7" width="8" height="10" rx="0.5" />
      <rect x="14.4" y="8.6" width="4.4" height="7" rx="0.5" />
    </>
  ),
  // Straight SEGMENTS, mitred: the reference's line forms are zigzags, and a
  // rounded join at 22px is what made ours read as smooth waves (R1b-03).
  line: <path d="M2.4 17.4l5-6 4.4 3.6 10-9.4" strokeLinejoin="miter" />,
  lineWithMarkers: (
    <>
      <path d="M2.4 17.4l5-6 4.4 3.6 10-9.4" strokeLinejoin="miter" />
      <circle cx="7.4" cy="11.4" r="1.6" fill="currentColor" />
      <circle cx="11.8" cy="15" r="1.6" fill="currentColor" />
    </>
  ),
  stepLine: <path d="M2 18.4h4.8v-6h4.8v3.6h4.8v-7.2H22" strokeLinejoin="miter" />,
  area: (
    <>
      <path d="M2.4 17.4l5-6 4.4 3.6 10-9.4" strokeLinejoin="miter" />
      <path d="M2.4 17.4l5-6 4.4 3.6 10-9.4V21.4H2.4z"
        fill="currentColor" fillOpacity="0.25" stroke="none" />
    </>
  ),
  // A BAND between the highs and the lows, with the closes traced through it —
  // which is the whole of what an HLC area draws.
  hlcArea: (
    <>
      <path d="M3 9L8 5L12 9L15 5L21 9L21 17L15 13L12 17L8 13L3 17Z"
        fill="currentColor" fillOpacity="0.2" stroke="none" />
      <path d="M3 9l5-4 4 4 3-4 6 4" />
      <path d="M3 17l5-4 4 4 3-4 6 4" />
    </>
  ),
  // A dashed reference with the line crossing it, which is the idea.
  baseline: (
    <>
      <path d="M2 12h20" strokeDasharray="2 2" />
      <path d="M2.4 17.4l5-6 4.4 3.6 10-9.4" strokeLinejoin="miter" />
    </>
  ),
  // Three HOLLOW bars. Filled ascending bars are a signal-strength icon, and
  // that is exactly what a viewer read them as (R1b-03).
  columns: (
    <>
      <rect x="2.6" y="12.4" width="5.2" height="9.4" />
      <rect x="9.4" y="6.6" width="5.2" height="15.2" />
      <rect x="16.2" y="2.6" width="5.2" height="19.2" />
    </>
  ),
  // Ranges and nothing else: no open, no close, no body.
  // Two hollow RANGE bars: no open, no close, no body — only the extremes.
  highLow: (
    <>
      <rect x="4.2" y="4.2" width="6.4" height="12.6" />
      <rect x="13.4" y="8" width="6.4" height="11.8" />
    </>
  ),
  // Stacked cells — a footprint prints a number in every price cell of every
  // bar, and the grid is what distinguishes it from a candle at this size.
  // A candle beside the rows of numbers a footprint prints in every cell.
  footprint: (
    <>
      <path d="M6 2.4v19.2" />
      <rect x="3" y="6.2" width="6" height="11.6" rx="0.5" />
      <path d="M12 6.4h9.6M12 11h9.6M12 15.6h9.6" />
    </>
  ),
  // Letter blocks, stacked into the profile they build.
  tpo: (
    <>
      <rect x="4" y="5" width="4" height="3.4" rx="0.4" />
      <rect x="9" y="5" width="4" height="3.4" rx="0.4" />
      <rect x="4" y="10.3" width="4" height="3.4" rx="0.4" />
      <rect x="9" y="10.3" width="4" height="3.4" rx="0.4" />
      <rect x="14" y="10.3" width="4" height="3.4" rx="0.4" />
      <rect x="4" y="15.6" width="4" height="3.4" rx="0.4" />
    </>
  ),
  // A horizontal histogram BESIDE a candle, which is the layout of the thing.
  sessionVolumeProfile: (
    <>
      <path d="M6.5 4v16" />
      <rect x="4" y="8" width="5" height="8" rx="0.5" />
      <path d="M12 6h8M12 10h5M12 14h7M12 18h3" />
    </>
  ),
  // Heikin Ashi: candle bodies that abut, because HA bars open at the previous
  // bar's midpoint rather than at a gap.
  // One candle and a small square, which is the reference's own 13×19
  // silhouette. Ours was a three-candle cluster carrying 2.5× its ink.
  heikinAshi: (
    <>
      <path d="M7.6 2.4v19.2" />
      <rect x="4.6" y="7.6" width="6" height="10.4" rx="0.5" />
      <path d="M16.6 3.4v3" />
      <rect x="13.8" y="6.4" width="5.6" height="5.6" rx="0.5" />
    </>
  ),
  // Renko: equal bricks stepping on a diagonal, with no wicks and no gaps.
  renko: (
    <>
      <rect x="3.4" y="15.4" width="5.8" height="5.8" rx="0.5" />
      <rect x="9.2" y="8.6" width="5.8" height="5.8" rx="0.5" />
      <rect x="15" y="1.8" width="5.8" height="5.8" rx="0.5" />
    </>
  ),
  // Line break: TALL blocks of unequal height — a line runs from the previous
  // close to the breaking one, so its height is whatever the break was worth.
  lineBreak: (
    <>
      <rect x="4" y="11" width="4" height="8" rx="0.5" />
      <rect x="10" y="5" width="4" height="9" rx="0.5" />
      <rect x="16" y="8" width="4" height="7" rx="0.5" />
    </>
  ),
  // Kagi: one path whose WIDTH changes at the shoulder, which is the entire
  // signal the chart carries.
  kagi: (
    <>
      <path d="M5 19v-8h4" strokeWidth="2.6" />
      <path d="M9 11v6h4" strokeWidth="1.2" />
      <path d="M13 17V6h5" strokeWidth="2.6" />
    </>
  ),
  pointAndFigure: (
    <>
      <path d="M4 6l4 4M8 6l-4 4" />
      <path d="M4 13l4 4M8 13l-4 4" />
      <circle cx="14" cy="8" r="2" />
      <circle cx="14" cy="14" r="2" />
      <path d="M18 10l3 3M21 10l-3 3" />
    </>
  ),
  // Range: bodies of EQUAL height at different levels — a range bar completes
  // when price has travelled the configured distance, so every one is the
  // same size.
  range: (
    <>
      <path d="M5.5 10v10M11.5 6v10M17.5 9v10" />
      <rect x="3.5" y="12" width="4" height="6" rx="0.5" />
      <rect x="9.5" y="8" width="4" height="6" rx="0.5" />
      <rect x="15.5" y="11" width="4" height="6" rx="0.5" />
    </>
  ),
};

/**
 * The type each group of the menu OPENS with.
 *
 * The reference divides its list into six runs of related shapes — price
 * bars, line forms, filled forms, discrete forms, trade-driven profiles, and
 * the price-driven forms — with a space and a hairline between them and no
 * headings at all. The glyphs already say what each run is, and six headings
 * in a twenty-one-row menu cost more rows than they explain.
 */
const GROUP_STARTS = new Set<ChartType>([
  "line", "area", "columns", "footprint", "heikinAshi",
]);

/**
 * Which styles sit on the bar as their own buttons.
 *
 * Per browser, because it is a preference about a toolbar and not about a
 * chart: it does not belong in the workspace, does not sync, and a browser
 * that refuses storage still gets a working control. The key sits beside
 * `tv.resolution.favourites.v1`, which is the same idea for timeframes.
 */
const FAVOURITES_KEY = "tv.chart-type.favourites.v1";

/** The reference's own defaults for a fresh account. */
const DEFAULT_FAVOURITES: readonly ChartType[] = ["candles", "heikinAshi", "renko"];

/**
 * How many styles may sit on the bar.
 *
 * The bar is one row at every width from 320px up, and this control is
 * `shrink-0` inside it — so every star is 38 permanent pixels taken from the
 * symbol beside it. Five is what the row can carry with the timeframe strip
 * and the edit-history group still on it; past that the star says the set is
 * full rather than silently dropping the click.
 */
const MAX_FAVOURITES = 5;

function readFavourites(): ChartType[] {
  try {
    const raw = window.localStorage.getItem(FAVOURITES_KEY);
    if (raw === null) return [...DEFAULT_FAVOURITES];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...DEFAULT_FAVOURITES];
    // Unknown entries are dropped rather than trusted: a type from a newer
    // build has no glyph here and would render an empty button.
    return parsed.filter(isChartType).slice(0, MAX_FAVOURITES);
  } catch {
    return [...DEFAULT_FAVOURITES];
  }
}

function writeFavourites(list: readonly ChartType[]): void {
  try { window.localStorage.setItem(FAVOURITES_KEY, JSON.stringify(list)); }
  catch { /* private mode — the strip is a convenience, not state */ }
}

/** A 38x38 icon-only control on the bar, without a display utility of its own. */
const STRIP_BUTTON =
  `${TOOL_STATE} ${TOOLBAR_H} w-[38px] shrink-0 items-center justify-center ` +
  // R1b-01: full ink at rest. The hover state on this bar is the chip.
  "text-ink";

function Glyph({ type, size }: { type: ChartType; size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={TOOL_ICON_STROKE} strokeLinecap="round" strokeLinejoin="round"
      className="shrink-0" aria-hidden="true">
      {ICONS[type]}
    </svg>
  );
}

/** What a control on the bar says about a style, in a tooltip rather than in ink. */
function describe(spec: ChartTypeSpec): string {
  const base = `${spec.label} — ${spec.hint}`;
  return spec.group === "transform" ? `${base}. ${SYNTHETIC_DISCLOSURE_HINT}` : base;
}

/**
 * Chart-style selector, in TradingView's position and TradingView's shape:
 * immediately after the timeframe, because the two together are what the eye
 * reads as "what am I looking at".
 *
 * ── Why it is a SPLIT control ──────────────────────────────────────────────
 *
 * It used to be one button: a glyph, a caret, and — whenever a synthetic
 * transform was on — a written label in amber. That label was the disclosure,
 * and it was the widest thing on the bar at the moment the bar was most under
 * pressure.
 *
 * Measured against the reference, the bar carries the user's FAVOURITE styles
 * as 38px radio buttons and a 24px caret that opens the list. So switching
 * between the two or three styles a trader actually alternates is one click on
 * a control that is already on screen, and the menu is for the other eighteen.
 *
 * ── Where the disclosure went ──────────────────────────────────────────────
 *
 * Nowhere quieter than the reference would put it, and nowhere the user cannot
 * reach: every control here carries the whole "display only" sentence in its
 * `title` and its accessible name. The load-bearing disclosure has never been
 * this button — it is the amber chip `CandleChart` paints ON the chart, which
 * is on screen the entire time a transform is drawing and is untouched. A word
 * on the toolbar was a third copy of it, competing for the row's width.
 */
export function ChartTypeMenu({
  value, onChange, settings,
}: {
  value: ChartType;
  onChange: (next: ChartType) => void;
  /**
   * The focused pane's settings, so the control's disclosure text names the
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
  const edgeClamp = useEdgeClamp(menuRef, open);

  /*
   * `localStorage` is read in an effect, not during render, so the first paint
   * is the same on the server and the client and there is no hydration branch.
   * A test can mount two workspaces without them sharing a strip.
   */
  const [favourites, setFavourites] = useState<ChartType[]>(() => [...DEFAULT_FAVOURITES]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    setFavourites(readFavourites());
  }, []);

  const toggleFavourite = useCallback((type: ChartType) => {
    setFavourites((current) => {
      const next = current.includes(type)
        ? current.filter((t) => t !== type)
        : current.length >= MAX_FAVOURITES ? current : [...current, type];
      if (next !== current) writeFavourites(next);
      return next;
    });
  }, []);

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

  /*
   * Opening lands on the style the chart is ON, not on "Bars".
   *
   * Twenty-one rows at 40px is taller than most viewports, so the row that
   * answers "which one am I on" is frequently below the fold. Focusing it
   * scrolls it into view, which is the only reason a user opens this menu
   * without already knowing what they want.
   */
  useEffect(() => {
    if (!open) return;
    const items = menuItems(menuRef.current);
    const checked = items.find((el) => el.getAttribute("aria-checked") === "true");
    (checked ?? items[0])?.focus();
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
   * The strip is the favourites, in the menu's own order, PLUS the style the
   * chart is currently on when that is not one of them.
   *
   * Without the second half the bar can show no chip at all — the user stars
   * three styles, picks a fourth from the menu, and the control they just used
   * reports nothing selected. The timeframe picker answers the same problem
   * the same way, by making sure something on the bar always carries the armed
   * state.
   */
  const strip = CHART_TYPES.filter(
    (t) => favourites.includes(t.value) || t.value === value);

  /*
   * ── Why the hint is a tooltip and not a second line ────────────────────────
   *
   * Every row used to be two lines: the type's name, and a sentence of prose
   * under it explaining what it draws. Twenty-one of those made a 900px-tall
   * menu that did not fit the viewport it opens in, and turned a control a
   * trader uses reflexively into something that has to be read.
   *
   * The prose is genuinely useful and none of it is gone — it is the row's
   * `title`, which is where a workstation puts an explanation it does not
   * want in the way. The rows are 40px, single-line, glyph-then-label, which
   * is the measured shape of TradingView's own.
   */
  const row = (t: ChartTypeSpec) => {
    const selected = t.value === value;
    const starred = favourites.includes(t.value);
    const full = !starred && favourites.length >= MAX_FAVOURITES;
    return (
      /*
        R1b-05: `pl-1.5 gap-2` with the glyph drawn directly (no 24px box
        around a 22px glyph) puts the icon's ink 14px and the label 42px from
        the menu's left edge — the measured reference. Ours sat at 19 and 50.
      */
      <div key={t.value} data-active={selected ? "true" : undefined}
        className="tvc-menu-row group gap-2 pl-1.5 pr-1.5">
        <button
          role="menuitemradio"
          aria-checked={selected}
          title={describe(t)}
          aria-label={t.group === "transform"
            ? `${t.label} — a synthetic display transform`
            : t.label}
          onClick={() => { onChange(t.value); setOpen(false); }}
          className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm"
        >
          <Glyph type={t.value} size={22} />
          <span className="min-w-0 flex-1 truncate">{t.label}</span>
          {/*
            No check glyph. The live inventory claimed one; the pixels in
            `tradingview/chart-type-menu-1440-dark.png` show the inverted chip
            and the star and nothing else, and the pixels win (R1b-05). The
            chip IS the answer to "am I on this one", said across the row
            rather than in a 13px mark at its end.
          */}
        </button>
        <button
          onClick={() => toggleFavourite(t.value)}
          aria-pressed={starred}
          title={starred
            ? `Take ${t.label} off the toolbar`
            : full
              ? `The toolbar holds ${MAX_FAVOURITES} styles — unstar one to add ${t.label}`
              : `Keep ${t.label} on the toolbar`}
          aria-label={starred
            ? `Take ${t.label} off the toolbar`
            : `Keep ${t.label} on the toolbar`}
          /*
           * R1b-05: the star is 16px and INK, not 11px and amber.
           *
           * Two amber marks in a grey list were the second thing a viewer
           * named in this menu. The reference draws a filled white star at the
           * row's right edge and lets the inverted selected row turn it black
           * — which is exactly what inheriting `currentColor` does, so the one
           * row where "is this a favourite" matters most stays readable
           * without hard-coding a colour for it.
           */
          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded transition-opacity ${
            starred
              ? "opacity-100"
              : `opacity-0 focus:opacity-100 group-hover:opacity-100 ${
                full ? "opacity-40" : ""}`
          }`}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"
            fill={starred ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.6">
            <path d="M12 3l2.6 5.6 6.1.8-4.5 4.2 1.2 6-5.4-3-5.4 3 1.2-6L3.3 9.4l6.1-.8z" />
          </svg>
        </button>
      </div>
    );
  };

  return (
    <div ref={boxRef} className="flex shrink-0 items-center">
      <div role="radiogroup" aria-label="Chart style favourites"
        className="flex shrink-0 items-center">
        {strip.map((t) => {
          const selected = t.value === value;
          return (
            <button
              key={t.value}
              role="radio"
              aria-checked={selected}
              title={describe(t)}
              aria-label={t.group === "transform"
                ? `${t.label} — a synthetic display transform`
                : t.label}
              onClick={() => onChange(t.value)}
              /*
               * Below `sm` only the armed style is on the bar. The row at that
               * width is the symbol, the timeframe and this; five 38px chips
               * would push the first of those off it, and the one chip that
               * has to survive is the one that says what is drawn.
               */
              className={`${STRIP_BUTTON} ${selected ? "flex" : "hidden sm:flex"}`}
            >
              <Glyph type={t.value} size={22} />
            </button>
          );
        })}
      </div>

      {/*
        The caret's own box is what the menu is anchored to, so the list opens
        at the caret's left edge — as the reference's does — rather than at the
        left edge of a strip whose width is the user's own preference.
      */}
      <div className="relative flex shrink-0 items-center">
        <button
          ref={buttonRef}
          onClick={() => setOpen(!open)}
          title={synthetic
            ? `Chart style — ${active.label}. ${SYNTHETIC_DISCLOSURE_HINT}`
            : `Chart style — ${active.label}`}
          aria-label="Chart style"
          aria-haspopup="menu"
          aria-expanded={open}
          className={TOOL_CARET_BUTTON}
        >
          <svg width={TOOL_CARET_GLYPH.width} height={TOOL_CARET_GLYPH.height}
            viewBox={TOOL_CARET_GLYPH.viewBox} fill="none" stroke="currentColor"
            strokeWidth={TOOL_CARET_GLYPH.stroke} strokeLinecap="round"
            strokeLinejoin="round" aria-hidden="true">
            <path d={TOOL_CARET_GLYPH.d} />
          </svg>
        </button>

        {open && (
          <div
            ref={menuRef}
            role="menu"
            aria-label="Chart style"
            onKeyDown={onMenuKeyDown}
            /*
              TVP8 round two: at 390px the trigger sits at x=208 and this is
              wider than the room to its right, so rows hung off the edge with
              no way to reach them. See `lib/useEdgeClamp`.
            */
            style={edgeClamp}
            /*
              `top-0`, not `top-full`: the reference's list opens at the TOP of
              the toolbar row and runs the height of the viewport, covering the
              bar it came from. Twenty-one 40px rows do not fit under a 38px
              bar on a 900px screen, and a list that starts 38px lower loses a
              row to nothing.
            */
            className="absolute left-0 top-0 z-50 max-h-[100vh] w-[273px] overflow-y-auto tvc-menu"
          >
            {CHART_TYPES.flatMap((t) => (
              GROUP_STARTS.has(t.value)
                ? [
                    // 19px of space between groups, measured: the hairline plus
                    // 9px either side, overriding `.tvc-menu-sep`'s own 6px.
                    <div key={`sep-${t.value}`} className="tvc-menu-sep !my-[9px]" role="separator" />,
                    row(t),
                  ]
                : [row(t)]
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
