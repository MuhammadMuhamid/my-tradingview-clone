/**
 * The bar-close countdown, as a label the PRICE AXIS draws.
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
 * ── Why a primitive ────────────────────────────────────────────────────────
 *
 * `ISeriesPrimitive.priceAxisViews()` is the library's own hook for putting a
 * label on the price axis. It calls `coordinate()` during ITS render pass, so
 * the coordinate is read from the price scale the chip is being drawn against
 * — never from a scale one layout behind it. And the library moves axis labels
 * apart to prevent them overlapping, so the countdown cannot cover the price
 * even if the two are asked for the same pixel.
 *
 * The reference draws the countdown as a second line inside the chip
 * (`09d_tv_pricelabel_crop.png`: `332.14` over `19:52`, one red plate). The
 * library draws one line per label, so this is the same thing in two labels:
 * the chip's own colour, immediately under it, moved apart by the library
 * rather than by arithmetic of ours.
 */
import type { ISeriesApi, ISeriesPrimitive, ISeriesPrimitiveAxisView, SeriesType } from "lightweight-charts";

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

export interface CountdownState {
  /** The price the chip is on — the same value the library labels. */
  price: number | null;
  /** What the label reads, or null while there is nothing to count down to. */
  text: string | null;
  backColor: string;
  textColor: string;
}

/**
 * A price-axis label under the last-price chip.
 *
 * `coordinate()` is deliberately the ONLY place the pixel is computed, and it
 * runs inside the library's own update: there is no second copy of the
 * geometry to fall behind.
 */
export class BarCountdownPrimitive implements ISeriesPrimitive {
  private state: CountdownState = {
    price: null, text: null, backColor: "#2a2e39", textColor: "#d1d4dc",
  };
  private series: ISeriesApi<SeriesType> | null = null;
  private requestUpdate: (() => void) | null = null;
  private readonly views: readonly ISeriesPrimitiveAxisView[];

  constructor() {
    /*
     * One view object for the life of the primitive. The library caches on the
     * ARRAY's identity — its own docs say so — so rebuilding either the array
     * or the view on each update would defeat that cache every frame.
     *
     * Arrow functions throughout, so `this` is the primitive without an alias.
     */
    this.views = [{
      coordinate: (): number => {
        const { price } = this.state;
        if (price === null || this.series === null) return -100;
        const y = this.series.priceToCoordinate(price);
        if (y === null) return -100;
        /*
         * The chip's own half-height plus a hair. The library then moves the
         * two labels apart if this still collides, which is what makes the
         * overlap impossible rather than merely unlikely.
         */
        return y + 18;
      },
      text: () => this.state.text ?? "",
      textColor: () => this.state.textColor,
      backColor: () => this.state.backColor,
      visible: () => this.state.text !== null && this.state.price !== null,
      // The chip above it already draws the tick; a second one is a second
      // line pointing at a price this label is not on.
      tickVisible: () => false,
    }];
  }

  attached(param: { series: ISeriesApi<SeriesType>; requestUpdate: () => void }): void {
    this.series = param.series;
    this.requestUpdate = param.requestUpdate;
  }

  detached(): void { this.series = null; this.requestUpdate = null; }

  /**
   * What the label says and what colour it says it in.
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
      || before.backColor !== next.backColor || before.textColor !== next.textColor) {
      this.requestUpdate?.();
    }
  }

  priceAxisViews(): readonly ISeriesPrimitiveAxisView[] { return this.views; }
}
