import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const required = ["initdb", "pg_ctl", "createdb", "psql", "pg_dump", "pg_restore"];
const available = required.every((command) =>
  spawnSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" }).status === 0);
const backendRoot = path.join(__dirname, "..");
const repositoryRoot = path.join(backendRoot, "..");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "platform-realization-recovery-"));
const cluster = path.join(scratch, "cluster");
const socket = path.join("/tmp", `ts-platform-pg-${process.pid}`);
const postgresLog = path.join(scratch, "postgres.log");
const backup = path.join(scratch, "platform.dump");
const port = 56_000 + (process.pid % 4_000);
const sourceUrl = `postgres://postgres@127.0.0.1:${port}/realization_source`;
const restoreUrl = `postgres://postgres@127.0.0.1:${port}/realization_restore`;
let started = false;

const run = (command: string, args: string[], env: NodeJS.ProcessEnv = process.env): string =>
  execFileSync(command, args, { cwd: repositoryRoot, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const sql = (url: string, statement: string): string =>
  run("psql", ["--dbname", url, "-XAtq", "-v", "ON_ERROR_STOP=1", "-c", statement]);

before(() => {
  if (!available) return;
  fs.mkdirSync(socket);
  run("initdb", ["-D", cluster, "-U", "postgres", "-A", "trust", "--no-locale"]);
  run("pg_ctl", ["-D", cluster, "-l", postgresLog,
    "-o", `-F -p ${port} -k ${socket} -h 127.0.0.1`, "-w", "start"]);
  started = true;
  run("createdb", ["--host", "127.0.0.1", "--port", String(port), "--username", "postgres",
    "realization_source"]);
  run("createdb", ["--host", "127.0.0.1", "--port", String(port), "--username", "postgres",
    "realization_restore"]);
});

after(() => {
  if (started) spawnSync("pg_ctl", ["-D", cluster, "-m", "fast", "-w", "stop"],
    { cwd: repositoryRoot, stdio: "ignore" });
  fs.rmSync(socket, { recursive: true, force: true });
  fs.rmSync(scratch, { recursive: true, force: true });
});

test("021 upgrades without backfill and pg_dump/restore preserves realization identity", {
  skip: !available,
}, () => {
  sql(sourceUrl, `CREATE TABLE schema_migrations (
    filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const migrationDir = path.join(backendRoot, "src", "db", "migrations");
  const migrations = fs.readdirSync(migrationDir).filter((name) => name.endsWith(".sql")).sort();
  for (const name of migrations.filter((item) => item < "021_realization_events.sql")) {
    run("psql", ["--dbname", sourceUrl, "-Xq", "-v", "ON_ERROR_STOP=1", "-f",
      path.join(migrationDir, name)]);
    sql(sourceUrl, `INSERT INTO schema_migrations(filename) VALUES ('${name}')`);
  }
  const deploymentId = "11111111-1111-4111-8111-111111111111";
  sql(sourceUrl, `
    INSERT INTO deployments (id,strategy_id,symbol,timeframe,params,status,delivery)
      VALUES ('${deploymentId}',1,'BTCUSDT','15m','{}','paused','custom');
    INSERT INTO realised_pnl (deployment_id,closed_at,pnl_quote)
      VALUES ('${deploymentId}','2026-09-01T00:00:00Z',1.25);`);

  const migration = "021_realization_events.sql";
  run("psql", ["--dbname", sourceUrl, "-Xq", "-v", "ON_ERROR_STOP=1", "-f",
    path.join(migrationDir, migration)]);
  sql(sourceUrl, `INSERT INTO schema_migrations(filename) VALUES ('${migration}')`);
  assert.equal(sql(sourceUrl, "SELECT count(*) FROM realised_pnl WHERE source_event_id IS NOT NULL").trim(), "0");

  sql(sourceUrl, `
    INSERT INTO order_intents (deployment_id,dedupe_key,action,bar_time,state)
      VALUES ('${deploymentId}','X-recovery','sell','2026-09-02T12:00:00Z','delivered');
    INSERT INTO realised_pnl
      (deployment_id,closed_at,pnl_quote,exit_price,quantity,reason,source_system,
       source_event_id,realization_kind,source_strategy_order_intent_id,
       source_exchange_order_id,source_platform_order_intent_id,accounting_basis,
       fee_model,quote_currency,exit_revenue_quote,source_payload_sha256,received_at)
      SELECT '${deploymentId}','2026-09-02T12:00:00Z',4.945,120,0.4,'tp1',
       'BOT_CUSTOM_V1','bot-realization-v1:partial:recovery','partial','bot-intent-recovery',
       'exchange-recovery',id,'modeled_fee_adjusted',
       'fixed_0.1pct_each_side_not_exchange_observed','USDT',48,
       repeat('a',64),'2026-09-02T12:00:01Z'
      FROM order_intents WHERE dedupe_key='X-recovery';
    INSERT INTO realization_ingest_nonces(nonce,expires_at)
      VALUES ('recovery_nonce_123456789','2035-09-02T12:00:00Z');`);

  run(path.join(repositoryRoot, "scripts", "backup-platform-db.sh"), [backup],
    { ...process.env, PLATFORM_BACKUP_SOURCE_URL: sourceUrl });
  run(path.join(repositoryRoot, "scripts", "restore-platform-db.sh"), [backup], {
    ...process.env, PLATFORM_RESTORE_DESTINATION_URL: restoreUrl,
    PLATFORM_RESTORE_EXPECT_DATABASE: "realization_restore",
  });
  assert.equal(sql(restoreUrl, `SELECT source_event_id || '|' || pnl_quote || '|' || realization_kind
    FROM realised_pnl WHERE source_event_id IS NOT NULL`).trim(),
  "bot-realization-v1:partial:recovery|4.945|partial");
  assert.equal(sql(restoreUrl, "SELECT nonce FROM realization_ingest_nonces").trim(),
    "recovery_nonce_123456789");
  assert.equal(sql(restoreUrl, "SELECT count(*) FROM realised_pnl WHERE source_system IS NULL").trim(), "1");
});
