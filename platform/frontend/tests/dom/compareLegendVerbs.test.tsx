/**
 * The comparison pane's legend verbs act.
 *
 * Final-closure finding: the `Percent change vs …` row carries the same
 * Hide / Settings / Remove cluster as every study row, but the comparison is
 * pane state, not a study — `ChartPane.paneAction` handed its key to the Pine
 * indicator API, which did not know it, and all three clicks were dropped.
 *
 * And a comparison restored from storage holds a canonical `instrument:v1:…`
 * id; writing it back (the eye, a mode change) upper-cased it into a different
 * key, so the series refetched and the chart re-framed.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, screen } from "@testing-library/react";
import { closeBrowser, compactSeries, resetBrowser, server, settle } from "./harness/env";
import { mountChart } from "./harness/chart";
import { createWorkspace, WORKSPACE_STORAGE_KEY } from "@/lib/workspace";

const HOUR = 3_600_000;

beforeEach(() => {
  resetBrowser();
  const bars = compactSeries(300, { intervalMs: HOUR });
  server.setCandles("SOLUSDT", "1h", bars);
  server.setCandles("ETHUSDT", "1h", bars);
});
after(closeBrowser);

function seed(): void {
  const ws = createWorkspace({ symbol: "SOLUSDT", interval: "1h" });
  ws.panes[0] = { ...ws.panes[0]!, compare: { symbol: "ETHUSDT", mode: "percent", length: 60 } };
  window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(ws));
}

const storedCompare = (): { symbol: string; hidden?: boolean } | undefined =>
  JSON.parse(window.localStorage.getItem(WORKSPACE_STORAGE_KEY) ?? "{}").panes?.[0]?.compare;

const button = (name: string | RegExp) => screen.queryAllByRole("button", { name })[0] ?? null;
const comparePane = (container: HTMLElement) =>
  container.querySelector("section[aria-label^='Percent change vs ETHUSDT']");

test("the comparison legend's eye hides it, keeps its identity, and is reversible", async () => {
  seed();
  const { container } = await mountChart();
  await settle(6);
  assert.ok(comparePane(container), "the comparison pane is drawn");
  const restored = storedCompare()!.symbol;
  assert.equal(restored, "instrument:v1:BINANCE:spot:ETH:USDT:USDT:spot");

  fireEvent.click(button("Hide Percent change vs ETHUSDT")!);
  await settle(4);
  assert.equal(comparePane(container), null, "a hidden comparison draws no pane");
  assert.equal(storedCompare()?.hidden, true, "and the workspace remembers it is hidden");
  assert.equal(storedCompare()?.symbol, restored,
    "writing it back must not re-spell the canonical id (a new key re-frames the chart)");

  const show = button("Show Percent change vs ETHUSDT");
  assert.ok(show, "the hidden comparison is offered back on the price legend");
  fireEvent.click(show);
  await settle(4);
  assert.ok(comparePane(container), "Show draws it again");
  assert.notEqual(storedCompare()?.hidden, true);
});

test("the comparison legend's settings open the comparison menu, and Remove removes it", async () => {
  seed();
  const { container } = await mountChart();
  await settle(6);

  fireEvent.click(button("Percent change vs ETHUSDT settings")!);
  await settle(2);
  assert.ok(screen.queryByText("Remove comparison"), "settings opens the comparison's own menu");
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  await settle(2);

  fireEvent.click(button("Remove Percent change vs ETHUSDT")!);
  await settle(4);
  assert.equal(comparePane(container), null, "the comparison pane is gone");
  assert.equal(storedCompare(), undefined, "and so is the stored comparison");
});
