"use client";
/**
 * One upstream kline stream per instrument-and-resolution, however many panes
 * are looking at it.
 *
 * ── Why this had to stop being per-component ───────────────────────────────
 *
 * Every `CandleChart` used to open its own `wss://…@kline_<interval>` socket in
 * a `useEffect`. With one chart that is the same thing as a shared feed. With
 * sixteen panes on BTCUSDT 15m it is sixteen connections to Binance carrying
 * byte-identical frames, sixteen JSON parses per tick, sixteen reconnect
 * ladders and sixteen watchdogs — all to draw the same bar.
 *
 * The registry keys a subscription by `SYMBOL|interval`, which is the whole of
 * this feed's identity. The first consumer opens the socket; every equivalent
 * consumer after it attaches to the same one; the socket closes once the last
 * consumer has detached and a short remount grace period has passed. Cost
 * therefore tracks *distinct feeds*, which is the real resource, rather than
 * pane count, which is a layout choice.
 *
 * ── Where the socket itself lives ──────────────────────────────────────────
 *
 * The connection, the origin fallback, the reconnect ladder and the silence
 * watchdog are `lib/marketStream`'s, shared with the watchlist and the order
 * ticket. This file is the kline parser on top: one `JSON.parse` per frame
 * per feed, fanned out to every pane as a typed tick.
 *
 * This is a per-tab concern and it stays in the tab. There is no server bus,
 * no shared worker, no backend fan-out: those would add an operational
 * component to solve a problem that a reference count solves.
 */
import {
  klineStreamName, MARKET_STREAM_ORIGINS, MarketStreamRegistry, marketStreams,
  singleStreamPath, streamUrl, STREAM_SILENCE_TIMEOUT_MS,
  type StreamScheduler, type StreamSocket, type StreamState, type StreamStatus,
  type StreamTransport,
} from "./marketStream";
import type { Interval } from "./types";

/** How long a feed may be silent before it is treated as dead and reopened. */
export const WS_SILENCE_TIMEOUT_MS = STREAM_SILENCE_TIMEOUT_MS;

export type FeedStatus = StreamStatus;
export type FeedState = StreamState;

/** One kline frame, already parsed. */
export interface KlineTick {
  symbol: string;
  interval: Interval;
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** True on the frame that closes the bar. */
  closed: boolean;
}

export interface FeedListener {
  onTick?: (tick: KlineTick) => void;
  /** Status transitions, with the full state behind them. */
  onStatus?: (status: FeedStatus, state: FeedState) => void;
}

/** Kept as aliases so the transport fixtures read the same in every test. */
export type FeedSocket = StreamSocket;
export type FeedTransport = StreamTransport;
export type FeedScheduler = StreamScheduler;

/** The subscription identity. Symbol case is not part of it. */
export function feedKey(symbol: string, interval: Interval): string {
  return `${symbol.toUpperCase()}|${interval}`;
}

/** The kline stream's URL at one origin — the first supported one by default. */
export function klineStreamUrl(
  symbol: string, interval: Interval, origin: string = MARKET_STREAM_ORIGINS[0]!
): string {
  return streamUrl(origin, singleStreamPath(klineStreamName(symbol, interval)));
}

interface RawKline {
  k?: {
    t: number; T: number; o: string; h: string; l: string; c: string; v: string; x: boolean;
  };
}

interface FeedEntry {
  symbol: string;
  interval: Interval;
  listeners: Set<FeedListener>;
  release: () => void;
  state: FeedState;
}

export interface MarketFeedRegistryOptions {
  transport?: StreamTransport;
  scheduler?: StreamScheduler;
  origins?: readonly string[];
  /** Share an existing stream registry instead of creating one. */
  streams?: MarketStreamRegistry;
}

export class MarketFeedRegistry {
  private readonly entries = new Map<string, FeedEntry>();
  readonly streams: MarketStreamRegistry;

  constructor(options: MarketFeedRegistryOptions = {}) {
    this.streams = options.streams ?? new MarketStreamRegistry({
      transport: options.transport, scheduler: options.scheduler, origins: options.origins,
    });
  }

  /** Distinct upstream feeds currently open. The number that must not be 16. */
  get activeFeeds(): number { return this.streams.activeStreams; }

  /** Feeds held open with no consumers, waiting out the remount grace period. */
  get lingeringFeeds(): number { return this.streams.lingeringStreams; }

  /** Total consumers attached across all feeds. */
  get consumerCount(): number {
    let total = 0;
    for (const entry of this.entries.values()) total += entry.listeners.size;
    return total;
  }

  /** Sockets opened and closed over this registry's life, for leak checks. */
  get socketsOpened(): number { return this.streams.socketsOpened; }
  get socketsClosed(): number { return this.streams.socketsClosed; }

  statusOf(symbol: string, interval: Interval): FeedStatus {
    return this.stateOf(symbol, interval).status;
  }

  stateOf(symbol: string, interval: Interval): FeedState {
    return this.streams.stateOf(feedKey(symbol, interval));
  }

  /**
   * Attach a consumer. The returned function detaches it, and is the only way
   * a socket is ever closed.
   *
   * Calling the returned function twice is harmless: the second call finds the
   * listener already gone and does nothing, so a React effect that runs its
   * cleanup twice cannot close a feed another pane is still using.
   */
  subscribe(symbol: string, interval: Interval, listener: FeedListener): () => void {
    const key = feedKey(symbol, interval);
    let entry = this.entries.get(key);
    if (!entry) {
      const created: FeedEntry = {
        symbol: symbol.toUpperCase(), interval, listeners: new Set(),
        release: () => {},
        state: { status: "idle", origin: null, attempt: 0, everLive: false, refused: [] },
      };
      created.release = this.streams.subscribe(
        key, singleStreamPath(klineStreamName(symbol, interval)), {
          onMessage: (data) => this.handleMessage(created, data),
          onState: (state) => {
            created.state = state;
            for (const l of created.listeners) l.onStatus?.(state.status, state);
          },
        });
      this.entries.set(key, created);
      entry = created;
    }
    entry.listeners.add(listener);
    // A late joiner is told the current state immediately rather than waiting
    // for the next frame, which on an idle market can be a minute away.
    listener.onStatus?.(entry.state.status, entry.state);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.entries.get(key);
      if (!current) return;
      current.listeners.delete(listener);
      if (current.listeners.size > 0) return;
      // The stream registry keeps the socket through its own grace period; if
      // a pane comes back in time it re-attaches to the same socket.
      this.entries.delete(key);
      current.release();
    };
  }

  /** Close every feed. Called when the workspace unmounts. */
  closeAll(): void {
    for (const entry of this.entries.values()) {
      entry.listeners.clear();
      entry.release();
    }
    this.entries.clear();
    this.streams.closeAll();
  }

  private handleMessage(entry: FeedEntry, data: string): void {
    let parsed: RawKline;
    try { parsed = JSON.parse(data) as RawKline; }
    catch { return; /* a malformed frame is dropped; the next one replaces it */ }
    const k = parsed.k;
    if (!k) return;
    // Parsed once per feed rather than once per pane — the whole point.
    const tick: KlineTick = {
      symbol: entry.symbol, interval: entry.interval,
      openTime: k.t, closeTime: k.T,
      open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v,
      closed: k.x === true,
    };
    for (const listener of entry.listeners) {
      // One pane throwing — `update()` on a bar older than the series holds,
      // say — must not stop the other panes receiving the same bar.
      try { listener.onTick?.(tick); }
      catch (error) {
        if (typeof console !== "undefined") console.error("kline listener failed", error);
      }
    }
  }
}

/**
 * The registry the application uses.
 *
 * One per tab. Module scope rather than React context because the chart page,
 * the watchlist and the order ticket are not in one provider tree, and a feed
 * that exists only inside one subtree is a feed the next consumer duplicates.
 * It shares the tab's one stream registry with the watchlist and the ticket.
 */
export const marketFeed = new MarketFeedRegistry({ streams: marketStreams });
