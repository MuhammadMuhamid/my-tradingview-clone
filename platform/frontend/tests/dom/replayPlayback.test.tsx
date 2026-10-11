/**
 * ── B-04: Replay Play advanced one bar per Pine round trip ────────────────
 *
 * The clock skipped every tick while any Pine study was loading, and every
 * tick started a fresh run of every study — so at 10× the chart moved about
 * one bar per server round trip. The clock now runs at the speed chosen, and
 * while a study's run is in flight later steps only ask for one more run, for
 * whatever horizon the chart has reached when it lands.
 *
 * Lookahead is the line that must not move: a forward step's output can only
 * end EARLIER than the horizon, and every run is asked for the horizon the
 * chart was on when it started — never a later one.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, screen } from "@testing-library/react";
import { advance, closeBrowser, compactSeries, resetBrowser, server, settle } from "./harness/env";
import { mountChart } from "./harness/chart";
import { indicatorStorageKey } from "@/lib/indicators";

const SOURCE = '//@version=5\nindicator("Probe")\nplot(close)';

beforeEach(() => {
  resetBrowser();
  server.setDefaultCandles(compactSeries(600));
  window.localStorage.setItem(indicatorStorageKey("p1"), JSON.stringify([
    { key: "i1", scriptId: null, name: "Probe", source: SOURCE, params: {}, visible: true },
  ]));
  server.routes.set("POST /api/pine/run", () => ({
    ok: true, errors: [], times: [], plots: [],
    meta: { kind: "indicator", title: "Probe", shortTitle: "PRB", overlay: true,
      format: "price", precision: 2, inputs: [], warnings: [] },
  }));
});
after(closeBrowser);

function horizon(): number {
  const stamp = document.querySelector<HTMLElement>("time[datetime]");
  assert.ok(stamp, "no running session");
  return Date.parse(stamp.getAttribute("datetime")!);
}

test("B-04 — Play keeps time while a study's run is in flight, and runs it at most once at a time", async () => {
  const chart = await mountChart();
  await advance(300);
  fireEvent.click(chart.container.querySelector<HTMLElement>('button[aria-label="Bar replay"]')!);
  await settle();
  fireEvent.click(screen.getByRole("button", { name: "Start Replay" }));
  await settle();
  await advance(300);

  const startedAt = horizon();
  const before = server.callsTo("/api/pine/run").length;
  const release = server.hold("/api/pine/run");
  try {
    fireEvent.click(screen.getAllByRole("button", { name: "Play replay" })[0]!);
    await settle();
    // Default speed: one bar a second. One `advance` per tick, because React
    // commits the next tick's timer only when the previous one's act ends.
    for (let i = 0; i < 4; i += 1) await advance(1_050);
    const stepped = (horizon() - startedAt) / (15 * 60_000);
    assert.ok(stepped >= 3, `the clock advanced ${stepped} bars in four seconds while a run was in flight`);
    const during = server.callsTo("/api/pine/run").length - before;
    assert.ok(during <= 1, `${during} runs were started for one study while one was still in flight`);
  } finally {
    release();
  }
  await advance(300);
  fireEvent.click(screen.getAllByRole("button", { name: /Pause replay/ })[0]!);
  await settle();
  const runs = server.callsTo("/api/pine/run").slice(before);
  const last = horizon();
  for (const run of runs) {
    const end = Date.parse((run.body as { endTime: string }).endTime);
    assert.ok(end <= last, "a run was asked for a horizon the chart had not reached — lookahead");
  }
});
