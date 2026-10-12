"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type SymbolSearchResult } from "@/lib/api";
import { shortReason } from "@/lib/errorCopy";
import {
  moveCursor, NO_INTENT, pressEnter, queryChanged, rankSearchResults, responseArrived,
  rowAtCursor, SEARCH_VENUE, type SearchIntent,
} from "@/lib/symbolSearch";
import { SymbolResultLine } from "@/components/tv/SymbolSearch";

/** How many rows the box offers. Eight 40px rows is the panel's own height budget. */
export const ADD_BOX_ROWS = 8;
const DEBOUNCE_MS = 150;

const keyOf = (term: string): string => term.trim().toUpperCase();

/**
 * The watchlist's `+` field: type, see what it resolves to, pick one.
 *
 * C-06. This was a bare input whose Enter added the TEXT. "eth" was looked up
 * by exact listing code, and the one venue whose code is literally `ETH` —
 * Hyperliquid's perpetual — became the row "ETHUSD.P PERP — — —", with no
 * quotes. Now nothing is ever added that the user did not see as a resolved
 * instrument: Enter takes the highlighted row, arrows move it, Escape closes,
 * and a query with no answer adds nothing.
 *
 * The rows, their ranking and the Enter arbitration are the symbol dialog's
 * own (`SymbolResultLine`, `rankSearchResults`, `pressEnter`/`responseArrived`),
 * so "eth" lands on Binance `ETHUSDT` here exactly as it does on the chart,
 * and an Enter pressed before the answer arrives waits for it rather than
 * taking rows that answer the previous keystroke.
 */
export function WatchlistAddBox({ onAdd, onClose, inList }: {
  /** Add the chosen instrument. Resolves true when it was added. */
  onAdd: (row: SymbolSearchResult) => Promise<boolean>;
  onClose: () => void;
  inList?: (row: SymbolSearchResult) => boolean;
}) {
  const [term, setTerm] = useState("");
  const [rows, setRows] = useState<SymbolSearchResult[]>([]);
  const [venues, setVenues] = useState<{ id: string; label: string }[]>([]);
  const [cursor, setCursor] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const intent = useRef<SearchIntent>(NO_INTENT);
  const reqId = useRef(0);
  const flush = useRef<(() => void) | null>(null);
  const live = useRef(true);
  // Set on mount, not only at construction: StrictMode (on in dev) mounts,
  // cleans up and mounts again, and a flag only ever cleared left every
  // search answer discarded and the box on "Searching…" for good.
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);

  const choose = useCallback(async (row: SymbolSearchResult) => {
    const added = await onAdd(row);
    if (added && live.current) onClose();
  }, [onAdd, onClose]);
  const chooseRef = useRef(choose);
  chooseRef.current = choose;

  useEffect(() => {
    intent.current = queryChanged(intent.current);
    const id = ++reqId.current;
    const key = keyOf(term);
    if (key.length === 0) {
      setRows([]); setCursor(-1); setBusy(false); setErr(null);
      intent.current = NO_INTENT;
      flush.current = null;
      return;
    }
    setBusy(true);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const run = () => {
      timer = null;
      flush.current = null;
      api.searchMarket(term.trim(), "", "", 40)
        .then((res) => {
          if (reqId.current !== id || !live.current) return;
          const ranked = rankSearchResults(res.results, term).slice(0, ADD_BOX_ROWS);
          setRows(ranked);
          setVenues(res.venues ?? []);
          setCursor(ranked.length > 0 ? 0 : -1);
          setErr(null);
          const settled = responseArrived(intent.current, key, true);
          intent.current = settled.intent;
          const top = ranked[0];
          if (settled.action === "select-top" && top) void chooseRef.current(top);
        })
        .catch((e) => {
          if (reqId.current !== id || !live.current) return;
          // Rows that answered an earlier query are not an answer to this one.
          setRows([]);
          setCursor(-1);
          intent.current = responseArrived(intent.current, key, false).intent;
          setErr((e as Error).message);
        })
        .finally(() => { if (reqId.current === id && live.current) setBusy(false); });
    };
    timer = setTimeout(run, DEBOUNCE_MS);
    flush.current = () => {
      if (timer === null) return;
      clearTimeout(timer);
      run();
    };
    return () => { if (timer !== null) clearTimeout(timer); };
  }, [term]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      // R7b-06: closes the FIELD. The panel's window-level Escape handler
      // took the whole column with it.
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => moveCursor(c, e.key === "ArrowDown" ? 1 : -1, rows.length));
      return;
    }
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (keyOf(term).length === 0) return;
    const decision = pressEnter(intent.current, keyOf(term));
    intent.current = decision.intent;
    if (decision.action === "flush") {
      // The rows on screen answer an earlier keystroke, or nothing yet. Ask
      // now, and take the top answer when it lands.
      flush.current?.();
      return;
    }
    const row = rowAtCursor(rows, cursor);
    // No row, no add: free text is never stored as a symbol.
    if (row) void choose(row);
  };

  const listId = "watchlist-add-results";
  const showList = keyOf(term).length > 0;
  return (
    <div className="mx-2 mb-1 shrink-0">
      {/*
        R7-12: a 34px search row, not a form. The field's focus is the
        wrapper's border going to the strong neutral (R7b-15), never the
        accent ring.
      */}
      <div className="flex h-[34px] items-center gap-1.5 rounded-md border border-control-border px-2 focus-within:border-[color:var(--ts-control-border-strong)]">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
          aria-hidden="true" className="shrink-0 text-ink-faint">
          <circle cx="11" cy="11" r="6.5" /><path d="M16 16l4.5 4.5" />
        </svg>
        <input autoFocus value={term} onChange={(e) => setTerm(e.target.value)}
          onKeyDown={onKeyDown}
          aria-label="Add a symbol to this watchlist" placeholder="Symbol, e.g. BTCUSDT"
          aria-autocomplete="list"
          aria-controls={showList ? listId : undefined}
          aria-activedescendant={showList && cursor >= 0 && rows[cursor] ? `${listId}-${cursor}` : undefined}
          className="w-full bg-transparent text-[14px] text-ink outline-none focus-visible:outline-none placeholder:text-ink-faint" />
      </div>
      {showList && (
        <div id={listId} role="listbox" aria-label="Matching instruments"
          className="mt-1 overflow-hidden rounded-md border border-border bg-surface shadow-lg">
          {rows.map((row, i) => {
            const venueLabel = venues.find((v) => v.id === row.venueId)?.label ?? row.venueId ?? SEARCH_VENUE;
            return (
              <div
                key={row.canonicalId ?? `${row.venueId ?? ""}:${row.symbol}`}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === cursor}
                data-add-result={row.canonicalId ?? row.symbol}
                // Keep focus in the field, so typing continues after a hover.
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setCursor(i)}
                onClick={() => void choose(row)}
                className="cursor-pointer"
              >
                <SymbolResultLine row={row} venueLabel={venueLabel} term={term}
                  highlighted={i === cursor} inList={inList?.(row) ?? false} />
              </div>
            );
          })}
          {rows.length === 0 && (
            <div className="flex h-10 items-center px-3 text-[13px] text-ink-faint" role="status"
              title={err ?? undefined}>
              {err !== null
                ? `Symbol search is unavailable. ${shortReason(err)} Nothing was added.`
                : busy ? "Searching…" : `No market instrument matches “${term.trim()}”`}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
