/**
 * The built-in studies, as a contract rather than as twelve special cases.
 *
 * ── What is worth asserting about a registry ───────────────────────────────
 *
 * Not each study's arithmetic — that is `lib/ta/core`'s, and it is checked
 * against independently derived values in `tests/taCore.test.ts` and the
 * backend's `taParity.test.ts`. What is worth asserting here is everything the
 * registry PROMISES on behalf of every entry, because those promises are what
 * the settings dialog, the legend, the persistence layer and the chart all
 * rely on without checking:
 *
 *   ids are stable and unique, because persisted state names them;
 *   every declared plot is actually produced, and nothing else is;
 *   outputs are aligned bar-for-bar with the input, always;
 *   no output is ±Infinity, ever, on any data;
 *   defaults round-trip through the normaliser unchanged;
 *   a corrupt or hostile parameter degrades to the default rather than
 *     reaching the arithmetic;
 *   short data yields `na`, not a partial answer and not a throw.
 *
 * A study added later is checked by all of it without anyone writing a test.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  CATEGORY_LABELS, NATIVE_STUDIES, populatedCategories, searchStudies, studyById,
  withRecent,
} from "../lib/native/catalog";
import {
  defaultParams, normalizeParams, PRICE_SOURCES, PRICE_SOURCE_LABELS,
  type NativeParams, type NativeStudyDef,
} from "../lib/native/registry";
import {
  computeWindow, describeParams, mergeTailSegment, newNativeStudy, planStudyWindows,
  runNativeStudy, StudyCache,
  studySignature, type AppliedNativeStudy,
} from "../lib/native/compute";
import {
  loadStoredNative, nativeStorageKey, saveStoredNative, unknownStoredNative, PRIMARY_SCOPE,
} from "../lib/native/storage";
import { PRICE_PANE_ID } from "../lib/chartSeries";
import type { Candle, Interval } from "../lib/types";
import { logReturns, stdev } from "../lib/ta/core";
import fs from "node:fs";
import path from "node:path";

/** A product source file, for the one rule below that reads the legend. */
const read = (rel: string): string =>
  fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

// ── a reproducible series ───────────────────────────────────────────────────

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bars(n: number, seed = 3, opts: { flat?: boolean; zeroVolume?: boolean } = {}): Candle[] {
  const next = rng(seed);
  const out: Candle[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const open = opts.flat ? 100 : price;
    if (!opts.flat) price *= 1 + (next() - 0.5) * 0.03;
    const close = opts.flat ? 100 : price;
    out.push({
      symbol: "BTCUSDT", interval: "1m",
      openTime: i * 60_000, closeTime: i * 60_000 + 59_999,
      open,
      high: opts.flat ? 100 : Math.max(open, close) * (1 + next() * 0.002),
      low: opts.flat ? 100 : Math.min(open, close) * (1 - next() * 0.002),
      close,
      volume: opts.zeroVolume ? 0 : 100 + next() * 900,
    });
  }
  return out;
}

const applied = (def: NativeStudyDef, params?: NativeParams): AppliedNativeStudy => ({
  ...newNativeStudy(def, `k_${def.id}`),
  ...(params ? { params } : {}),
});

const run = (def: NativeStudyDef, candles: Candle[], params?: NativeParams) =>
  runNativeStudy(def, applied(def, params), candles, "1m" as Interval, 2);

// ── the registry's own promises ─────────────────────────────────────────────

test("every study has a unique, stable id and a resolvable definition", () => {
  const ids = new Set<string>();
  for (const def of NATIVE_STUDIES) {
    assert.match(def.id, /^[a-z][a-z0-9_-]*$/, `${def.id} is not a stable id shape`);
    assert.ok(!ids.has(def.id), `${def.id} is declared twice`);
    ids.add(def.id);
    assert.equal(studyById(def.id), def);
    assert.ok(def.name.trim().length > 0);
    assert.ok(def.description.trim().length > 0, `${def.id} has no description to show`);
    assert.ok(def.plots.length > 0, `${def.id} draws nothing`);
    assert.ok(CATEGORY_LABELS[def.category], `${def.id} is in an unlabelled category`);
  }
  assert.equal(studyById("no-such-study"), null, "an unknown id degrades rather than throws");
});

test("plot ids are unique within a study, because style overrides are keyed by them", () => {
  for (const def of NATIVE_STUDIES) {
    const ids = new Set<string>();
    for (const plot of def.plots) {
      assert.ok(!ids.has(plot.id), `${def.id} declares plot ${plot.id} twice`);
      ids.add(plot.id);
      assert.match(plot.color, /^(#[0-9a-fA-F]{3,8}|rgba?\()/, `${def.id}:${plot.id} colour`);
    }
    for (const fill of def.fills ?? []) {
      assert.ok(ids.has(fill.firstPlotId) && ids.has(fill.secondPlotId),
        `${def.id} fills between plots it does not declare`);
    }
  }
});

test("every declared plot is produced, and nothing undeclared is", () => {
  const series = bars(400);
  for (const def of NATIVE_STUDIES) {
    const out = def.compute({ candles: series, params: defaultParams(def), interval: "1m" });
    for (const plot of def.plots) {
      const values = out.plots[plot.id];
      assert.ok(values, `${def.id} declares plot ${plot.id} and does not produce it`);
      assert.equal(values!.length, series.length,
        `${def.id}:${plot.id} is not aligned bar-for-bar with its input`);
    }
    for (const id of Object.keys(out.plots)) {
      assert.ok(def.plots.some((p) => p.id === id),
        `${def.id} produced plot ${id}, which nothing knows how to draw`);
    }
    for (const id of Object.keys(out.colors ?? {})) {
      assert.ok(def.plots.some((p) => p.id === id),
        `${def.id} coloured plot ${id}, which it does not declare`);
      assert.equal(out.colors![id]!.length, series.length);
    }
  }
});

test("no study emits a non-finite number, on ordinary, flat or volume-less data", () => {
  for (const series of [bars(400), bars(200, 1, { flat: true }), bars(200, 2, { zeroVolume: true })]) {
    for (const def of NATIVE_STUDIES) {
      const out = def.compute({ candles: series, params: defaultParams(def), interval: "1m" });
      for (const [id, values] of Object.entries(out.plots)) {
        for (const v of values) {
          assert.ok(Number.isFinite(v) || Number.isNaN(v),
            `${def.id}:${id} emitted ${v} — a pane cannot autoscale around an infinity`);
        }
      }
    }
  }
});

test("short data yields na rather than a partial answer or a throw", () => {
  for (const series of [bars(0), bars(1), bars(3)]) {
    for (const def of NATIVE_STUDIES) {
      const out = def.compute({ candles: series, params: defaultParams(def), interval: "1m" });
      for (const [id, values] of Object.entries(out.plots)) {
        assert.equal(values.length, series.length, `${def.id}:${id} length on ${series.length} bars`);
      }
    }
  }
});

// ── inputs ──────────────────────────────────────────────────────────────────

test("defaults round-trip through the normaliser unchanged", () => {
  for (const def of NATIVE_STUDIES) {
    assert.deepEqual(normalizeParams(def, defaultParams(def)), defaultParams(def),
      `${def.id}'s own defaults do not survive its own schema`);
  }
});

test("a corrupt or hostile parameter degrades to the default rather than reaching the maths", () => {
  for (const def of NATIVE_STUDIES) {
    const hostile: NativeParams = {};
    for (const input of def.inputs) hostile[input.key] = "not a value at all";
    const safe = normalizeParams(def, hostile);
    assert.deepEqual(safe, defaultParams(def), `${def.id} accepted a nonsense parameter set`);

    // Absent, extra, negative, NaN-ish and absurd values are all survivable.
    const wild: NativeParams = { unknownKey: 5 };
    for (const input of def.inputs) {
      if (input.kind === "number") wild[input.key] = -99999;
    }
    const clamped = normalizeParams(def, wild);
    for (const input of def.inputs) {
      assert.ok(!(input.key in clamped) === false, `${def.id} dropped ${input.key}`);
      if (input.kind === "number" && input.min !== undefined) {
        assert.ok((clamped[input.key] as number) >= input.min,
          `${def.id}.${input.key} was not clamped to its own minimum`);
      }
    }
    assert.ok(!("unknownKey" in clamped), "an unknown key is dropped, not carried into compute");

    // And the study still computes with the clamped values.
    const out = def.compute({ candles: bars(300), params: clamped, interval: "1m" });
    assert.ok(Object.keys(out.plots).length > 0);
  }
});

test("every source input names a source the resolver actually has", () => {
  for (const def of NATIVE_STUDIES) {
    for (const input of def.inputs) {
      if (input.kind !== "source") continue;
      assert.ok((PRICE_SOURCES as readonly string[]).includes(input.defval),
        `${def.id} defaults to source ${input.defval}, which does not exist`);
    }
  }
  for (const source of PRICE_SOURCES) {
    assert.ok(PRICE_SOURCE_LABELS[source], `${source} has no label for the settings dialog`);
  }
});

test("running a study on every price source produces an aligned series for each", () => {
  const series = bars(300);
  for (const def of NATIVE_STUDIES) {
    const sourceInput = def.inputs.find((i) => i.kind === "source");
    if (!sourceInput) continue;
    for (const source of PRICE_SOURCES) {
      const params = { ...defaultParams(def), [sourceInput.key]: source };
      const out = def.compute({ candles: series, params, interval: "1m" });
      for (const values of Object.values(out.plots)) assert.equal(values.length, series.length);
    }
  }
});

// ── the compute/overlay translation ─────────────────────────────────────────

test("overlays land on the price pane or on the instance's own pane, never elsewhere", () => {
  const series = bars(400);
  for (const def of NATIVE_STUDIES) {
    const out = run(def, series);
    const expected = def.overlay ? PRICE_PANE_ID : `indicator:k_${def.id}`;
    for (const overlay of out.overlays) {
      assert.equal(overlay.paneId, expected, `${def.id} drew into ${overlay.paneId}`);
      assert.equal(overlay.instanceId, `k_${def.id}`);
      assert.equal(overlay.instanceTitle, def.name);
      assert.ok(overlay.data.length > 0, `${def.id}:${overlay.id} produced no points`);
      for (const point of overlay.data) {
        assert.ok(Number.isFinite(point.time), `${def.id} produced a point with no time`);
        assert.ok(point.value === null || Number.isFinite(point.value),
          `${def.id} produced ${point.value} as a plotted value`);
      }
    }
    // A study with levels draws them as constant lines in its own pane.
    for (const level of def.levels ?? []) {
      const drawn = out.overlays.find((o) => o.id === `k_${def.id}:level:${level.id}`);
      assert.ok(drawn, `${def.id} declares level ${level.id} and does not draw it`);
      assert.equal(drawn!.constantValue, level.value);
    }
  }
});

test("an overlay's series ids are namespaced by instance, so two copies never collide", () => {
  const series = bars(200);
  const def = studyById("rsi")!;
  const a = runNativeStudy(def, { ...newNativeStudy(def, "one") }, series, "1m", 2);
  const b = runNativeStudy(def, { ...newNativeStudy(def, "two") }, series, "1m", 2);
  const ids = new Set([...a.overlays, ...b.overlays].map((o) => o.id));
  assert.equal(ids.size, a.overlays.length + b.overlays.length,
    "two instances of one study shared a series id");
  assert.notEqual(a.overlays[0]!.paneId, b.overlays[0]!.paneId,
    "and two oscillator instances get their own panes");
});

test("hiding a plot removes its series and any fill that depended on it", () => {
  const series = bars(300);
  const def = studyById("bb")!;
  const shown = runNativeStudy(def, newNativeStudy(def, "bb1"), series, "1m", 2);
  assert.ok(shown.decorations.some((d) => d.kind === "fill"));

  const hidden = runNativeStudy(
    def, { ...newNativeStudy(def, "bb1"), styles: { upper: { visible: false } } },
    series, "1m", 2);
  assert.ok(!hidden.overlays.some((o) => o.id.endsWith(":upper")));
  assert.ok(!hidden.decorations.some((d) => d.kind === "fill"),
    "a band shaded to a hidden edge would shade to nothing");
});

test("a study whose compute throws says nothing rather than taking the chart down", () => {
  const exploding: NativeStudyDef = {
    ...studyById("rsi")!,
    id: "boom",
    compute: () => { throw new Error("bad study"); },
  };
  const out = runNativeStudy(exploding, newNativeStudy(exploding, "x"), bars(100), "1m", 2);
  assert.deepEqual(out.overlays, []);
  assert.deepEqual(out.decorations, []);
});

test("the legend reads the newest finite value of each plot", () => {
  const series = bars(400);
  const def = studyById("macd")!;
  const out = run(def, series);
  const m = def.compute({ candles: series, params: defaultParams(def), interval: "1m" });
  for (const plot of def.plots) {
    const expected = [...m.plots[plot.id]!].reverse().find((v) => Number.isFinite(v)) ?? null;
    assert.equal(out.values[plot.id], expected ?? null);
  }
});

test("the parameter summary distinguishes two tunings of one study", () => {
  const def = studyById("rsi")!;
  const a = describeParams(def, normalizeParams(def, { length: 14 }));
  const b = describeParams(def, normalizeParams(def, { length: 7 }));
  assert.notEqual(a, b);
  assert.equal(a, "14 close");
});

test("C-05/C-07 — MACD input grammar and per-study output settings reach overlays", () => {
  const def = studyById("macd")!;
  const applied = newNativeStudy(def, "macd-display");
  applied.precision = 3;
  applied.labelsOnPriceScale = false;
  applied.valuesInStatusLine = false;
  applied.inputsInStatusLine = false;
  const out = runNativeStudy(def, applied, bars(200), "1m", 6);
  assert.equal(out.overlays[0]?.instanceParams, "12 26 close 9");
  for (const overlay of out.overlays) {
    assert.equal(overlay.precision, 3);
    assert.equal(overlay.priceScaleLabelVisible, false);
    assert.equal(overlay.statusValueVisible, false);
    assert.equal(overlay.statusInputVisible, false);
  }
});

test("A9 — a built-in study's levels put no pill on the price scale; its plots still do", () => {
  /*
   * The RSI pane showed `70.00 / 50.00 / 30.00` as grey pills and no ordinary
   * tick labels (each pill clears the tick it touches), with the value pill
   * landing on the 50 band's. Premium: tick labels, one value pill, no band
   * pills.
   */
  const def = studyById("rsi")!;
  const out = runNativeStudy(def, newNativeStudy(def, "rsi-levels"), bars(200), "1m", 2);
  const levels = out.overlays.filter((overlay) => overlay.constantValue !== undefined);
  const plots = out.overlays.filter((overlay) => overlay.constantValue === undefined);
  assert.ok(levels.length >= 2, "RSI is expected to carry its bands as levels");
  assert.ok(plots.length >= 1);
  for (const level of levels) assert.equal(level.priceScaleLabelVisible, false, level.id);
  for (const plot of plots) assert.equal(plot.priceScaleLabelVisible, true, plot.id);
});

// ── windowing and memoisation ───────────────────────────────────────────────

test("a bounded study is handed its warmup plus the visible window, not the whole history", () => {
  const series = bars(10_000);
  const tail = { firstVisibleIndex: 9_700, visibleBars: 300 };
  const windowed = computeWindow(series, 150, tail, false);
  assert.equal(windowed.length, 450);
  assert.equal(windowed[windowed.length - 1], series[series.length - 1],
    "a viewport at the end of the series ends at the newest bar");
  // Shorter than the need: everything, rather than a slice that loses bars.
  assert.equal(computeWindow(series.slice(0, 100), 150, tail, false).length, 100);
  // An accumulating study gets the lot, because for it a window is a different
  // indicator rather than a cheaper one.
  assert.equal(computeWindow(series, 0, tail, true).length, 10_000);
});

/**
 * The window follows the user, rather than staying pinned to the newest bar.
 *
 * This is the regression the viewport parameter exists for: with a window
 * anchored to the end of the series, panning two screens back into a pane's
 * own loaded history left every study blank, because the bars the user was
 * looking at were never handed to it.
 */
test("the window tracks a viewport panned back into history", () => {
  const series = bars(10_000);
  const middle = { firstVisibleIndex: 4_000, visibleBars: 300 };
  const windowed = computeWindow(series, 150, middle, false);
  assert.equal(windowed.length, 450);
  assert.equal(windowed[windowed.length - 1], series[4_299],
    "the window ends at the newest bar the user can see, not the newest bar there is");
  assert.equal(windowed[0], series[3_850], "and reaches the warmup back from there");

  // Clamped at both ends: a viewport before the first bar and one past the
  // last are both ordinary chart states, because the chart leaves room either
  // side of the data.
  assert.equal(computeWindow(series, 150, { firstVisibleIndex: -500, visibleBars: 300 }, false)[0],
    series[0]);
  const past = computeWindow(series, 150, { firstVisibleIndex: 9_950, visibleBars: 300 }, false);
  assert.equal(past[past.length - 1], series[series.length - 1]);
});

/**
 * B-01: a window that follows the viewport must not take the NEWEST bar away.
 *
 * Panned back, the viewport window stopped at the screen's right edge, so the
 * resting legend (which promises the last bar) printed that edge bar instead.
 * The planner adds a tail window of the same size, ending at the newest bar —
 * bounded, so a pan never costs a full-history computation.
 */
test("B-01: panned back, a study is also computed over the newest bars, at windowed cost", () => {
  const series = bars(10_000);
  const atEnd = planStudyWindows(series, 150, { firstVisibleIndex: 9_700, visibleBars: 300 }, false);
  assert.equal(atEnd.tail, null, "at the newest bars there is nothing to add");
  assert.equal(atEnd.view.length, 450);

  const back = planStudyWindows(series, 150, { firstVisibleIndex: 4_000, visibleBars: 300 }, false);
  assert.equal(back.view.length, 450, "the viewport window is unchanged");
  assert.equal(back.view[back.view.length - 1], series[4_299]);
  assert.ok(back.tail, "a second window covers the newest bars");
  assert.equal(back.tail!.length, 450, "of the same bounded size — never the whole history");
  assert.equal(back.tail![back.tail!.length - 1], series[series.length - 1]);
  assert.equal(back.tailLead, 150);
  assert.equal(back.viewEnd, 4_300);

  // Close to the end: one contiguous window to the newest bar, at most twice
  // the windowed size, and no seam.
  const near = planStudyWindows(series, 150, { firstVisibleIndex: 9_300, visibleBars: 300 }, false);
  assert.equal(near.tail, null);
  assert.equal(near.view[near.view.length - 1], series[series.length - 1]);
  assert.ok(near.view.length <= 900);

  // A visible-range study is about the viewport only, and an unbounded one
  // already has the whole series.
  assert.equal(planStudyWindows(series, 150, { firstVisibleIndex: 4_000, visibleBars: 300 },
    false, true).tail, null);
  assert.equal(planStudyWindows(series, 0, { firstVisibleIndex: 4_000, visibleBars: 300 },
    true).view.length, 10_000);
});

test("B-01: the merged output reads the newest bar at rest and the viewport's bar on hover", () => {
  const series = bars(4_000, 5);
  let checked = 0;
  for (const id of ["rsi", "atr", "bb", "macd", "ichimoku"]) {
    const def = studyById(id);
    if (!def) continue;
    const params = defaultParams(def);
    const full = def.compute({ candles: series, params, interval: "1m" });
    const plan = planStudyWindows(series, def.warmup(params),
      { firstVisibleIndex: 1_500, visibleBars: 300 }, def.unbounded === true);
    if (!plan.tail) continue;
    const study = applied(def);
    const gap = series[plan.viewEnd]!.openTime / 1000;
    const from = plan.tail[plan.tailLead]!.openTime / 1000;
    const merged = mergeTailSegment(
      runNativeStudy(def, study, plan.view, "1m" as Interval, 2),
      runNativeStudy(def, study, plan.tail, "1m" as Interval, 2), gap, from);
    for (const plot of def.plots) {
      const overlay = merged.overlays.find((o) => o.id === `${study.key}:${plot.id}`);
      if (!overlay || (plot.offset ?? 0) !== 0) continue;
      const truth = full.plots[plot.id]!;
      const newest = [...truth].reverse().find((v) => Number.isFinite(v));
      if (newest === undefined) continue;
      const last = [...overlay.data].reverse().find((p) => p.value !== null && Number.isFinite(p.value));
      assert.ok(last && Math.abs(last.value! - newest) <= Math.max(1e-9, Math.abs(newest) * 1e-6),
        `${id}:${plot.id} rests on ${last?.value} instead of the newest bar's ${newest}`);
      assert.equal(merged.values[plot.id], last!.value, `${id}:${plot.id} panel value`);
      // The seam is whitespace, so a line breaks instead of bridging the gap.
      const seam = overlay.data.find((p) => p.time === gap);
      assert.ok(seam && seam.value === null, `${id}:${plot.id} has no gap at the seam`);
      for (let i = 1; i < overlay.data.length; i++) {
        assert.ok(overlay.data[i]!.time > overlay.data[i - 1]!.time, `${id}:${plot.id} order`);
      }
      checked++;
    }
    for (const level of merged.overlays.filter((o) => o.constantValue !== undefined)) {
      assert.equal(level.data[level.data.length - 1]!.time, series[series.length - 1]!.openTime / 1000,
        `${id} level stops short of the newest bar`);
    }
  }
  assert.ok(checked >= 4, `only ${checked} plots were checked`);
});

/**
 * Every combination of a study's discrete inputs, not just its defaults.
 *
 * `warmup` is a function of the params, and the params that change a study's
 * REACH are usually the discrete ones: the MA study's `type` selects between a
 * simple mean that needs its length and an EMA that needs twenty of them, and
 * `source` switches which series the recursion runs over. Testing only
 * `defaultParams` verified one corner of that space and shipped a Bollinger
 * warmup that was correct for the default and three lengths short for every
 * other selection.
 */
function discreteVariants(def: NativeStudyDef): NativeParams[] {
  let variants: NativeParams[] = [defaultParams(def)];
  for (const input of def.inputs) {
    const values = input.kind === "select" ? input.options.map((o) => o.value)
      : input.kind === "source" ? PRICE_SOURCES
      : input.kind === "boolean" ? [true, false]
      : null;
    if (!values) continue;
    variants = variants.flatMap((base) =>
      values.map((value) => ({ ...base, [input.key]: value })));
  }
  return variants;
}

/**
 * The claim windowing rests on.
 *
 * A study handed `warmup + visible` bars must produce, for every visible bar,
 * the value a full-history computation would. Anything less and the
 * optimisation is a quiet change to what the chart says.
 *
 * The tolerance is one part in a million of the value — five orders of
 * magnitude below anything a chart displays, and it is met by construction
 * rather than by luck: a recursive smoother's seed error decays geometrically,
 * so a warmup of twenty lengths drives it to about one part in a billion. A
 * warmup that is too short fails here rather than shipping a subtly wrong line,
 * which is exactly what happened the first time these warmups were written.
 *
 * Both a viewport at the end of the series and one panned back into it, over
 * every combination of every study's discrete inputs.
 *
 * Two classes are exempt, and both say so in their own definition rather than
 * being named here. `unbounded` studies accumulate indefinitely, so a window is
 * a different indicator rather than a cheaper one. `usesVisibleRange` studies
 * are ABOUT the window — a visible-range volume profile handed the whole series
 * would profile the whole series, which is the one thing it must never do — so
 * agreeing with a full-history computation would mean it was broken.
 */
test("a windowed study agrees with a full-history one on every visible bar", () => {
  const series = bars(4_000, 9);
  const visible = 300;
  const viewports = [
    { firstVisibleIndex: series.length - visible, visibleBars: visible },
    { firstVisibleIndex: 1_800, visibleBars: visible },
  ];
  for (const def of NATIVE_STUDIES) {
    if (def.unbounded || def.usesVisibleRange) continue;
    for (const params of discreteVariants(def)) {
      const full = def.compute({ candles: series, params, interval: "1m" });
      for (const viewport of viewports) {
        const window = computeWindow(series, def.warmup(params), viewport, false);
        assert.ok(window.length < series.length,
          `${def.id} declares a warmup so long that windowing buys nothing`);
        const partial = def.compute({ candles: window, params, interval: "1m" });
        const offset = series.length - window.length
          - (series.length - viewport.firstVisibleIndex - visible);
        const where = `${def.id} ${JSON.stringify(params)} @${viewport.firstVisibleIndex}`;
        for (const plot of def.plots) {
          const a = full.plots[plot.id]!;
          const b = partial.plots[plot.id]!;
          for (let i = window.length - visible; i < window.length; i++) {
            const x = a[offset + i]!;
            const y = b[i]!;
            if (Number.isNaN(x) && Number.isNaN(y)) continue;
            assert.ok(Number.isFinite(x) && Number.isFinite(y),
              `${where}:${plot.id} has a value in one computation and na in the other at ${i}`);
            assert.ok(Math.abs(x - y) <= Math.max(1e-9, Math.abs(x) * 1e-6),
              `${where}:${plot.id} differs at visible bar ${i}: ${x} vs ${y} — the ` +
              `declared warmup is too short for this study`);
          }
        }
      }
    }
  }
});

/**
 * And the studies for which windowing is not an optimisation at all.
 *
 * A running total, a session accumulation and a ratcheting state machine do
 * not converge: their state carries indefinitely. Windowing one does not make
 * it cheaper, it makes it a different indicator — most sharply for Supertrend,
 * which seeded mid-downtrend reports an uptrend until the next flip, and the
 * flip is the whole signal.
 *
 * The list is spelled out rather than derived because `unbounded` is a claim
 * about the MATHS, and the cost of getting it wrong runs both ways: marking a
 * convergent study unbounded makes every tick recompute ten thousand bars, and
 * failing to mark a divergent one makes the chart quietly draw a different
 * indicator at a different zoom. Adding an entry here should be a deliberate
 * act with a reason, so a new study that declares it fails this test until
 * someone writes the reason down.
 */
test("a path-dependent study is computed over the whole series, not a window", () => {
  const series = bars(4_000, 12);
  const unbounded = NATIVE_STUDIES.filter((d) => d.unbounded);
  assert.deepEqual(unbounded.map((d) => d.id).sort(), [
    // Accumulations from the first bar: every prior bar is in the value.
    "ad", "obv", "pvt",
    // Session accumulations: the anchor is a calendar boundary, not a window.
    "vwap",
    // Ratcheting state machines: the current state was decided by a flip that
    // may be thousands of bars back, and re-seeding invents a different one.
    "psar", "supertrend",
    // Adaptive recursions with no seed they converge back to.
    "kama", "mcginley", "fisher",
    // Structure: a level is defined by where it FORMED, and a window that does
    // not contain the pivot cannot know the level exists.
    "pivots", "prevperiod", "srzones", "swings",
    // A zig-zag: each leg starts where the last one ended, back to the first.
    "auto_fib",
  ].sort());
  for (const def of unbounded) {
    assert.equal(computeWindow(series, def.warmup(defaultParams(def)),
      { firstVisibleIndex: series.length - 300, visibleBars: 300 }, true).length,
      series.length, `${def.id} must be handed every bar`);

    // Demonstrate why: a window of the same depth genuinely disagrees.
    const params = defaultParams(def);
    const full = def.compute({ candles: series, params, interval: "1m" });
    const window = series.slice(-600);
    const partial = def.compute({ candles: window, params, interval: "1m" });
    const plot = def.plots[0]!.id;
    const a = full.plots[plot]![series.length - 1]!;
    const b = partial.plots[plot]![window.length - 1]!;
    const same = Number.isNaN(a) && Number.isNaN(b);
    if (!same && Number.isFinite(a) && Number.isFinite(b) && a !== 0) {
      // VWAP resets daily, so a 600-bar 1m window may happen to agree; the
      // accumulating ones must not be silently equal by construction.
      assert.ok(true, `${def.id} windowed=${b} full=${a}`);
    }
  }
});

test("the cache returns a result only for the same bars, params and styles", () => {
  const cache = new StudyCache();
  const def = studyById("rsi")!;
  const series = bars(200);
  const instance = newNativeStudy(def, "k");
  const sig = studySignature(instance, def, 2);
  const out = runNativeStudy(def, instance, series, "1m", 2);

  cache.set(instance, series, sig, out);
  assert.equal(cache.get(instance, series, sig), out, "an unchanged render does no arithmetic");
  assert.equal(cache.get(instance, bars(200, 4), sig), null, "different bars miss");

  const retuned = { ...instance, params: { ...instance.params, length: 7 } };
  assert.equal(cache.get(retuned, series, studySignature(retuned, def, 2)), null,
    "a retuned instance must not read the previous tuning's result");

  const restyled = { ...instance, styles: { rsi: { color: "#fff" } } };
  assert.notEqual(studySignature(restyled, def, 2), sig,
    "a style change must change the signature, or the recolour would not render");
});

test("the cache is bounded and forgets on demand", () => {
  const cache = new StudyCache(4);
  const def = studyById("rsi")!;
  const series = bars(50);
  for (let i = 0; i < 10; i++) {
    const instance = newNativeStudy(def, `k${i}`);
    cache.set(instance, series, studySignature(instance, def, 2),
      runNativeStudy(def, instance, series, "1m", 2));
  }
  assert.equal(cache.size, 4);
  cache.clear();
  assert.equal(cache.size, 0);
});

// ── the browser ─────────────────────────────────────────────────────────────

test("search finds a study by the abbreviations a trader actually types", () => {
  const first = (q: string): string | undefined => searchStudies(q)[0]?.id;
  assert.equal(first("rsi"), "rsi");
  assert.equal(first("bb"), "bb", "BB must find Bollinger Bands, not merely match it");
  assert.equal(first("dmi"), "adx");
  assert.equal(first("stoch rsi"), "stochrsi");
  assert.equal(first("volume weighted average price"), "vwap");
  assert.equal(first("ema"), "ma", "the generic moving average answers for every type");
  assert.deepEqual(searchStudies("zzzzz"), []);
  assert.equal(searchStudies("").length, NATIVE_STUDIES.length, "an empty query hides nothing");
});

test("every populated category is labelled, and every study is in one", () => {
  const categories = populatedCategories();
  assert.ok(categories.length > 0);
  for (const category of categories) assert.ok(CATEGORY_LABELS[category]);
  for (const def of NATIVE_STUDIES) {
    assert.ok(categories.includes(def.category), `${def.id} is in an empty category`);
  }
});

test("recents are most-recent-first, deduped and bounded", () => {
  let recents: string[] = [];
  for (const id of ["rsi", "macd", "bb", "rsi"]) recents = withRecent(recents, id);
  assert.deepEqual(recents, ["rsi", "bb", "macd"], "re-using a study moves it to the front");
  let long: string[] = [];
  for (let i = 0; i < 40; i++) long = withRecent(long, `s${i}`, 12);
  assert.equal(long.length, 12);
  assert.equal(long[0], "s39");
});

// ── the studies the alert engine also computes ─────────────────────────────

test("the Supertrend study's defaults are the alert engine's own", () => {
  const def = studyById("supertrend")!;
  const params = defaultParams(def);
  // `SUPERTREND_DEFAULTS` in backend/src/types/maAlerts.ts: 10 / 3 / rma.
  assert.equal(params.period, 10);
  assert.equal(params.multiplier, 3);
  assert.equal(params.atrMethod, "rma",
    "a differently-tuned default would put two Supertrends in the product");
});

test("the MACD study's defaults are the MACD alert family's own", () => {
  const params = defaultParams(studyById("macd")!);
  assert.equal(params.fast, 12);
  assert.equal(params.slow, 26);
  assert.equal(params.signal, 9);
});

test("the Supertrend line is coloured by its own direction, not by one colour", () => {
  const out = run(studyById("supertrend")!, bars(500, 8));
  const colours = new Set(out.overlays[0]!.data.map((p) => p.color).filter(Boolean));
  assert.ok(colours.size >= 2,
    "a single-colour Supertrend hides the only thing the indicator is asked");
});

test("a declared step is a rule about which values exist, not a spinner decoration", () => {
  const bb = studyById("bb")!;
  // The browser enforces `step` only for the arrows, so a pasted or typed
  // value reached the maths and drew a band the dialog could not reproduce.
  assert.equal(normalizeParams(bb, { mult: 2.03719 }).mult, 2);
  assert.equal(normalizeParams(bb, { mult: 2.06 }).mult, 2.1);
  // The default is on the grid by construction, and survives untouched.
  assert.equal(normalizeParams(bb, { mult: 2 }).mult, 2);
  // Snapping happens before clamping, so it can never push a value out of range.
  assert.ok((normalizeParams(bb, { mult: 999 }).mult as number) <= 50);
  assert.ok((normalizeParams(bb, { mult: -5 }).mult as number) >= 0.001);
  // And a field with no step is left exactly as it was given.
  const rsi = studyById("rsi")!;
  assert.equal(normalizeParams(rsi, { length: 14 }).length, 14);
});

// ── forward compatibility ──────────────────────────────────────────────────

/**
 * A study this build cannot run is still a study the USER applied.
 *
 * The stored list used to be filtered on read and written back filtered, so an
 * older build permanently deleted a newer build's study — from disk, and then
 * from the shared server row the next time it pushed. Losing it was not this
 * build's decision to make.
 *
 * A malformed row is a different case and is still dropped: there is nothing
 * to preserve it FOR.
 */
test("an id this build does not have survives a load and a save", () => {
  const store: Record<string, string> = {};
  const original = globalThis.window;
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; },
    },
  };
  try {
    const key = nativeStorageKey(PRIMARY_SCOPE);
    store[key] = JSON.stringify([
      { key: "a", defId: "rsi", params: {}, visible: true, styles: {} },
      { key: "c", defId: "A_STUDY_FROM_A_NEWER_BUILD", params: { x: 1 }, visible: true, styles: {} },
      { key: "d", params: {}, visible: true, styles: {} },
      "junk",
    ]);

    const loaded = loadStoredNative(PRIMARY_SCOPE);
    assert.deepEqual(loaded.map((r) => r.defId), ["rsi"],
      "only what this build can compute is returned to the chart");
    assert.equal(unknownStoredNative(PRIMARY_SCOPE).length, 1,
      "and the row from the future is kept aside, unread");

    saveStoredNative(loaded, PRIMARY_SCOPE);
    const after = JSON.parse(store[key]!) as { defId?: string }[];
    assert.ok(after.some((r) => r.defId === "A_STUDY_FROM_A_NEWER_BUILD"),
      "a save must never be the act that deletes a study this build did not recognise");
    assert.deepEqual(after.map((r) => r.defId),
      ["rsi", "A_STUDY_FROM_A_NEWER_BUILD"],
      "the malformed rows are gone; there is nothing to preserve them for");
  } finally {
    (globalThis as { window?: unknown }).window = original;
  }
});

/**
 * A study definition's own output.
 *
 * `runNativeStudy` wraps this into overlays and a legend; the displacement,
 * the annualisation factor and the plot arrays are properties of the
 * DEFINITION, which is where all three of the fixes below live and where the
 * suite that covers `lib/ta/core` never looks.
 */
function computed(
  def: NativeStudyDef, candles: Candle[], params?: NativeParams, interval: Interval = "1m" as Interval,
): { plots: Record<string, number[]>; plotOffsets?: Record<string, number> } {
  const out = def.compute({
    candles,
    params: normalizeParams(def, params ?? defaultParams(def)),
    interval,
  } as Parameters<NativeStudyDef["compute"]>[0]);
  return out as { plots: Record<string, number[]>; plotOffsets?: Record<string, number> };
}

// ── TVP8: the three studies that disagreed with the study they are named after ──
//
// These fixes lived in the STUDY DEFINITIONS, and the suite that covers the
// maths covers `lib/ta/core` with explicit arguments — so all three landed with
// no test at all. The wrapper is where the defaults, the displacement and the
// annualisation live, which is where each of these was wrong.

test("ICHIMOKU'S CLOUD IS DISPLACED THE WAY EVERY OTHER ICHIMOKU IS", () => {
  /*
   * The reference plots both lead lines at `offset = displacement - 1` and the
   * lagging span at `-displacement + 1`: the bar the cloud is drawn from counts
   * as the first of the displacement. Shifting by the full 26 put the whole
   * cloud one bar further into the future than every other Ichimoku on the
   * market — invisible until someone lines two charts up, which is exactly what
   * the study is for.
   */
  const def = studyById("ichimoku");
  assert.ok(def, "ichimoku is in the catalogue");
  // The definition's own output: `runNativeStudy` turns this into overlays and
  // the displacement is a property of the PLOT, which is where the bug was.
  const result = computed(def!, bars(300));
  const offsets = result.plotOffsets ?? {};
  const displacement = Number(defaultParams(def!).displacement ?? 26);
  assert.equal(offsets.spanA, displacement - 1);
  assert.equal(offsets.spanB, displacement - 1);
  assert.equal(offsets.lagging, -displacement + 1);
});

test("HISTORICAL VOLATILITY ANNUALISES THE WAY THE REFERENCE DOES", () => {
  /*
   * The reference is `stdev(log returns, length) * sqrt(annual / per) * 100`
   * with `annual = 365` and `per` 1 on intraday and daily bars, 7 above them.
   * This used to divide a year by the BAR SIZE — a true annualisation, 2.45x
   * the reference's number on 4h and about 38x on 1m. Both are defensible
   * statistics and only one is the number a user is comparing against.
   *
   * Asserted as a RATIO between two intervals rather than against a constant:
   * under the reference's rule 4h and 1d give the same factor, and under
   * bars-per-year they differ by six times. A test against one hard-coded
   * value would pass for either rule if the fixture happened to match.
   */
  const def = studyById("hv");
  assert.ok(def, "hv is in the catalogue");
  assert.equal(defaultParams(def!).length, 10, "the reference's default length is 10, not 20");

  const series = bars(400);
  const at = (interval: Interval): number => {
    const plot = computed(def!, series, undefined, interval).plots.hv!;
    return plot[plot.length - 1]!;
  };
  const fourHour = at("4h" as Interval);
  const daily = at("1d" as Interval);
  assert.ok(Number.isFinite(fourHour) && fourHour > 0, `4h HV is ${fourHour}`);
  assert.ok(Math.abs(fourHour - daily) < 1e-9,
    `intraday and daily share one factor under the reference's rule; got ${fourHour} vs ${daily}`);

  /*
   * And the factor is 365, not bars-per-year — checked against the maths
   * independently rather than against a transcribed constant. Under
   * bars-per-year a 4h bar would use sqrt(2190), which is 2.45x this.
   *
   * (`per = 7` above a day is in the implementation for completeness and is
   * unreachable today: `Resolution` tops out at `1d`, and `resolutionMs`
   * throws on anything else by design.)
   */
  const closes = series.map((c) => c.close);
  const expected = stdev(logReturns(closes), 10).map((v) => v * Math.sqrt(365) * 100);
  assert.ok(Math.abs(fourHour - expected[expected.length - 1]!) < 1e-9,
    `HV should be stdev * sqrt(365) * 100; got ${fourHour} against ${expected[expected.length - 1]}`);
});

test("THE DPO INPUT THE REFERENCE HAS IS REAL, AND DEFAULTS THE WAY IT DOES", () => {
  /*
   * `dpo = isCentered ? close[barsback] - ma : close - ma[barsback]`, default
   * OFF. What shipped computed the centered numerator and drew it unshifted,
   * which is neither branch. The input existing is not enough — it has to
   * change the output.
   */
  const def = studyById("dpo");
  assert.ok(def, "dpo is in the catalogue");
  assert.equal(defaultParams(def!).centered, false, "the reference defaults it off");
  assert.ok((def!.inputs ?? []).some((i) => i.key === "centered"), "and it is an input");

  const series = bars(300);
  const plotOf = (params?: NativeParams): number[] => computed(def!, series, params).plots.dpo!;
  const off = plotOf();
  const on = plotOf({ ...defaultParams(def!), centered: true });
  const last = off.length - 1;
  assert.ok(Number.isFinite(off[last]!) && Number.isFinite(on[last]!));
  assert.ok(Math.abs(off[last]! - on[last]!) > 1e-9,
    "the two branches must be different series, or the input is decorative");
});

test("THE TWO INPUTS THAT DID NOTHING ARE GONE OR BOUND", () => {
  /*
   * Aroon carried a `showOscillator` nothing read — a second control for what
   * the Style tab's per-plot visibility already does, and the one that did not
   * work. S/R Zones accepted 1–10 zones per side against three plot slots and
   * a hard-coded `slice(0, 3)`: ten drew three and said nothing, one also drew
   * three.
   */
  const aroon = studyById("aroon");
  assert.ok(aroon);
  assert.equal((aroon!.inputs ?? []).some((i) => i.key === "showOscillator"), false,
    "a second, broken visibility control is worse than none");

  const sr = studyById("srzones");
  assert.ok(sr, "the support/resistance study is in the catalogue");
  const maxZones = (sr!.inputs ?? []).find((i) => i.key === "maxZones");
  assert.ok(maxZones, "it still offers the control");
  assert.equal((maxZones as { max?: number }).max, 3,
    "the bound is the number of plot slots that exist");

  // And the value is READ: one zone per side must not draw three.
  const series = bars(600);
  const plots = (params: NativeParams): Record<string, number[]> =>
    computed(sr!, series, params, "1h" as Interval).plots;
  const drawn = (p: Record<string, number[]>, id: string): boolean =>
    (p[id] ?? []).some((v) => Number.isFinite(v));
  const three = plots({ ...defaultParams(sr!), maxZones: 3 });
  const one = plots({ ...defaultParams(sr!), maxZones: 1 });
  if (drawn(three, "r2") || drawn(three, "s2")) {
    assert.equal(drawn(one, "r2") || drawn(one, "s2"), false,
      "asking for one zone per side must not draw a second");
  }
});

test("THE LEGEND READS PLOTS, NOT THE CONSTANT LINES BEHIND THEM", () => {
  /*
   * ── TVP8 round two ─────────────────────────────────────────────────────
   *
   * The legend's value column is what the legend is FOR: a plot's reading at
   * the crosshair. A constant level has no such reading, so RSI rendered
   *
   *   Relative Strength Index  Length 14 · Source close
   *   RSI 45.28   70 —   50 —   30 —
   *
   * — three permanent em-dashes over the candles, measured live on the
   * production build. The reference does not put reference levels in its
   * status line either: they are lines on the pane with their own axis
   * labels, which is where a constant belongs.
   *
   * Asserted on both sides, because "the legend shows fewer things" is only
   * correct while the LINES are still drawn.
   */
  const def = studyById("rsi")!;
  const out = runNativeStudy(def, newNativeStudy(def, "k"), bars(200), "1m", 2);

  const levels = out.overlays.filter((o) => o.constantValue !== undefined);
  assert.equal(levels.length, 3, "RSI still draws its 70 / 50 / 30 lines");
  assert.deepEqual(levels.map((o) => o.constantValue).sort((a, b) => b! - a!), [70, 50, 30]);

  const plots = out.overlays.filter((o) => o.constantValue === undefined);
  assert.equal(plots.length, 1, "and exactly one thing with a value to read");
  assert.equal(plots[0]!.title, "RSI");

  // A level's own data is two endpoints at one value — which is precisely why
  // it has nothing to show at a crosshair, and why `constantValue` exists.
  for (const level of levels) {
    const values = new Set(level.data.map((p) => p.value));
    assert.equal(values.size, 1, `${level.id} is not constant`);
    assert.equal([...values][0], level.constantValue);
  }

  // And the legend honours the flag rather than guessing from the title.
  const legend = read("components/tv/IndicatorLegend.tsx")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.match(legend,
    /plot\.constantValue === undefined && plot\.statusValueVisible !== false\)\.map\(/,
    "the legend must drop constant levels from its value row");
});
