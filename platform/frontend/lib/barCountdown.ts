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
 */
import type {
  IChartApiBase, ISeriesApi, ISeriesPrimitive, ISeriesPrimitivePaneRenderer,
  ISeriesPrimitivePaneView, SeriesAttachedParameter, SeriesType, Time,
} from "lightweight-charts";
import type { CanvasRenderingTarget2D } from "fancy-canvas";

/**
 * `hh:mm:ss` until the bar closes.
 *
 * Moved here from `CandleChart` unchanged — the format is what the interval
 * chip's own tests read, and F-03 is about WHERE the countdown is drawn, not
 * what it says.
 */
export function countdownText(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

/* ── the plate's colour ───────────────────────────────────────────────────
 *
 * Read from the same two values the library reads, in the same order, so the
 * plate cannot disagree with a chip drawn by `SeriesPriceAxisView`:
 *
 *   const lastValueColor = source.priceLineColor(lastValueData.color);
 *   const colors = generateContrastColors(lastValueColor);
 *
 * where `Series.priceLineColor(lastBarColor)` is `options.priceLineColor ||
 * lastBarColor`, and `generateContrastColors` picks its ink by luminance.
 */

/** The ground the library would paint the last-value chip with. */
export function chipBackColor(priceLineColor: string, lastBarColor: string): string {
  return priceLineColor || lastBarColor;
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
  /** The tick's row: the one actually at that price. */
  tickY: number;
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
): PlatePlan | null {
  if (texts.length === 0) return null;
  const padding = (fontSize / 12) * TICK;
  const rowHeight = fontSize + 2 * ((2.5 / 12) * fontSize);
  const extra = (2 / 12) * fontSize;
  const widest = Math.max(...texts.map((text) => Math.ceil(measure(text))));
  const rows = texts.map((text, index) => ({ text, centreY: priceY + index * rowHeight }));
  return {
    left: 0,
    right: BORDER + padding + padding + widest + TICK,
    top: priceY - rowHeight / 2 - extra,
    bottom: rows[rows.length - 1]!.centreY + rowHeight / 2 + extra,
    textX: TICK + padding,
    rows,
    tickY: priceY,
  };
}

const DEFAULT_FONT_SIZE = 12;
const DEFAULT_FONT_FAMILY = `-apple-system, BlinkMacSystemFont, 'Trebuchet MS', Roboto, Ubuntu, sans-serif`;

export interface CountdownState {
  /** The last candle's close — the anchor when the visible range cannot be read. */
  price: number | null;
  /** What the countdown row reads, or null while there is nothing to count down to. */
  text: string | null;
  /** ONE ground for the plate. That single value is the "one plate" property. */
  backColor: string;
  /** The ink for that ground. */
  textColor: string;
  /** Whether this primitive draws the price row itself, the series' chip being off. */
  ownsPriceRow: boolean;
}

/** Just enough of a data item to read a close from, whatever series type it came from. */
interface PriceBearing { close?: unknown; value?: unknown }

/**
 * `MismatchDirection.NearestLeft`, as the value rather than the enum: this
 * module is unit-tested under plain node, and importing the chart library for
 * one constant would drag a browser bundle into that.
 */
const NEAREST_LEFT = -1;

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
    price: null, text: null, backColor: "#2a2e39", textColor: "#d1d4dc", ownsPriceRow: false,
  };
  private series: ISeriesApi<SeriesType> | null = null;
  private chart: IChartApiBase<Time> | null = null;
  private requestUpdate: (() => void) | null = null;
  private readonly views: readonly ISeriesPrimitivePaneView[];

  constructor() {
    /*
     * One view object in one array for the life of the primitive. The library
     * caches on the ARRAY's identity — its own docs say so — so rebuilding
     * either would defeat that cache every frame.
     */
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
      || before.backColor !== next.backColor || before.textColor !== next.textColor
      || before.ownsPriceRow !== next.ownsPriceRow) {
      this.requestUpdate?.();
    }
  }

  priceAxisPaneViews(): readonly ISeriesPrimitivePaneView[] { return this.views; }

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
   * The price the library's own chip would be on: the close of the last bar
   * inside the visible range, not the last bar there is. They are the same bar
   * until the chart is panned back, and the difference is the chip following
   * the pan — which is the behaviour the series' chip had and this replaces.
   */
  private chipPrice(): number | null {
    const series = this.series;
    if (series === null) return null;
    return this.lastVisiblePrice(series) ?? this.state.price;
  }

  private lastVisiblePrice(series: ISeriesApi<SeriesType>): number | null {
    const chart = this.chart;
    if (chart === null || typeof series.dataByIndex !== "function") return null;
    try {
      const range = chart.timeScale().getVisibleLogicalRange();
      if (range === null) return null;
      const bar = series.dataByIndex(Math.floor(range.to), NEAREST_LEFT) as PriceBearing | null;
      const price = bar?.close ?? bar?.value;
      return typeof price === "number" ? price : null;
    } catch {
      // A read that threw is a read we do without; the caller falls back to
      // the close React handed us.
      return null;
    }
  }

  /** The chip's text, through the series' own formatter, so precision is the library's. */
  private priceText(): string {
    const series = this.series;
    const price = this.chipPrice();
    if (series === null || price === null) return "";
    try { return series.priceFormatter().format(price); } catch { return ""; }
  }

  private fontSize(): number { return this.layout()?.fontSize ?? DEFAULT_FONT_SIZE; }

  private font(): string {
    const layout = this.layout();
    return `${layout?.fontSize ?? DEFAULT_FONT_SIZE}px ${layout?.fontFamily ?? DEFAULT_FONT_FAMILY}`;
  }

  private layout(): { fontSize: number; fontFamily: string } | null {
    try { return this.chart?.options().layout ?? null; } catch { return null; }
  }

  private paint(target: CanvasRenderingTarget2D): void {
    const texts = this.rowTexts();
    if (texts.length === 0) return;
    const priceY = this.anchor();
    if (priceY === null) return;
    const font = this.font();
    const fontSize = this.fontSize();
    const { backColor, textColor } = this.state;
    target.useMediaCoordinateSpace(({ context, mediaSize }) => {
      context.save();
      try {
        context.font = font;
        /*
         * Measured on the canvas the plate is about to be drawn on. That is
         * the whole point: a width read here and a width drawn here cannot be
         * two different numbers.
         */
        const plan = platePlan(texts, priceY, fontSize, (text) => context.measureText(text).width);
        // Nothing to draw for a plate the scale has moved out of the axis.
        if (plan === null || plan.bottom < 0 || plan.top > mediaSize.height) return;
        context.fillStyle = backColor;
        roundedRect(context, plan.left, plan.top, plan.right - plan.left, plan.bottom - plan.top);
        context.fill();
        context.fillStyle = textColor;
        // The stub the library draws at the labelled price, and only there.
        // Snapped to a whole row, or a one-pixel line straddling two of them
        // is drawn as two half-lit ones.
        context.fillRect(plan.left, Math.round(plan.tickY) - 1, TICK, 1);
        context.textAlign = "left";
        context.textBaseline = "middle";
        for (const row of plan.rows) {
          context.fillText(row.text, plan.textX, row.centreY + midCorrection(context, row.text));
        }
      } finally {
        context.restore();
      }
    });
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
