/**
 * Whether THIS install evaluates notification alerts at all.
 *
 * One predicate, read by the three places that need it: the start-up gate in
 * `src/index.ts` that decides whether the `MaAlertRunner` is constructed, the
 * Operations status, and `/api/ma-alerts/options`, which the alert dialogs and
 * the Alerts page read. C-03: the first two knew the evaluator was off and the
 * third did not, so /alerts said "evaluated server-side and pushed to your
 * devices" and "1 of 1 armed" on an install where nothing was evaluated, while
 * /operations on the same install said the opposite.
 *
 * Opt-OUT, deliberately unlike the strategy runner: alerts only notify, so an
 * install runs them unless told not to. Changing that default belongs in one
 * place, and this is it.
 */
export interface AlertEvaluation {
  enabled: boolean;
  /** For operators. The UI writes its own sentence and never shows this as copy. */
  reason: string | null;
}

export const ALERT_EVALUATOR_DISABLED_REASON =
  "MA_ALERTS_ENABLED is false; notification alerts are intentionally disabled.";

export function alertEvaluation(env: NodeJS.ProcessEnv = process.env): AlertEvaluation {
  return env.MA_ALERTS_ENABLED === "false"
    ? { enabled: false, reason: ALERT_EVALUATOR_DISABLED_REASON }
    : { enabled: true, reason: null };
}
