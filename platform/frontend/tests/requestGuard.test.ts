/**
 * FE-07 and the stale-response race.
 *
 * The bug these prevent is not a crash. It is the chart quietly showing the
 * PREVIOUS symbol's candles under the new symbol's label, because
 * `setCandles(data)` was unconditional and a slow first response landed after a
 * fast second one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CancellableRequest, isAbortError, LatestRequest, RequestCoalescer,
} from "../lib/requestGuard";
import { expandCompact, type CompactCandles } from "../lib/api";

// ── Stale-response suppression ──────────────────────────────────────────────

test("only the newest token is current", () => {
  const seq = new LatestRequest();
  const first = seq.next();
  assert.equal(seq.isCurrent(first), true);
  const second = seq.next();
  assert.equal(seq.isCurrent(second), true);
  assert.equal(seq.isCurrent(first), false, "the superseded request must not apply");
});

test("the exact race: a slow FIRST response must not overwrite a fast second", async () => {
  const seq = new LatestRequest();
  let painted: string | null = null;

  const load = async (symbol: string, delayMs: number): Promise<void> => {
    const token = seq.next();
    await new Promise((r) => setTimeout(r, delayMs));
    if (!seq.isCurrent(token)) return;
    painted = symbol;
  };

  // APTUSDT is requested first and is slow; NEARUSDT is requested second and
  // returns first. Without the guard the chart ends on APTUSDT's data.
  const slow = load("APTUSDT", 40);
  const fast = load("NEARUSDT", 5);
  await Promise.all([slow, fast]);

  assert.equal(painted, "NEARUSDT");
});

test("switching away and BACK still rejects the first response", () => {
  // A parameter comparison would wrongly accept it here, because the
  // parameters match again. Comparing tokens is what makes this correct.
  const seq = new LatestRequest();
  const aptFirst = seq.next();   // APTUSDT
  seq.next();                    // NEARUSDT
  const aptAgain = seq.next();   // back to APTUSDT
  assert.equal(seq.isCurrent(aptFirst), false);
  assert.equal(seq.isCurrent(aptAgain), true);
});

test("invalidate stops everything in flight without issuing a new request", () => {
  const seq = new LatestRequest();
  const token = seq.next();
  seq.invalidate();
  assert.equal(seq.isCurrent(token), false);
});

// ── Cancellation ────────────────────────────────────────────────────────────

test("starting a new request aborts the previous one", () => {
  const req = new CancellableRequest();
  const first = req.start();
  assert.equal(first.aborted, false);
  const second = req.start();
  assert.equal(first.aborted, true, "the superseded request must stop consuming a connection");
  assert.equal(second.aborted, false);
});

test("cancel aborts without starting anything, and is idempotent", () => {
  const req = new CancellableRequest();
  const signal = req.start();
  assert.equal(req.inFlight, true);
  req.cancel();
  assert.equal(signal.aborted, true);
  assert.equal(req.inFlight, false);
  assert.doesNotThrow(() => req.cancel());
});

test("an abort is recognised as deliberate, not as a failure to report", async () => {
  const controller = new AbortController();
  controller.abort();
  try {
    await fetch("http://127.0.0.1:1/never", { signal: controller.signal });
    assert.fail("should have thrown");
  } catch (err) {
    assert.equal(isAbortError(err), true, "an aborted fetch must not surface as an error banner");
  }
});

test("a genuine error is NOT mistaken for an abort", () => {
  assert.equal(isAbortError(new Error("500 Internal Server Error")), false);
  assert.equal(isAbortError(new TypeError("Failed to fetch")), false);
  assert.equal(isAbortError("nope"), false);
  assert.equal(isAbortError(null), false);
});

// ── Coalescing ──────────────────────────────────────────────────────────────

test("concurrent identical requests share one call", async () => {
  const coalescer = new RequestCoalescer();
  let calls = 0;
  const fn = async (): Promise<number> => {
    calls++;
    await new Promise((r) => setTimeout(r, 10));
    return calls;
  };
  const [a, b, c] = await Promise.all([
    coalescer.run("APTUSDT|15m", fn),
    coalescer.run("APTUSDT|15m", fn),
    coalescer.run("APTUSDT|15m", fn),
  ]);
  assert.equal(calls, 1, "three callers, one 2.5 MB request");
  assert.equal(a, b);
  assert.equal(b, c);
});

test("different keys do not share", async () => {
  const coalescer = new RequestCoalescer();
  let calls = 0;
  const fn = async (): Promise<void> => { calls++; };
  await Promise.all([
    coalescer.run("APTUSDT|15m", fn),
    coalescer.run("NEARUSDT|15m", fn),
  ]);
  assert.equal(calls, 2);
});

test("it is a COALESCER, not a cache — the entry is dropped once settled", async () => {
  // Serving a stale candle series from memory is exactly the class of bug the
  // rest of this module exists to prevent.
  const coalescer = new RequestCoalescer();
  let calls = 0;
  const fn = async (): Promise<number> => ++calls;
  assert.equal(await coalescer.run("k", fn), 1);
  assert.equal(coalescer.size, 0);
  assert.equal(await coalescer.run("k", fn), 2, "a later request must actually run");
});

test("a rejected request is dropped too, so a retry is not poisoned", async () => {
  const coalescer = new RequestCoalescer();
  let calls = 0;
  const failing = async (): Promise<never> => { calls++; throw new Error("boom"); };
  await assert.rejects(coalescer.run("k", failing), /boom/);
  assert.equal(coalescer.size, 0);
  await assert.rejects(coalescer.run("k", failing), /boom/);
  assert.equal(calls, 2);
});

// ── Compact wire format ─────────────────────────────────────────────────────

const compact: CompactCandles = {
  format: "compact-v1",
  symbol: "APTUSDT",
  interval: "15m",
  stepMs: 900_000,
  count: 3,
  bars: [
    [0, 10, 11, 9, 10.5, 100],
    [900_000, 10.5, 12, 10, 11.5, 200],
    [1_800_000, 11.5, 13, 11, 12.5, 300],
  ],
};

test("the compact response expands to the candle shape the chart uses", () => {
  const candles = expandCompact(compact);
  assert.equal(candles.length, 3);
  assert.deepEqual(candles[0], {
    symbol: "APTUSDT", interval: "15m", openTime: 0,
    open: 10, high: 11, low: 9, close: 10.5, volume: 100,
    closeTime: 899_999,
  });
});

test("closeTime is DERIVED, never transmitted", () => {
  // It is `openTime + stepMs - 1` by definition, and sending it per bar was a
  // meaningful share of a 2.5 MB payload.
  for (const c of expandCompact(compact)) {
    assert.equal(c.closeTime, c.openTime + compact.stepMs - 1);
  }
});

test("symbol and interval come from the envelope, not from every bar", () => {
  for (const c of expandCompact(compact)) {
    assert.equal(c.symbol, "APTUSDT");
    assert.equal(c.interval, "15m");
  }
});

test("an empty response expands to an empty array rather than throwing", () => {
  assert.deepEqual(expandCompact({ ...compact, count: 0, bars: [] }), []);
});

test("expansion preserves ascending order and every price exactly", () => {
  const candles = expandCompact(compact);
  for (let i = 1; i < candles.length; i++) {
    assert.ok(candles[i]!.openTime > candles[i - 1]!.openTime);
  }
  assert.deepEqual(
    candles.map((c) => [c.open, c.high, c.low, c.close, c.volume]),
    compact.bars.map(([, o, h, l, c, v]) => [o, h, l, c, v])
  );
});
