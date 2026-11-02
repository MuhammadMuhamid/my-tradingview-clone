/**
 * The Trade panel on an install where manual trading is off.
 *
 * `GET /api/manual-trading/state` answers `{ enabled: false, … }` at once, and
 * the chart's own Positions & Orders read hears it first and closes the
 * install-wide polling gate (`lib/manualTradingPolling`). The panel's refresh
 * honoured that gate on its FIRST read too, so it never asked: `state` stayed
 * null with no error, and the panel read "Loading manual trading…" for ever
 * (measured still there at 20s) over an answer the server had already given.
 * The first read always runs now, and the panel says what is true.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, screen } from "@testing-library/react";
import { closeBrowser, resetBrowser, server, settle } from "./harness/env";
import { mountChart } from "./harness/chart";
import { manualTradingPollingAllowed } from "@/lib/manualTradingPolling";
import { loadSession, resetSessionForTests } from "@/lib/session";

beforeEach(() => { resetBrowser(); resetSessionForTests(); });
after(closeBrowser);

test("with manual trading off, the Trade panel says so instead of loading for ever", async () => {
  await loadSession(); // the fixture's instance without accounts: the administrator's
  const chart = await mountChart();
  await settle(6);
  assert.equal(manualTradingPollingAllowed(), false,
    "setup: the chart's own read should have closed the polling gate before the panel opens");

  const trade = chart.container.querySelector<HTMLElement>('[data-toolbar-control="trade"]');
  assert.ok(trade, "setup: the Trade control is the administrator's and should be drawn");
  const before = server.callsTo("/api/manual-trading/state").length;
  fireEvent.click(trade);
  await settle(6);

  assert.equal(screen.queryByText("Loading manual trading…"), null, "the panel is still loading an answer it has");
  assert.ok(screen.getByText("Manual trading is switched off"), "the panel's own switched-off state");
  assert.ok(server.callsTo("/api/manual-trading/state").length > before, "the panel never asked");
});
