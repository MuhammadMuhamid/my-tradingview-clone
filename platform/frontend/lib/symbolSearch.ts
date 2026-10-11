/**
 * The symbol dialog's non-visual rules.
 *
 * ── Why this is not inside the component ───────────────────────────────────
 *
 * Two of them are worth holding onto with a test rather than a screenshot.
 *
 * The keyboard cursor: ↑/↓ used to clamp against `rows.length - 1`, which is
 * `-1` for an empty result set, so a search that matched nothing left the
 * cursor at 0 pointing into an empty array. Nothing crashed — `rows[0]` is
 * `undefined` and Enter was a no-op — but the rule is easy to get wrong again
 * and impossible to see in review.
 *
 * The market context is explicit because one catalog spans crypto spot and
 * derivatives, U.S. stocks and ETFs, OTC FX, exchange futures and reference
 * indices — SEVERAL asset classes, which is why the dialog's first control is
 * a class chip row. Product, venue and quote filters preserve the canonical
 * identity; options remain absent because no provider contract supports them.
 *
 * ── TVP8 R4: the tables below are the dialog's claims ─────────────────────
 *
 * The chip set, the type and expiry menus, the row's words and the degraded
 * -source vocabulary all live here rather than in the JSX. A test can then
 * assert what the dialog OFFERS and what it SAYS, instead of grepping a
 * component for uppercase badge text — which is how "offers every implemented
 * market identity" used to be checked, and why it could not tell a rendered
 * filter from a deleted one.
 */
import type { SymbolSearchResult } from "./api";
import type { SymbolInfo } from "./types";
import { canonicalDisplayParts, displaySymbol, displayTicker, legacyBinanceSpotTicker } from "./instrument";
import { recallJson, rememberJson } from "./browserStorage";

/** Search is provider-aggregated and can return several canonical venues. */
export const SEARCH_VENUE = "All venues";
/** The supported read-only market catalog. Options remain intentionally absent. */
export const SEARCH_MARKET = "Crypto, stocks, FX, futures & indices";

/** The chip that means "do not filter by quote asset". */
export const ALL_QUOTES = "ALL";
export const ALL_VENUES = "ALL";
export const ALL_TYPES = "all";
export const LIVE_EXPIRIES = "live";
export type SearchInstrumentType = "all" | "spot" | "perpetual" | "future" | "continuous_future" | "stock" | "etf" |
  "fx_pair" | "commodity" | "index";
export type SearchExpiry = "all" | "live" | "30d" | "90d" | "expired";

/**
 * The quote-asset chips, from whatever the server reported.
 *
 * Quote/currency is one of several explicit filter axes; product type and
 * venue remain separate so identical tickers cannot collapse together.
 */
export function quoteFilters(quotes: readonly string[] | null | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [ALL_QUOTES];
  for (const q of quotes ?? []) {
    if (typeof q !== "string") continue;
    const upper = q.trim().toUpperCase();
    if (upper.length === 0 || upper === ALL_QUOTES || seen.has(upper)) continue;
    seen.add(upper);
    out.push(upper);
  }
  return out;
}

export function venueFilters(venues: readonly { id: string; label: string }[] | null | undefined):
  { id: string; label: string }[] {
  const seen = new Set<string>();
  return [{ id: ALL_VENUES, label: "All venues" }, ...(venues ?? []).filter((venue) => {
    const id = venue.id.trim().toUpperCase();
    if (!id || id === ALL_VENUES || seen.has(id)) return false;
    seen.add(id); return true;
  }).map((venue) => ({ id: venue.id.trim().toUpperCase(), label: venue.label.trim() || venue.id }))];
}

/**
 * The identity of one search: what was typed, and which quote chip is on.
 *
 * Results carry the key of the query they answer, so the dialog can tell an
 * answer to the current input from an answer to the previous one. Enter is
 * allowed to select only from the former — a debounced search means the two
 * are routinely different for the first 180 ms after a keystroke or a paste,
 * which is exactly when an impatient user presses Enter.
 *
 * The term is trimmed and upper-cased because the server treats it that way:
 * two inputs the search cannot distinguish must not count as different
 * queries, or Enter would stall waiting for an answer that already arrived.
 */
export function searchKey(term: string, quote: string, venue = ALL_VENUES,
  type: SearchInstrumentType = ALL_TYPES, expiry: SearchExpiry = LIVE_EXPIRIES): string {
  return `${term.trim().toUpperCase()}|${quote.trim().toUpperCase()}|${venue.trim().toUpperCase()}|${type}|${expiry}`;
}

/* ── Enter, the debounce, and which results may answer it ──────────────────
 *
 * The dialog debounces its search by 180 ms and opens seeded with the current
 * symbol, so for the first fraction of a second after a keystroke or a paste
 * the rows on screen answer the PREVIOUS query. Enter in that window must not
 * select from them.
 *
 * The arbitration is a small state machine, and it lives here — pure, with no
 * React and no timers — because every one of its interesting states is a race:
 * Enter before the answer, Enter then more typing, Enter then Escape, an
 * answer arriving after the dialog has closed. Those are the cases that were
 * got wrong when this logic was inline in the component, and they are cases a
 * source-text assertion cannot observe at all.
 * ──────────────────────────────────────────────────────────────────────── */

export interface SearchIntent {
  /** The query the rows currently on screen answer, or null for none yet. */
  rowsKey: string | null;
  /** An Enter is waiting for the answer to the query that was in the box. */
  pendingEnter: boolean;
}

export const NO_INTENT: SearchIntent = { rowsKey: null, pendingEnter: false };

/**
 * What Enter should do, given what the rows currently answer.
 *
 *   `select`  the rows answer the live query; take the highlighted row.
 *   `flush`   they do not; issue the query NOW and remember that an Enter is
 *             waiting for it. Flushing rather than guessing is what makes the
 *             impatient path cost one request instead of two.
 */
export function pressEnter(
  intent: SearchIntent, currentKey: string
): { intent: SearchIntent; action: "select" | "flush" } {
  if (intent.rowsKey === currentKey) return { intent, action: "select" };
  return { intent: { ...intent, pendingEnter: true }, action: "flush" };
}

/**
 * The query changed — a keystroke, a backspace, a different quote chip.
 *
 * The waiting Enter is dropped. It was an instruction about the text that was
 * in the box at the time; honouring it against a later query would commit the
 * user to a symbol they never confirmed for that query.
 */
export function queryChanged(intent: SearchIntent): SearchIntent {
  return intent.pendingEnter ? { ...intent, pendingEnter: false } : intent;
}

/**
 * A response arrived for `key`.
 *
 * `select` only when an Enter was waiting AND the dialog is still open. A
 * dialog the user has closed — Escape, the backdrop, the ✕ — must not go on to
 * change the chart's symbol and register a pair, which is exactly what an
 * unguarded in-flight request would do after the panel had disappeared.
 */
export function responseArrived(
  intent: SearchIntent, key: string, open: boolean
): { intent: SearchIntent; action: "select-top" | "none" } {
  const settled: SearchIntent = { rowsKey: key, pendingEnter: false };
  const take = intent.pendingEnter && open;
  return { intent: settled, action: take ? "select-top" : "none" };
}

/** The dialog closed. Nothing survives it. */
export function dialogClosed(): SearchIntent {
  return NO_INTENT;
}

/**
 * Where the highlight lands after a key press.
 *
 * Total for every length, including zero — an empty result set has no row to
 * highlight, and `-1` says so rather than pointing at a row that is not there.
 */
export function moveCursor(cursor: number, delta: number, length: number): number {
  if (length <= 0) return -1;
  const next = (Number.isFinite(cursor) ? Math.trunc(cursor) : 0) + delta;
  return Math.max(0, Math.min(length - 1, next));
}

/** The row Enter would select, or null when there is none. */
export function rowAtCursor<T>(rows: readonly T[], cursor: number): T | null {
  if (cursor < 0 || cursor >= rows.length) return null;
  return rows[cursor] ?? null;
}

/** The footer count. Says what it is looking at, not just a number. */
export function searchSummary(input: {
  busy: boolean; shown: number; total: number;
}): string {
  if (input.busy) return "Searching…";
  if (input.total === 0) return "No market instrument matches";
  if (input.shown >= input.total) {
    return `${input.total} market instrument${input.total === 1 ? "" : "s"}`;
  }
  return `${input.shown} of ${input.total} market instruments`;
}

/**
 * What one result row says about itself, beyond its ticker.
 *
 * `tracked: false` means the pair exists on the venue but this installation has
 * never stored it; choosing it registers it first. Saying "add" rather than
 * nothing is what makes that a decision instead of a surprise.
 */
export function describeResult(row: SymbolSearchResult): {
  pair: string; venue: string; market: string; needsAdding: boolean;
} {
  return {
    pair: `${row.baseAsset} / ${row.quoteAsset}`,
    venue: row.venueId ?? SEARCH_VENUE,
    market: row.instrumentType === "perpetual" ? "PERP"
      : row.instrumentType === "future" ? `FUTURE${row.series?.kind === "dated" ? ` ${row.series.expiry}` : ""}`
      : row.instrumentType === "stock" ? "STOCK" : row.instrumentType === "etf" ? "ETF" : "SPOT",
    needsAdding: !row.tracked,
  };
}

/* ── The asset-class chip row, and the menus behind it ─────────────────────
 *
 * The dialog's PRIMARY filter is the asset class, not the quote currency.
 *
 * That was the deepest of R4's findings and it is a fact about the catalogue
 * rather than a style: one search now spans crypto spot, crypto derivatives,
 * exchange futures, OTC FX and reference indices, and the first question a
 * reader asks is which of those they are looking at. A 24-chip grid of quote
 * currencies answers a question almost nobody has, in the space where that
 * one belongs; quote survives, in the dropdown row, where it is one of three
 * secondary axes beside venue and product type.
 *
 * ── Why the chips are a TABLE and not JSX ──────────────────────────────────
 *
 * Every chip is a claim about what this installation can answer. `Stocks` and
 * `Funds` exist in the contract and have exactly one provider, which is
 * unavailable today: they are rendered, DISABLED, with the reason on hover.
 * Hiding them would make a capability blink out of existence with a
 * credential and back in with another, and enabling them would promise an
 * answer that arrives empty. `Bonds`, `Economy` and `Options` are not here at
 * all, because no contract describes them — the same rule that keeps ISIN and
 * CUSIP out of the placeholder.
 *
 * Holding that here rather than in the component is what lets a test assert
 * the claim set directly instead of grepping JSX for uppercase words, which
 * is what the previous "offers every implemented market identity" test did.
 * ──────────────────────────────────────────────────────────────────────── */

/** The chips, in the order the row renders them. */
export type SearchAssetClass = "all" | "stocks" | "funds" | "futures" | "forex" | "crypto" | "indices";

/** The catalogue's own asset classes — `market.v1`'s vocabulary, not ours. */
export type SearchAssetClassQuery = "" | "crypto" | "equity" | "fx" | "commodity" | "index";

export interface AssetClassChip {
  id: SearchAssetClass;
  label: string;
  /** What the chip asks the search for. Both fields are optional filters. */
  query: { type?: SearchInstrumentType; assetClass?: SearchAssetClassQuery };
  /**
   * The providers that carry this class. A chip is dead only when EVERY one
   * of them is failing; an empty list is a class no single provider owns.
   */
  providers: readonly string[];
  /** Said to a reader when they are all failing. Never a provider id. */
  degraded: string;
}

export const ASSET_CLASS_CHIPS: readonly AssetClassChip[] = [
  { id: "all", label: "All", query: {}, providers: [], degraded: "" },
  { id: "stocks", label: "Stocks", query: { type: "stock" }, providers: ["alpaca-us-equities"],
    degraded: "U.S. stocks are unavailable" },
  { id: "funds", label: "Funds", query: { type: "etf" }, providers: ["alpaca-us-equities"],
    degraded: "U.S. ETFs are unavailable" },
  // Commodities ARE futures — NYMEX and COMEX contracts — so they live under
  // this chip's type menu rather than as a tenth chip of their own.
  { id: "futures", label: "Futures", query: { type: "future" }, providers: [], degraded: "" },
  { id: "forex", label: "Forex", query: { type: "fx_pair" }, providers: [], degraded: "" },
  { id: "crypto", label: "Crypto", query: { assetClass: "crypto" }, providers: [], degraded: "" },
  { id: "indices", label: "Indices", query: { type: "index" }, providers: [], degraded: "" },
];

export function chipById(id: SearchAssetClass): AssetClassChip {
  return ASSET_CLASS_CHIPS.find((chip) => chip.id === id) ?? ASSET_CLASS_CHIPS[0]!;
}

/**
 * The chip the dialog opens on: the class of the instrument on the chart.
 *
 * A legacy bare ticker is Binance spot and therefore crypto — the one venue
 * this installation registers without a canonical id.
 */
export function chipForInstrument(current: string): SearchAssetClass {
  const parts = canonicalDisplayParts(current);
  if (!parts) return "crypto";
  switch (parts.type) {
    case "fx_pair": return "forex";
    case "index": return "indices";
    case "stock": return "stocks";
    case "etf": return "funds";
    case "future": case "continuous_future": case "commodity": return "futures";
    default: return "crypto";
  }
}

/** Every product type this catalogue implements, as a reader would name it. */
export const TYPE_LABELS: Readonly<Record<SearchInstrumentType, string>> = Object.freeze({
  all: "All types", spot: "Spot", perpetual: "Perpetual", future: "Dated futures",
  continuous_future: "Continuous futures", fx_pair: "Forex", index: "Index",
  commodity: "Commodity", stock: "Stock", etf: "ETF",
});

/** Every expiry window the futures catalogue supports. */
export const EXPIRY_LABELS: Readonly<Record<SearchExpiry, string>> = Object.freeze({
  live: "Live only", "30d": "Next 30 days", "90d": "Next 90 days", expired: "Expired", all: "All",
});

export const EXPIRY_OPTIONS: readonly SearchExpiry[] = ["live", "30d", "90d", "expired", "all"];

/**
 * The product types a chip can honestly offer.
 *
 * A single-entry answer is a chip whose class IS one type; the dialog renders
 * that as plain text rather than a menu with one row in it.
 */
export function typeOptionsFor(chip: SearchAssetClass): readonly SearchInstrumentType[] {
  switch (chip) {
    case "crypto": return ["all", "spot", "perpetual", "future"];
    // No "all" row: the chip IS the restriction, and the route filters by one
    // type at a time, so "all" here would quietly widen back to the catalogue.
    case "futures": return ["future", "continuous_future", "commodity"];
    case "forex": return ["fx_pair"];
    case "indices": return ["index"];
    case "stocks": return ["stock"];
    case "funds": return ["etf"];
    default: return ["all", "spot", "perpetual", "future", "continuous_future",
      "fx_pair", "index", "commodity", "stock", "etf"];
  }
}

/**
 * The type a chip selects on its own.
 *
 * `all` where the chip's own restriction is carried elsewhere (the class
 * query, or nothing at all), and otherwise the first type it offers — which
 * is why this must agree with the chip's `query.type`, and a test says so.
 */
export function chipTypeDefault(chip: SearchAssetClass): SearchInstrumentType {
  const options = typeOptionsFor(chip);
  return options.includes(ALL_TYPES) ? ALL_TYPES : options[0]!;
}

/** Expiry is a futures question, so it is asked only where it has an answer. */
export function showsExpiry(chip: SearchAssetClass, type: SearchInstrumentType): boolean {
  return chip === "futures" || type === "future" || type === "continuous_future";
}

/* ── Truthful provider limitations, said in the reader's vocabulary ────────
 *
 * Six of this installation's providers are failing right now, and the old
 * dialog said so in a 50px amber banner of raw provider ids directly above
 * the first result — the most saturated thing on screen, before a single
 * answer, on every open. Contract §5 (REV-UX-01) forbids exactly that.
 *
 * The truth does not move; its placement and its voice do. A provider id and
 * a thrown cause are facts for a `title` and for the footer popover's detail
 * column. What a reader sees first is the venue's LABEL and one sentence.
 * ──────────────────────────────────────────────────────────────────────── */

export interface ProviderFailure { providerId: string; error: string }

export interface DegradedSource {
  providerId: string;
  /** `Bybit`, `Robinhood Crypto`, `Binance derivatives` — never `bybit-spot`. */
  label: string;
  /** One sentence a reader can act on. */
  reason: string;
  /** The cause exactly as it arrived. Tooltip and bug report only. */
  error: string;
}

const SOURCE_WORD = (word: string): string =>
  word === "us" ? "U.S." : word.charAt(0).toUpperCase() + word.slice(1);

/**
 * The venue a provider id belongs to, as a reader would name it.
 *
 * ── R4b-09: a tail word the venue's own label already carries ──────────────
 *
 * `robinhood-crypto` against a catalogue whose venue label is already
 * `Robinhood Crypto` produced `Robinhood Crypto Crypto` — the head is the
 * venue's registered LABEL, not the slug, and a label is free to contain the
 * book word the slug's tail names. So a tail word the head already ends with
 * is dropped: it adds nothing and reads as a stutter. `Binance` +
 * `derivatives` is untouched, because that tail names a different book from
 * the one the head alone means.
 */
export function sourceLabel(providerId: string,
  venues: readonly { id: string; label: string }[] | null | undefined): string {
  const parts = String(providerId ?? "").split("-").filter(Boolean);
  if (parts.length === 0) return String(providerId ?? "");
  const venue = (venues ?? []).find((item) => item.id.trim().toLowerCase() === parts[0]);
  const head = venue?.label.trim() || SOURCE_WORD(parts[0]!);
  // `-spot` says nothing a reader needs; `-derivatives` names a different book.
  const tail = parts.slice(1).filter((part) => part !== "spot")
    .map((part) => part === "derivatives" ? "derivatives" : SOURCE_WORD(part))
    .filter((word) => !new RegExp(`(^|\\s)${word}$`, "i").test(head));
  return [head, ...tail].join(" ");
}

/**
 * Why one source did not answer, in the reader's vocabulary.
 *
 * ── R4b-09: `shortReason` printed its own fallback as the reason ──────────
 *
 * `lib/errorCopy`'s `shortReason` reads a status code out of prose and, when
 * it finds none, answers `Hover for the reason reported.` That sentence is
 * correct as a TOOLTIP PROMPT and absurd as the content of the tooltip: four
 * of the six live failures landed in the popover's reason column telling the
 * reader to hover for the reason they were already hovering to read.
 *
 * The live causes are readable sentences — `…require an API key and
 * signature; no credential was supplied`, `official derivative API returned
 * HTTP 451` — so the classification here reads the SENTENCE rather than only
 * a code, and when it recognises nothing it quotes the cause's first clause
 * instead of inventing one. Provider prose in a popover's detail column is
 * allowed under REV-UX-01: the headline (`N sources unavailable`) is ours,
 * and the raw string stays in `title` either way.
 */
export function reasonForSource(error: string): string {
  const raw = String(error ?? "").trim();
  if (raw.length === 0) return "The source did not answer.";
  if (/\b451\b|geo-?block|unavailable for legal/i.test(raw)) return "Not available from this region.";
  if (/credential|api[- ]?key|signature|secret|token/i.test(raw)) return "No credential is configured.";
  if (/eligible|approved|entitle|subscription|account/i.test(raw)) return "Needs an approved account.";
  if (/\b(401|403)\b|forbidden|unauthor/i.test(raw)) return "The venue refused the request.";
  if (/\b(404)\b|no route/i.test(raw)) return "This environment does not serve it.";
  if (/\b5\d\d\b|timeout|timed out|fetch failed|network/i.test(raw)) {
    return "The service did not answer. Try again shortly.";
  }
  // Nothing recognised: the cause's own first clause, trimmed to a phrase.
  const clause = raw.split(/[;(]/)[0]!.trim().replace(/[.,]$/, "");
  const short = clause.length > 60 ? `${clause.slice(0, 57).trimEnd()}…` : clause;
  return short.endsWith("…") ? short : `${short}.`;
}

/** The venue id a failing provider belongs to, for matching against a row. */
export function sourceVenueId(providerId: string): string {
  return String(providerId ?? "").split("-")[0]?.toUpperCase() ?? "";
}

export function degradedSources(
  errors: readonly ProviderFailure[] | null | undefined,
  venues: readonly { id: string; label: string }[] | null | undefined,
  reason: (error: string) => string,
): DegradedSource[] {
  return (errors ?? []).filter((item) => typeof item?.providerId === "string").map((item) => ({
    providerId: item.providerId,
    label: sourceLabel(item.providerId, venues),
    reason: reason(item.error ?? ""),
    error: item.error ?? "",
  }));
}

/** The footer's one-line indicator. Counts sources; never names them. */
export function degradedSummary(count: number): string {
  return `${count} source${count === 1 ? "" : "s"} unavailable`;
}

/**
 * Why a chip is disabled, or null when it is not.
 *
 * A chip with no providers of its own is never disabled here: "Futures" is
 * carried by six venues and one of them failing is not the class going away.
 */
export function chipDegradedTitle(chip: AssetClassChip,
  errors: readonly ProviderFailure[] | null | undefined,
  reason: (error: string) => string): string | null {
  if (chip.providers.length === 0) return null;
  const failing = chip.providers.map((id) =>
    (errors ?? []).find((item) => item.providerId === id)).filter((item) => item !== undefined);
  if (failing.length < chip.providers.length) return null;
  return `${chip.degraded} — ${reason(failing[0]!.error ?? "")}`;
}

/* ── What one row says ─────────────────────────────────────────────────────
 *
 * The reference's row grammar is: mark, ticker, the instrument's NAME, three
 * quiet lowercase words for what it is, the venue in title case, the venue's
 * mark. Ours said the pair twice (`BTCUSDT` … `BTC / USDT`), shouted the type
 * in a badge, printed `LINEAR · SETTLE USDC` inline and ended on a raw
 * uppercase venue id.
 *
 * None of those facts is discarded. They are the row's `title` — one hover
 * away, which is where §5 puts a detail — and the identity panels show them
 * in full. What changes is that a list of instruments reads as a list of
 * instruments.
 * ──────────────────────────────────────────────────────────────────────── */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `2026-12-18` → `Dec 2026`. Fixed table, so it does not read a locale. */
export function contractMonth(expiry: string): string {
  const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(String(expiry ?? "").trim());
  if (!match) return String(expiry ?? "");
  const month = MONTHS[Number(match[2]) - 1];
  return month ? `${month} ${match[1]}` : String(expiry);
}

/** The ticker a workstation writes on the row: `BTCUSDT`, `BTCUSD.P`, `ES 2026-12-18`. */
export function rowTicker(row: SymbolSearchResult): string {
  return displayTicker(row.canonicalId ?? row.symbol);
}

/* ── R4b-13: the middle column was the ticker, spelled with a slash ────────
 *
 * `BTCUSDT` and `BTC / USDT` on one 40px row is the identity said twice and
 * the instrument said not at all; the reference spends that column on
 * `Bitcoin / TetherUS`. The provider contract carries no display name, so the
 * names come from a small table of the bases and quotes this catalogue
 * actually lists — names are FACTS, not a guess, and an asset the table does
 * not know falls back to its code rather than to an invented name.
 *
 * Frontend rather than `marketCatalog.ts` because nothing about the API
 * changes: a name is a rendering of an identity the response already carries.
 * ──────────────────────────────────────────────────────────────────────── */
export const ASSET_NAMES: Readonly<Record<string, string>> = Object.freeze({
  // Crypto bases the running catalogue returns.
  BTC: "Bitcoin", WBTC: "Wrapped Bitcoin", ETH: "Ethereum", WETH: "Wrapped Ethereum",
  SOL: "Solana", BNB: "BNB", XRP: "XRP", ADA: "Cardano", DOGE: "Dogecoin",
  AVAX: "Avalanche", LINK: "Chainlink", DOT: "Polkadot", MATIC: "Polygon",
  LTC: "Litecoin", TRX: "TRON", ATOM: "Cosmos", UNI: "Uniswap", AAVE: "Aave",
  ARB: "Arbitrum", OP: "Optimism", SUI: "Sui", APT: "Aptos", TON: "Toncoin",
  NEAR: "NEAR", FIL: "Filecoin", ETC: "Ethereum Classic", BCH: "Bitcoin Cash",
  SHIB: "Shiba Inu", PEPE: "Pepe", HYPE: "Hyperliquid",
  // Quotes.
  USDT: "Tether", USDC: "USD Coin", DAI: "Dai", BUSD: "Binance USD", FDUSD: "First Digital USD",
  USD: "U.S. dollar", EUR: "Euro", GBP: "British pound", JPY: "Japanese yen",
  CHF: "Swiss franc", AUD: "Australian dollar", CAD: "Canadian dollar",
  NZD: "New Zealand dollar", CNY: "Chinese yuan", MXN: "Mexican peso",
  // Exchange futures roots.
  ES: "E-Mini S&P 500", NQ: "E-Mini Nasdaq 100", YM: "E-Mini Dow", RTY: "E-Mini Russell 2000",
  GC: "Gold", SI: "Silver", HG: "Copper", CL: "Crude oil", NG: "Natural gas",
  ZB: "U.S. Treasury bond", ZN: "10-year T-note", ZC: "Corn", ZS: "Soybeans", ZW: "Wheat",
});

/** The instrument an asset code names, or the code when nothing is known. */
export function assetName(code: string): string {
  const key = String(code ?? "").trim().toUpperCase();
  return ASSET_NAMES[key] ?? String(code ?? "");
}

/**
 * The row's description: the instrument, not the ticker spelled a second way.
 *
 * Built from the identity and the name table above — with the series word
 * that makes two contracts on one underlying tell themselves apart.
 */
export function rowDescription(row: SymbolSearchResult): string {
  const pair = `${assetName(row.baseAsset)} / ${assetName(row.quoteAsset)}`;
  if (row.instrumentType === "perpetual") return `${pair} perpetual`;
  if (row.series?.kind === "dated") return `${pair} ${contractMonth(row.series.expiry)}`;
  if (row.instrumentType === "continuous_future") return `${pair} continuous`;
  return pair;
}

/** What the instrument is, in quiet lowercase words: `spot crypto`, `futures`. */
export function rowTypeWords(row: SymbolSearchResult): string {
  const type = row.instrumentType ?? "spot";
  const traditional = Boolean(row.equity ?? row.fx ?? row.futures ?? row.referenceIndex);
  const base = type === "spot" ? "spot" : type === "perpetual" ? "perpetual"
    : type === "future" || type === "commodity" ? "futures"
      : type === "continuous_future" ? "continuous futures"
        : type === "fx_pair" ? "forex" : type === "index" ? "index"
          : type === "stock" ? "stock" : "etf";
  const crypto = !traditional && (type === "spot" || type === "perpetual" ||
    type === "future" || type === "commodity");
  return crypto ? `${base} crypto` : base;
}

/**
 * Everything the row no longer prints, on one line, one hover away.
 *
 * Settlement, feed status, chain position, whether the pair is tracked and
 * whether it is the chart's own instrument. `tracked: false` still says that
 * choosing the row registers the pair first — that is a decision, not a
 * surprise, and it is the sentence `describeResult` has always carried.
 */
export function rowTitle(row: SymbolSearchResult, current: string): string {
  const facts: string[] = [displaySymbol(row.canonicalId ?? row.symbol)];
  if (row.derivative?.kind === "contract") {
    facts.push(`${row.derivative.settlement} · settle ${row.settlementAsset ?? row.quoteAsset}`);
  }
  if (row.equity) {
    facts.push(`REG · RAW · ${row.equity.marketData.defaultFeed.toUpperCase()} ` +
      `${row.equity.marketData.feedDelaySeconds}s delay`);
  }
  if (row.fx) facts.push(`MID chart · BID/ASK OTC · ${row.fx.feed.status.replaceAll("_", " ")}`);
  if (row.futures) {
    facts.push(`${row.futures.contractCode ?? "research series"} · ${row.futures.chainPosition} · ` +
      `${row.futures.feed.status.replaceAll("_", " ")}`);
  }
  if (row.referenceIndex) facts.push("READ-ONLY REFERENCE INDEX · not directly tradable");
  if ((row.canonicalId ?? row.symbol) === current) facts.push("on this chart");
  else if (!row.canonicalId && !row.tracked) facts.push("not tracked yet — choosing it registers the pair");
  return facts.join(" · ");
}

/**
 * The chart's own instrument, first.
 *
 * The reference opens with the current symbol as row 1 under the keyboard
 * cursor, so "open, Enter" re-selects what is already there and changes
 * nothing. Ours pre-filled the BASE asset, landed the cursor on row 0 — a
 * Hyperliquid perpetual — and made that same gesture a silent symbol change.
 * The ordering is client-side; the API is untouched.
 */
export function currentFirst(rows: readonly SymbolSearchResult[], current: string): SymbolSearchResult[] {
  const at = rows.findIndex((row) => (row.canonicalId ?? row.symbol) === current);
  if (at <= 0) return [...rows];
  return [rows[at]!, ...rows.slice(0, at), ...rows.slice(at + 1)];
}

/** The part of a description the query matched, so the row can mark it. */
export function matchParts(text: string, term: string): { pre: string; hit: string; post: string } | null {
  const needle = term.trim();
  if (needle.length === 0) return null;
  const at = text.toUpperCase().indexOf(needle.toUpperCase());
  if (at < 0) return null;
  return { pre: text.slice(0, at), hit: text.slice(at, at + needle.length), post: text.slice(at + needle.length) };
}

/**
 * The venues the `All sources` menu offers for the active chip.
 *
 * A venue that answered this class is offered; one whose only provider is
 * failing AND which returned nothing is offered DISABLED with the reason,
 * rather than removed — a venue that disappears looks like a venue we never
 * supported. `All` and whatever is currently chosen are always present, so a
 * selection can never be stranded outside its own menu.
 */
export function venueOptions(input: {
  venues: readonly { id: string; label: string }[] | null | undefined;
  rows: readonly SymbolSearchResult[];
  chip: SearchAssetClass;
  selected: string;
  errors: readonly ProviderFailure[] | null | undefined;
  reason: (error: string) => string;
}): { id: string; label: string; unavailable: boolean; title: string }[] {
  const carried = new Set(input.rows.map((row) => (row.venueId ?? "").toUpperCase()).filter(Boolean));
  const failed = new Map<string, string>();
  for (const item of input.errors ?? []) {
    const venue = sourceVenueId(item.providerId);
    if (venue && !failed.has(venue)) failed.set(venue, item.error ?? "");
  }
  return venueFilters(input.venues).filter((venue) => {
    if (venue.id === ALL_VENUES || venue.id === input.selected.toUpperCase()) return true;
    if (input.chip === "all") return true;
    return carried.has(venue.id) || failed.has(venue.id);
  }).map((venue) => {
    const error = venue.id === ALL_VENUES || carried.has(venue.id) ? undefined : failed.get(venue.id);
    return { id: venue.id, label: venue.label, unavailable: error !== undefined,
      title: error === undefined ? "" : `${venue.label} did not answer — ${input.reason(error)}` };
  });
}

/*
 * ── E7: what an EMPTY box lists — the user's recent symbols ───────────────
 *
 * Compare opens with nothing typed (it must not compare the chart with
 * itself), and an empty query asked the server for EVERYTHING: the panel
 * opened on `00USD`, `0GUSDT`, `0GTRY` — nine thousand instruments in
 * alphabetical order, none of them anything the user had ever looked at. The
 * reference opens that box on RECENT SYMBOLS. So does this: the rows the user
 * actually picked, newest first, kept on the device like the rest of the
 * search panel's state. With no history the panel says what to type instead
 * of pretending an alphabet is a suggestion.
 */
const RECENTS_KEY = "tv.symbolSearch.recents.v1";
export const RECENT_SYMBOL_LIMIT = 10;

const rowKey = (row: SymbolSearchResult): string => row.canonicalId ?? `${row.venueId ?? ""}:${row.symbol}`;

export function readRecentSymbols(): SymbolSearchResult[] {
  const stored = recallJson<unknown>(RECENTS_KEY, []);
  if (!Array.isArray(stored)) return [];
  return stored.filter((row): row is SymbolSearchResult =>
    !!row && typeof row === "object"
    && typeof (row as SymbolSearchResult).symbol === "string"
    && typeof (row as SymbolSearchResult).baseAsset === "string"
    && typeof (row as SymbolSearchResult).quoteAsset === "string").slice(0, RECENT_SYMBOL_LIMIT);
}

/** Put `row` at the front, once, and keep the newest `RECENT_SYMBOL_LIMIT`. */
export function withRecentSymbol(
  recents: readonly SymbolSearchResult[], row: SymbolSearchResult,
): SymbolSearchResult[] {
  const key = rowKey(row);
  return [row, ...recents.filter((r) => rowKey(r) !== key)].slice(0, RECENT_SYMBOL_LIMIT);
}

export function rememberRecentSymbol(row: SymbolSearchResult): void {
  // A chosen row becomes tracked once it is charted; store it as such so a
  // later pick from the recents list does not re-register the pair.
  rememberJson(RECENTS_KEY, withRecentSymbol(readRecentSymbols(), { ...row, tracked: true }));
}

/**
 * The rows an empty box shows. In compare mode the chart's own instrument is
 * left out — comparing a chart with itself is the one pick that is never
 * meant.
 */
export function recentRowsFor(
  recents: readonly SymbolSearchResult[], current: string, mode: "symbol" | "compare",
): SymbolSearchResult[] {
  return mode === "compare" ? recents.filter((row) => !isInstrument(row, current)) : [...recents];
}

/**
 * Whether `row` IS the instrument `current` names.
 *
 * The chart may hold either form — the canonical `instrument:v1:…` id or the
 * stored Binance ticker — and a row carries both, so comparing one field
 * missed the chart's own instrument whenever the forms differed.
 */
export function isInstrument(row: SymbolSearchResult, current: string): boolean {
  if (row.canonicalId !== undefined && row.canonicalId === current) return true;
  if (row.symbol === current) return true;
  const ticker = legacyBinanceSpotTicker(current);
  return ticker !== null && row.symbol === ticker
    && (row.venueId === undefined || row.venueId === "BINANCE");
}

/** The majors a trading desk expects first, when nothing is more recent. */
const LEADING_TRACKED = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT"];

/**
 * The installation's own instruments, as rows — what an empty box offers a
 * user with no history yet.
 *
 * Without it a first visit to Compare opened on an empty panel: no recents to
 * show, and the whole-catalogue alphabet is no answer. The tracked table is
 * exactly the instruments this installation has candles for — the ones a
 * comparison can actually draw — so they are a truthful starting list. Majors
 * first, then by ticker.
 */
export function trackedRows(symbols: readonly SymbolInfo[]): SymbolSearchResult[] {
  const rank = (s: string): number => {
    const at = LEADING_TRACKED.indexOf(s);
    return at < 0 ? LEADING_TRACKED.length : at;
  };
  return symbols
    .filter((info) => info.isActive !== false)
    .map((info): SymbolSearchResult => ({
      symbol: info.symbol,
      ...(info.canonicalId ? { canonicalId: info.canonicalId } : {}),
      ...(info.venue ? { venueId: info.venue } : {}),
      baseAsset: info.baseAsset,
      quoteAsset: info.quoteAsset,
      instrumentType: "spot",
      tracked: true,
    }))
    .sort((a, b) => rank(a.symbol) - rank(b.symbol) || a.symbol.localeCompare(b.symbol))
    .slice(0, 30);
}
