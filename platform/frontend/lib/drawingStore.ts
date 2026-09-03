"use client";
/**
 * One authority for drawings, shared by every pane showing an instrument.
 *
 * ── Why a store and not a `useState` per pane ──────────────────────────────
 *
 * Drawings are canonically keyed by symbol — that is `lib/drawings`, and this
 * wave does not change it. With one chart, "load on symbol change, save on
 * edit" was enough. With several panes it is not: two panes on BTCUSDT would
 * each hold their own copy, each write the whole store on every edit, and the
 * one that wrote last would silently erase the other's work.
 *
 * So the per-symbol list lives here, panes subscribe to it, and an edit in any
 * pane is immediately the truth in all of them. Closing a pane unsubscribes;
 * it does not delete anything, because losing a *view* of a drawing has never
 * been a request to remove the drawing.
 *
 * ── The write that used to happen sixty times a second ─────────────────────
 *
 * Dragging a trendline fires `onChange` on every mousemove, and the old path
 * ran `JSON.parse` of the entire multi-symbol store, then `JSON.stringify` of
 * it, then a synchronous `localStorage.setItem` — for every symbol's drawings,
 * on every pointer sample. Memory is updated synchronously here (the canvas
 * needs it that frame) and the disk write is coalesced onto the next idle
 * moment, with a flush on page hide so nothing is lost.
 */
import { loadDrawings, saveDrawings, type Drawing } from "./drawings";

type Listener = (drawings: Drawing[]) => void;

const PERSIST_DELAY_MS = 400;

class DrawingStore {
  private readonly cache = new Map<string, Drawing[]>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly dirty = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private hideHandlerAttached = false;

  /** The current list for a symbol, loading it from storage on first ask. */
  get(symbol: string): Drawing[] {
    const existing = this.cache.get(symbol);
    if (existing) return existing;
    const loaded = loadDrawings(symbol);
    this.cache.set(symbol, loaded);
    return loaded;
  }

  /**
   * Watch one symbol. The listener is called immediately with the current
   * list, then on every change from any pane.
   */
  subscribe(symbol: string, listener: Listener): () => void {
    let set = this.listeners.get(symbol);
    if (!set) { set = new Set(); this.listeners.set(symbol, set); }
    set.add(listener);
    this.attachHideFlush();
    listener(this.get(symbol));
    return () => {
      const current = this.listeners.get(symbol);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.listeners.delete(symbol);
    };
  }

  /** Replace a symbol's drawings and tell everyone watching it. */
  set(symbol: string, drawings: Drawing[]): void {
    this.cache.set(symbol, drawings);
    this.dirty.add(symbol);
    this.schedulePersist();
    const set = this.listeners.get(symbol);
    if (!set) return;
    for (const listener of set) listener(drawings);
  }

  /** Write pending symbols to storage now. Safe to call at any time. */
  flush(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    for (const symbol of this.dirty) {
      saveDrawings(symbol, this.cache.get(symbol) ?? []);
    }
    this.dirty.clear();
  }

  private schedulePersist(): void {
    if (this.flushTimer !== null) return;
    if (typeof window === "undefined") return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, PERSIST_DELAY_MS);
  }

  /**
   * A tab closed mid-drag must not lose the drawing.
   *
   * `pagehide` rather than `beforeunload`: it fires on mobile task switching
   * too, which is where a chart tab is most likely to be discarded.
   */
  private attachHideFlush(): void {
    if (this.hideHandlerAttached || typeof window === "undefined") return;
    this.hideHandlerAttached = true;
    window.addEventListener("pagehide", () => this.flush());
  }
}

export const drawingStore = new DrawingStore();
