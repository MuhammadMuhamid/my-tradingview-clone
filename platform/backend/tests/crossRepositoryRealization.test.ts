import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Fastify from "fastify";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import { config } from "../src/config";
import { realizationEventRoutes } from "../src/api/routes/realizationEvents";
import { platformWebhookIdentity } from "../src/contract/realizationEventContract";

const botRoot = process.env.TRADING_SCENE_BOT_ROOT;
const dbPath = botRoot ? path.join(botRoot, "backend", "tests", ".tmp-cross-repo.db") : "";
const original = { enabled: config.realizationIngestionEnabled, secret: config.realizationHmacSecret };
const webhookSecret = "cross-repository-webhook-secret-000000000000";

after(() => {
  config.realizationIngestionEnabled = original.enabled;
  config.realizationHmacSecret = original.secret;
  if (dbPath) for (const suffix of ["", "-journal", "-shm", "-wal"]) {
    fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }
});

class ReceiptDb {
  readonly realized = new Map<string, string>();
  readonly nonces = new Set<string>();
  readonly correlations = new Map([
    ["41", { dedupe: "X-cross-tp1", alert: 101 }],
    ["42", { dedupe: "X-cross-final", alert: 102 }],
  ]);

  async query<T extends QueryResultRow = QueryResultRow>(sql: string, values: unknown[] = []): Promise<QueryResult<T>> {
    let rows: QueryResultRow[] = [];
    let rowCount = 0;
    if (sql.startsWith("INSERT INTO realization_ingest_nonces")) {
      const nonce = String(values[0]);
      if (!this.nonces.has(nonce)) { this.nonces.add(nonce); rows = [{ nonce }]; rowCount = 1; }
    } else if (sql.startsWith("SELECT source_payload_sha256")) {
      const hash = this.realized.get(String(values[0]));
      if (hash) rows = [{ source_payload_sha256: hash }];
    } else if (sql.includes("FROM order_intents oi")) {
      const correlation = this.correlations.get(String(values[0]));
      if (correlation) rows = [{ id: String(values[0]), deployment_id: String(values[1]),
        dedupe_key: correlation.dedupe, action: "sell", alert_id: correlation.alert,
        symbol: "BTCUSDT", delivery: "custom", encrypted_secret: webhookSecret }];
    } else if (sql.includes("INSERT INTO realised_pnl")) {
      const eventId = String(values[7]);
      if (!this.realized.has(eventId)) {
        this.realized.set(eventId, String(values[13])); rows = [{ id: this.realized.size }]; rowCount = 1;
      }
    }
    return { rows: rows as T[], rowCount, command: "", oid: 0, fields: [] };
  }
  release(): void {}
}

test("loopback Bot outbox to authenticated Platform receipt survives duplicate replay", {
  skip: !botRoot,
}, async () => {
  if (!botRoot) return;
  const backend = path.join(botRoot, "backend");
  for (const suffix of ["", "-journal", "-shm", "-wal"]) fs.rmSync(`${dbPath}${suffix}`, { force: true });
  const databaseUrl = `file:${dbPath}`;
  execFileSync(process.execPath, [path.join(backend, "node_modules", "prisma", "build", "index.js"),
    "migrate", "deploy"], { cwd: backend, env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: "pipe" });
  process.env.DATABASE_URL = databaseUrl;
  const botPrismaModule = await import(pathToFileURL(path.join(backend, "src", "lib", "prisma.ts")).href);
  const botConfigModule = await import(pathToFileURL(path.join(backend, "src", "config.ts")).href);
  const botContract = await import(pathToFileURL(path.join(backend, "src", "contract", "realizationEventContract.ts")).href);
  const botDelivery = await import(pathToFileURL(path.join(backend, "src", "services", "realizationEvents.ts")).href);
  const botPrisma = botPrismaModule.prisma;
  const botConfig = botConfigModule.config;
  const hmacSecret = "cross-repository-realization-secret-0000000000";
  config.realizationIngestionEnabled = true;
  config.realizationHmacSecret = hmacSecret;
  const db = new ReceiptDb();
  const app = Fastify({ logger: false });
  await realizationEventRoutes(app, { connect: async () => db as unknown as PoolClient });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  botConfig.realizationDeliveryEnabled = true;
  botConfig.realizationPlatformUrl = `${address}/api/internal/realization-events/v1`;
  botConfig.realizationHmacSecret = hmacSecret;

  const deploymentId = "11111111-1111-4111-8111-111111111111";
  const make = (input: { id: string; kind: "partial" | "final"; intent: string;
    platformIntent: string; dedupe: string; at: string; pnl: string; qty: string;
    revenue: string; leg: "tp1" | "runner" }) => botContract.normalizeRealizationEvent({
      contractVersion: 1, type: "BOT_CUSTOM_REALIZATION", eventId: input.id,
      kind: input.kind, realizedAt: input.at, realizedPnlQuote: input.pnl,
      realizedQuantity: input.qty, exitPrice: "120", exitRevenueQuote: input.revenue,
      quoteCurrency: "USDT", symbol: "BTCUSDT", positionDirection: "long", exitSide: "sell",
      strategyOrderIntentId: input.intent, exchangeOrderId: `exchange-${input.intent}`,
      platformWebhookIdentity: platformWebhookIdentity(webhookSecret),
      platformDeploymentId: deploymentId, platformOrderIntentId: input.platformIntent,
      platformDedupeKey: input.dedupe, exitLeg: input.leg,
      accounting: { pnlBasis: "modeled_fee_adjusted", feeModel: "fixed_rate_both_sides",
        buyFeeRate: "0.001", sellFeeRate: "0.001",
        commissionSource: "modeled_not_exchange_observed" },
    });
  const events = [
    make({ id: "bot-realization-v1:partial:cross", kind: "partial", intent: "bot-partial",
      platformIntent: "41", dedupe: "X-cross-tp1", at: "2026-09-02T12:00:00Z",
      pnl: "10", qty: "0.4", revenue: "48", leg: "tp1" }),
    make({ id: "bot-realization-v1:final:cross", kind: "final", intent: "bot-final",
      platformIntent: "42", dedupe: "X-cross-final", at: "2026-09-02T12:05:00Z",
      pnl: "20", qty: "0.6", revenue: "72", leg: "runner" }),
  ];
  for (const event of events) {
    const payload = botContract.canonicalJson(event);
    await botPrisma.realizationEvent.create({ data: { id: event.eventId,
      strategyIntentId: event.strategyOrderIntentId, kind: event.kind,
      eventTime: new Date(event.realizedAt), payload,
      payloadSha256: createHash("sha256").update(payload).digest("hex") } });
  }
  try {
    botConfig.realizationPlatformUrl = "http://127.0.0.1:1/api/internal/realization-events/v1";
    assert.deepEqual(await botDelivery.deliverPendingRealizations(fetch, new Date()),
      { attempted: 2, delivered: 0 });
    assert.equal(await botPrisma.realizationEvent.count({ where: { deliveryStatus: "pending" } }), 2);
    await botPrisma.realizationEvent.updateMany({ data: { nextAttemptAt: new Date(0) } });
    botConfig.realizationPlatformUrl = `${address}/api/internal/realization-events/v1`;
    assert.deepEqual(await botDelivery.deliverPendingRealizations(fetch, new Date()),
      { attempted: 2, delivered: 2 });
    assert.equal(db.realized.size, 2);
    await botPrisma.realizationEvent.updateMany({ data: { deliveryStatus: "pending",
      deliveredAt: null, nextAttemptAt: new Date(0) } });
    assert.deepEqual(await botDelivery.deliverPendingRealizations(fetch, new Date()),
      { attempted: 2, delivered: 2 });
    assert.equal(db.realized.size, 2);
  } finally {
    await app.close();
    await botPrisma.$disconnect();
  }
});
