/**
 * Whether anything on this install EVALUATES what a page says is armed or
 * running.
 *
 * C-03 / C-04. Two surfaces made a claim the install could not keep:
 *
 *   /alerts           "evaluated server-side and pushed to your devices",
 *                     "1 of 1 armed", with `MA_ALERTS_ENABLED=false` — the
 *                     alert evaluator was never started;
 *   Automations       "1 running · Active" for a Paper deployment with
 *                     `LIVE_RUNNER_ENABLED` unset — the strategy runner was
 *                     never started, so the deployment emitted nothing.
 *
 * Operations on the same install said the opposite in both cases. The status
 * a row carries (`enabled`, `active`) is what the USER asked for, and it stays
 * true and editable; what changes is that the page now also says whether the
 * install will act on it. Creating and arming stay allowed: they run as soon
 * as the evaluator is turned on.
 *
 * ── Unknown is not off ─────────────────────────────────────────────────────
 *
 * Every predicate here is `=== false` / `=== "off"`. An older backend that
 * sends no `evaluation`, or a status route that failed, is UNKNOWN, and the
 * page keeps saying what it said before rather than inventing an outage.
 *
 * The server's `reason` strings name environment variables; they are operator
 * wording and never page copy (contract: provider/fixture error strings are
 * never primary copy). The sentences below are the product's.
 */
import type { MaAlert, MaAlertOptions, StrategyRunnerStatus } from "@/lib/api";
import { alertInactiveReason } from "@/lib/alerts";

/* ── Notification alerts ─────────────────────────────────────────────────── */

export const ALERT_EVALUATOR_OFF_NOTICE =
  "Alerts are saved but not evaluated on this install — the alert evaluator is turned off.";

/** The state an armed alert wears when nothing will evaluate it. */
export const ARMED_NOT_EVALUATED = "Armed · not evaluated here";

/** True only when the server SAID the evaluator is off. */
export function alertEvaluatorOff(options: Pick<MaAlertOptions, "evaluation"> | null | undefined): boolean {
  return options?.evaluation?.enabled === false;
}

/**
 * The word on an alert's state control.
 *
 * Paused and spent alerts keep their own reason — those are true whatever the
 * evaluator does. An armed alert says "Active" only where something watches.
 */
export function alertStateLabel(a: MaAlert, evaluatorOff: boolean): string {
  return alertInactiveReason(a) ?? (evaluatorOff ? ARMED_NOT_EVALUATED : "Active");
}

/** The inventory's card title. */
export function alertInventoryTitle(active: number, total: number, evaluatorOff: boolean): string {
  return `Notification alerts · ${active} of ${total} armed${evaluatorOff && active > 0 ? " · not evaluated here" : ""}`;
}

/** The Alerts page's description, which was a promise the install did not keep. */
export function alertsPageDescription(evaluatorOff: boolean): string {
  return evaluatorOff
    ? "Price levels and moving averages, saved here. This install does not evaluate them, so nothing is pushed to your devices until the alert evaluator is turned on."
    : "Price levels and moving averages, evaluated server-side and pushed to your devices — the chart does not need to be open.";
}

/* ── Strategy automations ────────────────────────────────────────────────── */

export const RUNNER_OFF_NOTICE =
  "Runner off on this install — nothing is evaluated. Active automations are kept as you set them and start acting on bar closes once the strategy runner is turned on.";

export const RUNNER_OFF_ROW = "Runner off on this install — nothing is evaluated";

/** True only when the server SAID the runner is off. */
export function runnerOff(status: StrategyRunnerStatus | null | undefined): boolean {
  return status?.state === "off";
}

/**
 * The badge an automation wears.
 *
 * `active` means the user switched it on. It is only "Active" — and only
 * counted as running — when a runner exists to run it.
 */
export function deploymentStatusLabel(
  status: string, runner: StrategyRunnerStatus | null | undefined,
): { label: string; tone: "positive" | "warning" | "neutral"; key: string } {
  if (status === "active" && runnerOff(runner)) {
    return { label: "Active · runner off", tone: "warning", key: "active-runner-off" };
  }
  if (status === "active" && runner?.state === "halted") {
    return { label: "Active · halted", tone: "warning", key: "active-halted" };
  }
  return { label: status, tone: status === "active" ? "positive" : "neutral", key: status };
}

/** The Automations page's first words. "N running" only when something runs them. */
export function automationsHeadline(activeCount: number, runner: StrategyRunnerStatus | null | undefined): string {
  if (runnerOff(runner)) return `${activeCount} active · runner off`;
  if (runner?.state === "halted") return `${activeCount} active · trading halted`;
  return `${activeCount} running`;
}

/** The chart rail's count, under the same rule. */
export function automationsRailCount(activeCount: number, runner: StrategyRunnerStatus | null | undefined): string {
  return runnerOff(runner) ? `${activeCount} active · runner off` : `${activeCount} active`;
}
