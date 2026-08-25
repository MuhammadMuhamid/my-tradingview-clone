/**
 * A deterministic market fixture for engine golden tests (`BE-29`).
 *
 * The audit's coverage finding names two missing suites, and this supports the
 * first: "a golden-file regression per strategy". Every strategy bar loop, and
 * the ~1400 lines of `signals.ts` behind it, ran against nothing.
 *
 * The fixture is a single 1-minute series aggregated into every timeframe a
 * strategy asks for, so the feeds AGREE with one another the way real feeds do
 * — a set of independently generated series would let a strategy see a 4-hour
 * trend that its own 15-minute bars contradict, and pin behaviour that can
 * never occur. It is generated from a seeded LCG, so it is identical on every
 * machine and every run.
 *
 * It is synthetic, and the tests say so: it exercises the code paths and pins
 * them against silent change. It is not evidence about the strategies.
 */
import { FeedStore, type Bars } from "../../src/engine/mtf";
import { INTERVAL_MS, type Interval } from "../../src/types/market";

export const FIXTURE_SYMBOL = "TESTUSDT";
const START = Date.UTC(2024, 0, 1);

/** Seeded 1-minute OHLCV. Two sine components give trend and pullback structure. */
export function minuteSeries(minutes: number, seed: number): Bars {
  let s = seed >>> 0;
  const rng = (): number => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
  const time: number[] = [], open: number[] = [], high: number[] = [],
    low: number[] = [], close: number[] = [], volume: number[] = [], closeTime: number[] = [];
  let px = 100;
  for (let i = 0; i < minutes; i += 1) {
    const trend = Math.sin(i / 4000) * 0.0028 + Math.sin(i / 611) * 0.0016;
    const shock = (rng() - 0.5) * 0.0055;
    const o = px;
    px = Math.max(1, px * (1 + trend + shock));
    time.push(START + i * 60_000);
    closeTime.push(START + (i + 1) * 60_000 - 1);
    open.push(o);
    close.push(px);
    high.push(Math.max(o, px) * (1 + rng() * 0.0022));
    low.push(Math.min(o, px) * (1 - rng() * 0.0022));
    volume.push(500 + Math.floor(rng() * 2500));
  }
  return {
    symbol: FIXTURE_SYMBOL, interval: "1m",
    time, open, high, low, close, volume, closeTime, length: minutes,
  };
}

/** Roll a finer series up into `interval` buckets, OHLCV-correctly. */
export function aggregate(src: Bars, interval: Interval): Bars {
  if (interval === src.interval) return src;
  const step = INTERVAL_MS[interval];
  const time: number[] = [], open: number[] = [], high: number[] = [],
    low: number[] = [], close: number[] = [], volume: number[] = [], closeTime: number[] = [];
  let bucket = -1;
  for (let i = 0; i < src.length; i += 1) {
    const t = Math.floor(src.time[i]! / step) * step;
    if (t !== bucket) {
      bucket = t;
      time.push(t);
      closeTime.push(t + step - 1);
      open.push(src.open[i]!);
      high.push(src.high[i]!);
      low.push(src.low[i]!);
      close.push(src.close[i]!);
      volume.push(src.volume[i]!);
    } else {
      const k = time.length - 1;
      high[k] = Math.max(high[k]!, src.high[i]!);
      low[k] = Math.min(low[k]!, src.low[i]!);
      close[k] = src.close[i]!;
      volume[k] = volume[k]! + src.volume[i]!;
    }
  }
  return {
    symbol: FIXTURE_SYMBOL, interval,
    time, open, high, low, close, volume, closeTime, length: time.length,
  };
}

/** A store holding every interval a strategy asked for, all from one base series. */
export function feedsFor(base: Bars, intervals: readonly Interval[]): FeedStore {
  const feeds = new FeedStore();
  for (const interval of new Set(intervals)) feeds.set(aggregate(base, interval));
  return feeds;
}

/**
 * A stable digest of a numeric or boolean series.
 *
 * Values are rounded to 8 significant figures before hashing: the point is to
 * catch a CHANGE IN BEHAVIOUR, not a change in the last bit of a float, which
 * differs harmlessly between platforms.
 */
export function digest(values: readonly (number | boolean | null | undefined)[]): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  const mix = (text: string): void => {
    for (let i = 0; i < text.length; i += 1) {
      h1 = Math.imul(h1 ^ text.charCodeAt(i), 0x01000193) >>> 0;
      h2 = Math.imul(h2 + text.charCodeAt(i), 0x85ebca6b) >>> 0;
    }
  };
  for (const v of values) {
    if (v === null || v === undefined) mix("~");
    else if (typeof v === "boolean") mix(v ? "T" : "F");
    else if (Number.isNaN(v)) mix("N");
    else mix(Number(v).toPrecision(8));
    mix("|");
  }
  return (h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0"));
}
