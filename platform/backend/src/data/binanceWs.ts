/**
 * Binance spot kline WebSocket manager. Aggregates multiple (symbol, interval)
 * kline streams over one combined connection, persists every closed bar, and
 * emits 'barClose' when Binance flags a candle final ("x": true), and
 * 'barUpdate' for every forming tick in between.
 *
 * Only CLOSED bars are persisted. A forming candle's high/low/close still move,
 * so writing it would put provisional numbers into the candle history that
 * backtests and MA warmups read as final.
 *
 * Reconnects with capped backoff and re-subscribes the active stream set. On
 * (re)connect a REST gap-fill is the caller's job (the live runner backfills
 * missed bars before resuming), so a dropped connection never loses signals.
 */
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type { Candle, Interval } from "../types/market";
import { upsertCandles } from "../repositories/candles";

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

/** A still-forming candle. Same shape, but its values are provisional. */
export type BarUpdateEvent = BarCloseEvent;

function streamName(symbol: string, interval: Interval): string {
  return `${symbol.toLowerCase()}@kline_${interval}`;
}

export declare interface BinanceWsManager {
  on(event: "barClose", listener: (e: BarCloseEvent) => void): this;
  on(event: "barUpdate", listener: (e: BarUpdateEvent) => void): this;
  on(event: "open", listener: () => void): this;
  on(event: "close", listener: () => void): this;
  on(event: "error", listener: (err: Error) => void): this;
}

export class BinanceWsManager extends EventEmitter {
  private ws: WebSocket | null = null;
  private streams = new Set<string>();
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private rebuildTimer: NodeJS.Timeout | null = null;
  private closedByUser = false;

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
      this.emit("open");
    });

    ws.on("message", (raw: WebSocket.RawData) => {
      void this.handleMessage(raw.toString());
    });

    ws.on("error", (err) => this.emit("error", err as Error));

    ws.on("close", () => {
      this.emit("close");
      if (this.closedByUser || this.ws !== ws) return;
      this.ws = null;
      this.scheduleReconnect();
    });
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
    const event = { symbol: candle.symbol, interval: candle.interval, candle };

    // Forming bar: announce it, but never persist provisional values.
    if (!k.x) {
      this.emit("barUpdate", event);
      return;
    }

    try {
      await upsertCandles([candle]);
      this.emit("barClose", event);
    } catch (err) {
      this.emit("error", err as Error);
    }
  }

  close(): void {
    this.closedByUser = true;
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
