import { test } from "node:test";
import assert from "node:assert/strict";
import { completedAtOrBefore } from "../src/pine/horizon";

test("Pine chart and MTF feeds include only source bars completed by replay T", () => {
  const feed = [
    { closeTime: 60_000, value: "completed" },
    { closeTime: 120_000, value: "closes-with-chart" },
    { closeTime: 180_000, value: "future" },
  ];
  assert.deepEqual(
    completedAtOrBefore(feed, 120_000).map((bar) => bar.value),
    ["completed", "closes-with-chart"],
  );
});
