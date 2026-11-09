/**
 * U1 on the Operations page: the execution Bot's facts, each under its own
 * name, the halt scope stated, and a way to the Bot page.
 *
 * The card used to lead with one word read only from a custom webhook
 * deployment, so a Platform with a working signed channel said NOT
 * CONFIGURED, and CONNECTED read as "ready" for a halted or simulated Bot.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { screen, within } from "@testing-library/react";
import { closeBrowser, render, resetBrowser, server, settle } from "./harness/env";
import { AppRoute } from "./harness/routing";
import OperationsPage from "@/app/operations/page";
import { resetSessionForTests } from "@/lib/session";
import type { BotControlPanel, OpsStatus, OpsStatusBotControl } from "@/lib/api";
import { HALT_SCOPE_TEXT } from "@/components/bot/botCopy";
import { account, panel } from "./botFixtures";

beforeEach(() => { resetBrowser(); resetSessionForTests(); });
after(closeBrowser);

function ops(botControl: BotControlPanel | undefined, bot?: OpsStatus["bot"]): OpsStatus & OpsStatusBotControl {
  const facts = botControl?.facts;
  return {
    mode: "DISABLED",
    emitter: { thisProcess: "p1", liveRunnerEnabled: false, holdsLease: false, lease: null },
    risk: {
      tradingHalted: false, haltedReason: null, haltedBy: null, haltedAt: null,
      maxTotalExposureQuote: null, maxConcurrentPositions: null, maxDailyLossQuote: null, dailyLossWindowHours: 24,
      snapshot: { currentExposureQuote: 0, openPositions: 0, realisedPnlInWindow: null },
      summary: "ACTIVE", dailyLossControl: { state: "DISABLED_UNFED", authority: "BOT", note: "" },
    },
    bot: bot ?? (facts ? { state: "CONNECTED", configuredEndpoints: 1, status: facts.operational }
      : { state: "UNAVAILABLE", configuredEndpoints: 1, reason: "request_failed" }),
    ...(botControl ? { botControl } : {}),
    database: { ready: true, checks: { database: "ok", schema: "current" }, schema: { expected: 1, applied: 1, missing: [] }, time: "2026-11-09T12:00:00.000Z" },
    alertRunner: { state: "disabled", active: 0, recent: 0, stale: 0, withoutEvidence: 0, lastEvaluatedAt: null, reason: "" },
    deployments: { total: 0, active: 0, long: 0, paused: 0, paper: 0, automated: 0, signalOnly: 0 },
    delivery: { state: "idle", summary: "", windowHours: 24, counts: { pending: 0, sent: 0, failed: 0, skipped: 0, blocked: 0 },
      total: 0, lastSentAt: null, lastFailureAt: null, stuckPending: 0, retried: 0 },
    exchange: { testnetConfigured: true, note: "" },
    feeds: { worst: "live", rows: [] },
    time: "2026-11-09T12:00:00.000Z",
  };
}

async function show(status: OpsStatus) {
  account("admin");
  server.routes.set("GET /api/ops/status", () => status);
  render(<AppRoute path="/operations"><OperationsPage /></AppRoute>);
  await settle(8);
  const heading = screen.getByRole("heading", { name: /Execution bot — authoritative/ });
  return heading.closest(".rounded-md") as HTMLElement;
}

test("each Bot fact has its own line, there is no single state word, and the card links to /bot", async () => {
  const card = await show(ops(panel({}, { halted: false, dryRun: true })));
  assert.ok(card.querySelector('dl[aria-label="Bot status"]'), "the separate statuses are one labelled description list");
  for (const label of ["Control channel (this Platform)", "Signed connection", "Webhook-credential path", "Execution",
    "Bot halt", "Exchange routing", "Risk limits", "Shariah floor", "TP/SL protection", "Manual trading"]) {
    assert.ok(within(card).getByText(label), label);
  }
  const text = card.textContent ?? "";
  assert.ok(text.includes("Dry run (simulated)"));
  assert.ok(text.includes("No custom webhook deployment"), "the webhook path is its own, separate fact");
  assert.ok(!/\bNOT CONFIGURED\b|\bCONNECTED\b/.test(text), "no one-word verdict");
  assert.ok(text.includes(HALT_SCOPE_TEXT));
  assert.equal(within(card).getByRole("link", { name: "Open the Bot page" }).getAttribute("href"), "/bot");
});

test("a halted Bot says TP/SL is not being checked", async () => {
  const card = await show(ops(panel({}, { halted: true, haltedBy: "daily_loss", latched: true })));
  const text = card.textContent ?? "";
  assert.ok(text.includes("TP/SL protection is NOT being checked."));
  assert.ok(text.includes("Halted by daily-loss limit (latched)"));
});

test("a configured channel with the Bot down is unreachable, not 'not configured'", async () => {
  const card = await show(ops(panel({ signed: { state: "UNREACHABLE", cause: null }, facts: null })));
  const text = card.textContent ?? "";
  assert.ok(text.includes("Unreachable"));
  assert.ok(text.includes("Set up"), "the channel is set up; the Bot did not answer");
  assert.ok(text.includes("Unknown (status not read)"), "could not read is not off");
});
