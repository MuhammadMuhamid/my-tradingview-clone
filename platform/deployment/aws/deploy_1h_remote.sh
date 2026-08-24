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
# The replace scripts share `lib/` — `replaceGuard.mjs` (write intent and the
# refuse-if-a-position-is-open check, OPT-27) and `holdoutGate.mjs` (the
# frozen-holdout deploy gate, OPT-01). The whole directory must be staged
# alongside them, or the import fails inside the container. Fail loudly here
# rather than there.
for required in replaceGuard.mjs holdoutGate.mjs; do
  [ -f "$CFG/lib/$required" ] || {
    echo "missing $CFG/lib/$required — stage platform/deployment/aws/lib/ with the script" >&2
    exit 1
  }
done
docker exec "$CID" mkdir -p /app/lib
docker cp "$CFG/lib/." "$CID:/app/lib/"
docker cp "$CFG/deploy_1h_manifest.json" "$CID:/tmp/deploy_1h_manifest.json"

echo "==================== DRY ===================="
docker exec -w /app "$CID" node replace_1h.mjs /tmp/deploy_1h_manifest.json --dry

echo "==================== REPLACE ===================="
docker exec -w /app "$CID" node replace_1h.mjs /tmp/deploy_1h_manifest.json --apply

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
curl -s -o /dev/null -w "site healthz: %{http_code}\n" https://${DOMAIN}/healthz || true
echo DONE
