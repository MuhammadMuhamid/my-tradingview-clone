/**
 * The frozen final holdout, and the guard that keeps selection out of it.
 *
 * `OPT-01` is the most consequential research finding in the audit, and the
 * chain to real money was traced end to end. `lean_optimizer15m/BEST_CONFIGS.md`
 * records the selection rule as:
 *
 *     gates    : >=50 IS trades, >=30 OOS trades, net > 0 on BOTH sides,
 *                profit factor >= 1.10 on BOTH sides, drawdown <= 3% on BOTH
 *     maximise : min(WR_is, WR_oos)
 *
 * Every one of those reads the out-of-sample window. So OOS is not a validation
 * set for anything deployed — it is a second selection criterion, and the
 * reported IS/OOS agreement is a selection artefact rather than evidence of
 * robustness. The analysis script that produces the deploy artifact says so
 * itself in its own emitted metadata: *"OOS is optimized here and is consumed;
 * forward/paper validation is mandatory."* Nothing in the pipeline enforced that
 * sentence.
 *
 * Corroborating evidence, all from inside the repository:
 *   * `holdout1h/HOLDOUT_REPORT.md` — mean rank correlation between in-sample
 *     leaderboard rank and out-of-sample net is **+0.03**.
 *   * `lean_optimizer15m/BEST_CONFIGS.md` — 9 of 15 deployed coins are tier-C,
 *     one with **4** surviving configs out of ~206,600 candidates.
 *
 * ── What this module does ─────────────────────────────────────────────────
 *
 * It defines a THIRD window that no selection step may read, and a guard that
 * refuses when one tries. The window is derived from the tree's own configured
 * range so it cannot be quietly moved, and the guard is a hard error rather
 * than a warning — `OPT-05` records that the leaderboard CLI already prints a
 * warning about OOS leakage and offers eight ways to do it anyway.
 *
 * This module does NOT re-run anything or change a stored number. It makes the
 * leak refusable.
 */

/** How the three windows divide a tree's range. */
export interface WindowSplit {
  /** In-sample: the GA searches here. */
  inSample: { startMs: number; endMs: number };
  /** Out-of-sample: currently also selected on. Named honestly. */
  outOfSample: { startMs: number; endMs: number };
  /**
   * The frozen holdout. No selection step may read it. Scoring here is
   * permitted exactly once, as a final report.
   */
  holdout: { startMs: number; endMs: number };
}

export type WindowName = "inSample" | "outOfSample" | "holdout";

/**
 * Divide a range into in-sample, out-of-sample and a frozen holdout.
 *
 * The holdout is taken from the END of the range, because that is the only
 * portion whose price action cannot have influenced anything already selected.
 * Carving it from the middle would leave later data that selection had already
 * seen, which is the defect rather than the fix.
 *
 * `holdoutFraction` defaults to 0.2 — a fifth of the range. The figure is a
 * research-policy decision, not an engineering one (`M8`), and it is a
 * parameter for that reason.
 */
export function splitWindows(
  range: { startMs: number; endMs: number },
  opts: { splitMs?: number; holdoutFraction?: number } = {}
): WindowSplit {
  const { startMs, endMs } = range;
  if (!(endMs > startMs)) {
    throw new Error(`invalid range: ${startMs}..${endMs}`);
  }
  const fraction = opts.holdoutFraction ?? 0.2;
  if (!(fraction > 0 && fraction < 1)) {
    throw new Error(`holdoutFraction must be strictly between 0 and 1, got ${fraction}`);
  }

  const total = endMs - startMs;
  const holdoutStart = endMs - Math.floor(total * fraction);
  // The IS/OOS split defaults to the midpoint of what remains.
  const split = opts.splitMs ?? startMs + Math.floor((holdoutStart - startMs) / 2);

  if (!(split > startMs && split < holdoutStart)) {
    throw new Error(
      `the IS/OOS split ${new Date(split).toISOString()} must fall strictly inside ` +
      `${new Date(startMs).toISOString()}..${new Date(holdoutStart).toISOString()} ` +
      "(the range less the frozen holdout)"
    );
  }

  return {
    inSample: { startMs, endMs: split },
    outOfSample: { startMs: split, endMs: holdoutStart },
    holdout: { startMs: holdoutStart, endMs },
  };
}

/** What a caller is doing with a window. Only `report` may touch the holdout. */
export type WindowPurpose =
  /** Searching, ranking, gating, filtering, sorting — anything that CHOOSES. */
  | "select"
  /** Producing a final number for a human to read, after selection is closed. */
  | "report";

export class HoldoutLeakError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HoldoutLeakError";
  }
}

/**
 * Refuse to read the frozen holdout for the purpose of selecting.
 *
 * Deliberately a THROW. `OPT-05` records that
 * `scripts/indexed_results.py` already prints a warning about out-of-sample
 * leakage, next to seven OOS sort modes each ending with a
 * one-keystroke "Apply one" command. A warning next to an easier path is not a
 * control.
 */
export function assertWindowUsage(window: WindowName, purpose: WindowPurpose): void {
  if (window === "holdout" && purpose === "select") {
    throw new HoldoutLeakError(
      "the frozen holdout must not be read while selecting a configuration. " +
      "It exists so that ONE number about a chosen config is honest; scoring " +
      "candidates against it makes that number a selection artefact, which is " +
      "exactly what happened to the out-of-sample window (OPT-01). " +
      "Use `purpose: \"report\"` only after selection is closed."
    );
  }
}

/** Which window a timestamp falls in, or null when it is outside the range. */
export function windowOf(split: WindowSplit, ms: number): WindowName | null {
  if (ms >= split.inSample.startMs && ms < split.inSample.endMs) return "inSample";
  if (ms >= split.outOfSample.startMs && ms < split.outOfSample.endMs) return "outOfSample";
  if (ms >= split.holdout.startMs && ms < split.holdout.endMs) return "holdout";
  return null;
}

/**
 * Whether a configuration has cleared the frozen holdout.
 *
 * The deploy scripts (`replace_*.mjs`) currently accept whatever the selection
 * artifact names. This is the shape of the gate they should apply: a config with
 * no holdout record has not been validated, and "not validated" must not read as
 * "passed".
 */
export interface HoldoutClearance {
  configId: string;
  /** Null when the holdout has never been scored for this config. */
  scoredAt: number | null;
  netPct: number | null;
  trades: number | null;
  engine: string | null;
  /** The window that was scored, so a moved holdout is detectable. */
  holdoutStartMs: number | null;
  holdoutEndMs: number | null;
}

export interface ClearanceRules {
  minTrades: number;
  minNetPct: number;
  /** The holdout the clearance must have been scored against. */
  expected: { startMs: number; endMs: number };
}

export type ClearanceVerdict =
  | { cleared: true }
  | { cleared: false; reason: string };

/**
 * Decide whether a config may be deployed on its holdout record.
 *
 * Every refusal names what is missing rather than returning a bare false: the
 * failure mode being prevented is a config reaching production because nobody
 * could tell "passed" from "never checked".
 */
export function evaluateClearance(
  clearance: HoldoutClearance | null,
  rules: ClearanceRules
): ClearanceVerdict {
  if (clearance === null || clearance.scoredAt === null) {
    return {
      cleared: false,
      reason:
        "no frozen-holdout result exists for this config. Absence of a result is " +
        "not a pass — score it on the holdout once, then deploy.",
    };
  }
  if (
    clearance.holdoutStartMs !== rules.expected.startMs ||
    clearance.holdoutEndMs !== rules.expected.endMs
  ) {
    return {
      cleared: false,
      reason:
        "the holdout result was scored against a DIFFERENT window " +
        `(${isoOrNull(clearance.holdoutStartMs)}..${isoOrNull(clearance.holdoutEndMs)}) ` +
        `than the one now frozen ` +
        `(${new Date(rules.expected.startMs).toISOString()}..` +
        `${new Date(rules.expected.endMs).toISOString()}). ` +
        "A holdout that moves is not a holdout.",
    };
  }
  if ((clearance.trades ?? 0) < rules.minTrades) {
    return {
      cleared: false,
      reason:
        `the holdout produced ${clearance.trades ?? 0} trade(s), below the minimum ` +
        `${rules.minTrades}. Too few trades to distinguish edge from noise.`,
    };
  }
  if ((clearance.netPct ?? -Infinity) < rules.minNetPct) {
    return {
      cleared: false,
      reason:
        `the holdout net is ${clearance.netPct ?? "unknown"}%, below the minimum ` +
        `${rules.minNetPct}%.`,
    };
  }
  return { cleared: true };
}

const isoOrNull = (ms: number | null): string =>
  ms === null ? "unknown" : new Date(ms).toISOString();
