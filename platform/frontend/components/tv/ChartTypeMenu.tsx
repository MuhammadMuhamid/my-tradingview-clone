"use client";
import { useEdgeClamp } from "@/lib/useEdgeClamp";
import { useCallback, useEffect, useRef, useState } from "react";
import { useExclusivePopover } from "@/lib/useExclusivePopover";
import {
  CHART_TYPES, SYNTHETIC_DISCLOSURE_HINT, isChartType, syntheticDisclosure,
  type ChartType, type ChartTypeSpec, type TransformSettings,
} from "@/lib/chartType";
import {
  TOOL_CARET_BUTTON, TOOL_CARET_GLYPH, TOOL_ICON_SIZE, TOOL_ICON_STROKE, TOOL_STATE,
  TOOLBAR_H,
} from "@/components/tv/toolbarChrome";
import { menuItems, moveMenuFocus } from "@/lib/menuKeyboard";

/**
 * One glyph per type, drawn rather than imported, on the toolbar's own grid.
 *
 * Ours, not the reference's: these are silhouettes of the same CHARTS — two
 * OHLC ticks, two candles, a staircase, a stack of bricks — which is the part
 * that has to be recognisable at this size, and the drawing is original.
 *
 * ── TVP8 R1b-03: each silhouette has to be DISTINCT, and thin ──────────────
 *
 * Three of these were near-identical bold candle pairs (Candles / Hollow
 * candles / Volume candles), the strip's Heikin Ashi was a three-candle
 * cluster carrying 2.5× the reference's ink, and Columns was three FILLED
 * ascending bars — a signal-strength icon. The rule the reference follows and
 * this now follows: hollow bodies, and one difference per type.
 *
 * ── TVP8 R1c-02: and every coordinate sits on a half-pixel ────────────────
 *
 * The box is `TOOL_ICON_SIZE` units rendered at `TOOL_ICON_SIZE` pixels, so
 * one unit is one pixel and a `x.5` coordinate with a 1px stroke covers
 * exactly one pixel column. The measured ink boxes from
 * `tradingview/chart-type-menu-1440-dark.png` are named per glyph below: Line
 * 22×14, Step 19×19, Area 23×17, Columns 19×14 (bars 5 wide at heights
 * 6/10/14), Kagi 17×19, Hollow 13×19, Volume 16×20, Renko 15×21, Footprint
 * 17×19.
 */
const ICONS: Record<ChartType, React.ReactNode> = {
  bars: (
    <>
      <path d="M9.5 4.5v19M19.5 6.5v15" />
      <path d="M4.5 9.5h5M9.5 16.5h5M14.5 11.5h5M19.5 18.5h5" />
    </>
  ),
  // Two thin HOLLOW candles of different heights, each with both wicks.
  candles: (
    <>
      <path d="M8.5 3.5v21M19.5 5.5v17" />
      <rect x="5.5" y="8.5" width="6" height="11" />
      <rect x="16.5" y="10.5" width="6" height="7" />
    </>
  ),
  // R1c-02: 13×19 — one FILLED body and one hollow one, which is the only
  // difference between this type and Candles.
  hollowCandles: (
    <>
      <path d="M10.5 4.5v18" />
      <rect x="8.5" y="8.5" width="4" height="10" fill="currentColor" />
      <path d="M18.5 8.5v9" />
      <rect x="16.5" y="10.5" width="4" height="5" fill="none" />
    </>
  ),
  // R1c-02: 16×20 — bodies of DIFFERENT WIDTHS (4 and 8), which is what a
  // volume candle actually is: the width carries the bar's traded volume.
  volumeCandles: (
    <>
      <path d="M10.5 4.5v19" />
      <rect x="6.5" y="8.5" width="7" height="11" />
      <path d="M20.5 7.5v13" />
      <rect x="18.5" y="10.5" width="3" height="7" />
    </>
  ),
  // R1c-02: 22×14, four straight MITRED segments. A rounded join at this size
  // is what made ours read as a smooth wave rather than as a price line.
  line: <path d="M3.5 20.5L9 14.5l5 3.5 4.5-6 6-4.5" strokeLinejoin="miter" />,
  lineWithMarkers: (
    <>
      <path d="M3.5 20.5L9 14.5l5 3.5 4.5-6 6-4.5" strokeLinejoin="miter" />
      <circle cx="9" cy="14.5" r="1.8" fill="currentColor" />
      <circle cx="14" cy="18" r="1.8" fill="currentColor" />
    </>
  ),
  // R1c-02: 19×19, three risers.
  stepLine: <path d="M4.5 23.5h5v-6h5v-5h4v-7h5" strokeLinejoin="miter" />,
  // R1c-02: 23×17 — a two-segment line with the area under it.
  area: (
    <>
      <path d="M2.5 21.5L12 12.5l13.5-5" strokeLinejoin="miter" />
      <path d="M2.5 21.5L12 12.5l13.5-5V24.5H2.5z"
        fill="currentColor" fillOpacity="0.25" stroke="none" />
    </>
  ),
  // A BAND between the highs and the lows, with the closes traced through it —
  // which is the whole of what an HLC area draws.
  hlcArea: (
    <>
      <path d="M3.5 10.5L9.3 5.8 14 10.5 17.5 5.8 24.5 10.5V19.8L17.5 15.2 14 19.8 9.3 15.2 3.5 19.8Z"
        fill="currentColor" fillOpacity="0.2" stroke="none" />
      <path d="M3.5 10.5l5.8-4.7 4.7 4.7 3.5-4.7 7 4.7" strokeLinejoin="miter" />
      <path d="M3.5 19.8l5.8-4.6 4.7 4.6 3.5-4.6 7 4.6" strokeLinejoin="miter" />
    </>
  ),
  // A dashed reference with the line crossing it, which is the idea.
  baseline: (
    <>
      <path d="M2.5 14.5h23" strokeDasharray="2 2" />
      <path d="M3.5 20.5L9 14.5l5 3.5 4.5-6 6-4.5" strokeLinejoin="miter" />
    </>
  ),
  // R1c-02: 19×14 — three HOLLOW bars 5 wide, of heights 6, 10 and 14. Filled
  // ascending bars are a signal-strength icon, and that is exactly what a
  // viewer read them as (R1b-03).
  columns: (
    <>
      <rect x="4.5" y="18.5" width="4" height="5" />
      <rect x="11.5" y="14.5" width="4" height="9" />
      <rect x="18.5" y="10.5" width="4" height="13" />
    </>
  ),
  // Two hollow RANGE bars: no open, no close, no body — only the extremes.
  highLow: (
    <>
      <rect x="5.5" y="5.5" width="6" height="14" />
      <rect x="16.5" y="9.5" width="6" height="12" />
    </>
  ),
  // R1c-02: 17×19 — a candle beside the rows of numbers a footprint prints in
  // every price cell of every bar.
  footprint: (
    <>
      <path d="M8.5 4.5v18" />
      <rect x="5.5" y="8.5" width="6" height="10" />
      <path d="M14.5 8.5h7.5M14.5 13.5h7.5M14.5 18.5h7.5" />
    </>
  ),
  // Letter blocks, stacked into the profile they build.
  tpo: (
    <>
      <rect x="4.5" y="5.5" width="5" height="4" rx="0.5" />
      <rect x="10.5" y="5.5" width="5" height="4" rx="0.5" />
      <rect x="4.5" y="11.5" width="5" height="4" rx="0.5" />
      <rect x="10.5" y="11.5" width="5" height="4" rx="0.5" />
      <rect x="16.5" y="11.5" width="5" height="4" rx="0.5" />
      <rect x="4.5" y="17.5" width="5" height="4" rx="0.5" />
    </>
  ),
  // A horizontal histogram BESIDE a candle, which is the layout of the thing.
  sessionVolumeProfile: (
    <>
      <path d="M7.5 4.5v19" />
      <rect x="4.5" y="9.5" width="6" height="9" />
      <path d="M14.5 7.5h9M14.5 12.5h6M14.5 17.5h8M14.5 21.5h3.5" />
    </>
  ),
  // R1c-02: 13×19 — one candle and a small square, which is the reference's
  // own Heikin Ashi silhouette. Ours was a three-candle cluster carrying 2.5×
  // its ink.
  heikinAshi: (
    <>
      <path d="M10.5 4.5v18" />
      <rect x="8.5" y="8.5" width="4" height="10" />
      <path d="M18.5 9.5v2" />
      <rect x="16.5" y="11.5" width="4" height="4" />
    </>
  ),
  // R1c-02: 15×21 — equal bricks stepping on a diagonal, no wicks, no gaps.
  renko: (
    <>
      <rect x="6.5" y="17.5" width="6" height="6" />
      <rect x="10.5" y="10.5" width="6" height="6" />
      <rect x="14.5" y="3.5" width="6" height="6" />
    </>
  ),
  // Line break: TALL blocks of unequal height — a line runs from the previous
  // close to the breaking one, so its height is whatever the break was worth.
  lineBreak: (
    <>
      <rect x="5.5" y="12.5" width="5" height="9" />
      <rect x="12.5" y="6.5" width="5" height="10" />
      <rect x="19.5" y="9.5" width="5" height="8" />
    </>
  ),
  // R1c-02: 17×19 — one path whose WIDTH changes at the shoulder, which is the
  // entire signal the chart carries.
  kagi: (
    <>
      <path d="M6.5 22.5v-9h4" strokeWidth="2.4" />
      <path d="M10.5 13.5v7h4" strokeWidth="1" />
      <path d="M14.5 20.5V5.5h6" strokeWidth="2.4" />
    </>
  ),
  pointAndFigure: (
    <>
      <path d="M4.5 7.5l5 5M9.5 7.5l-5 5" />
      <path d="M4.5 15.5l5 5M9.5 15.5l-5 5" />
      <circle cx="16.5" cy="9.5" r="2.4" />
      <circle cx="16.5" cy="16.5" r="2.4" />
      <path d="M21 12l3.5 3.5M24.5 12L21 15.5" />
    </>
  ),
  // Range: bodies of EQUAL height at different levels — a range bar completes
  // when price has travelled the configured distance, so every one is the
  // same size.
  range: (
    <>
      <path d="M6.5 11.5v12M13.5 6.5v12M20.5 10.5v12" />
      <rect x="4.5" y="14.5" width="4" height="6" />
      <rect x="11.5" y="9.5" width="4" height="6" />
      <rect x="18.5" y="13.5" width="4" height="6" />
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

/**
 * The same 1:1 frame the toolbar's own glyphs use (R1c-02).
 *
 * `TOOL_ICON_SIZE` units rendered at `TOOL_ICON_SIZE` pixels, so a segment on
 * an `x.5` coordinate covers exactly one pixel column and a 1px stroke is one
 * lit row rather than two half-lit ones. Ours were 1.5-wide strokes in a
 * 24-unit box at 22px: Hollow candles carried 172 ink px where the reference's
 * carries 82, Volume 132 against 78, Columns 153 against 76.
 */
function Glyph({ type, size = TOOL_ICON_SIZE }: { type: ChartType; size?: number }) {
  return (
    <svg width={size} height={size} viewBox={`0 0 ${TOOL_ICON_SIZE} ${TOOL_ICON_SIZE}`}
      fill="none" stroke="currentColor"
      strokeWidth={TOOL_ICON_STROKE} strokeLinecap="round" strokeLinejoin="round"
      vectorEffect="non-scaling-stroke"
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
          data-tooltip={describe(t)}
          aria-label={t.group === "transform"
            ? `${t.label} — a synthetic display transform`
            : t.label}
          onClick={() => { onChange(t.value); setOpen(false); }}
          /*
            R1c-02: `gap-0.5`, not `gap-2`. The glyph box grew from 22 to 28
            units so a 22-wide silhouette can be drawn at 1:1 — and the LABEL
            has to stay where the reference puts it, 42px from the menu's left
            edge. 6px of menu padding + 6px of row padding + 28px of box + 2px
            of gap is that 42; with the old 8px gap it would have drifted to 48.
          */
          className="flex min-w-0 flex-1 items-center gap-0.5 text-left text-sm"
        >
          <Glyph type={t.value} />
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
          /* B-24: an accessory of the row, not a stop of the arrow keys. */
          tabIndex={-1}
          data-menu-skip
          aria-pressed={starred}
          data-tooltip={starred
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
              data-tooltip={describe(t)}
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
              <Glyph type={t.value} />
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
          data-tooltip={synthetic
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
              B-16: under the caret, capped, scrolling inside. It opened at
              `top-0`/`max-h-[100vh]` over the bar, and `Range` fell off a
              900px screen. The bar is the first row, so the caret ends at 38:
              start 2px below it and scroll past viewport − 48.
            */
            className="absolute left-0 top-full z-50 mt-[2px] max-h-[calc(100vh-48px)] w-[273px] overflow-y-auto tvc-menu"
          >
            {CHART_TYPES.flatMap((t) => (
              GROUP_STARTS.has(t.value)
                ? [
                    /*
                      R1c-03: 13px between groups, not 19.
                      Measured on `tradingview/chart-type-menu-1440-dark.png`:
                      the Volume-candles row ends at y=166, the hairline is at
                      172 and the Line row starts at 179 — 6px either side of
                      the rule, not 9. The extra 3px a side compounded down the
                      list at +6 per group, and by the sixth group the `Range`
                      row landed at y=910 on a 900px viewport: a scroll the
                      reference does not have, on the last row of the menu.
                    */
                    <div key={`sep-${t.value}`} className="tvc-menu-sep !my-[6px]" role="separator" />,
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
