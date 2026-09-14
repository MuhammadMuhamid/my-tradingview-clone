/**
 * Removing a row the way the reference removes one.
 *
 * ── TVP8 R7b-09 ────────────────────────────────────────────────────────────
 *
 * Hovering a row on the reference reveals a 16px remove control over its right
 * end, and Delete on a focused row does the same thing. Ours revealed a fill
 * and nothing else (`extraControls: 1` in the reviewer's measurement), and
 * Delete on a focused row did nothing at all — eight rows before, eight rows
 * after. The only way out of a list was a right-click.
 *
 * The row's `title` was the other half of the finding: it read
 *
 *     BINANCE:BTC/USDT · SPOT · BINANCE
 *
 * a qualified storage identity, with the venue in it twice, on the surface the
 * contract says never shows one. The reference's tooltip says what the
 * instrument IS, where it trades, whether the number is live and whether the
 * market is open.
 *
 * Run against the repair reverted, the first assertion of each test fails —
 * there is no control named `Remove … from this list`, and the `title` starts
 * with a qualified identity rather than a name.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, screen } from "@testing-library/react";
import { closeBrowser, compactSeries, resetBrowser, server, settle } from "./harness/env";
import { mountChart } from "./harness/chart";
import { CANONICAL } from "./harness/market";

beforeEach(() => {
  resetBrowser();
  server.setCandles("SOLUSDT", "15m", compactSeries(300));
  server.seedWatchlist([CANONICAL.SOLUSDT!, CANONICAL.BTCUSDT!, CANONICAL.ETHUSDT!]);
});
after(closeBrowser);

const rowFor = (container: HTMLElement, symbol: string): HTMLElement => {
  const row = container.querySelector<HTMLElement>(`[data-watchlist-row="${symbol}"]`);
  if (!row) throw new Error(`the watchlist has no row for ${symbol}`);
  return row;
};

test("R7b-09 — every row carries a named remove control, and it removes the row", async () => {
  const chart = await mountChart();
  await settle();

  const eth = rowFor(chart.container, CANONICAL.ETHUSDT!);
  const remove = within_(eth, "Remove ETHUSDT from this list");
  fireEvent.click(remove);
  await settle(4);

  assert.equal(chart.container.querySelector(`[data-watchlist-row="${CANONICAL.ETHUSDT}"]`) === null,
    true, "clicking the remove control left the row where it was");

  const writes = server.calls.filter((c) => c.method === "PATCH" && c.path.includes("/api/watchlists/"));
  assert.ok(writes.length >= 1, "the removal was never persisted");
  const body = writes[writes.length - 1]!.body as { symbols: string[] };
  assert.equal(body.symbols.includes(CANONICAL.ETHUSDT!), false,
    "the row went from the view and stayed in the stored list");
  assert.deepEqual(body.symbols, [CANONICAL.SOLUSDT, CANONICAL.BTCUSDT],
    "removing one row must not disturb the others' order");
});

test("R7b-09 — Delete on a focused row removes it too", async () => {
  const chart = await mountChart();
  await settle();

  const eth = rowFor(chart.container, CANONICAL.ETHUSDT!);
  const open = eth.querySelector<HTMLButtonElement>("button");
  assert.ok(open, "the row has no focusable control");
  open.focus();
  fireEvent.keyDown(eth, { key: "Delete", bubbles: true });
  await settle(4);

  assert.equal(chart.container.querySelector(`[data-watchlist-row="${CANONICAL.ETHUSDT}"]`) === null,
    true, "Delete on a focused row did nothing — eight rows before, eight rows after");
});

test("R7b-09 — the row's tooltip is a NAME, a venue and a freshness, not a storage key", async () => {
  const chart = await mountChart();
  await settle();

  const title = rowFor(chart.container, CANONICAL.ETHUSDT!)
    .querySelector("button")?.getAttribute("title") ?? "";
  assert.match(title, /^Ethereum \/ TetherUS · BINANCE/,
    `the row's tooltip is ${JSON.stringify(title)}`);
  assert.doesNotMatch(title, /instrument:v1|BINANCE:.*BINANCE/,
    "a qualified identity, and the venue twice, is what this line used to say");
});

test("R7b-09 — and the panel still reports exactly one feed status", async () => {
  /*
   * The guard `watchlistEditFeed` asks for: a second `role="status"` in the
   * header would make that file's `feedStatus()` throw, and a remove control
   * per row is exactly the sort of addition that grows one by accident.
   */
  await mountChart();
  await settle();
  const statuses = screen.queryAllByRole("status")
    .map((el) => (el.textContent ?? "").trim())
    .filter((text) => text.includes("Prices "));
  assert.equal(statuses.length, 1, `expected one watchlist feed status, found ${statuses.length}`);
});

/** A control inside one row, by its accessible name. */
function within_(row: HTMLElement, name: string): HTMLButtonElement {
  const found = [...row.querySelectorAll<HTMLButtonElement>("button")]
    .find((b) => b.getAttribute("aria-label") === name);
  if (!found) {
    throw new Error(`the row offers no control named ${JSON.stringify(name)}; it has `
      + `${[...row.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") ?? "(unnamed)").join(", ")}`);
  }
  return found;
}
