/**
 * What a chart is set to, and where its bars honestly come from.
 *
 * ── The problem this exists to solve ───────────────────────────────────────
 *
 * A chart resolution used to be exactly one of eleven strings, because those
 * were the eleven Binance kline intervals the candle store held. Anything else
 * — 45 minutes, 30 seconds, 3 hours — did not exist, and the only way to add
 * one would have been to invent bars.
 *
 * Inventing bars is the failure mode this module is built to make impossible.
 * A 30-second candle assembled from one-minute candles is not a 30-second
 * candle: its high is the minute's high, its close is the minute's close, and
 * half of them would be a straight repetition of the other half. A 45-minute
 * candle assembled from hourly candles is the same lie at a different scale.
 *
 * So every resolution here is either something the venue publishes, or an
 * EXACT WHOLE MULTIPLE of something the venue publishes. There is no third
 * category, and `parseResolution` returns null rather than admit one.
 *
 * ── Why the arithmetic is duplicated ───────────────────────────────────────
 *
 * This file exists twice, byte for byte: `frontend/lib/resolution.ts` and
 * `backend/src/data/resolution.ts`. The server folds source bars into the
 * resolution the chart asked for when it answers a history request; the
 * browser folds the SAME source bars again when they arrive as live kline
 * frames, because a derived resolution has no stream of its own. If those two
 * folds disagreed by so much as a boundary, the last bar on the screen would
 * change shape the moment history reloaded. They cannot disagree if they are
 * the same code, and `frontend/tests/resolution.test.ts` fails the build if the
 * two copies ever stop being identical.
 *
 * That is also why nothing here is imported. A module that has to be storable
 * twice cannot depend on either side's module graph.
 *
 * ── The rules, stated once ─────────────────────────────────────────────────
 *
 *   native      a resolution the venue publishes as klines and this platform
 *               stores. `factor` is 1 and `source` is the resolution itself.
 *   derived     `factor` whole consecutive `source` bars, where `source` is the
 *               COARSEST native resolution that divides the target exactly.
 *               Coarsest, because 45m from three 15m bars is the same answer
 *               as 45m from forty-five 1m bars and costs fifteen times less.
 *   boundaries  a bar opens at `floor(t / ms) * ms` in epoch UTC and closes at
 *               `open + ms - 1`. Deterministic, venue-agnostic, and identical
 *               to how Binance itself anchors every interval up to a day.
 *   sub-minute  only ever folded from `1s`, which Binance publishes as a real
 *               kline back to 2017 — never from `1m`.
 *
 * The day is the ceiling. A week, a month and a quarter are not multiples of
 * anything: they are calendar objects whose length varies and whose anchor is a
 * venue policy rather than arithmetic. Folding them here would be guessing, so
 * this module refuses them and says why.
 */

/** A chart resolution: a native interval id, or a truthful multiple of one. */
export type Resolution = string;

export const SECOND_MS = 1_000;
export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/**
 * The resolutions Binance publishes as Spot klines AND this platform stores.
 *
 * Every one of these was verified against the configured official market-data
 * host rather than taken from documentation — see
 * `evidence/P1A_CHART_SHELL_INTERVALS.md`. Binance also publishes `3d`, `1w`
 * and `1M`; they are deliberately absent, because they are the calendar objects
 * the header comment refuses.
 */
export const NATIVE_RESOLUTIONS: readonly string[] = [
  "1s", "1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h", "1d",
];

/** One bar's duration, per native resolution. */
export const NATIVE_RESOLUTION_MS: Readonly<Record<string, number>> = {
  "1s": 1_000,
  "1m": 60_000,
  "3m": 180_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "1h": 3_600_000,
  "2h": 7_200_000,
  "4h": 14_400_000,
  "6h": 21_600_000,
  "8h": 28_800_000,
  "12h": 43_200_000,
  "1d": 86_400_000,
};

/** How a resolution is written and what it is made of. */
export interface ResolutionPlan {
  /** The canonical id. `"60m"` and `"1h"` both resolve to `"1h"`. */
  id: Resolution;
  /** One bar's duration in milliseconds. */
  ms: number;
  /** The native resolution its bars are folded from. Itself, when native. */
  source: string;
  /** How many whole source bars make one bar. 1 when native. */
  factor: number;
  /** True when the venue publishes this resolution directly. */
  native: boolean;
  /** The unit the canonical id is written in. */
  unit: "s" | "m" | "h" | "d";
  /** How many of that unit. */
  count: number;
}

/**
 * The largest count each unit accepts.
 *
 * Not arbitrary: one more of any of them is exactly one of the next unit up, so
 * a higher ceiling could only produce a second spelling of a resolution that
 * already has a canonical one. `60s` IS `1m`; `24h` IS `1d`.
 */
export const MAX_COUNT: Readonly<Record<"s" | "m" | "h" | "d", number>> = {
  s: 59, m: 1439, h: 23, d: 1,
};

const UNIT_MS: Readonly<Record<"s" | "m" | "h" | "d", number>> = {
  s: SECOND_MS, m: MINUTE_MS, h: HOUR_MS, d: DAY_MS,
};

/** The upper bound on a resolution: one day. */
export const MAX_RESOLUTION_MS = DAY_MS;

/**
 * How a duration is spelled: the largest unit that divides it exactly.
 *
 * This is what makes the identity single. A chart on 3,600,000 ms is on `1h`
 * whether the user typed `1h`, `60m` or `3600s`, so its history request, its
 * live stream, its Replay clip, its studies, its labels and its persisted pane
 * state all name the same thing — and two panes on it share one loaded window
 * instead of two.
 */
export function canonicalResolutionId(ms: number): string | null {
  if (!Number.isInteger(ms) || ms <= 0 || ms > MAX_RESOLUTION_MS) return null;
  if (ms % DAY_MS === 0) return `${ms / DAY_MS}d`;
  if (ms % HOUR_MS === 0) return `${ms / HOUR_MS}h`;
  if (ms % MINUTE_MS === 0) return `${ms / MINUTE_MS}m`;
  if (ms % SECOND_MS === 0) return `${ms / SECOND_MS}s`;
  // Sub-second. Binance's finest kline is one second, so there is nothing
  // truthful to fold from and no reason to invent a spelling for it.
  return null;
}

/**
 * The coarsest native resolution whose bars tile this duration exactly.
 *
 * Exactness is the whole test. A source that does not divide the target would
 * put a bar boundary inside a bucket, which is the moment a fold stops being
 * arithmetic and starts being an estimate.
 */
export function sourceFor(ms: number): { source: string; factor: number } | null {
  let best: { source: string; factor: number } | null = null;
  for (const candidate of NATIVE_RESOLUTIONS) {
    const step = NATIVE_RESOLUTION_MS[candidate]!;
    if (step > ms || ms % step !== 0) continue;
    if (best === null || step > NATIVE_RESOLUTION_MS[best.source]!) {
      best = { source: candidate, factor: ms / step };
    }
  }
  return best;
}

/**
 * Read a resolution, or refuse it.
 *
 * Returns null — never a guess and never a nearest match — for anything that
 * cannot be built out of whole venue bars. A caller that gets null must say the
 * resolution is unavailable; substituting a neighbouring one is precisely the
 * silent identity change this module exists to prevent.
 */
export function parseResolution(raw: unknown): ResolutionPlan | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  /*
   * Lowercase units only, and `M` is why.
   *
   * Everywhere this product's users have seen an interval written — TradingView
   * included — `1M` means one MONTH and `1m` means one minute. A parser that
   * lowercased the unit before reading it would take `1M` from a saved layout,
   * a deep link or a hand-typed entry and silently produce a one-minute chart:
   * the single worst outcome available to a module whose whole job is that a
   * resolution never changes identity without being told. So the ambiguity is
   * refused outright rather than resolved by guessing which one was meant.
   */
  const match = /^([0-9]{1,6})([smhd])$/.exec(text);
  if (!match) return null;
  const count = Number(match[1]);
  const unit = match[2] as "s" | "m" | "h" | "d";
  if (!Number.isInteger(count) || count <= 0) return null;
  if (count > MAX_COUNT[unit]) return null;

  const ms = count * UNIT_MS[unit];
  const id = canonicalResolutionId(ms);
  if (id === null) return null;
  // A non-canonical spelling is refused rather than silently rewritten: two
  // ids for one resolution would split the history cache, the live gate and the
  // persisted pane state three ways for no benefit.
  if (id !== text) return null;

  const canonicalUnit = id.slice(-1) as "s" | "m" | "h" | "d";
  const canonicalCount = Number(id.slice(0, -1));

  if (NATIVE_RESOLUTION_MS[id] !== undefined) {
    return {
      id, ms, source: id, factor: 1, native: true,
      unit: canonicalUnit, count: canonicalCount,
    };
  }
  const from = sourceFor(ms);
  /* istanbul ignore next — 1s and 1m divide every id this far in. */
  if (from === null) return null;
  return {
    id, ms, source: from.source, factor: from.factor, native: false,
    unit: canonicalUnit, count: canonicalCount,
  };
}

export function isResolution(raw: unknown): raw is Resolution {
  return parseResolution(raw) !== null;
}

export function isNativeResolution(raw: unknown): boolean {
  const plan = parseResolution(raw);
  return plan !== null && plan.native;
}

/**
 * One bar's duration, for a resolution already known to be valid.
 *
 * Throws on an unknown id rather than returning a plausible number: every
 * arithmetic caller — the history window, the freshness check, the replay
 * horizon, the drawing layer's time snapping — would otherwise place bars on a
 * grid that does not exist.
 */
export function resolutionMs(raw: Resolution): number {
  const plan = parseResolution(raw);
  if (plan === null) throw new Error(`not a resolution: ${String(raw)}`);
  return plan.ms;
}

/** The open time of the bucket containing `ms`, on the epoch-UTC grid. */
export function bucketOpenTime(ms: number, stepMs: number): number {
  return Math.floor(ms / stepMs) * stepMs;
}

/** How a resolution is said out loud — for a menu row or an aria-label. */
export function describeResolution(raw: Resolution): string {
  const plan = parseResolution(raw);
  if (plan === null) return String(raw);
  const noun = { s: "second", m: "minute", h: "hour", d: "day" }[plan.unit];
  return `${plan.count} ${noun}${plan.count === 1 ? "" : "s"}`;
}

/**
 * Why a resolution is trustworthy, in one sentence.
 *
 * Shown wherever a derived resolution is offered, because "45m" on a toolbar
 * says nothing about whether it was folded or invented, and the difference is
 * the entire point.
 */
export function explainResolution(raw: Resolution): string {
  const plan = parseResolution(raw);
  if (plan === null) return `${String(raw)} is not a resolution this venue can serve`;
  if (plan.native) return `${plan.id} bars come from the venue directly`;
  return `${plan.id} bars are ${plan.factor} whole ${plan.source} bars, aggregated`;
}

/** The bar shape this module folds. Both `Candle` types satisfy it. */
export interface FoldableBar {
  symbol: string;
  interval: string;
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume?: number;
  tradeCount?: number;
  closeTime: number;
}

/**
 * Fold source bars into the resolution's own bars.
 *
 * The arithmetic, and the whole of it:
 *
 *   open    the first source bar's open
 *   high    the maximum source high
 *   low     the minimum source low
 *   close   the last source bar's close
 *   volume  the sum
 *
 * Exact, because the source bars tile the bucket exactly — that is what
 * `sourceFor` guarantees and why nothing here interpolates, forward-fills or
 * weights anything.
 *
 * `openTime` and `closeTime` come from the GRID, not from the bars present. A
 * bucket whose first source bar is missing (the venue publishes no kline for a
 * minute in which nothing traded on a thin pair) still opens where the grid
 * says it opens; it is a bar with less inside it, not a bar in a different
 * place. Anything else would make a series whose boundaries depended on
 * liquidity.
 *
 * The newest bucket is normally incomplete, and is returned anyway — that is
 * the forming bar, and it is what a live chart draws. Its `closeTime` is the
 * grid's, so `now > closeTime` remains the single definition of "this bar has
 * closed" for a derived resolution and a native one alike.
 *
 * Source bars must be ascending by `openTime`, which every caller's source is:
 * the repository orders them and the live gate refuses out-of-order frames.
 */
export function foldBars<T extends FoldableBar>(
  source: readonly T[], plan: ResolutionPlan
): FoldableBar[] {
  if (plan.factor === 1) return source.map((bar) => ({ ...bar, interval: plan.id }));
  const out: FoldableBar[] = [];
  let current: FoldableBar | null = null;
  for (const bar of source) {
    const openTime = bucketOpenTime(bar.openTime, plan.ms);
    if (current === null || current.openTime !== openTime) {
      current = {
        symbol: bar.symbol,
        interval: plan.id,
        openTime,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
        closeTime: openTime + plan.ms - 1,
      };
      if (bar.quoteVolume !== undefined) current.quoteVolume = bar.quoteVolume;
      if (bar.tradeCount !== undefined) current.tradeCount = bar.tradeCount;
      out.push(current);
      continue;
    }
    if (bar.high > current.high) current.high = bar.high;
    if (bar.low < current.low) current.low = bar.low;
    current.close = bar.close;
    current.volume += bar.volume;
    if (bar.quoteVolume !== undefined) {
      current.quoteVolume = (current.quoteVolume ?? 0) + bar.quoteVolume;
    }
    if (bar.tradeCount !== undefined) {
      current.tradeCount = (current.tradeCount ?? 0) + bar.tradeCount;
    }
  }
  return out;
}

/**
 * How many source bars are needed to produce `bars` bars of this resolution.
 *
 * One extra bucket's worth, because a window that starts mid-bucket loses its
 * first, partial bucket — asking for exactly `bars * factor` would reliably
 * return one bar fewer than the caller asked for.
 */
export function sourceBarsNeeded(plan: ResolutionPlan, bars: number): number {
  return plan.factor === 1 ? bars : bars * plan.factor + plan.factor;
}
