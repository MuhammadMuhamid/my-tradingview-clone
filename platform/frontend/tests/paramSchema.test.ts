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
 * ── What these tests pin ──────────────────────────────────────────────────
 *
 * That every registered strategy's defaults come from its OWN schema, and that
 * no strategy's default set is silently `ma_rr_v9`'s. The failure mode was
 * never a missing key — it was a key that belonged to both schemas and carried
 * the other one's number, so identity of the shared keys' VALUES is the thing
 * worth asserting.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { SCHEMAS, defaultParamsFor, groupsFor } from "../lib/paramSchema";

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

test("a shared input takes each strategy's OWN default, not ma_rr_v9's", () => {
  // The eleven-key collision that made this a scientific defect rather than a
  // cosmetic one. Every key two schemas share is checked, not just those.
  const base = defaultParamsFor("ma_rr_v9");
  let compared = 0;

  for (const key of KEYS) {
    if (key === "ma_rr_v9") continue;
    const mine = groupsFor(key)!.flatMap((g) => g.fields);
    for (const field of mine) {
      if (!(field.key in base)) continue;
      compared += 1;
      assert.equal(
        defaultParamsFor(key)[field.key], field.default,
        `${key}.${field.key} must default to its own ${String(field.default)}, `
        + `not ma_rr_v9's ${String(base[field.key])}`
      );
    }
  }

  assert.ok(compared > 0,
    "no shared keys found — this test would pass vacuously and prove nothing");
});

test("no strategy-blind default survives in the schema module", async () => {
  // `defaultParams()` returned ma_rr_v9's values to whoever asked, and three
  // callers asked on another strategy's behalf. Its absence is the fix.
  const mod = await import("../lib/paramSchema");
  assert.equal("defaultParams" in mod, false,
    "a strategy-blind defaultParams() is back; use defaultParamsFor(strategyKey)");
});
