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
import { watchlistMenu } from "@/lib/menuPayloads";
import type { MenuEntry } from "@/lib/contextMenu";
import {
  MANUAL_SORT, canReorder, nextSort, reorderRefusal, reorderSymbols, sortSymbols,
  type SortColumn, type WatchlistSort,
} from "@/lib/watchlistOrder";
import {
  canonicalDisplayParts, canonicalizeLegacySpotSymbol, displaySymbol, displayTicker,
  instrumentTypeLabel, isCanonicalInstrumentId, type AssetClass,
} from "@/lib/instrument";
import { CaretGlyph } from "@/components/ui";
import { describeAction, type FailureCopy } from "@/lib/errorCopy";
import { AssetMark, WatchlistDetails, type MarketLine } from "@/components/tv/WatchlistDetails";

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
 * The row's four columns, as literals so Tailwind can see them.
 *
 * TVP8 R7-03: measured off the reference at 1440×900 — a 24px mark cell, the
 * ticker taking what is left, then 72 / 70 / 60 for Last / Chg / Chg%. The
 * shipped grid gave the two change columns 50px each, which cannot hold
 * `+333.12` at 14px, so every change cell in every capture read `+333....`.
 */
const ROW_GRID = "grid-cols-[24px_minmax(0,1fr)_72px_70px_60px]";
const ROW_GRID_COMPACT = "grid-cols-[24px_minmax(0,1fr)_72px]";
const HEAD_GRID = "grid-cols-[minmax(0,1fr)_72px_70px_60px]";
const HEAD_GRID_COMPACT = "grid-cols-[minmax(0,1fr)_72px]";

export function Watchlist({
  symbols, selected, onSelect, onSymbolsChanged, replayQuote = null,
  onOpenInNewPane, onAddAlert, canOpenNewPane = false, replayActive = false,
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
  canOpenNewPane?: boolean;
  replayActive?: boolean;
  /** The gutter grip closes the panel; the rail cell still toggles it. */
  onHide?: () => void;
}) {
  const ask = useAsk();
  const [adding, setAdding] = useState("");
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
  const [lists, setLists] = useState<NamedWatchlist[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  /**
   * One `ContextMenu` for every menu opened at a POINT — a row's right-click,
   * the header's `⋯`, the details block's `⋯`. The alternative is three
   * components with three sets of keyboard, placement and focus-restore rules,
   * which is the thing `ContextMenu`'s own header explains at length.
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
        setLists([]);
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
    if (lists === null || lists.length > 0 || symbols.length === 0 || seededDefault.current) return;
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
  }, [lists, symbols]);

  useEffect(() => {
    if (activeId) remember(ACTIVE_KEY, activeId);
  }, [activeId]);

  /** Compact mode: mark + ticker + Last, on the same 30px rows. */
  const [compact, setCompact] = useState(false);
  const [collapsed, setCollapsed] = useState<readonly string[]>([]);
  useEffect(() => {
    setCompact(recall(COMPACT_KEY) === "1");
    try {
      const raw = recall(COLLAPSED_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) setCollapsed(parsed.filter((x): x is string => typeof x === "string"));
    } catch { /* a malformed preference is no preference */ }
  }, []);
  const setCompactRemembered = (next: boolean): void => {
    setCompact(next);
    remember(COMPACT_KEY, next ? "1" : "0");
  };
  const toggleGroup = (label: string): void => {
    setCollapsed((current) => {
      const next = current.includes(label) ? current.filter((x) => x !== label) : [...current, label];
      remember(COLLAPSED_KEY, JSON.stringify(next));
      return next;
    });
  };

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

  const updateActive = (fn: (list: NamedWatchlist) => NamedWatchlist) => {
    if (!active) return;
    const next = fn(active);
    setLists((prev) => prev?.map((l) => (l.id === next.id ? next : l)) ?? prev);
    api.updateWatchlist(next.id, { name: next.name, symbols: next.symbols })
      .catch((e: Error) => setErr(describeAction(e, "read the watchlists")));
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
  const sections = useMemo(() => {
    const order: string[] = [];
    const byLabel = new Map<string, SymbolInfo[]>();
    for (const item of visibleSymbols) {
      const label = groupOf(item);
      if (!byLabel.has(label)) { byLabel.set(label, []); order.push(label); }
      byLabel.get(label)!.push(item);
    }
    return order.map((label) => ({ label, rows: byLabel.get(label)! }));
  }, [visibleSymbols]);

  const selectedDetails = useMemo(() => {
    const selectedLabel = displaySymbol(selected);
    const info = manualSymbols.find((item) => item.symbol === selected
      || displaySymbol(item.symbol) === selectedLabel) ?? null;
    if (!info) return null;
    return { info, ticker: tickers[info.symbol] ?? tickers[selected] ?? null };
  }, [manualSymbols, selected, tickers]);

  /** The row being dragged, in the manual order. Null when nothing is. */
  const [dragging, setDragging] = useState<string | null>(null);
  /** Why the last drop was refused, if it was. Cleared by the next drag. */
  const [dropRefusal, setDropRefusal] = useState<string | null>(null);

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
   * Optimistic local edit, then persist. The list re-renders immediately and
   * the server write follows; a failure surfaces in the error line rather than
   * silently diverging.
   */

  /**
   * Add one or more pairs, registering any the catalog does not have yet.
   *
   * Shared by the type-in field and the empty state's starter buttons, so
   * "adding a symbol" means exactly one thing however it was reached — the
   * starter list is not a second, looser admission path.
   */
  const addSymbols = async (wanted: readonly string[]) => {
    const clean = wanted.map((s) => s.trim()).filter(Boolean);
    if (clean.length === 0) return;
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
      updateActive((l) => ({
        ...l,
        symbols: [...l.symbols, ...resolved.filter((s) => !l.symbols.includes(s))],
      }));
      setAdding("");
    } catch (e) { setErr(describeAction(e, "create the list")); }
  };

  const add = async () => {
    const s = adding.trim().toUpperCase();
    if (!s) return;
    // Legacy suffix split, kept deliberately: this quick-add accepts USDT
    // pairs and only USDT pairs, so the suffix is the admission rule and the
    // base asset follows from it. Adding a pair through the symbol dialog
    // instead registers it from the venue's own metadata.
    await addSymbols([s]);
    setAddOpen(false);
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
  const renameList = async () => {
    if (!active) return;
    const name = (await ask.promptFor({
      title: "Rename watchlist", label: "Name", defaultValue: active.name,
      confirmLabel: "Rename",
    }))?.trim();
    if (name) updateActive((l) => ({ ...l, name }));
    setMenuOpen(false);
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

  const px = (n: number) => {
    const abs = Math.abs(n), d = abs >= 1000 ? 1 : abs >= 100 ? 2 : abs >= 1 ? 3 : abs >= .01 ? 5 : 7;
    return n.toLocaleString(undefined, { maximumFractionDigits: d });
  };

  const openRowMenu = (at: { x: number; y: number }, symbol: string): void => {
    setPointMenu({
      at, symbol,
      // R7-10: a canonical id is never the visible name of anything.
      label: displayTicker(symbol),
      entries: watchlistMenu({ symbol, replayActive, canOpenNewPane }),
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

  const columns: [SortColumn, string, string][] = compact
    ? [["symbol", "Symbol", ""], ["last", "Last", "text-right"]]
    : [["symbol", "Symbol", ""], ["last", "Last", "text-right"],
       ["change", "Chg", "text-right"], ["change", "Chg%", "text-right"]];

  return (
    <aside data-watchlist className="group/panel flex h-full w-[85vw] max-w-[300px] shrink-0 bg-surface md:w-[300px]">
      {/*
        R7-14: the 4px gutter, inside the panel's own 300px.

        The reference's panel is a DOCKED COLUMN: a 4px band of `--ts-line`
        separates it from the chart and carries the grip that closes it. Ours
        was a 1px `border-l`, which reads as a box drawn around a region rather
        than as a column parked beside one — the difference between a
        workstation and a page with a sidebar.
      */}
      <div className="relative hidden w-[4px] shrink-0 bg-border md:block">
        {onHide && (
          <button
            onClick={onHide}
            title="Hide the watchlist"
            aria-label="Hide the watchlist"
            className="absolute -left-[3px] top-1/2 z-10 flex h-[42px] w-[10px] -translate-y-1/2 items-center justify-center rounded-sm bg-border text-[10px] leading-none text-ink-faint opacity-0 transition-opacity hover:text-ink focus-visible:opacity-100 group-hover/panel:opacity-100"
          >
            <span aria-hidden="true">›</span>
          </button>
        )}
      </div>

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
              onClick={() => setCompactRemembered(!compact)}
              aria-pressed={compact}
              title={compact ? "Show the change columns" : "Compact list — ticker and last price only"}
              aria-label={compact ? "Show the change columns" : "Compact list"}
              className="tvc-control flex h-[38px] w-[38px] items-center justify-center text-ink"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                <rect x="4" y="4" width="16" height="16" rx="1.5" />
                <path d="M4 9.5h16M12 9.5V20" />
              </svg>
            </button>
            <button
              onClick={(e) => {
                const box = e.currentTarget.getBoundingClientRect();
                setPointMenu({
                  at: { x: box.right, y: box.bottom }, symbol: null, label: active?.name ?? "Watchlist",
                  entries: [
                    { id: "list:new", label: "New list" },
                    { id: "list:rename", label: "Rename list", disabled: !active,
                      disabledReason: "No list is selected" },
                    { id: "list:delete", label: "Delete list", destructive: true,
                      disabled: !active || (lists?.length ?? 0) <= 1,
                      disabledReason: "A workspace keeps at least one list" },
                  ],
                });
              }}
              title="More watchlist actions"
              aria-label="More watchlist actions"
              className="tvc-control flex h-[38px] w-[38px] items-center justify-center text-ink"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" />
              </svg>
            </button>
          </div>
          {menuOpen && lists && (
            <div role="menu" aria-label="My watchlists"
              className="absolute left-2 right-2 top-[46px] z-50 tvc-menu">
              <div className="tvc-menu-heading">My watchlists</div>
              {lists.map((l) => (
                <button key={l.id} role="menuitemradio" aria-checked={l.id === activeId}
                  onClick={() => { setActiveId(l.id); setMenuOpen(false); }}
                  className="tvc-menu-row justify-between px-2.5 text-left text-sm text-ink">
                  <span className="truncate">{l.name}</span><span className="opacity-70">{l.symbols.length}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {addOpen && (
          /*
            R7-12: a 34px search row, not a form.

            This was a 29px input with a 2px ACCENT border beside a filled-blue
            `Add` button — a primary call to action inside a 300px workstation
            panel, in the one colour the contract reserves for meaning. Enter
            adds; Escape closes; the accessible names are unchanged because
            `keyboard`, `drawings` and `watchlistEditFeed` all aim at them.
          */
          <div className="flex h-[34px] shrink-0 items-center gap-1.5 rounded-md border border-control-border px-2 mx-2 mb-1">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
              aria-hidden="true" className="shrink-0 text-ink-faint">
              <circle cx="11" cy="11" r="6.5" /><path d="M16 16l4.5 4.5" />
            </svg>
            {/* A placeholder is not an accessible name, and it disappears as soon
                as the field is typed into. Measured in a browser: this was the one
                control on the chart with no name at all. */}
            <input autoFocus value={adding} onChange={(e) => setAdding(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void add();
                if (e.key === "Escape") { setAdding(""); setAddOpen(false); }
              }}
              aria-label="Add a symbol to this watchlist" placeholder="Symbol, e.g. BTCUSDT"
              className="w-full bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-faint" />
          </div>
        )}
        {err && <div className="px-3 py-1.5 text-xs text-down" title={err.detail || undefined}>{err.headline}</div>}
        {/*
          Column headers that sort. A third click returns to the user's own
          order, so a sort is never a one-way door out of an arrangement they
          spent time on. The hairline under them is `--ts-state-active`, a step
          stronger than the row separators, exactly as the reference draws it.
        */}
        <div className={`grid h-[29px] shrink-0 items-center gap-x-1 border-b pl-[10px] pr-2 text-[14px] text-ink-faint ${compact ? HEAD_GRID_COMPACT : HEAD_GRID}`}
          style={{ borderColor: "var(--ts-state-active)" }}>
          {columns.map(([column, label, extra]) => (
            <button
              key={label}
              onClick={() => setSort((current) => nextSort(current, column))}
              aria-label={sort.column === column
                ? `Sorted by ${label}, ${sort.direction === "asc" ? "ascending" : "descending"}. Click to change.`
                : `Sort by ${label}`}
              className={`${extra} truncate text-left hover:text-ink ${
                sort.column === column ? "font-semibold text-ink" : ""
              }`}
            >
              {label}
              {sort.column === column && (
                <span aria-hidden="true">{sort.direction === "asc" ? " ↑" : " ↓"}</span>
              )}
            </button>
          ))}
        </div>
        {(reorderRefusal(sort) ?? dropRefusal) && (
          <div className="px-3 py-1 text-[11px] text-ink-faint">{reorderRefusal(sort) ?? dropRefusal}</div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {/*
            R7-13: loading is not emptiness.

            `lists === null` is every mount, and the empty state was rendered
            for it — so the first thing a returning user saw was a paragraph
            telling them their list was empty and pointing at a field that is
            closed by default.
          */}
          {lists === null && (
            <div aria-hidden="true" className="pt-1">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex h-[30px] items-center pl-4 pr-2">
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
          {sections.map((section) => (
            <div key={section.label} data-watchlist-section={section.label}>
              <button
                onClick={() => toggleGroup(section.label)}
                aria-expanded={!collapsed.includes(section.label)}
                className="flex h-[36px] w-full items-center gap-[13px] pl-[23px] pr-2 pt-[6px] text-left"
              >
                <span aria-hidden="true"
                  className={`shrink-0 text-[8px] leading-none text-ink-faint transition-transform ${
                    collapsed.includes(section.label) ? "-rotate-90" : ""}`}>▼</span>
                <span className="min-w-0 flex-1 truncate text-[12px] uppercase tracking-[0.04em] text-ink-faint">
                  {section.label}
                </span>
                <span className="shrink-0 text-[11px] text-ink-faint">{section.rows.length}</span>
              </button>
              {!collapsed.includes(section.label) && section.rows.map((s) => {
                const identity = canonicalDisplayParts(s.symbol);
                const selectedRow = s.symbol === selected;
                const t = selectedRow && replayQuote ? replayQuote : tickers[s.symbol];
                const up = t ? t.chgPct >= 0 : true;
                const known = Boolean(t) && t!.changeKnown !== false;
                const changeClass = known ? (up ? "text-up" : "text-down") : "text-ink-faint";
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
                    if (!canReorder(sort) || !dragging) return;
                    e.preventDefault();
                    moveSymbolOnto(dragging, s.symbol);
                    setDragging(null);
                  }}
                  onDragEnd={() => setDragging(null)}
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
                   */
                  className={`group h-11 border-b md:h-[29px] ${
                    selectedRow
                      ? "rounded-md border-transparent shadow-[inset_0_0_0_2px_var(--ts-ink-faint)]"
                      : "border-border hover:bg-state-hover"}`}>
                  <button onClick={() => onSelect(s.symbol)}
                    className={`grid h-full w-full min-w-0 items-center gap-x-1 pl-4 pr-2 text-left text-[14px] tabular ${compact ? ROW_GRID_COMPACT : ROW_GRID}`}
                    title={`${displaySymbol(s.symbol)}${s.venue ? ` · ${s.venue}` : ""}`}>
                    {/*
                      The ticker comes FIRST in the DOM and second on screen.
                      `col-start-*` places the mark, so a screen reader and
                      `textContent` read `BTCUSDT` rather than the monogram's
                      two letters — which is also what the row-finding tests
                      depend on.
                    */}
                    <span data-ticker className="col-start-2 row-start-1 flex min-w-0 items-center overflow-hidden whitespace-nowrap font-normal text-ink">
                      <span>{displayTicker(s.symbol)}</span>
                      {/* accent-is-meaning: a non-spot row is a different instrument KIND,
                          and mistaking a perp for spot is the costly error this prevents. */}
                      {identity && identity.type !== "spot" && (
                        <span className="ml-1 shrink-0 text-[9px] font-bold text-accent">
                          {instrumentTypeLabel(identity.type)}{identity.expiry ? ` ${identity.expiry.slice(2)}` : ""}
                        </span>
                      )}
                    </span>
                    <span data-col="last" className={`col-start-3 row-start-1 text-right ${t ? (t.stale ? "text-warn" : "text-ink") : "text-ink-faint"}`}
                      title={selectedRow && replayQuote ? "Replay price at the current historical horizon" : undefined}>
                      {t ? px(t.last) : "—"}
                    </span>
                    {!compact && (
                      <span data-col="chg" className={`col-start-4 row-start-1 text-right ${changeClass}`}>
                        {/* No `+` prefix: the colour carries the sign, and at
                            14px the character is a column's worth of width. */}
                        {known ? px(t!.chg) : "—"}
                      </span>
                    )}
                    {!compact && (
                      <span data-col="chgpct" className={`col-start-5 row-start-1 text-right ${changeClass}`}>
                        {known ? `${t!.chgPct.toFixed(2)}%` : "—"}
                      </span>
                    )}
                    <AssetMark asset={s.baseAsset} size={18} className="col-start-1 row-start-1" />
                  </button>
                </div>;
              })}
            </div>
          ))}
        </div>
        {selectedDetails && (
          <WatchlistDetails
            qualifiedName={displaySymbol(selectedDetails.info.symbol)}
            ticker_={displayTicker(selectedDetails.info.symbol)}
            base={selectedDetails.info.baseAsset}
            quote={selectedDetails.info.quoteAsset}
            venue={selectedDetails.info.venue ?? "BINANCE"}
            typeLabel={sentenceCase(instrumentTypeLabel(
              canonicalDisplayParts(selectedDetails.info.symbol)?.type ?? "spot"))}
            classLabel={groupOf(selectedDetails.info)}
            quote24h={selectedDetails.ticker}
            market={marketLine(selectedDetails.info, selectedDetails.ticker)}
            statsProvider={(selectedDetails.info.venue ?? "BINANCE") === "BINANCE" ? "binance-24h" : "none"}
            formatPrice={px}
            onMenu={(at) => openRowMenu(at, selectedDetails.info.symbol)}
          />
        )}
        <ContextMenu
          at={pointMenu?.at ?? null}
          label={pointMenu?.label ?? ""}
          entries={pointMenu?.entries ?? []}
          onClose={() => setPointMenu(null)}
          onSelect={(id) => {
            if (id === "list:new") { void createList(); return; }
            if (id === "list:rename") { void renameList(); return; }
            if (id === "list:delete") { void deleteList(); return; }
            const symbol = pointMenu?.symbol;
            if (!symbol) return;
            switch (id) {
              case "watchlist:open-focused": onSelect(symbol); return;
              case "watchlist:open-new-pane": onOpenInNewPane?.(symbol); return;
              case "watchlist:add-alert": onAddAlert?.(symbol); return;
              case "watchlist:remove":
                updateActive((l) => ({
                  ...l, symbols: l.symbols.filter((x) => x !== symbol),
                }));
                return;
              default: return;
            }
          }}
        />
      </div>
    </aside>
  );
}
