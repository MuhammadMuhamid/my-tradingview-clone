/**
 * The deploy-time holdout gate (`OPT-01`).
 *
 * The selection rule that chose every live configuration gates and maximises on
 * the out-of-sample window, so OOS is a second selection criterion rather than a
 * validation set — and the analysis script that produces the deploy artifact
 * says so in its own emitted metadata: *"OOS is optimized here and is consumed;
 * forward/paper validation is mandatory."* Nothing in the pipeline enforced that
 * sentence. These scripts accepted whatever the artifact named.
 *
 * This is that enforcement. Its most important property is that **absence of a
 * holdout result is a refusal, not a pass**: the failure being prevented is a
 * configuration reaching production because nobody could tell "validated" from
 * "never checked".
 *
 * It mirrors `platform/backend/src/engine/holdout.ts` `evaluateClearance`,
 * deliberately as a standalone copy so these scripts stay runnable with nothing
 * but node inside the container. `platform/backend/tests/holdoutGate.test.mjs`
 * asserts the two agree case by case.
 */

/** What the artifact must carry per coin for that coin to be deployable. */
export function clearanceVerdict(clearance, rules) {
  if (!clearance || clearance.scoredAt === null || clearance.scoredAt === undefined) {
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
        `(${iso(clearance.holdoutStartMs)}..${iso(clearance.holdoutEndMs)}) than the one now frozen ` +
        `(${iso(rules.expected.startMs)}..${iso(rules.expected.endMs)}). ` +
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
        `the holdout net is ${clearance.netPct ?? "unknown"}%, below the minimum ${rules.minNetPct}%.`,
    };
  }
  return { cleared: true };
}

const iso = (ms) => (typeof ms === "number" ? new Date(ms).toISOString() : "unknown");

/**
 * Read the frozen window and thresholds the artifact was scored against.
 *
 * They live in the artifact rather than in this script so that the evidence and
 * the thing it certifies travel together; a window supplied at deploy time
 * could be chosen to fit.
 */
export function gateRulesFrom(report) {
  const window = report?.holdout_window;
  const rules = report?.holdout_rules;
  if (!window || typeof window.startMs !== "number" || typeof window.endMs !== "number") {
    return null;
  }
  return {
    minTrades: Number(rules?.minTrades ?? 30),
    minNetPct: Number(rules?.minNetPct ?? 0),
    expected: { startMs: window.startMs, endMs: window.endMs },
  };
}

/**
 * Refuse the whole deployment unless every configuration in it has cleared.
 *
 * Whole-deployment, not per-coin: these scripts replace the portfolio as a set,
 * and a partially-cleared portfolio is a state nobody asked for.
 */
export function assertHoldoutClearance(report, entries, script) {
  const override = process.env.HOLDOUT_GATE === "off";
  const reason = (process.env.HOLDOUT_OVERRIDE_REASON ?? "").trim();
  if (override) {
    if (!reason) {
      throw new Error(
        `${script}: HOLDOUT_GATE=off also requires HOLDOUT_OVERRIDE_REASON, ` +
        "recording why this deployment is going out without holdout evidence."
      );
    }
    console.warn(
      "\n*** HOLDOUT GATE OVERRIDDEN ***\n" +
      `reason: ${reason}\n` +
      "These configurations were selected on the same out-of-sample window that\n" +
      "is being used to justify them (OPT-01). Nothing here has been validated\n" +
      "on data no selection step read.\n"
    );
    return { cleared: false, overridden: true, reason };
  }

  const rules = gateRulesFrom(report);
  if (!rules) {
    throw new Error(
      `${script}: this deploy input carries no \`holdout_window\`, so no configuration in it ` +
      "has been scored on data that no selection step read (OPT-01). Absence of a " +
      "holdout result is not a pass.\n" +
      "Add to the deploy input:\n" +
      '  "holdout_window": { "startMs": <ms>, "endMs": <ms> },\n' +
      '  "holdout_rules":  { "minTrades": 30, "minNetPct": 0 },\n' +
      "and per coin:\n" +
      '  "holdout": { "scoredAt": <ms>, "netPct": <n>, "trades": <n>, "engine": "<id>",\n' +
      '               "holdoutStartMs": <ms>, "holdoutEndMs": <ms> }\n' +
      "To deploy without it deliberately, set HOLDOUT_GATE=off and HOLDOUT_OVERRIDE_REASON."
    );
  }

  const refused = [];
  for (const entry of entries) {
    const verdict = clearanceVerdict(entry.holdout ?? null, rules);
    if (!verdict.cleared) refused.push(`${entry.symbol}: ${verdict.reason}`);
  }
  if (refused.length) {
    throw new Error(
      `${script}: ${refused.length} of ${entries.length} configurations have not cleared ` +
      `the frozen holdout:\n  ${refused.join("\n  ")}`
    );
  }
  console.log(
    `holdout gate: all ${entries.length} configurations cleared ` +
    `${iso(rules.expected.startMs)}..${iso(rules.expected.endMs)} ` +
    `(>= ${rules.minTrades} trades, >= ${rules.minNetPct}% net).`
  );
  return { cleared: true, overridden: false };
}
