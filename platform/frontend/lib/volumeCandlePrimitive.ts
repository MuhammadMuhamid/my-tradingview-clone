/**
 * Volume candles, with volume as WIDTH.
 *
 * ── What was wrong ────────────────────────────────────────────────────────
 *
 * The type encoded volume as SHADE: every body the same width, its alpha
 * scaled by volume. The reference encodes it as the candle's width — a heavy
 * bar is a fat body, a thin bar a sliver — and this product's own chart-style
 * picker has always drawn that: three bodies of different widths. Shade is
 * also the weakest channel there is on a dark chart, where 35% and 60% green
 * are hard to tell apart; width is read at a glance.
 *
 * ── Why a primitive and not a custom series ───────────────────────────────
 *
 * A lightweight-charts custom series would replace the main CANDLESTICK
 * series for this one type, and that series is the seam the whole chart is
 * built on — the data paths' `update`/`replace` plans, the per-bar colours,
 * the legend, the countdown chip and every layer typed against it. Point &
 * figure already solved the same problem the cheap way, and this follows it:
 * the candle series stays, transparent, so the price scale fits, the
 * crosshair and the OHLC legend read and the last-price label prints exactly
 * as they do for ordinary candles; this file draws the bodies and owns no
 * state that could disagree with the series.
 *
 * ── The width rule ────────────────────────────────────────────────────────
 *
 * Each body is proportional to its volume against the largest volume IN
 * VIEW, so the heaviest visible bar always fills its slot and panning to a
 * quiet stretch does not shrink every bar to a hairline. A floor keeps a bar
 * with almost no volume a visible body rather than nothing, and the wick is
 * always centred in the slot, whatever the body's width.
 */
import type {
  IChartApiBase, ISeriesApi, ISeriesPrimitive, ISeriesPrimitivePaneRenderer,
  ISeriesPrimitivePaneView, SeriesAttachedParameter, SeriesType, Time,
} from "lightweight-charts";
import type { CanvasRenderingTarget2D } from "fancy-canvas";
import type { Candle } from "./types";

/** Share of the bar spacing the heaviest body takes — the library's own candle ratio. */
export const VOLUME_BODY_SHARE = 0.8;
/** The thinnest body, in pixels, so a quiet bar is still a bar. */
export const MIN_VOLUME_BODY_PX = 1;

/**
 * The body width of a bar of `volume`, in a slot `spacing` pixels wide, when
 * the heaviest bar in view traded `maxVolume`. Total: a missing or zero volume
 * is the floor, never NaN, and nothing exceeds the slot.
 */
export function volumeBodyWidth(volume: number, maxVolume: number, spacing: number): number {
  const full = Math.max(MIN_VOLUME_BODY_PX, spacing * VOLUME_BODY_SHARE);
  if (!(maxVolume > 0) || !Number.isFinite(volume) || volume <= 0) return MIN_VOLUME_BODY_PX;
  return Math.max(MIN_VOLUME_BODY_PX, Math.min(full, full * (volume / maxVolume)));
}

export interface VolumeCandleStyle {
  up: string;
  down: string;
  wickUp: string;
  wickDown: string;
  body: boolean;
  wicks: boolean;
}

export class VolumeCandlePrimitive implements ISeriesPrimitive {
  private series: ISeriesApi<SeriesType> | null = null;
  private chart: IChartApiBase<Time> | null = null;
  private requestUpdate: (() => void) | null = null;
  private readonly views: readonly ISeriesPrimitivePaneView[];
  private style: VolumeCandleStyle = {
    up: "#2ebd85", down: "#f6465d", wickUp: "#2ebd85", wickDown: "#f6465d", body: true, wicks: true,
  };

  /**
   * `bars` and `colorOf` are READ AT PAINT TIME rather than copied in, so a
   * live tick — which rewrites the chart's own record and repaints the series
   * — is drawn by the same frame, with nothing here to fall a tick behind.
   */
  constructor(
    private readonly bars: () => readonly Candle[],
    private readonly colorOf: (timeSec: number) => string | undefined,
  ) {
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

  update(style: VolumeCandleStyle): void {
    this.style = style;
    this.requestUpdate?.();
  }

  /**
   * The bars in view, by TIME rather than by logical index: another series on
   * the same time scale (a comparison, a study reaching into the future) adds
   * points of its own, and then index `i` is no longer `bars[i]`. One bar of
   * margin either side, so a body half off the edge is still drawn.
   */
  private visible(bars: readonly Candle[]): readonly Candle[] {
    const range = this.chart?.timeScale().getVisibleRange();
    if (!range || typeof range.from !== "number" || typeof range.to !== "number") return bars;
    const fromMs = range.from * 1000;
    const toMs = range.to * 1000;
    let lo = 0, hi = bars.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (bars[mid]!.openTime < fromMs) lo = mid + 1; else hi = mid; }
    const start = Math.max(0, lo - 1);
    lo = start; hi = bars.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (bars[mid]!.openTime <= toMs) lo = mid + 1; else hi = mid; }
    return bars.slice(start, Math.min(bars.length, lo + 1));
  }

  private paint(target: CanvasRenderingTarget2D): void {
    const series = this.series;
    const chart = this.chart;
    const all = this.bars();
    if (!series || !chart || all.length === 0) return;
    const scale = chart.timeScale();
    const spacing = scale.options().barSpacing;
    const shown = this.visible(all);
    let maxVolume = 0;
    for (const bar of shown) if (Number.isFinite(bar.volume) && bar.volume > maxVolume) maxVolume = bar.volume;
    const { up, down, wickUp, wickDown, body, wicks } = this.style;

    target.useMediaCoordinateSpace(({ context }) => {
      context.save();
      try {
        for (const bar of shown) {
          const x = scale.timeToCoordinate((bar.openTime / 1000) as unknown as Time);
          const yHigh = series.priceToCoordinate(bar.high);
          const yLow = series.priceToCoordinate(bar.low);
          const yOpen = series.priceToCoordinate(bar.open);
          const yClose = series.priceToCoordinate(bar.close);
          if (x === null || yHigh === null || yLow === null || yOpen === null || yClose === null) continue;
          const cx = Math.round(Number(x));
          const rising = bar.close >= bar.open;
          const own = this.colorOf(bar.openTime / 1000);
          if (wicks) {
            context.fillStyle = own ?? (rising ? wickUp : wickDown);
            const top = Math.min(Number(yHigh), Number(yLow));
            context.fillRect(cx, top, 1, Math.max(1, Math.abs(Number(yLow) - Number(yHigh))));
          }
          if (body) {
            const width = Math.round(volumeBodyWidth(bar.volume, maxVolume, spacing));
            const top = Math.min(Number(yOpen), Number(yClose));
            context.fillStyle = own ?? (rising ? up : down);
            // Centred on the wick: an even body straddles it, an odd one is
            // symmetrical about it.
            context.fillRect(cx - Math.floor((width - 1) / 2), top, width,
              Math.max(1, Math.abs(Number(yClose) - Number(yOpen))));
          }
        }
      } finally {
        context.restore();
      }
    });
  }
}
