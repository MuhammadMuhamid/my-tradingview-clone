/**
 * The rules a cohort lives by, with no database: who owns what share, what a
 * member is worth, which cohort a trade belongs to, and how big an order is.
 */
import { allocate, percentOf, sum, type Units } from "./money";

export type CohortStatus = "open" | "running" | "settling" | "settled" | "cancelled";

/**
 * Members' final values: the closing value split by the capital each put in.
 * Shares are fixed when the cohort starts, so capital in is the weight, and the
 * values always add up to the closing value exactly.
 */
export function memberValues(closingValue: Units, capital: readonly Units[]): Units[] {
  return allocate(closingValue, capital);
}

/** A cohort's equity from its ledger: everything in, minus out, plus realized results. */
export function equityFrom(entries: readonly { amount: Units }[]): Units {
  return sum(entries.map((e) => e.amount));
}

/** What a member may withdraw, and why not if nothing. */
export function withdrawable(status: CohortStatus, memberValue: Units, alreadyOut: Units):
  { amount: Units } | { refused: string } {
  if (status !== "settled") {
    return { refused: status === "settling"
      ? "The cohort is settling: it's waiting for its open trades to close."
      : "Withdrawals open when the cohort has settled." };
  }
  const left = memberValue - alreadyOut;
  return left > 0n ? { amount: left } : { refused: "Nothing is left to withdraw." };
}

export interface HeldPosition {
  cohortId: string;
  cohortStatus: CohortStatus;
  symbol: string;
}

/**
 * Whether a BUY may open a position for the package's running cohort.
 *
 * Owner decision 6: while a settling cohort still holds a symbol, the new cohort
 * doesn't open that symbol. There is then only ever one position per symbol per
 * package, so a SELL has exactly one owner.
 */
export function decideBuy(input: {
  symbol: string;
  runningCohortId: string | null;
  held: readonly HeldPosition[];
}): { open: true; cohortId: string } | { open: false; reason: string } {
  if (!input.runningCohortId) return { open: false, reason: "no cohort is running" };
  const holder = input.held.find((h) => h.symbol === input.symbol);
  if (holder) {
    return { open: false, reason: holder.cohortStatus === "settling"
      ? "held by settling cohort" : "already holds this symbol" };
  }
  return { open: true, cohortId: input.runningCohortId };
}

/** The cohort a SELL closes for, or null when the package holds nothing in it. */
export function decideSell(symbol: string, held: readonly HeldPosition[]): string | null {
  return held.find((h) => h.symbol === symbol)?.cohortId ?? null;
}

/** A cohort is settled when it's past its end and holds nothing. */
export function nextStatus(input: {
  status: CohortStatus; now: Date; startsAt: Date; endsAt: Date; openTrades: number;
}): CohortStatus {
  const { status, now } = input;
  if (status === "open" && now >= input.startsAt) return "running";
  if (status === "running" && now >= input.endsAt) return input.openTrades > 0 ? "settling" : "settled";
  if (status === "settling" && input.openTrades === 0) return "settled";
  return status;
}

/**
 * The quote amount for a BUY: a set percentage of the running cohort's equity,
 * less what its open trades already hold, rounded down to a cent.
 */
export function buyQuote(input: { equity: Units; openExposure: Units; tradePercent: Units }): Units {
  const room = input.equity - input.openExposure;
  return percentOf(room < 0n ? 0n : room, input.tradePercent);
}
