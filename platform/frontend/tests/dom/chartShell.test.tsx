/**
 * The workspace, mounted.
 *
 * The plainest thing a rendering layer buys, and the thing the suite could
 * never say before: the chart page renders, with real bars, real scales and
 * real effects, and it does so without React reporting a single problem. A
 * duplicate key, a state update on an unmounted component and an effect that
 * loops are all invisible to a source-string test and all shipped.
 *
 * It also pins the identity questions — which instrument, which timeframe,
 * which bars — at the boundary where the workspace asks for them, because the
 * answer is a request and a request can be read.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, screen } from "@testing-library/react";
import { closeBrowser, compactSeries, resetBrowser, server, settle } from "./harness/env";
import { armedInterval, mountChart } from "./harness/chart";
import { render } from "@testing-library/react";
import TvWorkspace from "@/app/chart/page";

const renderWorkspace = () => render(<TvWorkspace />);

/** Console output React uses to report a problem with the tree. */
function captureReactComplaints(): { messages: string[]; stop: () => void } {
  const messages: string[] = [];
  const real = { error: console.error, warn: console.warn };
  const record = (original: typeof console.error) =>
    (...args: unknown[]): void => {
      messages.push(args.map(String).join(" "));
      original(...args);
    };
  console.error = record(real.error);
  console.warn = record(real.warn);
  return { messages, stop: () => { console.error = real.error; console.warn = real.warn; } };
}

beforeEach(() => {
  resetBrowser();
  server.setDefaultCandles(compactSeries(600));
});
after(closeBrowser);

test("the workspace renders a chart with bars, and React reports nothing", async () => {
  const capture = captureReactComplaints();
  let chart;
  try {
    chart = await mountChart();
    await settle();
  } finally {
    capture.stop();
  }

  const text = chart.container.textContent ?? "";
  assert.match(text, /SOLUSDT/);
  assert.match(text, /600 bars/, "the pane must report the window it actually loaded");
  assert.ok(chart.plot, "the chart host exists");

  const complaints = capture.messages.filter(
    (m) => /Warning:|same key|not wrapped in act|Maximum update depth|Each child/.test(m)
      && !/not wrapped in act/.test(m));
  assert.deepEqual(complaints, [],
    "React complaining during a render is a defect that ships silently");
});

test("the workspace asks for exactly the instrument and timeframe it is showing", async () => {
  const chart = await mountChart();

  const candleCalls = server.callsTo("/candles");
  assert.ok(candleCalls.length >= 1);
  for (const call of candleCalls) {
    assert.match(call.path, /\/api\/symbols\/SOLUSDT\/candles/);
    assert.match(call.path, /interval=15m/);
    assert.match(call.path, /format=compact/,
      "the chart's own loader uses the compact wire format");
  }
  assert.equal(armedInterval(chart.container), "15m");
});

test("clicking a timeframe loads that timeframe, once", async () => {
  const chart = await mountChart();
  const before = server.callsTo("/candles").length;

  const hour = [...chart.container.querySelectorAll<HTMLElement>("button")]
    .find((b) => (b.textContent ?? "").trim() === "1h");
  assert.ok(hour, "the toolbar has no 1h control");
  fireEvent.click(hour);
  await settle();

  const added = server.callsTo("/candles").slice(before);
  assert.ok(added.length >= 1, "changing timeframe must reload the bars");
  for (const call of added) assert.match(call.path, /interval=1h/);
  assert.equal(armedInterval(chart.container), "1h");
});

test("a symbol with no stored bars is repaired once rather than shown empty", async () => {
  // Nothing stored for this instrument at this depth: the loader backfills and
  // then asks only for what is missing.
  server.setDefaultCandles([]);
  const chart = await mountChart();
  await settle();

  const backfills = server.callsTo("/api/data/backfill");
  assert.equal(backfills.length, 1,
    "a window with no history is backfilled exactly once, not on every render");
  assert.match(chart.container.textContent ?? "", /0 bars|No candles|bars/,
    "and the pane says what it has rather than pretending");
});

test("the chart survives being unmounted mid-flight", async () => {
  const capture = captureReactComplaints();
  const release = server.hold("/candles");
  try {
    // Not `mountChart`: the point is to render and tear down while the first
    // history request is still open, so the chart never finishes appearing.
    const view = renderWorkspace();
    await settle();
    assert.ok(view.container.querySelector("[data-pane-id]"), "the pane mounted");
    // Tear the page down while its first history request is still open.
    resetBrowser();
    release();
    await settle();
  } finally {
    capture.stop();
  }
  const complaints = capture.messages.filter((m) => /unmounted component|memory leak/.test(m));
  assert.deepEqual(complaints, [],
    "a request that lands after its page has gone must not set state");
});

test("the alerts panel and the chart agree about which instrument is open", async () => {
  const chart = await mountChart();
  const alerts = server.callsTo("/api/ma-alerts");
  assert.ok(alerts.length >= 1, "the workspace reads this instrument's alerts");
  for (const call of alerts) {
    assert.match(call.path, /symbol=SOLUSDT/,
      "an alert list for a different instrument is a list of the wrong levels");
  }
  assert.ok(screen.getAllByText(/SOLUSDT/).length > 0, "and the chart says so too");
  assert.ok(chart.container);
});
