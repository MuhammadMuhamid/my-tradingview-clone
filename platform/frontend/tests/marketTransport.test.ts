/**
 * Live prices on any network.
 *
 * On the owner's network `stream.binance.com` answers the websocket handshake
 * with HTTP 451 and the socket closes before it opens; the market-data-only
 * endpoint `data-stream.binance.vision` is reachable. These pin the browser's
 * side of the repair: one origin list, tried in order with a fast rotation on
 * a refused handshake; a bounded reconnect on any close; `live` only once a
 * frame has arrived; a Content-Security-Policy that permits every origin the
 * registry may open; and cause text a trader can act on.
 *
 * Everything runs against a fake transport and a fake clock. Nothing here
 * contacts Binance.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bookTickerStreamName, combinedStreamPath, describeStreamState, klineStreamName,
  MARKET_STREAM_ORIGINS, MarketStreamRegistry, miniTickerStreamName, reconnectDelayMs,
  singleStreamPath, STREAM_SILENCE_TIMEOUT_MS, streamUrl,
  type StreamScheduler, type StreamSocket, type StreamState, type StreamTransport,
} from "../lib/marketStream";
import { MarketFeedRegistry } from "../lib/marketFeed";
import { bookQuoteStreamKey } from "../lib/useBookQuote";
import fs from "node:fs";
import path from "node:path";
import { retainTickers, tickerFrom, watchlistStreamKey } from "../lib/useWatchlistTickers";

interface FakeSocket extends StreamSocket {
  url: string;
  open: boolean;
  handlers: {
    onOpen: () => void; onMessage: (data: string) => void; onClose: () => void; onError: () => void;
  };
}

function fakeTransport(): StreamTransport & { sockets: FakeSocket[]; live: () => FakeSocket[] } {
  const sockets: FakeSocket[] = [];
  return {
    sockets,
    live: () => sockets.filter((s) => s.open),
    open(url, handlers) {
      const socket: FakeSocket = { url, open: true, handlers, close: () => { socket.open = false; } };
      sockets.push(socket);
      return socket;
    },
  };
}

function fakeScheduler(): StreamScheduler & { advance: (ms: number) => void; pending: () => number } {
  let now = 1_000_000;
  let nextId = 1;
  const timeouts = new Map<number, { at: number; fn: () => void }>();
  const intervals = new Map<number, { every: number; next: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout: (fn, ms) => { const id = nextId++; timeouts.set(id, { at: now + ms, fn }); return id; },
    clearTimeout: (handle) => { timeouts.delete(handle as number); },
    setInterval: (fn, ms) => { const id = nextId++; intervals.set(id, { every: ms, next: now + ms, fn }); return id; },
    clearInterval: (handle) => { intervals.delete(handle as number); },
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        let soonest = Infinity;
        for (const t of timeouts.values()) soonest = Math.min(soonest, t.at);
        for (const i of intervals.values()) soonest = Math.min(soonest, i.next);
        if (soonest > target) break;
        now = soonest;
        for (const [id, t] of [...timeouts]) if (t.at <= now) { timeouts.delete(id); t.fn(); }
        for (const i of [...intervals.values()]) if (i.next <= now) { i.next = now + i.every; i.fn(); }
      }
      now = target;
    },
    pending: () => timeouts.size + intervals.size,
  };
}

function registry() {
  const transport = fakeTransport();
  const scheduler = fakeScheduler();
  const streams = new MarketStreamRegistry({ transport, scheduler });
  return { transport, scheduler, streams };
}

const MIRROR = "wss://data-stream.binance.vision";
const NORMAL = "wss://stream.binance.com:9443";

/** A handshake refused by the edge: the socket errors and closes, never opens. */
function refuse(socket: FakeSocket): void {
  socket.handlers.onError();
  socket.handlers.onClose();
}

test("the origin list is the market-data endpoint first, the normal host second", () => {
  assert.deepEqual([...MARKET_STREAM_ORIGINS], [MIRROR, NORMAL]);
  assert.equal(streamUrl(MIRROR, singleStreamPath(klineStreamName("BTCUSDT", "1m"))),
    `${MIRROR}/ws/btcusdt@kline_1m`);
  assert.equal(combinedStreamPath([miniTickerStreamName("BTCUSDT"), miniTickerStreamName("ethusdt")]),
    "/stream?streams=btcusdt@miniTicker/ethusdt@miniTicker");
  assert.equal(bookTickerStreamName("SOLUSDT"), "solusdt@bookTicker");
});

test("THE CONTENT-SECURITY-POLICY PERMITS EVERY ORIGIN THE REGISTRY MAY OPEN", async () => {
  const config = await import("../next.config.mjs") as {
    MARKET_STREAM_ORIGINS: string[];
    default: { headers: () => Promise<Array<{ source: string; headers: Array<{ key: string; value: string }> }>> };
  };
  assert.deepEqual(config.MARKET_STREAM_ORIGINS, [...MARKET_STREAM_ORIGINS],
    "next.config.mjs and lib/marketStream.ts disagree about the stream origins");
  const rules = await config.default.headers();
  const csp = rules.find((r) => r.source === "/:path*")?.headers
    .find((h) => h.key === "Content-Security-Policy")?.value;
  assert.ok(csp, "no CSP header on every path");
  const connect = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("connect-src"));
  assert.ok(connect, "no connect-src directive");
  for (const origin of MARKET_STREAM_ORIGINS) {
    assert.ok(connect.split(/\s+/).includes(origin), `${origin} is not permitted by connect-src`);
  }
  // …and nothing else: the browser makes no Binance REST call, so no REST
  // origin belongs here. A policy is only as tight as the widest thing in it.
  assert.deepEqual(connect.split(/\s+/).slice(1), ["'self'", ...MARKET_STREAM_ORIGINS],
    "connect-src must permit exactly 'self' and the stream origins");
});

test("A REFUSED HANDSHAKE ROTATES TO THE NEXT ORIGIN ALMOST AT ONCE, AND FRAMES FLOW", () => {
  const { transport, scheduler, streams } = registry();
  const states: StreamState[] = [];
  const frames: string[] = [];
  streams.subscribe("k", singleStreamPath(klineStreamName("BTCUSDT", "1m")), {
    onState: (s) => states.push(s), onMessage: (d) => frames.push(d),
  });
  assert.equal(transport.sockets.length, 1);
  assert.equal(transport.sockets[0]!.url, `${MIRROR}/ws/btcusdt@kline_1m`, "the first attempt is the market-data endpoint");

  // The mirror is refused (this is the reverse of the owner's network, and
  // the harder case: the fallback must reach the normal host).
  refuse(transport.sockets[0]!);
  assert.equal(streams.stateOf("k").status, "reconnecting");
  assert.deepEqual(streams.stateOf("k").refused, [MIRROR]);
  scheduler.advance(300);
  assert.equal(transport.sockets.length, 2, "the next origin was not tried within a round trip");
  assert.equal(transport.sockets[1]!.url, `${NORMAL}/ws/btcusdt@kline_1m`);

  transport.sockets[1]!.handlers.onOpen();
  assert.equal(streams.stateOf("k").status, "open", "a handshake alone must not read as live");
  transport.sockets[1]!.handlers.onMessage("{\"k\":{}}");
  assert.equal(streams.stateOf("k").status, "live");
  assert.equal(streams.stateOf("k").origin, NORMAL);
  assert.equal(streams.stateOf("k").attempt, 0);
  assert.deepEqual(streams.stateOf("k").refused, [], "a live stream has nothing refused");
  assert.deepEqual(frames, ["{\"k\":{}}"]);

  // Every subscription after this starts at the origin that worked.
  assert.equal(streams.preferredOrigin, NORMAL);
  streams.subscribe("book", singleStreamPath(bookTickerStreamName("BTCUSDT")), {});
  assert.equal(transport.sockets[2]!.url, `${NORMAL}/ws/btcusdt@bookTicker`);
  streams.closeAll();
  assert.equal(scheduler.pending(), 0);
});

test("the owner's case: the normal host is fenced, the market-data endpoint is not", () => {
  const { transport, streams } = registry();
  // Simulate a registry whose preference had drifted to the normal host.
  const shifted = new MarketStreamRegistry({ transport, scheduler: fakeScheduler(), origins: [NORMAL, MIRROR] });
  shifted.subscribe("k", "/ws/btcusdt@kline_1m", {});
  refuse(transport.sockets[0]!);
  void streams;
  // (rotation is timer-driven; the previous test covers the timing)
  assert.deepEqual(shifted.stateOf("k").refused, [NORMAL]);
  assert.equal(describeStreamState(shifted.stateOf("k")).label, "stream refused — trying another host…");
  shifted.closeAll();
});

test("WHEN EVERY ORIGIN REFUSES, THE STATE SAYS SO AND RETRIES ON THE LADDER", () => {
  const { transport, scheduler, streams } = registry();
  streams.subscribe("k", "/ws/btcusdt@kline_1m", {});
  refuse(transport.sockets[0]!);
  scheduler.advance(300);
  refuse(transport.sockets[1]!);
  const state = streams.stateOf("k");
  assert.equal(state.status, "reconnecting");
  assert.deepEqual(state.refused, [MIRROR, NORMAL]);
  assert.equal(state.everLive, false);
  const words = describeStreamState(state);
  assert.equal(words.label, "live stream unavailable — history still updates");
  assert.match(words.detail, /data-stream\.binance\.vision, stream\.binance\.com:9443/);
  assert.match(words.detail, /history keeps loading/i);
  assert.match(words.detail, /not streaming/);

  // Retrying never stops, and never faster than the ladder once both are known.
  const before = transport.sockets.length;
  scheduler.advance(reconnectDelayMs(2) - 1);
  assert.equal(transport.sockets.length, before, "retried before the ladder step");
  scheduler.advance(2);
  assert.equal(transport.sockets.length, before + 1);
  assert.equal(transport.sockets.at(-1)!.url, `${MIRROR}/ws/btcusdt@kline_1m`, "the rotation wraps back to the first origin");
  streams.closeAll();
});

test("a socket that drops after being live reconnects on the bounded ladder", () => {
  const { transport, scheduler, streams } = registry();
  const statuses: string[] = [];
  streams.subscribe("w", combinedStreamPath(["btcusdt@miniTicker"]), { onState: (s) => statuses.push(s.status) });
  transport.sockets[0]!.handlers.onOpen();
  transport.sockets[0]!.handlers.onMessage("{}");
  assert.equal(streams.stateOf("w").status, "live");

  transport.sockets[0]!.handlers.onClose();
  assert.equal(streams.stateOf("w").status, "reconnecting");
  assert.equal(describeStreamState(streams.stateOf("w")).label, "reconnecting…");
  scheduler.advance(reconnectDelayMs(1));
  assert.equal(transport.sockets.length, 2, "the watchlist stream did not reconnect");
  assert.equal(transport.sockets[1]!.url, transport.sockets[0]!.url, "an open-then-dropped socket retries the same origin");

  // Silence is death, once per stream.
  transport.sockets[1]!.handlers.onOpen();
  transport.sockets[1]!.handlers.onMessage("{}");
  scheduler.advance(STREAM_SILENCE_TIMEOUT_MS + 6_000);
  assert.ok(statuses.includes("stale"));
  scheduler.advance(60_000);
  assert.equal(transport.live().length, 1);
  streams.closeAll();
  assert.equal(scheduler.pending(), 0);
});

test("A ONCE-LIVE STREAM THAT BECOMES UNREACHABLE KEEPS ONE RECONNECT CHAIN AND ONE SOCKET", () => {
  const { transport, scheduler, streams } = registry();
  streams.subscribe("k", "/ws/btcusdt@kline_1m", {});
  transport.sockets[0]!.handlers.onOpen();
  transport.sockets[0]!.handlers.onMessage("{}");
  assert.equal(streams.stateOf("k").status, "live");

  // The network goes away: the live socket drops, and every handshake from
  // now on is refused after a realistic round trip (100 ms). Ten simulated
  // minutes is long enough for the silence watchdog to fire a dozen times
  // beside the ladder — the case that used to start a chain per firing.
  transport.sockets[0]!.handlers.onClose();
  const answered = new Set<FakeSocket>([transport.sockets[0]!]);
  let peakPendingTimers = 0;
  let peakLiveSockets = 0;
  for (let elapsed = 0; elapsed < 10 * 60_000; elapsed += 100) {
    scheduler.advance(100);
    for (const socket of transport.live()) {
      if (answered.has(socket)) continue;
      answered.add(socket);
      refuse(socket);
    }
    // One interval (the watchdog) plus at most one reconnect timer.
    peakPendingTimers = Math.max(peakPendingTimers, scheduler.pending() - 1);
    peakLiveSockets = Math.max(peakLiveSockets, transport.live().length);
  }
  assert.equal(peakPendingTimers, 1, "more than one reconnect was pending at once");
  assert.ok(peakLiveSockets <= 1, `${peakLiveSockets} sockets were held at once`);
  // Two fast rotations, then the 2s→30s ladder: well under one attempt per 30 s
  // plus a handful, and nowhere near the 71 per minute the leak produced.
  assert.ok(transport.sockets.length < 40, `${transport.sockets.length} connection attempts in ten minutes`);
  assert.equal(streams.stateOf("k").status, "reconnecting");

  // The network comes back: the next attempt opens and delivers a frame.
  scheduler.advance(30_000);
  const recovered = transport.live();
  assert.equal(recovered.length, 1, "recovery must open exactly one socket");
  recovered[0]!.handlers.onOpen();
  assert.equal(streams.stateOf("k").status, "open", "a handshake alone must not read as live");
  recovered[0]!.handlers.onMessage("{}");
  assert.equal(streams.stateOf("k").status, "live");
  scheduler.advance(120_000);
  assert.equal(transport.live().length, 1, "orphan sockets were opened after recovery");
  assert.equal(streams.socketsOpened - streams.socketsClosed, 1, "the registry lost track of a socket");
  assert.equal(scheduler.pending(), 1, "only the watchdog may remain scheduled while live");

  streams.closeAll();
  assert.equal(transport.live().length, 0, "closeAll left a socket open");
  assert.equal(scheduler.pending(), 0);
});

test("the watchdog firing while a reconnect is already waiting neither adds a chain nor blames the host", () => {
  const { transport, scheduler, streams } = registry();
  streams.subscribe("k", "/ws/btcusdt@kline_1m", {});
  transport.sockets[0]!.handlers.onOpen();
  transport.sockets[0]!.handlers.onMessage("{}");

  // Quiet for 44 s, then the socket closes: the ladder schedules a retry at
  // 2 s, and the watchdog's 45 s silence threshold passes while that retry is
  // still pending. There is no socket to give up on, so it must stand aside.
  scheduler.advance(44_000);
  transport.sockets[0]!.handlers.onClose();
  assert.equal(streams.stateOf("k").status, "reconnecting");
  scheduler.advance(1_500);
  assert.equal(scheduler.pending(), 2, "one watchdog and one reconnect timer, nothing more");
  assert.deepEqual(streams.stateOf("k").refused, [], "a host that was never asked cannot have refused");
  scheduler.advance(1_000);
  assert.equal(transport.sockets.length, 2, "exactly one reconnect attempt");
  assert.equal(transport.live().length, 1);
  // The watchdog ticks again while that handshake is still in flight. The
  // silence it measures is this socket's, not the previous socket's.
  scheduler.advance(5_000);
  assert.equal(transport.sockets.length, 2, "a handshake in flight was given up on for an older socket's silence");
  assert.equal(transport.live().length, 1);
  assert.deepEqual(streams.stateOf("k").refused, [], "a host that was never asked cannot have refused");
  transport.sockets[1]!.handlers.onOpen();
  transport.sockets[1]!.handlers.onMessage("{}");
  // Well inside the silence threshold: nothing but the watchdog may run.
  scheduler.advance(30_000);
  assert.equal(transport.live().length, 1);
  assert.equal(transport.sockets.length, 2, "a second chain opened another socket");
  assert.equal(scheduler.pending(), 1);
  streams.closeAll();
  assert.equal(scheduler.pending(), 0);
});

test("the kline feed, the watchlist and the book quote share one registry and one lifecycle", () => {
  const { transport, streams } = registry();
  const feed = new MarketFeedRegistry({ streams });
  feed.subscribe("BTCUSDT", "1m", {});
  streams.subscribe(watchlistStreamKey(["ETHUSDT", "btcusdt"]), combinedStreamPath(["btcusdt@miniTicker", "ethusdt@miniTicker"]), {});
  streams.subscribe(bookQuoteStreamKey("btcusdt"), singleStreamPath(bookTickerStreamName("BTCUSDT")), {});
  assert.equal(streams.activeStreams, 3);
  assert.deepEqual(transport.sockets.map((s) => s.url), [
    `${MIRROR}/ws/btcusdt@kline_1m`,
    `${MIRROR}/stream?streams=btcusdt@miniTicker/ethusdt@miniTicker`,
    `${MIRROR}/ws/btcusdt@bookTicker`,
  ]);
  assert.equal(watchlistStreamKey(["ETHUSDT", "btcusdt"]), watchlistStreamKey(["BTCUSDT", "ETHUSDT"]),
    "the same symbol set in another order is the same stream");
  feed.closeAll();
  assert.equal(streams.activeStreams, 0);
});

test("a consumer that throws does not starve the others of the same frame", () => {
  const { transport, streams } = registry();
  const seen: string[] = [];
  const originalError = console.error;
  console.error = () => {};
  try {
    streams.subscribe("k", "/ws/x", { onMessage: () => { throw new Error("Cannot update oldest data"); } });
    streams.subscribe("k", "/ws/x", { onMessage: (d) => seen.push(d) });
    transport.sockets[0]!.handlers.onMessage("frame");
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(seen, ["frame"]);
  streams.closeAll();
});

test("a watchlist row is a real quote whether it was seeded or streamed, and says which", () => {
  const seeded = tickerFrom(101, 100, "seed");
  assert.equal(seeded.source, "seed");
  assert.equal(seeded.chg, 1);
  assert.ok(Math.abs(seeded.chgPct - 1) < 1e-9);
  assert.equal(tickerFrom(5, 0, "stream").chgPct, 0, "no 24h open means no percentage, not a division by zero");
});

test("a symbol removed from the watchlist does not come back wearing its old quote", () => {
  const streamed = { BTCUSDT: tickerFrom(101, 100, "stream"), ETHUSDT: tickerFrom(51, 50, "stream") };
  // Removal drops the row's value with the row…
  const without = retainTickers(streamed, ["ETHUSDT"]);
  assert.deepEqual(Object.keys(without), ["ETHUSDT"]);
  // …so on re-adding there is nothing stale for the seed to defer to: the row
  // is unknown ("—") until the seed or a frame gives it a current value.
  const readded = retainTickers(without, ["ETHUSDT", "btcusdt"]);
  assert.equal(readded.BTCUSDT, undefined);
  assert.equal(readded.ETHUSDT, without.ETHUSDT, "rows that stayed keep their value");
  assert.deepEqual(retainTickers(streamed, []), {});
  // The hook prunes on every membership change, before the seed request.
  const hook = fs.readFileSync(path.join(__dirname, "..", "lib", "useWatchlistTickers.ts"), "utf8");
  assert.match(hook, /setTickers\(\(current\) => retainTickers\(current, list\)\);\s*\n\s*if \(list\.length === 0\) return;/);
});

test("the watchlist header claims live only for a live stream, never for a handshake", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "components", "tv", "Watchlist.tsx"), "utf8");
  const labels = [...source.matchAll(/label: ("[^"]*")/g)].map((m) => m[1]!);
  assert.ok(labels.length >= 3, "the header's price-state labels could not be located");
  // "live" appears exactly once, and only under status === "live".
  assert.equal(labels.filter((l) => l === '"live"').length, 1, labels.join(" "));
  assert.match(source, /stream\.status === "live" \? \{ label: "live"/);
  assert.doesNotMatch(source, /anyStreamed/, "the once-streamed shortcut to \"live\" must not return");
  assert.match(source, /stream\.status === "open" \? "connected — waiting for data" : "connecting…"/);
});
