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
 * ── Deliberately browser-local ─────────────────────────────────────────────
 *
 * This is a per-tab concern and it stays in the tab. There is no server bus,
 * no shared worker, no backend fan-out: those would add an operational
 * component to solve a problem that a reference count solves.
 *
 * The reconnect ladder and the silence watchdog moved here unchanged from
 * `CandleChart`, so recovery behaviour is exactly what it was — it just
 * happens once per feed instead of once per chart.
 */
import type { Interval } from "./types";

/** How long a feed may be silent before it is treated as dead and reopened. */
export const WS_SILENCE_TIMEOUT_MS = 45_000;
const WS_WATCHDOG_INTERVAL_MS = 5_000;

/**
 * How long a feed with no consumers is kept before it is closed.
 *
 * Maximising a pane unmounts every other pane and remounts the survivor;
 * restoring does the reverse. Without a grace period the last consumer leaving
 * and the first consumer arriving happen in the same commit, so the socket is
 * closed and immediately reopened — a visible "connecting…" and a gap in live
 * prices caused entirely by a layout change. Two seconds is long enough to
 * span a remount and short enough that a feed nobody wants is not held.
 */
const RELEASE_GRACE_MS = 2_000;

export type FeedStatus = "idle" | "connecting" | "live" | "reconnecting" | "stale";

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
  onStatus?: (status: FeedStatus) => void;
}

/**
 * The socket shape the registry needs.
 *
 * An interface rather than `WebSocket` directly so the acceptance tests can
 * count connections deterministically without touching Binance.
 */
export interface FeedSocket {
  close: () => void;
}

export interface FeedTransport {
  open: (url: string, handlers: {
    onOpen: () => void;
    onMessage: (data: string) => void;
    onClose: () => void;
    onError: () => void;
  }) => FeedSocket;
}

/** Timer functions, injectable so a test never leaves an interval running. */
export interface FeedScheduler {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  now: () => number;
}

export const browserTransport: FeedTransport = {
  open(url, handlers) {
    const ws = new WebSocket(url);
    ws.onopen = () => handlers.onOpen();
    ws.onmessage = (event: MessageEvent) => handlers.onMessage(event.data as string);
    ws.onclose = () => handlers.onClose();
    ws.onerror = () => handlers.onError();
    return {
      close: () => {
        // Detach first: a close we asked for must not re-enter the ladder.
        ws.onopen = null; ws.onmessage = null; ws.onclose = null; ws.onerror = null;
        try { ws.close(); } catch { /* already gone */ }
      },
    };
  },
};

const realScheduler: FeedScheduler = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  now: () => Date.now(),
};

/** The subscription identity. Symbol case is not part of it. */
export function feedKey(symbol: string, interval: Interval): string {
  return `${symbol.toUpperCase()}|${interval}`;
}

export function klineStreamUrl(symbol: string, interval: Interval): string {
  return `wss://stream.binance.com:9443/ws/${symbol.toLowerCase()}@kline_${interval}`;
}

interface FeedEntry {
  key: string;
  symbol: string;
  interval: Interval;
  listeners: Set<FeedListener>;
  socket: FeedSocket | null;
  status: FeedStatus;
  attempt: number;
  lastMessageAt: number;
  reconnectTimer: unknown;
  watchdog: unknown;
  /** Set while the feed is being kept alive for a possible remount. */
  releaseTimer: unknown;
  closed: boolean;
}

interface RawKline {
  k?: {
    t: number; T: number; o: string; h: string; l: string; c: string; v: string; x: boolean;
  };
}

export class MarketFeedRegistry {
  private readonly entries = new Map<string, FeedEntry>();
  private readonly transport: FeedTransport;
  private readonly schedule: FeedScheduler;
  private opened = 0;
  private closedCount = 0;

  constructor(options: { transport?: FeedTransport; scheduler?: FeedScheduler } = {}) {
    this.transport = options.transport ?? browserTransport;
    this.schedule = options.scheduler ?? realScheduler;
  }

  /** Distinct upstream feeds currently open. The number that must not be 16. */
  get activeFeeds(): number {
    return this.entries.size;
  }

  /** Feeds held open with no consumers, waiting out the remount grace period. */
  get lingeringFeeds(): number {
    let total = 0;
    for (const entry of this.entries.values()) if (entry.releaseTimer !== null) total += 1;
    return total;
  }

  /** Total consumers attached across all feeds. */
  get consumerCount(): number {
    let total = 0;
    for (const entry of this.entries.values()) total += entry.listeners.size;
    return total;
  }

  /** Sockets opened and closed over this registry's life, for leak checks. */
  get socketsOpened(): number { return this.opened; }
  get socketsClosed(): number { return this.closedCount; }

  statusOf(symbol: string, interval: Interval): FeedStatus {
    return this.entries.get(feedKey(symbol, interval))?.status ?? "idle";
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
      entry = {
        key, symbol, interval, listeners: new Set(), socket: null, status: "idle",
        attempt: 0, lastMessageAt: 0, reconnectTimer: null, watchdog: null,
        releaseTimer: null, closed: false,
      };
      this.entries.set(key, entry);
      this.connect(entry);
      this.startWatchdog(entry);
    }
    if (entry.releaseTimer !== null) {
      // A pane came back before the grace period expired: keep the connection.
      this.schedule.clearTimeout(entry.releaseTimer);
      entry.releaseTimer = null;
    }
    entry.listeners.add(listener);
    // A late joiner is told the current state immediately rather than waiting
    // for the next frame, which on an idle market can be a minute away.
    listener.onStatus?.(entry.status);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.entries.get(key);
      if (!current) return;
      current.listeners.delete(listener);
      if (current.listeners.size > 0 || current.releaseTimer !== null) return;
      current.releaseTimer = this.schedule.setTimeout(() => {
        current.releaseTimer = null;
        // Re-checked: a consumer may have attached and detached again since.
        if (current.listeners.size === 0) this.teardown(current);
      }, RELEASE_GRACE_MS);
    };
  }

  /** Close every feed. Called when the workspace unmounts. */
  closeAll(): void {
    for (const entry of [...this.entries.values()]) {
      entry.listeners.clear();
      this.teardown(entry);
    }
  }

  private setStatus(entry: FeedEntry, status: FeedStatus): void {
    if (entry.status === status) return;
    entry.status = status;
    for (const listener of entry.listeners) listener.onStatus?.(status);
  }

  private connect(entry: FeedEntry): void {
    if (entry.closed) return;
    this.setStatus(entry, entry.attempt === 0 ? "connecting" : "reconnecting");
    this.opened += 1;
    entry.socket = this.transport.open(klineStreamUrl(entry.symbol, entry.interval), {
      onOpen: () => {
        if (entry.closed) return;
        entry.attempt = 0;
        entry.lastMessageAt = this.schedule.now();
        this.setStatus(entry, "live");
      },
      onMessage: (data) => this.handleMessage(entry, data),
      onClose: () => { if (!entry.closed) this.scheduleReconnect(entry); },
      onError: () => { /* a close always follows; the ladder runs there */ },
    });
  }

  private handleMessage(entry: FeedEntry, data: string): void {
    if (entry.closed) return;
    entry.lastMessageAt = this.schedule.now();
    this.setStatus(entry, "live");
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
    for (const listener of entry.listeners) listener.onTick?.(tick);
  }

  private scheduleReconnect(entry: FeedEntry): void {
    if (entry.closed) return;
    if (entry.socket) { entry.socket.close(); entry.socket = null; this.closedCount += 1; }
    entry.attempt += 1;
    this.setStatus(entry, "reconnecting");
    const delay = Math.min(1000 * 2 ** Math.min(entry.attempt, 5), 30_000);
    entry.reconnectTimer = this.schedule.setTimeout(() => {
      entry.reconnectTimer = null;
      this.connect(entry);
    }, delay);
  }

  private startWatchdog(entry: FeedEntry): void {
    entry.watchdog = this.schedule.setInterval(() => {
      if (entry.closed || entry.lastMessageAt === 0) return;
      if (this.schedule.now() - entry.lastMessageAt <= WS_SILENCE_TIMEOUT_MS) return;
      // Silent for too long. A socket that is open but delivering nothing looks
      // identical to a quiet market from the outside; treat it as dead.
      this.setStatus(entry, "stale");
      entry.lastMessageAt = this.schedule.now();
      this.scheduleReconnect(entry);
    }, WS_WATCHDOG_INTERVAL_MS);
  }

  private teardown(entry: FeedEntry): void {
    entry.closed = true;
    if (entry.releaseTimer !== null) {
      this.schedule.clearTimeout(entry.releaseTimer);
      entry.releaseTimer = null;
    }
    if (entry.reconnectTimer !== null) {
      this.schedule.clearTimeout(entry.reconnectTimer);
      entry.reconnectTimer = null;
    }
    if (entry.watchdog !== null) {
      this.schedule.clearInterval(entry.watchdog);
      entry.watchdog = null;
    }
    if (entry.socket) { entry.socket.close(); entry.socket = null; this.closedCount += 1; }
    this.entries.delete(entry.key);
  }
}

/**
 * The registry the application uses.
 *
 * One per tab. Module scope rather than React context because the chart page,
 * the watchlist and the order ticket are not in one provider tree, and a feed
 * that exists only inside one subtree is a feed the next consumer duplicates.
 */
export const marketFeed = new MarketFeedRegistry();
