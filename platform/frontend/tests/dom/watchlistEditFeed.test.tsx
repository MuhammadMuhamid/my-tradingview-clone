/**
 * Editing the watchlist must not make it report itself broken.
 *
 * ── TVP8 IO-A7, end to end ─────────────────────────────────────────────────
 *
 * The ticker poll's `.catch` had no abort check. Editing the list aborts the
 * controller while the fifteen-second poll is in flight; the rejection that
 * follows was painted as
 *
 *   some quotes unavailable — Ticker refresh failed: signal is aborted…
 *
 * on a list that had just been edited, and because `issues` is tested before
 * `stream.status` in the header, it also hid a feed that was working.
 *
 * The first end-to-end version of this test was DELETED: it mounted the
 * watchlist, stalled the ticker route, edited the list and read the header —
 * and had never made a ticker request, because the fixture answered
 * `/api/watchlists` with `[]` and had nothing to POST to, so the list was
 * empty, and an empty list does not poll. A vacuity guard caught it
 * (IO-A2-COV). The fixture now persists a watchlist and serves canonical
 * tickers, and this file asserts that the poll HAPPENED before asserting
 * anything about what the edit did to it.
 *
 * Run against the repair reverted (the abort check deleted from the poll's
 * `.catch`), this fails at the last assertion — see the commit.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, screen } from "@testing-library/react";
import { advance, closeBrowser, compactSeries, resetBrowser, server, settle } from "./harness/env";
import { mountChart } from "./harness/chart";
import { CANONICAL, idFor } from "./harness/market";

beforeEach(() => {
  resetBrowser();
  server.setCandles("SOLUSDT", "15m", compactSeries(300));
  // A returning user with two canonical rows. One is on a direct-stream venue,
  // because that is the only membership for which the per-instrument effect —
  // and its fifteen-second poll, where the defect lived — runs at all.
  server.seedWatchlist([CANONICAL.SOLUSDT!, idFor("COINBASE", "BTC", "USD")]);
});
after(closeBrowser);

const TICKERS = "/api/market/v1/tickers";

/** The watchlist header's feed status, as its screen-reader sentence. */
function feedStatus(): string {
  const statuses = screen.queryAllByRole("status")
    .map((el) => (el.textContent ?? "").trim())
    .filter((text) => text.includes("Prices "));
  assert.equal(statuses.length, 1, `expected one watchlist feed status, found ${statuses.length}`);
  return statuses[0]!;
}

test("ADDING A SYMBOL WHILE THE QUOTE POLL IS IN FLIGHT DOES NOT PAINT THE POLL'S ABORT AS A FAILURE", async () => {
  const chart = await mountChart();

  // The list holds two canonical ids and the seed read for them landed. This
  // is the vacuity guard the deleted test lacked.
  const seeds = server.callsTo(TICKERS).length;
  assert.equal(seeds >= 1, true, "the watchlist must have seeded its quotes from the canonical ticker route");
  assert.equal(feedStatus().includes("some quotes unavailable"), false,
    `before any edit the header must not report a failure; it says ${JSON.stringify(feedStatus())}`);

  // Stall the NEXT ticker read, then let the fifteen-second poll fire into it.
  const release = server.hold(TICKERS);
  await advance(15_000);
  assert.equal(server.callsTo(TICKERS).length > seeds, true,
    "the fifteen-second poll must have made a request — otherwise there is nothing in flight to abort");

  // Edit the list with a poll in flight. The tickers effect re-runs for the new
  // membership, and its cleanup aborts the held request. The hold stays on:
  // the re-run's own seed read is held too, so what the header shows now is
  // exactly what a person sees during that seed's round trip in a browser —
  // the window in which the aborted poll's rejection has already landed.
  const open = chart.container.querySelector<HTMLElement>('button[aria-label="Add a symbol to this list"]');
  assert.ok(open, "the watchlist offers no way to add a symbol");
  fireEvent.click(open);
  await settle();
  const box = screen.getByRole("textbox", { name: "Add a symbol to this watchlist" });
  fireEvent.change(box, { target: { value: "ETHUSDT" } });
  fireEvent.keyDown(box, { key: "Enter" });
  await settle();

  const rows = [...chart.container.querySelectorAll<HTMLElement>("button")]
    .map((b) => (b.textContent ?? "").trim());
  assert.equal(rows.some((text) => text.startsWith("ETH/USDT")), true,
    "the edit must have landed — ETH/USDT is now a row");
  assert.equal(server.callsTo(TICKERS).length > seeds + 1, true,
    "the edit must have started a new seed read for the new membership");

  assert.equal(feedStatus().includes("some quotes unavailable"), false,
    `the poll this edit superseded was aborted, which is not a failure; the header says ${JSON.stringify(feedStatus())}`);

  // And once the new seed lands, the list is simply current.
  release();
  await settle();
  assert.equal(feedStatus().includes("some quotes unavailable"), false,
    `after the new seed landed the header says ${JSON.stringify(feedStatus())}`);
});

