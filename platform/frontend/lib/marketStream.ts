"use client";
/**
 * The browser's connection to Binance's public market-data websocket.
 *
 * ── Why the origin is a list ────────────────────────────────────────────────
 *
 * `stream.binance.com` is the exchange's normal stream host and it is fenced
 * on some networks: the handshake is answered with HTTP 451 and the socket
 * closes before it ever opens. Binance publishes a market-data-only endpoint
 * for exactly that case, `data-stream.binance.vision`, which carries the same
 * public streams (kline, miniTicker, bookTicker) and no account or order
 * surface at all. It is listed first. The normal host stays as the second
 * candidate, so a network where the mirror is the one that is unreachable
 * still gets its prices.
 *
 * Every socket the browser opens to Binance goes through this file, and the
 * Content-Security-Policy in `next.config.mjs` names exactly these origins.
 * `tests/marketTransport.test.ts` asserts that the two lists agree, so an
 * origin cannot be added here and silently blocked by the policy.
 *
 * ── One registry for every stream ───────────────────────────────────────────
 *
 * The chart's kline feed, the watchlist's miniTicker stream and the order
 * ticket's bookTicker are three subscriptions with one lifecycle: open,
 * reconnect on close with a bounded ladder, rotate to the next origin when a
 * handshake is refused, treat silence as death, report an honest state, and
 * close only when the last consumer has gone. That lifecycle lives here once.
 * `lib/marketFeed` (kline parsing per pane), `lib/useWatchlistTickers` and
 * `lib/useBookQuote` are thin parsers over it.
 *
 * ── What "live" means ───────────────────────────────────────────────────────
 *
 * A socket that has completed its handshake is `open`; it becomes `live` only
 * when a frame has actually arrived. The distinction matters because the UI
 * must never say a price is streaming on the strength of a TCP connection
 * alone — a half-open socket looks exactly like a quiet market from outside.
 *
 * ── One socket, one reconnect chain ─────────────────────────────────────────
 *
 * A logical stream owns at most one socket and at most one pending reconnect
 * timer. Every path that opens a socket closes the one it replaces first;
 * every path that schedules a reconnect clears the one already waiting; and a
 * callback from a socket that is no longer the entry's current one is ignored
 * (`entry.socket === socket` is the ownership check). Without those three
 * rules the silence watchdog, firing every 45 s while a once-live host stays
 * unreachable, started a fresh ladder beside the one still running, and on
 * recovery every chain opened a socket of which only the last was tracked.
 */

/**
 * Supported public market-data websocket origins, in the order they are
 * tried. Both must appear in the CSP `connect-src`.
 */
export const MARKET_STREAM_ORIGINS: readonly string[] = [
  "wss://data-stream.binance.vision",
  "wss://stream.binance.com:9443",
];

/** How long a stream may be silent before it is treated as dead and reopened. */
export const STREAM_SILENCE_TIMEOUT_MS = 45_000;
const WATCHDOG_INTERVAL_MS = 5_000;
/**
 * A handshake that is refused fails within a round trip. Waiting the full
 * ladder step before trying the next origin would leave the chart without
 * prices for seconds on a network where the mirror was going to work at once.
 */
const REFUSED_ROTATE_DELAY_MS = 250;
/**
 * How long a stream with no consumers is kept before it is closed. Maximising
 * a pane unmounts every other pane and remounts the survivor; restoring does
 * the reverse. Without a grace period the last consumer leaving and the first
 * arriving happen in the same commit, so the socket is closed and immediately
 * reopened — a visible "connecting…" caused entirely by a layout change.
 */
const RELEASE_GRACE_MS = 2_000;

export type StreamStatus =
  | "idle" | "connecting" | "open" | "live" | "reconnecting" | "stale";

/** Everything a consumer may need to say something true about its stream. */
export interface StreamState {
  status: StreamStatus;
  /** The origin of the socket currently open or being opened; null when idle. */
  origin: string | null;
  /** Consecutive failed attempts since the last frame; 0 once live. */
  attempt: number;
  /** True once any frame has ever arrived over this subscription's life. */
  everLive: boolean;
  /** Origins whose handshake was refused since the stream was last live. */
  refused: readonly string[];
}

export interface StreamListener {
  /** One raw frame, as the socket delivered it. Parsing is the caller's. */
  onMessage?: (data: string) => void;
  onState?: (state: StreamState) => void;
}

export interface StreamSocket {
  close: () => void;
}

/**
 * The socket shape the registry needs — an interface rather than `WebSocket`
 * so the tests can count connections deterministically without Binance.
 */
export interface StreamTransport {
  open: (url: string, handlers: {
    onOpen: () => void;
    onMessage: (data: string) => void;
    onClose: () => void;
    onError: () => void;
  }) => StreamSocket;
}

/** Timer functions, injectable so a test never leaves an interval running. */
export interface StreamScheduler {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  now: () => number;
}

export const browserStreamTransport: StreamTransport = {
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

const realScheduler: StreamScheduler = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  now: () => Date.now(),
};

/** `/ws/<stream>` — one raw stream. */
export function singleStreamPath(stream: string): string {
  return `/ws/${stream}`;
}

/** `/stream?streams=a/b/c` — several streams multiplexed on one socket. */
export function combinedStreamPath(streams: readonly string[]): string {
  return `/stream?streams=${streams.join("/")}`;
}

export function klineStreamName(symbol: string, interval: string): string {
  return `${symbol.toLowerCase()}@kline_${interval}`;
}

export function miniTickerStreamName(symbol: string): string {
  return `${symbol.toLowerCase()}@miniTicker`;
}

export function bookTickerStreamName(symbol: string): string {
  return `${symbol.toLowerCase()}@bookTicker`;
}

export function streamUrl(origin: string, path: string): string {
  return `${origin}${path}`;
}

/** The reconnect ladder: 2s, 4s, 8s, 16s, 30s, 30s… Never gives up. */
export function reconnectDelayMs(attempt: number): number {
  return Math.min(1000 * 2 ** Math.min(attempt, 5), 30_000);
}

interface StreamEntry {
  key: string;
  path: string;
  listeners: Set<StreamListener>;
  socket: StreamSocket | null;
  status: StreamStatus;
  origin: string | null;
  /** Index into the origin list for the NEXT connection attempt. */
  originIndex: number;
  attempt: number;
  everLive: boolean;
  refused: string[];
  /** Whether the current socket completed its handshake. */
  opened: boolean;
  lastMessageAt: number;
  reconnectTimer: unknown;
  watchdog: unknown;
  releaseTimer: unknown;
  closed: boolean;
}

export interface MarketStreamRegistryOptions {
  transport?: StreamTransport;
  scheduler?: StreamScheduler;
  origins?: readonly string[];
}

export class MarketStreamRegistry {
  private readonly entries = new Map<string, StreamEntry>();
  private readonly transport: StreamTransport;
  private readonly schedule: StreamScheduler;
  private readonly origins: readonly string[];
  private readonly observers = new Set<() => void>();
  /**
   * The origin most recently proven to deliver frames. A new subscription
   * starts there rather than at the top of the list, so on a network where
   * the first candidate is fenced only the first stream pays for finding out.
   */
  private preferredIndex = 0;
  private opened = 0;
  private closedCount = 0;

  constructor(options: MarketStreamRegistryOptions = {}) {
    this.transport = options.transport ?? browserStreamTransport;
    this.schedule = options.scheduler ?? realScheduler;
    const origins = options.origins ?? MARKET_STREAM_ORIGINS;
    if (origins.length === 0) throw new Error("MarketStreamRegistry needs at least one origin");
    this.origins = origins;
  }

  /** Distinct upstream sockets currently held (open, reconnecting or lingering). */
  get activeStreams(): number { return this.entries.size; }

  /** Streams held open with no consumers, waiting out the remount grace period. */
  get lingeringStreams(): number {
    let total = 0;
    for (const entry of this.entries.values()) if (entry.releaseTimer !== null) total += 1;
    return total;
  }

  /** Total consumers attached across all streams. */
  get consumerCount(): number {
    let total = 0;
    for (const entry of this.entries.values()) total += entry.listeners.size;
    return total;
  }

  /** Sockets opened and closed over this registry's life, for leak checks. */
  get socketsOpened(): number { return this.opened; }
  get socketsClosed(): number { return this.closedCount; }

  /** The origin a brand-new subscription would try first. */
  get preferredOrigin(): string { return this.origins[this.preferredIndex]!; }

  stateOf(key: string): StreamState {
    const entry = this.entries.get(key);
    return entry ? snapshot(entry) : IDLE_STATE;
  }

  /** Every held stream's state, keyed — for a registry-wide summary. */
  states(): Map<string, StreamState> {
    const out = new Map<string, StreamState>();
    for (const [key, entry] of this.entries) out.set(key, snapshot(entry));
    return out;
  }

  /**
   * Be told whenever any stream's state changes. For surfaces that summarise
   * the whole tab's market connectivity rather than one stream.
   */
  observe(fn: () => void): () => void {
    this.observers.add(fn);
    return () => { this.observers.delete(fn); };
  }

  /**
   * Attach a consumer to the stream at `path`, identified by `key`.
   *
   * The returned function detaches it and is the only way a socket is ever
   * closed. Calling it twice is harmless, so a React effect that runs its
   * cleanup twice cannot close a stream another consumer is still using.
   */
  subscribe(key: string, path: string, listener: StreamListener): () => void {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        key, path, listeners: new Set(), socket: null, status: "idle", origin: null,
        originIndex: this.preferredIndex, attempt: 0, everLive: false, refused: [],
        opened: false, lastMessageAt: 0, reconnectTimer: null, watchdog: null,
        releaseTimer: null, closed: false,
      };
      this.entries.set(key, entry);
      this.connect(entry);
      this.startWatchdog(entry);
    }
    if (entry.releaseTimer !== null) {
      // A consumer came back before the grace period expired: keep the socket.
      this.schedule.clearTimeout(entry.releaseTimer);
      entry.releaseTimer = null;
    }
    entry.listeners.add(listener);
    // A late joiner is told the current state at once rather than waiting for
    // the next transition, which on an idle stream may never come.
    listener.onState?.(snapshot(entry));

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

  /** Close every stream. Called when the workspace unmounts. */
  closeAll(): void {
    for (const entry of [...this.entries.values()]) {
      entry.listeners.clear();
      this.teardown(entry);
    }
  }

  private publish(entry: StreamEntry): void {
    const state = snapshot(entry);
    for (const listener of entry.listeners) {
      try { listener.onState?.(state); }
      catch (error) { reportListenerError(error); }
    }
    for (const observer of this.observers) {
      try { observer(); }
      catch (error) { reportListenerError(error); }
    }
  }

  private setStatus(entry: StreamEntry, status: StreamStatus): void {
    if (entry.status === status) return;
    entry.status = status;
    this.publish(entry);
  }

  private connect(entry: StreamEntry): void {
    if (entry.closed) return;
    // Ownership moves to the socket opened below: whatever the entry still
    // holds — a handshake that never resolved, or a socket a stale caller
    // would have left behind — is closed first, and no reconnect stays
    // pending beside a live attempt.
    this.closeSocket(entry);
    this.clearReconnect(entry);
    // The silence clock belongs to the socket being opened: a handshake in
    // flight is not judged by how long ago the previous socket last spoke.
    // (Zero means "never opened", which keeps the watchdog off until then.)
    if (entry.lastMessageAt !== 0) entry.lastMessageAt = this.schedule.now();
    entry.origin = this.origins[entry.originIndex % this.origins.length]!;
    entry.opened = false;
    entry.status = entry.attempt === 0 ? "connecting" : "reconnecting";
    this.publish(entry);
    this.opened += 1;
    const socket = this.transport.open(streamUrl(entry.origin, entry.path), {
      onOpen: () => {
        if (entry.closed || entry.socket !== socket) return;
        entry.opened = true;
        entry.lastMessageAt = this.schedule.now();
        // Open is not live: nothing has been received yet.
        this.setStatus(entry, "open");
      },
      onMessage: (data) => { if (entry.socket === socket) this.handleMessage(entry, data); },
      onClose: () => { if (!entry.closed && entry.socket === socket) this.scheduleReconnect(entry, "closed"); },
      onError: () => { /* a close always follows; the ladder runs there */ },
    });
    entry.socket = socket;
  }

  private handleMessage(entry: StreamEntry, data: string): void {
    if (entry.closed) return;
    entry.lastMessageAt = this.schedule.now();
    if (entry.status !== "live") {
      // Frames are the only evidence of liveness. The first one also settles
      // which origin works, for every subscription that comes after.
      entry.attempt = 0;
      entry.everLive = true;
      entry.refused = [];
      this.preferredIndex = entry.originIndex % this.origins.length;
      this.setStatus(entry, "live");
    }
    for (const listener of entry.listeners) {
      // One consumer throwing must not starve the others of the same frame.
      try { listener.onMessage?.(data); }
      catch (error) { reportListenerError(error); }
    }
  }

  /**
   * `cause` says why the current socket is being given up: `closed` when the
   * socket itself closed (a refused handshake is one whose close arrived
   * before its open), `silent` when the watchdog gave up on it. Only a socket
   * that actually closed can have been refused; a host that is merely being
   * waited on must not be named as one that refused.
   */
  private scheduleReconnect(entry: StreamEntry, cause: "closed" | "silent"): void {
    if (entry.closed) return;
    this.closeSocket(entry);
    // One chain per stream: a reconnect already waiting is replaced, never joined.
    this.clearReconnect(entry);
    const refusedHandshake = cause === "closed" && !entry.opened;
    if (refusedHandshake && entry.origin && !entry.refused.includes(entry.origin)) {
      entry.refused = [...entry.refused, entry.origin];
    }
    entry.attempt += 1;
    // A refused handshake moves to the next origin almost at once, because the
    // answer is already known. A socket that was open and dropped — the
    // exchange recycles connections daily — retries its own origin first, and
    // rotates only when that fails again.
    if (refusedHandshake || entry.attempt > 1) entry.originIndex += 1;
    const untriedRemain = entry.attempt < this.origins.length;
    const delay = refusedHandshake && untriedRemain
      ? REFUSED_ROTATE_DELAY_MS
      : reconnectDelayMs(entry.attempt);
    this.setStatus(entry, "reconnecting");
    entry.reconnectTimer = this.schedule.setTimeout(() => {
      entry.reconnectTimer = null;
      this.connect(entry);
    }, delay);
  }

  private startWatchdog(entry: StreamEntry): void {
    entry.watchdog = this.schedule.setInterval(() => {
      if (entry.closed || entry.lastMessageAt === 0) return;
      // No socket means a reconnect is already waiting; the ladder owns the
      // recovery, and a second chain here is exactly the leak being avoided.
      if (entry.socket === null) return;
      if (this.schedule.now() - entry.lastMessageAt <= STREAM_SILENCE_TIMEOUT_MS) return;
      // Silent for too long. A socket that is open but delivering nothing looks
      // identical to a quiet market from the outside; treat it as dead.
      this.setStatus(entry, "stale");
      entry.lastMessageAt = this.schedule.now();
      this.scheduleReconnect(entry, "silent");
    }, WATCHDOG_INTERVAL_MS);
  }

  /** Close and forget the entry's current socket, if any. Idempotent. */
  private closeSocket(entry: StreamEntry): void {
    if (!entry.socket) return;
    entry.socket.close();
    entry.socket = null;
    this.closedCount += 1;
  }

  /** Drop the pending reconnect, if any. Idempotent. */
  private clearReconnect(entry: StreamEntry): void {
    if (entry.reconnectTimer === null) return;
    this.schedule.clearTimeout(entry.reconnectTimer);
    entry.reconnectTimer = null;
  }

  private teardown(entry: StreamEntry): void {
    entry.closed = true;
    if (entry.releaseTimer !== null) {
      this.schedule.clearTimeout(entry.releaseTimer);
      entry.releaseTimer = null;
    }
    this.clearReconnect(entry);
    if (entry.watchdog !== null) {
      this.schedule.clearInterval(entry.watchdog);
      entry.watchdog = null;
    }
    this.closeSocket(entry);
    this.entries.delete(entry.key);
    for (const observer of this.observers) {
      try { observer(); } catch (error) { reportListenerError(error); }
    }
  }
}

const IDLE_STATE: StreamState = {
  status: "idle", origin: null, attempt: 0, everLive: false, refused: [],
};

function snapshot(entry: StreamEntry): StreamState {
  return {
    status: entry.status, origin: entry.origin, attempt: entry.attempt,
    everLive: entry.everLive, refused: entry.refused,
  };
}

function reportListenerError(error: unknown): void {
  if (typeof console !== "undefined") console.error("market stream listener failed", error);
}

/**
 * The words the UI uses for a stream's state.
 *
 * `label` is short enough for a chip; `detail` is the sentence behind it. The
 * cause is named whenever it is known: a user on a fenced network should read
 * "refused" and the host, not "reconnecting…" forever.
 */
export function describeStreamState(state: StreamState): { label: string; detail: string } {
  const host = (origin: string): string => origin.replace(/^wss?:\/\//, "");
  const everyOriginRefused = state.refused.length >= MARKET_STREAM_ORIGINS.length;
  switch (state.status) {
    case "idle":
      return { label: "not live", detail: "No live stream is attached." };
    case "connecting":
      return {
        label: "connecting…",
        detail: state.origin ? `Opening the market stream at ${host(state.origin)}.` : "Opening the market stream.",
      };
    case "open":
      return {
        label: "connected — waiting for data",
        detail: state.origin
          ? `Connected to ${host(state.origin)}; no update has arrived yet.`
          : "Connected; no update has arrived yet.",
      };
    case "live":
      return {
        label: "live",
        detail: state.origin ? `Streaming from ${host(state.origin)}.` : "Streaming.",
      };
    case "reconnecting": {
      if (everyOriginRefused && !state.everLive) {
        return {
          label: "live stream unavailable — history still updates",
          detail: `Every market stream host refused the connection (${state.refused.map(host).join(", ")}). ` +
            "Candle history keeps loading through this app's own server; prices on screen are not streaming. " +
            "This usually means the network blocks Binance's stream hosts. Retrying.",
        };
      }
      if (state.refused.length > 0) {
        return {
          label: "stream refused — trying another host…",
          detail: `${state.refused.map(host).join(", ")} refused the connection` +
            (state.origin ? `; trying ${host(state.origin)}.` : "."),
        };
      }
      return {
        label: "reconnecting…",
        detail: state.origin
          ? `The market stream dropped; reconnecting to ${host(state.origin)}.`
          : "The market stream dropped; reconnecting.",
      };
    }
    case "stale":
      return {
        label: "feed stalled — price is not current",
        detail: "The market stream has been silent too long; it is being reopened.",
      };
  }
}

/**
 * The registry the application uses: one per tab, module scope, because the
 * chart, the watchlist and the order ticket are not in one provider tree.
 */
export const marketStreams = new MarketStreamRegistry();
