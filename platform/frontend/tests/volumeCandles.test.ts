/**
 * Volume candles carry volume as WIDTH (D-F6).
 *
 * The type used to shade every same-width body by volume, while the reference
 * — and this product's own chart-style icon — draws a heavy bar fat and a quiet
 * one thin. `VolumeCandlePrimitive` paints the bodies over a transparent
 * candle series; these tests drive its renderer against a stub scale and a
 * recording context, and pin the wiring that keeps the series transparent.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  MIN_VOLUME_BODY_PX, VOLUME_BODY_SHARE, VolumeCandlePrimitive, volumeBodyWidth,
} from "../lib/volumeCandlePrimitive";
import type { Candle } from "../lib/types";

const SPACING = 20;
const T0 = 1_700_000_000; // seconds

function bar(i: number, volume: number, rising = true): Candle {
  const open = rising ? 100 : 104;
  const close = rising ? 104 : 100;
  return {
    openTime: (T0 + i * 60) * 1000, closeTime: (T0 + (i + 1) * 60) * 1000 - 1,
    open, high: 106, low: 98, close, volume,
  } as Candle;
}

type Rect = { x: number; y: number; w: number; h: number; fill: string };

/** Paint once against a stub chart; `visible` is the time range in view, in seconds. */
function paint(
  bars: Candle[], visible: { from: number; to: number },
  colorOf: (t: number) => string | undefined = () => undefined,
  style?: Partial<Parameters<VolumeCandlePrimitive["update"]>[0]>,
): Rect[] {
  const rects: Rect[] = [];
  const context = {
    fillStyle: "",
    save() {}, restore() {},
    fillRect(x: number, y: number, w: number, h: number) { rects.push({ x, y, w, h, fill: this.fillStyle }); },
  };
  const primitive = new VolumeCandlePrimitive(() => bars, colorOf);
  primitive.attached({
    series: { priceToCoordinate: (p: number) => 500 - p * 4 },
    chart: {
      timeScale: () => ({
        options: () => ({ barSpacing: SPACING }),
        getVisibleRange: () => visible,
        timeToCoordinate: (t: number) => 100 + ((t - T0) / 60) * SPACING,
      }),
    },
    requestUpdate: () => {},
  } as never);
  primitive.update({
    up: "UP", down: "DOWN", wickUp: "WUP", wickDown: "WDOWN", body: true, wicks: true, ...style,
  });
  const renderer = primitive.paneViews()[0]!.renderer()!;
  renderer.draw({
    useMediaCoordinateSpace: (fn: (scope: unknown) => void) =>
      fn({ context, mediaSize: { width: 800, height: 600 } }),
  } as never);
  return rects;
}

const bodies = (rects: Rect[]) => rects.filter((r) => r.w > 1 || (r.fill !== "WUP" && r.fill !== "WDOWN"));

test("a body is as wide as its volume against the heaviest bar in view, with a floor", () => {
  const full = SPACING * VOLUME_BODY_SHARE;
  assert.equal(volumeBodyWidth(1000, 1000, SPACING), full, "the heaviest bar fills its slot");
  assert.equal(volumeBodyWidth(500, 1000, SPACING), full / 2, "half the volume, half the width");
  assert.equal(volumeBodyWidth(1, 1_000_000, SPACING), MIN_VOLUME_BODY_PX, "a quiet bar is still a body");
  assert.equal(volumeBodyWidth(0, 1000, SPACING), MIN_VOLUME_BODY_PX);
  assert.equal(volumeBodyWidth(Number.NaN, 1000, SPACING), MIN_VOLUME_BODY_PX);
  assert.equal(volumeBodyWidth(500, 0, SPACING), MIN_VOLUME_BODY_PX, "no volume in view is never NaN");
  assert.equal(volumeBodyWidth(2000, 1000, SPACING), full, "nothing is wider than its slot");
});

test("the renderer draws fat bodies for heavy bars and thin ones for quiet bars", () => {
  const bars = [bar(0, 1000), bar(1, 500, false), bar(2, 100)];
  const rects = paint(bars, { from: T0, to: T0 + 120 });
  const drawn = bodies(rects);
  assert.deepEqual(drawn.map((r) => r.w), [16, 8, 2], "widths follow volume: 16 = 0.8 × 20");
  assert.deepEqual(drawn.map((r) => r.fill), ["UP", "DOWN", "UP"], "colours from the direction");
  // Every wick is a 1px column at its bar's centre, and each body straddles it.
  const wicks = rects.filter((r) => r.fill === "WUP" || r.fill === "WDOWN");
  assert.equal(wicks.length, 3);
  wicks.forEach((wick, i) => {
    const centre = 100 + i * SPACING;
    assert.equal(wick.x, centre);
    assert.equal(wick.w, 1);
    const body = drawn[i]!;
    assert.ok(body.x <= centre && body.x + body.w > centre, `body ${i} is centred on its wick`);
    assert.ok(Math.abs((body.x + body.w / 2) - (centre + 0.5)) <= 0.5, `body ${i} is symmetric about the wick`);
  });
});

test("the scale is the heaviest bar IN VIEW, so panning to a quiet stretch keeps full bodies", () => {
  // A huge bar far off screen must not shrink everything that is on screen.
  const bars = [bar(0, 1_000_000), ...Array.from({ length: 10 }, (_, i) => bar(i + 1, i === 9 ? 400 : 200))];
  const rects = paint(bars, { from: T0 + 5 * 60, to: T0 + 10 * 60 });
  const drawn = bodies(rects);
  assert.ok(drawn.length >= 6 && drawn.length <= 8, `only the bars in view (plus a margin) are drawn: ${drawn.length}`);
  assert.equal(Math.max(...drawn.map((r) => r.w)), 16, "the heaviest bar in view fills its slot");
});

test("a Pine bar colour or the previous-close rule colours the body, and switches are honoured", () => {
  const bars = [bar(0, 1000), bar(1, 1000)];
  const own = paint(bars, { from: T0, to: T0 + 60 }, (t) => (t === T0 + 60 ? "PINE" : undefined));
  // The bar's own colour takes its wick too, as `mainSeriesDatum` does for a candle.
  assert.deepEqual(own.map((r) => `${r.w > 1 ? "body" : "wick"}:${r.fill}`),
    ["wick:WUP", "body:UP", "wick:PINE", "body:PINE"]);
  const noBody = paint(bars, { from: T0, to: T0 + 60 }, undefined, { body: false });
  assert.equal(noBody.every((r) => r.w === 1), true, "body off draws wicks only");
  const noWicks = paint(bars, { from: T0, to: T0 + 60 }, undefined, { wicks: false });
  assert.equal(noWicks.length, 2, "wicks off draws bodies only");
});

test("the series under the bodies is transparent, so nothing draws them twice", () => {
  const chart = readFileSync(new URL("../components/CandleChart.tsx", import.meta.url), "utf8");
  assert.match(chart, /const invisible = type === "pointAndFigure" \|\| type === "volumeCandles";/);
  assert.match(chart, /chartType === "pointAndFigure" \|\| chartType === "volumeCandles"\) return;/,
    "the settings effect would paint the bodies back in");
  assert.match(chart, /mainSeriesDatum\(kind, c, isVolumeCandle\(kind\) \? null : nextColors/);
  assert.match(chart, /mainSeriesDatum\(kind, liveOhlc, isVolumeCandle\(kind\) \? null : override\)/);
  assert.doesNotMatch(chart, /volumeCandleColor/, "volume is no longer a shade");
  assert.match(chart, /new VolumeCandlePrimitive\(\s*\n?\s*\(\) => candlesRef\.current/);
});
