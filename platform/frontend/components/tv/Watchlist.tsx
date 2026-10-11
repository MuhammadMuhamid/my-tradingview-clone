"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { recall, remember } from "@/lib/browserStorage";
import { useAsk } from "@/components/AskDialog";
import type { SymbolInfo } from "@/lib/types";
import { useExclusivePopover } from "@/lib/useExclusivePopover";
import { api, type ServerWatchlist } from "@/lib/api";
import { useWatchlistTickers, type WatchlistTicker } from "@/lib/useWatchlistTickers";
import { describeStreamState } from "@/lib/marketStream";
import { ContextMenu } from "@/components/tv/ContextMenu";
import {
  WATCHLIST_MENU_WIDTH, WATCHLIST_VIEW_DEFAULTS, watchlistListsMenu,
  watchlistMenu, watchlistSettingsMenu, type WatchlistPanelEntry, type WatchlistViewPrefs,
} from "@/lib/menuPayloads";
import {
  FLAG_COLOURS, FLAGS_CHANGED_EVENT, clearFlags, flagHex, readFlags, setFlag,
  type FlagColour, type FlagMap,
} from "@/lib/watchlistFlags";
import {
  addSection, bandRows, readNotes, readSections, removeSection, setNote,
  type NoteMap, type SectionMap,
} from "@/lib/watchlistSections";
import type { MenuEntry } from "@/lib/contextMenu";
import {
  MANUAL_SORT, canReorder, nextSort, reorderRefusal, reorderSymbols, sortSymbols,
  type SortColumn, type WatchlistSort,
} from "@/lib/watchlistOrder";
import {
  canonicalDisplayParts, canonicalizeLegacySpotSymbol, displayName, displaySymbol,
  displayTicker, instrumentTypeLabel, isCanonicalInstrumentId, type AssetClass,
} from "@/lib/instrument";
import { changedSuffix, quoteDigits } from "@/lib/format";
import { fitDecimals, fontOf, numericMeasurer } from "@/lib/fitNumeric";
import { resolvePriceTick } from "@/lib/priceTick";
import { averageVolume30D, performance as periodPerformance } from "@/lib/instrumentStats";
import { useInstrumentStats } from "@/lib/useInstrumentStats";
import { CaretGlyph } from "@/components/ui";
import { describeAction, type FailureCopy } from "@/lib/errorCopy";
import { AssetMark, WatchlistDetails, type MarketLine } from "@/components/tv/WatchlistDetails";
import { WatchlistAddBox } from "@/components/tv/WatchlistAddBox";

type Ticker = Pick<WatchlistTicker, "last" | "chg" | "chgPct" | "stale" | "changeKnown">;
type NamedWatchlist = ServerWatchlist;

/**
 * Lists live in the database, not localStorage: the same watchlist has to be
 * there when the app is opened on the phone the MA alerts notify.
 * Only the *selected* list stays device-local.
 */
const LEGACY_KEY = "tv-clone-watchlists-v1";
const ACTIVE_KEY = "tv.watchlist.active.v1";
/** How the list is being LOOKED AT — not part of the list, so device-local. */
const COMPACT_KEY = "tv.watchlist.compact.v1";
const COLLAPSED_KEY = "tv.watchlist.collapsed.v1";
/** R7b-08: which columns, and how a symbol is written. Device-local, same reason. */
const VIEW_KEY = "tv.watchlist.view.v1";
/** R7b-21: the panel's own width, which the reference stores per account. */
const WIDTH_KEY = "tv.watchlist.width.v1";

const MIN_WIDTH = 260;
const MAX_WIDTH = 420;
const DEFAULT_WIDTH = 300;

/**
 * What an empty watchlist offers instead of a full stop.
 *
 * ── Why an empty list needs a design at all ────────────────────────────────
 *
 * The empty state used to read "This watchlist is empty. Add a USDT pair
 * above." — which is true, and is also the entire product refusing to start.
 * It is the first thing a new account sees, it names no pair, and a person who
 * does not already know which Binance tickers exist has nothing to type.
 *
 * The benchmark's watchlist, captured under `evidence/P1A_tv/`, is never empty:
 * it ships with grouped sections of real instruments. This is the same idea
 * scoped to what this platform actually serves — Binance Spot, USDT-quoted,
 * long-only — offered as a starting point rather than imposed as one.
 *
 * ── Why these eight ────────────────────────────────────────────────────────
 *
 * The most liquid USDT pairs on the venue, which is the only property that
 * matters for a starter list: they have deep history for the Backtester, tight
 * spreads for the manual ticket, and they are the pairs a chart is most likely
 * to be opened on. It is not a recommendation and nothing here reads it as
 * one — adding a row to a watchlist has no effect on any strategy, alert or
 * order.
 */
const STARTER_SYMBOLS: readonly string[] = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT",
  "XRPUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT",
];

/*
 * ── TVP8 R7-06: the list is grouped, and the grouping is a VIEW ────────────
 *
 * The reference puts a `⌄ CRYPTO` band above its rows. It is not decoration:
 * a workstation list holds spot pairs, perpetuals, equities and FX at once,
 * and the reader's first question about an unfamiliar ticker is which of those
 * it is. A 42px band answers it once per group instead of once per row.
 *
 * Nothing about it is persisted, and `lib/watchlistOrder.ts` is untouched. The
 * user's manual order is still the stored list; grouping reads it and draws it
 * in sections, so clearing the view gives their arrangement back unchanged.
 */
const GROUP_LABEL: Readonly<Record<AssetClass, string>> = {
  crypto_spot: "Crypto",
  crypto_derivative: "Crypto",
  us_equity: "Stocks",
  fx: "Forex",
  traditional_future: "Futures",
  reference_index: "Indices",
};

function groupOf(info: SymbolInfo): string {
  return GROUP_LABEL[info.assetClass ?? "crypto_spot"] ?? "Crypto";
}

/** Sentence case for the details block's `Spot • Crypto` line. */
function sentenceCase(word: string): string {
  return word.charAt(0) + word.slice(1).toLowerCase();
}

/*
 * ── The row's columns, as MEASURED WIDTHS rather than as a class ───────────
 *
 * TVP8 R7-03 measured them off the reference at 1440x900: a 24px mark cell,
 * the ticker taking what is left, then 72 / 70 / 60 for Last / Chg / Chg%.
 *
 * TVP8 R7b-03 and R7b-08 moved them out of a Tailwind `grid-cols-[…]` literal
 * and into an inline template, for one reason: the `⋯` menu now chooses which
 * of them are shown. A literal class per combination is sixteen classes
 * Tailwind has to be able to see, and a `grid-cols-[…]` built at runtime is
 * one Tailwind cannot see at all — the class would simply not be emitted and
 * every row would collapse into a single column. The widths are still one
 * declaration, still measured, and `tests/uiContract.test.ts` still pins them.
 *
 * ── TVP8 F-01: the numbers get the room, the ticker truncates ──────────────
 *
 * The widths above were smaller than the ink they had to hold. `76,024.0` is
 * 60px of 14px tabular numerals and its track was 56 with 2 of padding; the
 * cells had no `overflow` and the grid had no `column-gap`, so the surplus was
 * simply PAINTED over the next column — `0.19280-0.004302.18%`, three values
 * as one run of digits.
 *
 * Which column yields is settled by the reference, not by arithmetic:
 * `08_tv_watchlist.png` at a 300px panel shows `BTCUSI`, `ETHUSI`, `DASHU` —
 * TradingView TRUNCATES the ticker and never truncates a number. So the
 * numeric tracks carry the queue's measured maxima and the ticker is the
 * flexible one, with a floor that keeps it legible.
 *
 * `minmax(0, Npx)` rather than `Npx` is what makes one declaration work across
 * the panel's whole 260–420 resize range: at 420 each numeric track reaches
 * its maximum and the ticker takes the surplus; at 300 they share what is left
 * over the ticker's floor, and `lib/fitNumeric` drops trailing decimals on any
 * value that still will not fit. Nothing overflows at any width, because the
 * gutter is a real `column-gap` and the cells clip.
 */
const COLUMN_WIDTH = {
  mark: "18px",
  ticker: "minmax(52px,1fr)",
  last: "minmax(0,84px)",
  change: "minmax(0,64px)",
  changePct: "minmax(0,60px)",
  volume: "minmax(0,64px)",
} as const;

/** The gutter between every pair of cells, in pixels (TVP8 F-01). */
const COLUMN_GAP = 8;

/** The value columns, in the order the reference draws them. */
const VALUE_COLUMNS = ["last", "change", "changePct", "volume"] as const;
type ValueColumn = (typeof VALUE_COLUMNS)[number];

const COLUMN_LABEL: Readonly<Record<ValueColumn, string>> = {
  last: "Last", change: "Chg", changePct: "Chg%", volume: "Vol",
};
const COLUMN_SORT: Readonly<Record<ValueColumn, SortColumn>> = {
  last: "last", change: "change", changePct: "changePct", volume: "last",
};
const COLUMN_DATA: Readonly<Record<ValueColumn, string>> = {
  last: "last", change: "chg", changePct: "chgpct", volume: "volume",
};

function readPrefs(): WatchlistViewPrefs {
  const raw = recall(VIEW_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<WatchlistViewPrefs>;
      return {
        compact: parsed.compact ?? WATCHLIST_VIEW_DEFAULTS.compact,
        columns: { ...WATCHLIST_VIEW_DEFAULTS.columns, ...(parsed.columns ?? {}) },
        mark: parsed.mark ?? WATCHLIST_VIEW_DEFAULTS.mark,
        display: parsed.display === "name" ? "name" : "symbol",
      };
    } catch { /* a malformed preference is no preference */ }
  }
  // The header's compact toggle shipped first and has its own key; a user who
  // set it must not have it silently reset by the arrival of a richer one.
  return { ...WATCHLIST_VIEW_DEFAULTS, compact: recall(COMPACT_KEY) === "1" };
}

function readWidth(): number {
  const raw = Number(recall(WIDTH_KEY));
  return Number.isFinite(raw) && raw > 0
    ? Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(raw)))
    : DEFAULT_WIDTH;
}

/**
 * A value whose CHANGED digits are painted in the direction colour for 600 ms.
 *
 * TVP8 R7b-17. The reference flashes the tail of a price that just moved —
 * `77,762.7`**`6`** — which is how a reader sees WHICH of twenty rows ticked
 * without watching all twenty. `changedSuffix` (in `lib/format`) decides how
 * much of the string is new; nothing flashes when the text is unchanged, so a
 * quiet row stays quiet.
 */
function TickDigits({ text, className }: { text: string; className: string }) {
  const previous = useRef(text);
  const [flash, setFlash] = useState<{ suffix: number; dir: "up" | "down" } | null>(null);

  useEffect(() => {
    const before = previous.current;
    previous.current = text;
    const suffix = changedSuffix(before, text);
    if (suffix === 0 || before === "—" || text === "—") return undefined;
    const numeric = (s: string): number => Number(s.replace(/[^0-9.-]/g, ""));
    setFlash({ suffix, dir: numeric(text) >= numeric(before) ? "up" : "down" });
    const timer = window.setTimeout(() => setFlash(null), 600);
    return () => window.clearTimeout(timer);
  }, [text]);

  if (!flash) return <span className={className}>{text}</span>;
  const cut = Math.max(0, text.length - flash.suffix);
  return (
    <span className={className} data-tick={flash.dir}>
      {text.slice(0, cut)}
      <span className={flash.dir === "up" ? "text-up" : "text-down"}>{text.slice(cut)}</span>
    </span>
  );
}

/**
 * One anchored dropdown, for the two the panel header owns.
 *
 * R7b-08: both carry section headings and radio rows, neither of which a flat
 * `menuitem` / `menuitemcheckbox` list can express, so they are not
 * `ContextMenu` payloads. They ARE the same `.tvc-menu` grammar — one popover
 * ground, 40px rows, a 6px gutter, an inverted selected chip — so nothing
 * about how they look is a second opinion.
 */
function PanelMenu({ entries, label, width, onClose, onSelect, className = "" }: {
  entries: readonly WatchlistPanelEntry[];
  label: string;
  width: number;
  onClose: () => void;
  onSelect: (id: string) => void;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const rows = entries.filter((e) => e.kind === "item" && !e.disabled);

  return (
    <>
      <div className="fixed inset-0 z-[45]" aria-hidden="true" onPointerDown={onClose} />
      <div
        ref={ref}
        role="menu"
        aria-label={label}
        tabIndex={-1}
        style={{ width }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            /*
             * R7b-06: and it STOPS here.
             *
             * `ChartSidePanel` listens for Escape on `window` and closes the
             * whole 300px column. Without these two lines, dismissing this
             * menu also dismissed the panel it belongs to — which is what
             * killed the reviewer's temp-list step.
             */
            event.preventDefault();
            event.stopPropagation();
            onClose();
            return;
          }
          if (event.key === "Tab") { event.preventDefault(); onClose(); return; }
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>(
              "button[role^='menuitem']:not(:disabled)") ?? [])];
            if (items.length === 0) return;
            const at = items.indexOf(document.activeElement as HTMLButtonElement);
            const next = event.key === "ArrowDown" ? at + 1 : at - 1;
            items[(next + items.length) % items.length]!.focus();
          }
        }}
        className={`absolute z-50 tvc-menu outline-none ${className}`}
      >
        {entries.map((entry) => {
          if (entry.kind === "separator") {
            return <div key={entry.id} role="separator" className="tvc-menu-sep" />;
          }
          if (entry.kind === "heading") {
            return <div key={entry.id} className="tvc-menu-heading">{entry.label}</div>;
          }
          return (
            <button
              key={entry.id}
              type="button"
              role={entry.radio ? "menuitemradio" : entry.checked === undefined
                ? "menuitem" : "menuitemcheckbox"}
              aria-checked={entry.checked}
              /* The ✓ below is this row's state; no inverted chip as well. */
              data-check-mark={entry.checked !== undefined ? "" : undefined}
              disabled={entry.disabled}
              aria-disabled={entry.disabled || undefined}
              title={entry.disabled ? entry.disabledReason : undefined}
              onClick={() => { onSelect(entry.id); }}
              className={`tvc-menu-row w-full justify-between gap-2 px-2.5 text-left text-sm ${
                entry.disabled ? "cursor-not-allowed text-ink-faint"
                  : entry.destructive ? "text-down" : "text-ink"}`}
            >
              <span className="min-w-0 truncate">{entry.label}</span>
              {/* The check IS the state: a toggle row wears no inverted chip
                  (`data-check-mark` above), as on the reference, so several
                  ticked rows never read as several selected ones. */}
              <span className="flex w-3 shrink-0 justify-center" aria-hidden="true">
                {entry.checked && (
                  <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor"
                    strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M2 6.5l2.5 2.5L10 3.5" />
                  </svg>
                )}
              </span>
            </button>
          );
        })}
        {rows.length === 0 && (
          <div className="px-2.5 py-2 text-[12px] text-ink-faint">Nothing to choose here.</div>
        )}
      </div>
    </>
  );
}

export function Watchlist({
  symbols, selected, onSelect, onSymbolsChanged, replayQuote = null,
  onOpenInNewPane, onAddAlert, onAddCompare, canOpenNewPane = false, replayActive = false,
  onHide,
}: {
  symbols: SymbolInfo[];
  selected: string;
  onSelect: (symbol: string) => void;
  onSymbolsChanged: () => void;
  replayQuote?: Ticker | null;
  /**
   * The row's right-click actions. Facts about the WORKSPACE — whether another
   * pane can be opened, whether Replay is running — so they arrive as props;
   * the list itself knows only its symbols.
   */
  onOpenInNewPane?: (symbol: string) => void;
  onAddAlert?: (symbol: string) => void;
  /**
   * `Add SYMBOL to compare` (TVP8 F-05) — the focused pane's own compare
   * action, so the row adds a real overlay rather than opening a dialog that
   * asks the user to name the symbol they just right-clicked.
   */
  onAddCompare?: (symbol: string) => void;
  canOpenNewPane?: boolean;
  replayActive?: boolean;
  /** The gutter grip closes the panel; the rail cell still toggles it. */
  onHide?: () => void;
}) {
  const ask = useAsk();
  /** The add-symbol field is opened from the header, not permanently reserved. */
  /*
   * TVP7: closed. This field was open on load, so the panel spent a permanent
   * 34px row — above the column headers, above the first quote — on a control
   * that duplicates the `+` beside it. TradingView's watchlist begins at its
   * rows. The `+` still opens this, still autofocuses it, and Escape still
   * closes it; only the default changed.
   */
  const [addOpen, setAddOpen] = useState(false);
  const [err, setErr] = useState<FailureCopy | null>(null);
  /*
   * TVP7: this was `useState(false)` — a private open flag beside a popover,
   * which is exactly the shape `lib/popoverGroup` exists to prevent. It went
   * unnoticed because the switcher was a hand-rolled box with no `role`;
   * giving it the menu role it always deserved is what surfaced it. It can now
   * no longer be open at the same time as the timeframe, chart-type, layout or
   * sync menus.
   */
  const [menuOpen, setMenuOpen] = useExclusivePopover("watchlist-lists");
  const [viewOpen, setViewOpen] = useExclusivePopover("watchlist-view");
  const [lists, setLists] = useState<NamedWatchlist[] | null>(null);
  /*
   * "The read failed" and "there are none" are different answers, and this
   * component turned the first into the second.
   *
   * The catch below did `setLists([])`. The first-run seed then saw an empty
   * list and POSTed the whole tracked catalog, which the repository applies as
   * `ON CONFLICT (name) DO UPDATE SET symbols = EXCLUDED.symbols` — so ONE
   * transient failure to read silently overwrote a curated watchlist with the
   * catalogue, with no prompt and no undo. The user's own content, destroyed
   * by a network blip.
   *
   * This flag is what keeps the seed out of that path: seeding is a first-run
   * act, and a failed read is not a first run.
   */
  const [readFailed, setReadFailed] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const nameButtonRef = useRef<HTMLButtonElement>(null);
  const viewButtonRef = useRef<HTMLButtonElement>(null);
  /**
   * One `ContextMenu` for every menu opened at a POINT — a row's right-click,
   * the details block's `⋯`. The alternative is components with their own sets
   * of keyboard, placement and focus-restore rules, which is the thing
   * `ContextMenu`'s own header explains at length.
   */
  const [pointMenu, setPointMenu] = useState<
    | null
    | { at: { x: number; y: number }; label: string; symbol: string | null; entries: MenuEntry[] }
  >(null);

  const reload = async (selectId?: string) => {
    const rows = await api.listWatchlists();
    setLists(rows);
    const stored = recall(ACTIVE_KEY);
    const wanted = selectId ?? stored;
    const pick = rows.find((l) => l.id === wanted) ?? rows[0] ?? null;
    setActiveId(pick?.id ?? null);
    return rows;
  };

  useEffect(() => {
    void (async () => {
      try {
        let rows = await api.listWatchlists();
        if (rows.length === 0) {
          // First run on this database. Import the browser's old lists if any;
          // the default list is seeded by the effect below, once the tracked
          // symbols it is seeded FROM are known.
          let seeded = false;
          try {
            const raw = recall(LEGACY_KEY);
            const legacy = raw ? (JSON.parse(raw) as { lists?: NamedWatchlist[] }) : null;
            for (const [i, l] of (legacy?.lists ?? []).entries()) {
              if (!l?.name) continue;
              await api.upsertWatchlist({ name: l.name, symbols: l.symbols ?? [], position: i });
              seeded = true;
            }
            if (seeded) remember(`${LEGACY_KEY}.migrated`, raw ?? "");
          } catch { /* malformed legacy data — fall through to the default */ }
          if (seeded) rows = await api.listWatchlists();
        }
        setLists(rows);
        const stored = recall(ACTIVE_KEY);
        const pick = rows.find((l) => l.id === stored) ?? rows[0] ?? null;
        setActiveId(pick?.id ?? null);
      } catch (e) {
        setErr(describeAction(e, "load the watchlist"));
        // Deliberately NOT `setLists([])`: see `readFailed`. Nothing is known
        // about the user's lists, and claiming they have none is what caused
        // the seed to overwrite them.
        setReadFailed(true);
      }
    })();
  }, []); // once on mount; the server is the source of truth afterwards

  /*
   * ── TVP8 IO-A10: the first-run seed was always empty ──────────────────────
   *
   * The seed used to live in the mount effect above, reading `symbols` from
   * that effect's closure — the value the panel MOUNTED with, which is `[]`,
   * because the page's own `listSymbols` is still in flight when the panel
   * first renders. So a fresh database got a "Main Watchlist" with no rows in
   * it, and since FG-01 opened the panel by default that is every first run.
   * Found the moment the DOM fixture could persist a watchlist at all
   * (IO-A2-COV): the recorded POST said `"symbols":[]`.
   *
   * The seed now waits for the thing it is seeded from. A database with no
   * tracked symbols gets no list, which is the honest state rather than an
   * empty list pretending to be one.
   */
  const seededDefault = useRef(false);
  useEffect(() => {
    // `readFailed` is the guard that matters here: seeding is a FIRST-RUN act,
    // and a failed read is not a first run.
    if (readFailed || lists === null || lists.length > 0
      || symbols.length === 0 || seededDefault.current) return;
    seededDefault.current = true;
    void (async () => {
      try {
        await api.upsertWatchlist({
          name: "Main Watchlist", symbols: symbols.map((s) => s.canonicalId ?? s.symbol), position: 0,
        });
        await reload();
      } catch (e) {
        setErr(describeAction(e, "create the list"));
      }
    })();
  }, [lists, symbols, readFailed]);

  useEffect(() => {
    if (activeId) remember(ACTIVE_KEY, activeId);
  }, [activeId]);

  /*
   * ── R7b-08: how the list is being LOOKED AT ───────────────────────────────
   *
   * Which columns are shown, whether the mark is drawn, and whether a row is
   * written as a ticker or as a name. Device-local for the same reason the
   * sort is not persisted at all: it is a property of this screen, not of the
   * list, and a list opened on a phone should not inherit a five-column view
   * chosen on a 27-inch monitor.
   */
  const [prefs, setPrefs] = useState<WatchlistViewPrefs>(WATCHLIST_VIEW_DEFAULTS);
  const [collapsed, setCollapsed] = useState<readonly string[]>([]);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  /*
   * TVP8 F-05: the reader's own markings on this list.
   *
   * Hydrated in an effect with the rest of the stored preferences rather than
   * in `useState`'s initialiser, for the reason every other preference here is:
   * the server render has no `localStorage`, and reading one during the first
   * render is the hydration mismatch that blanks the panel.
   */
  const [flags, setFlags] = useState<FlagMap>({});
  const [sections, setSections] = useState<SectionMap>({});
  const [notes, setNotes] = useState<NoteMap>({});
  // A flag set from the chart legend (E6) lands here without a reload.
  useEffect(() => {
    const sync = (): void => setFlags(readFlags());
    window.addEventListener(FLAGS_CHANGED_EVENT, sync);
    return () => window.removeEventListener(FLAGS_CHANGED_EVENT, sync);
  }, []);
  useEffect(() => {
    setPrefs(readPrefs());
    setWidth(readWidth());
    setFlags(readFlags());
    setSections(readSections());
    setNotes(readNotes());
    try {
      const raw = recall(COLLAPSED_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) setCollapsed(parsed.filter((x): x is string => typeof x === "string"));
    } catch { /* a malformed preference is no preference */ }
  }, []);
  const updatePrefs = (fn: (current: WatchlistViewPrefs) => WatchlistViewPrefs): void => {
    setPrefs((current) => {
      const next = fn(current);
      remember(VIEW_KEY, JSON.stringify(next));
      // The header's own compact cell reads the same pref; its legacy key is
      // kept in step so a downgrade does not lose the choice.
      remember(COMPACT_KEY, next.compact ? "1" : "0");
      return next;
    });
  };
  const toggleGroup = (label: string): void => {
    setCollapsed((current) => {
      const next = current.includes(label) ? current.filter((x) => x !== label) : [...current, label];
      remember(COLLAPSED_KEY, JSON.stringify(next));
      return next;
    });
  };

  /**
   * The value columns actually drawn.
   *
   * Compact is not a fourth preference fighting the other three: it is the
   * header's one-click way of saying "ticker and last price only", so it wins
   * over the column checkboxes while it is on and leaves them alone underneath.
   */
  const columns = useMemo<ValueColumn[]>(() => VALUE_COLUMNS.filter((column) => {
    if (prefs.compact) return column === "last" && prefs.columns.last;
    return prefs.columns[column];
  }), [prefs]);

  const gridTemplate = useMemo(() => [
    ...(prefs.mark ? [COLUMN_WIDTH.mark] : []),
    COLUMN_WIDTH.ticker,
    ...columns.map((column) => COLUMN_WIDTH[column]),
  ].join(" "), [prefs.mark, columns]);

  /** Where each cell sits, so the mark can be last in the DOM and first on screen. */
  const columnStart = (column: ValueColumn): number =>
    (prefs.mark ? 2 : 1) + 1 + columns.indexOf(column);
  const tickerStart = prefs.mark ? 2 : 1;
  const firstValueStart = prefs.mark ? 3 : 2;

  /*
   * ── TVP8 F-01: how wide a numeric track actually ended up ─────────────────
   *
   * The tracks are `minmax(0, Npx)`, so their resolved width is the panel's
   * business and changes as the user drags the gutter. `fitDecimals` needs the
   * real number, so the HEADER's own cells — which sit in the identical
   * template and are always mounted — are observed and their widths reported.
   * One observer for the column, not one per row: every row's cell in a column
   * is the same width by construction.
   */
  const headerCells = useRef(new Map<ValueColumn, HTMLElement>());
  const [cellWidth, setCellWidth] = useState<Partial<Record<ValueColumn, number>>>({});
  const [cellFont, setCellFont] = useState<string | null>(null);
  useEffect(() => {
    const cells = [...headerCells.current.entries()]
      .filter((entry): entry is [ValueColumn, HTMLElement] => Boolean(entry[1]));
    if (cells.length === 0) return;
    const read = (): void => {
      const next: Partial<Record<ValueColumn, number>> = {};
      for (const [column, element] of cells) next[column] = element.clientWidth;
      setCellWidth((current) => cells.every(([c]) => current[c] === next[c]) ? current : next);
    };
    read();
    const first = cells[0]?.[1];
    if (first) setCellFont((current) => current ?? fontOf(first));
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    for (const [, element] of cells) observer.observe(element);
    return () => observer.disconnect();
  }, [gridTemplate, width, columns]);
  const measure = useMemo(
    () => (cellFont === null ? null : numericMeasurer(cellFont)), [cellFont]);

  const active = lists?.find((l) => l.id === activeId) ?? null;
  /**
   * The rows in the user's own order — which is what is persisted.
   *
   * Sorting by a column is a VIEW of this list, applied below, not a rewrite
   * of it: sorting by change, looking, then clearing the sort gives the user
   * their arrangement back rather than leaving them to rebuild it.
   */
  const manualSymbols = useMemo(() => {
    if (!active) return [];
    const bySymbol = new Map(symbols.flatMap((s) => [
      [s.symbol, s] as const, ...(s.canonicalId ? [[s.canonicalId, s] as const] : []),
    ]));
    return active.symbols.map((s) => {
      const existing = bySymbol.get(s);
      if (existing) return { ...existing, symbol: s };
      const parts = canonicalDisplayParts(s);
      return parts ? {
        symbol: s, baseAsset: parts.base, quoteAsset: parts.quote,
        priceTick: null, qtyStep: null, minNotional: null, isActive: true,
        venue: parts.venue, assetClass: parts.type === "spot" ? "crypto_spot" as const
          : parts.type === "stock" || parts.type === "etf" ? "us_equity" as const
            : parts.type === "fx_pair" ? "fx" as const
              : parts.type === "index" ? "reference_index" as const
                : parts.type === "future" || parts.type === "continuous_future" ? "traditional_future" as const
                  : "crypto_derivative" as const,
      } : null;
    }).filter((s): s is SymbolInfo => Boolean(s));
  }, [active, symbols]);

  /*
   * Prices: seeded through this app's server, then moved by the shared market
   * stream (origin fallback, reconnect and watchdog included). See
   * `lib/useWatchlistTickers`. The rows are never `—` for want of a socket.
   */
  const visibleSymbolNames = useMemo(() => manualSymbols.map((s) => s.symbol), [manualSymbols]);
  const { tickers, stream, issues } = useWatchlistTickers(visibleSymbolNames);

  const updateList = (id: string, fn: (list: NamedWatchlist) => NamedWatchlist) => {
    const target = lists?.find((l) => l.id === id);
    if (!target) return;
    const next = fn(target);
    setLists((prev) => prev?.map((l) => (l.id === next.id ? next : l)) ?? prev);
    api.updateWatchlist(next.id, { name: next.name, symbols: next.symbols })
      .catch((e: Error) => setErr(describeAction(e, "read the watchlists")));
  };
  const updateActive = (fn: (list: NamedWatchlist) => NamedWatchlist) => {
    if (active) updateList(active.id, fn);
  };

  /*
   * The sort, and the rows it produces.
   *
   * Held here rather than persisted: it is how the user is looking at the list
   * right now, not part of the list. The manual order is the thing that
   * belongs to them and is saved.
   */
  const [sort, setSort] = useState<WatchlistSort>(MANUAL_SORT);
  const visibleSymbols = useMemo(() => {
    if (sort.column === "manual") return manualSymbols;
    const bySymbol = new Map(manualSymbols.map((s) => [s.symbol, s]));
    return sortSymbols(visibleSymbolNames, tickers, sort)
      .map((name) => bySymbol.get(name))
      .filter((s): s is SymbolInfo => Boolean(s));
  }, [manualSymbols, visibleSymbolNames, tickers, sort]);

  /** The sections, in first-appearance order. A sort applies inside them. */
  /*
   * The bands the list draws.
   *
   * Asset class when the reader has named nothing — which is every list until
   * they use `Add section` — and their own names from the anchor onwards once
   * they have. `lib/watchlistSections` owns the rule and is tested without a
   * browser.
   */
  const bands = useMemo(() => bandRows(
    visibleSymbols, (s) => s.symbol, groupOf, (activeId && sections[activeId]) || [],
  ), [visibleSymbols, sections, activeId]);

  const selectedDetails = useMemo(() => {
    const selectedLabel = displaySymbol(selected);
    const info = manualSymbols.find((item) => item.symbol === selected
      || displaySymbol(item.symbol) === selectedLabel) ?? null;
    if (!info) return null;
    return { info, ticker: tickers[info.symbol] ?? tickers[selected] ?? null };
  }, [manualSymbols, selected, tickers]);

  /*
   * R7b-11: the 30-day average and the performance tiles, from daily bars.
   *
   * One read for the SELECTED instrument, not one per row — see
   * `lib/useInstrumentStats`. The arithmetic is `lib/instrumentStats`, pure and
   * tested without a network.
   */
  const detailSymbol = selectedDetails?.info.symbol ?? null;
  const dailyStats = useInstrumentStats(detailSymbol);
  const derivedStats = useMemo(() => ({
    averageVolume30D: dailyStats.bars ? averageVolume30D(dailyStats.bars) : null,
    performance: dailyStats.bars ? periodPerformance(dailyStats.bars) : null,
    unavailable: dailyStats.unavailable,
  }), [dailyStats]);

  /** The row being dragged, in the manual order. Null when nothing is. */
  const [dragging, setDragging] = useState<string | null>(null);
  /** Why the last drop was refused, if it was. Cleared after a few seconds. */
  const [dropRefusal, setDropRefusal] = useState<string | null>(null);
  useEffect(() => {
    if (!dropRefusal) return undefined;
    /*
     * R7b-07: shown BECAUSE a drop was refused, and then gone.
     *
     * `reorderRefusal(sort)` used to be rendered permanently for as long as
     * any sort was active — a 44px paragraph above the first row explaining a
     * gesture the reader had not made, in a 300px column. The rule it states
     * is still the rule; it is now an answer rather than a standing notice.
     */
    const timer = window.setTimeout(() => setDropRefusal(null), 4000);
    return () => window.clearTimeout(timer);
  }, [dropRefusal]);

  /**
   * Drop `symbol` onto the row currently occupied by `onto`.
   *
   * By SYMBOL rather than by index, because the two lists are not the same
   * length: a symbol the catalog does not have — delisted, or a catalog still
   * loading — is dropped from the view and kept in the stored list. A visible
   * index applied to the stored array therefore lands somewhere else, and the
   * drag either does nothing or moves the row one slot off. Both are the
   * "drag looks broken" failure `canReorder` exists to prevent, reached by a
   * different route.
   */
  const moveSymbolOnto = (symbol: string, onto: string): void => {
    if (!canReorder(sort) || symbol === onto) return;
    const from = manualSymbols.find((s) => s.symbol === symbol);
    const to = manualSymbols.find((s) => s.symbol === onto);
    /*
     * R7-06: the sections are a view, so a row dragged across one would land
     * back under its own heading and appear not to have moved at all. Refusing
     * it and saying why is the same contract `reorderRefusal` keeps for a
     * sorted list.
     */
    if (from && to && groupOf(from) !== groupOf(to)) {
      setDropRefusal(`${groupOf(from)} and ${groupOf(to)} are separate sections — a row can only be moved within its own.`);
      return;
    }
    setDropRefusal(null);
    updateActive((l) => {
      const target = l.symbols.indexOf(onto);
      if (target < 0) return l;
      return { ...l, symbols: reorderSymbols(l.symbols, symbol, target) };
    });
  };
  const streamWords = describeStreamState(stream);
  /*
   * The header says what the numbers are. "live" is only claimed once a frame
   * has arrived on the CURRENT socket — never on a handshake, and never on the
   * strength of rows that streamed before a reconnect. A seeded list on a
   * fenced network says so, and says that the quotes are real but not
   * streaming, rather than looking frozen or fake.
   */
  const priceState: { label: string; tone: string; detail: string } | null =
    visibleSymbols.length === 0 ? null
    : issues.length > 0 ? { label: "some quotes unavailable", tone: "text-warn", detail: issues.join(" ") }
    : visibleSymbolNames.some((name) => tickers[name]?.stale)
      ? { label: "stale", tone: "text-warn", detail: "One or more provider quotes are older than the venue freshness limit." }
    : stream.status === "live" ? { label: "live", tone: "text-up", detail: streamWords.detail }
    : stream.status === "connecting" || stream.status === "open"
      ? { label: stream.status === "open" ? "connected — waiting for data" : "connecting…", tone: "text-ink-faint", detail: streamWords.detail }
    : stream.status === "stale"
      ? { label: "stalled", tone: "text-down", detail: streamWords.detail }
    : { label: "not streaming", tone: "text-warn", detail: `${streamWords.detail} Prices shown are retained REST quotes and refresh every 15 seconds.` };

  /*
   * R7-05: the feed dot LEAVES the header when the feed is fine.
   *
   * TradingView paints nothing there, and it is right to: a green dot that is
   * green 99% of the time teaches a reader to stop looking at it, which is
   * exactly the wrong training for the one time it is not. The sentence stays
   * — announced, and in the tooltip of the dot that appears when there IS
   * something to say.
   */
  const degraded = priceState !== null && priceState.label !== "live";

  /**
   * Add one or more pairs, registering any the catalog does not have yet.
   *
   * Shared by the type-in field and the empty state's starter buttons, so
   * "adding a symbol" means exactly one thing however it was reached — the
   * starter list is not a second, looser admission path.
   */
  const addSymbols = async (wanted: readonly string[], intoId?: string): Promise<boolean> => {
    const clean = wanted.map((s) => s.trim()).filter(Boolean);
    if (clean.length === 0) return false;
    setErr(null);
    try {
      const resolved: string[] = [];
      for (const raw of clean) {
        const s = isCanonicalInstrumentId(raw) ? raw : raw.toUpperCase();
        if (isCanonicalInstrumentId(s)) { resolved.push(s); continue; }
        if (s.endsWith("USDT")) {
          if (!symbols.some((x) => x.symbol === s)) await api.addSymbol(s, s.replace(/USDT$/, ""), "USDT");
          resolved.push(canonicalizeLegacySpotSymbol(s) ?? s); continue;
        }
        const found = await api.searchMarket(s, "", "", 20);
        const exact = found.results.filter((row) => row.providerSymbol?.toUpperCase() === s || row.symbol.toUpperCase() === s);
        if (exact.length !== 1 || !exact[0]?.canonicalId) {
          throw new Error(exact.length > 1 ? `“${s}” exists on multiple venues or contract series; choose it from Symbol search.` : `No exact market instrument matches “${s}”.`);
        }
        resolved.push(exact[0].canonicalId);
      }
      const missing = resolved.filter((s) => !symbols.some((x) => x.symbol === s));
      if (missing.length > 0) onSymbolsChanged();
      const target = intoId ?? active?.id;
      if (target) {
        updateList(target, (l) => ({
          ...l,
          symbols: [...l.symbols, ...resolved.filter((s) => !l.symbols.includes(s))],
        }));
      }
      return true;
    } catch (e) {
      setErr(describeAction(e, "create the list"));
      return false;
    }
  };

  /**
   * C-06: the `+` field adds a RESOLVED instrument — a row the user saw in
   * the results — never the text in the box. The canonical id is what is
   * stored, so a Binance pair and a Hyperliquid perpetual on the same base
   * can never be confused by a spelling.
   */
  const addResolved = (row: { canonicalId?: string; symbol: string }): Promise<boolean> =>
    addSymbols([row.canonicalId ?? row.symbol]);

  const removeSymbol = (symbol: string): void => {
    updateActive((l) => ({ ...l, symbols: l.symbols.filter((x) => x !== symbol) }));
  };

  const createList = async () => {
    const name = (await ask.promptFor({
      title: "New watchlist", label: "Name", defaultValue: "New Watchlist",
      confirmLabel: "Create",
    }))?.trim();
    if (!name || !lists) return;
    setMenuOpen(false);
    try {
      const created = await api.upsertWatchlist({ name, symbols: [], position: lists.length });
      await reload(created.id);
    } catch (e) { setErr(describeAction(e, "rename the list")); }
  };
  const copyList = async () => {
    if (!active || !lists) return;
    const name = (await ask.promptFor({
      title: "Make a copy", label: "Name", defaultValue: `${active.name} copy`,
      confirmLabel: "Create",
    }))?.trim();
    if (!name) return;
    setMenuOpen(false);
    try {
      const created = await api.upsertWatchlist({
        name, symbols: [...active.symbols], position: lists.length,
      });
      await reload(created.id);
    } catch (e) { setErr(describeAction(e, "create the list")); }
  };
  const renameList = async () => {
    if (!active) return;
    const name = (await ask.promptFor({
      title: "Rename watchlist", label: "Name", defaultValue: active.name,
      confirmLabel: "Rename",
    }))?.trim();
    if (name) updateActive((l) => ({ ...l, name }));
    setMenuOpen(false);
  };
  const clearList = async () => {
    if (!active || active.symbols.length === 0) { setMenuOpen(false); return; }
    if (!await ask.confirm({
      title: `Clear “${active.name}”?`,
      body: "Every row goes; the list and the symbols themselves stay.",
      confirmLabel: "Clear", tone: "danger",
    })) return;
    setMenuOpen(false);
    updateActive((l) => ({ ...l, symbols: [] }));
  };
  const deleteList = async () => {
    if (!lists || !active || lists.length === 1) return;
    if (!await ask.confirm({
      title: `Delete “${active.name}”?`,
      body: "The list and its order go; the symbols themselves are untouched.",
      confirmLabel: "Delete", tone: "danger",
    })) return;
    setMenuOpen(false);
    try {
      await api.deleteWatchlist(active.id);
      await reload(lists.find((l) => l.id !== active.id)?.id);
    } catch (e) { setErr(describeAction(e, "delete the list")); }
  };

  /*
   * ── TVP8 F-05: the row menu's actions, on real state ───────────────────────
   *
   * Every one of these writes something the panel then renders and reloads
   * with. The queue is explicit that an inert menu row is worse than a missing
   * one, and the previous menu's `Add symbol…` was the only row here that did
   * anything a second control did not already do.
   */
  const toggleFlag = (symbol: string): void => {
    const current = flags[symbol] ?? null;
    setFlags(setFlag(flags, symbol, current ? null : FLAG_COLOURS[0].id));
  };
  const pickFlag = (symbol: string, colour: FlagColour): void => {
    setFlags(setFlag(flags, symbol, colour));
  };
  const addNoteFor = async (symbol: string): Promise<void> => {
    const text = await ask.promptFor({
      title: `Note for ${displayTicker(symbol)}`,
      label: "Kept on this device, against the symbol",
      defaultValue: notes[symbol] ?? "",
      confirmLabel: "Save note",
      multiline: true,
      // An empty field CLEARS the note, which is the only way to take one off.
      required: false,
    });
    if (text === null) return;
    setNotes(setNote(notes, symbol, text));
  };
  const addSectionAbove = async (symbol: string): Promise<void> => {
    if (!activeId) return;
    const name = await ask.promptFor({
      title: "Add section",
      label: `A named band opening above ${displayTicker(symbol)}`,
      confirmLabel: "Add section",
    });
    if (name === null || name.trim() === "") return;
    setSections(addSection(sections, activeId, symbol, name.trim()));
  };
  const renameSection = async (anchor: string, current: string): Promise<void> => {
    if (!activeId) return;
    const name = await ask.promptFor({
      title: "Rename section", label: "Section name",
      defaultValue: current, confirmLabel: "Rename",
    });
    if (name === null || name.trim() === "") return;
    setSections(addSection(sections, activeId, anchor, name.trim()));
  };
  const dropSection = (anchor: string): void => {
    if (!activeId) return;
    setSections(removeSection(sections, activeId, anchor));
  };

  const openRowMenu = (at: { x: number; y: number }, symbol: string): void => {
    setPointMenu({
      at, symbol,
      // R7-10: a canonical id is never the visible name of anything.
      label: displayTicker(symbol),
      entries: watchlistMenu({
        symbol, replayActive, canOpenNewPane,
        lists: lists?.map((l) => ({ id: l.id, name: l.name })) ?? [],
        activeListId: activeId,
        flag: flags[symbol] ?? null,
        anyFlagged: Object.keys(flags).length > 0,
        flagColours: FLAG_COLOURS,
        canCompare: Boolean(onAddCompare),
      }),
    });
  };

  const marketLine = (info: SymbolInfo, quote: WatchlistTicker | null): MarketLine => {
    const crypto = (info.assetClass ?? "crypto_spot").startsWith("crypto");
    if (stream.status === "stale") {
      return { label: "Stalled", tone: "negative", detail: priceState?.detail ?? streamWords.detail };
    }
    if (stream.status === "live") {
      return {
        // Truthful for a 24/7 venue and only claimed for one; an equity's
        // session calendar is not something this panel knows.
        label: crypto ? "Market open" : "Streaming",
        tone: "open", detail: priceState?.detail ?? streamWords.detail,
      };
    }
    return {
      label: quote ? "Quotes 15 s old" : "Not streaming",
      tone: "caution", detail: priceState?.detail ?? streamWords.detail,
    };
  };

  /** The reference's own freshness word for a row's tooltip. */
  const feedWord = stream.status === "live" ? "Real-time" : "Delayed";

  /*
   * ── R7b-21: the gutter is a drag handle ───────────────────────────────────
   *
   * The reference serves the same account a 300px panel at 1440 and a 346px
   * one at 1920, so the width is a stored preference and the 4px band between
   * the chart and the panel is what sets it. Device-local: how wide a column
   * is on THIS screen is not a fact about the list.
   */
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  const beginResize = (event: React.PointerEvent<HTMLElement>): void => {
    drag.current = { startX: event.clientX, startWidth: width };
    const onMove = (move: PointerEvent): void => {
      if (!drag.current) return;
      // The panel is on the RIGHT, so dragging left makes it wider.
      const next = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH,
        Math.round(drag.current.startWidth - (move.clientX - drag.current.startX))));
      setWidth(next);
    };
    const onUp = (): void => {
      drag.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setWidth((current) => { remember(WIDTH_KEY, String(current)); return current; });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const listsMenuEntries = watchlistListsMenu({
    lists: lists?.map((l) => ({ id: l.id, name: l.name })) ?? [], activeId,
  });
  const settingsMenuEntries = watchlistSettingsMenu(prefs);

  return (
    <aside
      data-watchlist
      style={{ ["--ts-watchlist-width" as string]: `${width}px` }}
      /*
        R7b-03 / R7b-05: 300px of CONTENT, and the gutter outside it.

        The panel used to spend the first 4px of its own 300 on a `bg-border`
        strip, so its content was 296 wide and every column inside it sat 4px
        left of the reference's. The workspace row already lays its regions out
        with a 4px `gap` of page ground — the gutter was being drawn twice, 9px
        of rgb(46) where the reference has 4 — so the strip goes and the gap is
        the band. What is absolutely positioned into that gap is the grip and
        the resize handle, which is what the reference puts there.
      */
      className="group/panel relative flex h-full w-screen max-w-none shrink-0 bg-surface md:w-[var(--ts-watchlist-width)]"
    >
      {/* The handle lives ON the gutter, 4px wide, outside the panel's box. */}
      <div
        aria-hidden="true"
        onPointerDown={beginResize}
        data-watchlist-resize
        title="Drag to resize the watchlist"
        className="absolute -left-[4px] top-0 hidden h-full w-[4px] cursor-col-resize md:block"
      />
      {onHide && (
        /*
          R7b-05: a PERSISTENT notch, 60px above the bottom.

          Ours was 10x42, vertically centred and `opacity:0` until the panel
          was hovered — so the one control that closes the column could not be
          found by looking at it, and a pointer that never enters the panel
          never learns it is there. The reference's is a 10x24 notch the colour
          of the panel, cut into the band, always drawn, anchored near the
          bottom rather than at the middle.
        */
        <button
          onClick={onHide}
          title="Hide the watchlist"
          aria-label="Hide the watchlist"
          style={{ top: "calc(100% - 64px)" }}
          className="absolute -left-[4px] z-10 hidden h-[24px] w-[10px] items-center justify-center rounded-l-sm bg-surface text-[10px] leading-none text-ink-faint hover:text-ink md:flex"
        >
          <span aria-hidden="true">›</span>
        </button>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {/*
          R7-05: a 46px title row over a 29px column row.

          The shipped header put five things on one 41px line — a feed dot, the
          list name, a detached caret, `+`, a TS-only "create watchlist" icon
          and a count — of which three do not exist on the reference at all.
          What the reference has is a NAME with its own caret, and three 38px
          cells: add, a table/list toggle, and the list's own `⋯` menu.
        */}
        <div data-watchlist-header className="relative flex h-[46px] shrink-0 items-center pl-3 pr-2">
          <button
            ref={nameButtonRef}
            onClick={() => setMenuOpen(!menuOpen)}
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            className="tvc-control flex h-[34px] min-w-0 items-center gap-1 rounded-md px-1.5 text-left"
          >
            {degraded && priceState && (
              /* Visible only when there IS something to say. Its sentence is
                 the `role="status"` line below, which is always present. */
              <span aria-hidden="true" title={priceState.detail}
                className={`shrink-0 text-[9px] leading-none ${priceState.tone}`}>●</span>
            )}
            <span className="truncate text-[14px] font-semibold leading-none text-ink">
              {active?.name ?? "Watchlist"}
            </span>
            <span className="flex shrink-0 items-center text-ink-faint"><CaretGlyph /></span>
          </button>
          {priceState && (
            <span role="status" aria-live="polite" className="sr-only">Prices {priceState.label}</span>
          )}
          <div className="ml-auto flex items-center">
            <button
              onClick={() => setAddOpen((v) => !v)}
              aria-expanded={addOpen}
              title="Add a symbol to this list"
              aria-label="Add a symbol to this list"
              className="tvc-control flex h-[38px] w-[38px] items-center justify-center text-ink"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
            <button
              onClick={() => updatePrefs((p) => ({ ...p, compact: !p.compact }))}
              aria-pressed={prefs.compact}
              title={prefs.compact ? "Show the change columns" : "Compact list — ticker and last price only"}
              aria-label={prefs.compact ? "Show the change columns" : "Compact list"}
              className="tvc-control flex h-[38px] w-[38px] items-center justify-center text-ink"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                <rect x="4" y="4" width="16" height="16" rx="1.5" />
                <path d="M4 9.5h16M12 9.5V20" />
              </svg>
            </button>
            <button
              ref={viewButtonRef}
              onClick={() => setViewOpen(!viewOpen)}
              aria-expanded={viewOpen}
              aria-haspopup="menu"
              /*
                R7b-08: this is SETTINGS, not list editing.
                List editing moved onto the list's own name, where the
                reference keeps it and where the thing being edited is named.
              */
              title="Watchlist settings"
              aria-label="Watchlist settings"
              className="tvc-control flex h-[38px] w-[38px] items-center justify-center text-ink"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" />
              </svg>
            </button>
          </div>
          {menuOpen && lists && (
            <PanelMenu
              entries={listsMenuEntries}
              label="My watchlists"
              width={274}
              className="left-2 top-[46px]"
              onClose={() => { setMenuOpen(false); nameButtonRef.current?.focus(); }}
              onSelect={(id) => {
                if (id === "list:copy") { void copyList(); return; }
                if (id === "list:rename") { void renameList(); return; }
                if (id === "list:clear") { void clearList(); return; }
                if (id === "list:new") { void createList(); return; }
                if (id === "list:delete") { void deleteList(); return; }
                if (id.startsWith("list:select:")) {
                  setActiveId(id.slice("list:select:".length));
                  setMenuOpen(false);
                }
              }}
            />
          )}
          {viewOpen && (
            <PanelMenu
              entries={settingsMenuEntries}
              label="Watchlist settings"
              width={222}
              className="right-2 top-[46px]"
              onClose={() => { setViewOpen(false); viewButtonRef.current?.focus(); }}
              onSelect={(id) => {
                if (id === "view:compact") { updatePrefs((p) => ({ ...p, compact: !p.compact })); return; }
                if (id === "view:mark") { updatePrefs((p) => ({ ...p, mark: !p.mark })); return; }
                if (id === "view:display:symbol") { updatePrefs((p) => ({ ...p, display: "symbol" })); return; }
                if (id === "view:display:name") { updatePrefs((p) => ({ ...p, display: "name" })); return; }
                const column = VALUE_COLUMNS.find((c) => id === `view:column:${c}`);
                if (column) {
                  updatePrefs((p) => ({ ...p,
                    columns: { ...p.columns, [column]: !p.columns[column] } }));
                }
              }}
            />
          )}
        </div>

        {addOpen && (
          /*
            R7-12 / C-06: the 34px search row, now with the symbol dialog's
            own result rows under it. Enter adds the highlighted row; Escape
            closes the field (not the panel); the accessible names are
            unchanged because `keyboard`, `drawings` and `watchlistEditFeed`
            all aim at them.
          */
          <WatchlistAddBox
            onAdd={addResolved}
            onClose={() => setAddOpen(false)}
            inList={(row) => Boolean(active?.symbols.some((s) =>
              s === (row.canonicalId ?? row.symbol) || s === row.symbol))}
          />
        )}
        {err && <div className="px-3 py-1.5 text-xs text-down" title={err.detail || undefined}>{err.headline}</div>}
        {/*
          Column headers that sort. A third click returns to the user's own
          order, so a sort is never a one-way door out of an arrangement they
          spent time on. The hairline under them is `--ts-state-active`, a step
          stronger than the row separators, exactly as the reference draws it.
        */}
        <div
          className="grid h-[29px] shrink-0 items-center border-b pl-[10px] pr-2 text-[14px] text-ink-faint"
          style={{
            borderColor: "var(--ts-state-active)", gridTemplateColumns: gridTemplate,
            // F-01: the same gutter the rows carry, so a header label and its
            // values share one right edge and no two cells ever touch.
            columnGap: COLUMN_GAP,
          }}
        >
          <button
            onClick={() => setSort((current) => nextSort(current, "symbol"))}
            aria-label={sort.column === "symbol"
              ? `Sorted by Symbol, ${sort.direction === "asc" ? "ascending" : "descending"}. Click to change.`
              : "Sort by Symbol"}
            style={{ gridColumn: `1 / ${firstValueStart}` }}
            className={`truncate text-left hover:text-ink ${
              sort.column === "symbol" ? "font-semibold text-ink" : ""}`}
          >
            Symbol
            {sort.column === "symbol" && (
              <span aria-hidden="true">{sort.direction === "asc" ? " ↑" : " ↓"}</span>
            )}
          </button>
          {columns.map((column) => {
            const key = COLUMN_SORT[column];
            /*
             * R7b-07: `Chg` and `Chg%` no longer share a key.
             *
             * Both headers used to pass `"change"`, so clicking either marked
             * BOTH with an arrow and gave both the accessible name "Sorted
             * by …" — a table reporting two sorted columns at once.
             */
            const isSorted = sort.column === key
              && (column !== "volume");
            return (
              <button
                key={column}
                ref={(element) => {
                  if (element) headerCells.current.set(column, element);
                  else headerCells.current.delete(column);
                }}
                onClick={() => setSort((current) => nextSort(current, key))}
                aria-label={isSorted
                  ? `Sorted by ${COLUMN_LABEL[column]}, ${sort.direction === "asc" ? "ascending" : "descending"}. Click to change.`
                  : `Sort by ${COLUMN_LABEL[column]}`}
                style={{ gridColumnStart: columnStart(column) }}
                /* F-01: no `pr-[2px]` — the gutter is the grid's now, and the
                   last column's right edge is the panel's inner right. */
                className={`overflow-hidden whitespace-nowrap text-right hover:text-ink ${
                  isSorted ? "font-semibold text-ink" : ""}`}
              >
                {COLUMN_LABEL[column]}
                {isSorted && (
                  <span aria-hidden="true">{sort.direction === "asc" ? " ↑" : " ↓"}</span>
                )}
              </button>
            );
          })}
        </div>
        {dropRefusal && (
          <div role="status" className="px-3 py-1 text-[11px] text-ink-faint">{dropRefusal}</div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {/*
            R7-13: loading is not emptiness.

            `lists === null` is every mount, and the empty state was rendered
            for it — so the first thing a returning user saw was a paragraph
            telling them their list was empty and pointing at a field that is
            closed by default.
          */}
          {lists === null && readFailed && (
            <div role="alert" className="px-4 py-6">
              <p className="text-xs font-medium text-down">Your watchlists could not be read.</p>
              <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
                This is not a statement that you have none — nothing was read, so nothing is
                known. They are on the server and are untouched; reopen the panel to try again.
              </p>
            </div>
          )}
          {lists === null && !readFailed && (
            <div aria-hidden="true" className="pt-1">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex h-[30px] items-center pl-[10px] pr-2">
                  <div className="h-[10px] w-[86px] rounded-sm bg-surface-2" />
                  <div className="ml-auto h-[10px] w-[54px] rounded-sm bg-surface-2" />
                </div>
              ))}
            </div>
          )}
          {lists !== null && active !== null && visibleSymbols.length === 0 && (
            <div className="px-4 py-6">
              <p className="text-xs font-medium text-ink">Nothing on this list yet</p>
              <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
                Press + to add a symbol, or start with the most liquid Binance
                spot pairs.
              </p>
              <div className="mt-3 flex flex-wrap gap-1">
                {STARTER_SYMBOLS.map((s) => (
                  <button
                    key={s}
                    onClick={() => void addSymbols([s])}
                    aria-label={`Add ${s} to this watchlist`}
                    className="rounded border border-border px-1.5 py-0.5 text-[11px] text-ink-muted transition-colors hover:border-control-border hover:text-ink"
                  >
                    {s.replace(/USDT$/, "")}
                  </button>
                ))}
              </div>
              <button
                onClick={() => void addSymbols(STARTER_SYMBOLS)}
                /* The same bordered chip as the symbols above it. A full-width
                   filled-accent CTA is a product tour, and this is a 300px panel
                   of a trading workstation. */
                className="tvc-control mt-3 rounded-md border border-control-border px-1.5 py-0.5 text-[11px] text-ink-muted hover:text-ink"
              >
                {`Add all ${STARTER_SYMBOLS.length}`}
              </button>
              <p className="mt-2 text-[10px] leading-relaxed text-ink-faint">
                A starting point, not a recommendation — a watchlist row moves no
                strategy, alert or order.
              </p>
            </div>
          )}
          {bands.map((section) => (
            <div key={`${section.anchor ?? ""}:${section.label}`}
              data-watchlist-section={section.label}>
              {/*
                R7b-14: a 6px gap and a 36px row, and no count.

                The band used to be 36px INCLUDING 6px of top padding, so its
                label sat 8px high in its own row and the first quote arrived
                at y=153 where the reference has it at 161. The count at the
                right end is the reference's own absence: it paints none, and a
                number beside a group heading in a list this dense is one more
                digit competing with eight prices.
              */}
              {/* F-05: a user's own band is EDITABLE — the queue's "editable
                  section header row". An asset-class band is not: its name is
                  a fact about the instruments, not a choice. */}
              <div className="group/band relative flex items-center">
                <button
                  onClick={() => toggleGroup(section.label)}
                  aria-expanded={!collapsed.includes(section.label)}
                  data-watchlist-band
                  className="mt-[6px] flex h-[36px] min-w-0 flex-1 items-center gap-[13px] pl-[23px] pr-2 text-left"
                >
                  <span aria-hidden="true"
                    className={`shrink-0 text-[8px] leading-none text-ink-faint transition-transform ${
                      collapsed.includes(section.label) ? "-rotate-90" : ""}`}>▼</span>
                  <span className="min-w-0 flex-1 truncate text-[12px] uppercase tracking-[0.04em] text-ink-faint">
                    {section.label}
                  </span>
                </button>
                {section.anchor !== null && (
                  <span className="mt-[6px] flex h-[36px] shrink-0 items-center gap-0.5 pr-2">
                    <button
                      onClick={() => void renameSection(section.anchor!, section.label)}
                      aria-label={`Rename the section “${section.label}”`}
                      title={`Rename the section “${section.label}”`}
                      className="tvc-control flex h-5 w-5 items-center justify-center rounded-sm text-ink-faint opacity-0 hover:text-ink focus-visible:opacity-100 group-hover/band:opacity-100"
                    >
                      <svg width="12" height="12" viewBox="0 0 15 15" fill="none" stroke="currentColor"
                        strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M2.5 12.5v-2.5l7.5-7.5 2.5 2.5-7.5 7.5z" /><path d="M9 3.5l2.5 2.5" />
                      </svg>
                    </button>
                    <button
                      onClick={() => dropSection(section.anchor!)}
                      aria-label={`Remove the section “${section.label}”`}
                      title="Remove this section — the symbols stay on the list"
                      className="tvc-control flex h-5 w-5 items-center justify-center rounded-sm text-ink-faint opacity-0 hover:text-ink focus-visible:opacity-100 group-hover/band:opacity-100"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                        strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                        <path d="M6 6l12 12M18 6L6 18" />
                      </svg>
                    </button>
                  </span>
                )}
              </div>
              {!collapsed.includes(section.label) && section.rows.map((s) => {
                const identity = canonicalDisplayParts(s.symbol);
                const selectedRow = s.symbol === selected;
                const t = selectedRow && replayQuote ? replayQuote : tickers[s.symbol];
                const up = t ? t.chgPct >= 0 : true;
                const known = Boolean(t) && t!.changeKnown !== false;
                const changeClass = known ? (up ? "text-up" : "text-down") : "text-ink-faint";
                /*
                 * R7b-04: the instrument's decimals, not the number's.
                 *
                 * `Last` and `Chg` share them, which is what the reference
                 * does and what stops one row reading `1.387 / 0.0367`.
                 */
                const tick = resolvePriceTick(symbols, s.symbol);
                const digits = t ? quoteDigits(t.last, tick) : 2;
                const ticker = displayTicker(s.symbol);
                const name = displayName(s.symbol);
                const label = prefs.display === "name" ? name : ticker;
                const volume = (tickers[s.symbol] as WatchlistTicker | undefined)?.volume;
                /*
                 * F-01: the value, at the most precision its track can hold.
                 *
                 * Full precision whenever it fits — which at the default 300px
                 * panel is every column of every seeded row — and one decimal
                 * less at a time when it does not, rather than a number clipped
                 * mid-glyph or painted over the column beside it.
                 */
                const fit = (
                  column: ValueColumn, format: (d: number) => string, natural: number,
                ): string => fitDecimals(format, natural, cellWidth[column] ?? 0, measure);
                const cell = (column: ValueColumn): string | null => {
                  if (!t) return column === "last" ? "—" : "—";
                  if (column === "last") {
                    return fit("last",
                      (d) => t.last.toLocaleString(undefined,
                        { minimumFractionDigits: d, maximumFractionDigits: d }),
                      quoteDigits(t.last, tick));
                  }
                  if (column === "volume") {
                    return volume === undefined ? "—"
                      : volume.toLocaleString(undefined, { notation: "compact", maximumFractionDigits: 2 });
                  }
                  if (!known) return "—";
                  return column === "change"
                    ? fit("change", (d) => t.chg.toLocaleString(undefined,
                      { minimumFractionDigits: d, maximumFractionDigits: d }), digits)
                    : fit("changePct", (d) => `${t.chgPct.toFixed(d)}%`, 2);
                };
                return <div key={s.symbol}
                  data-watchlist-row={s.symbol}
                  draggable={canReorder(sort)}
                  onDragStart={(e) => {
                    if (!canReorder(sort)) return;
                    setDragging(s.symbol);
                    setDropRefusal(null);
                    e.dataTransfer.effectAllowed = "move";
                    // Some browsers refuse a drag with no payload at all.
                    e.dataTransfer.setData("text/plain", s.symbol);
                  }}
                  onDragOver={(e) => { if (canReorder(sort) && dragging) e.preventDefault(); }}
                  onDrop={(e) => {
                    if (!dragging) return;
                    e.preventDefault();
                    if (!canReorder(sort)) {
                      // R7b-07: the refusal is the ANSWER to this drop.
                      setDropRefusal(reorderRefusal(sort));
                      setDragging(null);
                      return;
                    }
                    moveSymbolOnto(dragging, s.symbol);
                    setDragging(null);
                  }}
                  onDragEnd={() => setDragging(null)}
                  onKeyDown={(e) => {
                    /* R7b-09: the reference removes a focused row with Delete.
                       Backspace too — on a Mac keyboard it is the key labelled
                       "delete", and a row vanishing under one and not the other
                       is the sort of difference nobody can account for. */
                    if (e.key !== "Delete" && e.key !== "Backspace") return;
                    if (e.target instanceof HTMLInputElement) return;
                    e.preventDefault();
                    removeSymbol(s.symbol);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    openRowMenu({ x: e.clientX, y: e.clientY }, s.symbol);
                  }}
                  /*
                   * R7-03 / R7-04: 30px of pitch (29px + a 1px separator), and
                   * a SELECTED row that is an outline rather than a filled
                   * slab. The reference draws a 2px rgb(140) ring with the
                   * panel's own ground inside it; ours painted the whole row
                   * `--ts-state-active`, which at 300px wide is the single
                   * loudest neutral on the surface and reads as a different
                   * selection grammar from across the room.
                   *
                   * R7b-01: 30, not 29. `border-box` puts the separator INSIDE
                   * the height, so a 29px class was a 29px PITCH and every row
                   * below the first was one pixel higher than the reference's —
                   * eight rows, eight pixels, and a details block that started
                   * in the wrong place.
                   */
                  style={{
                    borderColor: selectedRow ? "transparent" : "var(--ts-line-soft)",
                    ...(selectedRow
                      ? { boxShadow: "inset 0 0 0 2px var(--ts-ring)" } : {}),
                  }}
                  className={`group relative h-11 border-b md:h-[30px] ${
                    selectedRow ? "rounded-md" : "hover:bg-state-hover"}`}>
                  {/*
                    F-05: the flag stub, at the row's left edge.

                    4px of the reader's own colour, which is the reference's
                    marking and the only thing on this row that is not a fact
                    about the market. Drawn OUTSIDE the row button so a click on
                    it still selects the row.
                  */}
                  {flagHex(flags[s.symbol] ?? null) !== null && (
                    <span
                      aria-hidden="true"
                      data-watchlist-flag={flags[s.symbol]}
                      className="pointer-events-none absolute left-0 top-1/2 h-[18px] w-[4px] -translate-y-1/2 rounded-r-sm"
                      style={{ backgroundColor: flagHex(flags[s.symbol] ?? null)! }}
                    />
                  )}
                  <button onClick={() => onSelect(s.symbol)}
                    style={{ gridTemplateColumns: gridTemplate, columnGap: COLUMN_GAP }}
                    /* F-01: `pl-[10px]`, the header's own padding. They ran
                       `pl-4` against `pl-[10px]`, so the two grids resolved
                       their flexible ticker track over containers 6px apart
                       and a label never sat over its values. */
                    className="grid h-full w-full min-w-0 items-center pl-[10px] pr-2 text-left text-[14px] tabular"
                    /*
                     * R7b-09: an honest tooltip.
                     *
                     * This read `BINANCE:BTC/USDT · SPOT · BINANCE` — a
                     * qualified storage identity, with the venue in it twice,
                     * on the surface the contract says never shows one. The
                     * reference's says what the instrument IS, where it trades,
                     * whether the number is live, and whether the market is
                     * open.
                     */
                    title={`${name}${s.venue ? ` · ${s.venue}` : ""} · ${feedWord} · ${marketLine(s, tickers[s.symbol] ?? null).label}`
                      + (notes[s.symbol] ? `\n${notes[s.symbol]}` : "")}>
                    {/*
                      The ticker comes FIRST in the DOM and second on screen.
                      An explicit `gridColumnStart` places the mark, so a screen
                      reader and `textContent` read `BTCUSDT` rather than the
                      monogram's two letters — which is also what the
                      row-finding tests depend on.

                      D-01: the default 300px panel leaves 122px for the
                      symbol region: an 18px mark, an 8px gap and 96px of
                      ticker. Numeric columns own fixed, right-aligned widths
                      and never ellipsise. If a user enables extra columns,
                      only this ticker cell is allowed to hard-clip.
                    */}
                    <span data-ticker
                      style={{ gridColumnStart: tickerStart, gridRowStart: 1 }}
                      className="flex min-w-0 items-center overflow-hidden whitespace-nowrap font-normal text-ink">
                      <span>{label}</span>
                      {/* accent-is-meaning: a non-spot row is a different instrument KIND,
                          and mistaking a perp for spot is the costly error this prevents. */}
                      {identity && identity.type !== "spot" && (
                        <span className="ml-1 shrink-0 text-[9px] font-bold text-accent">
                          {instrumentTypeLabel(identity.type)}{identity.expiry ? ` ${identity.expiry.slice(2)}` : ""}
                        </span>
                      )}
                      {/* F-05: a note EXISTS, and the tooltip carries it. A
                          note that leaves no mark on the row is a note nobody
                          remembers writing. */}
                      {notes[s.symbol] && (
                        <span data-watchlist-note aria-hidden="true"
                          title={notes[s.symbol]}
                          className="ml-1 shrink-0 text-ink-faint">
                          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor"
                            strokeWidth="1.3" strokeLinejoin="round">
                            <path d="M3 3h10v7l-3 3H3z" /><path d="M13 10h-3v3" />
                          </svg>
                        </span>
                      )}
                    </span>
                    {columns.map((column) => {
                      const text = cell(column) ?? "—";
                      const tone = column === "last"
                        ? (t ? (t.stale ? "text-warn" : "text-ink") : "text-ink-faint")
                        : column === "volume" ? "text-ink-muted"
                        : changeClass;
                      return (
                        <span
                          key={column}
                          data-col={COLUMN_DATA[column]}
                          style={{ gridColumnStart: columnStart(column), gridRowStart: 1 }}
                          /* F-01: a value can never paint outside its track.
                             `fitDecimals` above keeps it from needing to. */
                          className="overflow-hidden whitespace-nowrap text-right tabular"
                          title={column === "last" && selectedRow && replayQuote
                            ? "Replay price at the current historical horizon" : undefined}
                        >
                          {column === "last"
                            ? <TickDigits text={text} className={tone} />
                            : <span className={tone}>{text}</span>}
                        </span>
                      );
                    })}
                    {prefs.mark && (
                      <AssetMark asset={s.baseAsset} size={18}
                        className="col-start-1 row-start-1" />
                    )}
                  </button>
                  {/*
                    R7b-09: the reference's hover remove.

                    Over the last column rather than as a column of its own —
                    R7-03 removed a permanent `+`/`×` column for the right
                    reason, and a 16px control that only exists under the
                    pointer costs the list nothing. Focus reveals it too, so it
                    is reachable without a pointer at all, and the Delete key
                    on the row does the same thing.
                  */}
                  {/*
                    F-05: a TRASH, 24×24, over the Chg% cell while hovered.

                    It was a 16px `×`, which in this product's grammar is
                    "dismiss" rather than "delete" — the reference draws a bin
                    here and the row it is on is about to leave the list. The
                    plate under it is the panel's own ground, so the number it
                    covers does not read through it.
                  */}
                  <button
                    data-watchlist-remove={s.symbol}
                    onClick={() => removeSymbol(s.symbol)}
                    aria-label={`Remove ${ticker} from this list`}
                    title={`Remove ${ticker} from this list`}
                    /*
                      NOT `.tvc-control`.

                      That class is `position: relative` at `:is(.ts-app) .tvc-control`
                      — two class selectors — which outranks Tailwind's single-class
                      `absolute`. So this control was never positioned at all: measured
                      live, the 24px box sat at x 1090 against a row running 1094–1394,
                      4px OUTSIDE the panel's left edge, which is why the reviewer's
                      hover found "no affordances". It is the only positioned
                      `.tvc-control` in the product; the hover-revealed affordances in
                      the indicator browser already do without it, and the chip
                      treatment it provides is not what a 24px icon over a number
                      wants anyway.
                    */
                    className="absolute right-[4px] top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-sm bg-surface text-ink-faint opacity-0 transition-opacity hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor"
                      strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9" />
                    </svg>
                  </button>
                </div>;
              })}
            </div>
          ))}
        </div>
        {selectedDetails && (
          <WatchlistDetails
            qualifiedName={displaySymbol(selectedDetails.info.symbol)}
            longName={displayName(selectedDetails.info.symbol)}
            ticker_={displayTicker(selectedDetails.info.symbol)}
            base={selectedDetails.info.baseAsset}
            quote={selectedDetails.info.quoteAsset}
            venue={selectedDetails.info.venue ?? "BINANCE"}
            typeLabel={sentenceCase(instrumentTypeLabel(
              canonicalDisplayParts(selectedDetails.info.symbol)?.type ?? "spot"))}
            classLabel={groupOf(selectedDetails.info)}
            quote24h={selectedDetails.ticker}
            market={marketLine(selectedDetails.info, selectedDetails.ticker)}
            priceTick={resolvePriceTick(symbols, selectedDetails.info.symbol)}
            daily={derivedStats}
            onEdit={() => onAddAlert?.(selectedDetails.info.symbol)}
            onMenu={(at) => openRowMenu(at, selectedDetails.info.symbol)}
          />
        )}
        <ContextMenu
          at={pointMenu?.at ?? null}
          label={pointMenu?.label ?? ""}
          entries={pointMenu?.entries ?? []}
          /* F-05: the reference's measured 254, not the shared 200–360 band. */
          width={WATCHLIST_MENU_WIDTH}
          onClose={() => setPointMenu(null)}
          onSelect={(id) => {
            const symbol = pointMenu?.symbol;
            if (symbol && id.startsWith("watchlist:add-to-list:")) {
              void addSymbols([symbol], id.slice("watchlist:add-to-list:".length));
              return;
            }
            if (symbol && id.startsWith("watchlist:flag-colours:")) {
              pickFlag(symbol, id.slice("watchlist:flag-colours:".length) as FlagColour);
              return;
            }
            switch (id) {
              case "watchlist:add-symbol":
                // R7b-18 / R7b-15: the same add field the header's `+` opens.
                setAddOpen(true);
                return;
              case "watchlist:flag": if (symbol) toggleFlag(symbol); return;
              case "watchlist:unflag-all": setFlags(clearFlags()); return;
              case "watchlist:add-compare": if (symbol) onAddCompare?.(symbol); return;
              case "watchlist:add-note": if (symbol) void addNoteFor(symbol); return;
              case "watchlist:add-section": if (symbol) void addSectionAbove(symbol); return;
              case "watchlist:open-focused": if (symbol) onSelect(symbol); return;
              case "watchlist:open-new-pane": if (symbol) onOpenInNewPane?.(symbol); return;
              case "watchlist:add-alert": if (symbol) onAddAlert?.(symbol); return;
              default: return;
            }
          }}
        />
      </div>
    </aside>
  );
}
