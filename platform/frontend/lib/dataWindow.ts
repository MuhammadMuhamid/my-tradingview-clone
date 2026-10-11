/**
 * What the Data window lists for one bar (W2D-05).
 *
 * The Data window listed the Date, the OHLC and the Pine overlays — and only
 * those, because the page built its rows from the two study lists it could
 * see, and the built-in list it held was a snapshot taken when a study was
 * ADDED, before it had computed anything. Volume, the bar's change, the
 * moving-average set, RSI, ATR and the comparison pane were all on the chart
 * and none were in the window. The reference lists every study in every pane,
 * plus the bar's change and volume.
 *
 * So this takes the overlays the PANE draws — the same set its legends are
 * built from — and reads each plot at the hovered time through the same
 * `plotValueAt` / `formatPlotValue` the legends use, grouped by study the way
 * the legend groups it. Nothing here computes a study; it only reads one.
 */
import {
  formatPlotValue, labelDuplicateInstances, plotValueAt, type ChartOverlay,
} from "@/lib/chartSeries";
import { fmtPriceDelta } from "@/lib/format";
import type { Candle } from "@/lib/types";

export interface DataWindowRow {
  id: string;
  label: string;
  value: string;
}

export interface DataWindowStudy {
  id: string;
  title: string;
  /** The study's inputs, as its legend prints them; "" when it has none. */
  params: string;
  rows: readonly DataWindowRow[];
}

/**
 * Every study on the pane, one group per instance, each plot read at `time`.
 *
 * `time` null is "no crosshair", which `plotValueAt` answers with the newest
 * reading — the same answer the legend gives. A constant level (RSI's 70 / 30)
 * has no reading at a bar and is not listed, as the legend does not list it.
 * An overlay with no points at all is a status row (a Pine run that failed),
 * not a plot, and is not listed either.
 */
export function dataWindowStudies(
  overlays: readonly ChartOverlay[], time: number | null
): DataWindowStudy[] {
  const byInstance = new Map<string,
    { id: string; title: string; params: string; plots: ChartOverlay[] }>();
  for (const overlay of overlays) {
    if (overlay.constantValue !== undefined || overlay.data.length === 0) continue;
    const id = overlay.instanceId ?? overlay.id;
    const existing = byInstance.get(id);
    if (existing) existing.plots.push(overlay);
    else byInstance.set(id, {
      id,
      title: overlay.instanceTitle || overlay.title,
      params: overlay.instanceParams ?? "",
      plots: [overlay],
    });
  }
  return labelDuplicateInstances([...byInstance.values()]).map((group) => ({
    id: group.id,
    title: group.title,
    params: group.params,
    rows: group.plots.map((plot, index) => ({
      id: `${group.id}:${plot.id}:${index}`,
      label: plot.title || group.title,
      value: formatPlotValue(plotValueAt(plot.data, time), plot.precision),
    })),
  }));
}

/**
 * The bar's own change and volume, as the main series' legend reads them.
 *
 * Change is against the PREVIOUS bar's close — against the bar's own open for
 * the first bar, which has no previous — at the precision of the price, signed,
 * with the percentage beside it: the legend's `buildLegend` arithmetic and its
 * `fmtPriceDelta` text, so the two never disagree about the same bar.
 */
export function dataWindowSeriesRows(
  candles: readonly Candle[], candle: Candle | null
): DataWindowRow[] {
  if (!candle) {
    return [
      { id: "change", label: "Change", value: "—" },
      { id: "volume", label: "Volume", value: "—" },
    ];
  }
  const index = candles.indexOf(candle);
  const previous = index > 0 ? candles[index - 1]!.close : candle.open;
  const change = candle.close - previous;
  const percent = previous !== 0 ? (change / previous) * 100 : 0;
  const percentText = Math.abs(percent).toFixed(2);
  const percentSign = percent < 0 && Number(percentText) !== 0 ? "−" : "+";
  return [
    {
      id: "change",
      label: "Change",
      value: `${fmtPriceDelta(change, candle.close)} (${percentSign}${percentText}%)`,
    },
    {
      id: "volume",
      label: "Volume",
      value: Number.isFinite(candle.volume)
        ? candle.volume.toLocaleString(undefined, { maximumFractionDigits: 2 })
        : "—",
    },
  ];
}
