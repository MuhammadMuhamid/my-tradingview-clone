import { test } from "node:test";
import assert from "node:assert/strict";
import type { QueryResult, QueryResultRow } from "pg";
import {
  canonicalJson, normalizeRealizationBatch, normalizeRealizationEvent, platformWebhookIdentity,
  type RealizationEventV1,
} from "../src/contract/realizationEventContract";
import { signManualCommand } from "../src/manualTrading/client";
import { verifyRealizationRequest } from "../src/realizations/auth";
import {
  ingestRealizationBatch, RealizationCorrelationError, RealizationIntegrityConflict,
  type RealizationDbClient,
} from "../src/realizations/ingestion";

const deploymentId = "11111111-1111-4111-8111-111111111111";
const webhookSecret = "realization-test-webhook-secret-000000000000";

function event(over: Partial<RealizationEventV1> = {}): RealizationEventV1 {
  return normalizeRealizationEvent({
    contractVersion: 1, type: "BOT_CUSTOM_REALIZATION",
    eventId: "bot-realization-v1:partial:partial-1", kind: "partial",
    realizedAt: "2026-09-02T12:00:00.123Z", realizedPnlQuote: "4.945",
    realizedQuantity: "0.4", exitPrice: "120", exitRevenueQuote: "48",
    quoteCurrency: "USDT", symbol: "BTCUSDT", positionDirection: "long", exitSide: "sell",
    strategyOrderIntentId: "bot-intent-1", exchangeOrderId: "exchange-1",
    platformWebhookIdentity: platformWebhookIdentity(webhookSecret),
    platformDeploymentId: deploymentId, platformOrderIntentId: "41",
    platformDedupeKey: "X-1788350400000-tp1", exitLeg: "tp1",
    accounting: { pnlBasis: "modeled_fee_adjusted", feeModel: "fixed_rate_both_sides",
      buyFeeRate: "0.001", sellFeeRate: "0.001",
      commissionSource: "modeled_not_exchange_observed" },
    ...over,
  });
}

class FakeDb implements RealizationDbClient {
  readonly rows = new Map<string, { hash: string; realizedAt: string }>();
  correlation = { deploymentId, orderIntentId: "41", dedupeKey: "X-1788350400000-tp1",
    symbol: "BTCUSDT", action: "sell", delivery: "custom", secret: webhookSecret };

  async query<T extends QueryResultRow = QueryResultRow>(sql: string, values: unknown[] = []): Promise<QueryResult<T>> {
    let rows: QueryResultRow[] = [];
    let rowCount = 0;
    if (sql.startsWith("SELECT source_payload_sha256")) {
      const found = this.rows.get(String(values[0]));
      if (found) rows = [{ source_payload_sha256: found.hash }];
    } else if (sql.includes("FROM order_intents oi")) {
      const direct = sql.includes("WHERE oi.id = $1");
      if ((direct && String(values[0]) === this.correlation.orderIntentId
            && String(values[1]) === this.correlation.deploymentId)
          || (!direct && String(values[0]) === this.correlation.dedupeKey)) {
        rows = [{ id: this.correlation.orderIntentId, deployment_id: this.correlation.deploymentId,
          dedupe_key: this.correlation.dedupeKey, action: this.correlation.action,
          symbol: this.correlation.symbol, delivery: this.correlation.delivery,
          encrypted_secret: this.correlation.secret, alert_id: 9 }];
      }
    } else if (sql.includes("INSERT INTO realised_pnl")) {
      const eventId = String(values[7]);
      if (this.rows.has(eventId)) throw Object.assign(new Error("unique"), { code: "23505" });
      this.rows.set(eventId, { hash: String(values[13]), realizedAt: String(values[2]) });
      rowCount = 1;
    }
    return { rows: rows as T[], rowCount, command: "", oid: 0, fields: [] };
  }
}

const batch = (...events: RealizationEventV1[]) => ({
  contractVersion: 1 as const, type: "BOT_CUSTOM_REALIZATION_BATCH" as const, events,
});

test("v1 canonicalizes exact decimal and timestamp spellings before conflict comparison", () => {
  const normalized = normalizeRealizationEvent({ ...event(), realizedPnlQuote: "+004.94500e0",
    realizedQuantity: "4.00e-1", realizedAt: "2026-09-02T08:00:00.123-04:00" });
  assert.equal(normalized.realizedPnlQuote, "4.945");
  assert.equal(normalized.realizedQuantity, "0.4");
  assert.equal(normalized.realizedAt, "2026-09-02T12:00:00.123Z");
  assert.equal(canonicalJson(normalized), canonicalJson(event()));
});

test("authenticated bounded batch accepts identical replay exactly once", async () => {
  const db = new FakeDb();
  const payload = batch(event());
  assert.deepEqual(await ingestRealizationBatch(db, payload), [event().eventId]);
  assert.deepEqual(await ingestRealizationBatch(db, payload), [event().eventId]);
  assert.equal(db.rows.size, 1);

  const timestamp = String(Date.UTC(2026, 8, 2, 12));
  const nonce = "nonce_1234567890123456";
  const requestId = "request_12345678901234";
  const secret = "r".repeat(40);
  const input = { method: "POST", path: "/api/internal/realization-events/v1",
    timestamp, nonce, requestId, body: payload };
  const signature = signManualCommand(input, secret);
  assert.equal(verifyRealizationRequest({ ...input, secret, signature,
    now: Number(timestamp) }).ok, true);
  assert.equal(verifyRealizationRequest({ ...input, secret, signature: `${signature}0`,
    now: Number(timestamp) }).ok, false);
});

test("same event identity with different immutable economics fails closed", async () => {
  const db = new FakeDb();
  await ingestRealizationBatch(db, batch(event()));
  await assert.rejects(
    ingestRealizationBatch(db, batch(event({ realizedPnlQuote: "999" }))),
    RealizationIntegrityConflict
  );
  assert.equal(db.rows.size, 1);
});

test("exact deployment/order provenance is mandatory", async () => {
  const db = new FakeDb();
  db.correlation.dedupeKey = "another-order";
  await assert.rejects(ingestRealizationBatch(db, batch(event())), RealizationCorrelationError);
  assert.equal(db.rows.size, 0);
});

test("old-Platform event resolves exactly by credential identity and dedupe key", async () => {
  const db = new FakeDb();
  const legacy = event({ platformDeploymentId: null, platformOrderIntentId: null });
  assert.deepEqual(await ingestRealizationBatch(db, batch(legacy)), [legacy.eventId]);
  assert.equal(db.rows.size, 1);

  const wrongSource = event({ eventId: "bot-realization-v1:final:wrong-source",
    kind: "final", platformDeploymentId: null, platformOrderIntentId: null,
    platformWebhookIdentity: platformWebhookIdentity(`${webhookSecret}-other`) });
  await assert.rejects(ingestRealizationBatch(db, batch(wrongSource)), RealizationCorrelationError);
});

test("arrival order never changes economics or authoritative realization chronology", async () => {
  const db = new FakeDb();
  const later = event({ eventId: "bot-realization-v1:final:bot-intent-2", kind: "final",
    realizedAt: "2026-09-02T12:05:00.000Z", strategyOrderIntentId: "bot-intent-2",
    exchangeOrderId: "exchange-2", realizedPnlQuote: "10", exitLeg: "runner" });
  const earlier = event();
  db.correlation.orderIntentId = later.platformOrderIntentId!;
  await ingestRealizationBatch(db, batch(later));
  db.correlation.orderIntentId = earlier.platformOrderIntentId!;
  await ingestRealizationBatch(db, batch(earlier));
  assert.equal(db.rows.get(later.eventId)?.realizedAt, later.realizedAt);
  assert.equal(db.rows.get(earlier.eventId)?.realizedAt, earlier.realizedAt);
});

test("strict batch rejects unsupported, duplicate, empty, and oversized input", () => {
  assert.throws(() => normalizeRealizationBatch({ contractVersion: 2,
    type: "BOT_CUSTOM_REALIZATION_BATCH", events: [event()] }));
  assert.throws(() => normalizeRealizationBatch(batch()));
  assert.throws(() => normalizeRealizationBatch(batch(event(), event())));
  assert.throws(() => normalizeRealizationBatch(batch(...Array.from({ length: 51 }, (_, index) =>
    event({ eventId: `bot-realization-v1:partial:${index}` })))));
});
