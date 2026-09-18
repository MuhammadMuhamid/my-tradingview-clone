/**
 * A parameter form must belong to the strategy it is editing.
 *
 * ── What went wrong ───────────────────────────────────────────────────────
 *
 * `ParamForm` rendered `PARAM_GROUPS` — `ma_rr_v9`'s schema — whatever strategy
 * it was handed, and its callers seeded their drafts from a matching
 * strategy-blind `defaultParams()`. With one strategy registered that was
 * correct. With three it meant selecting `mtf_lean`, touching nothing, and
 * sending 49 `ma_rr_v9` keys — eleven of which are real `mtf_lean` inputs
 * carrying the WRONG strategy's values: `rrRatio` 3.75 -> 2, both take-profit
 * levels, the trailing stop and its activation, the minimum stop distance.
 *
 * Nothing crashed. The form drew, the run completed, and every number it
 * produced was about a strategy the user had not configured — under a heading
 * reading "defaults apply unless changed". A stress run sends no params at all
 * and therefore got the engine's real defaults, so the stress page's claim that
 * its windows are "directly comparable with any other run on this install" was
 * false for exactly the strategy the repository describes as the one deployed
 * with real money.
 *
 * ── The half the first fix missed ─────────────────────────────────────────
 *
 * Correcting the WIRING left the DATA wrong. Thirteen of `mtf_lean`'s
 * thirty-four inputs still carried `ma_rr_v9`'s literals in the schema itself —
 * the labels were right and the numbers were another strategy's — so a form
 * that now resolved the correct schema went on shipping the wrong values.
 *
 * The test written alongside that fix could not see it. It asserted
 * `defaultParamsFor(key)[field.key] === field.default`, and `defaultParamsFor`
 * is `out[f.key] = f.default`: `f.default === f.default`, green for any values
 * whatsoever. A schema test that never leaves the schema cannot notice a schema
 * that is wrong about something outside it.
 *
 * ── What these tests pin ──────────────────────────────────────────────────
 *
 * That every form default IS the engine's default, compared across the
 * frontend/backend boundary where the truth actually lives, with the three
 * deliberate exceptions written down by name rather than tolerated by a
 * threshold — and that no strategy's default set is silently `ma_rr_v9`'s.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { SCHEMAS, defaultParamsFor, groupsFor } from "../lib/paramSchema";
import { MA_RR_V9_DEFAULTS } from "../../backend/src/engine/strategies/ma_rr_v9/params";
import { MTF_LEAN_DEFAULTS } from "../../backend/src/engine/strategies/mtf_lean/params";
import { SRTREND_V10_DEFAULTS } from "../../backend/src/engine/strategies/srtrend_v10/params";

/** What the engine actually runs when a caller sends nothing. */
const ENGINE_DEFAULTS: Record<string, Record<string, unknown>> = {
  ma_rr_v9: MA_RR_V9_DEFAULTS,
  mtf_lean: MTF_LEAN_DEFAULTS,
  srtrend_v10: SRTREND_V10_DEFAULTS,
};

const KEYS = Object.keys(SCHEMAS);

test("every registered strategy has a schema and non-empty defaults", () => {
  assert.ok(KEYS.length >= 2, "this regression only exists with a second strategy");
  for (const key of KEYS) {
    const groups = groupsFor(key);
    assert.ok(groups && groups.length > 0, `${key} has no groups`);
    assert.ok(Object.keys(defaultParamsFor(key)).length > 0, `${key} has no defaults`);
  }
});

test("a strategy's defaults are drawn only from its own schema", () => {
  for (const key of KEYS) {
    const own = new Set(groupsFor(key)!.flatMap((g) => g.fields).map((f) => f.key));
    for (const emitted of Object.keys(defaultParamsFor(key))) {
      assert.ok(own.has(emitted),
        `${key} would send "${emitted}", which is not one of its own inputs`);
    }
  }
});

/**
 * The three inputs the FORM deliberately differs on, and why.
 *
 * `ma_rr_v9`'s shipped engine defaults take no trade in any market over any
 * window — `priActive` only becomes true when a signal family is both enabled
 * and marked primary, and all six default to neither — so the form enables the
 * primary family to stop the page's main action returning an unexplained
 * "0 trades" out of the box. That reasoning is recorded at `BacktestForm.tsx`.
 *
 * Every other divergence is a bug, so the exception is a NAMED LIST rather
 * than a tolerance.
 */
const DELIBERATE: Record<string, Record<string, unknown>> = {
  ma_rr_v9: { useMaTrend: true, maPrimary: true, useRR: true },
};

test("every form default is the engine's default, except where we say otherwise", () => {
  /*
   * ── Why this test replaced the one that was here ─────────────────────────
   *
   * The previous version asserted `defaultParamsFor(key)[field.key] ===
   * field.default`, and `defaultParamsFor` is `out[f.key] = f.default`. It was
   * `f.default === f.default`: green for any values whatsoever, including the
   * thirteen `mtf_lean` inputs that were carrying `ma_rr_v9`'s numbers at the
   * moment it was written — the very defect its own docstring described.
   *
   * A schema test that never leaves the schema cannot see a schema that is
   * wrong about something else. This one imports the ENGINE's defaults and
   * compares across the boundary, which is the only place the truth lives.
   */
  const wrong: string[] = [];
  for (const key of KEYS) {
    const engine = ENGINE_DEFAULTS[key];
    assert.ok(engine, `${key} has no engine defaults to check against`);
    for (const field of groupsFor(key)!.flatMap((g) => g.fields)) {
      const allowed = DELIBERATE[key];
      if (allowed && field.key in allowed) {
        assert.equal(field.default, allowed[field.key],
          `${key}.${field.key} is a named exception; its value must be the one we named`);
        continue;
      }
      assert.ok(field.key in engine,
        `${key}.${field.key} is not an input the engine accepts`);
      if (engine[field.key] !== field.default) {
        wrong.push(`${key}.${field.key}: engine=${String(engine[field.key])} form=${String(field.default)}`);
      }
    }
  }
  assert.deepEqual(wrong, [],
    "a form default is not the engine's; a run that changes nothing would not run the defaults");
});

test("the named exceptions are the only ones, so the list cannot rot quietly", () => {
  // If an exception is removed from the schema, the entry here must go too —
  // otherwise the list slowly becomes a licence rather than a record.
  for (const [key, fields] of Object.entries(DELIBERATE)) {
    const own = new Set(groupsFor(key)!.flatMap((g) => g.fields).map((f) => f.key));
    for (const field of Object.keys(fields)) {
      assert.ok(own.has(field), `${key}.${field} is listed as deliberate but is no longer in the form`);
    }
  }
});

test("no strategy-blind default survives in the schema module", async () => {
  // `defaultParams()` returned ma_rr_v9's values to whoever asked, and three
  // callers asked on another strategy's behalf. Its absence is the fix.
  const mod = await import("../lib/paramSchema");
  assert.equal("defaultParams" in mod, false,
    "a strategy-blind defaultParams() is back; use defaultParamsFor(strategyKey)");
});
