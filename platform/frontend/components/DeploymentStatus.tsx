"use client";
import { StatusBadge } from "@/components/ui";
import type { StrategyRunnerStatus } from "@/lib/api";
import { deploymentStatusLabel, RUNNER_OFF_ROW, runnerOff } from "@/lib/evaluationState";

/**
 * An automation's status badge, told whether a runner exists to run it.
 *
 * C-04: a green "Active" on an install whose strategy runner never started
 * read as "this is trading" when nothing evaluated it. The deployment's own
 * status is unchanged; the badge just stops claiming the part that is false.
 */
export function DeploymentStatusBadge({ status, runner }: {
  status: string;
  runner: StrategyRunnerStatus | null;
}) {
  const shown = deploymentStatusLabel(status, runner);
  if (shown.tone !== "warning") return <StatusBadge status={status} />;
  return (
    <span
      data-deployment-status={shown.key}
      className="inline-flex items-center rounded-full border border-warn/30 bg-warn/15 px-2 py-0.5 text-xs font-medium text-warn"
    >
      {shown.label}
    </span>
  );
}

/** The quiet line under an active automation's row when nothing runs it. */
export function RunnerOffRowNote({ status, runner }: {
  status: string;
  runner: StrategyRunnerStatus | null;
}) {
  if (status !== "active" || !runnerOff(runner)) return null;
  return <span className="text-warn" data-runner-off-row>{RUNNER_OFF_ROW}</span>;
}
