/**
 * What the price AXIS says a price is.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * TVP8 F-03-R2. The last-price plate (`lib/barCountdown`) draws the price row
 * itself, and for a while it formatted that row through the series' own
 * `priceFormatter()`. That is the wrong function: it is the RAW series
 * formatter, and the axis beside it does not use it. Measured on ETHUSDT the
 * plate read `2416.65` beside axis labels reading `2,420.00`; on an
 * Indexed-to-100 scale it read the raw `98.64` under a label reading
 * `101.60`, a number that is not on the scale it sat on.
 *
 * The library formats every label on the axis — the ticks, the crosshair,
 * the series' own last-value chip — through ONE path,
 * `PriceScale.formatPrice(price, firstValue)` (lightweight-charts 4.2.3):
 *
 *     switch (mode) {
 *       case Percentage:   return formatPercentage(toPercent(price, firstValue));
 *       case IndexedTo100: return formatter().format(toIndexedTo100(price, firstValue));
 *       default:           return formatPrice(price);
 *     }
 *
 * where
 *
 *   - `formatPrice(p)` is `localization.priceFormatter(p)` when the chart has
 *     one, else the scale's formatter — the FIRST series on the scale's own
 *     `priceFormatter()`;
 *   - `formatPercentage(p)` is `localization.percentageFormatter(p)` when the
 *     chart has one, else the library's `PercentageFormatter`: two decimals,
 *     a `%`, and U+2212 for the sign;
 *   - in Indexed-to-100 the scale's `formatter()` is ALWAYS a fresh
 *     `PriceFormatter(100, 1)` — two decimals — and the localization formatter
 *     is not consulted at all;
 *   - `firstValue` is the close of the series' first bar INSIDE the visible
 *     range (`Series.firstValue()` → `firstBar()` → the bar at or after
 *     `floor(visibleLogicalRange.from)`), which is what Percentage and
 *     Indexed-to-100 are relative to; and
 *   - Logarithmic changes coordinates, not text: it falls to `default`.
 *
 * None of that is public API. Every INPUT to it is: the scale's mode
 * (`series.priceScale().options().mode`), the chart's localization formatters
 * (`chart.options().localization`), the series formatter
 * (`series.priceFormatter()`), and the visible bars
 * (`timeScale().getVisibleLogicalRange()` + `series.dataByIndex()`). So this
 * module is that switch, written once against those public inputs, and it
 * is the ONLY place a scale mode is allowed to change what a price reads as.
 * Anything that prints "the price on the axis" formats through
 * `priceAxisText`, and the library's own axis is the oracle it is tested
 * against.
 *
 * Plain node throughout: no import of the chart library, which is a browser
 * bundle, so `tests/priceAxisText.test.ts` runs in the unit suite.
 */

/** `PriceScaleMode`, as the values rather than the enum (see the module note). */
export const PRICE_SCALE_MODE = {
  normal: 0,
  logarithmic: 1,
  percentage: 2,
  indexedTo100: 3,
} as const;
export type PriceScaleModeValue = typeof PRICE_SCALE_MODE[keyof typeof PRICE_SCALE_MODE];

/** `MismatchDirection`, likewise. */
export const NEAREST_LEFT = -1;
export const NEAREST_RIGHT = 1;

/* ── the library's transforms, verbatim ──────────────────────────────────── */

/** `toPercent`: what a Percentage scale plots and labels for `value`. */
export function toPercent(value: number, baseValue: number): number {
  const result = 100 * (value - baseValue) / baseValue;
  return baseValue < 0 ? -result : result;
}

/** `toIndexedTo100`: what an Indexed-to-100 scale plots and labels for `value`. */
export function toIndexedTo100(value: number, baseValue: number): number {
  const result = 100 * (value - baseValue) / baseValue + 100;
  return baseValue < 0 ? -result : result;
}

/* ── the library's own formatters, verbatim ──────────────────────────────── */

/**
 * `PriceFormatter(priceScale, minMove).format(price)`.
 *
 * `priceScale` is `10 ** decimals` and `minMove` the step in those units, as
 * the library takes them. The sign is U+2212, which the library chooses
 * because it is as wide as `+`.
 */
export function libraryPriceFormat(price: number, priceScale = 100, minMove = 1): string {
  if (!minMove) minMove = 1;
  if (!Number.isFinite(priceScale) || priceScale % 1 !== 0) priceScale = 100;
  let fractionalLength = 0;
  if (priceScale > 0 && minMove > 0) {
    let base = priceScale;
    while (base > 1) { base /= 10; fractionalLength += 1; }
  }
  const sign = price < 0 ? "\u2212" : "";
  price = Math.abs(price);
  const base = priceScale / minMove;
  let intPart = Math.floor(price);
  let fracString = "";
  if (base > 1) {
    let fracPart = +(Math.round(price * base) - intPart * base).toFixed(fractionalLength);
    if (fracPart >= base) { fracPart -= base; intPart += 1; }
    fracString = "." + leadingZeros(+fracPart.toFixed(fractionalLength) * minMove, fractionalLength);
  } else {
    intPart = Math.round(intPart * base) / base;
    if (fractionalLength > 0) fracString = "." + leadingZeros(0, fractionalLength);
  }
  return sign + intPart.toFixed(0) + fracString;
}

/** `PercentageFormatter().format(value)`: the price formatter's text with a `%`. */
export function libraryPercentageFormat(value: number): string {
  return `${libraryPriceFormat(value, 100, 1)}%`;
}

/** `numberToStringWithLeadingZero`. */
function leadingZeros(value: number, length: number): string {
  if (!Number.isFinite(value)) return "n/a";
  if (length === 0) return value.toString();
  return ("0000000000000000" + value.toString()).slice(-length);
}

/* ── the switch ──────────────────────────────────────────────────────────── */

/** A formatter the way the library types one: anything with `format`. */
export interface PriceFormatterLike { format(price: number): string }

/**
 * The state `PriceScale.formatPrice` reads, from the public API that carries it.
 */
export interface PriceAxisFormatting {
  /** `series.priceScale().options().mode`. Unknown reads as Normal, as the library defaults it. */
  mode: number | undefined;
  /** `chart.options().localization.priceFormatter`. */
  priceFormatter?: ((price: number) => string) | undefined;
  /** `chart.options().localization.percentageFormatter`. */
  percentageFormatter?: ((percentage: number) => string) | undefined;
  /** `series.priceFormatter()`: the scale's fallback when the chart has no localization formatter. */
  seriesFormatter?: PriceFormatterLike | null | undefined;
}

/**
 * The text the price axis prints for `price` on a scale in this state.
 *
 * `firstValue` is the close the visible range starts on — see the module note
 * — and is only read in the two modes that are relative to it. In those modes
 * a scale with no first value prints nothing, which is what the library's
 * chip does (`lastValueData` reports no data), rather than a raw price the
 * scale does not agree with.
 */
export function priceAxisText(
  price: number,
  firstValue: number | null,
  formatting: PriceAxisFormatting,
): string {
  switch (formatting.mode) {
    case PRICE_SCALE_MODE.percentage: {
      if (firstValue === null) return "";
      const percentage = toPercent(price, firstValue);
      return formatting.percentageFormatter
        ? formatting.percentageFormatter(percentage)
        : libraryPercentageFormat(percentage);
    }
    case PRICE_SCALE_MODE.indexedTo100: {
      if (firstValue === null) return "";
      return libraryPriceFormat(toIndexedTo100(price, firstValue), 100, 1);
    }
    default: {
      if (formatting.priceFormatter) return formatting.priceFormatter(price);
      if (formatting.seriesFormatter) return formatting.seriesFormatter.format(price);
      return libraryPriceFormat(price, 100, 1);
    }
  }
}

/* ── reading that state off a live chart ─────────────────────────────────── */

/** Just the parts of a chart this reads: every one of them public API. */
export interface AxisChartLike {
  options(): {
    localization?: {
      // Method signatures, checked bivariantly: the library types the argument
      // as its branded `BarPrice`, which is a number wearing a name.
      priceFormatter?(price: number): string;
      percentageFormatter?(percentage: number): string;
    };
  } | undefined;
  timeScale(): { getVisibleLogicalRange(): { from: number; to: number } | null };
}

/** Just the parts of a series this reads: likewise. */
export interface AxisSeriesLike {
  priceScale?: () => { options(): { mode?: number } };
  priceFormatter?: () => PriceFormatterLike;
  dataByIndex?: (logicalIndex: number, mismatchDirection: number) => unknown;
}

/**
 * `PriceScale.formatPrice`'s inputs, read from the chart at call time.
 *
 * Read fresh on every call and cached nowhere, for the same reason the plate's
 * coordinate is: a mode switch from the axis menu, or the precision effect
 * rewriting the axis's decimals, must show on the next paint — not the next
 * React render.
 */
export function readPriceAxisFormatting(
  chart: AxisChartLike | null,
  series: AxisSeriesLike,
): PriceAxisFormatting {
  let mode: number | undefined;
  try { mode = series.priceScale?.().options().mode; } catch { mode = undefined; }
  let priceFormatter: PriceAxisFormatting["priceFormatter"];
  let percentageFormatter: PriceAxisFormatting["percentageFormatter"];
  try {
    const localization = chart?.options()?.localization;
    priceFormatter = localization?.priceFormatter;
    percentageFormatter = localization?.percentageFormatter;
  } catch { /* a chart mid-teardown; the series formatter is the fallback */ }
  let seriesFormatter: PriceFormatterLike | null = null;
  try { seriesFormatter = series.priceFormatter?.() ?? null; } catch { seriesFormatter = null; }
  return { mode, priceFormatter, percentageFormatter, seriesFormatter };
}

/** Just enough of a data item to read a close from, whatever series type it came from. */
interface PriceBearing { close?: unknown; value?: unknown }

function closeOf(bar: unknown): number | null {
  const item = bar as PriceBearing | null | undefined;
  const price = item?.close ?? item?.value;
  return typeof price === "number" ? price : null;
}

/**
 * `Series.firstValue()`: the close of the first bar inside the visible range —
 * the bar at or after `floor(from)`, which is `visibleStrictRange().left()`.
 * The base a Percentage or Indexed-to-100 scale is relative to.
 */
export function firstVisibleClose(chart: AxisChartLike | null, series: AxisSeriesLike): number | null {
  const range = visibleRange(chart);
  if (range === null || typeof series.dataByIndex !== "function") return null;
  try { return closeOf(series.dataByIndex(Math.floor(range.from), NEAREST_RIGHT)); }
  catch { return null; }
}

/**
 * `Series.lastValueData(false).price`: the close of the last bar inside the
 * visible range — the bar at or before `ceil(to)`, which is
 * `visibleStrictRange().right()`. The price the series' own chip is on.
 */
export function lastVisibleClose(chart: AxisChartLike | null, series: AxisSeriesLike): number | null {
  const range = visibleRange(chart);
  if (range === null || typeof series.dataByIndex !== "function") return null;
  try { return closeOf(series.dataByIndex(Math.ceil(range.to), NEAREST_LEFT)); }
  catch { return null; }
}

function visibleRange(chart: AxisChartLike | null): { from: number; to: number } | null {
  if (chart === null) return null;
  try { return chart.timeScale().getVisibleLogicalRange(); } catch { return null; }
}
