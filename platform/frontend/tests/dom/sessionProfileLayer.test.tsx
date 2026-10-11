/*
 * A session profile is drawn inside its own session, and says where its value
 * area stops.
 *
 * Phase D-F8 found the Session volume profile and TPO chart types covering the
 * latest UTC day only, with the value area visible only as a change of shade.
 * `tests/volumeProfileChart.test.ts` holds the decoration builder to one
 * profile per session. This holds the LAYER to drawing each of them where it
 * belongs: rows confined to their session's span rather than reaching 30% of
 * the whole plot across the neighbouring days, nothing at all for a session
 * scrolled off screen, and the VAH and VAL as labelled lines.
 *
 * The harness's 2D context measures nothing, so this one records: it is the
 * smallest stand-in that can tell "where did the rows go" without a pixel.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { IChartApi, ISeriesApi } from "lightweight-charts";
import { closeBrowser, render, resetBrowser, settle } from "./harness/env";
import { VolumeProfileLayer } from "@/components/tv/VolumeProfileLayer";
import type { ChartProfileDecoration } from "@/lib/chartSeries";

type Call = { op: string; args: unknown[] };

let calls: Call[] = [];
let originalGetContext: unknown;

beforeEach(() => {
  resetBrowser();
  calls = [];
  const proto = window.HTMLCanvasElement.prototype as unknown as { getContext: unknown };
  originalGetContext = proto.getContext;
  proto.getContext = function getContext(this: HTMLCanvasElement, id: string): unknown {
    if (id !== "2d" || this.dataset.testid !== "volume-profile-layer") {
      return (originalGetContext as (id: string) => unknown).call(this, id);
    }
    const state: Record<string, unknown> = {};
    return new Proxy(state, {
      get(target, prop) {
        if (typeof prop !== "string") return undefined;
        if (prop in target) return target[prop];
        return (...args: unknown[]) => { calls.push({ op: prop, args }); };
      },
      set(target, prop, value) { target[prop as string] = value; return true; },
    });
  };
});
after(() => {
  (window.HTMLCanvasElement.prototype as unknown as { getContext: unknown }).getContext = originalGetContext;
  closeBrowser();
});

const HOUR_S = 3600;
const BASE = 1_700_006_400; // a UTC midnight, in chart seconds
const PX_PER_BAR = 10;
const BAR_TIMES = new Set(Array.from({ length: 72 }, (_, i) => BASE + i * HOUR_S));

/** 72 hourly bars, 10px apart from x=0; a time that is not a bar has no x. */
function stubChart(offsetPx = 0): IChartApi {
  return {
    priceScale: () => ({ width: () => 60 }),
    timeScale: () => ({
      height: () => 30,
      getVisibleRange: () => ({ from: BASE, to: BASE + 71 * HOUR_S }),
      timeToCoordinate: (t: number) => BAR_TIMES.has(t)
        ? ((t - BASE) / HOUR_S) * PX_PER_BAR - offsetPx : null,
      subscribeVisibleLogicalRangeChange: () => {},
      unsubscribeVisibleLogicalRangeChange: () => {},
    }),
  } as unknown as IChartApi;
}

/** Price 100 at y=400, 10px per unit, up is up. */
const series = { priceToCoordinate: (p: number) => 400 - (p - 100) * 10 } as unknown as ISeriesApi<"Candlestick">;

/** A session from bar 24 to bar 48 (x 240..480), rows 98..102. */
function session(over: Partial<ChartProfileDecoration> = {}): ChartProfileDecoration {
  return {
    kind: "profile", id: "s1", paneId: "price", title: "Session Volume Profile",
    basis: "chart", sourceInterval: "1h", basisNotice: "UTC-day session estimates from 1h bars",
    from: BASE + 24 * HOUR_S, to: BASE + 48 * HOUR_S, side: "right", widthRatio: 0.3,
    rows: [98, 99, 100, 101].map((low, i) => ({ low, high: low + 1, total: [2, 6, 9, 3][i]!, up: 1, down: 1 })),
    pocIndex: 2, valueAreaRows: [1, 2], peakVolume: 9,
    split: "total", showValueArea: true, showPoc: true, showRange: false,
    fitToRange: true, showValueAreaEdges: true,
    colors: { total: "#888", up: "#0a0", down: "#a00", valueArea: "#46f", poc: "#fa0" },
    ...over,
  };
}

async function draw(profiles: ChartProfileDecoration[], offsetPx = 0): Promise<void> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  render(<VolumeProfileLayer container={container} chart={stubChart(offsetPx)} series={series} profiles={profiles} />);
  await settle();
}

const rects = () => calls.filter((c) => c.op === "fillRect").map((c) => c.args as number[]);
const texts = () => calls.filter((c) => c.op === "fillText").map((c) => c.args as [string, number, number]);

test("a session profile's rows stay inside its own session's span", async () => {
  await draw([session()]);
  const rows = rects();
  assert.ok(rows.length >= 4, `rows were painted (${rows.length})`);
  for (const [x, , w] of rows) {
    // Anchored at the session's right edge (480) and at most 30% of its own
    // 240px span wide — not 30% of the 1220px plot, which reached x=114.
    assert.ok(x! >= 480 - 72 - 0.01 && x! + w! <= 480 + 0.01, `row ${x}+${w} is inside 408..480`);
  }
  const clip = calls.find((c) => c.op === "rect" && (c.args[0] as number) === 240);
  assert.ok(clip, "the profile is clipped to its session");
});

test("a plot-sized profile keeps sizing against the plot", async () => {
  await draw([session({ fitToRange: false, showValueAreaEdges: false })]);
  const widest = Math.max(...rects().map(([, , w]) => w!));
  assert.ok(Math.abs(widest - 1220 * 0.3) < 0.01, `the widest row is 30% of the plot (${widest})`);
});

test("a session scrolled entirely off screen paints nothing", async () => {
  await draw([session()], 600);
  assert.equal(rects().length, 0);
  assert.equal(texts().length, 0);
});

test("the value area's high and low are labelled lines, above and below it", async () => {
  await draw([session()]);
  const vah = texts().find(([t]) => t === "VAH");
  const val = texts().find(([t]) => t === "VAL");
  assert.ok(vah && val, "both edges are labelled");
  // VAH is the top of row 2 (101 → y=390), VAL the bottom of row 1 (99 → y=410).
  assert.ok(vah![2] < 390.5 && val![2] > 410.5, `VAH ${vah![2]} above, VAL ${val![2]} below`);
  const lines = calls.filter((c) => c.op === "moveTo").map((c) => c.args[1] as number);
  assert.ok(lines.includes(390.5) && lines.includes(410.5), `edge lines at 390.5 and 410.5: ${lines}`);
});

test("a profile without the edges flag draws no VAH/VAL, and the POC is untouched", async () => {
  await draw([session({ showValueAreaEdges: false })]);
  assert.equal(texts().filter(([t]) => t === "VAH" || t === "VAL").length, 0);
  // A set: the layer paints once on mount and again on the next frame.
  const lines = new Set(calls.filter((c) => c.op === "moveTo").map((c) => c.args[1] as number));
  assert.deepEqual([...lines], [395.5], "only the POC line, at the middle of row 2 (100.5)");
});
