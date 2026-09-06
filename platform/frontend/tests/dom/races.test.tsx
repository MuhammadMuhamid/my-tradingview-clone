/**
 * Two answers to one question, arriving in the wrong order.
 *
 * ── Why this needs a browser ───────────────────────────────────────────────
 *
 * A stale-response guard is a claim about TIME: that the answer to a question
 * nobody is asking any more cannot land on screen. Every piece of it is pure —
 * a token, a comparison — and none of it can be tested by calling those pieces,
 * because the defect is a promise settling after a re-render, which is a thing
 * only a mounted component does.
 *
 * So the fixture origin holds the first response open until the second has
 * landed, and then releases it. That is the exact interleaving a slow network
 * produces and a fast test never does by accident.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { act, render } from "@testing-library/react";
import { closeBrowser, compactSeries, resetBrowser, server, settle } from "./harness/env";
import { useCompareSeries, type CompareSeries } from "@/lib/compare";
import { useIndicators, type IndicatorsApi } from "@/lib/useIndicators";
import type { Candle, Interval } from "@/lib/types";

const SOURCE = '//@version=5\nindicator("Probe")\nplot(close)';

/**
 * The base chart's bars, on the SAME grid the fixture serves.
 *
 * Compare aligns by open time and never by index — deliberately, because two
 * instruments have different histories. A base series on its own invented grid
 * would therefore align to nothing, and every assertion below would pass for
 * the wrong reason.
 */
const base = (count: number): Candle[] =>
  compactSeries(count).map(([openTime, open, high, low, close, volume]) => ({
    symbol: "SOLUSDT", interval: "15m" as const,
    openTime, open, high, low, close, volume,
    closeTime: openTime + 900_000 - 1,
  }));

beforeEach(() => {
  resetBrowser();
  server.setDefaultCandles(compactSeries(600));
});
after(closeBrowser);

test("a compared instrument's slow answer cannot land under a newer symbol's name", async () => {
  const BASE = base(600);
  // Two second-instruments with visibly different closes.
  server.setCandles("BTCUSDT", "15m", compactSeries(600, { base: 60_000 }));
  server.setCandles("ETHUSDT", "15m", compactSeries(600, { base: 3_000 }));

  let latest: CompareSeries | null = null;
  function Harness({ symbol }: { symbol: string }) {
    latest = useCompareSeries(BASE, symbol, "15m", 600);
    return null;
  }

  // BTC's answer is held open. Nothing about it will be allowed to settle
  // until ETH has already been asked for and answered.
  const releaseBtc = server.hold("/api/symbols/BTCUSDT/");

  const view = render(<Harness symbol="BTCUSDT" />);
  await settle();
  assert.equal(latest!.closes.length, 0, "BTC has not answered yet");

  // The user changes the compared instrument while BTC is still in flight.
  await act(async () => { view.rerender(<Harness symbol="ETHUSDT" />); });
  await settle();
  assert.equal(latest!.symbol, "ETHUSDT");
  const ethCloses = latest!.closes.slice();
  assert.ok(ethCloses.some((v) => Number.isFinite(v)), "ETH answered");

  // Now BTC finally answers. It must change nothing.
  releaseBtc();
  await settle();

  assert.equal(latest!.symbol, "ETHUSDT",
    "the first answer must not land on screen under the second symbol's name");
  assert.deepEqual(latest!.closes, ethCloses);
});

test("a compared series is never aligned onto a grid it was not loaded for", async () => {
  const BASE = base(600);
  server.setCandles("BTCUSDT", "15m", compactSeries(600, { base: 60_000 }));
  // Deliberately nothing at 4h: if the 15m answer were reused for the 4h grid,
  // the series would be plausibly populated instead of empty.
  server.setCandles("BTCUSDT", "4h", []);

  let latest: CompareSeries | null = null;
  function Harness({ interval }: { interval: Interval }) {
    latest = useCompareSeries(BASE, "BTCUSDT", interval, 600);
    return null;
  }

  const view = render(<Harness interval="15m" />);
  await settle();
  assert.ok(latest!.closes.some(Number.isFinite), "the 15m series loaded");

  await act(async () => { view.rerender(<Harness interval="4h" />); });
  await settle();

  assert.ok(!latest!.closes.some(Number.isFinite),
    "the interval is part of the request's identity; a symbol-only guard let " +
    "the previous timeframe's closes be aligned onto the new grid");
});

test("a Pine run for the old symbol cannot settle over the new one's output", async () => {
  let api: IndicatorsApi | null = null;
  function Harness({ symbol }: { symbol: string }) {
    api = useIndicators({
      symbol, timeframe: "15m",
      startTime: "2026-01-01T00:00:00.000Z", endTime: "2026-01-02T00:00:00.000Z",
      scope: "p1",
    });
    return null;
  }

  const run = (symbol: string, value: number): unknown => ({
    ok: true, errors: [],
    meta: {
      kind: "indicator", title: symbol, shortTitle: symbol, overlay: true,
      format: "price", precision: 2, inputs: [], warnings: [],
    },
    times: [1_767_225_600],
    plots: [{
      id: "p0", title: symbol, color: "#4f8cff", width: 1, style: "line",
      data: [value], renderable: true,
    }],
  });
  server.routes.set("POST /api/pine/run",
    (body) => run((body as { symbol: string }).symbol,
      (body as { symbol: string }).symbol === "SOLUSDT" ? 1 : 2));

  // Hold every run asked for on behalf of SOLUSDT — the same path as the
  // others, told apart by what was actually asked.
  const releaseSol = server.hold(
    (r) => r.path === "/api/pine/run" && (r.body as { symbol?: string }).symbol === "SOLUSDT");

  const view = render(<Harness symbol="SOLUSDT" />);
  await settle();
  await act(async () => { api!.add({ scriptId: null, name: "Probe", source: SOURCE }); });
  await settle();
  assert.equal(api!.overlays.length, 0, "the first run is still in flight");

  // The user switches instrument. That re-runs everything under a fresh token.
  await act(async () => { view.rerender(<Harness symbol="BTCUSDT" />); });
  await settle();
  assert.equal(api!.overlays.length, 1);
  assert.deepEqual(api!.overlays[0]!.data.map((p) => p.value), [2], "BTC's own output");

  releaseSol();
  await settle();

  assert.equal(api!.overlays.length, 1);
  assert.deepEqual(api!.overlays[0]!.data.map((p) => p.value), [2],
    "a run keyed to a symbol nobody is looking at any more must not draw");
  assert.equal(api!.list[0]!.loading, false);
});

test("two runs of the same instance settle in the order they were asked for", async () => {
  /*
   * The per-instance generation, which is a different guard from the token.
   * Retuning an input twice quickly issues two runs under the SAME context
   * token; without a per-instance version the first, slower one settles last
   * and the study shows the parameters the user has already moved on from.
   */
  let api: IndicatorsApi | null = null;
  function Harness() {
    api = useIndicators({
      symbol: "SOLUSDT", timeframe: "15m",
      startTime: "2026-01-01T00:00:00.000Z", endTime: "2026-01-02T00:00:00.000Z",
      scope: "p1",
    });
    return null;
  }

  let served = 0;
  server.routes.set("POST /api/pine/run", (body) => {
    served += 1;
    const length = (body as { params?: Record<string, number> }).params?.length ?? 0;
    return {
      ok: true, errors: [],
      meta: {
        kind: "indicator", title: "Probe", shortTitle: "PRB", overlay: true,
        format: "price", precision: 2,
        inputs: [{ key: "length", title: "Length", type: "int", defval: 0 }],
        warnings: [],
      },
      times: [1_767_225_600],
      plots: [{
        id: "p0", title: "Probe", color: "#4f8cff", width: 1, style: "line",
        data: [length], renderable: true,
      }],
    };
  });

  render(<Harness />);
  await settle();
  await act(async () => { api!.add({ scriptId: null, name: "Probe", source: SOURCE }); });
  await settle();
  const key = api!.list[0]!.key;

  // The first retune's answer is held; the second's is not.
  const releaseFirst = server.hold(
    (r) => r.path === "/api/pine/run" && (r.body as { params?: { length?: number } })
      .params?.length === 5);

  await act(async () => { api!.setParam(key, "length", 5); });
  await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
  await act(async () => { api!.setParam(key, "length", 9); });
  await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
  await settle();

  assert.ok(served >= 2, `only ${served} runs were issued`);
  releaseFirst();
  await settle();

  assert.deepEqual(api!.overlays[0]!.data.map((p) => p.value), [9],
    "the study must show the inputs the user last chose, not the answer that " +
    "happened to arrive last");
});
