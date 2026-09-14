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

  const rows = [...chart.container.querySelectorAll<HTMLElement>("button")]
    .map((b) => (b.textContent ?? "").trim());
  assert.equal(rows.some((t) => t.startsWith("SOL/USDT")) && rows.some((t) => t.startsWith("BTC/USDT")), true,
    "both tracked symbols must be rows in the seeded list");
});
