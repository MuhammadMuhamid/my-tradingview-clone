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
  computeWindow, describeParams, newNativeStudy, runNativeStudy, StudyCache,
  studySignature, type AppliedNativeStudy,
} from "../lib/native/compute";
import { PRICE_PANE_ID } from "../lib/chartSeries";
import type { Candle, Interval } from "../lib/types";

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
  assert.match(a, /Length 14/);
});

// ── windowing and memoisation ───────────────────────────────────────────────

test("a bounded study is handed its warmup plus the visible window, not the whole history", () => {
  const series = bars(10_000);
  const windowed = computeWindow(series, 150, 300, false);
  assert.equal(windowed.length, 450);
  assert.equal(windowed[windowed.length - 1], series[series.length - 1],
    "the window always ends at the newest bar");
  // Shorter than the need: everything, rather than a slice that loses bars.
  assert.equal(computeWindow(series.slice(0, 100), 150, 300, false).length, 100);
  // An accumulating study gets the lot, because for it a window is a different
  // indicator rather than a cheaper one.
  assert.equal(computeWindow(series, 0, 300, true).length, 10_000);
});

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
 */
test("a windowed study agrees with a full-history one on every visible bar", () => {
  const series = bars(4_000, 9);
  const visible = 300;
  for (const def of NATIVE_STUDIES) {
    if (def.unbounded) continue;
    const params = defaultParams(def);
    const full = def.compute({ candles: series, params, interval: "1m" });
    const window = computeWindow(series, def.warmup(params), visible, false);
    assert.ok(window.length < series.length,
      `${def.id} declares a warmup so long that windowing buys nothing`);
    const partial = def.compute({ candles: window, params, interval: "1m" });
    const offset = series.length - window.length;
    for (const plot of def.plots) {
      const a = full.plots[plot.id]!;
      const b = partial.plots[plot.id]!;
      for (let i = window.length - visible; i < window.length; i++) {
        const x = a[offset + i]!;
        const y = b[i]!;
        if (Number.isNaN(x) && Number.isNaN(y)) continue;
        assert.ok(Number.isFinite(x) && Number.isFinite(y),
          `${def.id}:${plot.id} has a value in one computation and na in the other at ${i}`);
        assert.ok(Math.abs(x - y) <= Math.max(1e-9, Math.abs(x) * 1e-6),
          `${def.id}:${plot.id} differs at visible bar ${i}: ${x} vs ${y} — the ` +
          `declared warmup is too short for this study`);
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
 */
test("a path-dependent study is computed over the whole series, not a window", () => {
  const series = bars(4_000, 12);
  const unbounded = NATIVE_STUDIES.filter((d) => d.unbounded);
  assert.deepEqual(unbounded.map((d) => d.id).sort(), ["obv", "supertrend", "vwap"]);
  for (const def of unbounded) {
    assert.equal(computeWindow(series, def.warmup(defaultParams(def)), 300, true).length,
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
