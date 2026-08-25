/**
 * FE-12/FE-13: when a polled page has stopped updating, and whether that is
 * worth saying.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { describeAge, freshAt, freshnessNotice, STALE_AFTER_MS } from "../lib/freshness";

const T = 1_700_000_000_000;

test("a page whose last poll succeeded says nothing", () => {
  assert.deepEqual(freshnessNotice(freshAt(T), T + 10 * 60_000), { show: false });
});

test("ONE FAILED POLL IS NOT WORTH INTERRUPTING ANYONE OVER", () => {
  // Transient failures are normal. A banner that flickers on every blip is a
  // banner people learn to ignore, which costs more than it saves.
  const state = { lastOkAt: T, lastError: "fetch failed" };
  assert.deepEqual(freshnessNotice(state, T + 5_000), { show: false });
  assert.deepEqual(freshnessNotice(state, T + STALE_AFTER_MS - 1), { show: false });
});

test("SUSTAINED FAILURE IS SAID, WITH HOW OLD THE DATA IS", () => {
  const notice = freshnessNotice({ lastOkAt: T, lastError: "fetch failed" }, T + 5 * 60_000);
  assert.equal(notice.show, true);
  assert.ok(notice.show && notice.message.includes("5m ago"));
  assert.ok(notice.show && notice.message.includes("fetch failed"));
  assert.equal(notice.show && notice.severity, "warn");
});

test("never having loaded is a DIFFERENT situation from being behind", () => {
  // Stale data is still real data and can be read with caution. A page that has
  // shown nothing since it opened has nothing to read at all.
  const notice = freshnessNotice({ lastOkAt: null, lastError: "Failed to fetch" }, T);
  assert.equal(notice.show, true);
  assert.equal(notice.show && notice.severity, "down");
  assert.match(notice.show ? notice.message : "", /^Could not load: Failed to fetch$/);
  assert.doesNotMatch(notice.show ? notice.message : "", /ago/);
});

test("a recovery clears the notice", () => {
  const failing = { lastOkAt: T, lastError: "fetch failed" };
  assert.equal(freshnessNotice(failing, T + 10 * 60_000).show, true);
  assert.equal(freshnessNotice(freshAt(T + 10 * 60_000), T + 10 * 60_000).show, false);
});

test("age is coarse — the exact second is not the point", () => {
  assert.equal(describeAge(1_000), "1s");
  assert.equal(describeAge(89_000), "89s");
  assert.equal(describeAge(90_000), "1m");
  assert.equal(describeAge(60 * 60_000), "60m");
  assert.equal(describeAge(90 * 60_000), "1h");
  assert.equal(describeAge(5 * 60 * 60_000), "5h");
});
