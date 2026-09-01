import { test } from "node:test";
import assert from "node:assert/strict";
import { formatFeedIntegrityStatus } from "../src/api/routes/operations";
import { INTERVAL_MS } from "../src/types/market";

test("operations integrity status is a cheap deterministic projection", () => {
  const lastBarTime = Date.UTC(2026, 8, 1, 10, 0);
  const now = lastBarTime + INTERVAL_MS["1h"] + 12_345;
  const status = formatFeedIntegrityStatus({
    symbol: "BTCUSDT",
    interval: "1h",
    state: "gap",
    lastBarTime,
    lastCheckedAt: now - 100,
    integrityState: "degraded",
    issueCodes: ["missing_completed_interval"],
    issueCounts: { missing_completed_interval: 1 },
  }, now);
  assert.deepEqual(status, {
    state: "degraded",
    market: "spot",
    symbol: "BTCUSDT",
    interval: "1h",
    latestCompletedBarTime: new Date(lastBarTime).toISOString(),
    latestCompletedBarAgeMs: 12_345,
    lastCheckedAt: new Date(now - 100).toISOString(),
    issueCodes: ["missing_completed_interval"],
    issueCounts: { missing_completed_interval: 1 },
  });
});

test("operations status derives stale state from timeframe and injected read time", () => {
  const interval = "15m" as const;
  const step = INTERVAL_MS[interval];
  const now = Date.UTC(2026, 8, 1, 12, 7, 30);
  const newestClosed = Math.floor(now / step) * step - step;
  const status = formatFeedIntegrityStatus({
    symbol: "ETHUSDT", interval, state: "live",
    lastBarTime: newestClosed - 2 * step,
    lastCheckedAt: now - 3 * step,
    integrityState: "healthy", issueCodes: [], issueCounts: {},
  }, now);
  assert.equal(status.state, "degraded");
  assert.deepEqual(status.issueCodes, ["stale_latest_completed_bar"]);
  assert.equal(status.issueCounts.stale_latest_completed_bar, 2);
});
