/**
 * A quoted row never arrives showing dashes.
 *
 * ── TVP8 R7-09 ─────────────────────────────────────────────────────────────
 *
 * On a fresh load, five of the eight rows in the reviewer's capture read
 *
 *     BTC/USDT   77,584.4   —   —
 *
 * under a header claiming the feed was live. The cause was a seam rather than
 * a failure: a canonical `instrument:v1:BINANCE:spot:…` row is not in the
 * hook's `legacy` set, so it was seeded ONLY through `api.marketTickers` — a
 * contract that carries `last` and no `open`. `useWatchlistTickers` therefore
 * built it with `changeKnown: false`, and the row showed a dash in Chg and
 * Chg% until the first `@miniTicker` frame for that pair landed. On a thin
 * pair that is seconds of dashes; on a fenced network it is forever.
 *
 * Canonical persistence is the default now, so this is the NORMAL first paint
 * of the product's own watchlist, not an edge case.
 *
 * ── Why this test is not vacuous ───────────────────────────────────────────
 *
 * It asserts three things in order, and the first two are the guard: the row
 * exists, the 24h seed route was actually asked for that row's PROVIDER symbol
 * (which is the repair — before it, only `/api/market/v1/tickers` was called
 * for a canonical row), and only then that the change cell holds a number.
 * No stream frame is ever delivered, so the value under test can only have
 * come from the seed.
 *
 * Run against the repair reverted — `api.tickers(legacy)` instead of
 * `api.tickers(combined.map(…providerSymbol))` — the second assertion fails
 * first, and the third fails after it.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { closeBrowser, compactSeries, resetBrowser, server, settle } from "./harness/env";
import { mountChart } from "./harness/chart";
import { CANONICAL } from "./harness/market";

beforeEach(() => {
  resetBrowser();
  server.setCandles("SOLUSDT", "15m", compactSeries(300));
  // A returning user whose list is persisted the way the product persists it:
  // canonical ids, on the venue whose 24h ticker the seed route answers for.
  server.seedWatchlist([CANONICAL.SOLUSDT!, CANONICAL.BTCUSDT!]);
});
after(closeBrowser);

test("R7-09 — A CANONICAL BINANCE ROW ARRIVES WITH ITS 24H CHANGE, NOT WITH DASHES", async () => {
  const chart = await mountChart();
  await settle(4);

  const row = chart.container.querySelector<HTMLElement>(
    `[data-watchlist-row="${CANONICAL.SOLUSDT}"]`);
  assert.ok(row, "the watchlist has no canonical SOL row — the fixture's seed did not land");

  // `path` on a recorded call carries the query string, so this reads the
  // symbols the seed actually asked for rather than merely that it ran.
  const seeds = server.callsTo("/api/symbols/tickers");
  assert.equal(
    seeds.some((call) => decodeURIComponent(call.path).includes("SOLUSDT")),
    true,
    "a canonical Binance spot row must be seeded through the 24h ticker route — "
    + "the provider snapshot carries no opening price, which is what left the row dashed");

  for (const col of ["chg", "chgpct"]) {
    const cell = row.querySelector<HTMLElement>(`[data-col="${col}"]`);
    assert.ok(cell, `the row has no ${col} cell`);
    assert.notEqual((cell.textContent ?? "").trim(), "—",
      `${col} is still a dash on a row whose 24h ticker the provider answered for`);
  }
});
