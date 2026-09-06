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
  addCustom, isFavourite, parseCustomEntry, parseStoredResolutions, recordRecent,
  removeCustom, timeframeStrip, toggleFavourite, type CustomUnit,
} from "@/lib/timeframes";
import { describeResolution, explainResolution, parseResolution, type Resolution } from "@/lib/resolution";

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
    <div className="group flex items-center gap-1 rounded pr-1 hover:bg-surface-2/60">
      <button
        role="menuitemradio"
        aria-checked={selected}
        aria-label={`${describeResolution(resolution)} — ${explainResolution(resolution)}`}
        onClick={() => onPick(resolution)}
        className={`flex flex-1 items-baseline gap-2 rounded px-2 py-1.5 text-left text-[13px] transition-colors ${
          selected ? "font-semibold text-ink" : "text-ink-muted group-hover:text-ink"
        }`}
      >
        <span className="w-10 shrink-0 tabular">{resolution}</span>
        {plan !== null && !plan.native && (
          // Said on the row, not in a tooltip: what a derived bar is made of is
          // the reason it can be trusted, and a tooltip is not an answer to a
          // question a reader did not know to ask.
          <span className="text-[11px] text-ink-faint">
            {plan.factor} × {plan.source}
          </span>
        )}
      </button>
      {onRemove && (
        <button
          onClick={() => onRemove(resolution)}
          title={`Remove the custom ${resolution} resolution`}
          aria-label={`Remove the custom ${resolution} resolution`}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-ink-faint opacity-0 transition-opacity hover:bg-surface-2 hover:text-ink focus:opacity-100 group-hover:opacity-100"
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
        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded transition-opacity hover:bg-surface-2 ${
          favourite
            ? "text-accent opacity-100"
            : "text-ink-faint opacity-0 focus:opacity-100 group-hover:opacity-100"
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
  boxRef: { current: HTMLElement | null }
): void {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent): void => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onEsc);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onEsc);
    };
  }, [open, setOpen, boxRef]);
}

const MENU_BOX =
  "absolute z-50 max-h-[70vh] w-[228px] overflow-y-auto rounded-md border " +
  "border-border bg-surface p-1 shadow-xl";

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
  useDismiss(open, setOpen, boxRef);

  const pick = useCallback((resolution: Resolution) => {
    props.preferences.noteUsed(resolution);
    props.onInterval(resolution);
    setOpen(false);
  }, [props, setOpen]);

  return (
    <div ref={boxRef} className={`relative shrink-0 ${props.className ?? ""}`}>
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="menu"
        title={`${explainResolution(props.interval)} — change this pane's timeframe`}
        aria-label={`Timeframe for this pane — currently ${props.interval}`}
        className="flex h-5 items-center gap-0.5 rounded px-1 text-[11px] font-semibold text-ink hover:bg-surface-2/80"
      >
        {props.interval}
        <svg width="8" height="8" viewBox="0 0 10 10" fill="none" aria-hidden="true">
          <path d="M2 3.5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </button>
      {open && (
        <div role="menu" aria-label="Pane timeframe" className={`${MENU_BOX} left-0 top-[22px]`}>
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
 * The favourites strip plus the picker button.
 *
 * The strip is the row's compressible element — it scrolls rather than pushing
 * the controls beside it off the bar, which is what keeps the toolbar a single
 * row at every width. The picker button sits OUTSIDE that scrolling box on
 * purpose: a popover inside an `overflow-x-auto` container is clipped by it.
 */
export function TimeframePicker(props: TimeframePickerProps) {
  const { interval, preferences } = props;
  const strip = timeframeStrip(interval, preferences.favourites);
  const [open, setOpen] = useExclusivePopover("timeframe");
  const boxRef = useRef<HTMLDivElement>(null);
  useDismiss(open, setOpen, boxRef);

  const pick = useCallback((resolution: Resolution) => {
    preferences.noteUsed(resolution);
    props.onInterval(resolution);
    setOpen(false);
  }, [preferences, props, setOpen]);

  return (
    <div
      role="group"
      aria-label="Timeframe"
      className={props.className ?? "flex min-w-0 flex-1 items-center gap-0.5 sm:flex-initial"}
    >
      <div className="no-scrollbar flex min-w-0 items-center gap-0.5 overflow-x-auto">
        {strip.quick.map((i) => (
          <button key={i} onClick={() => pick(i)}
            aria-pressed={interval === i}
            title={explainResolution(i)}
            className={`flex h-7 shrink-0 items-center rounded px-2 text-[13px] transition-colors ${
              interval === i
                ? "bg-surface-2 font-semibold text-ink"
                : "text-ink-muted hover:bg-surface-2/60 hover:text-ink"
            }`}>
            {i}
          </button>
        ))}
      </div>

      {/*
        The picker button sits OUTSIDE the scrolling strip on purpose: a popover
        inside an `overflow-x-auto` container is clipped by it.
      */}
      <div ref={boxRef} className="relative shrink-0">
        <button
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-haspopup="menu"
          aria-pressed={!strip.currentInQuick}
          title="All timeframes"
          aria-label={strip.currentInQuick
            ? "All timeframes"
            : `Timeframe — currently ${interval}. All timeframes`}
          className={`flex h-7 shrink-0 items-center gap-1 rounded px-1.5 text-[13px] transition-colors ${
            strip.currentInQuick
              ? "text-ink-muted hover:bg-surface-2/60 hover:text-ink"
              : "bg-surface-2 font-semibold text-ink"
          }`}
        >
          {strip.menuLabel}
          <svg width="9" height="9" viewBox="0 0 10 10" fill="none" aria-hidden="true">
            <path d="M2 3.5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </button>

        {open && (
          <div role="menu" aria-label="All timeframes" className={`${MENU_BOX} left-0 top-[34px]`}>
            <ResolutionMenu interval={interval} onPick={pick} preferences={preferences} />
          </div>
        )}
      </div>
    </div>
  );
}
