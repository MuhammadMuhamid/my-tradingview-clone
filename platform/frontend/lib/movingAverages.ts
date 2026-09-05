/**
 * Moving-average overlays for the chart.
 *
 * These are first-class chart lines rather than Pine indicator instances: they
 * are the fixed set the alert engine understands (SMA/EMA of 200/100/50/21/15),
 * they must be togglable one line at a time so each can be armed with its own
 * alert, and they must be cheap enough to recompute on every candle update.
 *
 * The maths here IS the server's — both call `lib/ta/core`, which exists
 * byte-identically on both sides. The chart must draw the same number the
 * server alerts on, or a "touch" would appear to fire on the wrong line, and
 * "two implementations that agree today" is not a way to guarantee that.
 */
import * as core from "@/lib/ta/core";
import type { ChartOverlay } from "@/lib/chartSeries";
import type { Candle } from "@/lib/types";

export type MaType = "sma" | "ema";

/** The lengths drawn on every coin chart, longest first (drawing order). */
export const MA_LENGTHS = [200, 100, 50, 21, 15] as const;
export type MaLength = (typeof MA_LENGTHS)[number];

export interface MaLine {
  type: MaType;
  length: number;
  visible: boolean;
}

export const maId = (type: MaType, length: number): string => `ma-${type}-${length}`;
export const maLabel = (type: MaType, length: number): string =>
  `${type.toUpperCase()} ${length}`;

/**
 * One hue per length so the SMA/EMA pair of the same period read as a pair;
 * the EMA is drawn dashed to tell the two apart without a legend lookup.
 */
const COLOR_BY_LENGTH: Record<number, string> = {
  200: "#f0b90b",
  100: "#e5679a",
  50: "#9b7cf5",
  21: "#4f8cff",
  15: "#26c6a4",
};

export const maColor = (length: number): string => COLOR_BY_LENGTH[length] ?? "#8b93a7";

/** Every SMA and EMA line, all visible — the default set for a coin layout. */
export function defaultMaLines(): MaLine[] {
  const lines: MaLine[] = [];
  for (const length of MA_LENGTHS) {
    lines.push({ type: "sma", length, visible: true });
    lines.push({ type: "ema", length, visible: true });
  }
  return lines;
}

/**
 * `na` is a break in the line; the chart draws a gap rather than a zero.
 *
 * The canonical layer speaks Pine's language, where an unavailable value is
 * NaN. lightweight-charts wants `null`. This is the whole of the difference
 * between the two, and it is a rendering convention rather than a different
 * answer — which is why it is one function here instead of a second copy of
 * the arithmetic.
 */
function drawable(series: readonly number[]): (number | null)[] {
  return series.map((v) => (Number.isFinite(v) ? v : null));
}

/**
 * Simple moving average; null until `len` bars exist, which breaks the line.
 *
 * The maths is `lib/ta/core`'s, which is the SAME code the server evaluates
 * alerts with. It used to be a second implementation here, written to agree by
 * intention: seeded the same way, accumulated the same way, and correct. But
 * "correct because someone kept the two in step" is a property that expires,
 * and the failure would be an armed "price touches EMA 200" firing on a
 * different line from the one on screen. `tests/taCore.test.ts` pins the
 * equivalence value for value.
 */
export function sma(src: number[], len: number): (number | null)[] {
  return drawable(core.sma(src, len));
}

/**
 * Exponential moving average, seeded with the SMA of the first `len` bars —
 * the same seeding Pine's `ta.ema` and the backend's `ema` use, because it is
 * now literally the same function.
 */
export function ema(src: number[], len: number): (number | null)[] {
  return drawable(core.ema(src, len));
}

/**
 * Decimal places for a price of this magnitude — the same adaptive rule
 * `fmtPrice` uses, so a moving average and the price it tracks are never shown
 * at two different precisions.
 */
export function pricePrecision(price: number): number {
  const abs = Math.abs(price);
  return abs >= 100 ? 2 : abs >= 1 ? 4 : 6;
}

/** Turn the visible lines into chart overlays for the given candles. */
export function buildMaOverlays(candles: Candle[], lines: MaLine[]): ChartOverlay[] {
  if (candles.length === 0) return [];
  const closes = candles.map((c) => c.close);
  /*
   * Read the moving averages at the instrument's own price precision. Without
   * a stated precision the formatter falls back to the magnitude of each
   * individual value, so one legend row showed `210.228` beside `212.3651`
   * beside `216.9878` — three different precisions for three prices of the
   * same instrument, which is noise, not information.
   */
  const precision = pricePrecision(closes[closes.length - 1] ?? 0);
  // Chart times are seconds; candle openTime is epoch milliseconds.
  const times = candles.map((c) => Math.floor(c.openTime / 1000));

  return lines
    .filter((l) => l.visible)
    .map((l) => {
      const series = l.type === "sma" ? sma(closes, l.length) : ema(closes, l.length);
      return {
        id: maId(l.type, l.length),
        title: maLabel(l.type, l.length),
        paneId: "price",
        instanceId: "moving-averages",
        instanceTitle: "Moving averages",
        color: maColor(l.length),
        width: l.length >= 100 ? 2 : 1,
        dashed: l.type === "ema",
        precision,
        data: times.map((time, i) => ({ time, value: series[i] })),
      };
    });
}

/** Current value of each visible line, for the alert dialog and the legend. */
export function currentMaValues(
  candles: Candle[], lines: MaLine[]
): Record<string, number | null> {
  const closes = candles.map((c) => c.close);
  const out: Record<string, number | null> = {};
  for (const l of lines) {
    const series = l.type === "sma" ? sma(closes, l.length) : ema(closes, l.length);
    out[maId(l.type, l.length)] = series[series.length - 1] ?? null;
  }
  return out;
}
