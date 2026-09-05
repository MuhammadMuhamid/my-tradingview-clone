/**
 * Manual ticket safety — what a staged order is still allowed to mean after the
 * operator changes something underneath it.
 *
 * ── Why this is a module and not three `useEffect`s ─────────────────────────
 *
 * The ticket panel lives beside a chart whose symbol the operator changes
 * constantly, from a watchlist, from search, from a deep link. The panel is not
 * remounted when that happens: it is the same component instance with a new
 * `symbol` prop. Everything already typed into it therefore survives — an
 * amount, a limit price, a take-profit, a stop, a chosen position to sell, and
 * the attestation that the next click spends real money on Binance mainnet.
 *
 * Each of those is meaningful only for the instrument it was typed for. "0.5"
 * is a sane quantity of one coin and a fortune in another; a limit price near
 * one instrument's market is nowhere near another's; and an attestation is a
 * statement about a specific order, not a session-wide mood.
 *
 * The rules are pure functions here, with tests, because a `useEffect` that
 * quietly stops firing is invisible, and because the submit guard has to be
 * able to answer the same question the reset does — from the same source.
 *
 * ── The one thing these rules must never do ─────────────────────────────────
 *
 * They must not make an exit harder. Scoping the SELL position picker to the
 * current symbol REMOVES foreign positions from a list where picking one sent
 * that position's quantity under this chart's symbol; it never hides a position
 * that belongs to this instrument, and it never disables selling.
 */
import type { ManualPosition } from "./api";

/** The parts of a ticket that are only meaningful for one instrument. */
export interface StagedTicket {
  amount: string;
  limitPrice: string;
  tp: string;
  sl: string;
  positionId: string;
  /** Real-funds attestation for the order being staged. */
  mainnetConfirmed: boolean;
  /** Set once a request id has been claimed for an in-flight submission. */
  orderRequestId: string | null;
  /** True while the confirmation step is open. */
  confirming: boolean;
}

export const EMPTY_TICKET: StagedTicket = {
  amount: "", limitPrice: "", tp: "", sl: "", positionId: "",
  mainnetConfirmed: false, orderRequestId: null, confirming: false,
};

/** Anything typed, chosen, attested or opened. An untouched ticket is inert. */
export function isTicketStaged(ticket: StagedTicket): boolean {
  return ticket.amount.trim() !== ""
    || ticket.limitPrice.trim() !== ""
    || ticket.tp.trim() !== ""
    || ticket.sl.trim() !== ""
    || ticket.positionId !== ""
    || ticket.mainnetConfirmed
    || ticket.orderRequestId !== null
    || ticket.confirming;
}

/**
 * What survives a symbol change: nothing.
 *
 * Every field above is instrument-specific, including the attestation and the
 * open confirmation dialog — a modal left open while the chart moves underneath
 * would otherwise re-render naming the NEW symbol with the old attestation
 * still ticked, and its confirm button live.
 *
 * The claimed request id is dropped too. It exists to make a retry idempotent
 * for one order; reusing it for an order against a different instrument would
 * make the retry silently mean something else.
 */
export function resetForSymbolChange(): StagedTicket {
  return { ...EMPTY_TICKET };
}

/**
 * What survives an account change: the numbers, not the attestation.
 *
 * The amounts stay meaningful — the instrument has not moved — but "I confirm
 * this order uses real funds on Binance mainnet" is a statement about a
 * specific account, and the account is exactly what changed. A chosen position
 * belongs to the old account's ledger, so it goes too.
 */
export function resetForAccountChange(ticket: StagedTicket): StagedTicket {
  return { ...ticket, mainnetConfirmed: false, positionId: "", confirming: false };
}

/** Normalised comparison, so "btcusdt" and "BTC/USDT" are not two instruments. */
export function sameSymbol(a: string, b: string): boolean {
  const clean = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return clean(a) !== "" && clean(a) === clean(b);
}

/** The base asset of a Spot symbol, for labelling and for position scoping. */
export function baseAssetOf(symbol: string): string {
  // Legacy suffix split, kept deliberately: this is a DISPLAY label for a
  // ticket that already knows its instrument, not a claim about the quote
  // asset. New code reads assets from metadata — see `lib/instrument`.
  return symbol.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/USDT$/, "");
}

/**
 * The positions a SELL on THIS chart may legitimately close.
 *
 * The account filter was already here. The symbol filter was not, and its
 * absence was the defect: the picker listed every open position on the account,
 * choosing one filled the amount box with THAT instrument's quantity, and the
 * submitted order still carried the CURRENT chart's symbol. The result was an
 * order that looked like an exit and was not one.
 */
export function positionsForSymbol(
  positions: readonly ManualPosition[] | undefined,
  scope: { symbol: string; accountId: string }
): ManualPosition[] {
  if (!positions) return [];
  return positions.filter((p) =>
    p.status === "active"
    && p.exchangeAccountId === scope.accountId
    && sameSymbol(p.pair, scope.symbol));
}

/**
 * The last gate before a staged order is submitted.
 *
 * The reset above is the primary mechanism; this is the one that does not
 * depend on an effect having fired. It answers the same question from the same
 * place, so a reset that regresses cannot silently let a stale ticket through.
 */
export function ticketSubmitBlocker(input: {
  /** The symbol the ticket was staged against, or null if never staged. */
  armedSymbol: string | null;
  /** The symbol the chart is showing right now. */
  currentSymbol: string;
  /** The account the ticket was staged against, or null. */
  armedAccountId: string | null;
  currentAccountId: string;
  positionId: string;
  side: "BUY" | "SELL";
  /** Positions already scoped by `positionsForSymbol`. */
  selectablePositions: readonly ManualPosition[];
}): string | null {
  if (input.armedSymbol !== null && !sameSymbol(input.armedSymbol, input.currentSymbol)) {
    return `This ticket was prepared for ${input.armedSymbol}. `
      + `Re-enter it for ${input.currentSymbol} before submitting.`;
  }
  if (input.armedAccountId !== null && input.armedAccountId !== input.currentAccountId) {
    return "This ticket was prepared for a different account. Re-enter it before submitting.";
  }
  if (input.side === "SELL" && input.positionId !== ""
      && !input.selectablePositions.some((p) => p.id === input.positionId)) {
    return `That position is not open on ${input.currentSymbol} for this account.`;
  }
  return null;
}
