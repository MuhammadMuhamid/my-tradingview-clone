/**
 * A replay on a canonical instrument keeps playing through a live frame.
 *
 * ── TVP8 IO-A2, end to end ─────────────────────────────────────────────────
 *
 * `useCandleHistory` runs its own provider stream and a fifteen-second REST
 * tail for an `instrument:v1:…` symbol, both of which call `mergeLiveBars`.
 * A merge hands the page a fresh `candles` array; the page's reconcile effect
 * is keyed on that identity; and `reconcileReplay` answered every reconcile
 * with `playing: false` — the right answer for a navigation, and the wrong
 * one for a refresh of the window the session is already in. Press Play on a
 * canonical instrument and the session stopped itself within fifteen
 * seconds, transport still lit, nothing said.
 *
 * The first end-to-end version of this test was DELETED: it passed before the
 * repair, because the fixture served no canonical instrument, so the pane
 * never left its legacy symbol and the live-merge path was never reached
 * (IO-A2-COV). The fixture now serves one. This file puts the pane on it
 * through the watchlist — the way a person does — and PROVES it got there
 * (a canonical candle request, a kline socket) before it presses Play.
 *
 * Run with `reconcileReplay` answering `playing: false` for a same-window
 * refresh, this fails at the last assertion — see the commit.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, screen } from "@testing-library/react";
import {
  FakeSocket, closeBrowser, compactSeries, lastClose, resetBrowser, server, settle,
} from "./harness/env";
import { CANONICAL, klineFrame } from "./harness/market";
import { mountChart, type MountedChart } from "./harness/chart";
import type { CompactBar } from "./harness/server";

const SOL = CANONICAL.SOLUSDT!;
let bars: CompactBar[];

beforeEach(() => {
  resetBrowser();
  bars = compactSeries(300);
  server.setCandles("SOLUSDT", "15m", bars);
  // A returning user: the list exists, and holds the two tracked canonical ids.
  server.seedWatchlist([CANONICAL.SOLUSDT!, CANONICAL.BTCUSDT!]);
});
after(closeBrowser);

/** Put the focused pane on the canonical SOL instrument, through its watchlist row. */
async function chooseCanonicalSol(chart: MountedChart): Promise<void> {
  const row = [...chart.container.querySelectorAll<HTMLElement>("button")]
    .find((b) => (b.textContent ?? "").trim().startsWith("SOL/USDT"));
  assert.ok(row, "the watchlist has no SOL/USDT row — the fixture's tracked symbols did not seed it");
  fireEvent.click(row);
  await settle();
}

/** Open the replay picker and start a session at the suggested bar. */
async function startReplay(chart: MountedChart): Promise<void> {
  // TVP8: icon-only on the bar, like the reference; the name is the accessible one.
  const open = chart.container.querySelector<HTMLElement>('button[aria-label="Bar replay"]');
  assert.ok(open, "the toolbar has no Replay control");
  fireEvent.click(open);
  await settle();
  const start = screen.getByRole("button", { name: "Start Replay" });
  assert.equal(start.hasAttribute("disabled"), false, "the picker must pre-fill a replay point from the loaded bars");
  fireEvent.click(start);
  await settle();
}

const transport = (): HTMLElement =>
  screen.getByRole("button", { name: /^(Play|Pause) replay$/ });

test("PRESS PLAY ON A CANONICAL INSTRUMENT, RECEIVE A LIVE BAR, AND THE SESSION IS STILL PLAYING", async () => {
  const chart = await mountChart();
  await chooseCanonicalSol(chart);

  // The pane is on the canonical identity: bars came through the canonical
  // route, and the provider candle stream was opened. Without both, nothing
  // below tests the path the defect lived in.
  assert.equal(server.callsTo(`/api/market/v1/candles/${encodeURIComponent(SOL)}`).length >= 1, true,
    "the pane must have loaded its bars through the canonical candle route");
  // The fixture's stream config names an origin that resolves nowhere; the
  // legacy symbol's socket goes to the real exchange host. Only the former is
  // the canonical provider stream.
  const kline = FakeSocket.opened.find((s) => s.url.startsWith("wss://fixture.invalid/") && s.url.includes("@kline_15m"));
  assert.ok(kline, `no canonical kline socket was opened; sockets: ${FakeSocket.opened.map((s) => s.url).join(", ")}`);

  await startReplay(chart);
  fireEvent.click(transport());
  await settle();
  assert.equal(transport().getAttribute("aria-label"), "Pause replay", "Play must start the session");

  // A live frame for the newest bar — the same refresh the provider sends
  // every few hundred milliseconds on a real instrument.
  const newest = bars[bars.length - 1]!;
  kline.open();
  kline.deliver(klineFrame(SOL, "15m", {
    openTime: newest[0], open: newest[1], high: Math.max(newest[2], lastClose(bars) * 1.001),
    low: newest[3], close: lastClose(bars) * 1.001, volume: newest[5] + 1, closed: false,
  }));
  await settle();
  kline.deliver(klineFrame(SOL, "15m", {
    openTime: newest[0], open: newest[1], high: Math.max(newest[2], lastClose(bars) * 1.002),
    low: newest[3], close: lastClose(bars) * 1.002, volume: newest[5] + 2, closed: false,
  }));
  await settle();

  assert.equal(transport().getAttribute("aria-label"), "Pause replay",
    "a refresh of the window the session is in must not stop the session");
  assert.equal(transport().getAttribute("aria-pressed"), "true");
});
