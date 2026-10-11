/**
 * W2D-04: a comparison's gap notice is on its own legend row, not over the
 * range shortcuts.
 *
 * With any comparison whose second instrument has a missing bar, a
 * `role="status"` box — "ETHUSDT has no bar for N of these — those bars are
 * left out rather than filled in with an invented price." — sat at the foot of
 * the pane, exactly over `1D 5D 1M 3M 6M YTD 1Y 5Y All`, and stayed there for
 * as long as the comparison was applied, reloads included. The sentence is
 * still owed to the reader; it is now an info glyph on the comparison pane's
 * legend row, whose tooltip and accessible name are the sentence.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { closeBrowser, compactSeries, resetBrowser, server, settle } from "./harness/env";
import { mountChart } from "./harness/chart";
import { createWorkspace, WORKSPACE_STORAGE_KEY } from "@/lib/workspace";

const HOUR = 3_600_000;

beforeEach(() => {
  resetBrowser();
  const bars = compactSeries(300, { intervalMs: HOUR });
  server.setCandles("SOLUSDT", "1h", bars);
  // The second instrument is missing five bars in the middle of the window.
  server.setCandles("ETHUSDT", "1h", bars.filter((_, i) => i < 150 || i >= 155));
});
after(closeBrowser);

function seed(): void {
  const ws = createWorkspace({ symbol: "SOLUSDT", interval: "1h" });
  ws.panes[0] = { ...ws.panes[0]!, compare: { symbol: "ETHUSDT", mode: "percent", length: 60 } };
  window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(ws));
}

test("W2D-04 — the gap notice is an info glyph on the compare pane's legend, never a status over the plot", async () => {
  seed();
  const { container } = await mountChart();
  await settle(6);

  const gapSentence = /has no bar for \d+ of these/;
  const statuses = [...container.querySelectorAll<HTMLElement>('[role="status"]')]
    .filter((el) => gapSentence.test(el.textContent ?? ""));
  assert.equal(statuses.length, 0,
    "the gap sentence is still a status box laid over the chart, where the range row is");

  const notes = [...container.querySelectorAll<HTMLElement>("[data-legend-note]")];
  assert.equal(notes.length, 1, `expected one legend note, found ${notes.length}`);
  const note = notes[0]!;
  const label = note.getAttribute("aria-label") ?? "";
  assert.match(label, /^ETHUSDT has no bar for 5 of these/,
    "the glyph's accessible name is the sentence, with the real count");
  assert.equal(note.getAttribute("role"), "img", "an info glyph a screen reader can read");
  assert.equal(note.getAttribute("title"), label, "and the sentence is its tooltip");
  assert.equal((note.textContent ?? "").trim(), "", "the glyph prints no sentence over the chart");

  const pane = note.closest<HTMLElement>("section[aria-label$='indicator pane']");
  assert.ok(pane, "the note is not on a pane's legend");
  assert.match(pane.getAttribute("aria-label") ?? "", /^Percent change vs ETHUSDT/,
    "the note belongs to the comparison's own pane");
});

test("W2D-04 — a comparison with no gap carries no note", async () => {
  server.setCandles("ETHUSDT", "1h", compactSeries(300, { intervalMs: HOUR }));
  seed();
  const { container } = await mountChart();
  await settle(6);
  assert.equal(container.querySelectorAll("[data-legend-note]").length, 0,
    "a complete second series has nothing to disclose");
  assert.ok(container.querySelector("section[aria-label^='Percent change vs ETHUSDT']"),
    "the comparison pane itself is still drawn");
});
