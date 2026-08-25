/**
 * Risk controls: the kill switch, the exposure cap, the concurrency cap and the
 * rolling daily-loss limit.
 *
 * A repository-wide search for `killSwitch|kill_switch|dailyLoss|maxExposure|
 * circuitBreak|maxOpenPositions` previously returned ZERO matches across both
 * repositories. The only limits that existed were per-strategy (choppy pause,
 * cooldown) and per-order (`buyQuoteQty <= 10_000`). With thirteen correlated
 * deployments across correlated coins, one market move can fire every one of
 * them on the same bar close, and there was no operator control to halt trading
 * short of pausing each deployment individually (BE-11, BOT-011).
 *
 * The decision logic here is pure. Persistence lives in
 * `repositories/riskControls.ts`; this module is what the hot signal path calls
 * and what the tests exercise.
 */

/** The operator-settable limits. `null` means "this limit is off". */
export interface RiskLimits {
  tradingHalted: boolean;
  haltedReason: string | null;
  haltedBy: HaltSource | null;
  maxTotalExposureQuote: number | null;
  maxConcurrentPositions: number | null;
  maxDailyLossQuote: number | null;
  dailyLossWindowHours: number;
}

export type HaltSource = "operator" | "daily_loss" | "exposure" | "concurrency" | "data_gap";

/** What the runner knows at the moment it is about to emit. */
export interface RiskSnapshot {
  /** Quote currency already committed across every long deployment. */
  currentExposureQuote: number;
  /** How many deployments are currently long. */
  openPositions: number;
  /** Signed realised P&L over the rolling window; negative is a loss. */
  realisedPnlInWindow: number;
}

/** The order about to be emitted. */
export interface ProposedOrder {
  action: "buy" | "sell";
  /** Quote currency this order would commit. Zero for an exit. */
  quoteQty: number;
  /** True when the deployment is already long, so a BUY would add to it. */
  alreadyLong: boolean;
}

export type RiskDecision =
  | { allowed: true }
  | { allowed: false; code: RiskBlockCode; reason: string };

export type RiskBlockCode =
  | "trading_halted"
  | "max_exposure"
  | "max_concurrent_positions"
  | "daily_loss_limit";

export const DEFAULT_RISK_LIMITS: RiskLimits = {
  tradingHalted: false,
  haltedReason: null,
  haltedBy: null,
  maxTotalExposureQuote: null,
  maxConcurrentPositions: null,
  maxDailyLossQuote: null,
  dailyLossWindowHours: 24,
};

const block = (code: RiskBlockCode, reason: string): RiskDecision =>
  ({ allowed: false, code, reason });

/**
 * The gate. Called immediately before delivery, for every emission.
 *
 * Two properties matter more than the individual limits:
 *
 *  1. **An EXIT is never blocked by a risk limit.** Every limit here exists to
 *     stop new risk being taken on. Refusing a sell because exposure is too
 *     high, or because the daily loss is too large, would trap the position
 *     that caused the problem — the opposite of what the control is for. Only
 *     an explicit operator halt stops an exit, and that is a deliberate
 *     "touch nothing" instruction.
 *
 *  2. **Every limit is opt-in.** A fresh install has them all null, so this
 *     function returns `allowed` and behaviour is unchanged until an operator
 *     configures a number.
 */
export function evaluateRisk(
  limits: RiskLimits,
  snapshot: RiskSnapshot,
  order: ProposedOrder
): RiskDecision {
  // An operator halt stops everything, entries and exits alike. It means "do
  // not touch the market", which is a different instruction from "stop taking
  // on more risk".
  if (limits.tradingHalted) {
    return block(
      "trading_halted",
      limits.haltedReason
        ? `trading is halted: ${limits.haltedReason}`
        : "trading is halted"
    );
  }

  // Exits are always permitted past this point.
  if (order.action === "sell") return { allowed: true };

  if (limits.maxDailyLossQuote !== null) {
    const loss = -Math.min(0, snapshot.realisedPnlInWindow);
    if (loss >= limits.maxDailyLossQuote) {
      return block(
        "daily_loss_limit",
        `rolling ${limits.dailyLossWindowHours}h realised loss ${loss.toFixed(2)} ` +
          `has reached the limit ${limits.maxDailyLossQuote.toFixed(2)}`
      );
    }
  }

  if (limits.maxConcurrentPositions !== null && !order.alreadyLong) {
    if (snapshot.openPositions >= limits.maxConcurrentPositions) {
      return block(
        "max_concurrent_positions",
        `${snapshot.openPositions} positions are already open, limit is ${limits.maxConcurrentPositions}`
      );
    }
  }

  if (limits.maxTotalExposureQuote !== null) {
    const after = snapshot.currentExposureQuote + order.quoteQty;
    if (after > limits.maxTotalExposureQuote) {
      return block(
        "max_exposure",
        `this order would take exposure to ${after.toFixed(2)}, limit is ` +
          `${limits.maxTotalExposureQuote.toFixed(2)}`
      );
    }
  }

  return { allowed: true };
}

/**
 * Should the daily-loss breach trip the kill switch, rather than just refuse
 * this one order?
 *
 * Refusing order after order while the loss stands means the operator finds out
 * from a log rather than from the state of the system. A breach latches the
 * switch, and clearing it is a deliberate action.
 */
export function shouldLatchHalt(decision: RiskDecision): HaltSource | null {
  if (decision.allowed) return null;
  return decision.code === "daily_loss_limit" ? "daily_loss" : null;
}

/**
 * Total quote currency committed by the deployments that are currently long.
 *
 * `buyQuoteQty` is what the platform asked the receiver to spend, which is the
 * only figure the platform actually knows. The receiver's own sizing can differ
 * — its `maxInvestmentPct` may cap the order below what was requested — so this
 * is an upper bound on platform-intended exposure, not a reading of the
 * exchange. It is named as an intent for that reason.
 */
export function intendedExposure(
  deployments: { position: "flat" | "long"; buyQuoteQty: number | null }[]
): number {
  return deployments
    .filter((d) => d.position === "long")
    .reduce((sum, d) => sum + (d.buyQuoteQty ?? 0), 0);
}

export function countOpenPositions(
  deployments: { position: "flat" | "long" }[]
): number {
  return deployments.filter((d) => d.position === "long").length;
}

/** Sum realised P&L inside the rolling window. Negative is a loss. */
export function realisedPnlInWindow(
  rows: { closedAt: number; pnlQuote: number }[],
  windowHours: number,
  now = Date.now()
): number {
  const cutoff = now - windowHours * 3_600_000;
  return rows
    .filter((r) => r.closedAt >= cutoff)
    .reduce((sum, r) => sum + r.pnlQuote, 0);
}

/** One-line operator summary, for the health surface and the logs. */
export function describeRiskState(limits: RiskLimits, snapshot: RiskSnapshot): string {
  if (limits.tradingHalted) {
    return `HALTED${limits.haltedBy ? ` (${limits.haltedBy})` : ""}${
      limits.haltedReason ? `: ${limits.haltedReason}` : ""
    }`;
  }
  const parts: string[] = [];
  parts.push(
    `exposure ${snapshot.currentExposureQuote.toFixed(2)}` +
      (limits.maxTotalExposureQuote !== null ? `/${limits.maxTotalExposureQuote.toFixed(2)}` : "")
  );
  parts.push(
    `positions ${snapshot.openPositions}` +
      (limits.maxConcurrentPositions !== null ? `/${limits.maxConcurrentPositions}` : "")
  );
  const loss = -Math.min(0, snapshot.realisedPnlInWindow);
  parts.push(
    `${limits.dailyLossWindowHours}h loss ${loss.toFixed(2)}` +
      (limits.maxDailyLossQuote !== null ? `/${limits.maxDailyLossQuote.toFixed(2)}` : "")
  );
  return `LIVE — ${parts.join(", ")}`;
}
