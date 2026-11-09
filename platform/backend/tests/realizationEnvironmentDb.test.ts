/**
 * Realization contract v2 through persistence (owner decision OD-5): a signed
 * batch is accepted with `capabilities`, the declared environment is stored as
 * declared, and the Journal labels it by the no-REAL-without-proof rule.
 *
 * Runs in its OWN database, for the reason `accountsDb.test.ts` gives.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";

const base = new URL(process.env.DATABASE_URL ?? "postgres://platform:platform@127.0.0.1:5433/platform_test");
const target = `${base.pathname.replace(/^\//, "") || "platform_test"}_realization_environment`;
const ownUrl = new URL(base.toString());
ownUrl.pathname = `/${target}`;
process.env.DATABASE_URL = ownUrl.toString();

async function prepare(): Promise<string | null> {
  const maintenance = new URL(base.toString());
  maintenance.pathname = "/postgres";
  const admin = new Pool({ connectionString: maintenance.toString(), connectionTimeoutMillis: 2_000, max: 1 });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${JSON.stringify(target)} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${JSON.stringify(target)}`);
    return null;
  } catch (error) {
    return `no local PostgreSQL (${(error as Error).message})`;
  } finally {
    await admin.end();
  }
}

const PATH = "/api/internal/realization-events/v1";
const HMAC = "realization-environment-test-hmac-0000000000000";
const WEBHOOK_SECRET = "realization-environment-webhook-secret-00000000";
const CLOSED = "2026-10-11T12:00:00.000Z";

test("realization environment (contract v2)", async (t) => {
  const skip = await prepare();
  if (skip && !process.env.CI) { t.skip(skip); return; }
  assert.equal(skip, null, skip ?? "");

  const { migrate } = await import("../src/db/migrate");
  const { closePool, query } = await import("../src/db/pool");
  const { config } = await import("../src/config");
  const { encryptSecret } = await import("../src/security/secrets");
  const { signManualCommand } = await import("../src/manualTrading/client");
  const { platformWebhookIdentity } = await import("../src/contract/realizationEventContract");
  const { realizationEventRoutes } = await import("../src/api/routes/realizationEvents");
  const { journalRoutes } = await import("../src/api/routes/journal");
  const Fastify = (await import("fastify")).default;
  after(() => closePool());
  await migrate();

  const previous = { enabled: config.realizationIngestionEnabled, secret: config.realizationHmacSecret,
    manual: config.manualTradingEnabled };
  Object.assign(config, { realizationIngestionEnabled: true, realizationHmacSecret: HMAC, manualTradingEnabled: false });
  t.after(() => Object.assign(config, { realizationIngestionEnabled: previous.enabled,
    realizationHmacSecret: previous.secret, manualTradingEnabled: previous.manual }));

  const strategy = (await query<{ id: number }>("SELECT id FROM strategies ORDER BY id LIMIT 1")).rows[0]!.id;
  const deploymentId = (await query<{ id: string }>(
    `INSERT INTO deployments (strategy_id, symbol, timeframe, params, delivery, webhook_url, secret)
     VALUES ($1, 'BTCUSDT', '1h', '{}', 'custom', 'https://bot.example.test/hook', $2) RETURNING id`,
    [strategy, encryptSecret(WEBHOOK_SECRET)])).rows[0]!.id;
  const intent = async (dedupe: string) => String((await query<{ id: string }>(
    `INSERT INTO order_intents (deployment_id, dedupe_key, action, bar_time, state, created_at)
     VALUES ($1, $2, 'sell', $3, 'delivered', $3) RETURNING id`, [deploymentId, dedupe, CLOSED])).rows[0]!.id);

  const app = Fastify({ logger: false });
  await realizationEventRoutes(app);
  await journalRoutes(app);
  t.after(() => app.close());

  let seq = 0;
  const post = (raw: object) => {
    // What goes over the wire, so the signature covers exactly that (an undefined key is dropped).
    const body = JSON.parse(JSON.stringify(raw)) as object;
    seq += 1;
    const timestamp = String(Date.now());
    const nonce = `nonce_env_${String(seq).padStart(10, "0")}`;
    const requestId = `request_env_${String(seq).padStart(8, "0")}`;
    const signature = signManualCommand({ method: "POST", path: PATH, timestamp, nonce, requestId, body }, HMAC);
    return app.inject({ method: "POST", url: PATH, payload: body, headers: {
      "x-realization-timestamp": timestamp, "x-realization-nonce": nonce,
      "x-realization-request-id": requestId, "x-realization-signature": signature } });
  };
  const event = (version: 1 | 2, over: { id: string; intent: string; dedupe: string; exchangeOrderId?: string;
    pnl?: string; environment?: unknown }) => ({
    contractVersion: version, type: "BOT_CUSTOM_REALIZATION", eventId: over.id, kind: "final",
    realizedAt: CLOSED, realizedPnlQuote: over.pnl ?? "10", realizedQuantity: "0.1", exitPrice: "100",
    exitRevenueQuote: "10", quoteCurrency: "USDT", symbol: "BTCUSDT", positionDirection: "long", exitSide: "sell",
    strategyOrderIntentId: `bot-${over.id}`, exchangeOrderId: over.exchangeOrderId ?? `88${seq}${over.intent}`,
    platformWebhookIdentity: platformWebhookIdentity(WEBHOOK_SECRET),
    platformDeploymentId: deploymentId, platformOrderIntentId: over.intent, platformDedupeKey: over.dedupe,
    exitLeg: "signal",
    accounting: { pnlBasis: "modeled_fee_adjusted", feeModel: "fixed_rate_both_sides",
      buyFeeRate: "0.001", sellFeeRate: "0.001", commissionSource: "modeled_not_exchange_observed" },
    ...(version === 2 ? { environment: over.environment } : {}),
  });
  const batch = (version: 1 | 2, ...events: object[]) => ({ contractVersion: version, type: "BOT_CUSTOM_REALIZATION_BATCH", events });
  const stored = async (id: string) => (await query<{ declared_environment: string | null }>(
    "SELECT declared_environment FROM realised_pnl WHERE source_event_id = $1", [id])).rows[0]?.declared_environment;

  const fixtures: Record<string, { version: 1 | 2; env?: string; exchangeOrderId?: string; pnl: string }> = {
    mainnet: { version: 2, env: "MAINNET", pnl: "100" },
    testnet: { version: 2, env: "TESTNET", pnl: "20" },
    unknown: { version: 2, env: "UNKNOWN", pnl: "3" },
    dryConsistent: { version: 2, env: "DRY_RUN", exchangeOrderId: "dry-sell-9", pnl: "4" },
    mainnetButDry: { version: 2, env: "MAINNET", exchangeOrderId: "dry-sell-10", pnl: "5000" },
    dryButExchange: { version: 2, env: "DRY_RUN", exchangeOrderId: "77001", pnl: "6000" },
    legacyV1: { version: 1, pnl: "7" },
  };
  const ids: Record<string, string> = {};

  await t.test("a v2 batch per environment is accepted, answers capabilities, and stores what was declared", async () => {
    for (const [name, f] of Object.entries(fixtures)) {
      const id = `bot-realization-v${f.version}:final:${name}`;
      ids[name] = id;
      const res = await post(batch(f.version, event(f.version, { id, intent: await intent(`X-${name}`), dedupe: `X-${name}`,
        exchangeOrderId: f.exchangeOrderId, pnl: f.pnl, environment: f.env })));
      assert.equal(res.statusCode, 200, `${name}: ${res.body}`);
      assert.deepEqual(res.json(), { status: "accepted", acceptedEventIds: [id], capabilities: ["realization.v2"] });
    }
    assert.equal(await stored(ids.mainnet!), "MAINNET");
    assert.equal(await stored(ids.testnet!), "TESTNET");
    assert.equal(await stored(ids.unknown!), null, "UNKNOWN is stored as NULL");
    assert.equal(await stored(ids.legacyV1!), null, "v1 declares nothing");
    assert.equal(await stored(ids.mainnetButDry!), "MAINNET", "stored as declared; the read decides what it proves");
  });

  await t.test("anything else is refused before it is stored", async () => {
    const dedupe = "X-refused";
    const intentId = await intent(dedupe);
    for (const environment of ["REAL", "mainnet", "LIVE", "", 1, null, { value: "MAINNET" }, undefined]) {
      const res = await post(batch(2, event(2, { id: "bot-realization-v2:final:refused", intent: intentId, dedupe, environment })));
      assert.equal(res.statusCode, 400, `${JSON.stringify(environment)}: ${res.body}`);
    }
    // A v1 event carrying environment has an unknown key; versions must match the batch.
    const v1WithEnv = { ...event(1, { id: "bot-realization-v1:final:refused", intent: intentId, dedupe }), environment: "MAINNET" };
    assert.equal((await post(batch(1, v1WithEnv))).statusCode, 400);
    assert.equal((await post(batch(2, event(1, { id: "bot-realization-v1:final:mixed", intent: intentId, dedupe })))).statusCode, 400);
    assert.equal((await post(batch(1, event(2, { id: "bot-realization-v2:final:mixed", intent: intentId, dedupe, environment: "TESTNET" })))).statusCode, 400);
    assert.equal((await query("SELECT 1 FROM realised_pnl WHERE source_event_id LIKE '%refused%' OR source_event_id LIKE '%mixed%'")).rowCount, 0);
  });

  await t.test("an identical re-send is accepted again; the same id under the other version or environment is 409", async () => {
    const f = fixtures.mainnet!;
    const again = await post(batch(2, event(2, { id: ids.mainnet!, intent: await intentOf("X-mainnet"), dedupe: "X-mainnet",
      exchangeOrderId: await exchangeIdOf(ids.mainnet!), pnl: f.pnl, environment: "MAINNET" })));
    assert.equal(again.statusCode, 200, again.body);
    const otherEnv = await post(batch(2, event(2, { id: ids.mainnet!, intent: await intentOf("X-mainnet"), dedupe: "X-mainnet",
      exchangeOrderId: await exchangeIdOf(ids.mainnet!), pnl: f.pnl, environment: "TESTNET" })));
    assert.equal(otherEnv.statusCode, 409, otherEnv.body);
    const asV1 = await post(batch(1, event(1, { id: ids.mainnet!, intent: await intentOf("X-mainnet"), dedupe: "X-mainnet",
      exchangeOrderId: await exchangeIdOf(ids.mainnet!), pnl: f.pnl })));
    assert.equal(asV1.statusCode, 409, asV1.body);
    assert.equal(await stored(ids.mainnet!), "MAINNET", "nothing was overwritten");
  });

  async function intentOf(dedupe: string): Promise<string> {
    return String((await query<{ id: string }>("SELECT id FROM order_intents WHERE dedupe_key = $1", [dedupe])).rows[0]!.id);
  }
  async function exchangeIdOf(eventId: string): Promise<string> {
    return (await query<{ source_exchange_order_id: string }>(
      "SELECT source_exchange_order_id FROM realised_pnl WHERE source_event_id = $1", [eventId])).rows[0]!.source_exchange_order_id;
  }

  await t.test("the Journal: MAINNET is REAL, TESTNET is TESTNET, contradictions and v1 are UNKNOWN; only REAL counts as real", async () => {
    const res = await app.inject({ method: "GET", url: "/api/journal?from=2026-10-11&to=2026-10-11&sources=AUTOMATED" });
    assert.equal(res.statusCode, 200, res.body);
    const journal = res.json() as import("../src/journal/types").JournalResponse;
    const envOf = async (eventId: string) => {
      const rowId = (await query<{ id: string }>("SELECT id FROM realised_pnl WHERE source_event_id = $1", [eventId])).rows[0]!.id;
      return journal.rows.find((row) => row.id === `automated-realization:${rowId}`)?.environment;
    };
    assert.equal(await envOf(ids.mainnet!), "REAL");
    assert.equal(await envOf(ids.testnet!), "TESTNET");
    assert.equal(await envOf(ids.unknown!), "UNKNOWN");
    assert.equal(await envOf(ids.dryConsistent!), "DRY_RUN");
    assert.equal(await envOf(ids.mainnetButDry!), "UNKNOWN", "MAINNET with a dry- id proves nothing");
    assert.equal(await envOf(ids.dryButExchange!), "UNKNOWN", "DRY_RUN with an exchange id proves nothing");
    assert.equal(await envOf(ids.legacyV1!), "UNKNOWN");
    assert.equal(journal.summary.real.knownRealizedPnl, 100, "only the consistent MAINNET row is real money");
    assert.equal(journal.summary.real.realizationRows, 1);
    // P&L stays the Bot's modeled figure, never relabelled as exchange-observed.
    const real = journal.rows.find((row) => row.environment === "REAL")!;
    assert.match(JSON.stringify(real), /modeled/);
  });
});
