"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type SymbolSearchResult } from "@/lib/api";
import { shortReason } from "@/lib/errorCopy";
import { CaretGlyph } from "@/components/ui";
import {
  ALL_QUOTES, ALL_TYPES, ALL_VENUES, ASSET_CLASS_CHIPS, EXPIRY_LABELS, EXPIRY_OPTIONS, LIVE_EXPIRIES,
  NO_INTENT, SEARCH_MARKET, SEARCH_VENUE, TYPE_LABELS, chipById, chipDegradedTitle, chipForInstrument,
  chipTypeDefault, currentFirst, degradedSources, degradedSummary, dialogClosed, matchParts, moveCursor,
  pressEnter, queryChanged, quoteFilters, responseArrived, rowAtCursor, rowDescription, rowTicker,
  rowTitle, rowTypeWords, searchKey, searchSummary, showsExpiry, typeOptionsFor, venueOptions,
  type SearchAssetClass, type SearchExpiry, type SearchInstrumentType, type SearchIntent,
} from "@/lib/symbolSearch";
import { displayTicker, storedSymbol } from "@/lib/instrument";

/**
 * The symbol dialog.
 *
 * Crypto spot and derivatives, U.S. stocks/ETFs, OTC FX, exchange futures and
 * reference indices share search, but never identity. Every row names its
 * product type and venue, and carries settlement, expiry, feed status and
 * tracking state in its `title`; options remain outside this catalog.
 *
 * ── Several asset classes, so the class is the first control ───────────────
 *
 * This header used to say "there is no asset-class row because there is only
 * one asset class". That stopped being true with the traditional-markets
 * work, and the dialog kept the shape it implied: the PRIMARY filter was the
 * quote currency — a 24-chip grid, two rows deep — with venue, product type
 * and expiry stacked below it as three more bands. Six control bands and a
 * diagnostics banner stood between the title and the first result.
 *
 * The order now is the workstation's: box → asset-class chips → one row of
 * borderless dropdowns → rows → footer. Quote, venue, type and expiry all
 * survive with their state and their query untouched; they are behind the
 * dropdown row, which is where a secondary axis belongs. `lib/symbolSearch`
 * holds the chip table and the menus, so what the dialog OFFERS is a
 * testable claim rather than a grep over JSX.
 *
 * ── Which chart it changes ─────────────────────────────────────────────────
 *
 * The dialog is opened FOR a pane — the focused one from the toolbar, or a
 * specific one from its own header — and the caller holds that pane id for as
 * long as the dialog is open. This component never resolves "the active pane"
 * itself, so clicking another chart while the dialog is open cannot silently
 * move where the selection lands. The trigger's own label says which chart it
 * is about, so the dialog does not spend a paragraph repeating it.
 *
 * ── Keyboard ───────────────────────────────────────────────────────────────
 *
 * ↑/↓ move, Enter picks, Esc closes, Tab stays inside the panel. The cursor is
 * `-1` when nothing matched — clamping to 0 against an empty list left a
 * highlight pointing at a row that was not there. While a filter menu is open
 * it takes every key: ↑/↓ move within it, Enter commits, Escape closes THE
 * MENU and leaves the dialog standing.
 *
 * ── Open, then Enter, changes nothing ──────────────────────────────────────
 *
 * The box opens pre-filled with the chart's own ticker, selected, and the
 * chart's own instrument is moved to row 0 under the cursor when the answer
 * contains it. So the fastest possible gesture — open, Enter — re-selects
 * what is already on the chart. It used to pre-fill the BASE asset (`BTC`),
 * land the cursor on row 0 of 162 answers (a Hyperliquid perpetual) and make
 * that same gesture a silent symbol change, on a different venue, with a new
 * pair registered behind it.
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
 * The rows now carry the query they answer. Enter against rows that do not
 * answer the current input does not guess and does not select: it FLUSHES the
 * pending debounce so the request goes out at once, and arms a one-shot intent
 * that the arriving results honour. The debounce timer is cleared by the flush,
 * so this issues one request rather than two.
 *
 * The arbitration itself — including the three ways an armed Enter must be
 * dropped rather than honoured — is `lib/symbolSearch`'s `SearchIntent`, pure
 * and unit-tested against the races directly:
 *
 *   the user typed again      the Enter was about the earlier text;
 *   the user closed the panel a cancelled dialog must not change the chart or
 *                             register a pair behind the user's back;
 *   the response is stale     a superseded query's answer is not an answer.
 *
 * ── Provider limitations, without a banner ─────────────────────────────────
 *
 * Six providers are failing today and the dialog used to open on a 50px amber
 * box listing their ids — `bybit-spot, robinhood-crypto, …` — above the first
 * result. Contract §5 forbids a provider id or a thrown cause as primary copy.
 * The truth is unchanged and is now said three times, quietly: a chip whose
 * only provider is down is disabled with the reason on hover, a source whose
 * venue answered nothing is a disabled menu row, and the footer carries one
 * muted `N sources unavailable` with a popover naming the venues by LABEL.
 */

/** A trigger in the dropdown row, and the menu it opens. */
interface FilterOption { value: string; label: string; disabled?: boolean; suffix?: string; title?: string }
interface FilterMenu {
  id: string; name: string; trigger: string; value: string;
  options: FilterOption[]; pick: (value: string) => void;
}

/*
 * The asset disc.
 *
 * Our own vector, always (OV-K): a 24px disc carrying the base asset's
 * initial, tinted from a small fixed table for the bases a reader recognises
 * by colour and neutral for everything else. The row used to open on a 36×24
 * grey block holding three letters of a ticker that was already printed 8px
 * to its right.
 */
const ASSET_MARKS: Readonly<Record<string, string>> = Object.freeze({
  BTC: "bg-[#f7931a] text-[#0f0f0f]", ETH: "bg-[#627eea] text-[#f2f2f2]", SOL: "bg-[#9945ff] text-[#f2f2f2]",
  USDT: "bg-[#26a17b] text-[#f2f2f2]", USDC: "bg-[#2775ca] text-[#f2f2f2]", BNB: "bg-[#f3ba2f] text-[#0f0f0f]",
  XRP: "bg-[#23292f] text-[#f2f2f2]", ADA: "bg-[#0033ad] text-[#f2f2f2]", DOGE: "bg-[#c2a633] text-[#0f0f0f]",
});

function AssetMark({ asset }: { asset: string }) {
  return (
    <span aria-hidden="true" className={`flex h-6 w-6 items-center justify-center rounded-full text-[11px] ${
      ASSET_MARKS[asset.toUpperCase()] ?? "bg-state-active text-ink"}`}>
      {asset.slice(0, 1)}
    </span>
  );
}

function VenueMark({ label }: { label: string }) {
  return (
    <span aria-hidden="true"
      className="flex h-5 w-5 items-center justify-center rounded-full bg-state-active text-[10px] text-ink-muted">
      {label.slice(0, 1)}
    </span>
  );
}

export function SymbolSearch({ open, current, onClose, onSelect, onSymbolAdded }: {
  open: boolean;
  current: string;
  onClose: () => void;
  onSelect: (symbol: string) => void;
  /** a new pair was registered locally — refresh the caller's symbol list */
  onSymbolAdded?: () => void;
}) {
  const [term, setTerm] = useState("");
  const [chip, setChip] = useState<SearchAssetClass>("all");
  const [quote, setQuote] = useState(ALL_QUOTES);
  const [venue, setVenue] = useState(ALL_VENUES);
  const [type, setType] = useState<SearchInstrumentType>(ALL_TYPES);
  const [expiry, setExpiry] = useState<SearchExpiry>(LIVE_EXPIRIES);
  const [venues, setVenues] = useState<{ id: string; label: string }[]>([]);
  const [quotes, setQuotes] = useState<string[]>([]);
  const [rows, setRows] = useState<SymbolSearchResult[]>([]);
  const [errors, setErrors] = useState<{ providerId: string; error: string }[]>([]);
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /** Which dropdown is open, and where its own cursor sits. */
  const [menu, setMenu] = useState<string | null>(null);
  const [menuCursor, setMenuCursor] = useState(0);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  /** Whatever had focus before the dialog opened, so it can be given back. */
  const restoreTo = useRef<HTMLElement | null>(null);
  const reqId = useRef(0);
  /**
   * Which query the rows answer, and whether an Enter is waiting for one.
   * A ref as well as state: the search effect reads it when a response lands,
   * and must see the value at THAT moment rather than the one captured when
   * the effect ran. `intentVersion` exists only to re-render the key handler.
   */
  const intent = useRef<SearchIntent>(NO_INTENT);
  const [intentVersion, setIntentVersion] = useState(0);
  const bumpIntent = useCallback(() => setIntentVersion((n) => n + 1), []);
  /** Whether the dialog is open, readable from an in-flight promise. */
  const openRef = useRef(open);
  openRef.current = open;
  /** The instrument on the chart, readable from an in-flight promise. */
  const currentRef = useRef(current);
  currentRef.current = current;
  /** Runs the debounced search immediately, cancelling the timer. */
  const flushSearch = useRef<(() => void) | null>(null);
  /** The open menu and its cursor, for the window key handler. */
  const menuRef = useRef<string | null>(null);
  menuRef.current = menu;
  const menuCursorRef = useRef(0);
  menuCursorRef.current = menuCursor;
  const menusRef = useRef<FilterMenu[]>([]);

  // Fresh dialog every time it opens, pre-seeded with the chart's own TICKER
  // so Enter re-selects it and typing replaces it (the selection is
  // highlighted), and on the chip of the chart's own asset class.
  useEffect(() => {
    if (!open) return;
    const chart = chipForInstrument(current);
    setTerm(displayTicker(current));
    setChip(chart);
    setQuote(ALL_QUOTES);
    setVenue(ALL_VENUES);
    setType(chipTypeDefault(chart));
    setExpiry(LIVE_EXPIRIES);
    setCursor(0);
    setErr(null);
    setMenu(null);
    setSourcesOpen(false);
    // A dialog that has just opened answers nothing yet; its rows are last
    // session's, and Enter must not treat them as this session's answer.
    intent.current = NO_INTENT;
    bumpIntent();
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
  }, [open, current, bumpIntent]);

  /*
   * Closing drops the armed Enter AND invalidates every request in flight.
   *
   * The component stays mounted and merely renders null when closed
   * (`ChartDialogs` renders it unconditionally), so without this a request
   * issued by an impatient Enter would still resolve, still pass its own
   * freshness check, and still select a symbol — changing the chart and
   * possibly registering a new pair — after the user had pressed Escape.
   */
  useEffect(() => {
    if (open) return;
    intent.current = dialogClosed();
    reqId.current += 1;
    flushSearch.current = null;
    bumpIntent();
  }, [open, bumpIntent]);

  // Debounced search; out-of-order responses are dropped by request id.
  useEffect(() => {
    if (!open) return;
    // The chip joins the key because it changes the REQUEST (`assetClass`)
    // without changing any of the five axes `searchKey` was written for.
    const key = `${searchKey(term, quote, venue, type, expiry)}|${chip}`;
    // This effect re-runs exactly when the query changed, which is exactly
    // when a waiting Enter stops being about what the user typed.
    intent.current = queryChanged(intent.current);
    const id = ++reqId.current;
    setBusy(true);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const run = () => {
      timer = null;
      api.searchMarket(term, quote === ALL_QUOTES ? "" : quote, venue === ALL_VENUES ? "" : venue, 60, type,
        expiry, "", chipById(chip).query.assetClass ?? "")
        .then((res) => {
          if (reqId.current !== id) return;
          // The chart's own instrument leads the list, so the keyboard cursor
          // opens on it and "open, Enter" is the no-op it looks like.
          const ordered = currentFirst(res.results, currentRef.current);
          setRows(ordered);
          setTotal(res.total);
          setQuotes(res.quotes);
          setVenues(res.venues ?? []);
          setErrors(res.errors ?? []);
          setCursor(ordered.length > 0 ? 0 : -1);
          setErr(null);
          // Enter was pressed while this query was still in flight. It meant
          // "take the best match for what I typed" — honoured only if the
          // dialog is still open.
          const settled = responseArrived(intent.current, key, openRef.current);
          intent.current = settled.intent;
          bumpIntent();
          const row = ordered[0];
          if (settled.action === "select-top" && row) void chooseRef.current(row);
        })
        .catch((e) => {
          if (reqId.current !== id) return;
          // A failed search must not leave the previous instrument list on
          // screen under an error: those rows are no longer an answer to what
          // was typed, and picking one would look like a successful search.
          setRows([]);
          setTotal(0);
          setCursor(-1);
          intent.current = responseArrived(intent.current, key, false).intent;
          bumpIntent();
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
  }, [open, term, quote, venue, type, expiry, chip, bumpIntent]);

  const choose = useCallback(async (row: SymbolSearchResult) => {
    try {
      if (!row.canonicalId && !row.tracked) {
        await api.addSymbol(row.symbol, row.baseAsset, row.quoteAsset);
        onSymbolAdded?.();
      }
      // The one place a chosen symbol leaves this dialog. Reduced through the
      // canonical resolver so the pane, the workspace and every request that
      // follows receive the bare stored ticker — see `lib/instrument`.
      onSelect(row.canonicalId ?? storedSymbol(row.symbol));
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
    /*
     * An open dropdown is modal to the dialog, exactly as the dialog is modal
     * to the chart: it takes every key, and its Escape closes the MENU. A
     * dialog that closed out from under an open menu on one Escape is how a
     * user loses the query they had typed.
     */
    const handleMenuKey = (e: KeyboardEvent, openId: string): void => {
      const key = e.key;
      const model = menusRef.current.find((item) => item.id === openId);
      if (key === "Escape") { e.preventDefault(); e.stopPropagation(); setMenu(null); return; }
      if (key === "ArrowDown" || key === "ArrowUp") {
        e.preventDefault();
        setMenuCursor((c) => moveCursor(c, key === "ArrowDown" ? 1 : -1, model?.options.length ?? 0));
        return;
      }
      if (key === "Enter") {
        e.preventDefault();
        const option = model?.options[menuCursorRef.current];
        if (option && !option.disabled) { model?.pick(option.value); setMenu(null); }
      }
    };
    const onKey = (e: KeyboardEvent) => {
      const openMenuId = menuRef.current;
      if (openMenuId !== null) { handleMenuKey(e, openMenuId); return; }
      if (e.key === "Escape") {
        e.preventDefault();
        intent.current = dialogClosed();
        onClose();
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setCursor((c) => moveCursor(c, e.key === "ArrowDown" ? 1 : -1, rows.length));
        return;
      }
      if (e.key === "Enter") {
        // Results that answer a previous query are not an answer to this one.
        // Selecting from them is exactly the defect: see the module header.
        const decision = pressEnter(intent.current, `${searchKey(term, quote, venue, type, expiry)}|${chip}`);
        intent.current = decision.intent;
        if (decision.action === "flush") {
          // Only now is Enter this dialog's key. Left un-prevented above, a
          // keyboard user on a chip or the Clear button keeps their ordinary
          // Enter-to-activate.
          e.preventDefault();
          bumpIntent();
          flushSearch.current?.();
          return;
        }
        const row = rowAtCursor(rows, cursor);
        if (row) { e.preventDefault(); void choose(row); }
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
    // `intentVersion` is a deliberate re-subscribe trigger, not a value read.
  }, [open, rows, intentVersion, term, quote, venue, type, expiry, chip, cursor, choose, onClose, bumpIntent]);

  /*
   * A pointer anywhere else dismisses an open filter menu, before that click
   * reaches a result row. Without it, a menu left open swallows every key —
   * the dialog's own Enter included — until the trigger is pressed again.
   */
  useEffect(() => {
    if (!open || menu === null) return;
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node | null;
      const inside = target !== null && [...(panelRef.current?.querySelectorAll('[role^="menu"], [aria-haspopup="menu"]') ?? [])]
        .some((el) => el.contains(target));
      if (!inside) setMenu(null);
    };
    window.addEventListener("mousedown", onDown, true);
    return () => window.removeEventListener("mousedown", onDown, true);
  }, [open, menu]);

  // Keep the highlighted row inside the scroll viewport.
  useEffect(() => {
    if (cursor < 0) return;
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${cursor}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  if (!open) return null;

  const down = degradedSources(errors, venues, shortReason);
  const typeChoices = typeOptionsFor(chip);
  const sources = venueOptions({ venues, rows, chip, selected: venue, errors, reason: shortReason });
  const menus: FilterMenu[] = [
    {
      id: "venue", name: "Filter by venue", value: venue,
      trigger: venue === ALL_VENUES ? "All sources" : (sources.find((s) => s.id === venue)?.label ?? venue),
      options: sources.map((s) => ({
        value: s.id, label: s.id === ALL_VENUES ? "All sources" : s.label,
        disabled: s.unavailable, suffix: s.unavailable ? "unavailable" : undefined,
        title: s.title.length > 0 ? s.title : undefined,
      })),
      pick: (value) => setVenue(value),
    },
    {
      id: "type", name: "Filter by instrument type", value: type,
      trigger: type === ALL_TYPES ? "All types" : TYPE_LABELS[type],
      // A chip whose class IS one product type has nothing to choose between,
      // so its slot in the row says the type as text rather than opening a
      // menu with a single row in it.
      options: typeChoices.length > 1 ? typeChoices.map((t) => ({ value: t, label: TYPE_LABELS[t] })) : [],
      pick: (value: string) => setType(value as SearchInstrumentType),
    },
    {
      id: "quote", name: "Filter by quote asset", value: quote,
      trigger: quote === ALL_QUOTES ? "All quote assets" : quote,
      options: quoteFilters(quotes).map((q) => ({ value: q, label: q === ALL_QUOTES ? "All quote assets" : q })),
      pick: (value) => setQuote(value),
    },
    ...(showsExpiry(chip, type) ? [{
      id: "expiry", name: "Filter futures by expiry", value: expiry,
      trigger: EXPIRY_LABELS[expiry],
      options: EXPIRY_OPTIONS.map((x) => ({ value: x, label: EXPIRY_LABELS[x] })),
      pick: (value: string) => setExpiry(value as SearchExpiry),
    }] : []),
  ];
  menusRef.current = menus;
  // TradingView sizes the ticker column to the widest ticker in the answer;
  // a per-row grid cannot align across rows, so the width is a variable the
  // list owns and every row reads.
  const tickerChars = Math.min(24, Math.max(7, ...rows.map((r) => rowTicker(r).length)));

  return (
    <div className="fixed inset-0 z-[70] bg-black/60">
      <button aria-label="Close" className="absolute inset-0 cursor-default" onClick={onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Symbol search"
        aria-describedby="symbol-search-keys"
        /*
          The dialog surface, not a second one, at the reference's own place
          and size: 840×680 at y=110. It used to open 56px higher and 40px
          taller, from `pt-[6vh] max-h-[80vh]`, and every band inside it was
          shrinkable — which is how the venue row ended up 15px tall and
          overprinted by the type row.
        */
        className="absolute left-1/2 top-[110px] flex h-[680px] max-h-[calc(100vh-140px)] w-[840px]
          max-w-[calc(100vw-32px)] -translate-x-1/2 flex-col overflow-hidden rounded-md bg-popover
          shadow-[var(--ts-popover-shadow)] max-sm:top-4 max-sm:h-[calc(100vh-32px)]"
      >
        {/* The keyboard contract, said to a screen reader instead of printed
            in the footer, which the reference spends on one sentence. */}
        <p id="symbol-search-keys" className="sr-only">↑↓ navigate · Enter select · Esc close</p>

        <div className="flex h-[68px] shrink-0 items-center justify-between px-5">
          <h2 className="text-xl font-semibold text-ink">Symbol search</h2>
          {/* Composed rather than `IconButton`, which is fixed at 28×28: the
              reference's close is a 34×34 hit box with a 16px glyph. */}
          <button onClick={onClose} title="Close" aria-label="Close"
            className="tvc-control -mr-2 flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-md text-ink-muted hover:text-ink">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        {/* search box — grey at rest and grey while focused, as the reference
            is; the caret and the selected text are what say where focus is. */}
        <div className="mx-5 flex h-10 shrink-0 items-center gap-2 rounded-md border border-control-border px-3">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="shrink-0 text-ink-faint" aria-hidden="true">
            <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" />
          </svg>
          <input
            ref={inputRef}
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder="Symbol"
            aria-label={`Search ${SEARCH_VENUE} ${SEARCH_MARKET}`}
            className="w-full bg-transparent text-[16px] leading-6 text-ink outline-none placeholder:text-ink-faint"
          />
          {term && (
            <button onClick={() => { setTerm(""); inputRef.current?.focus(); }} title="Clear" aria-label="Clear the search"
              className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-ink-faint text-popover">
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
                <path d="M2 2l6 6M8 2l-6 6" />
              </svg>
            </button>
          )}
        </div>

        {/*
          The asset class: the question a reader actually opens this with.
          Stocks and Funds are rendered and DISABLED while their only provider
          is unavailable — hiding them would make a capability blink out of
          existence with a credential; Bonds, Economy and Options are not here
          because no contract describes them.
        */}
        <div role="group" aria-label="Asset class" className="mt-4 flex h-7 shrink-0 gap-[5px] px-5">
          {ASSET_CLASS_CHIPS.map((item) => {
            const disabledWhy = chipDegradedTitle(item, errors, shortReason);
            return (
              <button
                key={item.id}
                onClick={() => {
                  if (disabledWhy) return;
                  setChip(item.id);
                  setType(chipTypeDefault(item.id));
                  setExpiry(LIVE_EXPIRIES);
                  setMenu(null);
                }}
                aria-pressed={chip === item.id}
                aria-disabled={disabledWhy ? "true" : undefined}
                title={disabledWhy ?? undefined}
                className={`tvc-control h-7 shrink-0 rounded-full px-3 text-sm ${chip === item.id
                  ? "bg-[var(--ts-menu-selected-bg)] text-[var(--ts-menu-selected-ink)]"
                  : "bg-state-hover text-ink"}`}
              >
                {item.label}
              </button>
            );
          })}
        </div>

        {/* Venue, product type, quote asset and — for futures — expiry. One
            borderless row of labels with chevrons, not four bands of
            controls stacked between the reader and the first result. */}
        <div className="mt-[18px] flex h-6 shrink-0 items-center gap-6 px-5">
          {menus.map((model) => (model.options.length === 0 ? (
            <span key={model.id} className="text-sm text-ink">{model.trigger}</span>
          ) : (
            <div key={model.id} className="relative">
              <button
                aria-haspopup="menu"
                aria-expanded={menu === model.id}
                aria-label={model.name}
                onClick={() => {
                  const next = menu === model.id ? null : model.id;
                  setMenu(next);
                  setMenuCursor(Math.max(0, model.options.findIndex((o) => o.value === model.value)));
                }}
                className="tvc-control inline-flex items-center gap-1.5 rounded-md text-sm text-ink"
              >
                {model.trigger}
                <CaretGlyph size={10} />
              </button>
              {menu === model.id && (
                <div role="menu" aria-label={model.name}
                  className="tvc-menu absolute left-0 top-full z-10 mt-1 max-h-[320px] min-w-[200px] overflow-y-auto">
                  {model.options.map((option, i) => (
                    <button
                      key={option.value}
                      role="menuitemradio"
                      aria-checked={model.value === option.value}
                      aria-disabled={option.disabled ? "true" : undefined}
                      data-highlighted={i === menuCursor ? "true" : undefined}
                      title={option.title}
                      onClick={() => { if (option.disabled) return; model.pick(option.value); setMenu(null); }}
                      className="tvc-menu-row justify-between gap-4 px-3 text-sm"
                    >
                      <span className="truncate">{option.label}</span>
                      {option.suffix && <span className="shrink-0 text-xs text-ink-faint">{option.suffix}</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )))}
        </div>

        {/* results */}
        <div ref={listRef} className="mt-[10px] min-h-0 flex-1 overflow-y-auto"
          style={{ ["--ss-ticker" as string]: `${tickerChars}ch` }}>
          {err && (
            <div role="alert" className="px-5 py-6 text-center">
              <p className="text-sm text-ink">Symbol search is unavailable.</p>
              {/* REV-UX-01: this line was the raw thrown message. */}
              <p className="mt-1 text-[13px] text-ink-muted" title={err}>{shortReason(err)}</p>
              <p className="mt-1 text-[13px] text-ink-muted">
                The chart keeps its current symbol. Nothing was changed.
              </p>
            </div>
          )}
          {!err && rows.length === 0 && !busy && (
            <div className="px-5 pt-12 text-center text-sm text-ink-muted">
              {term.trim().length === 0
                ? `Type to search crypto, U.S. stocks/ETFs, FX, futures and indices across supported venues.`
                : <>No market instrument matches “{term}”</>}
            </div>
          )}
          {rows.map((r, i) => {
            const isCurrent = (r.canonicalId ?? r.symbol) === current;
            const venueLabel = venues.find((v) => v.id === r.venueId)?.label ?? r.venueId ?? SEARCH_VENUE;
            const description = rowDescription(r);
            const hit = matchParts(description, term);
            return (
              <button
                key={r.canonicalId ?? `${r.venueId ?? "BINANCE"}:${r.symbol}`}
                data-idx={i}
                onMouseEnter={() => setCursor(i)}
                onClick={() => void choose(r)}
                aria-current={isCurrent ? "true" : undefined}
                title={rowTitle(r, current)}
                className={`grid h-10 w-full grid-cols-[24px_var(--ss-ticker,7ch)_minmax(0,1fr)_auto_auto_20px] items-center gap-x-2
                  border-b border-border px-5 text-left ${i === cursor
                  ? "outline outline-2 -outline-offset-2 outline-[var(--ts-menu-selected-bg)]"
                  : "hover:bg-state-hover"}`}
              >
                <AssetMark asset={r.baseAsset} />
                {/* accent-is-meaning: the ticker is the link — the reference's
                    row grammar spends accent on the instrument's name and on
                    nothing else in this list. */}
                <span className="truncate text-sm text-accent">{rowTicker(r)}</span>
                <span className="truncate text-sm text-ink">
                  {hit === null ? description : <>
                    {hit.pre}
                    {/* accent-is-meaning: the part of the name the query
                        matched, which is the same "this is the link" accent
                        the ticker carries. */}
                    <span className="text-accent">{hit.hit}</span>
                    {hit.post}
                  </>}
                </span>
                <span className="shrink-0 text-right text-xs text-ink-faint">{rowTypeWords(r)}</span>
                <span className="shrink-0 truncate text-sm text-ink">{venueLabel}</span>
                <VenueMark label={venueLabel} />
              </button>
            );
          })}
        </div>

        {/*
          The footer strip: one centred line on a lighter ground, which is the
          divider. The count is ours and stays; the reference's ISIN sentence
          is not ours to print, and the key hints moved to `sr-only` above.
        */}
        <div className="relative flex h-10 shrink-0 items-center justify-center bg-state-hover text-[13px] text-ink-faint">
          <span role="status">{searchSummary({ busy, shown: rows.length, total })}</span>
          {down.length > 0 && (
            <div className="absolute right-5">
              <button role="status" aria-label={degradedSummary(down.length)}
                onClick={() => setSourcesOpen((v) => !v)}
                onMouseEnter={() => setSourcesOpen(true)}
                onMouseLeave={() => setSourcesOpen(false)}
                className="flex items-center gap-1.5 rounded text-xs text-ink-faint hover:text-ink">
                {degradedSummary(down.length)}
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                  <circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 7.6v.6" />
                </svg>
              </button>
              {sourcesOpen && (
                <div className="tvc-popover absolute bottom-full right-0 z-10 mb-2 w-[320px] p-3 text-left">
                  <p className="text-xs text-ink-muted">
                    These sources did not answer. Everything else remains searchable.
                  </p>
                  <ul className="mt-2 space-y-1">
                    {down.map((source) => (
                      <li key={source.providerId} title={source.error}
                        className="flex items-baseline justify-between gap-3 text-xs">
                        <span className="shrink-0 text-ink">{source.label}</span>
                        <span className="truncate text-ink-faint">{source.reason}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
