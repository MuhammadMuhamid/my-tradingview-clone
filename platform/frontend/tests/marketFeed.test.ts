/**
 * Sixteen panes on one instrument must not be sixteen websockets.
 *
 * The audit's finding was that every chart opened its own
 * `wss://…@kline_<interval>` connection in a `useEffect`. With one chart that
 * is indistinguishable from a shared feed; with a sixteen-pane workspace it is
 * sixteen connections carrying byte-identical frames, sixteen JSON parses per
 * tick, sixteen reconnect ladders and sixteen watchdogs, all to draw one bar.
 *
 * These run against a fake transport and a fake clock: nothing here contacts
 * Binance, and the counts are exact rather than approximate.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  feedKey, klineStreamUrl, MarketFeedRegistry, WS_SILENCE_TIMEOUT_MS,
  type FeedScheduler, type FeedSocket, type FeedTransport, type KlineTick,
} from "../lib/marketFeed";
import { createWorkspace, feedKeys, setPaneCount, updatePane } from "../lib/workspace";
import type { Interval } from "../lib/types";

interface FakeSocket extends FeedSocket {
  url: string;
  open: boolean;
  handlers: {
    onOpen: () => void;
    onMessage: (data: string) => void;
    onClose: () => void;
    onError: () => void;
  };
}

/** A transport that records every connection instead of making one. */
function fakeTransport(): FeedTransport & { sockets: FakeSocket[]; live: () => FakeSocket[] } {
  const sockets: FakeSocket[] = [];
  return {
    sockets,
    live: () => sockets.filter((s) => s.open),
    open(url, handlers) {
      const socket: FakeSocket = {
        url, open: true, handlers,
        close: () => { socket.open = false; },
      };
      sockets.push(socket);
      return socket;
    },
  };
}

/** A clock the test drives, so no timer outlives the test process. */
function fakeScheduler(): FeedScheduler & { advance: (ms: number) => void; pending: () => number } {
  let now = 1_000_000;
  let nextId = 1;
  const timeouts = new Map<number, { at: number; fn: () => void }>();
  const intervals = new Map<number, { every: number; next: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout: (fn, ms) => { const id = nextId++; timeouts.set(id, { at: now + ms, fn }); return id; },
    clearTimeout: (handle) => { timeouts.delete(handle as number); },
    setInterval: (fn, ms) => {
      const id = nextId++;
      intervals.set(id, { every: ms, next: now + ms, fn });
      return id;
    },
    clearInterval: (handle) => { intervals.delete(handle as number); },
    advance(ms: number) {
      const target = now + ms;
      // Step through in the order the timers would actually fire.
      for (;;) {
        let soonest = Infinity;
        for (const t of timeouts.values()) soonest = Math.min(soonest, t.at);
        for (const i of intervals.values()) soonest = Math.min(soonest, i.next);
        if (soonest > target) break;
        now = soonest;
        for (const [id, t] of [...timeouts]) {
          if (t.at <= now) { timeouts.delete(id); t.fn(); }
        }
        for (const [id, i] of [...intervals]) {
          if (i.next <= now) { i.next = now + i.every; void id; i.fn(); }
        }
      }
      now = target;
    },
    pending: () => timeouts.size + intervals.size,
  };
}

function registry() {
  const transport = fakeTransport();
  const scheduler = fakeScheduler();
  const feed = new MarketFeedRegistry({ transport, scheduler });
  /** Past the remount grace period, so a released feed actually closes. */
  const settle = (): void => scheduler.advance(5_000);
  return { transport, scheduler, feed, settle };
}

const frame = (openTime: number, close: number, closed = false): string => JSON.stringify({
  k: { t: openTime, T: openTime + 59_999, o: "1", h: "2", l: "0.5", c: String(close), v: "10", x: closed },
});

test("the feed key is the whole of a subscription's identity", () => {
  assert.equal(feedKey("solusdt", "15m"), "SOLUSDT|15m");
  assert.equal(feedKey("SOLUSDT", "15m"), "SOLUSDT|15m");
  assert.notEqual(feedKey("SOLUSDT", "15m"), feedKey("SOLUSDT", "1h"));
  assert.notEqual(feedKey("SOLUSDT", "15m"), feedKey("BTCUSDT", "15m"));
  // The first supported origin is the market-data-only endpoint; the normal
  // host is the fallback. Both are asserted against the CSP elsewhere.
  assert.equal(klineStreamUrl("SOLUSDT", "15m"),
    "wss://data-stream.binance.vision/ws/solusdt@kline_15m");
  assert.equal(klineStreamUrl("SOLUSDT", "15m", "wss://stream.binance.com:9443"),
    "wss://stream.binance.com:9443/ws/solusdt@kline_15m");
});

test("SIXTEEN IDENTICAL PANES OPEN ONE UPSTREAM SUBSCRIPTION", () => {
  const { transport, feed, settle } = registry();
  const ticks: number[] = new Array(16).fill(0);
  const release = Array.from({ length: 16 }, (_, i) =>
    feed.subscribe("SOLUSDT", "15m", { onTick: () => { ticks[i]! += 1; } }));

  assert.equal(feed.activeFeeds, 1, "one feed key, one feed");
  assert.equal(transport.sockets.length, 1, "a socket was opened per pane");
  assert.equal(feed.consumerCount, 16);

  // One upstream frame reaches all sixteen consumers, parsed once.
  transport.sockets[0]!.handlers.onMessage(frame(1_700_000_000_000, 42));
  assert.deepEqual(ticks, new Array(16).fill(1));

  // Closing fifteen of them keeps the connection for the sixteenth.
  for (let i = 0; i < 15; i++) release[i]!();
  assert.equal(feed.activeFeeds, 1);
  assert.equal(transport.live().length, 1);
  assert.equal(feed.consumerCount, 1);

  // Only the last consumer leaving closes it, and only once the remount grace
  // period has passed — a layout change must not cost a reconnect.
  release[15]!();
  assert.equal(feed.activeFeeds, 1);
  assert.equal(feed.lingeringFeeds, 1);
  assert.equal(transport.live().length, 1, "the socket dropped before the grace expired");
  settle();
  assert.equal(feed.activeFeeds, 0);
  assert.equal(transport.live().length, 0);
  assert.equal(transport.sockets.length, 1, "the feed was reopened at some point");
});

test("A PANE THAT REMOUNTS KEEPS ITS FEED INSTEAD OF RECONNECTING", () => {
  /*
   * Maximise unmounts fifteen panes and remounts the sixteenth; restore does
   * the reverse. Without the grace period the last release and the first
   * subscribe land in the same commit, so the socket closes and immediately
   * reopens — a "connecting…" state and a gap in live prices caused purely by
   * a layout change.
   */
  const { transport, feed, settle } = registry();
  const release = Array.from({ length: 16 }, () => feed.subscribe("SOLUSDT", "15m", {}));
  assert.equal(transport.sockets.length, 1);

  for (const stop of release) stop();          // every pane unmounts…
  const remounted = feed.subscribe("SOLUSDT", "15m", {});   // …and one comes back
  assert.equal(transport.sockets.length, 1, "the feed reconnected across a layout change");
  assert.equal(transport.live().length, 1);
  assert.equal(feed.lingeringFeeds, 0, "the grace period was not cancelled on re-attach");

  settle();
  assert.equal(feed.activeFeeds, 1, "a feed with a live consumer was closed anyway");
  remounted();
  settle();
  assert.equal(feed.activeFeeds, 0);
});

test("upstream cost tracks unique feed keys, not pane count", () => {
  const { transport, feed, settle } = registry();
  const panes: Array<[string, Interval]> = [
    ["SOLUSDT", "15m"], ["SOLUSDT", "15m"], ["SOLUSDT", "15m"], ["SOLUSDT", "15m"],
    ["SOLUSDT", "1h"], ["SOLUSDT", "1h"],
    ["BTCUSDT", "15m"], ["BTCUSDT", "15m"], ["BTCUSDT", "15m"],
    ["ETHUSDT", "4h"],
  ];
  const release = panes.map(([s, i]) => feed.subscribe(s, i, {}));
  assert.equal(panes.length, 10);
  assert.equal(feed.activeFeeds, 4, "one feed per distinct symbol+interval");
  assert.equal(transport.live().length, 4);
  for (const stop of release) stop();
  settle();
  assert.equal(feed.activeFeeds, 0);
});

test("different feed keys stay isolated from one another", () => {
  const { transport, feed } = registry();
  const sol: KlineTick[] = [];
  const btc: KlineTick[] = [];
  const hourly: KlineTick[] = [];
  feed.subscribe("SOLUSDT", "15m", { onTick: (t) => sol.push(t) });
  feed.subscribe("BTCUSDT", "15m", { onTick: (t) => btc.push(t) });
  feed.subscribe("SOLUSDT", "1h", { onTick: (t) => hourly.push(t) });

  const byUrl = (url: string) => transport.sockets.find((s) => s.url === url)!;
  byUrl(klineStreamUrl("SOLUSDT", "15m")).handlers.onMessage(frame(1000, 10));
  assert.equal(sol.length, 1);
  assert.equal(btc.length, 0);
  assert.equal(hourly.length, 0);
  assert.equal(sol[0]!.symbol, "SOLUSDT");
  assert.equal(sol[0]!.interval, "15m");
  assert.equal(sol[0]!.close, 10);

  byUrl(klineStreamUrl("SOLUSDT", "1h")).handlers.onMessage(frame(2000, 20));
  assert.equal(sol.length, 1, "a 1h frame leaked into the 15m feed");
  assert.equal(hourly.length, 1);
  feed.closeAll();
});

test("changing symbol or interval releases the old feed and attaches to the new", () => {
  const { transport, feed, settle } = registry();
  // A pane on SOL 15m, alongside a second pane that stays where it is.
  const other = feed.subscribe("SOLUSDT", "15m", {});
  let release = feed.subscribe("SOLUSDT", "15m", {});
  assert.equal(feed.activeFeeds, 1);

  // The pane switches instrument: old consumer detached, new one attached.
  release();
  release = feed.subscribe("BTCUSDT", "15m", {});
  assert.equal(feed.activeFeeds, 2, "the SOL feed still has its other pane");
  assert.equal(feed.consumerCount, 2);

  // The pane that stayed leaves; the SOL feed closes, BTC keeps running.
  other();
  settle();
  assert.equal(feed.activeFeeds, 1);
  assert.equal(transport.live().length, 1);
  assert.equal(transport.live()[0]!.url, klineStreamUrl("BTCUSDT", "15m"));

  release();
  settle();
  assert.equal(feed.activeFeeds, 0);
  assert.equal(transport.live().length, 0);
});

test("leaving the page closes every socket and clears every timer", () => {
  const { transport, scheduler, feed } = registry();
  feed.subscribe("SOLUSDT", "15m", {});
  feed.subscribe("BTCUSDT", "1h", {});
  feed.subscribe("ETHUSDT", "4h", {});
  assert.equal(feed.activeFeeds, 3);
  assert.ok(scheduler.pending() >= 3, "each feed needs its own watchdog");

  feed.closeAll();
  assert.equal(feed.activeFeeds, 0);
  assert.equal(feed.consumerCount, 0);
  assert.equal(transport.live().length, 0);
  assert.equal(scheduler.pending(), 0, "a timer outlived the workspace");
});

test("releasing a consumer twice cannot close a feed another pane is using", () => {
  // React runs an effect's cleanup more than once in development Strict Mode.
  const { transport, feed } = registry();
  const first = feed.subscribe("SOLUSDT", "15m", {});
  feed.subscribe("SOLUSDT", "15m", {});
  first();
  first();
  first();
  assert.equal(feed.activeFeeds, 1);
  assert.equal(feed.consumerCount, 1);
  assert.equal(transport.live().length, 1);
  feed.closeAll();
});

test("the reconnect ladder and the silence watchdog run once per feed", () => {
  const { transport, scheduler, feed } = registry();
  const statuses: string[] = [];
  feed.subscribe("SOLUSDT", "15m", { onStatus: (s) => statuses.push(s) });
  feed.subscribe("SOLUSDT", "15m", {});
  assert.equal(transport.sockets.length, 1);

  transport.sockets[0]!.handlers.onOpen();
  // A handshake is not evidence of prices. Only a frame is.
  assert.equal(feed.statusOf("SOLUSDT", "15m"), "open");
  transport.sockets[0]!.handlers.onMessage(frame(1000, 10));
  assert.equal(feed.statusOf("SOLUSDT", "15m"), "live");

  // A socket that is open but silent is not a live feed.
  scheduler.advance(WS_SILENCE_TIMEOUT_MS + 6_000);
  assert.ok(statuses.includes("stale"), "silence was reported as live");
  // One reconnect for the feed, not one per consumer.
  scheduler.advance(60_000);
  assert.equal(transport.live().length, 1);
  assert.equal(feed.activeFeeds, 1);

  feed.closeAll();
  assert.equal(scheduler.pending(), 0);
});

test("a malformed frame is dropped rather than breaking the feed", () => {
  const { transport, feed } = registry();
  const ticks: KlineTick[] = [];
  feed.subscribe("SOLUSDT", "15m", { onTick: (t) => ticks.push(t) });
  const socket = transport.sockets[0]!;
  socket.handlers.onMessage("{not json");
  socket.handlers.onMessage(JSON.stringify({ nothing: true }));
  socket.handlers.onMessage(frame(3000, 30, true));
  assert.equal(ticks.length, 1);
  assert.equal(ticks[0]!.closed, true);
  feed.closeAll();
});

test("a sixteen-pane workspace asks for exactly one feed key", () => {
  // The workspace model and the registry agree on what "equivalent" means,
  // which is the property that keeps the acceptance claim honest.
  const sixteen = setPaneCount(createWorkspace({ symbol: "SOLUSDT", interval: "15m" }), 16);
  const keys = feedKeys(sixteen);
  assert.deepEqual(keys, ["SOLUSDT|15m"]);

  const { transport, feed } = registry();
  for (const pane of sixteen.panes) feed.subscribe(pane.symbol, pane.interval, {});
  assert.equal(feed.activeFeeds, keys.length);
  assert.equal(transport.sockets.length, 1);

  const mixed = updatePane(sixteen, "p9", { symbol: "BTCUSDT" });
  assert.equal(feedKeys(mixed).length, 2);
  feed.closeAll();
});
