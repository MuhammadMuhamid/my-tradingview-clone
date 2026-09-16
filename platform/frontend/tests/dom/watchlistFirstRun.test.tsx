/**
 * A fresh database's first watchlist holds the tracked symbols.
 *
 * ── TVP8 IO-A10 ────────────────────────────────────────────────────────────
 *
 * The first-run seed read `symbols` from the mount effect's closure — the
 * value the panel mounted with, `[]`, because the page's `listSymbols` is
 * still in flight when the panel first renders. Since FG-01 opened the panel
 * by default, every first run wrote a "Main Watchlist" with no rows.
 *
 * The race is made deterministic here: the symbols table is HELD until after
 * the watchlist has loaded and found the database empty, which is the order a
 * real first load takes. Run against the old closure, the recorded POST says
 * `"symbols":[]` and the last assertion fails.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { closeBrowser, compactSeries, resetBrowser, server, settle } from "./harness/env";
import { mountChart } from "./harness/chart";
import { CANONICAL } from "./harness/market";

beforeEach(() => {
  resetBrowser();
  server.setCandles("SOLUSDT", "15m", compactSeries(300));
  // No watchlist: a first run.
});
after(closeBrowser);

test("ON A FIRST RUN THE DEFAULT LIST IS SEEDED FROM THE TRACKED SYMBOLS, NOT FROM WHAT THE PANEL MOUNTED WITH", async () => {
  const release = server.hold((request) => request.method === "GET" && request.path === "/api/symbols");
  const chart = await mountChart();
  await settle();
  assert.equal(server.callsTo("/api/watchlists").some((c) => c.method === "GET"), true,
    "the watchlist must have asked for its lists before the symbols table answered");

  release();
  await settle(6);

  const created = server.calls.filter((c) => c.method === "POST" && c.path === "/api/watchlists");
  assert.equal(created.length, 1, `expected exactly one default list to be created, saw ${created.length}`);
  const body = created[0]!.body as { name: string; symbols: string[] };
  assert.equal(body.name, "Main Watchlist");
  assert.deepEqual(body.symbols, [CANONICAL.SOLUSDT, CANONICAL.BTCUSDT],
    "the seed must carry the tracked symbols' canonical identities");

  // Scoped to the list: the toolbar's symbol pill prints the same token now.
  const rows = [...chart.container.querySelectorAll<HTMLElement>("[data-watchlist-row] button")]
    .map((b) => (b.textContent ?? "").trim());
  // TVP8 R7-01: one token per row, as the reference writes them.
  assert.equal(rows.some((t) => t.startsWith("SOLUSDT")) && rows.some((t) => t.startsWith("BTCUSDT")), true,
    "both tracked symbols must be rows in the seeded list");
});

/**
 * ── TVP8 R7b-03: the ticker cell had 30 pixels ─────────────────────────────
 *
 * The row's grid was `24px minmax(0,1fr) 72px 70px 60px` with `gap-x-1` on top
 * of it, in a panel whose content was 296 wide rather than 300 (the gutter was
 * being painted twice — R7b-05). Sixteen pixels went to four column gaps and
 * four to the duplicated band, and the cell that paid was the one with
 * `1fr`: a computed 30px, so the reviewer's rows read `BTC▏`, `ETH▏`, `LINK`,
 * `AVA)` against the reference's six glyphs at 50px.
 *
 * ── Why this asserts the template and not `clientWidth` ────────────────────
 *
 * jsdom does no layout: `clientWidth` is 0 for every element on this page
 * whatever the product does, so an assertion on it would pass for the wrong
 * reason and keep passing if the grid were deleted. What IS real here is the
 * inline `grid-template-columns` the row builds — the widths are no longer a
 * Tailwind literal because the `⋯` menu chooses which columns exist (R7b-08),
 * and a `grid-cols-[…]` assembled at runtime is a class Tailwind never emits.
 * The measured 50px ticker is verified at the browser, in the capture set.
 */
test("F-01 — THE ROW GRID GUTTERS EVERY COLUMN AND CLIPS EVERY VALUE", async () => {
  const release = server.hold((request) => request.method === "GET" && request.path === "/api/symbols");
  const chart = await mountChart();
  await settle();
  release();
  await settle(6);

  const button = chart.container.querySelector<HTMLElement>(
    `[data-watchlist-row="${CANONICAL.BTCUSDT}"] button`);
  assert.ok(button, "the seeded list has no BTC row to measure");
  /*
   * TVP8 F-01, superseding D-01's `18px 8px minmax(0,1fr) 56px 54px 44px`.
   *
   * Those tracks were narrower than the tabular ink they had to hold — and
   * with no `column-gap` and no `overflow` on the cells, the surplus painted
   * over the next column: `0.19280-0.004302.18%`. The reference settles which
   * column yields (`08_tv_watchlist.png` truncates the TICKER at 300px and
   * never a number), so the numeric tracks carry the maxima and the ticker is
   * the flexible one.
   */
  assert.equal(button.style.gridTemplateColumns,
    "18px minmax(52px,1fr) minmax(0,84px) minmax(0,64px) minmax(0,60px)");
  assert.equal(button.style.columnGap, "8px",
    "the gutter is the grid's, so no two cells can share an x-range at any width");
  assert.equal(button.className.includes("gap-x-"), false,
    "one gutter, declared once — not a Tailwind gap class as well");

  const header = chart.container.querySelector<HTMLElement>(
    "[data-watchlist] .grid.h-\\[29px\\]")
    ?? [...chart.container.querySelectorAll<HTMLElement>("[data-watchlist] div")]
      .find((el) => el.style.gridTemplateColumns !== "" && el !== button);
  assert.ok(header, "the column header was not found");
  assert.equal(header.style.gridTemplateColumns, button.style.gridTemplateColumns,
    "header and row share ONE template, or a label does not sit over its values");
  assert.equal(header.style.columnGap, "8px");
  assert.ok(button.className.includes("pl-[10px]") && header.className.includes("pl-[10px]"),
    "and one padding, or the flexible track resolves over two different widths");

  const ticker = button.querySelector<HTMLElement>("[data-ticker]");
  assert.ok(ticker, "the row has no ticker cell");
  assert.equal(ticker.style.maskImage, "",
    "a hard clip only when necessary, never a fade or ellipsis");
  assert.equal(ticker.className.includes("truncate"), false, "the ticker must not ellipsise");
  for (const value of button.querySelectorAll<HTMLElement>("[data-col]")) {
    assert.equal(value.className.includes("truncate"), false, "a numeric value may never ellipsise");
    assert.ok(value.className.includes("overflow-hidden")
      && value.className.includes("whitespace-nowrap"),
      "a value that outgrows its track clips inside it rather than over its neighbour");
    assert.ok(value.className.includes("text-right") && value.className.includes("tabular"));
  }
});
