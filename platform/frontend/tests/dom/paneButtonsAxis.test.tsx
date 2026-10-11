/**
 * W2D-11: a study pane's own buttons end at the PLOT's right edge.
 *
 * The collapse / maximize cluster was `right-1` of the pane section, and the
 * section's chart spans the price axis, so the buttons sat on the scale and
 * hid its top tick (`80.00` on an RSI). The reference ends the cluster 4px
 * left of the axis. jsdom has no layout, but `lightweight-charts` runs for
 * real here and reports an axis width, so what is held is that the cluster's
 * offset IS that width plus 4 — whatever the width is.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { closeBrowser, render, resetBrowser, settle } from "./harness/env";
import { IndicatorPane } from "@/components/tv/IndicatorPane";
import type { IChartApi } from "lightweight-charts";

beforeEach(resetBrowser);
after(closeBrowser);

test("W2D-11 — the pane's buttons sit 4px left of the price axis, never over it", async () => {
  let chart: IChartApi | null = null;
  const base = 1_700_000_000;
  const view = render(
    <IndicatorPane
      id="rsi"
      title="RSI"
      params="Length 14"
      overlays={[{
        id: "rsi:0", title: "RSI", color: "#9b7cf5", paneId: "rsi", precision: 2,
        instanceId: "rsi", instanceTitle: "Relative Strength Index",
        data: Array.from({ length: 50 }, (_, i) => ({ time: base + i * 3600, value: 20 + i })),
      }]}
      decorations={[]}
      hoverTime={null}
      onHover={() => {}}
      onReady={(_id, api) => { if (api) chart = api; }}
      onRangeChange={() => {}}
      onToggleCollapsed={() => {}}
      onToggleMaximized={() => {}}
      canMaximize
    />);
  await settle(4);

  const cluster = view.container.querySelector<HTMLElement>("[data-pane-buttons]");
  assert.ok(cluster, "the pane has no button cluster");
  assert.ok(chart, "the pane never reported its chart");
  const axis = Math.round((chart as IChartApi).priceScale("right").width());
  assert.equal(cluster.style.right, `${axis + 4}px`,
    "the cluster is not anchored to the plot's right edge");
  assert.doesNotMatch(cluster.className, /\bright-1\b/, "the cluster is still offset from the section's edge");
});
