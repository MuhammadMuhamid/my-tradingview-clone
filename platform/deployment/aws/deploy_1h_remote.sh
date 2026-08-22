#!/usr/bin/env bash
# Runs ON the app EC2 (via SSM). Full replace of deployments + charts with the
# 14 fresh 1h alerts, then restarts the backend so the runner reloads.
set -euo pipefail
CFG="${1:-/tmp/cfg1h}"
DEPLOY=/opt/srtrend/deployment
C="docker compose --env-file $DEPLOY/.env -f $DEPLOY/compose.app.yml"

ls -1 "$CFG"
CID="$($C ps -q backend)"
[ -n "$CID" ] || { echo "backend container not found"; exit 1; }
docker cp "$CFG/replace_1h.mjs" "$CID:/app/replace_1h.mjs"
docker cp "$CFG/deploy_1h_manifest.json" "$CID:/tmp/deploy_1h_manifest.json"

echo "==================== DRY ===================="
docker exec -w /app "$CID" node replace_1h.mjs /tmp/deploy_1h_manifest.json --dry

echo "==================== REPLACE ===================="
docker exec -w /app "$CID" node replace_1h.mjs /tmp/deploy_1h_manifest.json

echo "============ RESTART BACKEND (runner reload) ===="
$C restart backend
st=starting
for _ in $(seq 1 36); do
  cid="$($C ps -q backend)"
  st="$(docker inspect -f '{{.State.Health.Status}}' "$cid" 2>/dev/null || echo starting)"
  [ "$st" = healthy ] && break
  sleep 5
done
echo "backend health: $st"
$C logs --tail 40 backend 2>&1 | grep -iE "live runner started|migration|FATAL|error" | tail -8
echo "== public health =="
curl -s -o /dev/null -w "site healthz: %{http_code}\n" https://mytradingview.alphawebstudioz.com/healthz || true
echo DONE
