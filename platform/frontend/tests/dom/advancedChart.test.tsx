/**
 * Advanced-chart workflows at the rendered boundary.
 *
 * The arithmetic has exhaustive pure coverage. These checks cover the wires a
 * pure test cannot: choosing a profile tool from the rail, editing the
 * selected range's settings, applying/removing a pair study from a pane, and
 * opening a matrix cell to the statistics behind its colour.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { CorrelationPanel } from "@/components/tv/CorrelationPanel";
import { drawingStore } from "@/lib/drawingStore";
import { WORKSPACE_STORAGE_KEY } from "@/lib/workspace";
import {
  advance, closeBrowser, compactSeries, resetBrowser, server, settle,
} from "./harness/env";
import { drag, mountChart } from "./harness/chart";

const SYMBOL = "SOLUSDT";

beforeEach(() => {
  resetBrowser();
  server.setDefaultCandles(compactSeries(600));
});
after(closeBrowser);

test("a fixed-range profile is selected by gesture and keeps independent settings", async () => {
  server.setCandles(SYMBOL, "1m", compactSeries(10_000, { intervalMs: 60_000 }));
  const chart = await mountChart();

  fireEvent.click(screen.getByRole("button", { name: "More anchored tools" }));
  fireEvent.click(screen.getByRole("button", { name: /Fixed Range Volume Profile/ }));
  await drag(chart.plot, [280, 260], [720, 380]);

  const created = drawingStore.get(SYMBOL);
  assert.equal(created.length, 1, "one range gesture creates exactly one profile");
  assert.equal(created[0]!.tool, "vprange");
  assert.equal(created[0]!.points.length, 2);
  assert.ok(created[0]!.points[1]!.time > created[0]!.points[0]!.time,
    "the selected bar range comes from the chart's time scale");
  assert.match(
    chart.pane().querySelector<HTMLElement>("[data-volume-profile-basis]")?.textContent ?? "",
    /chart's own 15m bars/,
    "the immediate fallback visibly discloses its chart-bar estimate basis",
  );

  await advance(150);
  const refinedNotice = chart.pane().querySelector<HTMLElement>(
    '[data-volume-profile-basis="refined"]',
  );
  assert.match(refinedNotice?.textContent ?? "", /1m bars loaded for this range/,
    "the rendered profile names the finer source when refinement lands");

  fireEvent.change(screen.getByRole("combobox", { name: "Profile rows" }), {
    target: { value: "100" },
  });
  fireEvent.change(screen.getByRole("combobox", { name: "Value area percent" }), {
    target: { value: "80" },
  });
  fireEvent.click(screen.getByRole("button", {
    name: "Split each row into up and down volume",
  }));
  fireEvent.click(screen.getByRole("button", { name: "Hide the point-of-control line" }));
  await settle();

  assert.deepEqual(drawingStore.get(SYMBOL)[0]!.style.profile, {
    layout: "rows",
    rowSize: 100,
    valueAreaPercent: 80,
    allocation: "range",
    split: "upDown",
    side: "right",
    widthPercent: 30,
    showValueArea: true,
    showPoc: false,
  }, "changing one profile control must not reset any of its other settings");

  await advance(1_400);
  const stored = server.getDrawings(SYMBOL).drawings as typeof created;
  assert.deepEqual(stored[0]!.style.profile, drawingStore.get(SYMBOL)[0]!.style.profile,
    "the selected range and its settings reach durable drawing storage together");
});

test("a pane applies, persists and removes a z-scored pair spread", async () => {
  const chart = await mountChart();

  fireEvent.click(screen.getByRole("button", { name: "Compare with another instrument" }));
  const dialog = screen.getByRole("dialog");
  assert.equal(dialog.parentElement?.parentElement, document.body,
    "the modal is portaled outside the legend's pointer-disabled ancestor");
  fireEvent.change(screen.getByRole("combobox", { name: "Which comparison" }), {
    target: { value: "zspread" },
  });
  fireEvent.change(screen.getByRole("spinbutton", { name: "Rolling window in bars" }), {
    target: { value: "30" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Compare" }));
  await settle();

  assert.ok(screen.getByRole("button", {
    name: "Comparing with BTCUSDT. Change or remove.",
  }));
  assert.ok(server.callsTo("/candles").some((call) =>
    call.path.includes("/api/symbols/BTCUSDT/candles") && call.path.includes("interval=15m")),
  "the pair is loaded on the pane's timeframe through the candle-history path");

  const stored = JSON.parse(window.localStorage.getItem(WORKSPACE_STORAGE_KEY) ?? "null") as {
    panes?: { compare?: unknown }[];
  } | null;
  assert.deepEqual(stored?.panes?.[0]?.compare, {
    symbol: "BTCUSDT", mode: "zspread", length: 30,
  });

  fireEvent.click(screen.getByRole("button", {
    name: "Comparing with BTCUSDT. Change or remove.",
  }));
  fireEvent.click(screen.getByRole("button", { name: "Remove comparison" }));
  await settle();
  const removed = JSON.parse(window.localStorage.getItem(WORKSPACE_STORAGE_KEY) ?? "null") as {
    panes?: { compare?: unknown }[];
  } | null;
  assert.equal(removed?.panes?.[0]?.compare, undefined);
  assert.ok(screen.getByRole("button", { name: "Compare with another instrument" }));
  assert.ok(chart.container);
});

test("the pane Compare modal closes from its portaled backdrop", async () => {
  await mountChart();
  fireEvent.click(screen.getByRole("button", { name: "Compare with another instrument" }));
  const dialog = screen.getByRole("dialog");
  const modalRoot = dialog.parentElement as HTMLElement;
  const backdrop = modalRoot.firstElementChild as HTMLElement;
  fireEvent.click(backdrop);
  assert.equal(screen.queryByRole("dialog"), null);
});

test("percent comparison keeps candles on price and declares a dedicated percent pane", async () => {
  const chart = await mountChart();
  fireEvent.click(screen.getByRole("button", { name: "Compare with another instrument" }));
  fireEvent.click(screen.getByRole("button", { name: "Compare" }));
  await settle();
  assert.ok(screen.getByText("Percent change vs BTCUSDT"));
  assert.ok(screen.getAllByText("% from first shared bar").length >= 1);
  assert.ok(chart.pane().querySelectorAll(".tv-lightweight-charts").length >= 2,
    "the price chart and unit-safe percent pane both render real chart hosts");
});

test("choosing two charts closes layout and leaves pane two immediately operable", async () => {
  const chart = await mountChart();
  fireEvent.click(screen.getByRole("button", { name: /^Chart layout/ }));
  fireEvent.click(screen.getByRole("button", { name: /^2 charts/ }));
  await settle();
  assert.equal(screen.queryByRole("menu", { name: "Chart layout" }), null);
  const second = chart.pane(1);
  fireEvent.click(within(second).getByRole("button", {
    name: /Timeframe for this pane/,
  }));
  assert.ok(screen.getByRole("menu", { name: "Pane timeframe" }));
});

test("a correlation cell opens the covariance and observation evidence behind it", async () => {
  render(
    <CorrelationPanel
      symbols={["SOLUSDT", "BTCUSDT"]}
      interval="15m"
      bars={600}
      selected="SOLUSDT"
      onSelect={() => {}}
    />,
  );
  await settle();

  const pair = screen.getByRole("button", { name: /^SOLUSDT against BTCUSDT:/ });
  assert.match(pair.getAttribute("aria-label") ?? "", /1\.00$/,
    "the visible cell has a textual value and does not rely on colour alone");
  fireEvent.click(pair);

  assert.ok(screen.getByRole("heading", { name: "SOLUSDT against BTCUSDT" }));
  assert.ok(screen.getByText("Covariance"));
  assert.ok(screen.getByText("Bars used"));
  assert.match(screen.getByText(/Each pair uses the bars both instruments have/).textContent ?? "",
    /Missing bars are left out, never filled in/);
});

test("correlation clears old-interval values while the new interval is loading", async () => {
  const view = render(
    <CorrelationPanel
      symbols={["SOLUSDT", "BTCUSDT"]}
      interval="1h"
      bars={600}
      selected="SOLUSDT"
      onSelect={() => {}}
    />,
  );
  await settle();
  assert.ok(screen.getByRole("button", { name: /^SOLUSDT against BTCUSDT:/ }));

  const release = server.hold("/candles");
  view.rerender(
    <CorrelationPanel
      symbols={["SOLUSDT", "BTCUSDT"]}
      interval="15m"
      bars={600}
      selected="SOLUSDT"
      onSelect={() => {}}
    />,
  );
  await settle();
  assert.ok(screen.getByText("Log returns on 15m bars"));
  assert.equal(screen.queryByRole("button", { name: /^SOLUSDT against BTCUSDT:/ }), null,
    "the 1h value is never rendered under the 15m provenance label");
  assert.ok(screen.getByText(/Loading these instruments/));
  release();
  await settle();
  assert.ok(screen.getByRole("button", { name: /^SOLUSDT against BTCUSDT:/ }));
});
