/**
 * Full replace: wipe all deployments + chart_layouts on AWS RDS, then insert
 * the 14 fresh 1h alerts (@ their buy amount, encrypted secret carried over —
 * decryptable because AWS shares ALERT_ENCRYPTION_KEY) and their "<COIN> 1h"
 * charts. Runs inside the AWS backend container. A pre-change backup is written
 * to /tmp first. Pass --dry to report without writing.
 *
 *   node replace_1h.mjs /tmp/deploy_1h_manifest.json [--dry]
 */
import fs from "node:fs";
import pg from "pg";

const MANIFEST = process.argv[2] || "/tmp/deploy_1h_manifest.json";
const DRY = process.argv.includes("--dry");
const FRESH = {
  position: "flat", entryPrice: null, entryBarTime: null, savedLongStop: null,
  savedLongTp: null, trailAnchor: null, trailArmed: false, tp1Done: false,
  tp2Done: false, consecLosses: 0, choppyUntilBarTime: null, runWinStreak: 0,
  runStreakPnlPct: 0, runPauseUntilBarTime: null, indSigArmed: false,
  lastExitBarTime: null, manualCloseReentryLock: false,
};

const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const before = await pool.query("SELECT symbol,status FROM deployments ORDER BY symbol");
const lay = await pool.query("SELECT count(*)::int c FROM chart_layouts");
console.log("BEFORE — deployments:", before.rows.length, "layouts:", lay.rows[0].c);

if (DRY) {
  console.log("DRY: would delete all, then insert", manifest.length, "coins:",
    manifest.map((m) => `${m.symbol}(${m.buyQuoteQty})`).join(", "));
  await pool.end();
} else {
  // Pre-change backup
  const bkDep = await pool.query("SELECT * FROM deployments");
  const bkLay = await pool.query("SELECT * FROM chart_layouts");
  const path = `/tmp/replace_backup_${Date.now()}.json`;
  fs.writeFileSync(path, JSON.stringify({ deployments: bkDep.rows, layouts: bkLay.rows }));
  console.log("backup written:", path, `(${bkDep.rows.length} deployments, ${bkLay.rows.length} layouts)`);

  const strat = await pool.query("SELECT id FROM strategies WHERE key='ma_rr_v9'");
  const strategyId = strat.rows[0].id;

  await pool.query("BEGIN");
  await pool.query("DELETE FROM deployments");   // cascades alert history
  await pool.query("DELETE FROM chart_layouts");
  for (const m of manifest) {
    // ensure symbol exists (FK); update filters if already present
    await pool.query(
      `INSERT INTO symbols (symbol, base_asset, quote_asset, price_tick, qty_step, min_notional, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,true)
       ON CONFLICT (symbol) DO UPDATE SET is_active=true`,
      [m.symbol, m.baseAsset, m.quoteAsset, m.priceTick, m.qtyStep, m.minNotional]
    );
    await pool.query(
      `INSERT INTO deployments
         (strategy_id, symbol, timeframe, params, delivery, webhook_url, secret, buy_quote_qty, runtime_state, status)
       VALUES ($1,$2,'1h',$3::jsonb,'custom',$4,$5,$6,$7::jsonb,'active')`,
      [strategyId, m.symbol, JSON.stringify(m.params), m.webhookUrl, m.secretEnc, m.buyQuoteQty, JSON.stringify(FRESH)]
    );
    await pool.query(
      `INSERT INTO chart_layouts (name, symbol, timeframe, bars, strategy_key, params, properties)
       VALUES ($1,$2,'1h',10000,'ma_rr_v9',$3::jsonb,$4::jsonb)`,
      [m.layoutName, m.symbol, JSON.stringify(m.params), JSON.stringify(m.properties)]
    );
  }
  await pool.query("COMMIT");

  const after = await pool.query(
    "SELECT symbol,status,timeframe,buy_quote_qty,(secret IS NOT NULL) hs,(SELECT count(*) FROM jsonb_object_keys(params)) n FROM deployments ORDER BY symbol"
  );
  console.log("AFTER — deployments:", after.rows.length);
  for (const r of after.rows) console.log(" ", r.symbol, r.status, r.timeframe, "buy", r.buy_quote_qty, "params", r.n, "secret", r.hs);
  console.log("layouts:", (await pool.query("SELECT count(*)::int c FROM chart_layouts")).rows[0].c);
  await pool.end();
}
console.log("DONE");
