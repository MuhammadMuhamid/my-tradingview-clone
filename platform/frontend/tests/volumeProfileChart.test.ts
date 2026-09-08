/**
 * The two volume profiles, where each meets the chart.
 *
 * `tests/volumeProfile.test.ts` checks the arithmetic. This checks the wiring:
 * that a visible-range profile actually follows the viewport rather than the
 * window it was handed, that a fixed range covers the bars its edges enclose
 * and no others, and that both arrive at the renderer as the same kind of
 * thing — because the one way for two profiles to disagree is for them to be
 * two implementations.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { studyById } from "../lib/native/catalog";
import { defaultParams, normalizeParams } from "../lib/native/registry";
import { newNativeStudy, runNativeStudy, studySignature } from "../lib/native/compute";
import { PROFILE_COLORS } from "../lib/native/profile";
import {
  DEFAULT_VP_RANGE_STYLE, fixedRangeDecorations, fixedRangeOverlays, fixedRangeProfiles,
} from "../lib/volumeProfileDrawing";
import { PRICE_PANE_ID, type ChartProfileDecoration } from "../lib/chartSeries";
import type { Drawing } from "../lib/drawings";
import type { Candle } from "../lib/types";
import {
  MAX_PROFILE_REFINEMENT_BARS, profileRefinementPlan,
} from "../lib/useVolumeProfileRefinement";

const MINUTE = 60_000;
const T0 = 1_700_000_000_000;

/** A ramp: bar `i` trades around price `100 + i`, with volume `10 + i`. */
function bars(count: number): Candle[] {
  return Array.from({ length: count }, (_, i) => ({
    openTime: T0 + i * MINUTE,
    closeTime: T0 + (i + 1) * MINUTE - 1,
    open: 100 + i, high: 100.5 + i, low: 99.5 + i, close: 100 + i + 0.2,
    volume: 10 + i,
  })) as Candle[];
}

const vrvp = studyById("vrvp")!;

test("the visible-range profile exists and declares what makes it different", () => {
  assert.ok(vrvp, "vrvp is in the catalog");
  assert.equal(vrvp.overlay, true);
  assert.equal(vrvp.category, "volume");
  assert.equal(vrvp.usesVisibleRange, true);
  // Zero, because a lead-in would widen the very range it is defined by.
  assert.equal(vrvp.warmup(defaultParams(vrvp)), 0);
  assert.deepEqual(vrvp.plots.map((p) => p.id), ["poc", "vah", "val"]);
});

test("the visible-range profile profiles the visible bars, not the window", () => {
  const series = bars(200);
  const params = defaultParams(vrvp);
  const whole = vrvp.compute({ candles: series, params, interval: "1m" });
  const clipped = vrvp.compute({
    candles: series, params, interval: "1m",
    visibleRange: { fromMs: T0, toMs: T0 + 9 * MINUTE },
  });

  // The whole-window profile spans every bar's price; the clipped one spans
  // only the first ten, which on this ramp is a strictly lower band.
  const wholePoc = whole.plots.poc!.filter(Number.isFinite);
  const clippedPoc = clipped.plots.poc!.filter(Number.isFinite);
  assert.ok(wholePoc.length > clippedPoc.length);
  assert.equal(clippedPoc.length, 10);
  assert.ok(clippedPoc[0]! < wholePoc[0]!,
    "clipping to the first ten bars must move the point of control down the ramp");

  // Outside the range there is no level at all, rather than a flat line
  // claiming the value area describes bars the profile never saw.
  assert.ok(Number.isNaN(clipped.plots.poc![50]!));
  assert.ok(Number.isNaN(clipped.plots.vah![50]!));
  assert.ok(Number.isNaN(clipped.plots.val![50]!));
});

test("the profile's memo key follows the exact range, and only for a study that reads it", () => {
  const applied = newNativeStudy(vrvp, "k1");
  const one = studySignature(applied, vrvp, 2, undefined, { fromMs: 0, toMs: 1000 });
  const two = studySignature(applied, vrvp, 2, undefined, { fromMs: 0, toMs: 2000 });
  assert.notEqual(one, two, "panning must invalidate a visible-range profile");

  const rsi = studyById("rsi")!;
  const rsiApplied = newNativeStudy(rsi, "k2");
  assert.equal(
    studySignature(rsiApplied, rsi, 2, undefined, { fromMs: 0, toMs: 1000 }),
    studySignature(rsiApplied, rsi, 2, undefined, { fromMs: 0, toMs: 2000 }),
    "an ordinary study must not be recomputed on every scroll frame");
});

test("a profile reaches the renderer as a price-pane decoration covering its last bar", () => {
  const series = bars(20);
  const applied = newNativeStudy(vrvp, "vp-instance");
  const output = runNativeStudy(vrvp, applied, series, "1m", 2, {
    visibleRange: { fromMs: T0, toMs: T0 + 9 * MINUTE },
  });
  const profiles = output.decorations.filter(
    (d): d is ChartProfileDecoration => d.kind === "profile");
  assert.equal(profiles.length, 1);
  const drawn = profiles[0]!;
  assert.equal(drawn.paneId, PRICE_PANE_ID);
  assert.equal(drawn.id, "vp-instance:profile:vp");
  assert.equal(drawn.from, Math.floor(T0 / 1000));
  // The range ends at the CLOSE of the tenth bar, one interval past its open.
  assert.equal(drawn.to, Math.floor((T0 + 10 * MINUTE) / 1000));
  assert.equal(drawn.showRange, false);
  assert.ok(drawn.rows.length > 0);
  assert.ok(drawn.peakVolume > 0);
  assert.ok(drawn.pocIndex >= 0);
  assert.equal(drawn.basis, "chart");
  assert.equal(drawn.sourceInterval, "1m");
  assert.match(drawn.basisNotice, /does not say where inside a bar/);
  // The legend gets the levels as values, so the profile is readable as
  // numbers and not only as a shape.
  assert.ok(output.values.poc !== null);
  assert.ok(output.values.vah !== null);
  assert.ok(output.values.val !== null);
});

test("visible and fixed profiles use supplied finer bars and disclose that source", () => {
  const chartBars = bars(4).map((c, i) => ({
    ...c, openTime: T0 + i * 15 * MINUTE,
    closeTime: T0 + (i + 1) * 15 * MINUTE - 1,
  }));
  const finer = bars(60);
  const applied = newNativeStudy(vrvp, "vp-refined");
  const visible = runNativeStudy(vrvp, applied, chartBars, "15m", 2, {
    visibleRange: { fromMs: T0, toMs: T0 + 45 * MINUTE },
    profileCandles: finer,
    profileInterval: "1m",
  });
  const visibleDecoration = visible.decorations.find(
    (d): d is ChartProfileDecoration => d.kind === "profile")!;
  assert.equal(visibleDecoration.basis, "refined");
  assert.equal(visibleDecoration.sourceInterval, "1m");
  assert.match(visibleDecoration.basisNotice, /1m bars loaded for this range/);

  const fixed = fixedRangeDecorations(
    [range("refined", 0, 2)], chartBars, "15m", { candles: finer, interval: "1m" },
  )[0]!;
  assert.equal(fixed.basis, "refined");
  assert.equal(fixed.sourceInterval, "1m");
  assert.match(fixed.basisNotice, /1m bars loaded for this range/);
});

test("refinement chooses the finest divisor inside its hard request budget", () => {
  const short = profileRefinementPlan("SOLUSDT", "15m", T0, T0 + 59 * MINUTE);
  assert.equal(short?.sourceInterval, "1s");
  assert.equal(short?.expectedBars, 3_541);

  const long = profileRefinementPlan(
    "SOLUSDT", "1d", T0, T0 + 599 * 24 * 60 * MINUTE,
  );
  assert.equal(long?.sourceInterval, "4h");
  assert.ok((long?.expectedBars ?? Infinity) <= MAX_PROFILE_REFINEMENT_BARS);
  assert.equal(
    profileRefinementPlan("SOLUSDT", "1m", T0, T0 + 599 * MINUTE),
    null,
    "a 36k-second request falls back to chart bars rather than exceeding the cap",
  );
});

test("a hidden or unparameterised profile draws nothing rather than throwing", () => {
  const applied = newNativeStudy(vrvp, "k");
  applied.params = normalizeParams(vrvp, { rowSize: "lots" as never, valueArea: -9 });
  const output = runNativeStudy(vrvp, applied, bars(5), "1m", 2);
  assert.ok(output.decorations.every((d) => d.kind !== "profile" || d.rows.length > 0));
  assert.equal(runNativeStudy(vrvp, applied, [], "1m", 2).decorations.length, 0);
});

// ── the fixed range ────────────────────────────────────────────────────────

function range(id: string, fromIndex: number, toIndex: number, over: Partial<Drawing> = {}): Drawing {
  return {
    id,
    tool: "vprange",
    points: [
      { time: (T0 + fromIndex * MINUTE) / 1000, price: 100 },
      { time: (T0 + toIndex * MINUTE) / 1000, price: 120 },
    ],
    style: { color: "#4f8cff", width: 2 },
    ...over,
  };
}

test("a fixed range covers the bars its edges enclose, either way round", () => {
  const series = bars(50);
  const forward = fixedRangeProfiles([range("a", 10, 19)], series, "1m");
  assert.equal(forward.length, 1);
  assert.equal(forward[0]!.profile.bars, 10);
  assert.equal(forward[0]!.profile.from, T0 + 10 * MINUTE);
  assert.equal(forward[0]!.profile.to, T0 + 19 * MINUTE);

  // Dragged right-to-left is the same range, not an empty one.
  const backward = fixedRangeProfiles([range("b", 19, 10)], series, "1m");
  assert.equal(backward[0]!.profile.bars, 10);
  assert.deepEqual(
    backward[0]!.profile.rows.map((r) => r.total),
    forward[0]!.profile.rows.map((r) => r.total));
});

test("a fixed range past the end of the loaded bars profiles what there is", () => {
  const series = bars(20);
  const found = fixedRangeProfiles([range("a", 15, 400)], series, "1m");
  assert.equal(found[0]!.profile.bars, 5);
  assert.equal(found[0]!.profile.to, T0 + 19 * MINUTE);
});

test("a Replay horizon truncates a fixed range rather than reaching past it", () => {
  /*
   * The pane hands this function the replay-clipped bars, so a range whose
   * right edge is beyond the horizon simply has fewer bars in it. Nothing here
   * knows about Replay; that is the point.
   */
  const full = fixedRangeProfiles([range("a", 0, 49)], bars(50), "1m");
  const clipped = fixedRangeProfiles([range("a", 0, 49)], bars(20), "1m");
  assert.equal(full[0]!.profile.bars, 50);
  assert.equal(clipped[0]!.profile.bars, 20);
  assert.ok(clipped[0]!.profile.priceHigh < full[0]!.profile.priceHigh);
});

test("a hidden fixed range is stored but not drawn", () => {
  const series = bars(30);
  assert.equal(fixedRangeProfiles([range("a", 0, 10, { hidden: true })], series, "1m").length, 0);
  assert.equal(fixedRangeDecorations([range("a", 0, 10, { hidden: true })], series, "1m").length, 0);
  assert.equal(fixedRangeDecorations([range("a", 0, 10)], series, "1m").length, 1);
});

test("only vprange drawings profile anything", () => {
  const series = bars(30);
  const trend = range("t", 0, 10, { tool: "trend" });
  assert.equal(fixedRangeProfiles([trend], series, "1m").length, 0);
  assert.equal(fixedRangeOverlays([trend], series, "1m", 2).length, 0);
});

test("a fixed range outlines itself and takes its value-area colour from its style", () => {
  const decorations = fixedRangeDecorations(
    [range("a", 5, 15, { style: { color: "#f0b90b", width: 2 } })], bars(40), "1m");
  const drawn = decorations[0]!;
  assert.equal(drawn.showRange, true);
  assert.equal(drawn.colors.valueArea, "#f0b90b");
  assert.equal(drawn.colors.poc, PROFILE_COLORS.poc);
  assert.equal(drawn.id, "vprange:a");
  assert.equal(drawn.paneId, PRICE_PANE_ID);
  assert.equal(drawn.to, Math.floor((T0 + 16 * MINUTE) / 1000));
});

test("a fixed range's own settings survive on its style and change its profile", () => {
  const series = bars(60);
  const coarse = fixedRangeDecorations(
    [range("a", 0, 59, { style: { color: "#fff", width: 1, profile: { rowSize: 12 } } })],
    series, "1m");
  const fine = fixedRangeDecorations(
    [range("a", 0, 59, { style: { color: "#fff", width: 1, profile: { rowSize: 200 } } })],
    series, "1m");
  assert.equal(coarse[0]!.rows.length, 12);
  assert.equal(fine[0]!.rows.length, 200);

  const split = fixedRangeDecorations(
    [range("a", 0, 59, { style: { color: "#fff", width: 1, profile: { split: "upDown" } } })],
    series, "1m");
  assert.equal(split[0]!.split, "upDown");
  const left = fixedRangeDecorations(
    [range("a", 0, 59, { style: { color: "#fff", width: 1, profile: { side: "left" } } })],
    series, "1m");
  assert.equal(left[0]!.side, "left");
  // Defaults where the style says nothing.
  const plain = fixedRangeDecorations([range("a", 0, 59)], series, "1m")[0]!;
  assert.equal(plain.split, DEFAULT_VP_RANGE_STYLE.split);
  assert.equal(plain.side, DEFAULT_VP_RANGE_STYLE.side);
  assert.equal(plain.rows.length, DEFAULT_VP_RANGE_STYLE.rowSize);
  assert.ok(Math.abs(plain.widthRatio - DEFAULT_VP_RANGE_STYLE.widthPercent / 100) < 1e-9);
});

test("a fixed range's levels are drawn only over the bars it profiles", () => {
  const series = bars(40);
  const overlays = fixedRangeOverlays([range("a", 10, 19)], series, "1m", 2);
  assert.deepEqual(overlays.map((o) => o.title), ["POC", "VAH", "VAL"]);
  for (const overlay of overlays) {
    assert.equal(overlay.paneId, PRICE_PANE_ID);
    assert.equal(overlay.instanceTitle, "Fixed Range Volume Profile");
    assert.equal(overlay.instanceParams, "10 1m bars · chart-bar estimate");
    const inside = overlay.data.filter((p) => p.value !== null);
    assert.equal(inside.length, 10);
    assert.equal(overlay.data[0]!.value, null);
    assert.equal(overlay.data[39]!.value, null);
  }
  // Two ranges are two instances, never one merged set of lines.
  const two = fixedRangeOverlays([range("a", 0, 5), range("b", 20, 25)], series, "1m", 2);
  assert.equal(new Set(two.map((o) => o.instanceId)).size, 2);
  assert.equal(new Set(two.map((o) => o.id)).size, 6);
});

test("a range with no bars in it draws nothing at all", () => {
  const series = bars(10);
  const far = range("a", 500, 600);
  assert.equal(fixedRangeDecorations([far], series, "1m").length, 0);
  assert.equal(fixedRangeOverlays([far], series, "1m", 2).length, 0);
});
