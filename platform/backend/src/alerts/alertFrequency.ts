/**
 * Alert frequency: how often a true condition is allowed to notify.
 *
 * Four modes, and the important one is the DEFAULT. Every alert that already
 * exists was created under bar-close semantics, so `once_per_bar_close` is both
 * the default for new alerts and the migration value for old ones, and its
 * behaviour here is exactly what `maAlertRunner` did before: evaluate the
 * closed bar, fire when the cooldown window has elapsed.
 *
 * The other three are new. Two of them evaluate INTRABAR, which is a genuinely
 * different promise to the user — a condition that is true mid-candle can be
 * false again by the close — and `INTRABAR_WARNING` is the exact sentence the
 * UI must show for them.
 *
 * Everything here is pure. State goes in, a decision and the next state come
 * out, and persistence is the caller's job. That is what makes the
 * across-restart guarantees testable: the same state that goes to the database
 * is the state these functions read.
 */

export const ALERT_FREQUENCIES = [
  /**
   * Fire once, ever. After a SUCCESSFUL delivery the alert is deactivated
   * permanently — `completed` is persisted, so a restart does not revive it.
   */
  "once_only",

  /**
   * Evaluate intrabar; fire on the first true transition within each candle,
   * and never more than once for the same alert and candle.
   */
  "once_per_bar",

  /**
   * Evaluate only the final CLOSED candle. The default, and the migration value
   * for every existing alert. Behaviour is unchanged from before frequencies
   * existed.
   */
  "once_per_bar_close",

  /**
   * Evaluate intrabar; fire at most once per minute while the condition remains
   * true. The throttle is persisted, so it survives a restart.
   */
  "once_per_minute",
] as const;

export type AlertFrequency = (typeof ALERT_FREQUENCIES)[number];

export const DEFAULT_ALERT_FREQUENCY: AlertFrequency = "once_per_bar_close";

export const isAlertFrequency = (v: unknown): v is AlertFrequency =>
  typeof v === "string" && (ALERT_FREQUENCIES as readonly string[]).includes(v);

/**
 * The warning the UI shows for the intrabar modes, verbatim.
 *
 * It is a constant rather than UI copy because it is a statement about
 * behaviour, and behaviour is defined here.
 */
export const INTRABAR_WARNING =
  "May trigger before the candle closes. The condition can become false again before bar close.";

/** True for the modes that evaluate a forming candle rather than a closed one. */
export function isIntrabar(frequency: AlertFrequency): boolean {
  return frequency === "once_per_bar" || frequency === "once_per_minute";
}

/** True for the modes that must only ever see a CLOSED candle. */
export function isBarCloseOnly(frequency: AlertFrequency): boolean {
  return frequency === "once_per_bar_close";
}

/**
 * `once_only` evaluates on whichever cadence is available and fires once, so it
 * is neither strictly intrabar nor strictly bar-close. Evaluating it intrabar
 * makes it fire at the first moment the condition is true, which is what "once"
 * most naturally means for a price target.
 */
export function acceptsIntrabarSample(frequency: AlertFrequency): boolean {
  return frequency !== "once_per_bar_close";
}

/** Everything persisted about an alert's firing history. */
export interface FireState {
  /** Wall-clock ms of the last delivery, or null. */
  lastFiredAt: number | null;
  /** Open time of the bar the last delivery fired on, or null. */
  lastFiredBarTime: number | null;
  /** `once_only` has already delivered and is permanently done. */
  completed: boolean;
  /** Legacy silence window, in minutes. Applies to `once_per_bar_close` only. */
  cooldownMin: number;
}

export const initialFireState = (cooldownMin = 60): FireState => ({
  lastFiredAt: null,
  lastFiredBarTime: null,
  completed: false,
  cooldownMin,
});

export type SuppressionReason =
  | "completed"
  | "already_fired_this_bar"
  | "within_cooldown"
  | "within_minute"
  | "wrong_sample_kind";

export type FireDecision =
  | { fire: true }
  | { fire: false; reason: SuppressionReason };

const suppress = (reason: SuppressionReason): FireDecision => ({ fire: false, reason });

/**
 * Decide whether a TRUE condition may notify now.
 *
 * The caller has already established that the condition is met; this answers
 * only the frequency question. Splitting the two is what makes each testable —
 * conflating them is how "fires too often" bugs become hard to localise.
 *
 * `sampleIsClosedBar` distinguishes a closed candle from a forming one, and it
 * is checked rather than assumed: `once_per_bar_close` must never act on a
 * forming candle, and letting it would silently turn every existing alert into
 * an intrabar one.
 */
export function decideFire(
  frequency: AlertFrequency,
  state: FireState,
  ctx: { barTime: number; sampleIsClosedBar: boolean; now: number }
): FireDecision {
  // `once_only` outranks everything: a completed alert is inert regardless of
  // cadence, and this is the check that must survive a restart.
  if (frequency === "once_only" && state.completed) return suppress("completed");

  if (frequency === "once_per_bar_close" && !ctx.sampleIsClosedBar) {
    return suppress("wrong_sample_kind");
  }

  switch (frequency) {
    case "once_only":
      return { fire: true };

    case "once_per_bar":
      // One fire per candle, whatever happens inside it. This is also what makes
      // a reconnect safe: the replayed bar has the same open time.
      if (state.lastFiredBarTime === ctx.barTime) return suppress("already_fired_this_bar");
      return { fire: true };

    case "once_per_bar_close":
      // Unchanged from the pre-frequency behaviour: the cooldown window is the
      // throttle, and it is the ONLY mode the cooldown applies to. Applying a
      // 60-minute cooldown to `once_per_bar` on a 15m chart would defeat the
      // mode entirely.
      if (state.lastFiredBarTime === ctx.barTime) return suppress("already_fired_this_bar");
      if (!cooldownElapsed(state.lastFiredAt, state.cooldownMin, ctx.now)) {
        return suppress("within_cooldown");
      }
      return { fire: true };

    case "once_per_minute":
      if (state.lastFiredAt !== null && ctx.now - state.lastFiredAt < MINUTE_MS) {
        return suppress("within_minute");
      }
      return { fire: true };
  }
}

export const MINUTE_MS = 60_000;

/** The legacy cooldown test, unchanged. */
export function cooldownElapsed(
  lastFiredAt: number | null,
  cooldownMin: number,
  now: number
): boolean {
  if (lastFiredAt === null || cooldownMin <= 0) return true;
  return now - lastFiredAt >= cooldownMin * MINUTE_MS;
}

/**
 * The state to persist after a SUCCESSFUL delivery.
 *
 * "Successful" matters for `once_only`: deactivating an alert whose
 * notification never reached a device would lose the one alert the user asked
 * for. `delivered` is the caller's report of whether the push actually went
 * anywhere.
 */
export function stateAfterFire(
  frequency: AlertFrequency,
  state: FireState,
  ctx: { barTime: number; now: number; delivered: boolean }
): FireState {
  return {
    ...state,
    lastFiredAt: ctx.now,
    lastFiredBarTime: ctx.barTime,
    // Only a delivery that reached at least one device retires a once-only
    // alert. A push failure leaves it armed, which is the recoverable direction.
    completed: frequency === "once_only" ? state.completed || ctx.delivered : state.completed,
  };
}

/** Human description of a frequency, for the UI and the notification body. */
export function describeFrequency(frequency: AlertFrequency): string {
  switch (frequency) {
    case "once_only": return "Once only";
    case "once_per_bar": return "Once per bar";
    case "once_per_bar_close": return "Once per bar close";
    case "once_per_minute": return "Once per minute";
  }
}

/** The longer explanation, including the intrabar warning where it applies. */
export function explainFrequency(frequency: AlertFrequency): string {
  switch (frequency) {
    case "once_only":
      return "Triggers the first time the condition is met, then turns itself off permanently.";
    case "once_per_bar":
      return `Triggers on the first moment the condition becomes true inside each candle, at most once per candle. ${INTRABAR_WARNING}`;
    case "once_per_bar_close":
      return "Evaluates only completed candles. A condition that was true mid-candle but false at the close does not trigger.";
    case "once_per_minute":
      return `Triggers at most once a minute for as long as the condition stays true. ${INTRABAR_WARNING}`;
  }
}
