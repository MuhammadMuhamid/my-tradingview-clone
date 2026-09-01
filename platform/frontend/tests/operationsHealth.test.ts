import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { OpsStatus } from "../lib/api";
import { buildOperationsOverview } from "../lib/operationsHealth";

const NOW = "2026-09-01T12:07:30.000Z";
const ROOT = path.resolve(import.meta.dirname, "..");

function status(): OpsStatus {
  return {
    mode: "LIVE",
    emitter: {
      thisProcess: "platform:1", liveRunnerEnabled: true, holdsLease: true,
      lease: {
        holder: "platform:1", hostname: "platform", pid: 1,
        acquiredAt: "2026-09-01T12:00:00.000Z", expiresAt: "2026-09-01T12:08:00.000Z",
        isThisProcess: true,
      },
    },
    risk: {
      tradingHalted: false, haltedReason: null, haltedBy: null, haltedAt: null,
      maxTotalExposureQuote: null, maxConcurrentPositions: null, maxDailyLossQuote: null,
      dailyLossWindowHours: 24,
      snapshot: { currentExposureQuote: 0, openPositions: 0, realisedPnlInWindow: null },
      summary: "ACTIVE", dailyLossControl: {
        state: "DISABLED_UNFED", authority: "BOT", note: "Bot owns realised fills.",
      },
    },
    bot: { state: "NOT_CONFIGURED", configuredEndpoints: 0, reason: "no_custom_bot_deployment" },
    database: {
      ready: true, checks: { database: "ok", schema: "current" },
      schema: { expected: 17, applied: 17, missing: [] }, time: NOW,
    },
    alertRunner: {
      state: "healthy", active: 2, recent: 2, stale: 0, withoutEvidence: 0,
      lastEvaluatedAt: "2026-09-01T11:45:00.000Z", reason: "2 active alerts have recent evaluation evidence.",
    },
    deployments: {
      total: 3, active: 2, long: 0, paused: 1, paper: 1, automated: 1, signalOnly: 1,
    },
    delivery: {
      state: "healthy", summary: "2 delivered, 0 refused by the bot, 0 skipped in the last 24h.",
      windowHours: 24, counts: { pending: 0, sent: 2, failed: 0, skipped: 0, blocked: 0 },
      total: 2, lastSentAt: "2026-09-01T12:00:00.000Z", lastFailureAt: null,
      stuckPending: 0, retried: 0,
    },
    exchange: { testnetConfigured: false, note: "Bot is authoritative." },
    feeds: {
      worst: "live",
      rows: [{
        symbol: "BTCUSDT", interval: "15m", state: "live", barsBehind: 0,
        missingBars: 0, detail: "contiguous and current",
        lastBarTime: "2026-09-01T11:45:00.000Z", lastCheckedAt: NOW,
        integrity: {
          state: "healthy", market: "spot", symbol: "BTCUSDT", interval: "15m",
          latestCompletedBarTime: "2026-09-01T11:45:00.000Z",
          latestCompletedBarAgeMs: 450_000, lastCheckedAt: NOW,
          issueCodes: [], issueCounts: {},
        },
      }],
    },
    time: NOW,
  };
}

const scannerHealthy = {
  value: {
    ok: true, resolved: 36, unresolved: 0, last_refresh_at: Date.parse(NOW),
    last_refresh_error: null,
  },
};

function item(result: ReturnType<typeof buildOperationsOverview>, id: string) {
  return result.items.find((entry) => entry.id === id)!;
}

test("all authoritative healthy evidence produces a compact Healthy overview", () => {
  const result = buildOperationsOverview(status(), scannerHealthy);
  assert.equal(result.status, "Healthy");
  assert.equal(item(result, "market-data").status, "Healthy");
  assert.equal(item(result, "database").status, "Healthy");
  assert.equal(item(result, "alerts").status, "Healthy");
});

test("degraded, invalid and stale market feeds retain the exact issue nearby", () => {
  for (const [state, code, expected, overall] of [
    ["degraded", "missing_completed_interval", "Degraded", "Attention"],
    ["invalid", "malformed_ohlc", "Invalid", "Degraded"],
    ["degraded", "stale_latest_completed_bar", "Degraded", "Attention"],
  ] as const) {
    const value = status();
    value.feeds.rows[0]!.integrity.state = state;
    value.feeds.rows[0]!.integrity.issueCodes = [code];
    value.feeds.rows[0]!.integrity.issueCounts = { [code]: code === "stale_latest_completed_bar" ? 2 : 1 };
    const result = buildOperationsOverview(value, scannerHealthy);
    assert.equal(result.status, overall);
    assert.equal(item(result, "market-data").status, expected);
    assert.match(item(result, "market-data").summary, code === "malformed_ohlc" ? /malformed OHLC/ : /missing|stale/);
  }
});

test("operator halt is an intentional top-level state, not a subsystem crash", () => {
  const value = status();
  value.mode = "HALTED";
  value.risk.tradingHalted = true;
  value.risk.haltedBy = "operator";
  value.risk.haltedReason = "exchange maintenance";
  value.risk.haltedAt = NOW;
  const result = buildOperationsOverview(value, scannerHealthy);
  assert.equal(result.status, "Halted");
  assert.equal(item(result, "trading-mode").status, "Operator halted");
  assert.match(item(result, "trading-mode").summary, /not a system crash/);
  assert.equal(item(result, "live-runner").status, "Healthy");
});

test("unknown and unconfigured evidence never becomes healthy", () => {
  const value = status();
  value.feeds.rows = [];
  value.alertRunner = {
    state: "not_configured", active: 0, recent: 0, stale: 0, withoutEvidence: 0,
    lastEvaluatedAt: null, reason: "No active notification alerts are configured.",
  };
  const result = buildOperationsOverview(value, { error: "Scanner service is not configured" });
  assert.equal(result.status, "Attention");
  assert.equal(item(result, "market-data").status, "Unknown");
  assert.equal(item(result, "alerts").status, "Not configured");
  assert.equal(item(result, "scanner").status, "Not configured");
});

test("mixed subsystem evidence elevates the worst proven state", () => {
  const value = status();
  value.delivery.state = "failing";
  value.delivery.summary = "3 of 4 deliveries failed.";
  value.alertRunner.state = "degraded";
  const result = buildOperationsOverview(value, scannerHealthy);
  assert.equal(result.status, "Degraded");
  assert.equal(item(result, "delivery").status, "Failing");
  assert.equal(item(result, "alerts").status, "Degraded");
});

test("execution-bot unavailability is not hidden inside an otherwise healthy mode", () => {
  const value = status();
  value.bot = { state: "UNAVAILABLE", configuredEndpoints: 1, reason: "request_failed" };
  const result = buildOperationsOverview(value, scannerHealthy);
  assert.equal(result.status, "Degraded");
  assert.equal(item(result, "trading-mode").status, "Bot unavailable");
});

test("loading and API error states are explicit and halt/resume confirmations stay exact", () => {
  assert.equal(item(buildOperationsOverview(status(), { loading: true }), "scanner").status, "Loading");
  assert.equal(item(buildOperationsOverview(status(), { error: "Scanner service is unavailable" }), "scanner").status, "Unavailable");

  const page = fs.readFileSync(path.join(ROOT, "app", "operations", "page.tsx"), "utf8");
  const api = fs.readFileSync(path.join(ROOT, "lib", "api.ts"), "utf8");
  assert.match(page, /Unable to read authoritative operations status/);
  assert.match(page, /error \? "alert" : "status"/);
  assert.match(page, /role="alert"/);
  assert.match(page, /setConfirmResume\(true\)/);
  assert.match(page, /Yes, resume trading/);
  assert.match(api, /confirmation: "HALT_TRADING"/);
  assert.match(api, /confirmation: "RESUME_TRADING"/);
});
