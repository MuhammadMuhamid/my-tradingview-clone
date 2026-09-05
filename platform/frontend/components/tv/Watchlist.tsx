"use client";
import { useEffect, useMemo, useState } from "react";
import type { SymbolInfo } from "@/lib/types";
import { api, type ServerWatchlist } from "@/lib/api";
import { useWatchlistTickers } from "@/lib/useWatchlistTickers";
import { describeStreamState } from "@/lib/marketStream";

interface Ticker { last: number; chg: number; chgPct: number }
type NamedWatchlist = ServerWatchlist;

/**
 * Lists live in the database, not localStorage: the same watchlist has to be
 * there when the app is opened on the phone the MA alerts notify.
 * Only the *selected* list stays device-local.
 */
const LEGACY_KEY = "tv-clone-watchlists-v1";
const ACTIVE_KEY = "tv.watchlist.active.v1";

export function Watchlist({ symbols, selected, onSelect, onSymbolsChanged, replayQuote = null }: {
  symbols: SymbolInfo[];
  selected: string;
  onSelect: (symbol: string) => void;
  onSymbolsChanged: () => void;
  replayQuote?: Ticker | null;
}) {
  const [adding, setAdding] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [lists, setLists] = useState<NamedWatchlist[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

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
  const visibleSymbols = useMemo(() => {
    if (!active) return [];
    const bySymbol = new Map(symbols.map((s) => [s.symbol, s]));
    return active.symbols.map((s) => bySymbol.get(s)).filter((s): s is SymbolInfo => Boolean(s));
  }, [active, symbols]);

  /*
   * Prices: seeded through this app's server, then moved by the shared market
   * stream (origin fallback, reconnect and watchdog included). See
   * `lib/useWatchlistTickers`. The rows are never `—` for want of a socket.
   */
  const visibleSymbolNames = useMemo(() => visibleSymbols.map((s) => s.symbol), [visibleSymbols]);
  const { tickers, stream } = useWatchlistTickers(visibleSymbolNames);
  const streamWords = describeStreamState(stream);
  const anyStreamed = Object.values(tickers).some((t) => t.source === "stream");
  /*
   * The header says what the numbers are. "live" is only claimed once a frame
   * has arrived; a seeded list on a fenced network says so, and says that the
   * quotes are real but not streaming, rather than looking frozen or fake.
   */
  const priceState: { label: string; tone: string; detail: string } | null =
    visibleSymbols.length === 0 ? null
    : stream.status === "live" ? { label: "live", tone: "text-up", detail: streamWords.detail }
    : stream.status === "connecting" || stream.status === "open"
      ? { label: anyStreamed ? "live" : "connecting…", tone: "text-ink-faint", detail: streamWords.detail }
    : stream.status === "stale"
      ? { label: "stalled", tone: "text-down", detail: streamWords.detail }
    : { label: "not streaming", tone: "text-warn", detail: `${streamWords.detail} Prices shown are the exchange's last quotes, refreshed when the list changes.` };

  /**
   * Optimistic local edit, then persist. The list re-renders immediately and
   * the server write follows; a failure surfaces in the error line rather than
   * silently diverging.
   */
  const updateActive = (fn: (list: NamedWatchlist) => NamedWatchlist) => {
    if (!active) return;
    const next = fn(active);
    setLists((prev) => prev?.map((l) => (l.id === next.id ? next : l)) ?? prev);
    api.updateWatchlist(next.id, { name: next.name, symbols: next.symbols })
      .catch((e: Error) => setErr(e.message));
  };

  const add = async () => {
    const s = adding.trim().toUpperCase();
    if (!s) return;
    if (!s.endsWith("USDT")) { setErr("Only *USDT Binance spot pairs"); return; }
    setErr(null);
    try {
      if (!symbols.some((x) => x.symbol === s)) {
        await api.addSymbol(s, s.replace(/USDT$/, ""), "USDT");
        onSymbolsChanged();
      }
      updateActive((l) => ({ ...l, symbols: l.symbols.includes(s) ? l.symbols : [...l.symbols, s] }));
      setAdding("");
    } catch (e) { setErr((e as Error).message); }
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
    <aside className="flex h-full w-[85vw] max-w-[300px] shrink-0 flex-col border-l border-border bg-surface md:w-[300px]">
      <div className="relative border-b border-border px-2 py-2">
        <div className="flex items-center gap-1">
          <button onClick={() => setMenuOpen((v) => !v)} className="flex min-w-0 flex-1 items-center justify-between rounded px-2 py-1.5 text-left hover:bg-surface-2">
            <span className="truncate text-sm font-semibold">{active?.name ?? "Watchlist"}</span>
            <span className="ml-2 text-[10px] text-ink-faint">▼</span>
          </button>
          <button onClick={() => void createList()} title="Create watchlist" className="rounded px-2 py-1 text-lg text-ink-muted hover:bg-surface-2 hover:text-ink">＋</button>
          <span className="w-7 text-right text-xs text-ink-faint">{visibleSymbols.length}</span>
        </div>
        {priceState && (
          <div
            role="status"
            aria-live="polite"
            title={priceState.detail}
            className={`mt-0.5 flex items-center gap-1 px-2 text-[10px] ${priceState.tone}`}
          >
            <span aria-hidden="true">●</span>
            <span className="truncate">Prices {priceState.label}</span>
          </div>
        )}
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
      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
        {/* A placeholder is not an accessible name, and it disappears as soon
            as the field is typed into. Measured in a browser: this was the one
            control on the chart with no name at all. */}
        <input value={adding} onChange={(e) => setAdding(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} aria-label="Add a symbol to this watchlist" placeholder="+ Add symbol to this list…" className="w-full rounded border border-transparent bg-transparent px-1.5 py-1 text-xs text-ink outline-none placeholder:text-ink-faint focus:border-border focus:bg-surface-2" />
        {adding && <button onClick={add} className="rounded bg-accent px-2 py-1 text-xs font-medium text-white">Add</button>}
      </div>
      {err && <div className="px-3 py-1.5 text-xs text-down">{err}</div>}
      <div className="grid grid-cols-[1fr_auto_auto_18px] gap-x-2 border-b border-border px-3 py-1.5 text-[11px] text-ink-faint"><span>Symbol</span><span>Last</span><span className="w-[64px] text-right">Chg%</span><span /></div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {visibleSymbols.length === 0 && <div className="px-4 py-8 text-center text-xs text-ink-faint">This watchlist is empty.<br />Add a USDT pair above.</div>}
        {visibleSymbols.map((s) => {
          const selectedRow = s.symbol === selected;
          const t = selectedRow && replayQuote ? replayQuote : tickers[s.symbol];
          const up = t ? t.chgPct >= 0 : true;
          return <div key={s.symbol} className={`group grid grid-cols-[1fr_auto_auto_18px] items-center gap-x-2 px-3 py-[7px] text-[13px] tabular ${selectedRow ? "bg-surface-2 shadow-[inset_2px_0_0_0_#4f8cff]" : "hover:bg-surface-2/60"}`}>
            <button onClick={() => onSelect(s.symbol)} className="contents text-left">
              <span className="truncate font-medium text-ink">{s.baseAsset}<span className="text-ink-faint">USDT</span></span>
              <span className={`text-right ${t ? (up ? "text-up" : "text-down") : "text-ink-faint"}`}
                title={selectedRow && replayQuote ? "Replay price at the current historical horizon" : undefined}>
                {t ? px(t.last) : "—"}
              </span>
              <span className={`w-[64px] text-right ${t ? (up ? "text-up" : "text-down") : "text-ink-faint"}`}>{t ? `${up ? "+" : ""}${t.chgPct.toFixed(2)}%` : "—"}</span>
            </button>
            <button title="Remove from watchlist" onClick={() => updateActive((l) => ({ ...l, symbols: l.symbols.filter((x) => x !== s.symbol) }))} className="invisible text-ink-faint hover:text-down group-hover:visible">×</button>
          </div>;
        })}
      </div>
    </aside>
  );
}
