/**
 * Telling one kind of refusal from another, in the operator's own words.
 *
 * ── Why a classifier and not just an error string ───────────────────────────
 *
 * "Rejected" is not an answer. An operator looking at a refused order needs to
 * know which system refused it, because the response differs completely:
 *
 *   shariah   — policy. The asset is not ELIGIBLE. Nothing is wrong with the
 *               order, the account or the exchange, and retrying will not help.
 *   auth      — the Platform could not prove itself to the execution bot. A
 *               configuration problem, not a trading one.
 *   risk      — the bot's own limits refused it. Operator-set, and adjustable.
 *   halt      — someone stopped trading deliberately.
 *   exchange  — Binance refused or was unreachable. Usually retryable.
 *
 * The distinction matters most for the first one. A Shariah refusal that reads
 * like an exchange error invites the operator to retry it, and to conclude the
 * gate is flaky rather than working.
 *
 * ── Where the evidence comes from ───────────────────────────────────────────
 *
 * The durable records that already exist — the execution bot's own manual order
 * rows, with the status and error text it recorded. Nothing here writes, and
 * nothing here is a second event store; this only reads what the bot already
 * kept and says what it means.
 */
import type { ManualOrder } from "./api";

export type RefusalClass = "shariah" | "auth" | "risk" | "halt" | "exchange" | "unknown";

export interface TradeEventView {
  id: string;
  symbol: string;
  side: string;
  /** Submitted, filled, cancelled, rejected — the lifecycle, not the reason. */
  status: string;
  at: string;
  /** Present only when the order did not proceed. */
  refusal: { class: RefusalClass; label: string; detail: string } | null;
}

const REFUSAL_LABELS: Record<RefusalClass, string> = {
  shariah: "Shariah policy",
  auth: "Authentication",
  risk: "Risk limit",
  halt: "Operator halt",
  exchange: "Exchange",
  unknown: "Rejected",
};

/**
 * Classify a refusal from what the bot recorded.
 *
 * Shariah is matched on the contract's own bounded rejection codes rather than
 * on prose, so a reworded message cannot silently reclassify a policy refusal
 * as something retryable. The remaining classes fall back to phrase matching,
 * which is why `unknown` exists and is not treated as "probably the exchange".
 */
export function classifyRefusal(detail: string | null | undefined): RefusalClass {
  if (!detail) return "unknown";
  const text = detail.toUpperCase();
  if (text.includes("SHARIAH")) return "shariah";
  if (/\b(401|UNAUTHORI[SZ]ED|SIGNATURE|HMAC|NONCE)\b/.test(text)) return "auth";
  if (text.includes("HALT")) return "halt";
  if (/\b(RISK|LIMIT EXCEEDED|MAX (ENTRY|ACTIVE|EXPOSURE)|EXPOSURE)\b/.test(text)) return "risk";
  if (/\b(BINANCE|EXCHANGE|INSUFFICIENT|LOT_SIZE|MIN_NOTIONAL|PRICE_FILTER|-\d{4})\b/.test(text)) {
    return "exchange";
  }
  return "unknown";
}

/** Whether this order represents something that did NOT proceed. */
export function isRefused(order: Pick<ManualOrder, "status" | "error">): boolean {
  return order.status === "rejected" || order.status === "error"
    || (order.status === "canceled" && Boolean(order.error));
}

export function toTradeEvent(order: ManualOrder): TradeEventView {
  const refused = isRefused(order);
  const detail = order.error ?? "";
  const refusalClass = refused ? classifyRefusal(detail) : "unknown";
  return {
    id: order.id,
    symbol: order.symbol,
    side: order.side,
    status: order.status,
    at: order.createdAt,
    refusal: refused
      ? { class: refusalClass, label: REFUSAL_LABELS[refusalClass], detail }
      : null,
  };
}

/** Tailwind classes per refusal class, so policy never looks like a fault. */
export const REFUSAL_TONE: Record<RefusalClass, string> = {
  shariah: "border-accent/50 bg-accent/10 text-accent",
  auth: "border-warn/50 bg-warn/10 text-warn",
  risk: "border-warn/50 bg-warn/10 text-warn",
  halt: "border-warn/50 bg-warn/10 text-warn",
  exchange: "border-down/50 bg-down/10 text-down",
  unknown: "border-down/50 bg-down/10 text-down",
};
