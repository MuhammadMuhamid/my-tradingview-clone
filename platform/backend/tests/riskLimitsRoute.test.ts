/**
 * What an operator is allowed to set the risk limits to.
 *
 * These are the platform's only exposure and concurrency controls. Until this
 * campaign nothing in the product could change them — the client function
 * existed with zero callers — and the route had no test, so the accept/reject
 * matrix was whatever the code happened to do.
 *
 * `riskControls.test.ts` covers the EVALUATOR (what the limits do once set).
 * This covers what may become a limit in the first place.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readRiskLimitPatch } from "../src/api/routes/operations";

const ok = (b: Record<string, unknown>) => {
  const r = readRiskLimitPatch(b);
  assert.ok("patch" in r, `expected accept, got ${JSON.stringify(r)}`);
  return r.patch;
};
const refused = (b: Record<string, unknown>) => {
  const r = readRiskLimitPatch(b);
  assert.ok("status" in r, `expected refusal, got ${JSON.stringify(r)}`);
  return r;
};

test("an omitted limit is left alone, not reset", () => {
  // The patch is sparse on purpose: sending only the exposure must not clear
  // the concurrency cap, which a dense body would.
  assert.deepEqual(ok({ maxTotalExposureQuote: 500 }), { maxTotalExposureQuote: 500 });
  assert.deepEqual(ok({}), {});
});

test("null turns a limit OFF, and zero is a different instruction", () => {
  // "No limit" and "nothing may open" are opposites. Conflating them is how an
  // empty input box silently halts trading, or a zero silently removes a cap.
  assert.deepEqual(ok({ maxTotalExposureQuote: null }), { maxTotalExposureQuote: null });
  assert.deepEqual(ok({ maxTotalExposureQuote: 0 }), { maxTotalExposureQuote: 0 });
  assert.deepEqual(ok({ maxConcurrentPositions: null }), { maxConcurrentPositions: null });
  assert.deepEqual(ok({ maxConcurrentPositions: 0 }), { maxConcurrentPositions: 0 });
});

test("a limit that cannot be enforced is refused", () => {
  for (const body of [
    { maxTotalExposureQuote: -1 },
    { maxTotalExposureQuote: "500" },
    { maxTotalExposureQuote: Number.NaN },
    { maxTotalExposureQuote: Number.POSITIVE_INFINITY },
    { maxConcurrentPositions: -1 },
    { maxConcurrentPositions: "3" },
  ]) {
    assert.equal(refused(body).status, 400, JSON.stringify(body));
  }
});

test("half a position is not a position", () => {
  assert.match(refused({ maxConcurrentPositions: 2.5 }).error, /whole number/);
});

test("a platform daily-loss cap is refused, and names the control that exists", () => {
  // The platform does not see realised fills, so this number would look like a
  // limit and enforce nothing. Storing it is worse than refusing it.
  const r = refused({ maxDailyLossQuote: 250 });
  assert.equal(r.status, 409);
  assert.match(r.error, /bot owns realised fills/);
  assert.match(r.error, /bot-side daily-loss protection/);
});

test("an old misleading daily-loss value can still be cleared", () => {
  assert.deepEqual(ok({ maxDailyLossQuote: null }), { maxDailyLossQuote: null });
});

test("the daily-loss window is bounded to something a day can be measured in", () => {
  assert.deepEqual(ok({ dailyLossWindowHours: 24 }), { dailyLossWindowHours: 24 });
  assert.deepEqual(ok({ dailyLossWindowHours: 1 }), { dailyLossWindowHours: 1 });
  assert.deepEqual(ok({ dailyLossWindowHours: 720 }), { dailyLossWindowHours: 720 });
  for (const v of [0, 721, 1.5, "24", null]) {
    assert.equal(refused({ dailyLossWindowHours: v }).status, 400, String(v));
  }
});

test("both limits move together in one patch", () => {
  assert.deepEqual(
    ok({ maxTotalExposureQuote: 1000, maxConcurrentPositions: 3 }),
    { maxTotalExposureQuote: 1000, maxConcurrentPositions: 3 }
  );
});

test("a refusal anywhere refuses the whole patch", () => {
  // Otherwise a body naming a good exposure and a bad daily loss would apply
  // half of what the operator asked for, and report an error for the rest.
  assert.equal(
    refused({ maxTotalExposureQuote: 1000, maxDailyLossQuote: 250 }).status, 409
  );
});
