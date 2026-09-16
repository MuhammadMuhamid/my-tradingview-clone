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
import { fireEvent } from "@testing-library/react";
import { resetInstrumentStatsCache } from "@/lib/useInstrumentStats";

/**
 * Select a row, the way a person does.
 *
 * The chart mounts on the legacy `SOLUSDT` and the list persists canonical
 * ids, so the details block has no selected row until one is clicked. That is
 * the product's own behaviour and not this file's subject; clicking is simply
 * how a details block comes to exist.
 */
async function selectRow(container: HTMLElement, symbol: string): Promise<HTMLElement> {
  const button = container.querySelector<HTMLElement>(`[data-watchlist-row="${symbol}"] button`);
  if (!button) throw new Error(`the watchlist has no row for ${symbol}`);
  fireEvent.click(button);
  await settle(8);
  const details = container.querySelector<HTMLElement>("[data-watchlist-details]");
  if (!details) throw new Error("selecting a row rendered no details block");
  return details;
}

const DAY = 86_400_000;

beforeEach(() => {
  resetBrowser();
  // The daily-bar cache in `lib/useInstrumentStats` is a module singleton and
  // `node --test` gives each FILE a process, not each test.
  resetInstrumentStatsCache();
  server.setCandles("SOLUSDT", "15m", compactSeries(300));
  /*
   * R7b-11: 400 closed daily bars for the selected row, which is what the
   * 30-day average and the six performance tiles are computed from. The
   * backend has served `interval=1d` the whole time; the fixture had simply
   * never been asked for it.
   */
  for (const symbol of ["SOLUSDT", "BTCUSDT"]) {
    server.setCandles(symbol, "1d", compactSeries(400, { intervalMs: DAY, base: 100 }));
  }
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

/**
 * ── TVP8 R7b-04: two precisions for one instrument, in one row ─────────────
 *
 * `Watchlist.tsx` formatted every number with a magnitude heuristic that read
 * the value it was handed and dropped trailing zeros, so `Last` and `Chg` in
 * the same row were shown to different precisions (`XRP 1.387 / 0.0367`), a
 * row's width moved between ticks (`DOGE 0.08421` ↔ `0.0842`), and the figure
 * disagreed with the chart axis on the same screen.
 *
 * The decimals are a property of the INSTRUMENT — its price tick — which is
 * what this asserts: the two cells agree with each other, and neither drops a
 * digit the tick says exists.
 */
test("R7b-04 — LAST AND CHG ARE PRINTED TO THE INSTRUMENT'S OWN PRECISION", async () => {
  const chart = await mountChart();
  await settle(4);

  const row = chart.container.querySelector<HTMLElement>(
    `[data-watchlist-row="${CANONICAL.BTCUSDT}"]`);
  assert.ok(row, "the watchlist has no canonical BTC row");
  const cell = (col: string): string =>
    (row.querySelector<HTMLElement>(`[data-col="${col}"]`)?.textContent ?? "").trim();

  /*
   * The fixture prices BTC at 77,000 and derives a 0.1 tick from it
   * (`tests/dom/harness/market.ts`), so one decimal is this instrument's
   * precision here. What matters is not the number 1 — it is that BOTH cells
   * use it, which is the defect: the old formatter gave `Chg` the decimals of
   * the CHANGE's magnitude, three orders below the price's.
   */
  const decimals = (text: string): number => (text.split(".")[1] ?? "").replace(/[^0-9]/g, "").length;
  assert.ok(cell("last").includes("."), `Last dropped its decimals entirely: ${cell("last")}`);
  assert.equal(decimals(cell("chg")), decimals(cell("last")),
    `Last reads ${cell("last")} and Chg reads ${cell("chg")} — one instrument, two precisions`);
});

/**
 * ── TVP8 R7b-10: a name the catalogue already held ─────────────────────────
 *
 * The details block printed `BTC / USDT • BINANCE` under a comment claiming
 * "`Bitcoin / TetherUS` would be a name we do not hold" — while
 * `lib/instrument.ts`'s `displayName()` produced exactly that string and
 * `PaneLegend` painted it a thousand pixels to the left on the same screen.
 */
test("R7b-10 — THE DETAILS BLOCK NAMES THE INSTRUMENT, NOT ITS TWO LEGS", async () => {
  const chart = await mountChart();
  await settle(4);

  const details = await selectRow(chart.container, CANONICAL.BTCUSDT!);
  assert.match((details.textContent ?? ""), /Bitcoin \/ TetherUS • BINANCE/,
    `the identity line reads ${JSON.stringify((details.textContent ?? "").slice(0, 120))}`);
  assert.match(details.getAttribute("aria-label") ?? "", /^Details for Bitcoin \/ TetherUS$/,
    "the block's accessible name was a qualified storage identity");
});

/**
 * ── TVP8 R7b-11: the panel refused to compute what it had ──────────────────
 *
 * `Average volume (30D)` was a dash with the tooltip "computing one needs
 * daily bars this panel does not read yet", and `Performance` was one sentence
 * saying it was not computed. The backend has served `interval=1d` the whole
 * time. The reference shows a number and six tiles.
 */
test("R7b-11 — THE 30-DAY AVERAGE AND SIX PERFORMANCE TILES COME FROM DAILY BARS", async () => {
  const chart = await mountChart();
  await settle(4);
  const details = await selectRow(chart.container, CANONICAL.BTCUSDT!);

  assert.ok(server.callsTo("interval=1d").length >= 1,
    "the details block never asked for the daily bars it is computed from");

  const rows = [...details.querySelectorAll<HTMLElement>("dl > div")]
    .map((r) => (r.textContent ?? "").trim());
  const average = rows.find((r) => r.startsWith("Average Volume (30D)"));
  assert.ok(average, `the Key stats list has no 30-day row; it has ${rows.join(" · ")}`);
  assert.doesNotMatch(average, /—$/,
    "four hundred daily bars are served for this instrument — the dash is a refusal, not a limit");

  const tiles = [...details.querySelectorAll<HTMLElement>("[data-performance]")];
  assert.deepEqual(tiles.map((t) => t.getAttribute("data-performance")),
    ["1W", "1M", "3M", "6M", "YTD", "1Y"],
    "the reference's own 2x3 tile grid, in its own order");
  for (const tile of tiles) {
    assert.match((tile.textContent ?? "").trim(), /%/,
      `${tile.getAttribute("data-performance")} shows no percentage`);
  }
});
