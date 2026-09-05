"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type SymbolSearchResult } from "@/lib/api";
import {
  ALL_QUOTES, SEARCH_MARKET, SEARCH_VENUE, moveCursor, quoteFilters, rowAtCursor,
  searchKey, searchSummary,
} from "@/lib/symbolSearch";

/**
 * The symbol dialog.
 *
 * ── Spot, and only spot ────────────────────────────────────────────────────
 *
 * Every row here is a Binance SPOT pair, because that is the only feed this
 * installation has. There are no stocks, no futures, no forex and no options,
 * so there are no filter chips for them: a chip that returns nothing is not a
 * filter, it is a claim about what the product trades. The only axis that
 * exists is the quote asset, and the venue and market are stated in the header
 * rather than left to be inferred from the tickers.
 *
 * ── Which chart it changes ─────────────────────────────────────────────────
 *
 * The dialog is opened FOR a pane — the focused one from the toolbar, or a
 * specific one from its own header — and the caller holds that pane id for as
 * long as the dialog is open. This component never resolves "the active pane"
 * itself, so clicking another chart while the dialog is open cannot silently
 * move where the selection lands. It says which chart it is about, in the
 * header, so that is visible rather than merely true.
 *
 * ── Keyboard ───────────────────────────────────────────────────────────────
 *
 * ↑/↓ move, Enter picks, Esc closes, Tab stays inside the panel. The cursor is
 * `-1` when nothing matched — clamping to 0 against an empty list left a
 * highlight pointing at a row that was not there.
 *
 * ── Enter cannot select a previous query's results ─────────────────────────
 *
 * Typing or pasting a ticker and hitting Enter immediately is the fastest way
 * to change symbol, and it was wrong. The search is debounced by 180 ms, so at
 * the moment Enter arrives `rows` still hold the answer to whatever was in the
 * box before — the dialog opens seeded with the CURRENT symbol, so pasting
 * "SOLUSDT" and pressing Enter re-selected BTCUSDT and looked like nothing had
 * happened.
 *
 * The rows now carry the query they answer (`rowsKey`). Enter against rows that
 * do not answer the current input does not guess and does not select: it
 * FLUSHES the pending debounce so the request goes out at once, and arms a
 * one-shot intent that the arriving results honour. The debounce timer is
 * cleared by the flush, so this issues one request rather than two, and an
 * intent is dropped the moment the user types again or closes the dialog.
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
  const [quote, setQuote] = useState(ALL_QUOTES);
  const [quotes, setQuotes] = useState<string[]>([]);
  const [rows, setRows] = useState<SymbolSearchResult[]>([]);
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  /** Whatever had focus before the dialog opened, so it can be given back. */
  const restoreTo = useRef<HTMLElement | null>(null);
  const reqId = useRef(0);
  /**
   * Which query `rows` answer. Compared against the live input before Enter is
   * allowed to select anything — see the module header.
   */
  const [rowsKey, setRowsKey] = useState<string | null>(null);
  /** Set when Enter arrived before its results did; consumed by the next answer. */
  const pendingEnter = useRef(false);
  /** Runs the debounced search immediately, cancelling the timer. */
  const flushSearch = useRef<(() => void) | null>(null);

  // Fresh dialog every time it opens, pre-seeded with the current symbol so
  // Enter re-selects it and typing replaces it (the selection is highlighted).
  useEffect(() => {
    if (!open) return;
    setTerm(current);
    setQuote(ALL_QUOTES);
    setCursor(0);
    setErr(null);
    // A dialog that has just opened answers nothing yet; its rows are last
    // session's, and Enter must not treat them as this session's answer.
    setRowsKey(null);
    pendingEnter.current = false;
    restoreTo.current = typeof document === "undefined"
      ? null : (document.activeElement as HTMLElement | null);
    const t = setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
    return () => {
      clearTimeout(t);
      // Returning focus matters here: the trigger is a toolbar button a
      // keyboard user was on, and dropping to <body> restarts their tab order
      // at the top of the page.
      const target = restoreTo.current;
      if (target?.isConnected) target.focus();
    };
  }, [open, current]);

  // Debounced search; out-of-order responses are dropped by request id.
  useEffect(() => {
    if (!open) return;
    const key = searchKey(term, quote);
    const id = ++reqId.current;
    setBusy(true);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const run = () => {
      timer = null;
      api.searchSymbols(term, quote === ALL_QUOTES ? "" : quote, 60)
        .then((res) => {
          if (reqId.current !== id) return;
          setRows(res.results);
          setTotal(res.total);
          setQuotes(res.quotes);
          setCursor(res.results.length > 0 ? 0 : -1);
          setRowsKey(key);
          setErr(null);
          // Enter was pressed while this query was still in flight. It meant
          // "take the best match for what I typed", and this is that answer.
          if (pendingEnter.current) {
            pendingEnter.current = false;
            const row = res.results[0];
            if (row) void chooseRef.current(row);
          }
        })
        .catch((e) => {
          if (reqId.current !== id) return;
          // A failed search must not leave the previous instrument list on
          // screen under an error: those rows are no longer an answer to what
          // was typed, and picking one would look like a successful search.
          setRows([]);
          setTotal(0);
          setCursor(-1);
          setRowsKey(key);
          pendingEnter.current = false;
          setErr((e as Error).message);
        })
        .finally(() => { if (reqId.current === id) setBusy(false); });
    };
    timer = setTimeout(run, 180);
    // Enter may need this query NOW rather than in 180 ms. Flushing cancels
    // the timer first, so the impatient path costs one request, not two.
    flushSearch.current = () => {
      if (timer === null) return;
      clearTimeout(timer);
      run();
    };
    return () => {
      if (timer !== null) clearTimeout(timer);
      flushSearch.current = null;
    };
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

  /*
   * The search effect must be able to complete a pending Enter, but must not
   * re-run — and re-issue its request — every time `choose` is rebuilt. A ref
   * gives it the current implementation without becoming a dependency.
   */
  const chooseRef = useRef(choose);
  chooseRef.current = choose;

  // Keyboard navigation: ↑/↓ move, Enter picks, Esc closes, Tab stays inside.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setCursor((c) => moveCursor(c, e.key === "ArrowDown" ? 1 : -1, rows.length));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        // Results that answer a previous query are not an answer to this one.
        // Selecting from them is exactly the defect: see the module header.
        if (rowsKey !== searchKey(term, quote)) {
          pendingEnter.current = true;
          flushSearch.current?.();
          return;
        }
        const row = rowAtCursor(rows, cursor);
        if (row) void choose(row);
        return;
      }
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const items = [...panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )].filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !panel.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, rows, rowsKey, term, quote, cursor, choose, onClose]);

  // Keep the highlighted row inside the scroll viewport.
  useEffect(() => {
    if (cursor < 0) return;
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${cursor}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  if (!open) return null;

  const chips = quoteFilters(quotes);

  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center bg-black/60 p-4 pt-[6vh]">
      <button aria-label="Close" className="absolute inset-0 cursor-default" onClick={onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Symbol search"
        className="relative flex max-h-[80vh] w-full max-w-[860px] flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-2xl"
      >
        <div className="flex items-start justify-between gap-3 px-6 pb-2 pt-5">
          <div className="min-w-0">
            <h2 className="text-xl font-semibold text-ink">Symbol search</h2>
            <p className="mt-0.5 text-xs text-ink-muted">
              {SEARCH_VENUE} {SEARCH_MARKET} pairs. Choosing one replaces the symbol on the chart
              currently showing <span className="font-semibold text-ink">{current}</span>.
            </p>
          </div>
          <button onClick={onClose} className="shrink-0 rounded p-1 text-ink-muted hover:bg-surface-2 hover:text-ink" title="Close" aria-label="Close">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        {/* search box */}
        <div className="px-6">
          <div className="flex items-center gap-3 rounded-lg border border-border bg-surface-2 px-3 py-2.5 focus-within:border-accent">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="shrink-0 text-ink-faint" aria-hidden="true">
              <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" />
            </svg>
            <input
              ref={inputRef}
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              placeholder="Search — e.g. ZEC, SOLUSDT, BTC"
              aria-label={`Search ${SEARCH_VENUE} ${SEARCH_MARKET} pairs`}
              className="w-full bg-transparent text-base text-ink outline-none placeholder:text-ink-faint"
            />
            {term && (
              <button onClick={() => { setTerm(""); inputRef.current?.focus(); }} title="Clear" aria-label="Clear the search"
                className="shrink-0 rounded-full p-0.5 text-ink-faint hover:bg-surface hover:text-ink">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                  <circle cx="12" cy="12" r="9" /><path d="M9 9l6 6M15 9l-6 6" />
                </svg>
              </button>
            )}
          </div>
        </div>

        {/*
          Quote asset is the only real filter axis. There is no asset-class row
          because there is only one asset class — see the module header.
        */}
        <div role="group" aria-label="Filter by quote asset" className="flex flex-wrap gap-2 px-6 py-3">
          {chips.map((q) => (
            <button
              key={q}
              onClick={() => setQuote(q)}
              aria-pressed={quote === q}
              className={`rounded-full px-4 py-1.5 text-sm transition-colors ${
                quote === q ? "bg-ink font-medium text-bg" : "bg-surface-2 text-ink-muted hover:text-ink"
              }`}
            >
              {q === ALL_QUOTES ? "All quotes" : q}
            </button>
          ))}
        </div>

        {/* results */}
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto border-t border-border">
          {err && (
            <div role="alert" className="m-4 rounded-md border border-down/30 bg-down/10 px-4 py-3 text-sm text-down">
              <p className="font-medium">Symbol search is unavailable.</p>
              <p className="mt-0.5 text-[13px] text-down/90">{err}</p>
              <p className="mt-1 text-[13px] text-ink-muted">
                The chart keeps its current symbol. Nothing was changed.
              </p>
            </div>
          )}
          {!err && rows.length === 0 && !busy && (
            <div className="px-6 py-12 text-center text-sm text-ink-faint">
              {term.trim().length === 0
                ? `Type to search every ${SEARCH_VENUE} ${SEARCH_MARKET} pair.`
                : <>No {SEARCH_VENUE} {SEARCH_MARKET} pair matches “{term}”{quote === ALL_QUOTES ? "" : ` in ${quote}`}.</>}
            </div>
          )}
          {rows.map((r, i) => {
            const isCurrent = r.symbol === current;
            return (
              <button
                key={r.symbol}
                data-idx={i}
                onMouseEnter={() => setCursor(i)}
                onClick={() => void choose(r)}
                aria-current={isCurrent ? "true" : undefined}
                className={`flex w-full items-center gap-4 border-b border-border/60 px-6 py-3 text-left ${
                  i === cursor ? "bg-surface-2" : "hover:bg-surface-2/50"
                } ${isCurrent ? "border-l-2 border-l-accent" : "border-l-2 border-l-transparent"}`}
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-xs font-bold text-ink-muted">
                  {r.baseAsset.slice(0, 3)}
                </span>
                <span className="w-[150px] shrink-0 truncate font-semibold text-accent">{r.symbol}</span>
                <span className="min-w-0 flex-1 truncate text-sm text-ink-muted">
                  {r.baseAsset} / {r.quoteAsset}
                </span>
                {isCurrent && (
                  <span className="shrink-0 rounded bg-accent/15 px-2 py-0.5 text-[11px] font-medium text-accent">
                    on this chart
                  </span>
                )}
                {!r.tracked && (
                  <span className="shrink-0 rounded bg-surface-2 px-2 py-0.5 text-[11px] text-ink-faint"
                    title="Not tracked here yet — choosing it registers the pair first">
                    add
                  </span>
                )}
                <span className="shrink-0 text-xs text-ink-faint">{SEARCH_MARKET}</span>
                <span className="shrink-0 text-sm font-medium text-ink-muted">{SEARCH_VENUE}</span>
              </button>
            );
          })}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border px-6 py-2 text-[11px] text-ink-faint">
          <span role="status">{searchSummary({ busy, shown: rows.length, total })}</span>
          <span>↑↓ navigate · Enter select · Esc close</span>
        </div>
      </div>
    </div>
  );
}
