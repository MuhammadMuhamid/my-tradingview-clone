/**
 * ── W2D-01: a cold symbol switch after interval abuse ──────────────────────
 *
 * Reproduced on a production build: 1m → 1h → D → 5m → 15m a second or two
 * apart, then a watchlist click on an instrument the chart had not loaded.
 * The whole workspace collapsed to one canvas, the study panes then drew from
 * a window that was not the chart's (an ATR that is one diagonal, an RSI that
 * is only its levels) for several seconds, and "My Strategy" vanished from the
 * legend — twice for good, after its run came back 500 — while the toolbar
 * still counted it.
 *
 * What is pinned here, through the real workspace:
 *
 * - no study is ever drawn from a window that is not the one the price pane
 *   holds for the same dataset — never a handful of points, never bars that
 *   end somewhere other than where the chart's do;
 * - while another instrument's window is in flight, every study keeps its
 *   row (loading) and nothing is computed from the previous instrument;
 * - a superseded Pine run is CANCELLED, and neither a cancel nor a 500 takes
 *   the strategy out of the legend; the next dataset runs it again.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, screen, within } from "@testing-library/react";
import {
  advance, closeBrowser, compactSeries, resetBrowser, server, settle,
} from "./harness/env";
import { mountChart, type MountedChart } from "./harness/chart";
import { CANONICAL } from "./harness/market";
import { createWorkspace, WORKSPACE_STORAGE_KEY } from "@/lib/workspace";
import { indicatorStorageKey } from "@/lib/indicators";
import type { ChartOverlay } from "@/lib/chartSeries";

const SOURCE = '//@version=5\nindicator("My Strategy")\nplot(close)';
const DAY = 86_400_000;
const MIN = 60_000;

/** Every pane's study series, read from the props the chart is drawing. */
interface Drawn { pane: string; id: string; title: string; points: number; lastTime: number | null }

interface Fiber {
  child: Fiber | null; sibling: Fiber | null; type: unknown;
  memoizedProps: Record<string, unknown> | null;
}

function rootFiber(container: Element): Fiber | null {
  for (const node of [container, ...container.querySelectorAll("*")]) {
    const key = Object.keys(node).find((k) =>
      k.startsWith("__reactContainer$") || k.startsWith("__reactFiber$"));
    if (!key) continue;
    let fiber = (node as unknown as Record<string, Fiber & { return?: Fiber | null }>)[key]!;
    while ((fiber as { return?: Fiber | null }).return) {
      fiber = (fiber as { return: Fiber }).return as Fiber & { return?: Fiber | null };
    }
    return fiber;
  }
  return null;
}

/**
 * What the study panes and the price chart are being handed right now.
 *
 * An oracle over the component tree, like `harness/timeScales`: the canvas
 * draws nothing here, so the data the chart is GIVEN is the observable.
 */
function snapshot(container: Element): { studies: Drawn[]; priceLast: number | null; priceBars: number } {
  const studies: Drawn[] = [];
  let priceLast: number | null = null;
  let priceBars = 0;
  const root = rootFiber(container);
  const stack: Fiber[] = root ? [root] : [];
  while (stack.length > 0) {
    const fiber = stack.pop()!;
    const name = typeof fiber.type === "function" ? (fiber.type as { name?: string }).name : null;
    if (name === "IndicatorPane") {
      const overlays = (fiber.memoizedProps?.overlays ?? []) as ChartOverlay[];
      for (const o of overlays) {
        if (o.constantValue !== undefined) continue; // a level is two points by design
        studies.push({ pane: String(fiber.memoizedProps?.id), id: o.id, title: o.instanceTitle ?? o.title,
          points: o.data.length, lastTime: o.data[o.data.length - 1]?.time ?? null });
      }
    }
    if (name === "CandleChart") {
      const candles = (fiber.memoizedProps?.candles ?? []) as { openTime: number }[];
      priceBars = candles.length;
      priceLast = candles.length > 0 ? Math.floor(candles[candles.length - 1]!.openTime / 1000) : null;
    }
    if (fiber.sibling) stack.push(fiber.sibling);
    if (fiber.child) stack.push(fiber.child);
  }
  return { studies, priceLast, priceBars };
}

/** The invariant: a study is drawn from the chart's own window, or not at all. */
function assertNoPartialStudy(container: Element, when: string): void {
  const { studies, priceLast, priceBars } = snapshot(container);
  for (const s of studies) {
    if (s.points === 0) continue;
    assert.ok(priceBars > 0, `${when}: ${s.title} drew ${s.points} points over a pane with no bars`);
    assert.ok(s.points >= 50,
      `${when}: ${s.title} was drawn from a ${s.points}-point dataset`);
    assert.equal(s.lastTime, priceLast,
      `${when}: ${s.title} ends at ${s.lastTime}, the chart's bars at ${priceLast} — `
      + "it was computed over a window that is not the one on screen");
  }
}

const legendText = (chart: MountedChart): string =>
  (chart.container.textContent ?? "").replace(/\s+/g, " ");

async function addStudies(chart: MountedChart, names: readonly string[]): Promise<void> {
  // The toolbar's control; with a study applied it also counts them.
  const open = chart.container.querySelector<HTMLElement>('button[aria-label^="Indicators —"]')
    ?? chart.container.querySelector<HTMLElement>('button[aria-label="Indicators"]');
  fireEvent.click(open!);
  await settle();
  const dialog = screen.getByRole("dialog");
  for (const name of names) {
    fireEvent.click(within(dialog).getByRole("button", { name }));
    await settle();
  }
  fireEvent.keyDown(document, { key: "Escape" });
  await settle();
  await advance(1_500);
}

async function clickInterval(chart: MountedChart, label: string): Promise<void> {
  const button = [...chart.container.querySelectorAll<HTMLElement>("button")]
    .find((b) => (b.textContent ?? "").trim() === label);
  assert.ok(button, `the toolbar has no ${label} control`);
  fireEvent.click(button);
  await settle();
}

/** Every Pine request's signal, so a test can see which ones were cancelled. */
const pineSignals: AbortSignal[] = [];

beforeEach(() => {
  resetBrowser();
  pineSignals.length = 0;
  const fixtureFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("/api/pine/run") && init?.signal) pineSignals.push(init.signal);
    return fixtureFetch(input, init);
  }) as typeof fetch;

  // Windows of very different depths, which is what makes an index carried
  // from one of them into another point at the wrong bars.
  server.setDefaultCandles(compactSeries(600));
  server.setCandles("SOLUSDT", "1d", compactSeries(90, { intervalMs: DAY }));
  server.setCandles("SOLUSDT", "1h", compactSeries(400, { intervalMs: 60 * MIN }));
  server.setCandles("SOLUSDT", "1m", compactSeries(1_000, { intervalMs: MIN }));
  server.setCandles("SOLUSDT", "5m", compactSeries(800, { intervalMs: 5 * MIN }));
  server.setCandles("BTCUSDT", "15m", compactSeries(700, { base: 60_000 }));
  server.seedWatchlist([CANONICAL.SOLUSDT!, CANONICAL.BTCUSDT!]);
  window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(
    createWorkspace({ symbol: CANONICAL.SOLUSDT!, interval: "15m" })));
  window.localStorage.setItem(indicatorStorageKey("p1"), JSON.stringify([
    { key: "i1", scriptId: null, name: "My Strategy", source: SOURCE, params: {}, visible: true },
  ]));
  server.routes.set("POST /api/pine/run", (body) => {
    const symbol = (body as { symbol: string }).symbol;
    return {
      ok: true, errors: [],
      meta: { kind: "indicator", title: "My Strategy", shortTitle: "", overlay: true,
        format: "price", precision: 2, inputs: [], warnings: [] },
      times: [Math.floor(Date.now() / 1000)],
      plots: [{ id: "p0", title: "Fast", color: "#4f8cff", width: 1, style: "line",
        data: [symbol === "BTCUSDT" ? 2 : 1], renderable: true }],
    };
  });
});
after(closeBrowser);

test("W2D-01 — interval abuse, then a cold symbol: no study ever draws a partial window", async () => {
  const chart = await mountChart();
  await addStudies(chart, ["Average True Range", "Relative Strength Index"]);
  await advance(600);
  assertNoPartialStudy(chart.container, "on mount");
  assert.ok(snapshot(chart.container).studies.some((s) => s.points > 0), "no study drew to begin with");

  // The interval abuse, each switch landing before the next.
  for (const label of ["1m", "1h", "D", "5m", "15m"]) {
    await clickInterval(chart, label);
    assertNoPartialStudy(chart.container, `straight after ${label}`);
    await advance(250);
    assertNoPartialStudy(chart.container, `once ${label} landed`);
  }

  // A cold instrument: its bars and its Pine run are both held in flight.
  const releaseBars = server.hold(({ path }) => path.includes("candles") && path.includes("BTC"));
  const releaseRun = server.hold((r) => r.path === "/api/pine/run"
    && (r.body as { symbol?: string }).symbol === "BTCUSDT");
  try {
    const row = chart.container.querySelector<HTMLElement>(
      `[data-watchlist-row="${CANONICAL.BTCUSDT}"] button`);
    assert.ok(row, "the watchlist has no BTC row to switch to");
    fireEvent.click(row);
    for (let i = 0; i < 4; i += 1) {
      await advance(150);
      assertNoPartialStudy(chart.container, `while BTC loads (${i})`);
      const { studies } = snapshot(chart.container);
      assert.ok(studies.every((s) => s.points === 0),
        "a study was computed from SOL's bars under BTC's name");
    }
    const text = legendText(chart);
    assert.match(text, /Average True Range[^]*Loading…/, "ATR left the legend while BTC loaded");
    assert.match(text, /Relative Strength Index[^]*Loading…/, "RSI left the legend while BTC loaded");
    assert.match(text, /My Strategy\s*Loading…/, "the strategy vanished while its run was in flight");
  } finally {
    releaseBars();
  }
  await advance(300);
  assertNoPartialStudy(chart.container, "once BTC's bars landed");
  assert.ok(snapshot(chart.container).studies.some((s) => s.points > 0),
    "the studies never drew on BTC");
  assert.match(legendText(chart), /My Strategy\s*Loading…/,
    "the strategy's row must survive until its own run lands");
  releaseRun();
  await advance(300);
  assert.ok(!/My Strategy\s*Loading…/.test(legendText(chart)), "the strategy never settled");
});

test("W2D-01 — a superseded Pine run is cancelled, and a cancel or a 500 never removes the strategy", async () => {
  const chart = await mountChart();
  await advance(600);
  assert.match(legendText(chart), /My Strategy/);

  // Every run from here on is held, so each switch supersedes the last.
  const release = server.hold((r) => r.path === "/api/pine/run");
  const before = pineSignals.length;
  try {
    for (const label of ["1h", "5m", "15m"]) {
      await clickInterval(chart, label);
      await advance(100);
      assert.match(legendText(chart), /My Strategy\s*Loading…/,
        `the strategy left the legend while its ${label} run was in flight`);
    }
    const asked = pineSignals.slice(before);
    assert.ok(asked.length >= 3, `only ${asked.length} runs were asked for`);
    assert.ok(asked.slice(0, -1).every((s) => s.aborted),
      "a run the chart had moved on from was left running on the server");
    assert.equal(asked[asked.length - 1]!.aborted, false, "the CURRENT run was cancelled");
  } finally {
    release();
  }
  await advance(300);

  // The proxy's 500 — the study is listed, says so, and is run again next time.
  server.routes.set("POST /api/pine/run", () => new Response("Internal Server Error", {
    status: 500, headers: { "content-type": "text/plain" } }));
  await clickInterval(chart, "1h");
  await advance(400);
  assert.match(legendText(chart), /My Strategy\s*Could not run on this chart/,
    "a 500 took the strategy out of the legend");
  assert.ok(!/Internal Server Error/.test(legendText(chart)), "the proxy's words are page copy");

  server.routes.set("POST /api/pine/run", () => ({
    ok: true, errors: [],
    meta: { kind: "indicator", title: "My Strategy", shortTitle: "", overlay: true,
      format: "price", precision: 2, inputs: [], warnings: [] },
    times: [Math.floor(Date.now() / 1000)],
    plots: [{ id: "p0", title: "Fast", color: "#4f8cff", width: 1, style: "line", data: [3], renderable: true }],
  }));
  const runsBefore = server.callsTo("/api/pine/run").length;
  await clickInterval(chart, "15m");
  await advance(400);
  assert.ok(server.callsTo("/api/pine/run").length > runsBefore,
    "the failed study was not run again on the next dataset");
  const text = legendText(chart);
  assert.match(text, /My Strategy/);
  assert.ok(!/Could not run on this chart|Loading…/.test(text), "the strategy did not recover");
});
