/**
 * Sizing a manual order against what the account actually holds.
 *
 * ── What these numbers are, and are not ─────────────────────────────────────
 *
 * Advisory. Every function here helps a human pick a number that the exchange
 * is likely to accept; not one of them decides whether an order executes. The
 * execution Bot re-reads the balance, re-applies Binance's filters and re-runs
 * its risk and Shariah checks at submission, and it does so from its own
 * authority. A figure shown in the ticket can therefore be stale, and being
 * stale must only ever cost the operator a rejection — never buy more than the
 * account holds.
 *
 * That is why the rounding here always goes DOWN. A quick-fill of "100%" that
 * rounded up to the next lot step would ask for more than is free, and Binance
 * would refuse the whole order; flooring can only ever ask for less.
 */

export interface AssetBalance { asset: string; free: number; locked: number }
export interface SymbolRules {
  lotStep: number; minQty: number; priceTick: number; minNotional: number;
}
export interface ManualAccountState {
  symbol: string; base: AssetBalance; quote: AssetBalance;
  rules: SymbolRules; simulated: boolean;
}

/** A live best bid/ask pair. Both sides present, or no quote at all. */
export interface BookQuote { bid: number; ask: number }

export const QUICK_FILL_PERCENTS = [1, 5, 10, 25, 50, 75, 100] as const;

/** Decimal places implied by a step, so a value prints the way Binance stores it. */
export function decimalsForStep(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 8;
  const text = step.toPrecision(12).replace(/0+$/, "");
  const dot = text.indexOf(".");
  if (dot < 0) return 0;
  return Math.min(8, text.length - dot - 1);
}

/** Floor a value onto a step. Never rounds up — see the module note. */
export function floorToStep(value: number, step: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (!Number.isFinite(step) || step <= 0) return value;
  const units = Math.floor(value / step + 1e-9);
  return Number((units * step).toFixed(decimalsForStep(step)));
}

/** The position a SELL is for (OD-7): only its remaining quantity matters here. */
export interface SellPosition { quantity: number }

/**
 * The largest order the ticket can honestly offer right now.
 *
 * BUY spends the quote asset, so its ceiling is free quote. SELL delivers the
 * base asset, floored onto the lot step because a quantity off-step is refused
 * outright. A SELL for a selected position (OD-7) is capped by THAT position:
 * `floor(min(position quantity, free base))`, so "100%" means the position the
 * operator chose, never coins belonging to another position or to nobody.
 * Without a position it is the free wallet balance ("Sell from wallet").
 */
export function maximumOrder(
  state: ManualAccountState | null, side: "BUY" | "SELL", position?: SellPosition | null
): { amount: number; asset: string } | null {
  if (!state) return null;
  if (side === "BUY") return { amount: state.quote.free, asset: state.quote.asset };
  const ceiling = position ? Math.min(Math.max(0, position.quantity), state.base.free) : state.base.free;
  return { amount: floorToStep(ceiling, state.rules.lotStep), asset: state.base.asset };
}

/**
 * What flooring a whole-position SELL onto the lot step leaves behind (OD-7):
 * the part of the position (capped by the free balance) below one lot step.
 * Null when there is none, so the ticket only mentions dust that exists.
 */
export function sellDust(state: ManualAccountState | null, position: SellPosition | null | undefined): number | null {
  if (!state || !position) return null;
  const ceiling = Math.min(Math.max(0, position.quantity), state.base.free);
  const dust = Number((ceiling - floorToStep(ceiling, state.rules.lotStep)).toFixed(12));
  return dust > 1e-12 ? dust : null;
}

/** A quick-fill percentage of the maximum, as the string the input holds. */
export function quickFillAmount(
  state: ManualAccountState | null, side: "BUY" | "SELL", percent: number, position?: SellPosition | null
): string {
  const max = maximumOrder(state, side, position);
  if (!max || !(max.amount > 0)) return "";
  const raw = (max.amount * percent) / 100;
  if (side === "BUY") {
    // Quote amounts are spent, not delivered, so the lot step does not apply;
    // Binance accepts two decimals of quote.
    const floored = Math.floor(raw * 100) / 100;
    return floored > 0 ? String(floored) : "";
  }
  const floored = floorToStep(raw, state!.rules.lotStep);
  return floored > 0 ? String(floored) : "";
}

/**
 * Why the ticket, as filled in, would not be accepted — or null.
 *
 * These are the checks a human can be told about BEFORE submitting. They are
 * duplicated by the Bot and by Binance, which remain the authorities; stating
 * them here only saves a round trip and names the actual current maximum
 * instead of relaying "insufficient balance".
 */
export function preSubmitProblem(input: {
  state: ManualAccountState | null;
  side: "BUY" | "SELL";
  amount: string;
  /** Last price or ask, used only to estimate a SELL's notional. */
  referencePrice: number | null;
  /** The selected position, for a SELL tied to one (OD-7). */
  position?: SellPosition | null;
}): string | null {
  const amount = Number(input.amount);
  if (!input.state || !(amount > 0)) return null;
  const max = maximumOrder(input.state, input.side, input.position);
  if (!max) return null;

  if (amount > max.amount) {
    if (input.side === "SELL" && input.position) {
      return `The selected position allows at most ${trim(max.amount)} ${max.asset} `
        + "(its quantity, capped by the free balance and the lot step).";
    }
    return `Only ${trim(max.amount)} ${max.asset} is available. `
      + `Maximum order at current state: ${trim(max.amount)} ${max.asset}.`;
  }
  const { rules } = input.state;
  if (input.side === "SELL") {
    if (rules.minQty > 0 && amount < rules.minQty) {
      return `Minimum order size on this symbol is ${trim(rules.minQty)} ${max.asset}.`;
    }
    if (rules.lotStep > 0 && Math.abs(amount - floorToStep(amount, rules.lotStep)) > 1e-12) {
      return `Quantity must be a multiple of ${trim(rules.lotStep)} ${max.asset}.`;
    }
    const notional = input.referencePrice !== null ? amount * input.referencePrice : null;
    if (notional !== null && rules.minNotional > 0 && notional < rules.minNotional) {
      return `Order value is below the ${trim(rules.minNotional)} `
        + `${input.state.quote.asset} minimum for this symbol.`;
    }
    return null;
  }
  if (rules.minNotional > 0 && amount < rules.minNotional) {
    return `Minimum order value on this symbol is ${trim(rules.minNotional)} `
      + `${input.state.quote.asset}.`;
  }
  return null;
}

/** The spread between a live best bid and ask, absolute and in basis points. */
export function spreadOf(quote: BookQuote | null): { absolute: number; bps: number } | null {
  if (!quote || !(quote.bid > 0) || !(quote.ask > 0) || quote.ask < quote.bid) return null;
  const absolute = quote.ask - quote.bid;
  const mid = (quote.ask + quote.bid) / 2;
  return { absolute, bps: mid > 0 ? (absolute / mid) * 10_000 : 0 };
}

/**
 * How a typed limit price relates to the live book, in whole ticks.
 *
 * Explanatory only. It is derived from the price the operator already typed and
 * never feeds back into it, so nothing here can alter the value that is signed
 * and submitted.
 */
export function relativePriceHint(input: {
  limitPrice: string; quote: BookQuote | null; tickSize: number;
}): string | null {
  const price = Number(input.limitPrice);
  if (!input.quote || !(price > 0) || !(input.tickSize > 0)) return null;
  const { bid, ask } = input.quote;
  if (!(bid > 0) || !(ask > 0)) return null;
  // Measured against the side it would rest behind: above the ask it is a
  // taker-ish buy, below the bid a taker-ish sell.
  const anchor = price >= ask ? { label: "Ask", value: ask }
    : price <= bid ? { label: "Bid", value: bid }
      : { label: price - bid <= ask - price ? "Bid" : "Ask",
          value: price - bid <= ask - price ? bid : ask };
  const ticks = Math.round((price - anchor.value) / input.tickSize);
  if (ticks === 0) return `At ${anchor.label.toLowerCase()}`;
  return `${anchor.label} ${ticks > 0 ? "+" : "−"} ${Math.abs(ticks)} `
    + `tick${Math.abs(ticks) === 1 ? "" : "s"}`;
}

function trim(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return String(Number(value.toFixed(8)));
}
