import { test } from "node:test";
import assert from "node:assert/strict";
import { Broker } from "../src/engine/broker";
import type { Bars } from "../src/engine/mtf";
import { allCorrections, noCorrections } from "../src/engine/corrections";
import { allEntriesSkippedReason, skippedEntriesTruth } from "../src/engine/backtester";

const approx = (a: number, b: number, eps = 1e-9): void => {
  assert.ok(Math.abs(a - b) < eps, `expected ${a} ≈ ${b}`);
};

function makeBars(rows: [number, number, number, number][]): Bars {
  const n = rows.length;
  return {
    symbol: "TESTUSDT",
    interval: "5m",
    time: rows.map((_, i) => i * 300_000),
    open: rows.map((r) => r[0]),
    high: rows.map((r) => r[1]),
    low: rows.map((r) => r[2]),
    close: rows.map((r) => r[3]),
    volume: rows.map(() => 1000),
    closeTime: rows.map((_, i) => (i + 1) * 300_000 - 1),
    length: n,
  };
}

const OPTS = {
  initialCapital: 1000,
  commissionPct: 0.05,
  slippageTicks: 2,
  tickSize: 0.01,
  qtyCash: 930,
  corrections: noCorrections(),
};
const REASONS = { tp: { RR1: "TP1", RR2: "TP2", RR3: "TP", "RR X": "TP" }, sl: "SL" };

test("market entry fills at next bar open + slippage, cash sizing, commission", () => {
  const bars = makeBars([
    [100, 101, 99, 100.5],
    [100.6, 101, 100, 100.8],
  ]);
  const b = new Broker(OPTS);
  b.queueEntry("entry");         // placed at close of bar 0
  b.processOpen(bars, 1);        // fills at bar 1 open
  const expectedFill = 100.6 + 2 * 0.01;
  approx(b.avgPrice, expectedFill);
  approx(b.positionQty, 930 / expectedFill);
  approx(b.commissionPaid, expectedFill * (930 / expectedFill) * 0.0005);
});

test("stop fills at stop - slippage; green bar hits stop before limit", () => {
  const bars = makeBars([
    [100, 100, 100, 100],
    [100, 100, 100, 100],  // entry fills here at 100.02
    [100, 106, 94, 105],   // green bar: BOTH stop (95) and limit (105) inside range
  ]);
  const b = new Broker(OPTS);
  b.queueEntry("entry");
  b.processOpen(bars, 1);
  b.setExitLeg("RR X", null, 105, 95, 1); // issued at close of bar 1
  b.processIntrabar(bars, 2, REASONS);
  assert.equal(b.closed.length, 1);
  const trade = b.closed[0]!;
  assert.equal(trade.exitReason, "SL");   // green bar → open→low first
  approx(trade.exitPrice!, 95 - 0.02);
  assert.ok(b.isFlat);
});

test("red bar hits limit before stop", () => {
  const bars = makeBars([
    [100, 100, 100, 100],
    [100, 100, 100, 100],
    [100, 106, 94, 95],    // red bar (close < open): open→high first
  ]);
  const b = new Broker(OPTS);
  b.queueEntry("entry");
  b.processOpen(bars, 1);
  b.setExitLeg("RR X", null, 105, 95, 1);
  b.processIntrabar(bars, 2, REASONS);
  assert.equal(b.closed[0]!.exitReason, "TP");
  approx(b.closed[0]!.exitPrice!, 105);   // limit fills at limit, no slippage
});

test("gap down opens below stop: fills at open - slippage", () => {
  const bars = makeBars([
    [100, 100, 100, 100],
    [100, 100, 100, 100],
    [90, 92, 89, 91],      // gaps below the 95 stop
  ]);
  const b = new Broker(OPTS);
  b.queueEntry("entry");
  b.processOpen(bars, 1);
  b.setExitLeg("RR X", null, 105, 95, 1);
  b.processIntrabar(bars, 2, REASONS);
  approx(b.closed[0]!.exitPrice!, 90 - 0.02);
});

test("partial legs: TP1 fills its qty, runner + stop protect the rest", () => {
  const bars = makeBars([
    [100, 100, 100, 100],
    [100, 100, 100, 100],  // entry ~100.02
    [100, 103, 99, 102.5], // green: hits TP1 at 102, stop 95 untouched
    [102, 102, 94, 94.5],  // stop 95 hit → remaining legs stop out
  ]);
  const b = new Broker(OPTS);
  b.queueEntry("entry");
  b.processOpen(bars, 1);
  const qty = b.positionQty;
  b.setExitLeg("RR1", qty * 0.4, 102, 95, 1);
  b.setExitLeg("RR3", null, 110, 95, 1);
  b.processIntrabar(bars, 2, REASONS);
  assert.equal(b.closed.length, 1);
  assert.equal(b.closed[0]!.exitReason, "TP1");
  approx(b.closed[0]!.qty, qty * 0.4);
  approx(b.positionQty, qty * 0.6);
  // next bar: stop takes the rest
  b.setExitLeg("RR3", null, 110, 95, 2);
  b.processIntrabar(bars, 3, REASONS);
  assert.equal(b.closed.length, 2);
  assert.equal(b.closed[1]!.exitReason, "SL");
  assert.ok(b.isFlat);
});

test("legs are inactive on their issue bar (TV order timing)", () => {
  const bars = makeBars([
    [100, 100, 100, 100],
    [100, 106, 94, 100],   // stop+limit range but leg issued THIS bar → no fill
    [100, 100, 100, 100],
  ]);
  const b = new Broker(OPTS);
  b.queueEntry("entry");
  b.processOpen(bars, 1);
  b.setExitLeg("RR X", null, 105, 95, 1);
  b.processIntrabar(bars, 1, REASONS);   // same bar as issue → inactive
  assert.equal(b.closed.length, 0);
  assert.ok(!b.isFlat);
});

test("market close fills at open - slippage and cancels legs", () => {
  const bars = makeBars([
    [100, 100, 100, 100],
    [100, 100, 100, 100],
    [101, 106, 94, 100],   // close order fills at open before intrabar levels
  ]);
  const b = new Broker(OPTS);
  b.queueEntry("entry");
  b.processOpen(bars, 1);
  b.setExitLeg("RR X", null, 105, 95, 1);
  b.queueClose("HL Break");
  b.processOpen(bars, 2);
  assert.equal(b.closed.length, 1);
  assert.equal(b.closed[0]!.exitReason, "HL Break");
  approx(b.closed[0]!.exitPrice!, 101 - 0.02);
  b.processIntrabar(bars, 2, REASONS);   // legs must be gone
  assert.equal(b.closed.length, 1);
});

test("per-leg pnl is net of exit commission + pro-rata entry commission", () => {
  const bars = makeBars([
    [100, 100, 100, 100],
    [100, 100, 100, 100],
    [100, 111, 100, 110],
  ]);
  const b = new Broker(OPTS);
  b.queueEntry("entry");
  b.processOpen(bars, 1);
  const entryPx = b.avgPrice;
  const qty = b.positionQty;
  const entryComm = entryPx * qty * 0.0005;
  b.setExitLeg("RR X", null, 110, 90, 1);
  b.processIntrabar(bars, 2, REASONS);
  const t = b.closed[0]!;
  const exitComm = 110 * qty * 0.0005;
  approx(t.pnl!, (110 - entryPx) * qty - exitComm - entryComm);
  // realizedNet must equal the sum of trade pnls when fully closed
  approx(b.realizedNet, t.pnl!);
});

test("FC1-B1 corrected protection executes after candle close and keeps trigger provenance", () => {
  const bars = makeBars([
    [100, 100, 100, 100],
    [100, 100, 100, 100],
    [100, 105, 89, 95],
  ]);
  const b = new Broker({ ...OPTS, corrections: allCorrections() });
  b.queueEntry("entry");
  b.processOpen(bars, 1);
  b.setExitLeg("RR X", null, 110, 90, 1);
  b.processIntrabar(bars, 2, REASONS);
  assert.equal(b.closed[0]?.exitReason, "SL");
  approx(b.closed[0]!.intendedTriggerPrice!, 90);
  approx(b.closed[0]!.exitPrice!, 95 - 0.02);
  assert.equal(b.closed[0]!.exitTime, bars.closeTime[2]! + 1);
});

test("FC1-M1 close-fill excursion starts at fill; open-fill still observes its fill candle", () => {
  const bars = makeBars([
    [100, 200, 50, 100],
    [100, 100, 100, 100],
  ]);
  const closeFill = new Broker({ ...OPTS, fillOnBarClose: true });
  closeFill.queueEntry("entry");
  closeFill.processClose(bars, 0);
  closeFill.queueClose("done");
  closeFill.processClose(bars, 1);
  approx(closeFill.closed[0]!.runUpPct!, 0);
  approx(closeFill.closed[0]!.drawdownPct!, 0);

  const openFill = new Broker(OPTS);
  openFill.queueEntry("entry");
  openFill.processOpen(bars, 0);
  openFill.queueClose("done");
  openFill.processOpen(bars, 1);
  assert.ok(openFill.closed[0]!.runUpPct! > 90);
  assert.ok(openFill.closed[0]!.drawdownPct! > 40);
});

test("C-01 lotDustExit — a leg that would leave less than one lot closes the whole position", () => {
  /*
   * Cash sizing buys 930 / 100.02 ≈ 9.298 units; with a 0.1 lot step the TP
   * leg for 99 % of that floors to 9.2 and would leave 0.098 — less than one
   * lot, which no exchange would let anyone sell. Without the correction the
   * broker kept that dust "open" with its stale legs (the result page showed an
   * open trade +44 % with a TP hit weeks before); with it, the leg takes the
   * remainder and the position is flat.
   */
  const bars = makeBars([
    [100, 100, 100, 100],
    [100, 100, 100, 100],
    [100, 103, 99, 102.5],
  ]);
  const run = (lotDustExit: boolean): Broker => {
    const b = new Broker({
      ...OPTS, qtyStep: 0.1,
      corrections: { ...noCorrections(), exchangeFilters: true, lotDustExit },
    });
    b.queueEntry("entry");
    b.processOpen(bars, 1);
    b.setExitLeg("RR1", b.positionQty * 0.99, 102, 95, 1);
    b.processIntrabar(bars, 2, REASONS);
    return b;
  };
  const without = run(false);
  assert.ok(without.positionQty > 0 && without.positionQty < 0.1, `expected dust, got ${without.positionQty}`);
  assert.equal(without.isFlat, false);

  const withFix = run(true);
  assert.equal(withFix.isFlat, true, "a sub-lot remainder was left open");
  assert.equal(withFix.closed.length, 1, "the dust is folded into the closing leg, not a trade of its own");
  approx(withFix.closed[0]!.qty, 930 / (100 + 0.02), 1e-9);
});

test("C-01 affordableEntries — a cash entry larger than the account is skipped, and said so", () => {
  /*
   * Initial capital 100 with the strategy's default 930 cash per entry: the
   * old broker bought 930 of an asset with 100 of cash, so the run's absolute
   * P/L was the same as a 1,000-capital run's and its percentages were ten
   * times larger — −97.91 % over 39 trades a spot account could never have
   * placed. Spot has no margin; the order is refused.
   */
  const bars = makeBars([
    [100, 100, 100, 100],
    [100, 101, 99, 100.5],
  ]);
  const run = (affordableEntries: boolean): Broker => {
    const b = new Broker({
      ...OPTS, initialCapital: 100,
      corrections: { ...noCorrections(), affordableEntries },
    });
    b.queueEntry("entry");
    b.processOpen(bars, 1);
    return b;
  };
  const without = run(false);
  approx(without.positionQty, 930 / (100 + 0.02));
  assert.equal(without.rejectedEntries.length, 0);

  const withFix = run(true);
  assert.equal(withFix.isFlat, true, "an entry spending more than the account holds was filled");
  assert.equal(withFix.commissionPaid, 0, "a refused order pays no commission");
  assert.equal(withFix.rejectedEntries.length, 1);
  const rejected = withFix.rejectedEntries[0]!;
  assert.equal(rejected.bar, 1);
  assert.equal(rejected.time, bars.time[1]);
  approx(rejected.cash, 930);
  approx(rejected.equity, 100);
});

test("C-01 affordableEntries — entries stop once losses take equity below the order size", () => {
  // 1,000 capital, 930 per entry: the first trade loses ~20 %, which leaves
  // about 810 — and the second 930 entry is no longer affordable.
  const bars = makeBars([
    [100, 100, 100, 100],
    [100, 100, 100, 100],
    [80, 80, 80, 80],
    [80, 80, 80, 80],
  ]);
  const run = (affordableEntries: boolean): Broker => {
    const b = new Broker({ ...OPTS, corrections: { ...noCorrections(), affordableEntries } });
    b.queueEntry("entry");
    b.processOpen(bars, 1);
    b.queueClose("exit");
    b.processOpen(bars, 2);
    b.queueEntry("entry");
    b.processOpen(bars, 3);
    return b;
  };
  const without = run(false);
  assert.equal(without.isFlat, false, "the baseline keeps entering");
  const withFix = run(true);
  assert.ok(withFix.equityAt(80) < 930, `equity ${withFix.equityAt(80)} should be below the order size`);
  assert.equal(withFix.isFlat, true);
  assert.equal(withFix.closed.length, 1, "the first, affordable trade is unaffected");
  assert.equal(withFix.rejectedEntries.length, 1);
  assert.equal(withFix.rejectedEntries[0]!.bar, 3);
});

test("C-01 affordableEntries — percent-of-equity sizing is unaffected while equity is positive", () => {
  const bars = makeBars([
    [100, 100, 100, 100],
    [100, 101, 99, 100.5],
  ]);
  const run = (affordableEntries: boolean): Broker => {
    const b = new Broker({
      ...OPTS, qtyPctEquity: 100,
      corrections: { ...noCorrections(), affordableEntries },
    });
    b.queueEntry("entry");
    b.processOpen(bars, 1);
    return b;
  };
  const without = run(false);
  const withFix = run(true);
  approx(withFix.positionQty, without.positionQty);
  approx(withFix.positionQty, 1000 / (100 + 0.02));
  assert.equal(withFix.rejectedEntries.length, 0);
});

test("a fixed-cash spot entry must pay its entry fee from the available account", () => {
  const bars = makeBars([[100, 100, 100, 100], [100, 100, 100, 100]]);
  const b = new Broker({ ...OPTS, initialCapital: 100, qtyCash: 100,
    commissionPct: 5, slippageTicks: 0, corrections: allCorrections() });
  b.queueEntry("entry");
  b.processOpen(bars, 1);
  assert.equal(b.isFlat, true, "100 notional plus a 5 fee cannot be funded by 100 cash");
  assert.equal(b.commissionPaid, 0, "a refused entry must not charge its fee");
  assert.equal(b.rejectedEntries.length, 1);
});

test("100%-equity spot sizing reserves entry commission without borrowing or suppressing the workflow", () => {
  const bars = makeBars([[100, 100, 100, 100], [100, 100, 100, 100]]);
  const b = new Broker({ ...OPTS, initialCapital: 100, qtyPctEquity: 100,
    commissionPct: 5, slippageTicks: 0, corrections: allCorrections() });
  b.queueEntry("entry");
  b.processOpen(bars, 1);
  assert.ok(b.positionQty > 0, "an all-equity entry remains usable with fees reserved");
  const spent = b.positionQty * b.avgPrice + b.commissionPaid;
  assert.ok(spent <= 100 + 1e-9, `the entry spent ${spent} from only 100 cash`);
  approx(spent, 100);
});

test("fee-reserved equity sizing conserves account money through a complete round trip", () => {
  const bars = makeBars([[100, 100, 100, 100], [100, 100, 100, 100], [110, 110, 110, 110]]);
  for (const pct of [50, 100]) {
    const b = new Broker({ ...OPTS, initialCapital: 100, qtyPctEquity: pct,
      commissionPct: 5, slippageTicks: 0, corrections: allCorrections() });
    b.queueEntry("entry");
    b.processOpen(bars, 1);
    const notional = Math.min(pct, 100 / 1.05);
    approx(b.positionQty * b.avgPrice, notional);
    const cashRemaining = 100 - notional - b.commissionPaid;
    assert.ok(cashRemaining >= -1e-9);
    b.queueClose("exit");
    b.processOpen(bars, 2);
    const proceeds = notional * 1.1;
    const expectedEquity = cashRemaining + proceeds * 0.95;
    approx(b.equityAt(110), expectedEquity);
    approx(b.closed[0]!.pnl!, expectedEquity - 100);
    approx(b.commissionPaid, notional * 0.05 + proceeds * 0.05);
    assert.equal(b.isFlat, true);
  }
});

test("entry fill price is checked before creating a position or charging a fee", () => {
  for (const price of [0, -1, Number.NaN]) {
    const bars = makeBars([[100, 100, 100, 100], [price, price, price, price]]);
    const b = new Broker({ ...OPTS, slippageTicks: 0, corrections: allCorrections() });
    b.queueEntry("entry");
    assert.throws(() => b.processOpen(bars, 1), /Entry fill price/);
    assert.equal(b.isFlat, true);
    assert.equal(b.commissionPaid, 0);
    assert.equal(b.realizedNet, 0);
  }
});

test("Broker rejects nonfinite or impossible money inputs while ignoring unused cash sizing", () => {
  for (const override of [
    { initialCapital: 0 }, { initialCapital: Number.NaN },
    { commissionPct: -1 }, { commissionPct: Number.POSITIVE_INFINITY },
    { slippageTicks: -1 }, { tickSize: 0 },
    { qtyCash: -1 }, { qtyPctEquity: Number.NaN },
  ]) {
    assert.throws(() => new Broker({ ...OPTS, ...override }), /capital|commission|slippage|tick|sizing/i);
  }
  assert.doesNotThrow(() => new Broker({ ...OPTS, qtyPctEquity: 50, qtyCash: 0 }),
    "equity sizing does not read qtyCash");
});

test("slippage cannot book a nonpositive exit price or refund an exit fee", () => {
  const bars = makeBars([[1, 1, 1, 1], [1, 1, 1, 1], [1, 1, 1, 1]]);
  for (const slippageTicks of [100, 200]) {
    const b = new Broker({ ...OPTS, slippageTicks, tickSize: 0.01,
      corrections: allCorrections() });
    b.queueEntry("entry");
    b.processOpen(bars, 1);
    const feeBefore = b.commissionPaid;
    b.queueClose("exit");
    assert.throws(() => b.processOpen(bars, 2), /fill price|slippage/i,
      "a result with a zero or negative execution price must fail clearly");
    assert.equal(b.closed.length, 0, "an impossible fill must not become a reported trade");
    assert.equal(b.commissionPaid, feeBefore, "the invalid exit must not alter cost accounting");
  }
});

test("C-01 the run records skipped entries, and a run that skipped all of them says why", () => {
  assert.equal(skippedEntriesTruth([]), null, "a run that skipped nothing records nothing");
  const truth = skippedEntriesTruth([
    { bar: 3, time: 900_000, cash: 930, equity: 100 },
    { bar: 9, time: 2_700_000, cash: 930, equity: 100 },
  ]);
  assert.deepEqual(truth, { count: 2, cash: 930, equity: 100, firstMs: 900_000 });
  assert.equal(allEntriesSkippedReason(truth!),
    "Every entry would have spent 930 while the account held 100. "
    + "A spot account has no margin, so all 2 entries were skipped.");
  assert.match(allEntriesSkippedReason({ count: 1, cash: 930, equity: 42.5, firstMs: 0 }),
    /held 42\.50\. .* all 1 entry was skipped\.$/);
});
