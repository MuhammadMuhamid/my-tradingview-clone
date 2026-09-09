/**
 * ════════════════════════════════════════════════════════════════════════════
 *  ENGINE CORRECTIONS — EXPLICIT, VERSIONED, AND CORRECT BY DEFAULT
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Several audit findings are corrections to the BACKTEST engine, and every one
 * of them changes what a historical number means. The generated result data is
 * gitignored and absent from clones (`OPT-08`), so it cannot be recomputed here
 * — and half-corrected leaderboards are worse than uncorrected ones, because
 * the two cannot be told apart.
 *
 * Each correction is named and fingerprinted. New work always defaults to the
 * complete corrected set. The pre-FC1 baseline remains available only through
 * the explicit `legacy-baseline` selector so historical results can be
 * reproduced without ever being mistaken for acceptable new evidence.
 *
 * ── Why retain a legacy selector ──────────────────────────────────────────
 *
 * Correcting defaults must not silently relabel stored numbers. The explicit
 * selector can reproduce an old result for diagnosis; the production runner
 * rejects it, and a corrected result must be recomputed into a clean window.
 *
 * ── Selection ─────────────────────────────────────────────────────────────
 *
 *   ENGINE_CORRECTIONS=netAvgTrade,exchangeFilters,leanWarmupFloor
 *
 * or `ENGINE_CORRECTIONS=all`. `ENGINE_CORRECTIONS=legacy-baseline` is for
 * quarantined reproduction only. `describeCorrections()` renders the active set
 * for a report header, and `correctionsFingerprint()` is what gets stored
 * alongside a result.
 */

/** Every correction, with what it changes and what it invalidates. */
export const CORRECTION_KEYS = [
  /**
   * FC1-B1 — the executable live architecture observes protective touches only
   * after a candle closes and then submits a Spot MARKET sell. It cannot fill
   * historically at the earlier stop/target trigger. With this correction,
   * bracket touches retain their reason/trigger but fill at that candle's close
   * (plus configured adverse slippage), which is the executable non-native
   * protection model. Native Binance protection remains disabled and unverified.
   */
  "executableCloseFills",
  /**
   * `BE-05` — `avgTradePct` is the mean of `pnlPct`, and `pnlPct` is computed
   * from raw price change while every neighbouring metric is net of commission.
   * At 0.1 % per side that overstates per-trade edge by ~0.2 percentage points,
   * which on a strategy averaging +0.3 %/trade is most of the edge.
   *
   * Changes historical results: THAT METRIC ONLY.
   */
  "netAvgTrade",

  /**
   * `BE-07` — `stepSize` and `minNotional` are fetched from exchangeInfo and
   * stored in the symbols table, and read by nothing. The broker books
   * partial-take-profit legs the exchange would reject outright.
   *
   * Changes historical results: YES, and unpredictably — a rejected leg changes
   * the whole subsequent trade sequence.
   */
  "exchangeFilters",

  /**
   * `BE-09` — `ma_rr_v9` applies a 1500-bar floor before ratcheting indicators
   * are trusted; `mtf_lean` has none, so its recursive indicators are seeded
   * from whatever the loaded window happens to start at. Re-running after the
   * candle table gains history silently changes which trades were taken.
   *
   * Changes historical results: YES, slightly, and it makes them reproducible.
   */
  "leanWarmupFloor",

  /**
   * `BE-10` — a trade closing at exactly zero P&L is counted as a LOSS,
   * because the test is `pnl > 0`. Definitional rather than wrong, but it
   * inflates `losingTrades` and deflates `winRatePct`.
   *
   * Changes historical results: only where an exact-zero trade exists.
   */
  "zeroPnlIsScratch",

  /**
   * `BE-06` — `computeSegmentMetrics` is valid ONLY under fixed-cash sizing,
   * a precondition stated in a comment and never asserted, while
   * `qty_pct_equity` is a live searchable parameter. It also attributes a
   * boundary-straddling trade by ENTRY time, so a trade opened in-sample and
   * closed out-of-sample counts wholly as in-sample.
   *
   * Changes historical results: the recorded IS/OOS split only. With the flag
   * on, an invalid combination THROWS rather than producing a meaningless
   * number.
   */
  "assertSegmentValidity",

  /**
   * `BE-04` — the entry bar is unprotected. `broker.ts` makes bracket legs
   * active one bar after issue, and `ma_rr_v9`/`srtrend_v10` gate bracket issue
   * on `pos > 0`, which is read AFTER the fill — so on the fill bar the
   * brackets are issued with `issuedBar = i` and only become active at `i+1`,
   * leaving the fill bar with no stop and no target. The tier-touch latches
   * still fire on that bar, permanently cancelling a partial that was never
   * taken. `mtf_lean/index.ts` already gets this right with
   * `(pos > 0 || longSignal)`.
   *
   * Changes historical results: YES — every `ma_rr_v9` and `srtrend_v10`
   * leaderboard number moves.
   */
  "entryBarBrackets",

  /**
   * Bar magnifier. When a stop and a target both sit inside one bar's range,
   * which filled first is unknowable from OHLC alone, and the broker resolves
   * it with TradingView's heuristic: a green bar is walked open → low → high,
   * a red bar open → high → low. That is a guess, and on a partial-TP
   * configuration it decides whether the trade booked +2R or −1R.
   *
   * With this on, and a finer feed available, the broker walks the ACTUAL
   * sub-bar path instead. The ambiguity does not vanish — it shrinks to one
   * sub-bar — and what remains is resolved by the same heuristic, now over a
   * minute rather than an hour.
   *
   * Deterministic: for a given chart bar and sub-bar sequence the fills are
   * fully determined, with no randomness and no tie-breaking by insertion
   * order. Where no finer feed is loaded the behaviour is bit-for-bit the old
   * one.
   *
   * Changes historical results: YES, on any bar where a stop and a target were
   * both touched.
   */
  "barMagnifier",
] as const;

export type CorrectionKey = (typeof CORRECTION_KEYS)[number];

export type CorrectionSet = Readonly<Record<CorrectionKey, boolean>>;

const NONE: CorrectionSet = Object.freeze(
  Object.fromEntries(CORRECTION_KEYS.map((k) => [k, false])) as Record<CorrectionKey, boolean>
);

const ALL: CorrectionSet = Object.freeze(
  Object.fromEntries(CORRECTION_KEYS.map((k) => [k, true])) as Record<CorrectionKey, boolean>
);

export const noCorrections = (): CorrectionSet => NONE;
export const allCorrections = (): CorrectionSet => ALL;

/**
 * Parse the flag list.
 *
 * Deliberately strict: an unrecognised name THROWS rather than being ignored.
 * A typo that silently disabled a correction someone believed was on would
 * reintroduce exactly the ambiguity this module exists to remove.
 */
export function parseCorrections(raw: string | undefined | null): CorrectionSet {
  const value = (raw ?? "").trim();
  if (!value) return ALL;
  if (value.toLowerCase() === "none" || value.toLowerCase() === "legacy-baseline") return NONE;
  if (value.toLowerCase() === "all") return ALL;

  const requested = value.split(",").map((s) => s.trim()).filter(Boolean);
  const known = new Set<string>(CORRECTION_KEYS);
  const unknown = requested.filter((r) => !known.has(r));
  if (unknown.length > 0) {
    throw new Error(
      `unknown engine correction(s): ${unknown.join(", ")}. ` +
      `Valid keys: ${CORRECTION_KEYS.join(", ")} (or "all"/"none").`
    );
  }
  const set = { ...NONE } as Record<CorrectionKey, boolean>;
  for (const key of requested) set[key as CorrectionKey] = true;
  return Object.freeze(set);
}

/** The process-wide set, read once at import. Default: all corrected semantics. */
export const ACTIVE_CORRECTIONS: CorrectionSet = parseCorrections(process.env.ENGINE_CORRECTIONS);

/** Stable, sorted list of what is on. `"none"` when nothing is. */
export function activeCorrectionKeys(set: CorrectionSet = ACTIVE_CORRECTIONS): CorrectionKey[] {
  return CORRECTION_KEYS.filter((k) => set[k]);
}

/**
 * The identity to store alongside any result produced under this engine.
 *
 * A stored number that does not say which engine produced it is exactly how the
 * cost-model confusion in `X-09` became unresolvable, so every result gets one.
 */
export function correctionsFingerprint(set: CorrectionSet = ACTIVE_CORRECTIONS): string {
  const active = activeCorrectionKeys(set);
  return active.length === 0 ? "engine:legacy-baseline:quarantined" : `engine:v2-corrected:${active.join("+")}`;
}

/** Human-readable, for a report header or a log line at boot. */
export function describeCorrections(set: CorrectionSet = ACTIVE_CORRECTIONS): string {
  const active = activeCorrectionKeys(set);
  if (active.length === 0) {
    return "engine corrections: LEGACY BASELINE (QUARANTINED; reproduction only; not acceptable for new results)";
  }
  return `engine v2 corrected semantics: ${active.join(", ")} — legacy histories require explicit recomputation`;
}

/** Legacy results may be inspected/reproduced, never accepted as new evidence. */
export function assertCorrectedEngine(set: CorrectionSet = ACTIVE_CORRECTIONS): void {
  const missing = CORRECTION_KEYS.filter((key) => !set[key]);
  if (missing.length > 0) {
    throw new Error(
      `legacy/partial engine semantics are quarantined and cannot produce new accepted work; ` +
      `missing corrections: ${missing.join(", ")}. Recompute with ENGINE_CORRECTIONS=all.`
    );
  }
}

/**
 * Corrections whose expected behaviour depends on resolving `BE-08`.
 *
 * `BE-08` is the contradiction between `mtf.ts`'s header comment (higher-TF
 * cutoff at the chart bar's OPEN time) and its implementation (cutoff at the
 * chart bar's CLOSE for all timeframes). Settling it needs a side-by-side
 * TradingView comparison, which this workspace cannot run — no TradingView
 * account, and `platform/backend/parity/` is gitignored and absent from every
 * clone, so the artifacts the header claims to have been verified against do
 * not exist here.
 *
 * Nothing in this list may be enabled until that is answered, because each
 * would bake one convention into a number without evidence for it.
 */
export const BE08_DEPENDENT: readonly CorrectionKey[] = Object.freeze([]);

/**
 * Guard for the corrections that are gated on BE-08.
 *
 * Currently empty by design: the corrections implemented here were chosen
 * precisely because their expected behaviour does NOT depend on the disputed
 * convention. `entryBarBrackets`, for instance, is about when a bracket becomes
 * active relative to its own fill bar — a question about `broker.ts`, not about
 * `mtf.ts`. The list and this guard exist so that a future correction which IS
 * dependent cannot be added without declaring it.
 */
export function assertNotBe08Dependent(set: CorrectionSet = ACTIVE_CORRECTIONS): void {
  const blocked = BE08_DEPENDENT.filter((k) => set[k]);
  if (blocked.length > 0) {
    throw new Error(
      `these corrections depend on resolving BE-08 and must not be enabled yet: ` +
      `${blocked.join(", ")}. See docs/RESEARCH-METHODOLOGY.md.`
    );
  }
}
