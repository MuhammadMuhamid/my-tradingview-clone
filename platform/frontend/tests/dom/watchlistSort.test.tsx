/**
 * One sorted column, one indicator — and no standing lecture about dragging.
 *
 * ── TVP8 R7b-07 ────────────────────────────────────────────────────────────
 *
 * `columns[]` gave both `Chg` and `Chg%` the sort key `"change"`, so clicking
 * either marked BOTH with an arrow and gave both the accessible name "Sorted
 * by …, descending". A table cannot have two sorted columns, and a screen
 * reader was being told it did.
 *
 * The second half of the finding was a 44px paragraph — "Clear the sort to
 * rearrange this list — dragging while sorted would move a row you cannot see
 * move." — painted permanently for as long as ANY sort was active, which
 * pushed the section band from y=117 to y=161 and spent a seventh of a 300px
 * column explaining a gesture the reader had not made. The rule is still the
 * rule; it is now the answer to a refused drop rather than a standing notice.
 *
 * Run against the repair reverted, the first test finds two `Sorted by` rows
 * and the second finds the paragraph.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent } from "@testing-library/react";
import { closeBrowser, compactSeries, resetBrowser, server, settle } from "./harness/env";
import { mountChart } from "./harness/chart";
import { CANONICAL } from "./harness/market";

beforeEach(() => {
  resetBrowser();
  server.setCandles("SOLUSDT", "15m", compactSeries(300));
  server.seedWatchlist([CANONICAL.SOLUSDT!, CANONICAL.BTCUSDT!, CANONICAL.ETHUSDT!]);
});
after(closeBrowser);

function header(container: HTMLElement, name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>("[data-watchlist] button")]
    .find((b) => (b.getAttribute("aria-label") ?? "").startsWith(name));
  if (!found) {
    throw new Error(`the watchlist has no column header named ${JSON.stringify(name)}; it has `
      + [...container.querySelectorAll<HTMLButtonElement>("[data-watchlist] button")]
        .map((b) => b.getAttribute("aria-label")).filter((l) => l?.includes("Sort")).join(" · "));
  }
  return found;
}

const sortedHeaders = (container: HTMLElement): string[] =>
  [...container.querySelectorAll<HTMLButtonElement>("[data-watchlist] button")]
    .map((b) => b.getAttribute("aria-label") ?? "")
    .filter((label) => label.startsWith("Sorted by"));

test("R7b-07 — clicking Chg% marks Chg% and nothing else", async () => {
  const chart = await mountChart();
  await settle(4);
  assert.deepEqual(sortedHeaders(chart.container), [],
    "the list opens in the user's own order, which is not a sorted column");

  fireEvent.click(header(chart.container, "Sort by Chg%"));
  await settle();

  const sorted = sortedHeaders(chart.container);
  assert.equal(sorted.length, 1,
    `a table can have one sorted column; this one reports ${sorted.length}: ${sorted.join(" · ")}`);
  assert.match(sorted[0]!, /^Sorted by Chg%, descending/);
});

test("R7b-07 — and clicking Chg marks Chg, which is a different sort", async () => {
  const chart = await mountChart();
  await settle(4);

  fireEvent.click(header(chart.container, "Sort by Chg"));
  await settle();

  const sorted = sortedHeaders(chart.container);
  assert.equal(sorted.length, 1, `${sorted.length} columns report themselves sorted`);
  assert.match(sorted[0]!, /^Sorted by Chg, descending/,
    "`Chg` sorts by the absolute move; it used to pass `Chg%`'s own key");
});

test("R7b-07 — sorting does not paint a permanent paragraph about dragging", async () => {
  const chart = await mountChart();
  await settle(4);

  fireEvent.click(header(chart.container, "Sort by Chg%"));
  await settle();

  const panel = chart.container.querySelector<HTMLElement>("[data-watchlist]");
  assert.ok(panel, "the watchlist is not open");
  assert.equal((panel.textContent ?? "").includes("Clear the sort"), false,
    "44px of a 300px column spent explaining a gesture the reader has not made");
});
