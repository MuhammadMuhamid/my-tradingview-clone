/**
 * Replaces chart layouts + live deployments with the approved 15m MTF Lean
 * portfolio. Reads exact full_params from the analysis artifact, encrypts the
 * webhook secret in memory, and never writes that secret to disk.
 *
 * Run inside the backend container:
 *   WEBHOOK_SECRET='...' node replace_mtf_lean15m.mjs analysis.json --dry
 *   WEBHOOK_SECRET='...' node replace_mtf_lean15m.mjs analysis.json
 */
import crypto from "node:crypto";
import fs from "node:fs";
import pg from "pg";
import { assertNoOpenPositions, parseWriteIntent } from "./lib/replaceGuard.mjs";
import { assertHoldoutClearance } from "./lib/holdoutGate.mjs";

const SOURCE = process.argv[2] || "/tmp/LEAN15M_DEPLOY_2026-08-22.json";
// OPT-27: writing is opt-in. `--dry` still previews; passing neither flag
// also previews, so an invocation that forgets the flag cannot rewrite the
// deployment table by accident.
const INTENT = parseWriteIntent(process.argv, "replace_mtf_lean15m_13coin.mjs");
const DRY = !INTENT.apply;
const secret = process.env.WEBHOOK_SECRET ?? "";
const encryptionKey = process.env.ALERT_ENCRYPTION_KEY ?? "";
if (secret && secret.length < 32) throw new Error("WEBHOOK_SECRET must be at least 32 characters");
if (secret && encryptionKey.length < 32) throw new Error("ALERT_ENCRYPTION_KEY is missing/too short");

const SELECTED = [
  "ALLOUSDT",
  "DEXEUSDT",
  "EIGENUSDT",
  "INJUSDT",
  "JSTUSDT",
  "JTOUSDT",
  "KAITOUSDT",
  "PUMPUSDT",
  "SYNUSDT",
  "TAOUSDT",
  "TIAUSDT",
  "ZECUSDT",
  "币安人生USDT",
];
const EXPECTED_PARTIAL = new Set([
  "ALLOUSDT",
  "DEXEUSDT",
  "EIGENUSDT",
  "INJUSDT",
  "JSTUSDT",
  "JTOUSDT",
  "KAITOUSDT",
  "PUMPUSDT",
  "SYNUSDT",
  "TAOUSDT",
  "TIAUSDT",
  "ZECUSDT",
  "币安人生USDT",
]);
const BUY_QUOTE_QTY = 140.01;
const DEPLOY_STATUS = process.env.DEPLOY_STATUS === "active" ? "active" : "paused";
if (DEPLOY_STATUS === "active") console.log("!! DEPLOY_STATUS=active -> deployments go LIVE on insert");
else console.log("deploying as PAUSED (no orders). Re-run with DEPLOY_STATUS=active to go live.");
const WEBHOOK_URL = "https://bot.alphawebstudioz.com/api/webhooks/signal_bots";
const FRESH = {
  position: "flat", entryPrice: null, entryBarTime: null, savedLongStop: null,
  savedLongTp: null, trailAnchor: null, trailArmed: false, tp1Done: false,
  tp2Done: false, consecLosses: 0, choppyUntilBarTime: null, runWinStreak: 0,
  runStreakPnlPct: 0, runPauseUntilBarTime: null, indSigArmed: false,
  lastExitBarTime: null, manualCloseReentryLock: false,
};

function encrypt(value) {
  const key = crypto.createHash("sha256").update(encryptionKey).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `enc:${Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64")}`;
}

const report = JSON.parse(fs.readFileSync(SOURCE, "utf8"));
const entries = SELECTED.map((symbol) => {
  const coin = report.coins?.[symbol];
  if (!coin?.full_params) throw new Error(`missing full_params for ${symbol}`);
  const partial = coin.full_params.rrUsePartialTp === true;
  if (partial !== EXPECTED_PARTIAL.has(symbol)) throw new Error(`partial-mode mismatch for ${symbol}`);
  if (partial && coin.full_params.rrTp1Size + coin.full_params.rrTp2Size >= 100) {
    throw new Error(`TP1 + TP2 leaves no runner for ${symbol}`);
  }
  return { symbol, params: coin.full_params, metrics: coin.metrics, holdout: coin.holdout ?? null };
});

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
await assertNoOpenPositions(pool, "replace_mtf_lean15m_13coin.mjs");
console.log(`PLAN: ${entries.length} deployments; ${EXPECTED_PARTIAL.size} partial, ${entries.length - EXPECTED_PARTIAL.size} full-only`);
for (const e of entries) {
  console.log(e.symbol, e.params.rrUsePartialTp ? "TP1/TP2/runner" : "full runner", e.metrics);
}
// OPT-01: refuse a portfolio whose configurations have not been scored on
// data no selection step read. Absence of a holdout result is not a pass.
assertHoldoutClearance(report, entries, "replace_mtf_lean15m_13coin.mjs");

console.log(INTENT.explain());
if (DRY) {
  await pool.end();
  process.exit(0);
}

const oldDeployments = await pool.query("SELECT * FROM deployments");
const oldLayouts = await pool.query("SELECT * FROM chart_layouts");
const backupPath = `/tmp/mtf_lean15m_backup_${Date.now()}.json`;
fs.writeFileSync(backupPath, JSON.stringify({ deployments: oldDeployments.rows, layouts: oldLayouts.rows }));
console.log(`backup: ${backupPath}`);

// Default to the already encrypted receiver credential currently used by the
// live clone. This avoids moving a plaintext webhook secret through CloudShell.
const existingCredential = oldDeployments.rows.find((r) => typeof r.secret === "string" && r.secret.length > 0)?.secret;
const encryptedSecret = secret ? encrypt(secret) : existingCredential;
if (!encryptedSecret) throw new Error("no existing deployment secret found; provide WEBHOOK_SECRET explicitly");
const properties = {
  initialCapital: 10000,
  qtyType: "cash",
  qtyValue: 1000,
  qtyCash: 1000,
  commissionPct: 0.1,
  slippageTicks: 2,
  rangeStart: "2025-08-11",
  rangeEnd: "2026-08-20",
};

const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query(`
    INSERT INTO strategies (key,name,description,pine_source)
    VALUES ('mtf_lean','MTF Confluence Lean','MTF confluence live/backtest engine with partial exits','MTF_Confluence_Lean.pine')
    ON CONFLICT (key) DO UPDATE SET name=EXCLUDED.name, description=EXCLUDED.description, pine_source=EXCLUDED.pine_source
  `);
  const strategyId = (await client.query("SELECT id FROM strategies WHERE key='mtf_lean'" )).rows[0].id;
  await client.query("DELETE FROM deployments");
  await client.query("DELETE FROM chart_layouts");
  for (const e of entries) {
    const base = e.symbol.slice(0, -4);
    await client.query(
      `INSERT INTO symbols(symbol,base_asset,quote_asset,is_active) VALUES($1,$2,'USDT',true)
       ON CONFLICT(symbol) DO UPDATE SET is_active=true`, [e.symbol, base]
    );
    await client.query(
      `INSERT INTO deployments(strategy_id,symbol,timeframe,params,status,delivery,webhook_url,secret,buy_quote_qty,runtime_state)
       VALUES($1,$2,'15m',$3::jsonb,$8,'custom',$4,$5,$6,$7::jsonb)`,
      [strategyId, e.symbol, JSON.stringify(e.params), WEBHOOK_URL, encryptedSecret, BUY_QUOTE_QTY, JSON.stringify(FRESH), DEPLOY_STATUS]
    );
    await client.query(
      `INSERT INTO chart_layouts(name,symbol,timeframe,bars,strategy_key,params,properties)
       VALUES($1,$2,'15m',50000,'mtf_lean',$3::jsonb,$4::jsonb)`,
      [`${base} 15m`, e.symbol, JSON.stringify(e.params), JSON.stringify(properties)]
    );
  }
  await client.query("COMMIT");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
}

const verify = await pool.query(`
  SELECT d.symbol,d.status,d.timeframe,d.buy_quote_qty,
         (d.params->>'rrUsePartialTp')::boolean partial,l.name layout
  FROM deployments d JOIN chart_layouts l ON l.symbol=d.symbol
  ORDER BY d.symbol
`);
console.table(verify.rows);
await pool.end();
