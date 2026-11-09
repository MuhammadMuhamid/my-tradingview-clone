import { test } from "node:test";
import assert from "node:assert/strict";
import type { QueryResult, QueryResultRow } from "pg";
import { createHash } from "node:crypto";
import {
  REALIZATION_CAPABILITIES, canonicalJson, declaredEnvironmentOf, normalizeRealizationBatch,
  normalizeRealizationEvent, platformWebhookIdentity, type RealizationEventV1, type RealizationEventV2,
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
  }) as RealizationEventV1;
}

class FakeDb implements RealizationDbClient {
  readonly rows = new Map<string, { hash: string; realizedAt: string }>();
  readonly declared = new Map<string, string | null>();
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
      this.declared.set(eventId, values[14] as string | null);
      rowCount = 1;
    }
    return { rows: rows as T[], rowCount, command: "", oid: 0, fields: [] };
  }
}

const batch = (...events: RealizationEventV1[]) => ({
  contractVersion: 1 as const, type: "BOT_CUSTOM_REALIZATION_BATCH" as const, events,
});

/** The same event as contract v2, with `environment`. */
const v2 = (environment: unknown, over: Partial<RealizationEventV1> = {}) =>
  normalizeRealizationEvent({ ...event(over), contractVersion: 2, environment }) as RealizationEventV2;
const batch2 = (...events: RealizationEventV2[]) => ({
  contractVersion: 2 as const, type: "BOT_CUSTOM_REALIZATION_BATCH" as const, events,
});

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

test("OD-5: a v1 event normalizes to exactly the v1 keys, with the same hash as before v2 existed", () => {
  const normalized = event();
  assert.deepEqual(Object.keys(normalized).sort(), ["accounting", "contractVersion", "eventId", "exchangeOrderId",
    "exitLeg", "exitPrice", "exitRevenueQuote", "exitSide", "kind", "platformDedupeKey", "platformDeploymentId",
    "platformOrderIntentId", "platformWebhookIdentity", "positionDirection", "quoteCurrency", "realizedAt",
    "realizedPnlQuote", "realizedQuantity", "strategyOrderIntentId", "symbol", "type"]);
  // Computed from the contract at 0afaeec (before v2), split so no long hex literal sits in the source.
  assert.equal(sha256(canonicalJson(normalized)), "68a821bc98cb26f7193b5c065a87333580e4acd6" + "6f44771ec5eba04daec6f142");
});

test("OD-5: v2 requires environment from the strict set; its hash covers it", () => {
  for (const environment of ["DRY_RUN", "TESTNET", "MAINNET", "UNKNOWN"] as const) {
    const normalized = v2(environment);
    assert.equal(normalized.contractVersion, 2);
    assert.equal(normalized.contractVersion === 2 && normalized.environment, environment);
    assert.deepEqual(normalizeRealizationBatch(batch2(normalized)).events, [normalized]);
  }
  assert.equal(declaredEnvironmentOf(v2("MAINNET")), "MAINNET");
  assert.equal(declaredEnvironmentOf(v2("TESTNET")), "TESTNET");
  assert.equal(declaredEnvironmentOf(v2("DRY_RUN")), "DRY_RUN");
  assert.equal(declaredEnvironmentOf(v2("UNKNOWN")), null, "UNKNOWN is stored as NULL");
  assert.equal(declaredEnvironmentOf(event()), null, "v1 declares nothing");
  const hashes = new Set([event(), v2("MAINNET"), v2("TESTNET")].map((e) => sha256(canonicalJson(e))));
  assert.equal(hashes.size, 3, "version and environment are part of the immutable payload");
  for (const environment of ["REAL", "mainnet", "LIVE", "", 1, true, null, { value: "MAINNET" }]) {
    assert.throws(() => v2(environment), JSON.stringify(environment));
  }
  const { environment: _dropped, ...missing } = v2("TESTNET");
  assert.throws(() => normalizeRealizationEvent(missing), "v2 without environment");
  assert.throws(() => normalizeRealizationEvent({ ...event(), environment: "MAINNET" }), "v1 with environment is an unknown key");
  assert.throws(() => normalizeRealizationEvent({ ...v2("TESTNET"), extra: 1 }), "unknown keys are still refused");
  assert.throws(() => normalizeRealizationEvent({ ...event(), contractVersion: 3 }));
});

test("OD-5: a batch and its events share one version", () => {
  assert.throws(() => normalizeRealizationBatch({ ...batch2(v2("TESTNET")), contractVersion: 1 }));
  assert.throws(() => normalizeRealizationBatch({ ...batch(event()), contractVersion: 2 }));
  assert.throws(() => normalizeRealizationBatch({ ...batch2(v2("TESTNET")),
    events: [v2("TESTNET"), event({ eventId: "bot-realization-v1:partial:mix" })] }));
  assert.deepEqual(REALIZATION_CAPABILITIES, ["realization.v2"]);
});

test("OD-5: ingestion stores the declared environment; the same id under the other version is a conflict", async () => {
  const db = new FakeDb();
  const declared = v2("MAINNET");
  assert.deepEqual(await ingestRealizationBatch(db, batch2(declared)), [declared.eventId]);
  assert.equal(db.declared.get(declared.eventId), "MAINNET");
  assert.deepEqual(await ingestRealizationBatch(db, batch2(declared)), [declared.eventId], "identical re-send");
  await assert.rejects(ingestRealizationBatch(db, batch(event())), RealizationIntegrityConflict);
  await assert.rejects(ingestRealizationBatch(db, batch2(v2("TESTNET"))), RealizationIntegrityConflict);
  const unknown = v2("UNKNOWN", { eventId: "bot-realization-v1:final:unknown", kind: "final" });
  await ingestRealizationBatch(db, batch2(unknown));
  assert.equal(db.declared.get(unknown.eventId), null);
  const plain = event({ eventId: "bot-realization-v1:final:plain", kind: "final" });
  await ingestRealizationBatch(db, batch(plain));
  assert.equal(db.declared.get(plain.eventId), null);
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
  const future = String(Number(timestamp) + 60_000);
  const futureInput = { ...input, timestamp: future };
  const futureSignature = signManualCommand(futureInput, secret);
  const first = verifyRealizationRequest({ ...futureInput, secret,
    signature: futureSignature, now: Number(timestamp) });
  assert.equal(first.ok, true);
  if (first.ok) {
    assert.ok(first.expiresAt.getTime() > Number(future) + 60_000);
    assert.equal(verifyRealizationRequest({ ...futureInput, secret,
      signature: futureSignature, now: Number(future) + 60_000 }).ok, true);
  }
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
