/**
 * D3 through persistence: saved realization and activity rows, read back by
 * the real repository SQL, labelled by the Journal and the chart overlay.
 *
 * The environment rules depend on two columns the repository must select:
 * `realised_pnl.source_system` (only `BOT_CUSTOM_V1` proves the custom Bot)
 * and `deployments.delivery` (3commas activity is never the Bot's). Unit tests
 * hand those values to the projection directly, so dropping either SELECT
 * would pass them all. This inserts the rows and goes through
 * `GET /api/journal` and `GET /api/trading-overlays`.
 *
 * Runs in its OWN database like accountSecurityDb.test.ts, because the shared
 * test database is dropped and recreated by another file in the same run.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";

const base = new URL(process.env.DATABASE_URL ?? "postgres://platform:platform@127.0.0.1:5433/platform_test");
const target = `${base.pathname.replace(/^\//, "") || "platform_test"}_journal_environment`;
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

const CLOSED = "2026-10-10T12:00:00.000Z";
const SHA = "a".repeat(64);

test("saved rows are labelled from their own provenance, identically on the Journal and the chart", async (t) => {
  const skip = await prepare();
  if (skip && !process.env.CI) { t.skip(skip); return; }
  assert.equal(skip, null, skip ?? "");
  const { migrate } = await import("../src/db/migrate");
  const { closePool, query } = await import("../src/db/pool");
  const { config } = await import("../src/config");
  const { journalRoutes } = await import("../src/api/routes/journal");
  const { tradingOverlayRoutes } = await import("../src/api/routes/tradingOverlays");
  const Fastify = (await import("fastify")).default;
  after(() => closePool());
  await migrate();
  // No Bot is asked anything: manual trading is off, and neither route may
  // read the Bot's current mode any more.
  const previous = config.manualTradingEnabled;
  config.manualTradingEnabled = false;
  t.after(() => { config.manualTradingEnabled = previous; });

  const strategy = (await query<{ id: number }>("SELECT id FROM strategies ORDER BY id LIMIT 1")).rows[0]!.id;
  const deployment = async (delivery: "custom" | "3commas") => (await query<{ id: string }>(
    `INSERT INTO deployments (strategy_id, symbol, timeframe, params, delivery, webhook_url, secret, bot_uuid)
     VALUES ($1, 'BTCUSDT', '1h', '{}', $2, 'https://bot.example.test/hook', 'not-a-real-secret', $3)
     RETURNING id`, [strategy, delivery, delivery === "3commas" ? "bot-uuid" : null])).rows[0]!.id;
  const custom = await deployment("custom");
  const threeCommas = await deployment("3commas");

  const legacy = async (deploymentId: string, pnl: number) => (await query<{ id: string }>(
    `INSERT INTO realised_pnl (deployment_id, closed_at, pnl_quote, exit_price, quantity, reason)
     VALUES ($1, $2, $3, 100, 0.1, 'legacy') RETURNING id`, [deploymentId, CLOSED, pnl])).rows[0]!.id;
  const botRealization = async (eventId: string, exchangeOrderId: string, pnl: number) => (await query<{ id: string }>(
    `INSERT INTO realised_pnl (deployment_id, closed_at, pnl_quote, exit_price, quantity, reason,
       source_system, source_event_id, realization_kind, source_strategy_order_intent_id,
       source_exchange_order_id, source_platform_order_intent_id, accounting_basis, fee_model,
       quote_currency, exit_revenue_quote, source_payload_sha256, received_at)
     VALUES ($1, $2, $3, 100, 0.1, 'tp1', 'BOT_CUSTOM_V1', $4, 'partial', $5, $6, 41,
       'modeled_fee_adjusted', 'fixed_0.1pct_each_side_not_exchange_observed', 'USDT', 10, $7, now())
     RETURNING id`, [custom, CLOSED, pnl, eventId, `intent-${eventId}`, exchangeOrderId, SHA])).rows[0]!.id;
  const execution = async (deploymentId: string, exchangeOrderId: string, minute: number) => (await query<{ id: string }>(
    `INSERT INTO executions (deployment_id, exchange_order_id, side, order_type, qty, price, status, created_at)
     VALUES ($1, $2, 'BUY', 'MARKET', 1, 100, 'FILLED', $3) RETURNING id`,
    [deploymentId, exchangeOrderId, `2026-10-10T11:${String(minute).padStart(2, "0")}:00.000Z`])).rows[0]!.id;
  const intent = async (deploymentId: string, dedupe: string) => (await query<{ id: string }>(
    `INSERT INTO order_intents (deployment_id, dedupe_key, action, bar_time, state, created_at)
     VALUES ($1, $2, 'buy', $3, 'delivered', $3) RETURNING id`, [deploymentId, dedupe, CLOSED])).rows[0]!.id;

  const ids = {
    legacyCustom: await legacy(custom, 5),
    legacyThreeCommas: await legacy(threeCommas, 3),
    botAcknowledged: await botRealization("bot-realization-v1:partial:a", "8812345", 10),
    botDryRun: await botRealization("bot-realization-v1:partial:b", "dry-sell-1", 1000),
    executionDryCustom: await execution(custom, "dry-buy-1", 1),
    executionCustom: await execution(custom, "7001", 2),
    executionDryThreeCommas: await execution(threeCommas, "dry-3c-1", 3),
    intentCustom: await intent(custom, "X-custom-1"),
    intentThreeCommas: await intent(threeCommas, "X-3c-1"),
  };

  const app = Fastify({ logger: false });
  await journalRoutes(app);
  await tradingOverlayRoutes(app);
  t.after(() => app.close());

  const journalRes = await app.inject({ method: "GET", url: "/api/journal?from=2026-10-10&to=2026-10-10" });
  assert.equal(journalRes.statusCode, 200, journalRes.body);
  const journal = journalRes.json() as import("../src/journal/types").JournalResponse;
  const journalEnv = Object.fromEntries(journal.rows.map((row) => [row.id, row.environment]));
  assert.deepEqual(journalEnv, {
    [`automated-realization:${ids.legacyCustom}`]: "UNKNOWN",
    [`automated-realization:${ids.legacyThreeCommas}`]: "UNKNOWN",
    // BOT_CUSTOM_V1, acknowledged: TESTNET or REAL, and nothing stored says which.
    [`automated-realization:${ids.botAcknowledged}`]: "UNKNOWN",
    [`automated-realization:${ids.botDryRun}`]: "DRY_RUN",
    [`execution-snapshot:${ids.executionDryCustom}`]: "DRY_RUN",
    [`execution-snapshot:${ids.executionCustom}`]: "UNKNOWN",
    // A dry- id on a 3commas deployment is not the custom Bot's evidence.
    [`execution-snapshot:${ids.executionDryThreeCommas}`]: "UNKNOWN",
    [`automated-intent:${ids.intentCustom}`]: "UNKNOWN",
    [`automated-intent:${ids.intentThreeCommas}`]: "UNKNOWN",
  });
  assert.ok(journal.rows.every((row) => row.environment !== "REAL"));
  assert.deepEqual(journal.summary.real, {
    knownRealizedPnl: 0, knownRealizedRows: 0, realizationRows: 0, knownFees: 0, feeKnownRows: 0,
    wins: 0, losses: 0, scratches: 0, incompleteRows: 0, unknownEconomicRows: 0,
    durationKnownRows: 0, averageDurationMs: null,
  });
  assert.equal(journal.summary.dryRun.knownRealizedPnl, 1000);
  assert.equal(journal.summary.unknownEnvironment.knownRealizedPnl, 18);

  const overlayRes = await app.inject({ method: "GET", url:
    `/api/trading-overlays?symbol=BTCUSDT&from=${Date.parse("2026-10-10T00:00:00Z")}&to=${Date.parse("2026-10-10T23:59:59Z")}&scope=historical` });
  assert.equal(overlayRes.statusCode, 200, overlayRes.body);
  const overlay = overlayRes.json() as import("../src/overlays/types").TradingOverlayResponse;
  const overlayEnv = Object.fromEntries(overlay.items.map((item) => [item.id, item.environment]));
  // The same saved rows, the same labels: realizations share an id; an
  // execution snapshot is `execution-snapshot:` in the Journal and
  // `automated-execution:` on the chart. Intents draw no marker.
  assert.deepEqual(overlayEnv, {
    [`automated-realization:${ids.legacyCustom}`]: journalEnv[`automated-realization:${ids.legacyCustom}`],
    [`automated-realization:${ids.legacyThreeCommas}`]: journalEnv[`automated-realization:${ids.legacyThreeCommas}`],
    [`automated-realization:${ids.botAcknowledged}`]: journalEnv[`automated-realization:${ids.botAcknowledged}`],
    [`automated-realization:${ids.botDryRun}`]: journalEnv[`automated-realization:${ids.botDryRun}`],
    [`automated-execution:${ids.executionDryCustom}`]: journalEnv[`execution-snapshot:${ids.executionDryCustom}`],
    [`automated-execution:${ids.executionCustom}`]: journalEnv[`execution-snapshot:${ids.executionCustom}`],
    [`automated-execution:${ids.executionDryThreeCommas}`]: journalEnv[`execution-snapshot:${ids.executionDryThreeCommas}`],
  });
});
