/**
 * Paper (simulation) fills.
 *
 * The platform had two delivery modes that touch money — `custom` and
 * `3commas` — and one that does nothing at all, `off`. There was no way to run
 * a deployment forward on live bars and see what it WOULD have done, which is
 * the thing an operator wants before arming a configuration with real money,
 * and it is what the selection pipeline's own metadata demands: *"forward/paper
 * validation is mandatory"* (`OPT-01`).
 *
 * This module is that simulation, and it is deliberately a PURE function of the
 * signals it is given. It holds no credentials, opens no socket and imports
 * nothing that can place an order. A paper deployment is separated from live
 * delivery structurally, not by a flag read at the last moment:
 * `tests/paperIsolation.test.ts` walks this module's entire transitive import
 * graph and fails if it can reach the dispatcher, the webhook contract or the
 * live evaluators.
 *
 * The cost model is the live one — 0.1 % per side, the figure every research
 * tree runs (`X-09`, `docs/COST-MODELS.md`). A paper run at zero fees would
 * flatter every configuration exactly where it matters least.
 */

/** Commission per side, as a percentage. Binance spot taker. */
export const PAPER_COMMISSION_PCT = 0.1;

export interface PaperSignal {
  action: "buy" | "sell";
  /** Fill price. The live path emits a market order, so this is the bar close. */
  price: number;
  barTime: number;
  /** Quote currency to spend on a BUY. Ignored on a SELL. */
  buyQuoteQty: number;
  /** Fraction of the open position to sell, 0..100. Absent means all of it. */
  sellPercent?: number | null;
  reason?: string;
}

export interface PaperPosition {
  /** Base asset held. Zero means flat. */
  qty: number;
  /** Quote spent acquiring `qty`, net of what partial exits have released. */
  costBasis: number;
  entryPrice: number | null;
  entryBarTime: number | null;
}

export const FLAT: PaperPosition = Object.freeze({
  qty: 0, costBasis: 0, entryPrice: null, entryBarTime: null,
});

export interface PaperFill {
  action: "buy" | "sell";
  barTime: number;
  price: number;
  /** Base asset bought or sold. */
  qty: number;
  /** Quote paid (buy) or received (sell), before commission. */
  quote: number;
  commission: number;
  /** Realised P&L in quote, net of BOTH sides' commission. Null on a buy. */
  realisedPnl: number | null;
  positionAfter: PaperPosition;
}

export type PaperResult =
  | { filled: true; fill: PaperFill }
  | { filled: false; reason: string; positionAfter: PaperPosition };

const commissionOn = (quote: number): number => quote * (PAPER_COMMISSION_PCT / 100);

/**
 * Apply one signal to a paper position.
 *
 * Refusals are explicit and are NOT silent no-ops: a sell with nothing held, or
 * a buy while already long, means the platform's idea of the position and the
 * simulation's have diverged, and that is exactly what a paper run is for
 * surfacing.
 */
export function applyPaperSignal(position: PaperPosition, signal: PaperSignal): PaperResult {
  if (!(signal.price > 0) || !Number.isFinite(signal.price)) {
    return { filled: false, reason: `invalid fill price ${signal.price}`, positionAfter: position };
  }

  if (signal.action === "buy") {
    if (position.qty > 0) {
      return {
        filled: false,
        reason: "already long — a paper position is not averaged into, because the live path does not",
        positionAfter: position,
      };
    }
    const quote = signal.buyQuoteQty;
    if (!(quote > 0) || !Number.isFinite(quote)) {
      return { filled: false, reason: `invalid order size ${quote}`, positionAfter: position };
    }
    const commission = commissionOn(quote);
    const qty = quote / signal.price;
    const positionAfter: PaperPosition = {
      qty,
      // The buy-side commission is carried in the basis, so the realised P&L of
      // the eventual sell is net of BOTH sides.
      costBasis: quote + commission,
      entryPrice: signal.price,
      entryBarTime: signal.barTime,
    };
    return {
      filled: true,
      fill: { action: "buy", barTime: signal.barTime, price: signal.price, qty, quote, commission, realisedPnl: null, positionAfter },
    };
  }

  if (position.qty <= 0) {
    return { filled: false, reason: "nothing held — sell ignored", positionAfter: position };
  }

  const pct = signal.sellPercent ?? 100;
  if (!(pct > 0) || pct > 100 || !Number.isFinite(pct)) {
    return { filled: false, reason: `invalid sell percent ${signal.sellPercent}`, positionAfter: position };
  }
  const fraction = pct / 100;
  const qty = position.qty * fraction;
  const quote = qty * signal.price;
  const commission = commissionOn(quote);
  const basisSold = position.costBasis * fraction;
  const realisedPnl = quote - commission - basisSold;
  const remaining = position.qty - qty;
  // Below a millionth of the original there is nothing left worth tracking, and
  // float residue would otherwise leave a position that can never be closed.
  const flat = remaining <= position.qty * 1e-6;
  const positionAfter: PaperPosition = flat
    ? { ...FLAT }
    : {
        qty: remaining,
        costBasis: position.costBasis - basisSold,
        entryPrice: position.entryPrice,
        entryBarTime: position.entryBarTime,
      };
  return {
    filled: true,
    fill: { action: "sell", barTime: signal.barTime, price: signal.price, qty, quote, commission, realisedPnl, positionAfter },
  };
}

export interface PaperSummary {
  fills: number;
  buys: number;
  sells: number;
  realisedPnl: number;
  commissionPaid: number;
  wins: number;
  losses: number;
  /** Null when nothing has been realised yet. */
  winRatePct: number | null;
  openPosition: PaperPosition;
  /** Unrealised P&L at `markPrice`, or null when flat or unpriced. */
  unrealisedPnl: number | null;
}

/**
 * Roll a sequence of fills into the numbers an operator reads.
 *
 * `BE-10` is respected: a realised leg of exactly zero is neither a win nor a
 * loss here. The backtest's own definition counts it as a loss, and that
 * difference is behind the `zeroPnlIsScratch` correction rather than being
 * silently resolved one way in each place.
 */
export function summarisePaper(
  fills: readonly PaperFill[],
  opts: { markPrice?: number | null } = {}
): PaperSummary {
  let realisedPnl = 0, commissionPaid = 0, buys = 0, sells = 0, wins = 0, losses = 0;
  let openPosition: PaperPosition = { ...FLAT };
  for (const fill of fills) {
    commissionPaid += fill.commission;
    if (fill.action === "buy") buys += 1;
    else {
      sells += 1;
      realisedPnl += fill.realisedPnl ?? 0;
      if ((fill.realisedPnl ?? 0) > 0) wins += 1;
      else if ((fill.realisedPnl ?? 0) < 0) losses += 1;
    }
    openPosition = fill.positionAfter;
  }
  const decided = wins + losses;
  const mark = opts.markPrice ?? null;
  return {
    fills: fills.length, buys, sells,
    realisedPnl, commissionPaid, wins, losses,
    winRatePct: decided === 0 ? null : (wins / decided) * 100,
    openPosition,
    unrealisedPnl:
      openPosition.qty > 0 && mark !== null && Number.isFinite(mark)
        ? openPosition.qty * mark - commissionOn(openPosition.qty * mark) - openPosition.costBasis
        : null,
  };
}
