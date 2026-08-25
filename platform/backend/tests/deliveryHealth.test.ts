/**
 * The operator surface's signal-delivery health.
 *
 * The question it exists to answer is "are the signals this system produced
 * actually reaching the bot?" — which, before the operator console, could only
 * be answered by reading the `alerts` table by hand. A webhook that had been
 * failing for a day looked exactly like a quiet market.
 *
 * `X-12` is why the statuses are not collapsed into ok/not-ok: the receiver
 * answers HTTP 200 for outcomes where it placed no order, and `blocked` exists
 * so "the bot refused this" is never read as "sent".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FAILING_RATE, PENDING_GRACE_MS, summariseDelivery, type DeliveryRow,
} from "../src/engine/deliveryHealth";

const NOW = Date.UTC(2026, 7, 24, 12, 0, 0);
const ago = (minutes: number): number => NOW - minutes * 60_000;
const opts = { now: NOW, windowHours: 24 };

const row = (over: Partial<DeliveryRow> = {}): DeliveryRow => ({
  status: "sent", firedAt: ago(30), sentAt: ago(30), attempts: 1, httpStatus: 200, ...over,
});

test("a quiet market is IDLE, not broken", () => {
  const health = summariseDelivery([], opts);
  assert.equal(health.state, "idle");
  assert.match(health.summary, /normal in a quiet market/);
  assert.equal(health.total, 0);
});

test("everything delivered is HEALTHY, and the refused and skipped are counted separately", () => {
  const health = summariseDelivery([
    row(), row(), row({ status: "blocked", sentAt: null }), row({ status: "skipped", sentAt: null }),
  ], opts);
  assert.equal(health.state, "healthy");
  assert.equal(health.counts.sent, 2);
  assert.equal(health.counts.blocked, 1);
  assert.equal(health.counts.skipped, 1);
  assert.match(health.summary, /2 delivered, 1 refused by the bot, 1 skipped/);
});

test("a bot REFUSAL is never counted as a delivery", () => {
  // X-12: the receiver answers 200 for "no order placed". `blocked` is the
  // status that keeps those out of the delivered count.
  const health = summariseDelivery([row({ status: "blocked", sentAt: null })], opts);
  assert.equal(health.counts.sent, 0);
  assert.equal(health.lastSentAt, null);
});

test("some failures are DEGRADED", () => {
  const health = summariseDelivery([
    row(), row(), row(), row({ status: "failed", sentAt: null, httpStatus: 502 }),
  ], opts);
  assert.equal(health.state, "degraded");
  assert.match(health.summary, /1 of 4 deliveries failed/);
  assert.equal(health.lastFailureAt, ago(30));
});

test("half or more failing is FAILING, and says signals are not reaching the bot", () => {
  const rows = [row(), row({ status: "failed", sentAt: null }), row({ status: "failed", sentAt: null })];
  const health = summariseDelivery(rows, opts);
  assert.equal(health.state, "failing");
  assert.ok(2 / 3 >= FAILING_RATE);
  assert.match(health.summary, /not reaching the bot/);
});

test("skipped and blocked rows do not dilute the failure rate", () => {
  // Only attempted deliveries count: a duplicate the dispatcher skipped was
  // never a delivery, and counting it as a success would hide a real failure.
  const health = summariseDelivery([
    row({ status: "failed", sentAt: null }),
    ...Array.from({ length: 20 }, () => row({ status: "skipped", sentAt: null })),
  ], opts);
  assert.equal(health.state, "failing", "1 of 1 attempted deliveries failed");
});

test("A STUCK PENDING ALERT OUTRANKS EVERYTHING — the outcome is unknown", () => {
  // BE-13: a process death between delivery and persistence leaves the row
  // pending with the order possibly placed. That is worse than a recorded
  // failure, which is why it wins over `failing`.
  const health = summariseDelivery([
    row(), row({ status: "failed", sentAt: null }), row({ status: "failed", sentAt: null }),
    row({ status: "pending", firedAt: ago(30), sentAt: null }),
  ], opts);
  assert.equal(health.state, "stalled");
  assert.equal(health.stuckPending, 1);
  assert.match(health.summary, /never recorded an outcome/);
  assert.match(health.summary, /unresolved-intents/);
});

test("a pending alert inside the grace period is not stuck", () => {
  const health = summariseDelivery(
    [row({ status: "pending", firedAt: NOW - PENDING_GRACE_MS + 1_000, sentAt: null })], opts
  );
  assert.equal(health.stuckPending, 0);
  assert.notEqual(health.state, "stalled");
});

test("retries are counted, because a delivery that needed four attempts is not healthy news", () => {
  const health = summariseDelivery([row({ attempts: 4 }), row({ attempts: 1 })], opts);
  assert.equal(health.retried, 1);
});

test("the most recent send and the most recent failure are both reported", () => {
  const health = summariseDelivery([
    row({ sentAt: ago(90) }), row({ sentAt: ago(10) }),
    row({ status: "failed", firedAt: ago(200), sentAt: null }),
    row({ status: "failed", firedAt: ago(50), sentAt: null }),
  ], opts);
  assert.equal(health.lastSentAt, ago(10));
  assert.equal(health.lastFailureAt, ago(50));
});
