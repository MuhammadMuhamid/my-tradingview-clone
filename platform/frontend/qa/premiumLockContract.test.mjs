import test from "node:test";
import assert from "node:assert/strict";
import { hasExpectedCheckCount } from "./premiumLockContract.mjs";

test("Premium lock rejects a shrunk denominator", () => {
  assert.equal(hasExpectedCheckCount(61), true);
  assert.equal(hasExpectedCheckCount(59), false);
  assert.equal(hasExpectedCheckCount(62), false);
});
