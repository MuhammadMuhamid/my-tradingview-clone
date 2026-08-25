/**
 * Binance spot kline WebSocket manager. Aggregates multiple (symbol, interval)
 * kline streams over one combined connection, persists every closed bar, and
 * emits 'barClose' when Binance flags a candle final ("x": true).
 *
 * Forming candles are emitted as 'barUpdate' and never written to the database:
 * only a closed bar is a fact about the market. See BarUpdateEvent.
 *
 * Reconnects with capped backoff and re-subscribes the active stream set. On
 * (re)connect a REST gap-fill is the caller's job (the live runner backfills
 * missed bars before resuming), so a dropped connection never loses signals.
 */
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type { Candle, Interval } from "../types/market";
import { upsertCandles } from "../repositories/candles";
import { WS_SILENCE_TIMEOUT_MS } from "./feedHealth";

const WS_BASE = "wss://stream.binance.com:9443/stream";
const MAX_STREAMS_PER_CONN = 200; // Binance allows up to 1024; stay conservative

interface RawKlineMsg {
  stream: string;
  data: {
    e: "kline";
    s: string; // symbol
    k: {
      t: number; T: number; i: string;
      o: string; h: string; l: string; c: string; v: string; q: string; n: number;
      x: boolean; // is this kline closed?
    };
  };
}

export interface BarCloseEvent {
  symbol: string;
  interval: Interval;
  candle: Candle;
}

/**
 * A snapshot of the candle currently FORMING. Binance sends one roughly every
 * second on a kline stream, whether or not anything is listening.
 *
 * The candle is deliberately NOT persisted. `upsertCandles` on a forming bar
 * would write an unfinished high/low/close into the candle store, and every
 * backtest, indicator and chart that later read that row would be reading a
 * bar that never existed — a silent corruption that survives long after the
 * websocket frame is forgotten. Only closed bars are written; a forming bar is
 * an observation, and lives no longer than the listener that reads it.
 */
export interface BarUpdateEvent {
  symbol: string;
  interval: Interval;
  candle: Candle;
}

/** Emitted when a nominally-open connection has gone silent and is rebuilt. */
export interface StaleEvent {
  silentForMs: number;
  streams: number;
}

function streamName(symbol: string, interval: Interval): string {
  return `${symbol.toLowerCase()}@kline_${interval}`;
}

// Declaration merging is the standard way to give EventEmitter typed events.
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export declare interface BinanceWsManager {
  on(event: "barClose", listener: (e: BarCloseEvent) => void): this;
  on(event: "barUpdate", listener: (e: BarUpdateEvent) => void): this;
  on(event: "open", listener: () => void): this;
  on(event: "close", listener: () => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  on(event: "stale", listener: (e: StaleEvent) => void): this;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class BinanceWsManager extends EventEmitter {
  private ws: WebSocket | null = null;
  private streams = new Set<string>();
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private rebuildTimer: NodeJS.Timeout | null = null;
  private closedByUser = false;
  /**
   * Watchdog state. A socket can sit in readyState OPEN while delivering
   * nothing — a half-open TCP connection, or a server that has stopped sending.
   * `isConnected()` returns true throughout, which is exactly why nothing
   * noticed: prices froze while still being displayed as live.
   */
  private lastMessageAt = 0;
  private watchdogTimer: NodeJS.Timeout | null = null;

  /** subscriptions map streamName → set of intervals is implicit in the name. */
  subscribe(symbol: string, interval: Interval): void {
    const name = streamName(symbol, interval);
    if (this.streams.has(name)) return;
    if (this.streams.size >= MAX_STREAMS_PER_CONN) {
      throw new Error(`stream limit ${MAX_STREAMS_PER_CONN} reached`);
    }
    this.streams.add(name);
    this.reconnect();
  }

  unsubscribe(symbol: string, interval: Interval): void {
    if (this.streams.delete(streamName(symbol, interval))) this.reconnect();
  }

  get subscriptionCount(): number {
    return this.streams.size;
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Milliseconds since the last message on ANY subscribed stream, or null when
   * nothing has arrived yet. Connectivity alone is not liveness, so this is
   * what the health surface reads rather than `isConnected()`.
   */
  silentForMs(now = Date.now()): number | null {
    if (this.lastMessageAt === 0) return null;
    return now - this.lastMessageAt;
  }

  /**
   * True when the transport should not be trusted: either not open, or open and
   * silent past the timeout. This is the value `assessFeed` takes as
   * `transportDown`.
   */
  isTransportDown(now = Date.now()): boolean {
    if (!this.isConnected()) return true;
    const silent = this.silentForMs(now);
    return silent !== null && silent > WS_SILENCE_TIMEOUT_MS;
  }

  /**
   * Rebuild the connection with the current stream set. Debounced: several
   * subscribe()/unsubscribe() calls in the same tick (e.g. one per MTF feed of
   * a deployment) coalesce into a single connect, avoiding a reconnect storm.
   */
  private reconnect(): void {
    if (this.rebuildTimer) return;
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null;
      this.doRebuild();
    }, 50);
  }

  private doRebuild(): void {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws) {
      const old = this.ws;
      this.ws = null;
      old.removeAllListeners();
      // A socket closed mid-handshake emits 'error'; without a listener that
      // crashes the process. Swallow it on the discarded socket.
      old.on("error", () => {});
      try { old.close(); } catch { /* ignore */ }
    }
    if (this.streams.size === 0) return;
    this.connect();
  }

  private connect(): void {
    const url = `${WS_BASE}?streams=${[...this.streams].join("/")}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on("open", () => {
      this.reconnectAttempts = 0;
      this.lastMessageAt = Date.now();
      this.startWatchdog();
      this.emit("open");
    });

    ws.on("message", (raw: WebSocket.RawData) => {
      // Every frame counts, closed bar or not: liveness is about the transport,
      // not about whether this particular message was interesting.
      this.lastMessageAt = Date.now();
      void this.handleMessage(raw.toString());
    });

    // `ws` answers ping frames automatically, but a pong is also proof the
    // connection is alive, so it resets the watchdog too.
    ws.on("ping", () => { this.lastMessageAt = Date.now(); });
    ws.on("pong", () => { this.lastMessageAt = Date.now(); });

    ws.on("error", (err) => this.emit("error", err as Error));

    ws.on("close", () => {
      this.emit("close");
      if (this.closedByUser || this.ws !== ws) return;
      this.ws = null;
      this.stopWatchdog();
      this.scheduleReconnect();
    });
  }

  /**
   * Force a rebuild when the connection has gone silent for longer than a
   * stream this active could plausibly be quiet.
   */
  private startWatchdog(): void {
    this.stopWatchdog();
    const period = Math.max(5_000, Math.floor(WS_SILENCE_TIMEOUT_MS / 3));
    this.watchdogTimer = setInterval(() => {
      if (this.closedByUser || this.streams.size === 0) return;
      const silent = this.silentForMs();
      if (silent === null || silent <= WS_SILENCE_TIMEOUT_MS) return;
      this.emit("stale", { silentForMs: silent, streams: this.streams.size });
      // Reset first, so the rebuilt socket is not judged on the old timestamp.
      this.lastMessageAt = Date.now();
      this.doRebuild();
    }, period);
    // A watchdog must never be the reason a process refuses to exit.
    this.watchdogTimer.unref?.();
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.watchdogTimer = null;
  }

  private scheduleReconnect(): void {
    if (this.streams.size === 0) return;
    this.reconnectAttempts += 1;
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 30_000);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private async handleMessage(text: string): Promise<void> {
    let msg: RawKlineMsg;
    try {
      msg = JSON.parse(text) as RawKlineMsg;
    } catch {
      return;
    }
    if (!msg.data || msg.data.e !== "kline") return;
    const k = msg.data.k;
    // Nothing is watching forming bars on this manager — the live strategy
    // runner never does — so do not pay to parse one. This keeps the cost of
    // the intrabar feature exactly zero for the callers that do not use it.
    if (!k.x && this.listenerCount("barUpdate") === 0) return;
    const candle: Candle = {
      symbol: msg.data.s,
      interval: k.i as Interval,
      openTime: k.t,
      open: parseFloat(k.o),
      high: parseFloat(k.h),
      low: parseFloat(k.l),
      close: parseFloat(k.c),
      volume: parseFloat(k.v),
      quoteVolume: parseFloat(k.q),
      tradeCount: k.n,
      closeTime: k.T,
    };

    // A forming bar is announced but never stored. See BarUpdateEvent for why
    // persisting one would corrupt every later read of the candle store.
    if (!k.x) {
      this.emit("barUpdate", { symbol: candle.symbol, interval: candle.interval, candle });
      return;
    }

    try {
      await upsertCandles([candle]);
      this.emit("barClose", { symbol: candle.symbol, interval: candle.interval, candle });
    } catch (err) {
      this.emit("error", err as Error);
    }
  }

  close(): void {
    this.closedByUser = true;
    this.stopWatchdog();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    this.streams.clear();
    if (this.ws) {
      const old = this.ws;
      this.ws = null;
      old.removeAllListeners();
      old.on("error", () => {});
      try { old.close(); } catch { /* ignore */ }
    }
  }
}
