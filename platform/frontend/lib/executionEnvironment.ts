/**
 * One label and one colour per execution environment, for every surface that
 * names one: the Journal's row badges and cards, and the chart's trading-state
 * chip. The same word must never wear opposite colours on two screens.
 *
 * The colour answers one question — could this be real money?
 *   - `warn` (contract §2: honest degradation): REAL, and UNKNOWN, which may be.
 *   - neutral but solid: TESTNET and DRY RUN, which cannot be.
 *
 * Tones are colour classes only (border colour, ground, ink); each surface
 * keeps its own shape (pill, chip) and adds `border` itself.
 */
export type ExecutionEnvironmentWord = "REAL" | "TESTNET" | "DRY_RUN" | "UNKNOWN";

export const WARN_TONE = "border-warn/40 bg-warn/15 text-warn";
export const NOT_REAL_TONE = "border-border-strong bg-surface-2 text-ink";

export const EXECUTION_ENVIRONMENT_LABEL: Record<ExecutionEnvironmentWord, string> = {
  REAL: "REAL", TESTNET: "TESTNET", DRY_RUN: "DRY RUN", UNKNOWN: "UNKNOWN",
};

export const EXECUTION_ENVIRONMENT_TONE: Record<ExecutionEnvironmentWord, string> = {
  REAL: WARN_TONE, UNKNOWN: WARN_TONE, TESTNET: NOT_REAL_TONE, DRY_RUN: NOT_REAL_TONE,
};
