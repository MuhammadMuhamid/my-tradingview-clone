/**
 * Clears ORPHANED long positions from the deployments table.
 *
 * Only touches rows whose status is 'paused'. A paused deployment cannot have
 * opened anything new, so a 'long' there is a stale record left behind when the
 * runner was paused mid-trade. REFUSES to touch an 'active' deployment, because
 * clearing one would make the DB lie about real open exposure.
 *
 *   node reset_stale_positions.mjs --dry
 *   node reset_stale_positions.mjs
 */
import pg from "pg";

const DRY = process.argv.includes("--dry");
const FRESH = {
  position: "flat", entryPrice: null, entryBarTime: null, savedLongStop: null,
  savedLongTp: null, trailAnchor: null, trailArmed: false, tp1Done: false,
  tp2Done: false, consecLosses: 0, choppyUntilBarTime: null, runWinStreak: 0,
  runStreakPnlPct: 0, runPauseUntilBarTime: null, indSigArmed: false,
  lastExitBarTime: null, manualCloseReentryLock: false,
};

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const open = await pool.query(`
  SELECT symbol, status,
         runtime_state->>'entryPrice'   AS entry_price,
         runtime_state->>'entryBarTime' AS entry_bar_time
    FROM deployments
   WHERE runtime_state->>'position' = 'long'
   ORDER BY symbol`);

if (open.rows.length === 0) {
  console.log("no open positions in DB — nothing to do");
  await pool.end();
  process.exit(0);
}

const active = open.rows.filter((r) => r.status === "active");
if (active.length) {
  console.error("REFUSING: these are ACTIVE with open positions: " +
    active.map((r) => r.symbol).join(", "));
  await pool.end();
  process.exit(1);
}

for (const r of open.rows) {
  const since = r.entry_bar_time ? new Date(Number(r.entry_bar_time)).toISOString() : "-";
  console.log(`${DRY ? "would clear" : "clearing"}: ${r.symbol} (status=${r.status}) entry=${r.entry_price ?? "-"} since=${since}`);
}

if (DRY) {
  console.log(`\nDRY RUN — ${open.rows.length} row(s) would be reset to flat. Nothing written.`);
} else {
  const res = await pool.query(
    `UPDATE deployments SET runtime_state = $1::jsonb, updated_at = now()
      WHERE status = 'paused' AND runtime_state->>'position' = 'long'`,
    [JSON.stringify(FRESH)]);
  console.log(`\ncleared ${res.rowCount} row(s) -> position=flat`);
}
await pool.end();
