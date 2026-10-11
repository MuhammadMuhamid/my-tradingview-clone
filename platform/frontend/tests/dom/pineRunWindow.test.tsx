/**
 * ── B-12: "My Strategy" on 1m ran nothing and said nothing ────────────────
 *
 * Switching to 1m sent `POST /api/pine/run` from the standard backtest start —
 * 496,800 bars against the server's 120,000 limit — and the 400 left the
 * legend showing `∅ ∅`. The run's start is now clamped to what one run may
 * load (`pineRunRange`), and a run that fails anyway says so on its legend
 * row in plain language rather than in the server's words.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { advance, closeBrowser, compactSeries, resetBrowser, server, settle } from "./harness/env";
import { mountChart } from "./harness/chart";
import { createWorkspace, WORKSPACE_STORAGE_KEY } from "@/lib/workspace";
import { indicatorStorageKey } from "@/lib/indicators";

const SOURCE = '//@version=5\nindicator("My Strategy")\nplot(close)';

beforeEach(() => {
  resetBrowser();
  server.setDefaultCandles(compactSeries(600, { intervalMs: 60_000 }));
  window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(
    createWorkspace({ symbol: "SOLUSDT", interval: "1m" })));
  window.localStorage.setItem(indicatorStorageKey("p1"), JSON.stringify([
    { key: "i1", scriptId: null, name: "My Strategy", source: SOURCE, params: {}, visible: true },
  ]));
});
after(closeBrowser);

test("B-12 — a 1m run never asks for more bars than the server will run", async () => {
  server.routes.set("POST /api/pine/run", () => ({
    ok: true, errors: [], times: [], plots: [],
    meta: { kind: "indicator", title: "My Strategy", shortTitle: "", overlay: true,
      format: "price", precision: 2, inputs: [], warnings: [] },
  }));
  await mountChart();
  await advance(600);
  const runs = server.callsTo("/api/pine/run");
  assert.ok(runs.length > 0, "the study was never run");
  for (const run of runs) {
    const body = run.body as { startTime: string; endTime: string; timeframe: string };
    const bars = (Date.parse(body.endTime) - Date.parse(body.startTime)) / 60_000;
    assert.ok(bars <= 120_000, `a ${body.timeframe} run asked for ${Math.round(bars)} bars`);
  }
});

test("B-12 — a failed run says so on its legend row, in plain words", async () => {
  server.routes.set("POST /api/pine/run", () => new Response(
    JSON.stringify({ error: "range is too large: 496,800 bars exceeds the 120,000 limit for one run" }),
    { status: 400, headers: { "content-type": "application/json" } }));
  const chart = await mountChart();
  await advance(600);
  await settle();
  const text = (chart.container.textContent ?? "").replace(/\s+/g, " ");
  assert.match(text, /My Strategy\s*Could not run on this chart/,
    "the failed study's row does not say what happened");
  assert.ok(!/range is too large|120,000/.test(text), "the server's own words are page copy");
});
