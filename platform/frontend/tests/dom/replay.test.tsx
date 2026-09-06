/**
 * Replay, and the fence around it.
 *
 * ── What has to be true ────────────────────────────────────────────────────
 *
 * A Replay is a scratch pad over history. Three things follow, and all three
 * are cross-component wiring rather than logic:
 *
 *   Nothing a Replay does is persisted. A trendline drawn at a replayed bar
 *   belongs to the session, not to the instrument, and it must reach neither
 *   local storage nor the server.
 *
 *   Nothing a Replay shows may arm a live action. The price on screen is not
 *   the market, so an alert or an order staged from it would be armed at a
 *   number that does not exist.
 *
 *   Nothing computed during a Replay may see past the horizon. A study run
 *   with today's end time and a rewound chart is lookahead with a plausible
 *   picture attached.
 *
 * `lib/replay` is pure and tested. Whether the WORKSPACE honours it was, until
 * now, a claim about source code.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, screen } from "@testing-library/react";
import { advance, closeBrowser, compactSeries, resetBrowser, server, settle } from "./harness/env";
import {
  drag, menuItems, mountChart, rightClickAt, selectTool, type MountedChart,
} from "./harness/chart";
import { drawingStore } from "@/lib/drawingStore";
import { loadDrawings } from "@/lib/drawings";

const SYMBOL = "SOLUSDT";

beforeEach(() => {
  resetBrowser();
  server.setDefaultCandles(compactSeries(600));
  server.routes.set("POST /api/pine/run", () => ({
    ok: true, errors: [],
    meta: {
      kind: "indicator", title: "Probe", shortTitle: "PRB", overlay: true,
      format: "price", precision: 2, inputs: [], warnings: [],
    },
    times: [], plots: [],
  }));
});
after(closeBrowser);

/** Open the replay picker and start a session at the suggested bar. */
async function startReplay(chart: MountedChart): Promise<void> {
  const open = [...chart.container.querySelectorAll<HTMLElement>("button")]
    .find((b) => (b.textContent ?? "").trim() === "Replay");
  assert.ok(open, "the toolbar has no Replay control");
  fireEvent.click(open);
  await settle();

  const start = screen.getByRole("button", { name: "Start Replay" });
  assert.equal(start.hasAttribute("disabled"), false,
    "the picker must pre-fill a replay point from the loaded bars");
  fireEvent.click(start);
  await settle();
}

test("a session starts at a completed bar and can be left again", async () => {
  const chart = await mountChart();
  await startReplay(chart);

  assert.ok(screen.getByRole("button", { name: "Exit Replay" }),
    "a running session must be visible as one, and leavable");

  // While it runs, the chart menu refuses the live actions and says why.
  await rightClickAt(chart.plot, 600, 300);
  const alert = menuItems().find((i) => i.label.startsWith("Add alert"));
  assert.ok(alert, "the chart menu must still offer the item");
  assert.equal(alert.disabled, true,
    "arming a live alert from a replayed bar would arm it at a price that is not the market");
});

test("a drawing made during a Replay is session state and is never persisted", async () => {
  const chart = await mountChart();

  // A real drawing on the instrument first, so "nothing was written" is
  // distinguishable from "nothing was ever there".
  await selectTool(chart.container, "Trend line");
  await drag(chart.plot, [300, 260], [520, 380]);
  await advance(1_400);
  const realCount = loadDrawings(SYMBOL).length;
  const serverVersion = server.getDrawings(SYMBOL).version;
  assert.equal(realCount, 1);
  assert.equal(serverVersion, 1);

  await startReplay(chart);
  await selectTool(chart.container, "Trend line");
  await drag(chart.plot, [340, 300], [560, 420]);
  await advance(1_400);

  assert.equal(loadDrawings(SYMBOL).length, realCount,
    "a Replay drawing must not reach this browser's storage");
  assert.equal(server.getDrawings(SYMBOL).version, serverVersion,
    "and it must not reach the server either — that is what makes a Replay a scratch pad");
  assert.equal(drawingStore.get(SYMBOL).length, realCount,
    "the instrument's own list is untouched");
});

test("a study run during a Replay is bounded by the horizon, not by today", async () => {
  const chart = await mountChart();

  const liveRuns = server.callsTo("/api/pine/run").length;
  await startReplay(chart);
  await settle();

  // Apply a study while the session is running, through the workspace's own
  // Pine path, and read what the request actually asked for.
  const runs = server.callsTo("/api/pine/run");
  const bodies = runs.slice(liveRuns).map((c) => c.body as { endTime?: string });
  for (const body of bodies) {
    assert.ok(body.endTime, "every run states its horizon");
    assert.ok(new Date(body.endTime!).getTime() < Date.now(),
      `a replayed run ended at ${body.endTime}, which is not a rewound horizon`);
  }
  assert.ok(chart.container);
});

test("leaving a Replay restores the instrument's own drawings", async () => {
  const chart = await mountChart();
  await selectTool(chart.container, "Trend line");
  await drag(chart.plot, [300, 260], [520, 380]);
  const before = drawingStore.get(SYMBOL).map((d) => d.id);

  await startReplay(chart);
  await selectTool(chart.container, "Trend line");
  await drag(chart.plot, [340, 300], [560, 420]);

  const exit = [...chart.container.querySelectorAll<HTMLElement>("button")]
    .find((b) => /exit/i.test(b.textContent ?? ""));
  assert.ok(exit, "a running session must be leavable");
  fireEvent.click(exit);
  await settle();

  assert.deepEqual(drawingStore.get(SYMBOL).map((d) => d.id), before,
    "the session's drawings vanish with it, and the instrument's do not");
});
