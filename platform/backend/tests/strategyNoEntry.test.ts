/**
 * A strategy that cannot trade says so, instead of reporting "0 trades".
 *
 * `ma_rr_v9` is a framework strategy: `signals.ts` builds
 * `frameworkLongOk = priActive && priFired && fltPass`, and `priActive` only
 * becomes true when a signal family is BOTH enabled and marked primary. All six
 * families are `*_en: false` with `*_primary: false` in `MA_RR_V9_DEFAULTS`, so
 * with the shipped defaults `longSetup` is false on every bar and this strategy
 * can never take a position — not rarely, never, by construction.
 *
 * That configuration is legitimate; the operator is expected to switch a family
 * on. What was not legitimate is that the Quick backtest page hard-coded this
 * strategy, so its primary action returned an unexplained "0 trades" out of the
 * box every single time — indistinguishable from a quiet market, a badly chosen
 * window, or a broken engine. On the one screen whose whole job is to report
 * what a strategy did, that is the worst available answer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { explainNoEntries, MA_RR_V9_DEFAULTS, SIGNAL_FAMILIES } from "../src/engine/strategies/ma_rr_v9/params";
import { maRrV9Module } from "../src/engine/strategies/ma_rr_v9";
import { srTrendV10Module } from "../src/engine/strategies/srtrend_v10";
import { mtfLeanModule } from "../src/engine/strategies/mtf_lean";
import type { StrategyParams } from "../src/types/strategy";

test("the shipped defaults genuinely cannot produce an entry, and say why", () => {
  const reason = explainNoEntries({});
  assert.ok(reason, "the shipped defaults take no trade in any market; that must be explainable");
  assert.match(reason, /none of them is switched on/i);
  // The reader must be told what to actually do, not merely that something is wrong.
  assert.match(reason, /Switch on a family/i);
  for (const family of SIGNAL_FAMILIES) {
    assert.ok(reason.includes(family.label),
      `the explanation must name every family the operator could switch on, missing ${family.label}`);
  }
});

test("enabled-but-not-primary is a different refusal, and gets a different sentence", () => {
  /*
   * The subtler of the two dead configurations, and the easier one to create by
   * hand: a family is on, so the settings LOOK configured, but nothing is
   * marked primary and only a primary family can start a trade — the others
   * merely filter one.
   */
  const reason = explainNoEntries({ useMaTrend: true } as unknown as StrategyParams);
  assert.ok(reason);
  assert.match(reason, /none is marked PRIMARY/);
  assert.match(reason, /only filter one/);
  assert.match(reason, /moving-average trend/,
    "the sentence must name the family that is on, so the operator knows where to look");
});

test("a configuration that CAN trade is not second-guessed", () => {
  assert.equal(
    explainNoEntries({ useMaTrend: true, maPrimary: true } as unknown as StrategyParams),
    null,
    "a runnable configuration must produce no warning; a false one would train the reader to ignore it",
  );
});

test("the strategies that trade out of the box are not made to apologise for it", () => {
  // Only `ma_rr_v9` implements the hook. The other two take trades with their
  // own defaults, and a module that cannot answer the question says nothing
  // rather than guessing at one.
  assert.equal(typeof maRrV9Module.explainNoEntries, "function");
  assert.equal((srTrendV10Module as { explainNoEntries?: unknown }).explainNoEntries, undefined);
  assert.equal((mtfLeanModule as { explainNoEntries?: unknown }).explainNoEntries, undefined);
});

test("the default set really does leave every family off", () => {
  // Pins the premise of everything above. If a future default switches a family
  // on, this fails and the explanation stops being about the shipped state.
  const defaults = MA_RR_V9_DEFAULTS as unknown as Record<string, boolean>;
  for (const family of SIGNAL_FAMILIES) {
    assert.equal(defaults[family.enabled], false, `${family.enabled} is no longer off by default`);
    assert.equal(defaults[family.primary], false, `${family.primary} is no longer off by default`);
  }
});
