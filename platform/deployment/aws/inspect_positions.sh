#!/usr/bin/env bash
# READ-ONLY. Runs ON the app EC2 via SSM. Prints what the DATABASE believes
# about every deployment: status, tracked position, entry price/time and last
# exit. Use this to reconcile DB state against what the exchange actually holds
# before any deploy that is blocked by the open-position guard.
set -euo pipefail
DEPLOY=/opt/srtrend/deployment
C="docker compose --env-file $DEPLOY/.env -f $DEPLOY/compose.app.yml"
CID="$($C ps -q backend)"
[ -n "$CID" ] || { echo "backend container not found"; exit 1; }

docker exec "$CID" node -e '
const pg = require("pg");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  const r = await pool.query(`
    SELECT symbol, status, timeframe, buy_quote_qty AS qty,
           runtime_state->>'"'"'position'"'"'      AS position,
           runtime_state->>'"'"'entryPrice'"'"'    AS entry_price,
           runtime_state->>'"'"'entryBarTime'"'"'  AS entry_bar_time,
           runtime_state->>'"'"'lastExitBarTime'"'"' AS last_exit,
           updated_at
      FROM deployments ORDER BY symbol`);
  for (const x of r.rows) {
    const t = x.entry_bar_time ? new Date(Number(x.entry_bar_time)).toISOString() : "-";
    console.log(
      String(x.symbol).padEnd(14),
      String(x.status).padEnd(9),
      String(x.timeframe).padEnd(4),
      "pos=" + String(x.position).padEnd(6),
      "entry=" + String(x.entry_price ?? "-").padEnd(12),
      "since=" + t
    );
  }
  const longs = r.rows.filter((x) => x.position === "long").map((x) => x.symbol);
  console.log("\nopen per DB:", longs.length ? longs.join(", ") : "none");
  await pool.end();
})();
'
