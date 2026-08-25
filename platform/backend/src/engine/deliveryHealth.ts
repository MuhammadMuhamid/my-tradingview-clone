/**
 * Signal-delivery health, as a pure function of recent alert rows.
 *
 * The operator surface has to answer one question: **are the signals this
 * system produced actually reaching the bot?** Before this there was no way to
 * ask it short of reading the `alerts` table by hand, so a webhook that had
 * been failing for a day looked exactly like a quiet market.
 *
 * `X-12` is why the statuses are not collapsed into ok/not-ok: the receiver
 * answers HTTP 200 for outcomes where it placed no order, and `blocked` is a
 * distinct status precisely so "the bot refused this" is never read as "sent".
 */

export type DeliveryStatus = "pending" | "sent" | "failed" | "skipped" | "blocked";

export interface DeliveryRow {
  status: DeliveryStatus;
  /** ms since epoch. */
  firedAt: number;
  sentAt: number | null;
  attempts: number;
  httpStatus: number | null;
}

/** Worst-first, so a single state can summarise a set. */
export const DELIVERY_STATES = ["failing", "stalled", "degraded", "idle", "healthy"] as const;
export type DeliveryState = (typeof DELIVERY_STATES)[number];

export interface DeliveryHealth {
  state: DeliveryState;
  /** One sentence for an operator, naming the number that decided the state. */
  summary: string;
  windowHours: number;
  counts: Record<DeliveryStatus, number>;
  total: number;
  /** ms since epoch, or null when nothing in the window reached the bot. */
  lastSentAt: number | null;
  lastFailureAt: number | null;
  /** Alerts still pending past the grace period — fired but never resolved. */
  stuckPending: number;
  /** Deliveries that needed more than one attempt. */
  retried: number;
}

/**
 * A `pending` row older than this has not merely been slow: `deliver` retries
 * four times inside its own timeout, so nothing legitimately stays pending for
 * minutes. It means the process died between firing and recording (`BE-13`).
 */
export const PENDING_GRACE_MS = 5 * 60_000;

/** A failure rate at or above this is `failing` rather than `degraded`. */
export const FAILING_RATE = 0.5;

export function summariseDelivery(
  rows: readonly DeliveryRow[],
  opts: { now: number; windowHours: number }
): DeliveryHealth {
  const counts: Record<DeliveryStatus, number> = {
    pending: 0, sent: 0, failed: 0, skipped: 0, blocked: 0,
  };
  let lastSentAt: number | null = null;
  let lastFailureAt: number | null = null;
  let stuckPending = 0;
  let retried = 0;

  for (const row of rows) {
    counts[row.status] += 1;
    if (row.attempts > 1) retried += 1;
    if (row.status === "sent" && row.sentAt !== null) {
      lastSentAt = lastSentAt === null ? row.sentAt : Math.max(lastSentAt, row.sentAt);
    }
    if (row.status === "failed") {
      lastFailureAt = lastFailureAt === null ? row.firedAt : Math.max(lastFailureAt, row.firedAt);
    }
    if (row.status === "pending" && opts.now - row.firedAt > PENDING_GRACE_MS) stuckPending += 1;
  }

  const total = rows.length;
  const attempted = counts.sent + counts.failed;
  const failureRate = attempted === 0 ? 0 : counts.failed / attempted;

  let state: DeliveryState;
  let summary: string;
  if (stuckPending > 0) {
    // Worse than a failure: a failure is recorded, this is an unknown outcome.
    state = "stalled";
    summary =
      `${stuckPending} alert(s) fired more than ${Math.round(PENDING_GRACE_MS / 60_000)} minutes ago ` +
      "and never recorded an outcome. The order may or may not have been placed — " +
      "check /api/ops/unresolved-intents before resuming.";
  } else if (attempted > 0 && failureRate >= FAILING_RATE) {
    state = "failing";
    summary =
      `${counts.failed} of ${attempted} deliveries failed in the last ${opts.windowHours}h ` +
      `(${Math.round(failureRate * 100)}%). Signals are being produced and not reaching the bot.`;
  } else if (counts.failed > 0) {
    state = "degraded";
    summary =
      `${counts.failed} of ${attempted} deliveries failed in the last ${opts.windowHours}h. ` +
      "Delivery is working but not reliably.";
  } else if (total === 0) {
    state = "idle";
    summary = `No alerts fired in the last ${opts.windowHours}h. This is normal in a quiet market.`;
  } else {
    state = "healthy";
    summary =
      `${counts.sent} delivered, ${counts.blocked} refused by the bot, ` +
      `${counts.skipped} skipped in the last ${opts.windowHours}h.`;
  }

  return {
    state, summary, windowHours: opts.windowHours,
    counts, total, lastSentAt, lastFailureAt, stuckPending, retried,
  };
}
