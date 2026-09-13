/**
 * Per-test browser hygiene, and the two globals jsdom cannot honestly provide.
 *
 * `resetBrowser()` is called before every DOM test. It empties local storage,
 * repoints `fetch` at the fixture origin, and replaces `WebSocket` with a
 * socket that connects to nothing — the market stream is a live connection to
 * Binance, and a test suite that opened one would be both flaky and rude.
 *
 * Nothing here mocks a component, a hook or a store. Those are the subject.
 */
import assert from "node:assert/strict";
import { act, cleanup, render as rtlRender } from "@testing-library/react";
import type { ReactElement } from "react";
import { AskProvider } from "@/components/AskDialog";
import { installFetch, server, type CompactBar } from "./server";
import { candleHistory } from "@/lib/candleHistory";
import { drawingStore } from "@/lib/drawingStore";
import { resetTailRepairs } from "@/lib/historyFreshness";
import { resetVolumeProfileRefinementCache } from "@/lib/useVolumeProfileRefinement";
import { resetManualTradingPollingCapability } from "@/lib/manualTradingPolling";

/**
 * A websocket that opens and then says nothing.
 *
 * The product's own reconnect ladder, silence watchdog and origin rotation all
 * run against it unchanged; what it does not do is reach the internet. Frames
 * can be delivered by hand with `deliver`, which is how a live-tick test
 * chooses exactly what arrived and when.
 */
export class FakeSocket {
  static readonly opened: FakeSocket[] = [];
  static get last(): FakeSocket | undefined { return FakeSocket.opened.at(-1); }

  readonly url: string;
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  readonly sent: string[] = [];

  constructor(url: string) {
    this.url = url;
    FakeSocket.opened.push(this);
  }

  /** Complete the handshake. Nothing opens on its own; a test decides. */
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  deliver(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  send(data: string): void { this.sent.push(data); }

  close(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: "test" });
  }

  addEventListener(): void {}
  removeEventListener(): void {}
}

let restoreFetch: (() => void) | null = null;

export function resetBrowser(): void {
  // Unmount first. A component torn down after storage was cleared can write
  // its farewell state back into it, and the next test starts dirty.
  cleanup();
  window.localStorage.clear();
  /*
   * The module singletons.
   *
   * `node --test` gives each FILE its own process, but not each test, so the
   * shared history cache, the tail-repair cooldown and the drawing store all
   * survive from one test to the next. Every one of them is correct in a
   * browser and wrong between two tests.
   */
  candleHistory.reset();
  resetTailRepairs();
  resetVolumeProfileRefinementCache();
  resetManualTradingPollingCapability();
  drawingStore.resetAll();
  window.sessionStorage.clear();
  server.reset();
  FakeSocket.opened.length = 0;
  restoreFetch?.();
  restoreFetch = installFetch();
  (globalThis as unknown as Record<string, unknown>).WebSocket = FakeSocket;
  (window as unknown as Record<string, unknown>).WebSocket = FakeSocket;
}

/**
 * Tear the document down at the end of a file.
 *
 * The chart keeps a one-second clock, the market stream keeps a reconnect
 * ladder and `pretendToBeVisual` keeps an animation frame loop. All three are
 * correct in a browser and all three keep Node's event loop alive forever, so
 * a run without this never exits. `node --test` gives each file its own
 * process, so closing the window here cannot affect another file.
 */
export function closeBrowser(): void {
  cleanup();
  restoreFetch?.();
  restoreFetch = null;
  window.close();
}

/**
 * Let every already-scheduled microtask and timer callback settle.
 *
 * A restore effect is `useEffect` → `await fetch` → `setState`; three turns of
 * the loop, none of which React's `act` will wait for on its own. Awaiting a
 * real (zero) timeout inside `act` drains all three, and does so without a
 * fixed sleep that would be a race on a slow machine.
 */
export async function settle(times = 3): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }
}

/** Advance past a debounce whose delay is known, then let its work settle. */
export async function advance(ms: number): Promise<void> {
  await act(async () => { await new Promise((r) => setTimeout(r, ms)); });
  await settle();
}

/**
 * A deterministic candle series, in the wire's own compact shape.
 *
 * Prices trace a shallow sine around `base`, so studies produce varied but
 * reproducible values, and every bar is closed. Times run backwards from a
 * fixed epoch, so nothing in a test depends on the day it is run.
 */
export const FIXTURE_EPOCH_MS = Date.UTC(2026, 0, 1, 0, 0, 0);

/**
 * The newest bar's open time, by default: the current interval slot.
 *
 * The chart repairs a stale tail — it backfills and refetches when the newest
 * bar is more than a couple of slots behind the grid. That repair is correct
 * and is tested on its own; a fixture pinned to a fixed past date would make
 * every OTHER test run through it, which is both slow and a distraction. Tests
 * that need fixed times pass `endMs` explicitly.
 */
const currentSlot = (step: number): number => Math.floor(Date.now() / step) * step;

const round = (n: number): number => Math.round(n * 1e4) / 1e4;

export function compactSeries(count: number, opts: {
  intervalMs?: number; base?: number; endMs?: number;
} = {}): CompactBar[] {
  const step = opts.intervalMs ?? 15 * 60_000;
  const base = opts.base ?? 100;
  const end = opts.endMs ?? currentSlot(step);
  const bars: CompactBar[] = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const n = count - i;
    const openTime = end - i * step;
    const open = base + Math.sin(n / 7) * (base * 0.02);
    const close = base + Math.sin((n + 1) / 7) * (base * 0.02);
    bars.push([
      openTime,
      round(open),
      round(Math.max(open, close) + base * 0.003),
      round(Math.min(open, close) - base * 0.003),
      round(close),
      1_000 + (n % 13) * 37,
    ]);
  }
  return bars;
}

/** The close of the newest bar in a series — what "last price" must resolve to. */
export function lastClose(bars: CompactBar[]): number {
  return bars[bars.length - 1]![4];
}

export { server };

/**
 * Render inside the providers `app/layout.tsx` mounts.
 *
 * TVP8: the product's confirmations and text entry moved off `window.confirm`
 * and `window.prompt` into `AskProvider`, which the root layout mounts above
 * every page (see `components/AskDialog.tsx`). These tests render a page or a
 * pane directly, so they render BELOW that provider's position in the real
 * tree and `useAsk` — which throws rather than silently falling back to the
 * browser's own sheet — took the whole suite down.
 *
 * Re-exported from here rather than fixed at 33 call sites, so a provider the
 * layout gains next is added once and every DOM test is inside it. That is
 * also the honest arrangement: a test that renders a page should see the tree
 * the page actually runs in.
 */
export function render(
  ui: ReactElement, options?: Parameters<typeof rtlRender>[1],
): ReturnType<typeof rtlRender> {
  return rtlRender(ui, { wrapper: AskProvider, ...options });
}

/**
 * ── Never hand a DOM node to an assertion ──────────────────────────────────
 *
 * `assert.equal(screen.queryByRole("button", { name: "Exit" }), null)` reads
 * perfectly and is a trap. When it PASSES, nothing happens. When it fails,
 * node:test builds a diff of the actual value — a jsdom `HTMLElement`, whose
 * `ownerDocument` reaches the whole document, which reaches every node, which
 * reaches back. The process stops answering and the runner kills it, so the
 * suite reports
 *
 *   ✖ tests/dom/replay.test.tsx (30691ms)  'test failed'
 *
 * with no assertion, no message and no line number. Found while proving a new
 * test could fail: three deliberate regressions all produced that, and looked
 * for a while like three vacuous assertions.
 *
 * So the node never reaches the assertion. What is compared is a boolean, and
 * the sentence comes from the caller.
 */
export function assertAbsent(found: Element | null, what: string): void {
  assert.equal(found === null, true, what);
}

export function assertPresent(found: Element | null, what: string): Element {
  assert.equal(found !== null, true, what);
  return found!;
}
