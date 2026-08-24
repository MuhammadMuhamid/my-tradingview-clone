/**
 * BE-23 — a user-supplied Pine script must not be able to stall the API.
 *
 * The audit's finding was that `/api/pine/run` executed the interpreter on the
 * process's own event loop with a 45-second budget, so one heavy script blocked
 * live alert evaluation and webhook dispatch for as long as it ran. These tests
 * pin the property that fixes it: the run happens elsewhere, this thread stays
 * responsive throughout, and the run is bounded in time and in concurrency.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Bars } from "../src/engine/mtf";
import { PineBusyError, poolState, runPineInWorker } from "../src/pine/runInWorker";

function makeBars(n: number): Bars {
  const time: number[] = [], open: number[] = [], high: number[] = [],
    low: number[] = [], close: number[] = [], volume: number[] = [], closeTime: number[] = [];
  let px = 100;
  for (let i = 0; i < n; i++) {
    const o = px;
    px *= 1 + Math.sin(i / 7) * 0.01;
    time.push(1_700_000_000_000 + i * 900_000);
    closeTime.push(1_700_000_000_000 + (i + 1) * 900_000 - 1);
    open.push(o); close.push(px);
    high.push(Math.max(o, px) * 1.002);
    low.push(Math.min(o, px) * 0.998);
    volume.push(1000 + i);
  }
  return { symbol: "TESTUSDT", interval: "15m", time, open, high, low, close, volume, closeTime, length: n };
}

const BARS = makeBars(300);

const request = (source: string, timeBudgetMs = 10_000) => ({
  source, bars: BARS, startIdx: 0, endIdx: BARS.length - 1,
  broker: null, timeBudgetMs,
});

test("an indicator runs on the worker and returns its plots", async () => {
  const out = await runPineInWorker(request(`
//@version=5
indicator("worker smoke")
plot(ta.sma(close, 10), title="sma")
`));
  assert.equal(out.kind, "ok");
  const run = (out as { kind: "ok"; run: Record<string, unknown> }).run;
  const plots = run.plots as { title: string; data: (number | null)[] }[];
  assert.equal(plots.length, 1);
  assert.equal(plots[0]!.title, "sma");
  assert.equal(plots[0]!.data.length, BARS.length);
});

test("a strategy run comes back with trades, metrics and an equity curve", async () => {
  const out = await runPineInWorker({
    ...request(`
//@version=5
strategy("worker strategy")
if ta.crossover(ta.sma(close, 5), ta.sma(close, 20))
    strategy.entry("L", strategy.long)
if ta.crossunder(ta.sma(close, 5), ta.sma(close, 20))
    strategy.close("L")
`),
    broker: {
      initialCapital: 1000, commissionPct: 0.1, slippageTicks: 0,
      tickSize: 0.01, qtyCash: 930, qtyPctEquity: 0,
    },
  });
  assert.equal(out.kind, "ok");
  const run = (out as { kind: "ok"; run: Record<string, unknown> }).run;
  assert.ok(Array.isArray(run.trades));
  assert.ok(run.metrics && typeof run.metrics === "object");
  assert.ok(Array.isArray(run.equityCurve));
});

test("a syntax error is a script error, not a dead thread", async () => {
  const out = await runPineInWorker(request(`
//@version=5
indicator("broken"
plot(close)
`));
  assert.equal(out.kind, "script-error");
  const errs = (out as { errors: { message: string }[] }).errors;
  assert.ok(errs.length > 0);
  assert.ok(errs[0]!.message.length > 0);
});

test("THE POINT OF BE-23: this thread keeps running while a script does", async () => {
  // A script that burns its whole budget in a tight loop. Before this change it
  // would have held the only event loop for the entire run.
  const heavy = runPineInWorker(request(`
//@version=5
indicator("hot loop")
var float acc = 0.0
for i = 0 to 200000
    acc := acc + math.sin(i)
plot(acc)
`, 4_000));

  // Sample a timer on THIS loop while the script runs. If the interpreter were
  // still inline, every one of these would arrive in a single late burst.
  const gaps: number[] = [];
  let last = Date.now();
  const ticker = setInterval(() => {
    const now = Date.now();
    gaps.push(now - last);
    last = now;
  }, 20);
  const out = await heavy;
  clearInterval(ticker);

  assert.ok(gaps.length >= 5, `expected the local loop to keep ticking, got ${gaps.length} ticks`);
  const worst = Math.max(...gaps);
  assert.ok(worst < 1_000, `event loop stalled for ${worst}ms while a Pine script ran`);
  assert.ok(["ok", "script-error", "timeout"].includes(out.kind), out.kind);
});

test("a runaway script is stopped, and says so", async () => {
  const started = Date.now();
  const out = await runPineInWorker(request(`
//@version=5
indicator("runaway")
var float acc = 0.0
for i = 0 to 100000000
    acc := acc + i
plot(acc)
`, 1_500));
  const elapsed = Date.now() - started;
  // Either the interpreter's own deadline fired (script-error) or the parent
  // terminated the thread (timeout). Both are bounded; neither is "ok".
  assert.ok(out.kind === "script-error" || out.kind === "timeout", out.kind);
  assert.ok(elapsed < 15_000, `a runaway script ran for ${elapsed}ms`);
});

test("concurrency is bounded and the queue refuses rather than growing", async () => {
  const before = poolState();
  assert.ok(before.max >= 1);
  const source = `
//@version=5
indicator("queue filler")
var float acc = 0.0
for i = 0 to 400000
    acc := acc + math.sin(i)
plot(acc)
`;
  // One more than the pool and the queue can hold together.
  const overflow = before.max + 8 + 1;
  const runs = Array.from({ length: overflow }, () => runPineInWorker(request(source, 4_000)));
  const settled = await Promise.allSettled(runs);
  const refused = settled.filter(
    (r) => r.status === "rejected" && r.reason instanceof PineBusyError
  );
  assert.equal(refused.length, 1, "the run past the queue limit must be refused, not queued");
  // Everything else completed one way or another, and the pool drained.
  assert.equal(poolState().running, 0);
  assert.equal(poolState().queued, 0);
});
