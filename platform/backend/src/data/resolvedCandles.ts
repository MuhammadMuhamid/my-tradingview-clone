/**
 * Serving a chart the resolution it asked for.
 *
 * The candle store holds native Binance intervals and nothing else — see
 * `types/market.ts`. A chart may sit on a resolution the store does not hold
 * (30 seconds, 45 minutes, 3 hours), and this is the only place that turns one
 * into the other.
 *
 * Why here and not in the route: three surfaces need the same answer. The
 * chart's history request, the Pine runner's window, and any future consumer
 * that draws bars must all fold the same source with the same boundaries, or a
 * script would run over a series different from the one under it. `resolution.ts`
 * holds the arithmetic; this holds the reads.
 *
 * Nothing here writes. A derived resolution is never stored: it is a view over
 * bars that already exist, so there is exactly one row per real venue bar and
 * no possibility of a stored 45-minute series drifting from the 15-minute
 * series it is made of.
 */
import * as candleRepo from "../repositories/candles";
import { ensureCandles } from "./binanceRest";
import {
  foldBars, sourceBarsNeeded, type FoldableBar, type ResolutionPlan,
} from "./resolution";
import { isInterval, type Interval } from "../types/market";

/**
 * A plan's source, as the type the candle store speaks.
 *
 * `resolution.ts` is duplicated on both sides of the wire and therefore imports
 * nothing, so it can only call a source a `string`. Every member of its
 * `NATIVE_RESOLUTIONS` is a member of `INTERVALS` — `tests/resolution.test.ts`
 * pins the two lists against each other — so this narrowing always succeeds.
 * It throws rather than casting because a future edit that adds a resolution to
 * one list and not the other should fail loudly at the first read, not serve
 * an empty series.
 */
export function sourceInterval(plan: ResolutionPlan): Interval {
  if (!isInterval(plan.source)) {
    throw new Error(
      `resolution ${plan.id} folds from ${plan.source}, which the candle store does not hold`);
  }
  return plan.source;
}

/**
 * The most source rows one request may read.
 *
 * A 1,439-minute resolution folded from one-minute bars needs 1,439 source rows
 * per bar; ten thousand of them would be fourteen million rows for one chart.
 * The cap is applied to the SOURCE read, so an extreme resolution returns fewer
 * bars than were asked for rather than a different resolution or a timeout —
 * fewer bars is honest, and the response says how many there are.
 */
export const MAX_SOURCE_ROWS = 200_000;

/**
 * A window of `plan`'s bars, ending at the newest stored bar.
 *
 * The limit counts BARS OF THE RESOLUTION, which is what a caller means by
 * "ten thousand bars" — asking the repository for ten thousand source rows and
 * folding them would silently return a fortieth of the requested window on a
 * 45-minute chart.
 */
export async function readResolvedCandles(
  symbol: string,
  plan: ResolutionPlan,
  opts: { from?: number; to?: number; limit?: number } = {}
): Promise<FoldableBar[]> {
  const source = sourceInterval(plan);
  const limit = opts.limit;
  const sourceLimit = limit === undefined
    ? undefined
    : Math.min(sourceBarsNeeded(plan, limit), MAX_SOURCE_ROWS);

  const rows = await candleRepo.getCandles(symbol, source, {
    from: opts.from,
    to: opts.to,
    limit: sourceLimit,
  });
  return resolveWindow(rows, plan, limit);
}

/**
 * Source rows in, the resolution's own bars out.
 *
 * Split from the read so it can be driven directly: everything interesting
 * about serving a derived resolution — the fold, the partial leading bucket,
 * the trim to the requested count — is here, and none of it needs a database
 * to be wrong.
 */
export function resolveWindow(
  rows: readonly FoldableBar[], plan: ResolutionPlan, limit?: number
): FoldableBar[] {
  if (plan.factor === 1) {
    return rows.map((bar) => ({ ...bar, interval: plan.id }));
  }
  const folded = foldBars(rows, plan);
  /*
   * The oldest bucket is dropped when the source read began inside it.
   *
   * A window that starts mid-bucket has a first bar built from a fraction of
   * its own span — a 45-minute bar containing one 15-minute bar, drawn at full
   * width beside forty-five-minute neighbours. `sourceBarsNeeded` asks for one
   * extra bucket precisely so this can be dropped without the window coming up
   * short. The NEWEST bucket is kept incomplete on purpose: that one is the
   * forming bar.
   */
  if (folded.length > 0 && rows.length > 0) {
    const first = folded[0]!;
    if (rows[0]!.openTime !== first.openTime) folded.shift();
  }
  return limit !== undefined && folded.length > limit ? folded.slice(-limit) : folded;
}

/**
 * Guarantee the store holds what `plan` is folded from, for this range.
 *
 * A chart on a derived resolution backfills its SOURCE — there is nothing else
 * to fetch, and asking Binance for a "45m" kline would simply be an error from
 * the venue.
 */
export async function ensureResolvedCoverage(
  symbol: string,
  plan: ResolutionPlan,
  startMs: number,
  endMs: number,
  log?: (msg: string) => void
): Promise<void> {
  await ensureCandles(symbol, sourceInterval(plan), startMs, endMs, log);
}
