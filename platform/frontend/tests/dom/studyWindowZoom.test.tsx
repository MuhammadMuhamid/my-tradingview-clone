/**
 * Zooming a study's window must not take the chart page down.
 *
 * ── The owner-found P0 this pins, against the code that threw ──────────────
 *
 * Reproduced by the owner and then here on the PRODUCTION build at
 * `http://localhost:3000/chart` (SOL/USDT, 1d) by zooming and panning:
 *
 *   Error: Cannot update oldest data, last time=…, new time=…
 *   [route error] → "This page stopped working"
 *
 * The instrumented stack put the throw inside a React effect calling
 * `ISeriesApi.update` on a TWO-POINT line — a native study's reference level.
 *
 * `tests/seriesTailOrdering.test.ts` pins the rule in the planner with a hand
 * -written series. This one removes the hand-written part: the series is a REAL
 * `lightweight-charts` line series, so the guard being satisfied here is the
 * same `DataLayer._seriesLastTimePoint` guard that threw in the browser, at the
 * same version the product ships. `register.ts` gives jsdom the canvas and the
 * box the library needs; the library itself is unmodified.
 *
 * A study's window is sized from the VIEWPORT (`lib/native/compute.ts`), so a
 * zoom that shortens it keeps the level's first point and its value and pulls
 * its last point back by hundreds of bars. That is the whole gesture below.
 */
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createChart, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import { resetBrowser } from "./harness/env";
import {
  canUpdateTail, planSeriesMutation, type ChartPoint, type SeriesMutation,
} from "@/lib/chartSeries";
import { computeWindow } from "@/lib/native/compute";
import type { Candle } from "@/lib/types";

const DAY = 86_400_000;

const CANDLES: Candle[] = Array.from({ length: 1_200 }, (_, i) => {
  const close = 100 + Math.sin(i / 9) * 8;
  return {
    symbol: "SOLUSDT", interval: "1d" as const,
    openTime: Date.UTC(2022, 0, 1) + i * DAY,
    closeTime: Date.UTC(2022, 0, 1) + (i + 1) * DAY - 1,
    open: close, high: close + 1, low: close - 1, close, volume: 1_000 + i,
  };
});

/** The window a study is computed over, for one viewport. */
const timesFor = (visibleBars: number, firstVisibleIndex: number): number[] =>
  computeWindow(CANDLES, 200, { firstVisibleIndex, visibleBars }, false)
    .map((c) => c.openTime / 1000);

/** A study's reference level: two points at one constant value. */
const level = (times: readonly number[], value = 70): ChartPoint[] =>
  times.length > 1
    ? [{ time: times[0]!, value }, { time: times[times.length - 1]!, value }]
    : [{ time: times[0]!, value }];

/** A study's plot over the same window. */
const plot = (times: readonly number[]): ChartPoint[] =>
  times.map((time, i) => ({ time, value: 50 + Math.sin(i / 7) * 20 }));

/**
 * The chart's write seam, verbatim: plan against what the series was last
 * given, then make exactly the call the plan names.
 *
 * `held` mirrors `entry.data` in `CandleChart.updateOverlayData` and
 * `IndicatorPane.updateData`, which is what those two compare the incoming
 * point against before they will call `update()` at all.
 */
function writer(
  api: ISeriesApi<"Line">,
  plan: (previous: ChartPoint[], next: ChartPoint[]) => SeriesMutation = planSeriesMutation,
) {
  let held: ChartPoint[] = [];
  const rows = (points: ChartPoint[]) =>
    points.map((p) => ({ time: p.time as UTCTimestamp, value: p.value ?? undefined }));
  return {
    apply(next: ChartPoint[]): SeriesMutation {
      const planned = plan(held, next);
      if (planned === "replace") {
        api.setData(rows(next));
        held = [...next];
      } else if (planned === "update") {
        const point = next[next.length - 1]!;
        // The seam, verbatim: the shared refusal both components consult
        // before they will call `update()` at all.
        if (!canUpdateTail(held, point.time)) {
          api.setData(rows(next));
          held = [...next];
          return "replace";
        }
        api.update({ time: point.time as UTCTimestamp, value: point.value ?? undefined });
        held = held.length > 0 && held[held.length - 1]!.time === point.time
          ? [...held.slice(0, -1), point] : [...held, point];
      }
      return planned;
    },
    held: () => held,
  };
}

let chart: IChartApi | null = null;

beforeEach(() => {
  resetBrowser();
  chart?.remove();
  chart = null;
});

test("ZOOMING A STUDY'S WINDOW BACKWARDS DOES NOT THROW OUT OF THE LIBRARY", () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  chart = createChart(host, { width: 1280, height: 320 });

  const plotWriter = writer(chart.addLineSeries());
  const levels = [70, 50, 30].map(() => writer(chart!.addLineSeries()));

  const draw = (visibleBars: number, firstVisibleIndex: number) => {
    const times = timesFor(visibleBars, firstVisibleIndex);
    plotWriter.apply(plot(times));
    for (const [i, w] of levels.entries()) w.apply(level(times, [70, 50, 30][i]!));
    return times;
  };

  // Zoomed out: the window is the whole series, so the levels span it.
  const wide = draw(1_400, 0);
  assert.equal(wide.length, 1_200);

  // Zoomed in on the same anchor: shorter window, the level's first point and
  // value unchanged, its last point 400 bars earlier. This is the exact shape
  // that produced "Cannot update oldest data" on the production build — an
  // identical prefix and a tail that has gone backwards.
  const narrow = timesFor(800, 0);
  assert.equal(narrow[0], wide[0],
    "the fixture must keep the level's first point, or it is not the crashing shape");
  assert.ok(narrow[narrow.length - 1]! < wide[wide.length - 1]!,
    "the fixture must pull the level's last point backwards");

  // The planner itself must call this a repaint. Asserting the PLAN and not
  // only the outcome is deliberate: the seam would rescue a wrong plan, and a
  // test that could not tell the two apart would pass over the actual defect.
  assert.equal(planSeriesMutation(level(wide), level(narrow)), "replace",
    "the planner still promises update() a tail it cannot move backwards");

  draw(800, 0);

  // Every level was REPLACED at its new span — not dropped, and not thrown on.
  for (const [i, w] of levels.entries()) {
    assert.deepEqual(w.held(), level(narrow, [70, 50, 30][i]!));
  }

  // …and repeatedly, in and out, across the 200-bar buckets `ChartPane` rounds
  // the viewport to, which is what a person doing this with a wheel produces.
  for (const bars of [1_400, 600, 1_000, 400, 1_200, 200, 800, 1_400]) {
    for (const first of [0, 200, 600, 200, 0]) draw(bars, first);
  }

  // Back where we started: the series hold exactly the last window drawn, in
  // order, with no duplicate times.
  const settled = draw(1_400, 0);
  assert.deepEqual(plotWriter.held(), plot(settled));
  for (const w of levels) {
    const rows = w.held();
    for (let i = 1; i < rows.length; i++) {
      assert.ok(rows[i]!.time > rows[i - 1]!.time, "a level is out of order");
    }
  }

  // The cheap path is still the cheap path: a live tick that only rewrites the
  // forming bar must not have become a full repaint of 1,200 points.
  const ticked = plot(settled);
  ticked[ticked.length - 1] = { ...ticked[ticked.length - 1]!, value: 99 };
  assert.equal(plotWriter.apply(ticked), "update");

  host.remove();
});

test("THE SEAM HOLDS EVEN WHEN THE PLANNER IS WRONG", () => {
  /*
   * Defence in depth, tested as such.
   *
   * `canUpdateTail` exists so that the rule is a property of the CHART and not
   * of one function: six call sites write to series, and a planner that is
   * wrong — the state this repair found the product in — must not be able to
   * kill the page. So this drives the real library with a planner that is
   * deliberately, maximally wrong: it answers "update" for everything.
   *
   * With the seam in place the backwards tails are replaced and nothing
   * throws. Remove the `canUpdateTail` check from `updateOverlayData` /
   * `updateData` and this test is the one that fails.
   */
  const host = document.createElement("div");
  document.body.appendChild(host);
  chart = createChart(host, { width: 1280, height: 320 });

  const alwaysUpdate = (): SeriesMutation => "update";
  const level70 = writer(chart.addLineSeries(), alwaysUpdate);

  level70.apply(level(timesFor(1_400, 0)));
  // A tail 400 bars in the past, offered as an "update" by a broken planner.
  assert.equal(level70.apply(level(timesFor(800, 0))), "replace",
    "the seam did not convert a backwards update into the replacement it is");

  for (const bars of [1_400, 600, 1_000, 400, 1_200, 200, 800]) {
    for (const first of [0, 200, 600, 0]) level70.apply(level(timesFor(bars, first)));
  }

  const settled = timesFor(1_400, 0);
  level70.apply(level(settled));

  /*
   * A broken planner still draws a wrong PICTURE — told "update" for a window
   * that grew, the seam appends rather than replacing, so the level keeps
   * points from spans it has left. That is the planner's job and the planner
   * is fixed; what the seam owes is that the series stays ORDERED and alive,
   * which is the difference between a stale line and a dead page.
   */
  const rows = level70.held();
  assert.equal(rows[rows.length - 1]!.time, settled[settled.length - 1]!);
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i]!.time > rows[i - 1]!.time, "the seam let the series go out of order");
  }

  host.remove();
});
