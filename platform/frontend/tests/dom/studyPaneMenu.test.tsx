/**
 * A study pane's own right-click menu.
 *
 * ── The finding (R8, high) ─────────────────────────────────────────────────
 *
 * Right-clicking an RSI or MACD pane — its plot, its price axis, or the time
 * axis under it — left `defaultPrevented` false, so CHROME's menu opened over
 * a trading chart: Back, Reload, Save as, Inspect. The price pane has carried
 * its own `onContextMenu` since TVP8 and the panes below it never got one, so
 * the product's `priceAxisMenu()` and `timeAxisMenu()` were unreachable for
 * any user with a study open — and since the time axis is drawn ONCE, under
 * the lowest pane, the time-scale menu was unreachable outright.
 *
 * The gesture is the test: a real right-click on a real study pane, asserting
 * that the product claimed the event and opened its own menu.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent } from "@testing-library/react";
import { closeBrowser, compactSeries, render, resetBrowser, server, settle } from "./harness/env";
import { mountChart, openMenu, plotOf } from "./harness/chart";
import { IndicatorPane } from "@/components/tv/IndicatorPane";

beforeEach(() => {
  resetBrowser();
  server.setDefaultCandles(compactSeries(600));
});
after(closeBrowser);

/** Apply an RSI, so the chart has a study pane under the price pane. */
async function withStudyPane(): Promise<HTMLElement> {
  const chart = await mountChart();
  /*
   * Through the product's own storage rather than through the browser dialog:
   * this test is about the pane's menu, and driving the indicator browser
   * would make it a test of the browser first.
   */
  window.localStorage.setItem("tv.nativeStudies.v1", JSON.stringify([{
    key: "rsi-1", defId: "rsi", params: { length: 14, source: "close" },
    visible: true, styles: {},
  }]));
  const again = await mountChart();
  await settle();
  const panes = again.container.querySelectorAll<HTMLElement>("[aria-label$='indicator pane']");
  assert.ok(panes.length > 0, "the workspace mounted no study pane to right-click on");
  void chart;
  return plotOf(panes[0]!);
}

test("R8 — right-clicking a study pane opens the PRODUCT's menu, not Chrome's", async () => {
  const plot = await withStudyPane();

  const event = new window.MouseEvent("contextmenu", {
    bubbles: true, cancelable: true, clientX: 240, clientY: 620, button: 2,
  });
  fireEvent(plot, event);
  await settle();

  /*
   * The finding itself: an unclaimed `contextmenu` IS Chrome's menu — Back,
   * Reload, Save as, Inspect — drawn over a trading chart. Every study pane
   * left it unclaimed.
   */
  assert.equal(event.defaultPrevented, true,
    "an unclaimed contextmenu is Chrome's menu over a trading chart");
  /*
   * And the payload reaches the one resolver the price pane's does, so the
   * product draws its own menu. WHICH rows that menu carries is
   * `tests/dom/contextMenu.test.tsx`'s subject, not this one's.
   */
  assert.ok(openMenu(), "the product opened no menu of its own");
});

test("R8 — the pane reports the region it was clicked in, as the price pane does", async () => {
  /*
   * The component's own half of the wire, driven directly: three regions, the
   * same payload shape `openChartMenu` already takes. The workspace test above
   * proves the event is claimed; this proves what is handed over, without
   * depending on which rows any one menu happens to carry today.
   */
  const seen: { region: string }[] = [];
  const view = render(
    <IndicatorPane
      id="rsi"
      title="RSI"
      params="Length 14"
      overlays={[]}
      decorations={[]}
      hoverTime={null}
      onHover={() => {}}
      onReady={() => {}}
      onRangeChange={() => {}}
      onContextMenu={(event) => seen.push({ region: event.region })}
    />);
  await settle();
  const host = view.container.querySelector<HTMLElement>(".tv-lightweight-charts");
  assert.ok(host, "the pane has no chart host");

  const event = new window.MouseEvent("contextmenu", {
    bubbles: true, cancelable: true, clientX: 200, clientY: 60, button: 2,
  });
  fireEvent(host, event);
  await settle();
  assert.equal(event.defaultPrevented, true);
  assert.equal(seen.length, 1, "the pane handed nothing to its owner");
  assert.ok(["plot", "axis", "time"].includes(seen[0]!.region),
    `the pane reported an unknown region: ${seen[0]!.region}`);
});
