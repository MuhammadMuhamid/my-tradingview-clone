/**
 * A canonical instrument's chart streams, and says so only while it does.
 *
 * Two facts, both found the hard way (B-18):
 *
 *  - The alert dialog said "No live frame yet" under a Last price that was
 *    ticking, because a canonical instrument's live frames arrive on
 *    `useCandleHistory`'s provider stream, not through `useLivePrice`. The hook
 *    now reports `streamLive`.
 *  - "Live" must mean frames are arriving, so this asserts the provider socket
 *    actually opens for a canonical instrument and that the flag turns on only
 *    when a frame lands — not merely that the flag reads right.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { act } from "@testing-library/react";
import {
  FakeSocket, closeBrowser, compactSeries, render, resetBrowser, server, settle,
} from "./harness/env";
import { CANONICAL, klineFrame } from "./harness/market";
import { useCandleHistory, type CandleHistoryState } from "@/lib/useCandleHistory";

beforeEach(() => {
  resetBrowser();
  server.setDefaultCandles(compactSeries(300));
});
after(closeBrowser);

test("B-18 — a canonical instrument opens its stream, and is live only once a frame lands", async () => {
  const id = CANONICAL.BTCUSDT!;
  let state: CandleHistoryState | null = null;
  function Harness() {
    state = useCandleHistory({ symbol: id, interval: "15m", bars: 300 }, { live: true });
    return null;
  }
  render(<Harness />);
  await settle(6);
  assert.ok(state!.candles.length > 0, "the window did not load");

  const socket = FakeSocket.opened.find((s) => /btcusdt@kline_15m/.test(s.url));
  assert.ok(socket, `no provider stream was opened: ${FakeSocket.opened.map((s) => s.url).join(", ")}`);
  assert.equal(state!.streamLive, false, "live before any frame arrived");

  const last = state!.candles[state!.candles.length - 1]!;
  await act(async () => {
    socket.open();
    socket.deliver(klineFrame(id, "15m", {
      openTime: last.openTime, open: last.open, high: last.high + 1, low: last.low,
      close: last.close + 0.5, volume: last.volume, closed: false,
    }));
  });
  await settle();
  assert.equal(state!.streamLive, true, "a delivered frame did not make the stream live");
});
