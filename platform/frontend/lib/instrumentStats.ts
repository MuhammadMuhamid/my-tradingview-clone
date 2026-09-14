/**
 * What a daily bar series says about an instrument.
 *
 * ── TVP8 R7b-11: the details block was refusing to compute what it had ─────
 *
 * `WatchlistDetails` printed `Average volume (30D) —` with the tooltip
 * "computing one needs daily bars this panel does not read yet", and
 * `Performance: Not computed for this instrument.` Both sentences were honest
 * about the panel and wrong about the product: `GET /api/symbols/:symbol/
 * candles?interval=1d` has been served the whole time (`backend/src/api/
 * routes/symbols.ts`), and `lib/api.ts` has had `api.candles` pointed at it.
 * The reference shows `Average Volume (30D) 16.40K` and six period tiles, and
 * both are arithmetic over bars this installation already serves.
 *
 * The arithmetic lives here, pure, so it is tested without a network: a
 * percentage that is wrong by one bar is not something a screenshot catches.
 *
 * ── The rule the fabrication ban still keeps ──────────────────────────────
 *
 * A number is returned only when the series can actually support it. A
 * 20-bar history has no 1-month figure, so `performance` returns `null` for
 * that period rather than reaching for the oldest bar it happens to have and
 * calling the answer "1M" — which would be a made-up number wearing a real
 * label, which is the failure this module's caller exists to avoid.
 */

/** The only fields either helper reads. `lib/types.ts`'s `Candle` satisfies it. */
export interface StatBar {
  openTime: number;
  close: number;
  volume: number;
}

/** The periods the reference's tile grid shows, in its own order. */
export const PERFORMANCE_PERIODS = ["1W", "1M", "3M", "6M", "YTD", "1Y"] as const;
export type PerformancePeriod = (typeof PERFORMANCE_PERIODS)[number];

/** How many daily bars back each fixed period looks. `YTD` is not fixed. */
const PERIOD_BARS: Readonly<Record<Exclude<PerformancePeriod, "YTD">, number>> = {
  "1W": 7, "1M": 30, "3M": 90, "6M": 180, "1Y": 365,
};

/**
 * The mean daily volume of the last 30 CLOSED bars.
 *
 * Closed, because the newest daily bar is a partial day on a 24/7 venue and
 * averaging it in drags the figure down by however much of the day is left —
 * a "30-day average" that is lowest at 00:05 UTC and highest at 23:55 is not
 * an average of anything. `bars` is expected oldest-first, which is the order
 * `api.candles` returns.
 */
export function averageVolume30D(bars: readonly StatBar[], now = Date.now()): number | null {
  const closed = closedBars(bars, now);
  if (closed.length < 30) return null;
  const window = closed.slice(-30);
  let total = 0;
  for (const bar of window) {
    if (!Number.isFinite(bar.volume)) return null;
    total += bar.volume;
  }
  return total / window.length;
}

/**
 * Percentage change over each period, or `null` where the series is short.
 *
 * Each figure is `(latest close / the close that many bars back − 1) × 100`.
 * `YTD` is measured from the first bar at or after 1 January UTC, because a
 * year-to-date figure is defined by a calendar boundary and not by a bar
 * count — 1 January is 0 to 365 bars back depending on the day it is read.
 */
export function performance(
  bars: readonly StatBar[], now = Date.now(),
): Record<PerformancePeriod, number | null> {
  const out = {} as Record<PerformancePeriod, number | null>;
  for (const period of PERFORMANCE_PERIODS) out[period] = null;
  if (bars.length === 0) return out;

  const latest = bars[bars.length - 1]!;
  if (!Number.isFinite(latest.close) || latest.close === 0) return out;

  const change = (from: number | undefined): number | null =>
    from === undefined || !Number.isFinite(from) || from === 0
      ? null : (latest.close / from - 1) * 100;

  for (const [period, back] of Object.entries(PERIOD_BARS) as
    [Exclude<PerformancePeriod, "YTD">, number][]) {
    const index = bars.length - 1 - back;
    // `< 0` and not `<= 0`: a series of exactly `back + 1` bars HAS the bar
    // the period asks for, and refusing it would blank a figure the data
    // supports.
    out[period] = index < 0 ? null : change(bars[index]!.close);
  }

  const janFirst = Date.UTC(new Date(now).getUTCFullYear(), 0, 1);
  const ytd = bars.find((bar) => bar.openTime >= janFirst);
  // A series that begins after 1 January has no year-to-date reference, and
  // one whose first in-year bar IS the latest bar has nothing to compare.
  out.YTD = ytd === undefined || ytd === latest ? null : change(ytd.close);
  return out;
}

/** Bars whose day is over, oldest-first. */
function closedBars(bars: readonly StatBar[], now: number): readonly StatBar[] {
  const DAY = 86_400_000;
  let end = bars.length;
  while (end > 0 && bars[end - 1]!.openTime + DAY > now) end -= 1;
  return bars.slice(0, end);
}
