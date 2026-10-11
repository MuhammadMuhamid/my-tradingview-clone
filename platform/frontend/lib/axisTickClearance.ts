/**
 * Price-axis tick labels never show half a number under a pill (E2).
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 *
 * lightweight-charts 4.2.3 paints the price axis in a fixed order: the ground,
 * every tick label, the primitives' own axis views, then every label — the
 * last-price chip, each moving average's pill, a study's value, an RSI band —
 * on top. Nothing between those steps asks whether a pill landed on a tick.
 * A pill is about 17px tall and a tick label about 12, so whenever the scale
 * puts a round number near a live value the pill covers PART of it, and the
 * axis reads `80,000.00` with its lower half shaved off: a number the eye
 * still tries to read, beside the one it should. It came and went with the
 * zoom, which is what one would expect of an overlap no one tests for.
 *
 * The reference never shows a tick label a label has touched. That is the
 * rule here, applied to what was actually DRAWN rather than to a prediction of
 * it: after the axis has painted, its pixels are read, the label boxes and the
 * tick-text runs are told apart by the one column only a label box ever fills
 * (`axisColumns`), and any tick run that a label box touches is painted back
 * to the ground. A tick the
 * pill covered completely has nothing left to remove; one it never reached is
 * left alone. Reading pixels is what makes this exact: the library does not
 * expose where its ticks or its packed labels are, and re-deriving either
 * would be a second implementation of its layout, wrong in some mode.
 *
 * Plain functions over a pixel buffer, so `tests/axisTickClearance.test.ts`
 * runs in node; the primitive below is the only part that needs a canvas.
 */
import type {
  IChartApiBase, ISeriesApi, ISeriesPrimitive, ISeriesPrimitivePaneRenderer, ISeriesPrimitivePaneView,
  SeriesAttachedParameter, SeriesType, Time,
} from "lightweight-charts";
import type { CanvasRenderingTarget2D } from "fancy-canvas";

export type Rgb = readonly [number, number, number];
/** A ground colour as the canvas stores it: rgb, and alpha on 0–255. */
export type Rgba = readonly [number, number, number, number];

/** A channel this far from the ground is ink, not antialiasing noise. */
const INK_DISTANCE = 24;
/** lightweight-charts' `RendererConstants.TickLength`, in CSS px. */
export const TICK_LENGTH = 5;

export type RowKind = "empty" | "ink" | "label";

/**
 * Where to look, in bitmap columns, to tell a label row from a tick row.
 *
 * The library draws every label box FLUSH against the plot-facing edge — its
 * rect starts at the scale's inner edge and spans the tick stub and the inner
 * padding before its text. A tick label's text starts only after that same
 * stub and padding, and the stub itself is one row tall. So the column in the
 * middle of the inner padding is inked on every row of every label box and on
 * no row of any tick label: one pixel answers which a row is, where a coverage
 * or run-length test was fooled by a narrow pill's own glyphs (which break its
 * fill into short runs) and by its rounded corners.
 */
export function axisColumns(
  fontSize: number, horizontalPixelRatio: number, width: number, side: "left" | "right",
): { probe: number; textFrom: number; textTo: number } {
  const paddingInner = (fontSize / 12) * TICK_LENGTH;
  const probeCss = TICK_LENGTH + paddingInner / 2;
  const textCss = TICK_LENGTH + paddingInner;
  const probe = Math.round(probeCss * horizontalPixelRatio);
  const text = Math.round(textCss * horizontalPixelRatio);
  return side === "right"
    ? { probe, textFrom: text, textTo: width }
    : { probe: width - 1 - probe, textFrom: 0, textTo: width - text };
}

/** What each bitmap row of the axis holds. */
export function classifyRows(
  data: Uint8ClampedArray, width: number, height: number,
  columns: { probe: number; textFrom: number; textTo: number },
  groundAt: (row: number) => Rgba,
): RowKind[] {
  const rows: RowKind[] = new Array(height);
  /*
   * Alpha counts. A pane whose ground is transparent (a study pane over the
   * page) stores its empty pixels as 0,0,0,0 — and a black glyph on it is
   * 0,0,0,255. Comparing colour alone would call that glyph ground.
   */
  const inked = (y: number, x: number, ground: Rgba): boolean => {
    const i = (y * width + x) * 4;
    return Math.abs(data[i + 3]! - ground[3]) > INK_DISTANCE
      || (data[i + 3]! > 0 && (Math.abs(data[i]! - ground[0]) > INK_DISTANCE
        || Math.abs(data[i + 1]! - ground[1]) > INK_DISTANCE
        || Math.abs(data[i + 2]! - ground[2]) > INK_DISTANCE));
  };
  for (let y = 0; y < height; y++) {
    const ground = groundAt(y);
    if (inked(y, columns.probe, ground)) { rows[y] = "label"; continue; }
    let any = false;
    for (let x = columns.textFrom; x < columns.textTo && !any; x++) any = inked(y, x, ground);
    rows[y] = any ? "ink" : "empty";
  }
  return rows;
}

/**
 * The tick-text runs a label box touches: `[first, last]` row pairs to clear.
 *
 * A run is consecutive `ink` rows — one tick label's glyphs. It is cleared when
 * the row just above or just below it belongs to a label, which is exactly the
 * state of a tick the label's box overlaps: the part under the box became
 * label rows, the part outside it is the remnant.
 */
export function truncatedTickRuns(rows: readonly RowKind[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let y = 0;
  while (y < rows.length) {
    if (rows[y] !== "ink") { y++; continue; }
    const start = y;
    while (y < rows.length && rows[y] === "ink") y++;
    const end = y - 1;
    if (rows[start - 1] === "label" || rows[end + 1] === "label") out.push([start, end]);
  }
  return out;
}

/** `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()`, `rgba()` and `transparent`; null for anything else. */
export function parseColour(text: string): Rgba | null {
  const value = text.trim();
  if (value.toLowerCase() === "transparent") return [0, 0, 0, 0];
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value);
  if (hex) {
    const h = hex[1]!;
    if (h.length === 3) return [parseInt(h[0]! + h[0]!, 16), parseInt(h[1]! + h[1]!, 16), parseInt(h[2]! + h[2]!, 16), 255];
    const alpha = h.length === 8 ? parseInt(h.slice(6, 8), 16) : 255;
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), alpha];
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i.exec(value);
  if (rgb) {
    const a = rgb[4] === undefined ? 1
      : rgb[4].endsWith("%") ? Number(rgb[4].slice(0, -1)) / 100 : Number(rgb[4]);
    return [Math.round(Number(rgb[1])), Math.round(Number(rgb[2])), Math.round(Number(rgb[3])),
      Math.round(Math.min(1, Math.max(0, a)) * 255)];
  }
  return null;
}

type Background =
  | { type?: string; color?: string; topColor?: string; bottomColor?: string }
  | undefined;

/** The ground colour on one bitmap row, for a solid or a vertical gradient. */
export function groundFor(background: Background, height: number): ((row: number) => Rgba) | null {
  if (!background) return null;
  if (background.type === "gradient") {
    const top = parseColour(background.topColor ?? "");
    const bottom = parseColour(background.bottomColor ?? "");
    if (!top || !bottom) return null;
    return (row) => {
      const t = height <= 1 ? 0 : row / (height - 1);
      return [0, 1, 2, 3].map((i) => Math.round(top[i]! + (bottom[i]! - top[i]!) * t)) as unknown as Rgba;
    };
  }
  const solid = parseColour(background.color ?? "");
  return solid ? () => solid : null;
}

/**
 * Attach one to any series on a chart: it acts on that series' price axis.
 *
 * Drawn from the axis's TOP layer, which the library paints after the main
 * axis canvas has its ticks and labels; the main canvas is the top canvas's
 * sibling, and that is the canvas cleaned. A cursor-only repaint leaves the
 * main canvas as it was, so the clean survives the crosshair moving.
 */
export class AxisTickClearancePrimitive implements ISeriesPrimitive {
  private chart: IChartApiBase<Time> | null = null;
  private series: ISeriesApi<SeriesType> | null = null;
  private readonly views: readonly ISeriesPrimitivePaneView[];

  constructor() {
    const renderer: ISeriesPrimitivePaneRenderer = {
      draw: (target: CanvasRenderingTarget2D) => { this.clean(target); },
    };
    this.views = [{ zOrder: () => "top", renderer: () => renderer }];
  }

  attached(param: SeriesAttachedParameter<Time, SeriesType>): void {
    this.chart = param.chart ?? null;
    this.series = param.series;
  }

  detached(): void { this.chart = null; this.series = null; }

  priceAxisPaneViews(): readonly ISeriesPrimitivePaneView[] { return this.views; }

  private clean(target: CanvasRenderingTarget2D): void {
    target.useBitmapCoordinateSpace(({ context, horizontalPixelRatio }) => {
      const main = context.canvas?.previousElementSibling;
      if (!(main instanceof HTMLCanvasElement)) return;
      const ctx = main.getContext("2d");
      if (!ctx || main.width === 0 || main.height === 0) return;
      let background: Background;
      let fontSize: number;
      let side: "left" | "right";
      try {
        const options = this.chart?.options();
        if (!options) return;
        background = options.layout.background as Background;
        fontSize = options.layout.fontSize;
        side = this.series?.options().priceScaleId === "left" ? "left" : "right";
      } catch { return; }
      const width = main.width;
      const height = main.height;
      const ground = groundFor(background, height);
      if (!ground) return;
      let image: ImageData;
      try { image = ctx.getImageData(0, 0, width, height); } catch { return; }
      const columns = axisColumns(fontSize, horizontalPixelRatio, width, side);
      const runs = truncatedTickRuns(classifyRows(image.data, width, height, columns, ground));
      // Put the ground back exactly as the library laid it: cleared, then the
      // background's own colour (which may be translucent or none at all).
      for (const [first, last] of runs) {
        for (let y = first; y <= last; y++) {
          const [r, g, b, a] = ground(y);
          ctx.clearRect(columns.textFrom, y, columns.textTo - columns.textFrom, 1);
          if (a === 0) continue;
          ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a / 255})`;
          ctx.fillRect(columns.textFrom, y, columns.textTo - columns.textFrom, 1);
        }
      }
    });
  }
}
