"use client";
/**
 * One control for every resolution the chart can honestly show.
 *
 * ── What this replaces ─────────────────────────────────────────────────────
 *
 * A strip of six hard-coded buttons plus a "More" popover listing the other
 * five. That shape could not survive the resolution work: the chart now offers
 * seconds, forty-five minutes, three hours and anything a person types, and a
 * strip cannot hold thirty entries without becoming the ragged multi-row bar
 * this workspace spent a phase removing.
 *
 * The shape here is TradingView's, observed live and cached under
 * `evidence/P1A_tv/`: a small run of FAVOURITE resolutions as buttons, then one
 * picker button. The picker groups by unit, stars a row into the favourites
 * strip, remembers what was recently used, and takes a custom entry at the top.
 * Nothing was removed — every one of the eleven intervals the strip used to
 * reach is still one or two clicks away, and eighteen more joined them.
 *
 * ── What is stated, and why ────────────────────────────────────────────────
 *
 * Every derived row says what it is made of: "3 × 15m". A person choosing a
 * 45-minute chart is entitled to know it is three fifteen-minute bars added up
 * rather than a feed the venue publishes, because that is the difference
 * between a real resolution and an invented one — and this product's whole
 * claim about custom intervals is that it never invents.
 *
 * ── Where the lists live ───────────────────────────────────────────────────
 *
 * Favourites, recents and custom entries are per-browser preferences, so they
 * are in `localStorage` and nowhere else: they are not chart state, they do not
 * belong in a saved layout, and a second device having its own is correct
 * rather than a bug. Every rule about what may go in one of those lists is a
 * pure function in `lib/timeframes`; this component reads and writes, and does
 * not decide.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useExclusivePopover } from "@/lib/useExclusivePopover";
import {
  CUSTOM_KEY, CUSTOM_UNITS, DEFAULT_FAVOURITES, FAVOURITES_KEY, MAX_CUSTOM,
  CATALOGUE_RESOLUTIONS, MAX_FAVOURITES, MAX_RECENTS, RECENTS_KEY, RESOLUTION_CATALOGUE,
  addCustom, chipLabel, isFavourite, parseCustomEntry, parseStoredResolutions,
  recordRecent, removeCustom, timeframeStrip, toggleFavourite, type CustomUnit,
} from "@/lib/timeframes";
import { describeResolution, explainResolution, parseResolution, type Resolution } from "@/lib/resolution";
import { menuItems, moveMenuFocus } from "@/lib/menuKeyboard";
import { TOOL_CARET_BUTTON } from "@/components/tv/toolbarChrome";

/**
 * Read a stored list without letting a corrupt entry take the page down.
 *
 * `localStorage` throws in a private window in some browsers, and its contents
 * are whatever was last written by any version of this app. Both are handled
 * the same way: fall back to the default and carry on.
 */
function readList(key: string, max: number, fallback: readonly Resolution[]): Resolution[] {
  try {
    const raw = window.localStorage.getItem(key);
    return parseStoredResolutions(raw === null ? null : JSON.parse(raw), max, fallback);
  } catch {
    return [...fallback];
  }
}

function writeList(key: string, list: readonly Resolution[]): void {
  try { window.localStorage.setItem(key, JSON.stringify(list)); }
  catch { /* a browser that refuses storage still gets a working picker */ }
}

export interface ResolutionPreferences {
  favourites: Resolution[];
  recents: Resolution[];
  custom: Resolution[];
  toggleFavourite: (resolution: Resolution) => void;
  addCustom: (resolution: Resolution) => void;
  removeCustom: (resolution: Resolution) => void;
  /** Called when a resolution is actually applied, to keep recents honest. */
  noteUsed: (resolution: Resolution) => void;
}

/**
 * The three per-browser lists, as one hook.
 *
 * A hook rather than module state so a test can mount two workspaces without
 * them sharing a strip, and so the first render is deterministic on the server
 * (`localStorage` is read in an effect, not during render).
 */
export function useResolutionPreferences(): ResolutionPreferences {
  const [favourites, setFavourites] = useState<Resolution[]>(() => [...DEFAULT_FAVOURITES]);
  const [recents, setRecents] = useState<Resolution[]>([]);
  const [custom, setCustom] = useState<Resolution[]>([]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setFavourites(readList(FAVOURITES_KEY, MAX_FAVOURITES, DEFAULT_FAVOURITES));
    setRecents(readList(RECENTS_KEY, MAX_RECENTS, []));
    setCustom(readList(CUSTOM_KEY, MAX_CUSTOM, []));
  }, []);

  const toggle = useCallback((resolution: Resolution) => {
    setFavourites((current) => {
      const next = toggleFavourite(current, resolution);
      writeList(FAVOURITES_KEY, next);
      return next;
    });
  }, []);

  const add = useCallback((resolution: Resolution) => {
    setCustom((current) => {
      const next = addCustom(current, resolution);
      writeList(CUSTOM_KEY, next);
      return next;
    });
  }, []);

  const remove = useCallback((resolution: Resolution) => {
    setCustom((current) => {
      const next = removeCustom(current, resolution);
      writeList(CUSTOM_KEY, next);
      return next;
    });
  }, []);

  const noteUsed = useCallback((resolution: Resolution) => {
    setRecents((current) => {
      const next = recordRecent(current, resolution, favourites);
      writeList(RECENTS_KEY, next);
      return next;
    });
  }, [favourites]);

  return {
    favourites, recents, custom,
    toggleFavourite: toggle, addCustom: add, removeCustom: remove, noteUsed,
  };
}

interface RowProps {
  resolution: Resolution;
  current: Resolution;
  favourite: boolean;
  onPick: (resolution: Resolution) => void;
  onToggleFavourite: (resolution: Resolution) => void;
  onRemove?: (resolution: Resolution) => void;
}

function PickerRow({
  resolution, current, favourite, onPick, onToggleFavourite, onRemove,
}: RowProps) {
  const plan = parseResolution(resolution);
  const selected = current === resolution;
  return (
    /*
      The selected row is FILLED, not just bolded — at a glance bold text on
      the panel's own background is indistinguishable from the row above it,
      and a resolution picker is a place where "which one am I on" has to be
      answerable without reading. The fill is `tvc-menu-row`'s inverted chip
      rather than this row's own accent blue: measured live, TradingView's
      selected menu row is #f2f2f2 on #0f0f0f text, not a tint.
    */
    <div data-active={selected ? "true" : undefined}
      className="tvc-menu-row group gap-1 pr-1">
      <button
        role="menuitemradio"
        aria-checked={selected}
        aria-label={`${describeResolution(resolution)} — ${explainResolution(resolution)}`}
        onClick={() => onPick(resolution)}
        className={`flex flex-1 items-baseline gap-2 px-2 text-left text-sm ${
          selected ? "font-semibold" : "text-ink-muted group-hover:text-ink"
        }`}
      >
        <span className="w-10 shrink-0 tabular">{resolution}</span>
        {plan !== null && !plan.native && (
          // Said on the row, not in a tooltip: what a derived bar is made of is
          // the reason it can be trusted, and a tooltip is not an answer to a
          // question a reader did not know to ask.
          <span className={`text-[11px] ${selected ? "opacity-70" : "text-ink-faint"}`}>
            {plan.factor} × {plan.source}
          </span>
        )}
      </button>
      {onRemove && (
        <button
          onClick={() => onRemove(resolution)}
          title={`Remove the custom ${resolution} resolution`}
          aria-label={`Remove the custom ${resolution} resolution`}
          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded opacity-0 transition-opacity focus:opacity-100 group-hover:opacity-100 ${
            selected ? "text-white/70 hover:bg-white/20 hover:text-white" : "text-ink-faint hover:bg-state-hover hover:text-ink"
          }`}
        >
          <svg width="8" height="8" viewBox="0 0 10 10" fill="none" aria-hidden="true">
            <path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" strokeWidth="1.6" />
          </svg>
        </button>
      )}
      <button
        onClick={() => onToggleFavourite(resolution)}
        aria-pressed={favourite}
        title={favourite ? `Remove ${resolution} from the toolbar` : `Keep ${resolution} on the toolbar`}
        aria-label={favourite ? `Remove ${resolution} from the toolbar` : `Keep ${resolution} on the toolbar`}
        /*
         * The star INHERITS the row's colour when the row is selected.
         *
         * It used to hard-code `text-white`, which was right while a selected
         * resolution was a blue fill. The selected menu row is now an inverted
         * light chip (`--ts-menu-selected-bg` on `-ink`), so white-on-near-white
         * made the star of the armed resolution invisible — the one row where
         * knowing whether it is a favourite matters most.
         *
         * Amber, not accent, for a favourite: a star is a keep-this mark, and
         * accent in this product is an action or a link.
         */
        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded transition-opacity ${
          favourite
            ? `opacity-100 ${selected ? "" : "text-warn"}`
            : `opacity-0 focus:opacity-100 group-hover:opacity-100 ${selected ? "opacity-70" : "text-ink-faint"}`
        }`}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" aria-hidden="true"
          fill={favourite ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8">
          <path d="M12 3l2.6 5.6 6.1.8-4.5 4.2 1.2 6-5.4-3-5.4 3 1.2-6L3.3 9.4l6.1-.8z" />
        </svg>
      </button>
    </div>
  );
}

export interface ResolutionMenuProps {
  interval: Resolution;
  onPick: (interval: Resolution) => void;
  preferences: ResolutionPreferences;
}

/**
 * The picker's list: custom entry, current, custom, recent, then the catalogue.
 *
 * One component, mounted by the toolbar control and by every pane legend, so a
 * resolution offered in one is offered in all of them and a star set in one is
 * a star set everywhere. Two lists that were meant to agree is the defect this
 * whole module was written to remove; building a second one for the legend
 * would have reintroduced it in a day.
 */
export function ResolutionMenu({ interval, onPick, preferences }: ResolutionMenuProps) {
  const [customCount, setCustomCount] = useState("");
  const [customUnit, setCustomUnit] = useState<CustomUnit>("m");
  const [customError, setCustomError] = useState<string | null>(null);

  const submitCustom = useCallback(() => {
    const result = parseCustomEntry(customCount, customUnit);
    if ("error" in result) { setCustomError(result.error); return; }
    setCustomError(null);
    setCustomCount("");
    preferences.addCustom(result.resolution);
    onPick(result.resolution);
  }, [customCount, customUnit, preferences, onPick]);

  /*
   * The current resolution always has a row.
   *
   * A custom `7m` that was applied and then removed from the custom list, or a
   * resolution restored from a saved layout, would otherwise be a chart whose
   * timeframe appears nowhere in its own timeframe menu.
   */
  const orphanCurrent = useMemo(() => {
    const known = new Set<Resolution>([
      ...CATALOGUE_RESOLUTIONS,
      ...preferences.custom,
      ...preferences.recents,
    ]);
    return known.has(interval) ? null : interval;
  }, [interval, preferences.custom, preferences.recents]);

  const row = (resolution: Resolution, onRemove?: (r: Resolution) => void) => (
    <PickerRow
      key={resolution}
      resolution={resolution}
      current={interval}
      favourite={isFavourite(preferences.favourites, resolution)}
      onPick={onPick}
      onToggleFavourite={preferences.toggleFavourite}
      {...(onRemove ? { onRemove } : {})}
    />
  );

  return (
    <>
      {/* ── custom entry, at the top, as on the benchmark ── */}
      <div className="rounded bg-surface-2/40 p-1.5">
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
          Add custom
        </div>
        <div className="flex items-center gap-1">
          <input
            value={customCount}
            onChange={(e) => { setCustomCount(e.target.value); setCustomError(null); }}
            onKeyDown={(e) => { if (e.key === "Enter") submitCustom(); }}
            inputMode="numeric"
            aria-label="Custom interval amount"
            placeholder="45"
            className="h-7 w-14 rounded border border-border bg-surface px-1.5 text-[13px] text-ink"
          />
          <select
            value={customUnit}
            onChange={(e) => { setCustomUnit(e.target.value as CustomUnit); setCustomError(null); }}
            aria-label="Custom interval unit"
            className="h-7 flex-1 rounded border border-border bg-surface px-1 text-[12px] text-ink"
          >
            {CUSTOM_UNITS.map((u) => (
              <option key={u.value} value={u.value}>{u.label}</option>
            ))}
          </select>
          <button
            onClick={submitCustom}
            className="h-7 shrink-0 rounded bg-accent px-2 text-[12px] font-semibold text-white"
          >
            Add
          </button>
        </div>
        {customError !== null && (
          <p role="alert" className="mt-1 text-[11px] text-warn">{customError}</p>
        )}
      </div>

      {orphanCurrent !== null && (
        <section aria-label="Current">
          <h4 className="px-2 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
            Current
          </h4>
          {row(orphanCurrent)}
        </section>
      )}

      {preferences.custom.length > 0 && (
        <section aria-label="Custom">
          <h4 className="px-2 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
            Custom
          </h4>
          {preferences.custom.map((r) => row(r, preferences.removeCustom))}
        </section>
      )}

      {preferences.recents.length > 0 && (
        <section aria-label="Recent">
          <h4 className="px-2 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
            Recent
          </h4>
          {preferences.recents.map((r) => row(r))}
        </section>
      )}

      {RESOLUTION_CATALOGUE.map((group) => (
        <section key={group.label} aria-label={group.label}>
          <h4 className="px-2 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
            {group.label}
          </h4>
          {group.items.map((r) => row(r))}
        </section>
      ))}
    </>
  );
}

/** Dismiss-on-outside-click and Escape, shared by both triggers. */
function useDismiss(
  open: boolean, setOpen: (open: boolean) => void,
  boxRef: { current: HTMLElement | null },
  triggerRef?: { current: HTMLElement | null },
): void {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key === "Escape") { setOpen(false); triggerRef?.current?.focus(); }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onEsc);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onEsc);
    };
  }, [open, setOpen, boxRef, triggerRef]);
}

function useMenuKeys(
  open: boolean,
  setOpen: (open: boolean) => void,
  menuRef: { current: HTMLElement | null },
  triggerRef: { current: HTMLElement | null },
): void {
  useEffect(() => {
    if (open) menuItems(menuRef.current)[0]?.focus();
  }, [open, menuRef]);
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
        e.preventDefault();
        moveMenuFocus(menuItems(menuRef.current), document.activeElement, e.key);
      }
    };
    const menu = menuRef.current;
    menu?.addEventListener("keydown", onKeyDown);
    return () => menu?.removeEventListener("keydown", onKeyDown);
  }, [open, setOpen, menuRef, triggerRef]);
}

/*
 * FC2 recorded this popover as the strongest area of the product — row pitch,
 * sectioning, favourites, Escape and focus restoration are all at parity, and
 * the `5 x 1s` derivation hints are better than the reference. What it did
 * flag was type one step small and a 6px radius where TradingView has none.
 * Both are here; nothing about the structure moved.
 */
const MENU_BOX =
  "absolute z-50 max-h-[70vh] w-[212px] overflow-y-auto tvc-menu";

export interface LegendTimeframeProps {
  /** The pane's id, so two panes' menus cannot both be open. */
  scope: string;
  interval: Resolution;
  onInterval: (interval: Resolution) => void;
  preferences: ResolutionPreferences;
  className?: string;
}

/**
 * A pane's own timeframe, as one small button on the chart legend.
 *
 * The whole of what a pane needs and no more: the toolbar's favourites strip
 * belongs to the workspace, and repeating it per pane is the duplication the
 * legend exists to end. The MENU is the same one, so nothing a pane can reach
 * differs from what the toolbar can reach.
 */
export function LegendTimeframe(props: LegendTimeframeProps) {
  const [open, setOpen] = useExclusivePopover(`timeframe:${props.scope}`);
  const boxRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useDismiss(open, setOpen, boxRef, triggerRef);
  useMenuKeys(open, setOpen, menuRef, triggerRef);

  const pick = useCallback((resolution: Resolution) => {
    props.preferences.noteUsed(resolution);
    props.onInterval(resolution);
    setOpen(false);
  }, [props, setOpen]);

  return (
    <div ref={boxRef} className={`relative shrink-0 ${props.className ?? ""}`}>
      <button
        ref={triggerRef}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="menu"
        title={`${explainResolution(props.interval)} — change this pane's timeframe`}
        aria-label={`Timeframe for this pane — currently ${props.interval}`}
        className="flex h-5 items-center gap-0.5 rounded px-1 text-[11px] font-semibold text-ink hover:bg-state-hover/80"
      >
        {props.interval}
        <svg width="8" height="8" viewBox="0 0 10 10" fill="none" aria-hidden="true">
          <path d="M2 3.5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </button>
      {open && (
        <div ref={menuRef} role="menu" aria-label="Pane timeframe" className={`${MENU_BOX} left-0 top-[22px]`}>
          <ResolutionMenu
            interval={props.interval}
            onPick={pick}
            preferences={props.preferences}
          />
        </div>
      )}
    </div>
  );
}

export interface TimeframePickerProps {
  interval: Resolution;
  onInterval: (interval: Resolution) => void;
  preferences: ResolutionPreferences;
  /** Class applied to the strip's own wrapper, so the toolbar owns its layout. */
  className?: string;
}

/**
 * One chip on the favourites strip.
 *
 * `data-resolution` carries the canonical id beside the printed label because
 * they are deliberately not the same string: the reference writes a day as
 * `1D` and a minute as `1m`, while every request, persisted pane and test
 * names `1d`. Anything reading the strip programmatically reads the id.
 */
function StripChip(props: {
  resolution: Resolution;
  armed: boolean;
  onPick: (resolution: Resolution) => void;
}) {
  return (
    <button
      data-resolution={props.resolution}
      onClick={() => props.onPick(props.resolution)}
      aria-pressed={props.armed}
      title={explainResolution(props.resolution)}
      className={`tvc-control flex h-[38px] shrink-0 items-center px-1.5 text-sm ${
        props.armed ? "text-ink" : "text-ink-muted hover:text-ink"
      }`}
    >
      {chipLabel(props.resolution)}
    </button>
  );
}

/**
 * The favourites strip, the armed chip, and the caret that opens the rest.
 *
 * ── R1-03: the strip stopped being the row's absorber above `sm` ───────────
 *
 * It was, and the owner's own 1440 screenshot is what it cost: the wrapper
 * measured 150px while holding 194px of chips, so the bar read `1h 4 ⌄` — one
 * favourite cut in half mid-glyph and the next one parked underneath the caret
 * at x=440. A control that silently drops part of what it was asked to show is
 * worse than one that is not there, because nothing on the screen says so.
 *
 * So from `sm` up the strip is `shrink-0`: it takes its content width and
 * gives none of it back. The `overflow-x-auto` survives only BELOW `md`, where
 * a small tablet can genuinely be narrower than six chips plus a symbol
 * control and a scroller is still better than an overlap. At every width this
 * product targets — 1280 and up — the strip's scrollWidth is its clientWidth
 * and nothing about it moves.
 *
 * ── Why the trigger is a bare caret ───────────────────────────────────────
 *
 * It used to print the word "Timeframe" (or, below `sm`, the armed
 * resolution), and both were wrong for the same reason: the reference draws a
 * 24px caret there and nothing else, and a control that sometimes names a
 * category and sometimes names a value is two controls sharing one box. The
 * armed resolution is now always a CHIP — its own favourite when it has one,
 * and an extra pressed chip immediately before the caret when it does not
 * (a starred-away `1h`, a typed `45m`). That is the reference's behaviour and
 * it keeps "which timeframe am I on" answerable by looking at the chips alone.
 *
 * ── FC2-B1: why the strip is not rendered on a phone ───────────────────────
 *
 * It was, and it broke the toolbar. The wrapper carried `flex-1 min-w-0` at
 * every width. `min-width: 0` is exactly the permission a flex item needs to
 * shrink BELOW its own minimum content size, and at 390px the row's
 * incompressible siblings already exceeded the viewport, so the wrapper was
 * squeezed to 15px while the picker button inside it stayed 90px wide and
 * overflowed its own parent. The measured result: the `Timeframe` button
 * painted from x=169 to x=259 straight across the chart-type button at x=188,
 * and because the chart-type button comes later in the DOM it won the hit test.
 * `elementFromPoint(195, 26)` and `(215, 26)` both returned the chart-type
 * control while the user was looking at the word "Timeframe". Tapping the
 * middle of a visible label opened a different menu — a functional break, and
 * an accessibility one, on the primary mobile toolbar of the primary surface.
 *
 * Two things keep that fixed, and both are still here:
 *
 *   1. Nothing in this control may shrink. The wrapper and everything in it
 *      are `shrink-0`, so no box on this bar can ever be squeezed narrower
 *      than the button inside it. (This used to hold only below `sm`; R1-03
 *      made it true at every width, which is strictly stronger.)
 *   2. The quick strip itself is hidden below `sm`. Six 44px touch targets
 *      cannot share a 390px row with a symbol, a presentation menu and an
 *      overflow control, and the honest answer at that width is the caret —
 *      which reaches every resolution rather than six of them.
 *
 * What a phone loses with the word gone is a label naming the armed
 * resolution on the BAR. It has not lost the fact: the pane legend states it
 * (`LegendTimeframe`, above), which is where the reference states it too, and
 * an armed resolution that is not a favourite still renders its own chip here
 * at every width.
 *
 * The row's remaining give comes from the symbol button in `ChartToolbar`,
 * which truncates. That is what keeps the guarantee — no two interactive boxes
 * on this bar intersect at any width from 320px up — true rather than lucky.
 */
export function TimeframePicker(props: TimeframePickerProps) {
  const { interval, preferences } = props;
  const strip = timeframeStrip(interval, preferences.favourites);
  const [open, setOpen] = useExclusivePopover("timeframe");
  const boxRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useDismiss(open, setOpen, boxRef, triggerRef);
  useMenuKeys(open, setOpen, menuRef, triggerRef);

  const pick = useCallback((resolution: Resolution) => {
    preferences.noteUsed(resolution);
    props.onInterval(resolution);
    setOpen(false);
  }, [preferences, props, setOpen]);

  return (
    <div
      role="group"
      aria-label="Timeframe"
      className={props.className ?? "flex shrink-0 items-center"}
    >
      <div className="no-scrollbar hidden min-w-0 shrink-0 items-center overflow-x-auto sm:flex md:overflow-x-visible">
        {strip.quick.map((i) => (
          <StripChip key={i} resolution={i} armed={interval === i} onPick={pick} />
        ))}
      </div>

      {/*
        The armed resolution, when no favourite carries it.

        Outside the scroller and rendered at every width, including below `sm`
        where the strip is not: a chart on a resolution nothing on the bar
        names is the state this chip exists to prevent.
      */}
      {strip.armedChip !== null && (
        <StripChip resolution={strip.armedChip} armed onPick={pick} />
      )}

      {/*
        The caret sits OUTSIDE the scrolling strip on purpose: a popover inside
        an `overflow-x-auto` container is clipped by it.
      */}
      <div ref={boxRef} className="relative shrink-0">
        <button
          ref={triggerRef}
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-haspopup="menu"
          title="All timeframes"
          /*
           * No `aria-pressed`. It used to be set when this button was standing
           * in for the armed chip, so the control announced itself as a toggle
           * AND as a menu button — two contradictory roles on one box. The
           * armed chip is a chip now, and this is only ever the way into the
           * catalogue.
           */
          aria-label="Chart interval — all timeframes"
          className={TOOL_CARET_BUTTON}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
            <path d="M2 3.5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </button>

        {open && (
          <div ref={menuRef} role="menu" aria-label="All timeframes" className={`${MENU_BOX} left-0 top-full`}>
            <ResolutionMenu interval={interval} onPick={pick} preferences={preferences} />
          </div>
        )}
      </div>
    </div>
  );
}
