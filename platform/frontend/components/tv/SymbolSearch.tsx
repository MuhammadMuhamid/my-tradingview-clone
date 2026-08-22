"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type SymbolSearchResult } from "@/lib/api";

/**
 * TradingView-style symbol search dialog. Searches every Binance spot pair
 * (not just locally tracked ones); picking an untracked pair registers it
 * first so the chart can immediately backfill candles for it.
 *
 * The chip row filters by quote asset — the meaningful axis here, since this
 * platform is Binance-spot only and has no stocks/forex/futures feeds.
 */
export function SymbolSearch({ open, current, onClose, onSelect, onSymbolAdded }: {
  open: boolean;
  current: string;
  onClose: () => void;
  onSelect: (symbol: string) => void;
  /** a new pair was registered locally — refresh the caller's symbol list */
  onSymbolAdded?: () => void;
}) {
  const [term, setTerm] = useState("");
  const [quote, setQuote] = useState("USDT");
  const [quotes, setQuotes] = useState<string[]>(["USDT"]);
  const [rows, setRows] = useState<SymbolSearchResult[]>([]);
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const reqId = useRef(0);

  // Fresh dialog every time it opens, pre-seeded with the current symbol so
  // Enter re-selects it and typing replaces it (the selection is highlighted).
  useEffect(() => {
    if (!open) return;
    setTerm(current);
    setCursor(0);
    setErr(null);
    const t = setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
    return () => clearTimeout(t);
  }, [open, current]);

  // Debounced search; out-of-order responses are dropped by request id.
  useEffect(() => {
    if (!open) return;
    const id = ++reqId.current;
    setBusy(true);
    const t = setTimeout(() => {
      api.searchSymbols(term, quote === "ALL" ? "" : quote, 60)
        .then((res) => {
          if (reqId.current !== id) return;
          setRows(res.results);
          setTotal(res.total);
          setQuotes(res.quotes);
          setCursor(0);
          setErr(null);
        })
        .catch((e) => { if (reqId.current === id) setErr((e as Error).message); })
        .finally(() => { if (reqId.current === id) setBusy(false); });
    }, 180);
    return () => clearTimeout(t);
  }, [open, term, quote]);

  const choose = useCallback(async (row: SymbolSearchResult) => {
    try {
      if (!row.tracked) {
        await api.addSymbol(row.symbol, row.baseAsset, row.quoteAsset);
        onSymbolAdded?.();
      }
      onSelect(row.symbol);
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [onSelect, onClose, onSymbolAdded]);

  // Keyboard navigation, TV-style: ↑/↓ move, Enter picks, Esc closes.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setCursor((c) => {
          const next = e.key === "ArrowDown" ? c + 1 : c - 1;
          return Math.max(0, Math.min(rows.length - 1, next));
        });
      }
      if (e.key === "Enter") {
        const row = rows[cursor];
        if (row) { e.preventDefault(); void choose(row); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, rows, cursor, choose, onClose]);

  // Keep the highlighted row inside the scroll viewport.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${cursor}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center bg-black/60 p-4 pt-[6vh]">
      <button aria-label="Close" className="absolute inset-0 cursor-default" onClick={onClose} />
      <div
        role="dialog"
        aria-label="Symbol search"
        className="relative flex max-h-[80vh] w-full max-w-[860px] flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-2xl"
      >
        <div className="flex items-center justify-between px-6 pb-2 pt-5">
          <h2 className="text-xl font-semibold text-ink">Symbol search</h2>
          <button onClick={onClose} className="rounded p-1 text-ink-muted hover:bg-surface-2 hover:text-ink" title="Close">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        {/* search box */}
        <div className="px-6">
          <div className="flex items-center gap-3 rounded-lg border border-border bg-surface-2 px-3 py-2.5 focus-within:border-accent">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="shrink-0 text-ink-faint">
              <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" />
            </svg>
            <input
              ref={inputRef}
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              placeholder="Search — e.g. ZEC, SOLUSDT, BTC"
              className="w-full bg-transparent text-base text-ink outline-none placeholder:text-ink-faint"
            />
            {term && (
              <button onClick={() => { setTerm(""); inputRef.current?.focus(); }} title="Clear"
                className="shrink-0 rounded-full p-0.5 text-ink-faint hover:bg-surface hover:text-ink">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <circle cx="12" cy="12" r="9" /><path d="M9 9l6 6M15 9l-6 6" />
                </svg>
              </button>
            )}
          </div>
        </div>

        {/* quote-asset chips */}
        <div className="flex flex-wrap gap-2 px-6 py-3">
          {["ALL", ...quotes].map((q) => (
            <button
              key={q}
              onClick={() => setQuote(q)}
              className={`rounded-full px-4 py-1.5 text-sm transition-colors ${
                quote === q ? "bg-ink text-bg font-medium" : "bg-surface-2 text-ink-muted hover:text-ink"
              }`}
            >
              {q === "ALL" ? "All" : q}
            </button>
          ))}
        </div>

        {err && <div className="px-6 pb-2 text-sm text-down">{err}</div>}

        {/* results */}
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto border-t border-border">
          {rows.length === 0 && !busy && (
            <div className="px-6 py-12 text-center text-sm text-ink-faint">
              No Binance spot pair matches “{term}”.
            </div>
          )}
          {rows.map((r, i) => (
            <button
              key={r.symbol}
              data-idx={i}
              onMouseEnter={() => setCursor(i)}
              onClick={() => void choose(r)}
              className={`flex w-full items-center gap-4 border-b border-border/60 px-6 py-3 text-left ${
                i === cursor ? "bg-surface-2" : "hover:bg-surface-2/50"
              }`}
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-xs font-bold text-ink-muted">
                {r.baseAsset.slice(0, 3)}
              </span>
              <span className="w-[150px] shrink-0 truncate font-semibold text-accent">{r.symbol}</span>
              <span className="min-w-0 flex-1 truncate text-sm text-ink-muted">
                {r.baseAsset} / {r.quoteAsset}
              </span>
              {r.symbol === current && (
                <span className="shrink-0 rounded bg-accent/15 px-2 py-0.5 text-[11px] font-medium text-accent">current</span>
              )}
              {!r.tracked && (
                <span className="shrink-0 rounded bg-surface-2 px-2 py-0.5 text-[11px] text-ink-faint">add</span>
              )}
              <span className="shrink-0 text-xs text-ink-faint">spot crypto</span>
              <span className="shrink-0 text-sm font-medium text-ink-muted">Binance</span>
            </button>
          ))}
        </div>

        <div className="flex items-center justify-between border-t border-border px-6 py-2 text-[11px] text-ink-faint">
          <span>{busy ? "Searching…" : `${rows.length} of ${total} matching pairs`}</span>
          <span>↑↓ navigate · Enter select · Esc close</span>
        </div>
      </div>
    </div>
  );
}
