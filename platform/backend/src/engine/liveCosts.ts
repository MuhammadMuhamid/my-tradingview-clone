/**
 * The round-trip cost the LIVE path must apply when deciding whether a closed
 * trade was a win.
 *
 * `BE-15`: the live evaluators determined win/loss as `exitPrice > entryPrice`
 * — gross — while the backtest reads `broker.closed[…].pnl`, which is NET of
 * commission. A +0.03 % gross exit was therefore a WIN live and a LOSS in the
 * backtest. That flag drives `consecLosses`, which drives the choppy-pause
 * circuit breaker, which decides which later trades are taken at all: the two
 * take different trade sets from the same data, for no reason other than a
 * missing fee.
 *
 * `X-09`: the figure itself was contradicted three ways. Measured from every
 * `config.json`, every optimizer tree runs **0.1 % per side**, so 0.2 % round
 * trip. `OPTIMIZATION_SYSTEM_BLUEPRINT.md` said 0.05 %, `CLAUDE_HANDOFF.md`
 * said 0.1 % with zero slippage, and the backtest API defaulted to 0.05 %.
 * `docs/COST-MODELS.md` records what actually ran, and this constant is the
 * live path's single reference to it.
 */

/**
 * Commission per fill, in percent. Binance spot taker is 0.1 %, which is what
 * every research tree uses.
 *
 * Overridable so an account on a lower fee tier is not forced to model a cost
 * it does not pay — but the DEFAULT matches the research, because a live path
 * that assumes cheaper fills than the backtest is the more dangerous direction
 * to be wrong in.
 */
export const LIVE_COMMISSION_PCT_PER_SIDE = (() => {
  const raw = process.env.PLATFORM_COMMISSION_PCT;
  if (raw === undefined) return 0.1;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 5) {
    throw new Error(
      `PLATFORM_COMMISSION_PCT must be a percentage between 0 and 5, got ${JSON.stringify(raw)}`
    );
  }
  return parsed;
})();

/** Both fills, as a fraction: 0.1 % per side is 0.002. */
export const roundTripCostFraction = (commissionPctPerSide = LIVE_COMMISSION_PCT_PER_SIDE): number =>
  (commissionPctPerSide / 100) * 2;

/**
 * Was this trade a win after costs?
 *
 * The comparison mirrors the broker: commission is charged on the notional of
 * each fill, so the break-even exit is the entry marked up by the round-trip
 * cost. A trade that exits exactly at break-even is NOT a win, which is the
 * same convention the backtest's `pnl > 0` test applies.
 */
export function isNetWin(
  entryPrice: number,
  exitPrice: number,
  commissionPctPerSide = LIVE_COMMISSION_PCT_PER_SIDE
): boolean {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return false;
  if (!Number.isFinite(exitPrice)) return false;
  // The epsilon is not cosmetic. `((100.2 - 100) / 100) * 100 - 0.2` does not
  // evaluate to exactly zero in binary floating point, and its SIGN varies with
  // the operands — so an exit landing on break-even would be classified as a
  // win or a loss unpredictably. Since that flag drives the choppy-pause
  // circuit breaker, "unpredictable" would mean two runs over identical data
  // taking different trades. A trade within a rounding error of break-even is
  // not a win.
  return netPnlPct(entryPrice, exitPrice, commissionPctPerSide) > NET_WIN_EPSILON_PCT;
}

/** Percentage points below which a result is treated as break-even, not a win. */
export const NET_WIN_EPSILON_PCT = 1e-9;

/**
 * Net percentage return on the entry notional, after both commissions.
 *
 * `(exit - entry) / entry` less the round-trip cost. This is the quantity the
 * run-limit streak tracker accumulates, and it was previously gross there too.
 */
export function netPnlPct(
  entryPrice: number,
  exitPrice: number,
  commissionPctPerSide = LIVE_COMMISSION_PCT_PER_SIDE
): number {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return 0;
  const gross = ((exitPrice - entryPrice) / entryPrice) * 100;
  return gross - commissionPctPerSide * 2;
}

/** The exit price at which a trade breaks even after both commissions. */
export function breakEvenExit(
  entryPrice: number,
  commissionPctPerSide = LIVE_COMMISSION_PCT_PER_SIDE
): number {
  return entryPrice * (1 + roundTripCostFraction(commissionPctPerSide));
}
