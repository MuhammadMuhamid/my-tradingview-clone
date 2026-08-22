/**
 * Apply new optimizer configs to deployments + layouts. Runs inside the AWS
 * backend container (uses its DATABASE_URL + pg). Reads a manifest of
 * { symbol, params, properties, isNew } and, per coin:
 *   - upserts the chart layout,
 *   - existing alert & FLAT   -> update params + reset runtime + buy 340.01,
 *   - existing alert & LONG   -> SKIP (never disturb an open position),
 *   - no alert (new coin)     -> create by copying webhook/secret from an
 *                                existing custom alert (credential never read),
 * then a separate backend restart makes the runner reload every change.
 *
 * Coins absent from the manifest (e.g. INJUSDT) are never touched.
 * Pass --dry to report actions without writing.
 *
 *   node apply_configs.mjs /tmp/deploy_manifest.json [--dry]
 */
import fs from "node:fs";
import pg from "pg";

const MANIFEST = process.argv[2] || "/tmp/deploy_manifest.json";
const DRY = process.argv.includes("--dry");
const BUY = 340.01;
const FRESH = {
  position: "flat", entryPrice: null, entryBarTime: null, savedLongStop: null,
  savedLongTp: null, trailAnchor: null, trailArmed: false, tp1Done: false,
  tp2Done: false, consecLosses: 0, choppyUntilBarTime: null, runWinStreak: 0,
  runStreakPnlPct: 0, runPauseUntilBarTime: null, indSigArmed: false,
  lastExitBarTime: null, manualCloseReentryLock: false,
};

const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const report = [];

// Pre-change backup: dump current params/runtime/buy for the manifest coins so
// the change is reversible. Written to /tmp inside the container and echoed.
if (!DRY) {
  const syms = manifest.map((m) => m.symbol);
  const cur = await pool.query(
    "SELECT symbol, params, runtime_state, buy_quote_qty FROM deployments WHERE symbol = ANY($1)",
    [syms]
  );
  const path = `/tmp/deployments_backup_${Date.now()}.json`;
  fs.writeFileSync(path, JSON.stringify(cur.rows));
  console.log(`pre-change backup: ${cur.rows.length} deployments -> ${path}`);
}

for (const { symbol, params, properties } of manifest) {
  try {
    if (!DRY) {
      await pool.query(
        `INSERT INTO chart_layouts (name, symbol, timeframe, bars, strategy_key, params, properties)
         VALUES ($1,$1,'15m',10000,'ma_rr_v9',$2::jsonb,$3::jsonb)
         ON CONFLICT (upper(btrim(name))) DO UPDATE SET
           symbol=EXCLUDED.symbol, timeframe=EXCLUDED.timeframe, bars=EXCLUDED.bars,
           strategy_key=EXCLUDED.strategy_key, params=EXCLUDED.params,
           properties=EXCLUDED.properties, updated_at=now()`,
        [symbol, JSON.stringify(params), JSON.stringify(properties)]
      );
    }
    const dep = await pool.query(
      "SELECT id, status, runtime_state->>'position' AS pos FROM deployments WHERE symbol=$1",
      [symbol]
    );
    if (dep.rows.length === 0) {
      if (DRY) { report.push({ symbol, alert: "would-create", layout: "ok" }); continue; }
      const ins = await pool.query(
        `INSERT INTO deployments (strategy_id, symbol, timeframe, params, delivery, webhook_url, secret, bot_uuid, buy_quote_qty, runtime_state, status)
         SELECT strategy_id, $1, '15m', $2::jsonb, delivery, webhook_url, secret, bot_uuid, $3, $4::jsonb, 'active'
         FROM deployments WHERE delivery='custom' AND secret IS NOT NULL ORDER BY created_at LIMIT 1
         RETURNING id`,
        [symbol, JSON.stringify(params), BUY, JSON.stringify(FRESH)]
      );
      report.push({ symbol, alert: ins.rows.length ? "created" : "NO-TEMPLATE", id: ins.rows[0]?.id, layout: "ok" });
    } else {
      const d = dep.rows[0];
      if (d.pos === "long") { report.push({ symbol, alert: "SKIPPED-in-position", id: d.id, layout: "ok" }); continue; }
      if (DRY) { report.push({ symbol, alert: "would-update", id: d.id, layout: "ok" }); continue; }
      await pool.query(
        "UPDATE deployments SET params=$2::jsonb, runtime_state=$3::jsonb, buy_quote_qty=$4, updated_at=now() WHERE id=$1",
        [d.id, JSON.stringify(params), JSON.stringify(FRESH), BUY]
      );
      report.push({ symbol, alert: "updated", id: d.id, layout: "ok" });
    }
  } catch (e) {
    report.push({ symbol, error: String(e && e.message || e) });
  }
}

console.log(JSON.stringify({ dry: DRY, count: report.length, report }, null, 2));
await pool.end();
