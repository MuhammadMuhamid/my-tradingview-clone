/**
 * The live half of a derived resolution.
 *
 * A `45m` chart has no `45m` stream to listen to — Binance publishes a kline
 * stream per native interval and nothing else — so the browser subscribes to
 * the source and folds the frames itself. Everything that can go wrong with
 * that is a way of drawing a bar that is not the bar:
 *
 *   joining mid-bucket and reporting a fragment's open as the bucket's open;
 *   adding every frame's running volume total and multiplying the bucket's
 *     volume by however many frames happened to arrive;
 *   closing the derived bar when a SOURCE bar closes rather than when the
 *     bucket ends;
 *   opening a second socket for a resolution that shares a source.
 *
 * All four are asserted here against the real registry, with a fake transport
 * standing in for the socket and nothing else stubbed.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import {
  MarketFeedRegistry, feedKey, klineStreamUrl, type FeedTransport, type KlineTick,
} from "../lib/marketFeed";

/** A transport that records what was opened and lets a test push frames. */
function fakeTransport(): FeedTransport & {
  urls: string[];
  send: (index: number, frame: unknown) => void;
  openAll: () => void;
} {
  const handlers: { onOpen: () => void; onMessage: (data: string) => void }[] = [];
  const urls: string[] = [];
  return {
    urls,
    open(url, h) {
      urls.push(url);
      handlers.push(h);
      return { close: () => {} };
    },
    openAll: () => { for (const h of handlers) h.onOpen(); },
    send: (index, frame) => handlers[index]!.onMessage(JSON.stringify(frame)),
  };
}

/*
 * Every registry a test builds, closed when the file is done.
 *
 * The registry runs a silence watchdog on a real `setInterval`, which is
 * correct in a browser and keeps the node test process alive forever if a test
 * simply walks away from one.
 */
const built: MarketFeedRegistry[] = [];
function registryWith(transport: FeedTransport): MarketFeedRegistry {
  const registry = new MarketFeedRegistry({ transport });
  built.push(registry);
  return registry;
}
after(() => { for (const r of built) r.closeAll(); });

const MIN = 60_000;

/** One Binance kline frame. `x` marks the frame that closes the source bar. */
const frame = (openTime: number, step: number, o: number, h: number, l: number,
  c: number, v: number, closed: boolean) => ({
  k: {
    t: openTime, T: openTime + step - 1,
    o: String(o), h: String(h), l: String(l), c: String(c), v: String(v), x: closed,
  },
});

function collect(registry: MarketFeedRegistry, symbol: string, resolution: string) {
  const ticks: KlineTick[] = [];
  const release = registry.subscribe(symbol, resolution, { onTick: (t) => ticks.push(t) });
  return { ticks, release };
}

test("a derived feed listens to its SOURCE stream, and never to a stream that does not exist", () => {
  const transport = fakeTransport();
  const registry = registryWith(transport);
  const { release } = collect(registry, "SOLUSDT", "45m");

  assert.equal(transport.urls.length, 1);
  assert.match(transport.urls[0]!, /solusdt@kline_15m$/,
    "there is no 45m kline stream; asking for one delivers nothing, quietly");
  assert.match(klineStreamUrl("SOLUSDT", "45m"), /kline_15m$/);
  release();
});

test("two resolutions that share a source share one socket", () => {
  const transport = fakeTransport();
  const registry = registryWith(transport);
  const a = collect(registry, "SOLUSDT", "15m");
  const b = collect(registry, "SOLUSDT", "45m");

  assert.equal(transport.urls.length, 1,
    "a workspace showing 15m and 45m on one instrument is listening to one thing");
  assert.equal(registry.activeFeeds, 1);
  a.release();
  b.release();
});

test("A BUCKET THE FEED DID NOT SEE THE START OF EMITS NOTHING", () => {
  /*
   * The honest answer to joining mid-bucket.
   *
   * A subscription that starts inside a 45-minute bucket has not seen that
   * bucket's earlier 15-minute bars, so it cannot know the bucket's open or its
   * volume. The chart keeps the server's own fold of that bucket — which is
   * exact — and the feed starts emitting at the next boundary, which it owns
   * from the first bar. The alternative was a bar that advances and is wrong.
   */
  const transport = fakeTransport();
  const registry = registryWith(transport);
  const { ticks } = collect(registry, "SOLUSDT", "45m");

  // The second 15m bar of the 00:00–00:45 bucket.
  transport.send(0, frame(15 * MIN, 15 * MIN, 50, 60, 40, 55, 9, true));
  assert.deepEqual(ticks, [], "a fragment must not be drawn as a bar");

  // The third, still inside the same unowned bucket.
  transport.send(0, frame(30 * MIN, 15 * MIN, 55, 70, 54, 65, 3, true));
  assert.deepEqual(ticks, []);

  // The next bucket begins, and this one the feed owns from its first bar.
  transport.send(0, frame(45 * MIN, 15 * MIN, 100, 101, 99, 100, 1, false));
  const owned: KlineTick[] = ticks;
  assert.equal(owned.length, 1);
  assert.equal(owned[0]!.openTime, 45 * MIN);
  assert.equal(owned[0]!.open, 100);
});

test("VOLUME IS ACCUMULATED PER SOURCE BAR, NOT PER FRAME", () => {
  /*
   * Binance sends a frame roughly every second and each one carries the source
   * bar's RUNNING TOTAL. Summing frames would multiply the bucket's volume by
   * however many arrived — a 45-minute bar reporting nine hundred times the
   * volume that traded.
   */
  const transport = fakeTransport();
  const registry = registryWith(transport);
  const { ticks } = collect(registry, "SOLUSDT", "45m");

  transport.send(0, frame(0, 15 * MIN, 100, 105, 99, 104, 2, false));
  transport.send(0, frame(0, 15 * MIN, 100, 108, 99, 107, 5, false));
  transport.send(0, frame(0, 15 * MIN, 100, 108, 98, 106, 6, true));
  assert.equal(ticks.at(-1)!.volume, 6, "one source bar, its own running total");

  transport.send(0, frame(15 * MIN, 15 * MIN, 106, 110, 105, 109, 1, false));
  transport.send(0, frame(15 * MIN, 15 * MIN, 106, 112, 105, 111, 4, true));
  assert.equal(ticks.at(-1)!.volume, 10, "the closed bar plus the running one");

  const latest = ticks.at(-1)!;
  assert.equal(latest.open, 100, "the bucket's open is its FIRST source bar's");
  assert.equal(latest.high, 112);
  assert.equal(latest.low, 98);
  assert.equal(latest.close, 111);
  assert.equal(latest.interval, "45m");
});

test("a derived bar closes when its bucket ends, not when a source bar does", () => {
  const transport = fakeTransport();
  const registry = registryWith(transport);
  const { ticks } = collect(registry, "SOLUSDT", "45m");

  transport.send(0, frame(0, 15 * MIN, 1, 1, 1, 1, 1, true));
  assert.equal(ticks.at(-1)!.closed, false, "one third of a 45-minute bar");
  transport.send(0, frame(15 * MIN, 15 * MIN, 1, 1, 1, 1, 1, true));
  assert.equal(ticks.at(-1)!.closed, false);
  transport.send(0, frame(30 * MIN, 15 * MIN, 1, 1, 1, 1, 1, true));
  assert.equal(ticks.at(-1)!.closed, true, "the LAST source bar of the bucket closed it");
  assert.equal(ticks.at(-1)!.closeTime, 45 * MIN - 1, "the grid's close time, always");
});

test("a seconds resolution folds from one-second frames", () => {
  const transport = fakeTransport();
  const registry = registryWith(transport);
  const { ticks } = collect(registry, "SOLUSDT", "5s");
  assert.match(transport.urls[0]!, /kline_1s$/,
    "sub-minute bars are never folded from minutes");

  for (let i = 0; i < 5; i++) {
    transport.send(0, frame(i * 1000, 1000, 10 + i, 12 + i, 9 + i, 11 + i, 1, true));
  }
  const last = ticks.at(-1)!;
  assert.equal(last.interval, "5s");
  assert.equal(last.openTime, 0);
  assert.equal(last.closeTime, 4999);
  assert.equal(last.open, 10);
  assert.equal(last.close, 15);
  assert.equal(last.volume, 5);
  assert.equal(last.closed, true);
});

test("a native feed is untouched: the frame is the tick", () => {
  const transport = fakeTransport();
  const registry = registryWith(transport);
  const { ticks } = collect(registry, "SOLUSDT", "15m");
  transport.send(0, frame(0, 15 * MIN, 100, 110, 90, 105, 7, true));
  assert.deepEqual(ticks, [{
    symbol: "SOLUSDT", interval: "15m",
    openTime: 0, closeTime: 15 * MIN - 1,
    open: 100, high: 110, low: 90, close: 105, volume: 7, closed: true,
  }]);
});

test("the feed key is the resolution; the socket key is the source", () => {
  assert.equal(feedKey("solusdt", "45m"), "SOLUSDT|45m");
  const transport = fakeTransport();
  const registry = registryWith(transport);
  const a = collect(registry, "SOLUSDT", "45m");
  const b = collect(registry, "SOLUSDT", "90m");
  // Two resolutions, two folds, one 30m/15m question — and never one socket per
  // pane, which is what this registry exists to prevent.
  assert.equal(registry.consumerCount, 2);
  assert.equal(transport.urls.length, 2, "45m folds from 15m, 90m from 30m");
  a.release();
  b.release();
});

test("subscribing to something that is not a resolution is a programming error, not a silent no-op", () => {
  const registry = registryWith(fakeTransport());
  assert.throws(() => registry.subscribe("SOLUSDT", "1w", {}), /not a resolution/);
});
