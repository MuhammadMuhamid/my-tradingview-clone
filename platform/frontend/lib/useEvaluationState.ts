"use client";
/**
 * The two "is anything evaluating this?" reads, as hooks.
 *
 * See `lib/evaluationState.ts` for why they exist and for the rule that an
 * unanswered read is UNKNOWN, never "off".
 */
import { useEffect, useState } from "react";
import { api, type MaAlertOptions, type StrategyRunnerStatus } from "@/lib/api";
import { alertEvaluatorOff } from "@/lib/evaluationState";

/**
 * `/api/ma-alerts/options`, shared.
 *
 * Every alert dialog reads it twice — the frequency field for its wording, the
 * armed field for the evaluator state — and the Alerts page reads it too. One
 * request serves them all for a minute; a failed one is forgotten at once, so
 * the next dialog asks again rather than inheriting the failure.
 */
const OPTIONS_TTL_MS = 60_000;
let optionsPromise: Promise<MaAlertOptions> | null = null;
let optionsAt = 0;

export function loadMaAlertOptions(now: number = Date.now()): Promise<MaAlertOptions> {
  if (optionsPromise !== null && now - optionsAt < OPTIONS_TTL_MS) return optionsPromise;
  optionsAt = now;
  const pending = api.maAlertOptions();
  optionsPromise = pending;
  pending.catch(() => {
    if (optionsPromise === pending) optionsPromise = null;
  });
  return pending;
}

/** For tests that change what the server answers between mounts. */
export function resetMaAlertOptionsCache(): void {
  optionsPromise = null;
  optionsAt = 0;
}

/** True only once the server has said this install does not evaluate alerts. */
export function useAlertEvaluatorOff(): boolean {
  const [off, setOff] = useState(false);
  useEffect(() => {
    let live = true;
    loadMaAlertOptions()
      .then((options) => { if (live) setOff(alertEvaluatorOff(options)); })
      // Unknown is not off: the surfaces keep their ordinary wording.
      .catch(() => { /* leave it unknown */ });
    return () => { live = false; };
  }, []);
  return off;
}

/**
 * `/api/ops/runner`, polled beside a deployment list.
 *
 * A failed poll keeps the last answer rather than clearing it: a runner that
 * was off a moment ago has not been switched on by a network blip.
 */
export function useStrategyRunner(pollMs = 15_000): StrategyRunnerStatus | null {
  const [status, setStatus] = useState<StrategyRunnerStatus | null>(null);
  useEffect(() => {
    let live = true;
    const read = () => {
      api.strategyRunnerStatus()
        .then((next) => { if (live) setStatus(next); })
        .catch(() => { /* keep what was last known */ });
    };
    read();
    const t = setInterval(read, pollMs);
    return () => { live = false; clearInterval(t); };
  }, [pollMs]);
  return status;
}
