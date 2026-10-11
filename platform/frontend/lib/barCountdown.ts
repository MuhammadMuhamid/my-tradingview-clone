/**
 * The last-price plate: the price the PRICE AXIS shows, and the bar-close
 * countdown under it, as ONE object.
 *
 * ── The defect this replaces ───────────────────────────────────────────────
 *
 * TVP8 F-03. The countdown was an absolutely positioned DOM span whose `top`
 * was computed during React's render from `series.priceToCoordinate(close)`,
 * and re-computed only when the component re-rendered — which is once a second,
 * off the clock that changes the TEXT.
 *
 * That is two independent answers to one question. The chip is drawn by the
 * library from the series' own last value, at the moment the library paints;
 * the span was placed by us from the last CANDLE's close, at the moment React
 * rendered. Insert a study pane and the chart's container shrinks: the library
 * re-lays-out on its own schedule, and until the next render that agrees with
 * it the span sits at a coordinate from the old geometry — which on a quiet
 * feed is every render, because nothing else moves. The reported symptom is
 * exactly that: the countdown painted ON TOP of the price chip, its 58px of
 * `bg-surface` hiding all but the first digit, and staying there until reload.
 *
 * ── F-03-R: why ONE plate, drawn here ──────────────────────────────────────
 *
 * The first repair put the countdown in `priceAxisViews()` — the library's own
 * hook for a label on the price axis — and left the price to the series'
 * `lastValueVisible` chip. That killed the overlap: the library computes the
 * coordinates in one pass, during its own paint, so no label can sit at a
 * coordinate one layout behind the chip's. What it could not do is make the
 * two labels agree with each other. The chip takes its ground from
 * `priceLineColor` (slate); the countdown took the bar's direction (red or
 * green). And each label sizes its own plate to its own text, so the countdown
 * overhung the price by 19px. Two colours and two widths read as two chips,
 * not as the reference's one plate (`09d_tv_pricelabel_crop.png`: `332.14`
 * over `19:52`, one ground, one width, edges shared).
 *
 * Colour is fixable through that hook. Width is not. A label's plate is
 * `border + padding + ceil(measureText(text)) + tick` wide and nothing but the
 * text moves it, so the only lever is padding the shorter string — and a
 * padded string is one whose width we have to PREDICT. Measured on the running
 * chart, the prediction does not hold: a canvas of ours and the library's own
 * canvas, given the same font and the same string, returned widths differing
 * by up to four percent, so plates sized level came out one to three pixels
 * apart, and which way depended on the price.
 *
 * So the plate is drawn here instead, as one rounded rect with a row of text
 * per line, through `priceAxisPaneViews()` — and measured on the very canvas
 * it is drawn on, which is the one ruler that cannot disagree with itself. One
 * rect is one ground, one width and two shared edges by construction rather
 * than by arithmetic. The geometry mirrors `PriceAxisViewRenderer`'s so the
 * plate reads as the axis's own: the same paddings off the font size, the same
 * 5px tick at the labelled price, the same small radius on the corners away
 * from the chart.
 *
 * The series' own chip stands down while this is on (`lastValueVisible: false`
 * in `CandleChart`), so there is exactly one object at the last price.
 *
 * ── F-03-R2: the plate owns the PRESENTATION, never the SEMANTICS ─────────
 *
 * Drawing the price row is not the same as deciding what it says. The first
 * one-rect plate formatted the price through `series.priceFormatter()` — the
 * raw series formatter — and so printed `2416.65` beside an axis reading
 * `2,420.00`, and on an Indexed-to-100 scale printed the raw `98.64` under a
 * label reading `101.60`. The axis, and the chip this replaces, format through
 * `PriceScale.formatPrice(price, firstValue)`: the scale's MODE decides the
 * value (raw, percentage of the first visible close, or indexed to it) and
 * the chart's localization decides the text. That switch lives once, in
 * `lib/priceAxisText`, and this primitive reads its inputs off the chart at
 * draw time — the mode, the localization formatter, the first and last
 * visible closes — and prints whatever the axis would. Every mode, Percentage
 * included, so there is no mode in which the library's chip and a row of ours
 * have to share the price coordinate.
 *
 * ── A8: the LIVE price, in the SERIES' colour, above every other pill ─────
 *
 * Measured against Premium on SOLUSDT 15m, the plate read `109.56 / 00:03:28`
 * in slate while the status line, the watchlist and the plate's own dashed
 * price line all said 109.70 — and a blue moving-average pill at 109.68 sat on
 * top of it, so what showed was a blue pill with a grey sliver of countdown
 * under it. Three defects, which read as one: "two labels, one of them stale".
 *
 *   The price. The row followed `lastValueData(false)` — the last bar INSIDE
 *   the visible range, which is what the library's own chip reads. But the
 *   library draws its dashed price line from `lastValueData(true)`, the last
 *   bar there is (`priceLineSource: LastBar`), so whenever the newest bar was
 *   not in view the plate described the bar before it and sat a row away from
 *   its own line. The reference's label is the live price, always. The row is
 *   now `lastClose`: the series' final bar, read at draw time, so a tick moves
 *   it in the frame the tick is drawn in.
 *
 *   The colour. It was `priceLineColor || lastBarColor`, and `priceLineColor`
 *   is the `Last price line` setting — slate by default — so the second half
 *   never ran. The reference paints the label in the SERIES' colour: the last
 *   bar's own colour for candles and bars (up, down, or the per-bar colour a
 *   script set), the line's for a line. `plateGround` decides it from the same
 *   final bar, at draw time.
 *
 *   The stacking. A primitive's normal price-axis pane view paints BEFORE the
 *   library's labels, so every study pill landed on top of the plate. The
 *   plate now paints from the axis's TOP pass — after every label — onto the
 *   axis's main canvas, where `lib/axisTickClearance` (attached after this
 *   one, and run from the same pass) still sees it as a label box and clears
 *   any tick it touches. It also holds its place in the library's own label
 *   packing: one transparent axis view per row, pinned by `fixedCoordinate`,
 *   so with `No overlapping labels` on the other pills are moved off the plate
 *   the way they are moved off each other, rather than painted over.
 *
 * The series' own chip is now off in EVERY state (`CandleChart`), not only
 * while the countdown runs: with the countdown off the plate is a single row —
 * the same price, the same ground — rather than a library chip with another
 * anchor and another colour.
 */
import type {
  IChartApiBase, ISeriesApi, ISeriesPrimitive, ISeriesPrimitiveAxisView, ISeriesPrimitivePaneRenderer,
  ISeriesPrimitivePaneView, SeriesAttachedParameter, SeriesType, Time,
} from "lightweight-charts";
import type { CanvasRenderingTarget2D } from "fancy-canvas";
import {
  firstVisibleClose, lastBar, lastClose, priceAxisText, readPriceAxisFormatting,
} from "./priceAxisText";

/**
 * `hh:mm:ss` until the bar closes.
 *
 * Moved here from `CandleChart` unchanged — the format is what the interval
 * chip's own tests read, and F-03 is about WHERE the countdown is drawn, not
 * what it says.
 */
/**
 * Time until the CURRENT bar closes, from the clock and the interval.
 *
 * W2D-01: the plate read `last.closeTime - now`, and the newest bar a window
 * holds is often one that has already closed — a provider history that ends
 * on the last completed bar, a cold load, the first second of a new bar before
 * its first frame. The plate then sat at `00:00:00` for as long as it took the
 * forming bar to arrive. The bar boundary is not data; it is the interval's
 * grid, so a close that has passed is rolled forward by whole intervals to the
 * slot the clock is in now. Every resolution this product offers is a fixed
 * length (`lib/resolution`), so the roll is exact.
 *
 * A close still in the future is returned as it is: that IS the forming bar.
 */
export function barCloseCountdownMs(
  lastCloseTime: number, intervalMs: number, nowMs: number,
): number {
  const remaining = lastCloseTime - nowMs;
  if (remaining > 0 || !(intervalMs > 0) || !Number.isFinite(lastCloseTime)) return remaining;
  const slots = Math.floor((nowMs - lastCloseTime) / intervalMs) + 1;
  return lastCloseTime + slots * intervalMs - nowMs;
}

export function countdownText(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

/* ── the plate's colour ───────────────────────────────────────────────────
 *
 * The SERIES' colour at its last bar (A8), which is the reference's: green
 * over a rising candle, red over a falling one, the line's own colour on a
 * line. Not `priceLineColor` — that is the `Last price line` setting, slate by
 * default, and taking it first is what painted every plate slate whatever the
 * bar did.
 *
 * Decided from the bar itself at draw time, so a tick that turns the bar
 * round turns the plate round in the same frame, with no React render.
 */

/** The colours a plate can take, in the chart's own current settings. */
export interface PlatePalette {
  /** A bar that closed at or above its open. */
  up: string;
  /** A bar that closed below its open. */
  down: string;
  /** A series with no open — line, area, histogram, baseline. */
  line: string;
}

/**
 * The ground for a plate over `bar`.
 *
 * In the order the library's own bar colourer uses: a per-bar `color` (a
 * script's `barcolor`, or `Color bars based on previous close`) wins, then the
 * direction of an OHLC bar, then the series' line.
 */
export function plateGround(bar: unknown, palette: PlatePalette): string {
  const item = bar as { color?: unknown; open?: unknown; close?: unknown } | null | undefined;
  if (typeof item?.color === "string" && item.color !== "") return item.color;
  if (typeof item?.open === "number" && typeof item.close === "number") {
    return item.close >= item.open ? palette.up : palette.down;
  }
  return palette.line;
}

/** The ink the library would pick for that ground. */
export function chipTextColor(backColor: string): string {
  const rgb = parseRgb(backColor);
  if (rgb === null) return "white";
  // `rgbaToGrayscale`, weights and threshold as the library has them.
  return 0.199 * rgb[0] + 0.687 * rgb[1] + 0.114 * rgb[2] > 160 ? "black" : "white";
}

function parseRgb(color: string): [number, number, number] | null {
  const text = color.trim();
  const hex = /^#([0-9a-f]{3,8})$/i.exec(text);
  if (hex) {
    const digits = hex[1]!;
    if (digits.length === 3 || digits.length === 4) {
      const pair = (i: number) => parseInt(digits[i]!.repeat(2), 16);
      return [pair(0), pair(1), pair(2)];
    }
    if (digits.length === 6 || digits.length === 8) {
      const pair = (i: number) => parseInt(digits.slice(i, i + 2), 16);
      return [pair(0), pair(2), pair(4)];
    }
    return null;
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(text);
  if (rgb) {
    const parts = rgb[1]!.split(/[,\s/]+/).filter((p) => p !== "").map(Number);
    if (parts.length >= 3 && parts.slice(0, 3).every((n) => Number.isFinite(n))) {
      return [parts[0]!, parts[1]!, parts[2]!];
    }
  }
  return null;
}

/* ── the plate's geometry ─────────────────────────────────────────────────
 *
 * `PriceAxisViewRenderer`'s own numbers, so a plate of ours sits on the axis
 * the way every label the library draws does.
 */

/** `RendererConstants.TickLength`: the stub that points at the labelled price. */
const TICK = 5;
/** `RendererConstants.BorderSize`. */
const BORDER = 1;
/** The radius the library rounds a label's outer corners by. */
const RADIUS = 2;

export interface PlateRow {
  text: string;
  /** The row's vertical middle, in the price axis's own coordinates. */
  centreY: number;
}

export interface PlatePlan {
  /** The chart-facing edge; a right-hand scale draws rightwards from it. */
  left: number;
  right: number;
  top: number;
  bottom: number;
  /** Where every row's text starts. One x, so the rows read as one column. */
  textX: number;
  rows: readonly PlateRow[];
  /** The tick's row: the one actually at that price. None when the price row is not ours. */
  tickY: number | null;
}

export interface PlateOptions {
  /**
   * The series' own chip is on the price coordinate, so this plate must not
   * be: its rows start one row height below the price, where the library's
   * `recalculateOverlapping` would have packed a colliding label, and there is
   * no tick because the chip has one. The state that produced F-03's overlap
   * in Percentage scale, made impossible by construction.
   */
  belowVisibleChip?: boolean;
}

/**
 * One rect around every row.
 *
 * The width is the WIDEST row's, so no row can reach an edge another does not
 * — the equality the two-label version had to predict, and could not. Rows sit
 * one label height apart, which is the distance the library's own
 * `recalculateOverlapping` packs colliding labels at, and the rect is grown
 * past them by `extra` top and bottom, which is the padding the library adds
 * to a primitive's own axis label. Together that is the ~38px the accepted
 * repair measured, with the price row's middle still exactly on its price.
 */
export function platePlan(
  texts: readonly string[],
  priceY: number,
  fontSize: number,
  measure: (text: string) => number,
  options: PlateOptions = {},
): PlatePlan | null {
  if (texts.length === 0) return null;
  const padding = (fontSize / 12) * TICK;
  const rowHeight = fontSize + 2 * ((2.5 / 12) * fontSize);
  const extra = (2 / 12) * fontSize;
  const widest = Math.max(...texts.map((text) => Math.ceil(measure(text))));
  const firstY = options.belowVisibleChip ? priceY + rowHeight : priceY;
  const rows = texts.map((text, index) => ({ text, centreY: firstY + index * rowHeight }));
  return {
    left: 0,
    right: BORDER + padding + padding + widest + TICK,
    top: firstY - rowHeight / 2 - extra,
    bottom: rows[rows.length - 1]!.centreY + rowHeight / 2 + extra,
    textX: TICK + padding,
    rows,
    tickY: options.belowVisibleChip ? null : priceY,
  };
}

const DEFAULT_FONT_SIZE = 12;
const DEFAULT_FONT_FAMILY = `-apple-system, BlinkMacSystemFont, 'Trebuchet MS', Roboto, Ubuntu, sans-serif`;

export interface CountdownState {
  /** The last candle's close — the anchor when the series cannot be read. */
  price: number | null;
  /** What the countdown row reads, or null while there is nothing to count down to. */
  text: string | null;
  /**
   * What the ONE ground is chosen from. One ground for both rows is the "one
   * plate" property; which colour it is follows the last bar (`plateGround`).
   */
  palette: PlatePalette;
  /** Whether this primitive draws the price row itself, the series' chip being off. */
  ownsPriceRow: boolean;
}

/** Ground and ink, as one decision. */
export interface PlateColors { backColor: string; textColor: string }

/** A ground nothing paints with: the packing placeholders' (see `axisViews`). */
const INVISIBLE = "rgba(0, 0, 0, 0)";

/**
 * The last-price plate, drawn on the price axis.
 *
 * Everything the plate is made of — the price, its coordinate, the countdown,
 * the colour, the measurement — is read inside the one `draw` call, on the
 * canvas being drawn. There is no second copy of the geometry to fall behind
 * (F-03), and no second ruler to disagree with (F-03-R).
 */
export class BarCountdownPrimitive implements ISeriesPrimitive {
  private state: CountdownState = {
    price: null, text: null, palette: { up: "#2a2e39", down: "#2a2e39", line: "#2a2e39" },
    ownsPriceRow: false,
  };
  private series: ISeriesApi<SeriesType> | null = null;
  private chart: IChartApiBase<Time> | null = null;
  private requestUpdate: (() => void) | null = null;
  private readonly views: readonly ISeriesPrimitivePaneView[];
  private readonly axisViews: readonly ISeriesPrimitiveAxisView[];

  constructor() {
    /*
     * One view object in one array for the life of the primitive. The library
     * caches on the ARRAY's identity — its own docs say so — so rebuilding
     * either would defeat that cache every frame.
     *
     * `top`, so the plate is painted after the library's labels (A8): a pane
     * view in the `normal` layer is drawn before them, and every study pill
     * that came near the last price was painted over it.
     */
    const renderer: ISeriesPrimitivePaneRenderer = {
      draw: (target: CanvasRenderingTarget2D) => { this.paint(target); },
    };
    this.views = [{ zOrder: () => "top", renderer: () => renderer }];
    /*
     * The plate's place in the library's label packing (A8).
     *
     * The plate is drawn by this primitive, not as a library label, so the
     * packing that keeps labels off each other (`alignLabels`, the
     * `No overlapping labels` setting) did not know it was there. One
     * placeholder per row tells it: transparent, so it paints nothing, the
     * row's own text, so it is the row's width and the axis is sized to fit
     * the plate, and `fixedCoordinate`, so the packing moves the OTHER labels
     * around it rather than it — the library's own reading of that field.
     */
    this.axisViews = [0, 1].map((index): ISeriesPrimitiveAxisView => ({
      coordinate: () => this.rowCentre(index) ?? -1e6,
      fixedCoordinate: () => this.rowCentre(index) ?? undefined,
      text: () => this.rowTexts()[index] ?? "",
      textColor: () => INVISIBLE,
      backColor: () => INVISIBLE,
      visible: () => this.rowCentre(index) !== null,
      tickVisible: () => false,
    }));
  }

  attached(param: SeriesAttachedParameter<Time, SeriesType>): void {
    this.series = param.series;
    this.chart = param.chart ?? null;
    this.requestUpdate = param.requestUpdate;
  }

  detached(): void { this.series = null; this.chart = null; this.requestUpdate = null; }

  /**
   * What the plate says and what colour it says it in.
   *
   * `requestUpdate` is the library's own "redraw me": the text changes once a
   * second with no data behind it, and asking the CHART to repaint is what
   * makes that second tick appear without a React render or a series option
   * write to fake one.
   */
  update(next: CountdownState): void {
    const before = this.state;
    this.state = next;
    if (before.text !== next.text || before.price !== next.price
      || before.palette.up !== next.palette.up || before.palette.down !== next.palette.down
      || before.palette.line !== next.palette.line
      || before.ownsPriceRow !== next.ownsPriceRow) {
      this.requestUpdate?.();
    }
  }

  priceAxisPaneViews(): readonly ISeriesPrimitivePaneView[] { return this.views; }

  priceAxisViews(): readonly ISeriesPrimitiveAxisView[] { return this.axisViews; }

  /**
   * Where row `index` of the plate is centred, or null when it has none —
   * what the packing placeholders report, so they cannot describe a different
   * plate from the one `draw` paints.
   */
  rowCentre(index: number): number | null {
    const plan = this.plan((text) => text.length);
    return plan?.rows[index]?.centreY ?? null;
  }

  /** The plate's ground and ink right now, from the series' last bar (A8). */
  colors(): PlateColors {
    const series = this.series;
    const backColor = plateGround(series === null ? null : lastBar(series), this.state.palette);
    return { backColor, textColor: chipTextColor(backColor) };
  }

  /** The rows the plate has right now: the price, the countdown, both or neither. */
  rowTexts(): string[] {
    const texts: string[] = [];
    if (this.state.ownsPriceRow) {
      const price = this.priceText();
      if (price !== "") texts.push(price);
    }
    if (this.state.text !== null) texts.push(this.state.text);
    return texts;
  }

  /** The coordinate the plate hangs from, read at call time and never cached. */
  anchor(): number | null {
    const series = this.series;
    if (series === null) return null;
    const price = this.chipPrice();
    if (price === null) return null;
    const y = series.priceToCoordinate(price);
    return y === null ? null : y;
  }

  /**
   * The price the plate is on: the LAST bar's close, wherever the view is —
   * the live price, and the bar the dashed price line is drawn from (A8).
   *
   * It used to be the last bar inside the visible range, which is the
   * library's chip's reading. That put the plate a bar behind its own price
   * line whenever the newest bar was out of view, which on a running feed is
   * the moment it opens, until the chart is scrolled to meet it.
   */
  private chipPrice(): number | null {
    const series = this.series;
    if (series === null) return null;
    // A read that fails is a read we do without: the close React handed us.
    return lastClose(series) ?? this.state.price;
  }

  /**
   * The chip's text: what the AXIS prints for this price, in the scale's
   * current mode, through the chart's own localization — `lib/priceAxisText`,
   * with every input read off the chart now. Not the series' raw formatter,
   * which is neither grouped nor mode-aware (F-03-R2).
   */
  private priceText(): string {
    const series = this.series;
    const price = this.chipPrice();
    if (series === null || price === null) return "";
    try {
      return priceAxisText(
        price,
        firstVisibleClose(this.chart, series),
        readPriceAxisFormatting(this.chart, series),
      );
    } catch { return ""; }
  }

  /**
   * Whether the series' own chip is on the price coordinate right now. When
   * it is, and the price row is not ours, the plate goes under it rather
   * than on it — the guard that makes the F-03 overlap unreachable whatever
   * `CandleChart` decides about who owns the row.
   */
  chipVisible(): boolean {
    if (this.state.ownsPriceRow) return false;
    try { return this.series?.options().lastValueVisible === true; } catch { return false; }
  }

  /** The plan `draw` would paint with, for a given ruler; what the tests read. */
  plan(measure: (text: string) => number): PlatePlan | null {
    const texts = this.rowTexts();
    if (texts.length === 0) return null;
    const priceY = this.anchor();
    if (priceY === null) return null;
    return platePlan(texts, priceY, this.fontSize(), measure, { belowVisibleChip: this.chipVisible() });
  }

  private fontSize(): number { return this.layout()?.fontSize ?? DEFAULT_FONT_SIZE; }

  private font(): string {
    const layout = this.layout();
    return `${layout?.fontSize ?? DEFAULT_FONT_SIZE}px ${layout?.fontFamily ?? DEFAULT_FONT_FAMILY}`;
  }

  private layout(): { fontSize: number; fontFamily: string } | null {
    try { return this.chart?.options().layout ?? null; } catch { return null; }
  }

  /**
   * Paint the plate onto the axis's MAIN canvas, from the axis's top pass.
   *
   * The top pass runs after the main canvas has its ground, ticks and every
   * library label, which is the only moment the plate can be drawn over the
   * study pills (A8). It is drawn onto the MAIN canvas rather than the top one
   * because the main canvas is where the axis's labels live: that is the one
   * `lib/axisTickClearance` reads to find label boxes and the ticks they
   * half-cover, and the one a crosshair-only repaint leaves alone — so the
   * plate is never wiped by the crosshair moving, and never covers the
   * crosshair's own label, which is drawn on the top canvas.
   *
   * Repainting it on a crosshair-only pass is idempotent: the plate is an
   * opaque rect with its text drawn fresh on it, at a position that only a
   * full repaint (data, scale, or `requestUpdate`) can move.
   */
  private paint(target: CanvasRenderingTarget2D): void {
    target.useBitmapCoordinateSpace(({ context, bitmapSize, horizontalPixelRatio, verticalPixelRatio }) => {
      const sibling = (context.canvas as HTMLCanvasElement | undefined)?.previousElementSibling;
      const main = typeof HTMLCanvasElement !== "undefined" && sibling instanceof HTMLCanvasElement
        && sibling.width === bitmapSize.width && sibling.height === bitmapSize.height
        ? sibling.getContext("2d") : null;
      const ctx = main ?? context;
      ctx.save();
      try {
        ctx.setTransform(horizontalPixelRatio, 0, 0, verticalPixelRatio, 0, 0);
        this.paintMedia(ctx, {
          width: bitmapSize.width / horizontalPixelRatio,
          height: bitmapSize.height / verticalPixelRatio,
        });
      } finally {
        ctx.restore();
      }
    });
  }

  /** The plate, in CSS pixels, on a context the caller has saved and will restore. */
  private paintMedia(context: CanvasRenderingContext2D, mediaSize: { width: number; height: number }): void {
    const { backColor, textColor } = this.colors();
    context.font = this.font();
    /*
     * Measured on the canvas the plate is about to be drawn on. That is the
     * whole point: a width read here and a width drawn here cannot be two
     * different numbers.
     */
    const plan = this.plan((text) => context.measureText(text).width);
    // Nothing to draw for a plate the scale has moved out of the axis.
    if (plan === null || plan.bottom < 0 || plan.top > mediaSize.height) return;
    context.fillStyle = backColor;
    roundedRect(context, plan.left, plan.top, plan.right - plan.left, plan.bottom - plan.top);
    context.fill();
    context.fillStyle = textColor;
    // The stub the library draws at the labelled price, and only there.
    // Snapped to a whole row, or a one-pixel line straddling two of them
    // is drawn as two half-lit ones.
    if (plan.tickY !== null) context.fillRect(plan.left, Math.round(plan.tickY) - 1, TICK, 1);
    context.textAlign = "left";
    context.textBaseline = "middle";
    for (const row of plan.rows) {
      context.fillText(row.text, plan.textX, row.centreY + midCorrection(context, row.text));
    }
  }
}

/** The library's own `yMidCorrection`: centre the glyphs, not the em box. */
function midCorrection(context: CanvasRenderingContext2D, text: string): number {
  const metrics = context.measureText(text);
  return ((metrics.actualBoundingBoxAscent || 0) - (metrics.actualBoundingBoxDescent || 0)) / 2;
}

/** Square against the chart, rounded away from it — the shape a label has. */
function roundedRect(
  context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number,
): void {
  const radius = Math.min(RADIUS, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x, y);
  context.lineTo(x + width - radius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + radius);
  context.lineTo(x + width, y + height - radius);
  context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  context.lineTo(x, y + height);
  context.closePath();
}
