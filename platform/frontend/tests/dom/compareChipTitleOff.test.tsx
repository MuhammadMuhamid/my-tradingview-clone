/**
 * B-17: `Title` off hides the title, not the comparison.
 *
 * With a comparison active, Chart settings → Status line → Title off took the
 * `vs TICKER` chip away with the title, so the comparison's own menu (change
 * the mode, remove it) was reachable only through the toolbar's Compare
 * button. The chip says the chart is a materially different chart — a
 * percentage against a second instrument — and that must stay visible and
 * one click from undoing whatever the title is doing.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { screen } from "@testing-library/react";
import { closeBrowser, compactSeries, resetBrowser, server, settle } from "./harness/env";
import { mountChart } from "./harness/chart";
import { createWorkspace, WORKSPACE_STORAGE_KEY } from "@/lib/workspace";
import { DEFAULT_CHART_SETTINGS } from "@/lib/chartSettings";

beforeEach(() => {
  resetBrowser();
  server.setDefaultCandles(compactSeries(600));
});
after(closeBrowser);

function seed(statusSymbol: boolean): void {
  const ws = createWorkspace({ symbol: "SOLUSDT", interval: "1h" });
  ws.panes[0] = {
    ...ws.panes[0]!,
    compare: { symbol: "ETHUSDT", mode: "percent", length: 60 },
    chartSettings: { ...DEFAULT_CHART_SETTINGS, statusSymbol },
  };
  window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(ws));
}

test("B-17 — with Title off, the comparison chip is still on the chart", async () => {
  seed(false);
  await mountChart();
  await settle();
  assert.ok(screen.queryByRole("button", { name: /^Comparing with ETHUSDT/ }),
    "Title off took the comparison chip with it");
  assert.equal(screen.queryAllByRole("button", { name: /^Change symbol for the/ }).length, 0,
    "Title off must still hide the title itself");
});

test("B-17 — with Title on, both are there, as before", async () => {
  seed(true);
  await mountChart();
  await settle();
  assert.ok(screen.queryByRole("button", { name: /^Comparing with ETHUSDT/ }));
  assert.ok(screen.queryAllByRole("button", { name: /^Change symbol for the/ }).length > 0);
});
