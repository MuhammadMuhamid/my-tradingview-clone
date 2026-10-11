/**
 * A drawing's price tags, ON the price axis (B-21).
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 *
 * A horizontal line's price, a horizontal ray's, and the `Price labels` a
 * trend line's settings switch on were painted by the drawing canvas as
 * coloured boxes 62px in from the pane's right edge — inside the plot, over
 * the candles, in a monospace face, and outside the price scale's own label
 * packing, so they sat on top of the last-price plate and each other. The
 * drawing canvas covers the PANE; it cannot draw on the axis. The reference
 * tags these on the axis, as pills, like every other price on the chart.
 *
 * So the tags are a series primitive's `priceAxisViews()`: the library draws
 * them as ordinary axis labels — the axis's font, its geometry, its packing
 * (`No overlapping labels`), and the tick clearance that keeps a pill from
 * half-covering a tick — and formats nothing itself: the text is what the
 * axis prints for that price (`lib/priceAxisText`), in whatever scale mode.
 */
import type {
  IChartApiBase, ISeriesApi, ISeriesPrimitive, ISeriesPrimitiveAxisView,
  SeriesAttachedParameter, SeriesType, Time,
} from "lightweight-charts";
import { chipTextColor } from "./barCountdown";
import { drawingVisibleOnTimeframe, type Drawing } from "./drawings";
import { firstVisibleClose, priceAxisText, readPriceAxisFormatting } from "./priceAxisText";
import type { Resolution } from "./resolution";

export interface AxisTag { price: number; color: string }

/** Tools whose ONLY price is the line itself, and which the reference always tags. */
const LEVEL_TOOLS = new Set(["hline", "hray"]);

/**
 * Every price tag the drawings ask for, in drawing order.
 *
 * A level is tagged whatever its settings say; `Price labels` tags each anchor
 * of anything else, once per distinct price — a flat line's two anchors share
 * a row, and two identical tags on one pixel are a smudge, not information.
 */
export function drawingAxisTags(
  drawings: readonly Drawing[], interval: Resolution, hidden = false,
): AxisTag[] {
  if (hidden) return [];
  const tags: AxisTag[] = [];
  for (const d of drawings) {
    if (d.hidden || !drawingVisibleOnTimeframe(d, interval)) continue;
    const points = LEVEL_TOOLS.has(d.tool) ? d.points.slice(0, 1)
      : d.style.priceLabels === true ? d.points : [];
    const seen = new Set<number>();
    for (const point of points) {
      if (!Number.isFinite(point.price) || seen.has(point.price)) continue;
      seen.add(point.price);
      tags.push({ price: point.price, color: d.style.color });
    }
  }
  return tags;
}

/** Attach to the price series; `update` with `drawingAxisTags`. */
export class DrawingAxisLabelsPrimitive implements ISeriesPrimitive {
  private series: ISeriesApi<SeriesType> | null = null;
  private chart: IChartApiBase<Time> | null = null;
  private requestUpdate: (() => void) | null = null;
  private tags: readonly AxisTag[] = [];
  /*
   * A new array only when the SET of tags changes: the library caches on the
   * array's identity, so a fresh one per frame would defeat that cache.
   */
  private views: readonly ISeriesPrimitiveAxisView[] = [];

  attached(param: SeriesAttachedParameter<Time, SeriesType>): void {
    this.series = param.series;
    this.chart = param.chart ?? null;
    this.requestUpdate = param.requestUpdate;
  }

  detached(): void { this.series = null; this.chart = null; this.requestUpdate = null; }

  update(tags: readonly AxisTag[]): void {
    const same = tags.length === this.tags.length
      && tags.every((tag, i) => tag.price === this.tags[i]!.price && tag.color === this.tags[i]!.color);
    if (same) return;
    this.tags = tags;
    this.views = tags.map((tag): ISeriesPrimitiveAxisView => ({
      coordinate: () => this.series?.priceToCoordinate(tag.price) ?? -1e6,
      text: () => this.text(tag.price),
      textColor: () => chipTextColor(tag.color),
      backColor: () => tag.color,
      visible: () => this.series?.priceToCoordinate(tag.price) != null,
    }));
    this.requestUpdate?.();
  }

  priceAxisViews(): readonly ISeriesPrimitiveAxisView[] { return this.views; }

  private text(price: number): string {
    const series = this.series;
    if (series === null) return "";
    try {
      return priceAxisText(price, firstVisibleClose(this.chart, series), readPriceAxisFormatting(this.chart, series));
    } catch { return ""; }
  }
}
