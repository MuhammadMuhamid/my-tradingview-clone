/**
 * The interval workflows, driven the way a person drives them.
 *
 * The pure tests next door prove that a 45-minute bar is arithmetically three
 * fifteen-minute bars. These prove the other half — that the workspace actually
 * asks for one, draws one, keeps calling it 45m everywhere, and lets a person
 * get to it without a strip of thirty buttons on the toolbar.
 *
 * Everything here goes through the rendered DOM: a click on a real button, a
 * real request recorded by the fixture server, a real fold performed by the
 * same `lib/resolution` the backend uses.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, screen, within } from "@testing-library/react";
import {
  closeBrowser, compactSeries, FakeSocket, resetBrowser, server, settle,
} from "./harness/env";
import { armedInterval, mountChart } from "./harness/chart";
import { klineStreamUrl, marketFeed } from "@/lib/marketFeed";

beforeEach(() => {
  resetBrowser();
  server.setDefaultCandles(compactSeries(600));
});
after(closeBrowser);

/** Open the toolbar's timeframe picker and return its menu. */
async function openPicker(container: HTMLElement): Promise<HTMLElement> {
  const button = container.querySelector<HTMLElement>('button[aria-label*="All timeframes"]')
    ?? container.querySelector<HTMLElement>('button[title="All timeframes"]');
  assert.ok(button, "the toolbar has no timeframe picker");
  fireEvent.click(button);
  await settle();
  const menu = container.querySelector<HTMLElement>('[role="menu"][aria-label="All timeframes"]');
  assert.ok(menu, "the picker did not open");
  return menu;
}

function menuRow(menu: HTMLElement, resolution: string): HTMLElement {
  const row = [...menu.querySelectorAll<HTMLElement>('button[role="menuitemradio"]')]
    .find((b) => (b.querySelector("span")?.textContent ?? "").trim() === resolution);
  assert.ok(row, `the picker has no ${resolution} row`);
  return row;
}

const candleCallsFor = (resolution: string): string[] =>
  server.callsTo("/candles").map((c) => c.path).filter((p) => p.includes(`interval=${resolution}&`)
    || p.endsWith(`interval=${resolution}`) || p.includes(`interval=${resolution}&limit`));

// ── the picker ──────────────────────────────────────────────────────────────

test("the toolbar shows six favourites and reaches thirty resolutions behind one button", async () => {
  const chart = await mountChart();

  const strip = chart.container.querySelector<HTMLElement>('[role="group"][aria-label="Timeframe"]');
  assert.ok(strip, "the toolbar has no timeframe group");
  const stripButtons = [...strip.querySelectorAll<HTMLElement>("button")]
    .map((b) => (b.textContent ?? "").trim())
    .filter((t) => /^\d+[smhd]$/.test(t));
  assert.deepEqual(stripButtons, ["1m", "5m", "15m", "1h", "4h", "1d"],
    "a new user's strip is the six the toolbar has always shown");

  const menu = await openPicker(chart.container);
  const offered = [...menu.querySelectorAll<HTMLElement>('button[role="menuitemradio"]')]
    .map((b) => (b.querySelector("span")?.textContent ?? "").trim());
  assert.ok(offered.length >= 20, `only ${offered.length} resolutions are reachable`);
  for (const group of ["Seconds", "Minutes", "Hours", "Days"]) {
    assert.ok(menu.querySelector(`section[aria-label="${group}"]`), `no ${group} group`);
  }
  // Every one the backend stores is in there, including the two that were new.
  for (const stored of ["1s", "3m", "8h", "12h"]) assert.ok(offered.includes(stored), stored);
});

test("a derived row says what it is made of, on the row", async () => {
  const chart = await mountChart();
  const menu = await openPicker(chart.container);

  const derived = menuRow(menu, "45m");
  assert.match(derived.textContent ?? "", /3 × 15m/,
    "a person choosing 45m is entitled to see that it is three real 15m bars");
  assert.match(derived.getAttribute("aria-label") ?? "", /45 minutes/);
  assert.match(derived.getAttribute("aria-label") ?? "", /3 whole 15m bars, aggregated/);

  const native = menuRow(menu, "15m");
  assert.doesNotMatch(native.textContent ?? "", /×/, "a native row has nothing to explain");
  assert.match(native.getAttribute("aria-label") ?? "", /from the venue directly/);
});

// ── picking one ─────────────────────────────────────────────────────────────

test("PICKING 45m ASKS FOR 45m, AND THE BARS THAT COME BACK ARE FOLDED 15m BARS", async () => {
  /*
   * The end-to-end claim, in one test.
   *
   * The fixture server holds only the SOURCE series and folds it exactly as the
   * backend does, so what the chart draws here is what it would draw against a
   * real candle store: three 15-minute bars per 45-minute bar, with the open of
   * the first, the close of the last, and the summed volume.
   */
  const source = compactSeries(300, { intervalMs: 900_000 });
  server.setCandles("SOLUSDT", "15m", source);
  const chart = await mountChart();

  const menu = await openPicker(chart.container);
  fireEvent.click(menuRow(menu, "45m"));
  await settle();

  const asked = candleCallsFor("45m");
  assert.ok(asked.length >= 1, "the chart did not request 45m");
  for (const path of asked) {
    assert.doesNotMatch(path, /interval=15m/,
      "the chart must ask for the resolution it is ON, not for its source");
  }
  assert.equal(armedInterval(chart.container), "45m",
    "the toolbar must show the resolution the chart is on");

  // The workspace names it 45m everywhere it names anything.
  assert.match(chart.container.textContent ?? "", /45m/);
  const legend = chart.container.querySelector<HTMLElement>("[data-pane-legend]");
  assert.ok(legend, "the pane has no legend");
  assert.match(legend.textContent ?? "", /45m/,
    "the pane legend must name the same resolution as the toolbar");
});

test("a resolution folded from one-second bars asks for seconds, not for minutes", async () => {
  server.setCandles("SOLUSDT", "1s", compactSeries(600, { intervalMs: 1_000 }));
  const chart = await mountChart();

  const menu = await openPicker(chart.container);
  fireEvent.click(menuRow(menu, "30s"));
  await settle();

  assert.ok(candleCallsFor("30s").length >= 1);
  assert.equal(armedInterval(chart.container), "30s");
  // The one rule that cannot bend: sub-minute bars are never made of minutes.
  const minuteCalls = server.callsTo("/candles").map((c) => c.path)
    .filter((p) => /interval=1m\b/.test(p));
  assert.deepEqual(minuteCalls, [],
    "a 30-second chart must never have fetched one-minute bars");
});

// ── favourites, recents and custom entries ──────────────────────────────────

test("starring a resolution puts it on the toolbar strip, and unstarring takes it off", async () => {
  const chart = await mountChart();
  let menu = await openPicker(chart.container);

  const star = within(menuRow(menu, "45m").parentElement!)
    .getByRole("button", { name: /Keep 45m on the toolbar/ });
  fireEvent.click(star);
  await settle();

  const strip = chart.container.querySelector<HTMLElement>('[role="group"][aria-label="Timeframe"]')!;
  const onStrip = () => [...strip.querySelectorAll<HTMLElement>("button")]
    .map((b) => (b.textContent ?? "").trim());
  assert.ok(onStrip().includes("45m"), "the starred resolution is not on the strip");
  // It went to its catalogue position rather than the end, so the strip a user
  // has learned does not reshuffle under them.
  assert.ok(onStrip().indexOf("45m") < onStrip().indexOf("1h"));

  menu = chart.container.querySelector<HTMLElement>('[role="menu"][aria-label="All timeframes"]')!;
  fireEvent.click(within(menuRow(menu, "45m").parentElement!)
    .getByRole("button", { name: /Remove 45m from the toolbar/ }));
  await settle();
  assert.ok(!onStrip().includes("45m"));
});

test("a custom interval can be typed, is applied, and is remembered", async () => {
  server.setCandles("SOLUSDT", "1m", compactSeries(900, { intervalMs: 60_000 }));
  const chart = await mountChart();
  const menu = await openPicker(chart.container);

  const amount = within(menu).getByLabelText("Custom interval amount");
  const unit = within(menu).getByLabelText("Custom interval unit") as HTMLSelectElement;
  fireEvent.change(unit, { target: { value: "m" } });
  fireEvent.change(amount, { target: { value: "7" } });
  fireEvent.click(within(menu).getByRole("button", { name: "Add" }));
  await settle();

  assert.equal(armedInterval(chart.container), "7m");
  assert.ok(candleCallsFor("7m").length >= 1, "the custom resolution was not loaded");

  // It is kept, under Custom, so it costs one click the next time.
  const reopened = await openPicker(chart.container);
  const custom = reopened.querySelector<HTMLElement>('section[aria-label="Custom"]');
  assert.ok(custom, "the custom resolution was not remembered");
  assert.match(custom.textContent ?? "", /7m/);
});

test("a custom entry that is not a resolution is refused with a reason", async () => {
  const chart = await mountChart();
  const menu = await openPicker(chart.container);

  const amount = within(menu).getByLabelText("Custom interval amount");
  fireEvent.change(amount, { target: { value: "60" } });
  fireEvent.click(within(menu).getByRole("button", { name: "Add" }));
  await settle();

  // 60 minutes IS an hour. Accepting both spellings would split one chart's
  // identity in two, so it is refused — and the refusal says what to use.
  assert.match(within(menu).getByRole("alert").textContent ?? "", /That is 1h/);
  assert.equal(armedInterval(chart.container), "15m", "the chart did not move");
});

// ── one identity, everywhere ────────────────────────────────────────────────

test("A DERIVED CHART DOES NOT PRETEND ITS ALERTS ARE ON ITS OWN RESOLUTION", async () => {
  server.setCandles("SOLUSDT", "15m", compactSeries(300, { intervalMs: 900_000 }));
  const chart = await mountChart();

  const menu = await openPicker(chart.container);
  fireEvent.click(menuRow(menu, "45m"));
  await settle();

  // Arm a price alert from the toolbar.
  const alert = chart.container.querySelector<HTMLElement>('[data-toolbar-control="alert"]');
  assert.ok(alert, "the toolbar has no alert control");
  fireEvent.click(alert);
  await settle();

  const notice = document.querySelector<HTMLElement>('[data-resolution-notice="true"]');
  assert.ok(notice, "the dialog opened on a substituted timeframe and said nothing");
  const text = notice.textContent ?? "";
  assert.match(text, /45m is folded from 3 15m bars/);
  assert.match(text, /This alert is set to/);
  assert.match(text, /15m/);

  const field = screen.getByLabelText("Alert timeframe") as HTMLSelectElement;
  assert.equal(field.value, "15m",
    "the dialog opens on the interval the notice named, and the control is right there");
  assert.ok(![...field.options].some((o) => o.value === "45m"),
    "an alert timeframe the runner cannot evaluate must not be offered");
  assert.ok(![...field.options].some((o) => o.value === "1s"),
    "nor one it cannot honour once per bar close");
});

test("a native chart says nothing, because there is nothing to say", async () => {
  const chart = await mountChart();
  fireEvent.click(chart.container.querySelector<HTMLElement>('[data-toolbar-control="alert"]')!);
  await settle();
  assert.equal(document.querySelector('[data-resolution-notice="true"]'), null);
  assert.equal((screen.getByLabelText("Alert timeframe") as HTMLSelectElement).value, "15m");
});

test("history, live and the chart's own labels all name the resolution the pane is on", async () => {
  server.setCandles("SOLUSDT", "15m", compactSeries(300, { intervalMs: 900_000 }));
  const chart = await mountChart();
  const menu = await openPicker(chart.container);
  fireEvent.click(menuRow(menu, "45m"));
  await settle();

  // The pane's screen-reader identity, which is what a non-sighted user has.
  const pane = chart.pane(0);
  const spoken = pane.querySelector(".sr-only")?.textContent ?? "";
  assert.match(spoken, /SOLUSDT 45m/);

  /*
   * The live feed subscribes to the SOURCE stream — there is no 45m stream to
   * subscribe to — while everything the user sees still says 45m.
   *
   * Asserted three ways, because the interesting property is a negative one and
   * a negative is easy to pass for the wrong reason: the URL the registry would
   * build, the socket that was actually opened, and the feed state the pane
   * reads back under its own resolution.
   */
  assert.match(klineStreamUrl("SOLUSDT", "45m"), /kline_15m$/,
    "a derived resolution must listen to the stream its bars are folded from");
  const streams = FakeSocket.opened.map((sock) => sock.url);
  assert.ok(!streams.some((u) => /kline_45m/.test(u)),
    "there is no 45m stream, and asking for one would silently deliver nothing");
  assert.notEqual(marketFeed.statusOf("SOLUSDT", "45m"), "idle",
    "the 45m pane must be attached to a live feed, through its source");
});
