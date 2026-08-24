/**
 * Backtest-versus-live parity reporting.
 *
 * `BE-01`, `BE-03` and `BE-15` were all found by reading code. Each changes
 * which trades are taken, and none of them would show up in a metric: the two
 * sides simply take different trades and each looks internally consistent.
 * What catches that is a signal-by-signal comparison of the two trade lists.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { compareParity, overlapWindow, type ParitySignal } from "../src/engine/parityReport";

const BAR = Date.UTC(2026, 7, 24, 0, 0, 0);
const FIFTEEN = 15 * 60_000;
const at = (n: number): number => BAR + n * FIFTEEN;

const sig = (n: number, over: Partial<ParitySignal> = {}): ParitySignal => ({
  barTime: at(n), action: "buy", reason: "entry", ...over,
});

test("two identical lists agree completely", () => {
  const list = [sig(0), sig(4, { action: "sell", reason: "tp" })];
  const report = compareParity(list, list);
  assert.equal(report.identical, true);
  assert.equal(report.matched, 2);
  assert.deepEqual(report.divergences, []);
  assert.equal(report.agreement, 1);
  assert.match(report.summary, /identical/);
});

test("BE-01 in the shape it would appear: the live side misses a trade the backtest takes", () => {
  // A staler MTF feed live means an entry gate opens two bars later, so the
  // live side simply never produces the signal.
  const backtest = [sig(0), sig(4, { action: "sell", reason: "tp" })];
  const live = [sig(4, { action: "sell", reason: "tp" })];
  const report = compareParity(backtest, live, { window: { startMs: at(0), endMs: at(10) } });
  assert.equal(report.identical, false);
  assert.equal(report.divergences.length, 1);
  assert.equal(report.divergences[0]!.kind, "missing_live");
  assert.match(report.divergences[0]!.detail, /the live side did not act/);
});

test("BE-03 in the shape it would appear: the same trade for a different reason", () => {
  // Inverted exit precedence: the backtest resolves the stop first, the live
  // path checked signal exits first, so both sell and each names a different
  // rule — with a different exit price and therefore a different win/loss flag.
  const backtest = [sig(4, { action: "sell", reason: "sl" })];
  const live = [sig(4, { action: "sell", reason: "hl_break" })];
  const report = compareParity(backtest, live);
  assert.equal(report.divergences[0]!.kind, "reason_mismatch");
  assert.match(report.divergences[0]!.detail, /exit precedence/);
  assert.equal(report.matched, 0);
});

test("opposite directions on one bar is its own, louder finding", () => {
  const report = compareParity([sig(3)], [sig(3, { action: "sell" })]);
  assert.equal(report.divergences[0]!.kind, "action_mismatch");
  assert.match(report.divergences[0]!.detail, /opposite trades/);
});

test("a signal the live side took and the backtest did not is reported too", () => {
  // With an explicit window, because the inferred overlap ends at the
  // backtest's LAST signal and would hide anything the live side did after it.
  const report = compareParity(
    [sig(0), sig(4)], [sig(0), sig(2, { reason: "entry" }), sig(4)],
    { window: { startMs: at(0), endMs: at(10) } }
  );
  assert.equal(report.matched, 2);
  assert.equal(report.divergences.length, 1);
  assert.equal(report.divergences[0]!.kind, "extra_live");
  assert.equal(report.divergences[0]!.barTime, at(2));
});

test("the inferred window ends at the backtest's last signal — stated, not hidden", () => {
  // A caller with the real run windows should pass them. The report always
  // says which window it used, so a partial comparison cannot read as a full
  // one.
  const report = compareParity([sig(0)], [sig(0), sig(2)]);
  assert.deepEqual(report.window, { startMs: at(0), endMs: at(0) });
  assert.equal(report.liveSignals, 1, "the live signal outside the window is not compared");
});

test("reason spelling is not a divergence", () => {
  // The backtest records `HL Break`; the live path records `hl_break`. Treating
  // that as a divergence would bury the real ones.
  const report = compareParity(
    [sig(1, { action: "sell", reason: "HL Break" })],
    [sig(1, { action: "sell", reason: "hl_break" })]
  );
  assert.equal(report.identical, true);
  assert.equal(report.matched, 1);
});

test("partial exit legs are compared leg by leg, not collapsed onto the bar", () => {
  const backtest = [
    sig(5, { action: "sell", reason: "tp", exitLeg: "TP1" }),
    sig(5, { action: "sell", reason: "tp", exitLeg: "TP2" }),
  ];
  const live = [sig(5, { action: "sell", reason: "tp", exitLeg: "TP1" })];
  const report = compareParity(backtest, live);
  assert.equal(report.matched, 1);
  assert.equal(report.divergences.length, 1);
  assert.equal(report.divergences[0]!.backtest?.exitLeg, "TP2");
});

test("ONLY THE OVERLAPPING WINDOW IS COMPARED", () => {
  // The live side starts when the deployment was armed. Comparing a backtest
  // that begins a year earlier would report the whole first year as missing,
  // which is true and useless.
  const backtest = [sig(0), sig(10), sig(20)];
  const live = [sig(10), sig(20)];
  const report = compareParity(backtest, live);
  assert.deepEqual(report.window, { startMs: at(10), endMs: at(20) });
  assert.equal(report.identical, true, "the bars before the live side existed are not divergences");
  assert.equal(report.backtestSignals, 2);
});

test("an explicit window overrides the overlap, so a partial run can be checked", () => {
  const backtest = [sig(0), sig(10)];
  const live = [sig(10)];
  const report = compareParity(backtest, live, { window: { startMs: at(0), endMs: at(30) } });
  assert.equal(report.divergences.length, 1);
  assert.equal(report.divergences[0]!.kind, "missing_live");
});

test("no overlap at all is reported as nothing to compare, not as agreement", () => {
  const report = compareParity([sig(0), sig(1)], [sig(50), sig(51)]);
  assert.equal(report.window, null);
  // With no window every signal is compared, so the disagreement is total.
  assert.equal(report.matched, 0);
  assert.equal(report.identical, false);
});

test("two empty lists are not a passing parity check", () => {
  const report = compareParity([], []);
  assert.equal(report.agreement, null, "0/0 must not read as 100 % agreement");
  assert.equal(report.identical, true, "…but there is genuinely nothing that differs");
  assert.match(report.summary, /identical|nothing to compare/);
});

test("one side empty is every signal on the other side, reported", () => {
  const report = compareParity([sig(0), sig(1)], []);
  assert.equal(report.divergences.length, 2);
  assert.ok(report.divergences.every((d) => d.kind === "missing_live"));
  assert.equal(report.agreement, 0);
});

test("divergences come back in bar order, so the FIRST one is the first to diverge", () => {
  const report = compareParity(
    [sig(9), sig(1), sig(5)],
    [sig(5)],
    { window: { startMs: at(0), endMs: at(20) } }
  );
  assert.deepEqual(report.divergences.map((d) => d.barTime), [at(1), at(9)]);
  assert.equal(report.matched, 1);
});

test("overlapWindow is null when either side is empty", () => {
  assert.equal(overlapWindow([], [sig(1)]), null);
  assert.equal(overlapWindow([sig(1)], []), null);
  assert.deepEqual(overlapWindow([sig(1), sig(5)], [sig(3), sig(9)]), { startMs: at(3), endMs: at(5) });
  assert.equal(overlapWindow([sig(1)], [sig(9)]), null, "disjoint ranges do not overlap");
});
