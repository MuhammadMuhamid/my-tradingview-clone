/**
 * A window that is long enough can still be hours behind the market.
 *
 * These are the eight cases Wave A names, driven against the pure freshness
 * rules and against `repairStaleTail` with a stubbed API — no chart, no cache
 * and no network. Every assertion is about TIME, because the defect was that
 * the old acceptance rule only knew about COUNT.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  barsBehind, claimTailRepair, formingOpenTime, inspectTail, isTailStale,
  lastClosedOpenTime, resetTailRepairs, spliceTail, TAIL_TOLERANCE_BARS,
  tailRepairRange,
} from "../lib/historyFreshness";
import { repairStaleTail } from "../lib/useCandleHistory";
import { INTERVAL_MS, type Candle, type Interval } from "../lib/types";

const MIN = 60_000;
const DAY = 86_400_000;

function candle(openTime: number, interval: Interval = "1m", close = 100): Candle {
  return {
    symbol: "BTCUSDT", interval, openTime, open: close, high: close, low: close, close,
    volume: 1, closeTime: openTime + INTERVAL_MS[interval] - 1,
  };
}

/** `count` contiguous bars ending on the slot that opens at `lastOpen`. */
function series(lastOpen: number, count: number, interval: Interval = "1m"): Candle[] {
  const step = INTERVAL_MS[interval];
  return Array.from({ length: count }, (_, i) => candle(lastOpen - (count - 1 - i) * step, interval));
}

// ── grid arithmetic ─────────────────────────────────────────────────────────

test("the forming slot and the newest closed slot are one interval apart", () => {
  const now = 1_700_000_123_456;
  for (const interval of ["1m", "5m", "1h", "1d"] as Interval[]) {
    const forming = formingOpenTime(now, interval);
    assert.equal(forming % INTERVAL_MS[interval], 0, `${interval} forming slot is on the grid`);
    assert.ok(forming <= now && now < forming + INTERVAL_MS[interval]);
    assert.equal(lastClosedOpenTime(now, interval), forming - INTERVAL_MS[interval]);
  }
});

test("a window ending on the forming bar OR the newest closed bar is zero behind", () => {
  const now = 10 * MIN + 12_345;
  assert.equal(barsBehind(formingOpenTime(now, "1m"), "1m", now), 0, "forming bar held");
  assert.equal(barsBehind(lastClosedOpenTime(now, "1m"), "1m", now), 0, "newest closed bar held");
  // A bar stamped in the future is a clock disagreement, never "ahead".
  assert.equal(barsBehind(formingOpenTime(now, "1m") + 5 * MIN, "1m", now), 0);
  assert.equal(barsBehind(null, "1m", now), Number.POSITIVE_INFINITY);
});

// ── case 1: enough bars, fresh tail → no refresh ────────────────────────────

test("case 1 — a long window ending at the current slot is not stale", () => {
  const now = 5_000 * MIN + 30_000;
  const fresh = series(formingOpenTime(now, "1m"), 10_000);
  assert.equal(fresh.length, 10_000);
  assert.equal(isTailStale(fresh, "1m", now), false);
});

// ── case 2: enough bars, stale tail → refresh ───────────────────────────────

test("case 2 — ten thousand bars that end three hours ago ARE stale", () => {
  const now = 100_000 * MIN;
  const stale = series(formingOpenTime(now, "1m") - 180 * MIN, 10_000);
  assert.equal(stale.length, 10_000, "the count-based rule would have accepted this");
  const tail = inspectTail(stale, "1m", now);
  assert.equal(tail.behind, 179);
  assert.equal(tail.stale, true);
});

// ── case 4: the exact interval boundary must be quiet ───────────────────────

test("case 4 — at an exact boundary, the bar that just closed is tolerated", () => {
  const now = 1_000 * MIN; // exactly on the grid
  assert.equal(formingOpenTime(now, "1m"), now);
  // Store ends on the bar that closed one slot ago: nobody has fetched the
  // newly closed one yet. Refreshing here would fire at every boundary.
  const atBoundary = series(now - 2 * MIN, 600);
  assert.equal(barsBehind(now - 2 * MIN, "1m", now), TAIL_TOLERANCE_BARS);
  assert.equal(isTailStale(atBoundary, "1m", now), false);
  // One more slot back is a gap no boundary explains.
  assert.equal(isTailStale(series(now - 3 * MIN, 600), "1m", now), true);
});

// ── case 5: daily and other large intervals scale by construction ───────────

test("case 5 — the same rule on 1d means days, not minutes", () => {
  const now = 20_000 * DAY + 3 * 3_600_000;
  const yesterday = series(formingOpenTime(now, "1d") - DAY, 400, "1d");
  assert.equal(isTailStale(yesterday, "1d", now), false, "yesterday's close is current");
  const threeDaysBack = series(formingOpenTime(now, "1d") - 3 * DAY, 400, "1d");
  assert.equal(isTailStale(threeDaysBack, "1d", now), true);
  // The same series read on a 1m grid would be millions of bars behind: the
  // threshold is a count of SLOTS, so it scales with the timeframe by itself.
  assert.equal(barsBehind(formingOpenTime(now, "1d") - 3 * DAY, "1d", now), 2);
});

// ── the repair is bounded ───────────────────────────────────────────────────

test("the repair asks for the tail, never the whole window", () => {
  const now = 100_000 * MIN;
  const last = formingOpenTime(now, "1m") - 180 * MIN;
  const range = tailRepairRange(last, "1m", now, 10_000);
  assert.equal(range.from, last, "overlaps the newest stored bar so a bad boundary is overwritten");
  assert.equal(range.to, now);
  assert.ok((range.to - range.from) / MIN < 200, "a three-hour gap costs ~180 bars, not 10,000");

  // An empty or ancient window is floored at the window's own depth.
  const floored = tailRepairRange(null, "1m", now, 500);
  assert.equal(floored.from, formingOpenTime(now, "1m") - 500 * MIN);
});

test("splicing a tail overwrites the slots it covers and respects the window depth", () => {
  const held = series(10 * MIN, 6);
  const tail = [candle(9 * MIN, "1m", 999), candle(10 * MIN, "1m", 1000), candle(11 * MIN, "1m", 1001)];
  const merged = spliceTail(held, tail, 6);
  assert.deepEqual(merged.map((c) => c.openTime / MIN), [6, 7, 8, 9, 10, 11]);
  assert.deepEqual(merged.slice(-3).map((c) => c.close), [999, 1000, 1001], "tail is the authority");

  assert.equal(spliceTail(held, [], 6), held, "an empty answer changes nothing");
  const older = spliceTail(held, [candle(3 * MIN, "1m", 5)], 6);
  assert.equal(older, held, "an older-only answer must not truncate a good window");
});

// ── cases 3, 6, 7, 8: the loader's repair behaviour ─────────────────────────

interface Stub {
  backfills: { from: string; to: string }[];
  ranges: { from: number; to: number }[];
  answer: Candle[] | Error;
}

/**
 * `repairStaleTail` reaches the network through the `api` module singleton, so
 * the stub is installed on it. Restored by every test that installs one.
 */
async function withStubbedApi<T>(
  stub: Stub, run: () => Promise<T>
): Promise<T> {
  const mod = await import("../lib/api");
  const api = mod.api as unknown as Record<string, unknown>;
  const realBackfill = api.backfill;
  const realRange = api.candlesRange;
  api.backfill = async (_s: string, _i: string, from: string, to: string) => {
    stub.backfills.push({ from, to });
    if (stub.answer instanceof Error) throw stub.answer;
    return { fetched: 0 };
  };
  api.candlesRange = async (_s: string, _i: string, from: number, to: number) => {
    stub.ranges.push({ from, to });
    if (stub.answer instanceof Error) throw stub.answer;
    return stub.answer;
  };
  try { return await run(); }
  finally { api.backfill = realBackfill; api.candlesRange = realRange; }
}

const REQUEST = { symbol: "BTCUSDT", interval: "1m" as Interval, bars: 500 };

test("case 3/2 — a stale window is repaired from the tail and becomes current", async () => {
  resetTailRepairs();
  const now = Date.now();
  const forming = formingOpenTime(now, "1m");
  const stale = series(forming - 20 * MIN, 500);
  const tail = series(forming, 21);
  const stub: Stub = { backfills: [], ranges: [], answer: tail };

  const out = await withStubbedApi(stub, () =>
    repairStaleTail(REQUEST, stale, new AbortController().signal));

  assert.equal(stub.backfills.length, 1, "exactly one bounded backfill");
  assert.equal(stub.ranges.length, 1, "exactly one bounded range read");
  assert.equal(isTailStale(out, "1m", Date.now()), false, "the window is current afterwards");
  assert.equal(out.length, 500, "the window depth is preserved");
});

test("case 6 — a failed refresh keeps the real window and stays honestly stale", async () => {
  resetTailRepairs();
  const now = Date.now();
  const stale = series(formingOpenTime(now, "1m") - 20 * MIN, 500);
  const stub: Stub = { backfills: [], ranges: [], answer: new Error("market data host refused") };

  const out = await withStubbedApi(stub, () =>
    repairStaleTail(REQUEST, stale, new AbortController().signal));

  assert.equal(out, stale, "a failed repair does not discard a real window");
  assert.equal(isTailStale(out, "1m", Date.now()), true, "and it still reads as stale");
});

test("a repair cannot loop: the second attempt inside the cooldown is not made", async () => {
  resetTailRepairs();
  const now = Date.now();
  const stale = series(formingOpenTime(now, "1m") - 20 * MIN, 500);
  const stub: Stub = { backfills: [], ranges: [], answer: [] };

  await withStubbedApi(stub, async () => {
    await repairStaleTail(REQUEST, stale, new AbortController().signal);
    await repairStaleTail(REQUEST, stale, new AbortController().signal);
    await repairStaleTail(REQUEST, stale, new AbortController().signal);
  });
  assert.equal(stub.backfills.length, 1, "a pair with no newer bars is asked once, not once per load");
});

test("case 7 — the cooldown is per window, so a symbol switch is not suppressed", () => {
  resetTailRepairs();
  const now = 1_000_000;
  assert.equal(claimTailRepair("BTCUSDT|1m|500", now), true);
  assert.equal(claimTailRepair("BTCUSDT|1m|500", now + 1_000), false, "same window, inside cooldown");
  assert.equal(claimTailRepair("SOLUSDT|1m|500", now + 1_000), true, "another symbol is its own claim");
  assert.equal(claimTailRepair("BTCUSDT|1h|500", now + 1_000), true, "another interval too");
  assert.equal(claimTailRepair("BTCUSDT|1m|500", now + 61_000), true, "after the cooldown");
});

test("an abort during a repair propagates rather than being swallowed as a failure", async () => {
  resetTailRepairs();
  const now = Date.now();
  const stale = series(formingOpenTime(now, "1m") - 20 * MIN, 500);
  const abort = new Error("aborted");
  abort.name = "AbortError";
  const stub: Stub = { backfills: [], ranges: [], answer: abort };

  await assert.rejects(
    () => withStubbedApi(stub, () => repairStaleTail(REQUEST, stale, new AbortController().signal)),
    (err: Error) => err.name === "AbortError");
});

test("case 8 — a live bar at the current slot clears staleness without any refetch", () => {
  const now = Date.now();
  const forming = formingOpenTime(now, "1m");
  const stale = series(forming - 20 * MIN, 500);
  assert.equal(isTailStale(stale, "1m", now), true);
  // Exactly what `mergeLiveBarsInto` does when a kline for the forming slot
  // lands: the window reaches the grid and stops being behind.
  const withTick = [...stale, candle(forming)];
  assert.equal(isTailStale(withTick, "1m", now), false);
});
