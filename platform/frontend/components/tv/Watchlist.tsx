"use client";
import { useEffect, useMemo, useState } from "react";
import type { SymbolInfo } from "@/lib/types";
import { api, type ServerWatchlist } from "@/lib/api";
import { useWatchlistTickers } from "@/lib/useWatchlistTickers";
import { describeStreamState } from "@/lib/marketStream";
import { ContextMenu } from "@/components/tv/ContextMenu";
import { watchlistMenu } from "@/lib/menuPayloads";
import type { MenuEntry } from "@/lib/contextMenu";
import {
  MANUAL_SORT, canReorder, nextSort, reorderRefusal, reorderSymbols, sortSymbols,
  type SortColumn, type WatchlistSort,
} from "@/lib/watchlistOrder";
import { canonicalDisplayParts, displaySymbol, isCanonicalInstrumentId } from "@/lib/instrument";

interface Ticker { last: number; chg: number; chgPct: number; stale?: boolean; changeKnown?: boolean }
type NamedWatchlist = ServerWatchlist;

/**
 * Lists live in the database, not localStorage: the same watchlist has to be
 * there when the app is opened on the phone the MA alerts notify.
 * Only the *selected* list stays device-local.
 */
const LEGACY_KEY = "tv-clone-watchlists-v1";
const ACTIVE_KEY = "tv.watchlist.active.v1";

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

export function Watchlist({
  symbols, selected, onSelect, onSymbolsChanged, replayQuote = null,
  onOpenInNewPane, onAddAlert, canOpenNewPane = false, replayActive = false,
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
}) {
  const [adding, setAdding] = useState("");
  /** The add-symbol field is opened from the header, not permanently reserved. */
  const [addOpen, setAddOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [lists, setLists] = useState<NamedWatchlist[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  /**
   * The row right-click menu.
   *
   * `watchlistMenu` was written in Wave B and imported by nothing but its
   * test, so B7's required watchlist payload was dead code. It opens here.
   */
  const [rowMenu, setRowMenu] = useState<
    | null
    | { at: { x: number; y: number }; symbol: string; entries: MenuEntry[] }
  >(null);

  const reload = async (selectId?: string) => {
    const rows = await api.listWatchlists();
    setLists(rows);
    const stored = typeof window !== "undefined" ? localStorage.getItem(ACTIVE_KEY) : null;
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
          // First run on this database. Import the browser's old lists if any,
          // otherwise seed one list from the tracked symbols.
          let seeded = false;
          try {
            const raw = localStorage.getItem(LEGACY_KEY);
            const legacy = raw ? (JSON.parse(raw) as { lists?: NamedWatchlist[] }) : null;
            for (const [i, l] of (legacy?.lists ?? []).entries()) {
              if (!l?.name) continue;
              await api.upsertWatchlist({ name: l.name, symbols: l.symbols ?? [], position: i });
              seeded = true;
            }
            if (seeded) localStorage.setItem(`${LEGACY_KEY}.migrated`, raw ?? "");
          } catch { /* malformed legacy data — fall through to the default */ }
          if (!seeded) {
            await api.upsertWatchlist({
              name: "Main Watchlist", symbols: symbols.map((s) => s.symbol), position: 0,
            });
          }
          rows = await api.listWatchlists();
        }
        setLists(rows);
        const stored = localStorage.getItem(ACTIVE_KEY);
        const pick = rows.find((l) => l.id === stored) ?? rows[0] ?? null;
        setActiveId(pick?.id ?? null);
      } catch (e) {
        setErr((e as Error).message);
        setLists([]);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // once on mount; the server is the source of truth afterwards

  useEffect(() => {
    if (activeId && typeof window !== "undefined") localStorage.setItem(ACTIVE_KEY, activeId);
  }, [activeId]);

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
    const bySymbol = new Map(symbols.map((s) => [s.symbol, s]));
    return active.symbols.map((s) => {
      const existing = bySymbol.get(s);
      if (existing) return existing;
      const parts = canonicalDisplayParts(s);
      return parts ? {
        symbol: s, baseAsset: parts.base, quoteAsset: parts.quote,
        priceTick: null, qtyStep: null, minNotional: null, isActive: true,
        venue: parts.venue, assetClass: "crypto_spot" as const,
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
      .catch((e: Error) => setErr(e.message));
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

  /** The row being dragged, in the manual order. Null when nothing is. */
  const [dragging, setDragging] = useState<string | null>(null);

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
    : issues.length > 0 ? { label: "partial outage", tone: "text-down", detail: issues.join(" ") }
    : visibleSymbolNames.some((name) => tickers[name]?.stale)
      ? { label: "stale", tone: "text-warn", detail: "One or more provider quotes are older than the venue freshness limit." }
    : stream.status === "live" ? { label: "live", tone: "text-up", detail: streamWords.detail }
    : stream.status === "connecting" || stream.status === "open"
      ? { label: stream.status === "open" ? "connected — waiting for data" : "connecting…", tone: "text-ink-faint", detail: streamWords.detail }
    : stream.status === "stale"
      ? { label: "stalled", tone: "text-down", detail: streamWords.detail }
    : { label: "not streaming", tone: "text-warn", detail: `${streamWords.detail} Prices shown are retained REST quotes and refresh every 15 seconds.` };

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
          resolved.push(s); continue;
        }
        const found = await api.searchMarket(s, "", "", 20);
        const exact = found.results.filter((row) => row.providerSymbol?.toUpperCase() === s || row.symbol.toUpperCase() === s);
        if (exact.length !== 1 || !exact[0]?.canonicalId) {
          throw new Error(exact.length > 1 ? `“${s}” exists on multiple venues; choose it from Symbol search.` : `No exact spot instrument matches “${s}”.`);
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
    } catch (e) { setErr((e as Error).message); }
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
    const name = window.prompt("New watchlist name", "New Watchlist")?.trim();
    if (!name || !lists) return;
    setMenuOpen(false);
    try {
      const created = await api.upsertWatchlist({ name, symbols: [], position: lists.length });
      await reload(created.id);
    } catch (e) { setErr((e as Error).message); }
  };
  const renameList = () => {
    if (!active) return;
    const name = window.prompt("Rename watchlist", active.name)?.trim();
    if (name) updateActive((l) => ({ ...l, name }));
    setMenuOpen(false);
  };
  const deleteList = async () => {
    if (!lists || !active || lists.length === 1) return;
    if (!window.confirm(`Delete “${active.name}”?`)) return;
    setMenuOpen(false);
    try {
      await api.deleteWatchlist(active.id);
      await reload(lists.find((l) => l.id !== active.id)?.id);
    } catch (e) { setErr((e as Error).message); }
  };

  const px = (n: number) => {
    const abs = Math.abs(n), d = abs >= 1000 ? 1 : abs >= 100 ? 2 : abs >= 1 ? 3 : abs >= .01 ? 5 : 7;
    return n.toLocaleString(undefined, { maximumFractionDigits: d });
  };

  return (
    <aside className="flex h-full w-[85vw] max-w-[294px] shrink-0 flex-col border-l border-border bg-surface md:w-[294px]">
      {/*
        FC2-L3: one header row, not three.

        The list name, the feed state, the add control and the count used to
        stack 139px deep before the first symbol, against TradingView's 118px —
        roughly one symbol's worth of a list whose whole job is showing
        symbols. The feed dot is now IN the title row (it is a two-state dot,
        not a sentence, and its sentence is still in the tooltip and still
        announced), and adding a symbol is an icon that opens the field rather
        than a permanently reserved row.
      */}
      <div className="relative border-b border-border px-2 py-1.5">
        <div className="flex items-center gap-0.5">
          <button onClick={() => setMenuOpen((v) => !v)} className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1.5 py-1 text-left hover:bg-surface-2">
            {priceState && (
              <span
                role="status"
                aria-live="polite"
                title={priceState.detail}
                className={`shrink-0 text-[9px] leading-none ${priceState.tone}`}
              >
                <span aria-hidden="true">●</span>
                <span className="sr-only">Prices {priceState.label}</span>
              </span>
            )}
            <span className="truncate text-sm font-semibold">{active?.name ?? "Watchlist"}</span>
            <span className="ml-auto pl-1 text-[10px] text-ink-faint">▼</span>
          </button>
          <button
            onClick={() => setAddOpen((v) => !v)}
            aria-expanded={addOpen}
            title="Add a symbol to this list"
            aria-label="Add a symbol to this list"
            className="flex h-7 w-7 items-center justify-center rounded text-ink-muted hover:bg-surface-2 hover:text-ink"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
          <button onClick={() => void createList()} title="Create watchlist" aria-label="Create watchlist"
            className="flex h-7 w-7 items-center justify-center rounded text-ink-muted hover:bg-surface-2 hover:text-ink">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <path d="M4 6h10M4 12h7M4 18h7" /><path d="M17 10v8M13 14h8" />
            </svg>
          </button>
          <span className="w-6 shrink-0 text-right text-[11px] text-ink-faint">{visibleSymbols.length}</span>
        </div>
        {menuOpen && lists && (
          <div className="absolute left-2 right-2 top-[44px] z-50 rounded-md border border-border bg-surface py-1 shadow-xl">
            <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-ink-faint">My watchlists</div>
            {lists.map((l) => (
              <button key={l.id} onClick={() => { setActiveId(l.id); setMenuOpen(false); }} className={`flex w-full justify-between px-3 py-2 text-left text-xs hover:bg-surface-2 ${l.id === activeId ? "text-accent" : "text-ink"}`}>
                <span className="truncate">{l.name}</span><span className="text-ink-faint">{l.symbols.length}</span>
              </button>
            ))}
            <div className="my-1 border-t border-border" />
            <button onClick={() => void createList()} className="w-full px-3 py-1.5 text-left text-xs hover:bg-surface-2">＋ Create new</button>
            <button onClick={renameList} className="w-full px-3 py-1.5 text-left text-xs hover:bg-surface-2">Rename current</button>
            <button disabled={lists.length === 1} onClick={() => void deleteList()} className="w-full px-3 py-1.5 text-left text-xs text-down hover:bg-surface-2 disabled:opacity-30">Delete current</button>
          </div>
        )}
      </div>
      {addOpen && (
        <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
          {/* A placeholder is not an accessible name, and it disappears as soon
              as the field is typed into. Measured in a browser: this was the one
              control on the chart with no name at all. */}
          <input autoFocus value={adding} onChange={(e) => setAdding(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void add();
              if (e.key === "Escape") { setAdding(""); setAddOpen(false); }
            }}
            aria-label="Add a symbol to this watchlist" placeholder="Symbol, e.g. BTCUSDT"
            className="w-full rounded-sm border border-border bg-bg px-1.5 py-1 text-[13px] text-ink outline-none placeholder:text-ink-faint focus:border-accent" />
          <button onClick={add} disabled={!adding}
            className="rounded-sm bg-accent px-2 py-1 text-[13px] font-medium text-white disabled:opacity-40">Add</button>
        </div>
      )}
      {err && <div className="px-3 py-1.5 text-xs text-down">{err}</div>}
      {/*
        Column headers that sort. A third click returns to the user's own
        order, so a sort is never a one-way door out of an arrangement they
        spent time on.
      */}
      <div className="grid grid-cols-[1fr_auto_auto_18px] gap-x-2 border-b border-border px-3 py-1 text-[11px] text-ink-faint">
        {([["symbol", "Symbol", ""], ["last", "Last", ""],
           ["change", "Chg%", "w-[64px] text-right"]] as [SortColumn, string, string][])
          .map(([column, label, extra]) => (
            <button
              key={column}
              onClick={() => setSort((current) => nextSort(current, column))}
              aria-label={sort.column === column
                ? `Sorted by ${label}, ${sort.direction === "asc" ? "ascending" : "descending"}. Click to change.`
                : `Sort by ${label}`}
              className={`${extra} text-left hover:text-ink ${
                sort.column === column ? "font-semibold text-ink" : ""
              }`}
            >
              {label}
              {sort.column === column && (
                <span aria-hidden="true">{sort.direction === "asc" ? " ↑" : " ↓"}</span>
              )}
            </button>
          ))}
        <span />
      </div>
      {reorderRefusal(sort) && (
        <div className="px-3 py-1 text-[10px] text-ink-faint">{reorderRefusal(sort)}</div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {visibleSymbols.length === 0 && (
          <div className="px-4 py-6">
            <p className="text-xs font-medium text-ink">Nothing on this list yet</p>
            <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
              Type an exact spot symbol in the field above, or start from the Binance
              most liquid ones.
            </p>
            <div className="mt-3 flex flex-wrap gap-1">
              {STARTER_SYMBOLS.map((s) => (
                <button
                  key={s}
                  onClick={() => void addSymbols([s])}
                  aria-label={`Add ${s} to this watchlist`}
                  className="rounded border border-border px-1.5 py-0.5 text-[11px] text-ink-muted transition-colors hover:border-accent hover:text-ink"
                >
                  {s.replace(/USDT$/, "")}
                </button>
              ))}
            </div>
            <button
              onClick={() => void addSymbols(STARTER_SYMBOLS)}
              className="mt-3 w-full rounded bg-accent px-2 py-1.5 text-[11px] font-semibold text-white transition-colors hover:bg-accent/90"
            >
              Add all eight
            </button>
            <p className="mt-2 text-[10px] leading-relaxed text-ink-faint">
              A starting point, not a recommendation — a watchlist row moves no
              strategy, alert or order.
            </p>
          </div>
        )}
        {visibleSymbols.map((s) => {
          const selectedRow = s.symbol === selected;
          const t = selectedRow && replayQuote ? replayQuote : tickers[s.symbol];
          const up = t ? t.chgPct >= 0 : true;
          return <div key={s.symbol}
            draggable={canReorder(sort)}
            onDragStart={(e) => {
              if (!canReorder(sort)) return;
              setDragging(s.symbol);
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
              setRowMenu({
                at: { x: e.clientX, y: e.clientY },
                symbol: s.symbol,
                entries: watchlistMenu({
                  symbol: s.symbol, replayActive, canOpenNewPane,
                }),
              });
            }}
            /*
              FC2-M1: 29px rows with a hairline, at 14px.

              They were 33.5px at 13px with `border-bottom: 0` — 14% taller
              than TradingView's, showing two fewer symbols per screen, in
              smaller type, with nothing ruling one row off from the next. All
              three pulled the same way: the list read as looser and less
              scannable than the reference while occupying the same width.
            */
            className={`group grid h-[29px] grid-cols-[1fr_auto_auto_18px] items-center gap-x-2 border-b border-border px-3 text-sm tabular ${selectedRow ? "bg-surface-2 shadow-[inset_2px_0_0_0_rgb(var(--ts-accent-rgb))]" : "hover:bg-surface-2"}`}>
            <button onClick={() => onSelect(s.symbol)} className="contents text-left">
              <span className="truncate font-medium text-ink" title={displaySymbol(s.symbol)}>
                {s.baseAsset}<span className="text-ink-faint">/{s.quoteAsset}</span>
                {isCanonicalInstrumentId(s.symbol) && <span className="ml-1 text-[9px] font-normal text-ink-faint">· {s.venue}</span>}
              </span>
              <span className={`text-right ${t ? (t.stale ? "text-warn" : up ? "text-up" : "text-down") : "text-ink-faint"}`}
                title={selectedRow && replayQuote ? "Replay price at the current historical horizon" : undefined}>
                {t ? px(t.last) : "—"}
              </span>
              <span className={`w-[64px] text-right ${t && t.changeKnown !== false ? (up ? "text-up" : "text-down") : "text-ink-faint"}`}>{t && t.changeKnown !== false ? `${up ? "+" : ""}${t.chgPct.toFixed(2)}%` : "—"}</span>
            </button>
            <button title="Remove from watchlist" onClick={() => updateActive((l) => ({ ...l, symbols: l.symbols.filter((x) => x !== s.symbol) }))} className="invisible text-ink-faint hover:text-down group-hover:visible">×</button>
          </div>;
        })}
      </div>
      <ContextMenu
        at={rowMenu?.at ?? null}
        label={rowMenu?.symbol ?? ""}
        entries={rowMenu?.entries ?? []}
        onClose={() => setRowMenu(null)}
        onSelect={(id) => {
          const symbol = rowMenu?.symbol;
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
    </aside>
  );
}
