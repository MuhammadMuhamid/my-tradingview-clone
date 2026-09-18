/*
 * A Volume Footprint chart draws every bar, and says which of them have tape.
 *
 * Phase 3D found the pane blank: cells on the two bars this session's tape
 * reached, and nothing at all on the other twenty-two — no body, no wick — so
 * the price scale, shared with the MA overlay, fitted the MA and the chart read
 * as broken. The cause was not a missing backfill. `/api/data/trades` serves
 * aggregate trades; what is bounded is how far a page reaches (measured on this
 * provider: 50,000 executions is about two hours of BTC, walking forward from
 * the window start), and the client asks for the last thirty minutes. No window
 * covers 24 daily bars, so the tape will always be partial and the chart has to
 * be truthful about it rather than silent.
 *
 * The rule the repair holds, and these tests hold it to:
 *
 *   - every bar is drawn, as the exchange's own OHLC;
 *   - a bid/ask cell appears only where a real execution did;
 *   - nothing is inferred for the bars in between;
 *   - the pane says how many bars have cells.
 *
 * The legend is the other half. It read `footprintBarsAsOhlc`, whose `open` is
 * the lowest traded LEVEL and whose `close` is a volume-weighted mean, under
 * the labels O/H/L/C — `open` equalled `low` on every bar, which is the tell.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, screen } from "@testing-library/react";
import { api, type MarketTrade } from "@/lib/api";
import { assertAbsent, closeBrowser, compactSeries, resetBrowser, server, settle } from "./harness/env";
import { mountChart } from "./harness/chart";
import { footprintCoveredTimes } from "@/lib/tradeChartTransforms";

const STEP = 15 * 60_000;
const BARS = 24;

let original: typeof api.marketTrades;
beforeEach(() => { resetBrowser(); original = api.marketTrades; });
after(() => { api.marketTrades = original; closeBrowser(); });

/** The bar times the fixture's candles occupy, newest last. */
function barTimes(): number[] {
  return compactSeries(BARS, { intervalMs: STEP }).map((bar) => bar[0]);
}

/** Tape that reaches only the newest `n` bars — the shape the provider gives. */
function tapeOverLastBars(n: number): MarketTrade[] {
  const times = barTimes().slice(-n);
  return times.flatMap((openTime, i) => [
    { id: i * 2 + 1, timestamp: openTime + 1_000, price: 100.01, quantity: 2, aggressor: "buy" as const },
    { id: i * 2 + 2, timestamp: openTime + 2_000, price: 100.02, quantity: 3, aggressor: "sell" as const },
  ]);
}

/** Drives the chart-style menu to Volume footprint, the way a person does. */
async function chooseVolumeFootprint(container: HTMLElement): Promise<void> {
  const caret = [...container.querySelectorAll<HTMLElement>("button")]
    .find((b) => b.getAttribute("aria-label") === "Chart style");
  assert.ok(caret, "the chart-style caret is missing");
  fireEvent.click(caret);
  await settle();
  const menu = document.querySelector<HTMLElement>('[role="menu"][aria-label="Chart style"]');
  assert.ok(menu, "the chart-style menu did not open");
  const row = [...menu.querySelectorAll<HTMLElement>('[role^="menuitem"]')]
    .find((el) => /volume footprint/i.test(el.textContent ?? ""));
  assert.ok(row, "the chart-style menu has no Volume footprint row");
  fireEvent.click(row);
  await settle();
}

test("the covered-times pass agrees with the bucketing footprintBars uses", () => {
  // The pane and the series both ask this rather than aggregating levels twice
  // more over 50,000 executions. It must bucket identically, and admit
  // identically — a zero-quantity print is not an execution.
  const t = (timestamp: number, quantity: number): MarketTrade =>
    ({ id: timestamp, timestamp, price: 100, quantity, aggressor: "buy" });
  const covered = footprintCoveredTimes(
    [t(0, 1), t(STEP - 1, 1), t(STEP, 1), t(2 * STEP, 0), t(3 * STEP, 5)], STEP,
  );
  assert.deepEqual([...covered].sort((a, b) => a - b), [0, STEP, 3 * STEP],
    "buckets must floor to the interval, and a zero-quantity print must not create one");
  assert.equal(footprintCoveredTimes([t(0, 1)], 0).size, 0, "a non-positive interval buckets nothing");
});

test("a footprint chart whose tape reaches two bars still draws the other twenty-two", async () => {
  server.setDefaultCandles(compactSeries(BARS, { intervalMs: STEP }));
  api.marketTrades = async () => tapeOverLastBars(2);
  const chart = await mountChart();
  await chooseVolumeFootprint(chart.container);

  // The pane must not be claiming the presentation is unavailable — it has
  // tape, and a tick, and every bar's OHLC.
  assertAbsent(screen.queryByText(/Volume footprint (unavailable|has no executions)/),
    "the chart refused a presentation it has the data to draw");

  // And it must say, in bars, how far the cells reach. Silence here is what
  // made the blank pane read as a bug rather than as a boundary.
  const chip = screen.getByText(/Footprint cells on \d+ of \d+ bars/);
  assert.equal(chip.getAttribute("data-footprint-coverage"), "2",
    `the pane miscounted the bars the tape covers: ${JSON.stringify(chip.textContent)}`);
  assert.match(chip.textContent ?? "", new RegExp(`of ${BARS} bars`),
    "the count must be against the bars on screen");

  // The disclosure must name what the other bars ARE, so a reader cannot take
  // a drawn bar as evidence of order flow.
  assert.match(chip.getAttribute("title") ?? "", /ordinary exchange\s+OHLC/,
    "the disclosure must say the uncovered bars are exchange OHLC");
  assert.match(chip.getAttribute("title") ?? "", /no order flow is inferred/,
    "the disclosure must say nothing is inferred for them");
});

test("full tape coverage says nothing, because there is nothing to disclose", async () => {
  server.setDefaultCandles(compactSeries(BARS, { intervalMs: STEP }));
  api.marketTrades = async () => tapeOverLastBars(BARS);
  const chart = await mountChart();
  await chooseVolumeFootprint(chart.container);

  assertAbsent(screen.queryByText(/Footprint cells on \d+ of \d+ bars/),
    "a chip that appears when every bar has cells stops carrying information");
});
