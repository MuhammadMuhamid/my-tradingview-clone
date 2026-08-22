#!/usr/bin/env bash
# Runs ON the app EC2 (via SSM). Applies new optimizer configs to the live
# deployments + layouts on RDS, then restarts the backend so the runner reloads.
# Position-checked: coins that are mid-trade on AWS are skipped; coins absent
# from the manifest (e.g. INJUSDT) are never touched.
set -euo pipefail

CFG="${1:-/tmp/cfg}"   # dir with apply_configs.mjs + deploy_manifest.json
DEPLOY=/opt/srtrend/deployment
ENVF="$DEPLOY/.env"
COMPOSE="docker compose --env-file $ENVF -f $DEPLOY/compose.app.yml"

ls -1 "$CFG"
CID="$($COMPOSE ps -q backend)"
[ -n "$CID" ] || { echo "backend container not found"; exit 1; }
docker cp "$CFG/apply_configs.mjs" "$CID:/app/apply_configs.mjs"
docker cp "$CFG/deploy_manifest.json" "$CID:/tmp/deploy_manifest.json"

echo "==================== DRY RUN ===================="
docker exec -w /app "$CID" node apply_configs.mjs /tmp/deploy_manifest.json --dry

echo "==================== APPLY ======================"
docker exec -w /app "$CID" node apply_configs.mjs /tmp/deploy_manifest.json

echo "============ RESTART BACKEND (runner reload) ===="
$COMPOSE restart backend
status=starting
for _ in $(seq 1 36); do
  cid="$($COMPOSE ps -q backend)"
  status="$(docker inspect -f '{{.State.Health.Status}}' "$cid" 2>/dev/null || echo starting)"
  [ "$status" = healthy ] && break
  sleep 5
done
echo "backend health: $status"

echo "==================== VERIFY ======================"
cid="$($COMPOSE ps -q backend)"
$COMPOSE logs --tail 30 backend | grep -Ei "live runner started|migration|error" || true
docker exec -w /app "$cid" node -e '
const pg=require("pg");const p=new pg.Pool({connectionString:process.env.DATABASE_URL});
(async()=>{
  const dep=await p.query("SELECT symbol,status,buy_quote_qty,runtime_state->>\x27position\x27 pos,(SELECT count(*) FROM jsonb_object_keys(params)) n FROM deployments ORDER BY symbol");
  console.log("deployments:",dep.rows.length);
  for(const r of dep.rows) console.log(" ",r.symbol,r.status,"buy",r.buy_quote_qty,"params",r.n,"pos",r.pos);
  const inj=dep.rows.find(r=>r.symbol==="INJUSDT");
  console.log("INJUSDT untouched check ->", inj?`pos ${inj.pos} (should be long/open), params ${inj.n}`:"MISSING");
  const lay=await p.query("SELECT count(*)::int c FROM chart_layouts");
  console.log("layouts:",lay.rows[0].c);
  await p.end();
})().catch(e=>{console.error(e);process.exit(1)});
'
echo "DONE"
