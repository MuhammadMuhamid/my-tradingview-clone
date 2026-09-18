/**
 * Point & figure, drawn as X and O columns.
 *
 * ── What was wrong ────────────────────────────────────────────────────────
 *
 * `pointFigureColumns` has always produced the right arithmetic — each column
 * carries its direction, its box size and how many boxes it is — and the chart
 * fed that straight into a CANDLESTICK series. The result was solid green and
 * red rectangles: no wicks, no box grid, no glyphs, and nothing on screen
 * delimiting a box.
 *
 * Counting boxes is the entire act of reading a P&F chart. A column drawn as
 * one filled body cannot be counted, so the presentation did not merely look
 * unlike the reference — it withheld the only information the chart is for.
 * The chart-style picker's own icon draws X-O-X, so the product was promising
 * the notation in the menu and declining it on the chart.
 *
 * ── Why a primitive ───────────────────────────────────────────────────────
 *
 * A glyph per BOX is not a series shape any library series can express: one
 * column is one time slot holding between one and dozens of marks. The library
 * has one extension point for this, and this repository already uses it for
 * the bar countdown, so the pattern is established rather than invented here.
 *
 * The candle series stays, transparent. It keeps the price scale fitting, the
 * crosshair, the legend and the last-price label working off real data, and
 * means this file draws and nothing else — it owns no state that could
 * disagree with the series.
 */
import type {
  IChartApiBase, ISeriesApi, ISeriesPrimitive, ISeriesPrimitivePaneRenderer,
  ISeriesPrimitivePaneView, SeriesAttachedParameter, SeriesType, Time,
} from "lightweight-charts";
import type { CanvasRenderingTarget2D } from "fancy-canvas";
import type { PointFigureColumn } from "./chartTransforms";

/** The widest a glyph is allowed to get, so one column cannot fill the pane. */
const MAX_GLYPH = 26;
/** Below this the marks become noise, and a plain column body reads better. */
const MIN_GLYPH = 3;

export class PointFigurePrimitive implements ISeriesPrimitive {
  private columns: readonly PointFigureColumn[] = [];
  private up = "#2ebd85";
  private down = "#f6465d";
  private series: ISeriesApi<SeriesType> | null = null;
  private chart: IChartApiBase<Time> | null = null;
  private requestUpdate: (() => void) | null = null;
  private readonly views: readonly ISeriesPrimitivePaneView[];

  constructor() {
    // One view in one array for the life of the primitive: the library caches
    // on the array's identity, so rebuilding either defeats that cache.
    const renderer: ISeriesPrimitivePaneRenderer = {
      draw: (target: CanvasRenderingTarget2D) => { this.paint(target); },
    };
    this.views = [{ renderer: () => renderer }];
  }

  attached(param: SeriesAttachedParameter<Time, SeriesType>): void {
    this.series = param.series;
    this.chart = param.chart ?? null;
    this.requestUpdate = param.requestUpdate;
  }

  detached(): void { this.series = null; this.chart = null; this.requestUpdate = null; }

  paneViews(): readonly ISeriesPrimitivePaneView[] { return this.views; }

  update(columns: readonly PointFigureColumn[], up: string, down: string): void {
    this.columns = columns;
    this.up = up;
    this.down = down;
    this.requestUpdate?.();
  }

  private paint(target: CanvasRenderingTarget2D): void {
    const series = this.series;
    const chart = this.chart;
    if (!series || !chart || this.columns.length === 0) return;
    const scale = chart.timeScale();

    target.useMediaCoordinateSpace(({ context, mediaSize }) => {
      context.save();
      try {
        /*
         * The glyph is as wide as a column is, bounded at both ends. Read from
         * the scale rather than from the data, so zooming changes the mark and
         * not the reading.
         */
        const spacing = scale.options().barSpacing;
        const width = Math.max(MIN_GLYPH, Math.min(MAX_GLYPH, spacing - 2));
        if (width < MIN_GLYPH) return;
        context.lineWidth = Math.max(1, Math.min(2.5, width / 8));
        context.lineCap = "round";

        for (const column of this.columns) {
          const x = scale.timeToCoordinate((column.openTime / 1000) as unknown as Time);
          if (x === null) continue;
          const cx = Number(x);
          // Off-screen columns cost nothing to skip and everything to draw.
          if (cx < -width || cx > mediaSize.width + width) continue;

          context.strokeStyle = column.direction === 1 ? this.up : this.down;
          const base = column.direction === 1 ? column.low : column.high;

          for (let box = 0; box < column.boxes; box += 1) {
            const from = base + column.direction * box * column.boxSize;
            const to = from + column.direction * column.boxSize;
            const yA = series.priceToCoordinate(from);
            const yB = series.priceToCoordinate(to);
            if (yA === null || yB === null) continue;
            const top = Math.min(Number(yA), Number(yB));
            const bottom = Math.max(Number(yA), Number(yB));
            const height = bottom - top;
            // A box shorter than a line is a smudge; the column's extent is
            // still readable from the ones that do fit.
            if (height < MIN_GLYPH) continue;

            const inset = Math.min(width, height) * 0.16;
            const left = cx - width / 2 + inset;
            const right = cx + width / 2 - inset;
            const upper = top + inset;
            const lower = bottom - inset;

            context.beginPath();
            if (column.direction === 1) {
              // X — two strokes, drawn corner to corner of the box.
              context.moveTo(left, upper);
              context.lineTo(right, lower);
              context.moveTo(right, upper);
              context.lineTo(left, lower);
            } else {
              // O — an ellipse inscribed in the box, so a tall box gives a tall
              // O rather than a circle floating in it.
              context.ellipse(
                cx, (upper + lower) / 2,
                Math.max(1, (right - left) / 2), Math.max(1, (lower - upper) / 2),
                0, 0, Math.PI * 2,
              );
            }
            context.stroke();
          }
        }
      } finally {
        context.restore();
      }
    });
  }
}
