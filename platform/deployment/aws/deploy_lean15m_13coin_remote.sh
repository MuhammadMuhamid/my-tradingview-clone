#!/usr/bin/env bash
# Runs ON the app EC2 (via SSM) — NOT in CloudShell. CloudShell has its own
# Docker with no backend container; the containers live on the app instance.
#
# Applies the 13-coin 15m MTF Lean portfolio, then restarts the backend so the
# live runner reloads. Deployments are inserted INACTIVE unless DEPLOY_STATUS
# is explicitly set to "active" — pushing config and starting live order
# execution are deliberately two separate acts.
set -euo pipefail

CFG="${1:-/tmp/lean15m}"
DEPLOY=/opt/srtrend/deployment
C="docker compose --env-file $DEPLOY/.env -f $DEPLOY/compose.app.yml"

ls -1 "$CFG"
CID="$($C ps -q backend)"
[ -n "$CID" ] || { echo "backend container not found"; exit 1; }
docker cp "$CFG/replace_mtf_lean15m_13coin.mjs" "$CID:/app/replace_mtf_lean15m_13coin.mjs"
# OPT-27: the replace scripts share `lib/replaceGuard.mjs` (write-intent and the
# refuse-if-a-position-is-open check). It must be staged alongside them, or the
# import fails inside the container. Fail loudly here rather than there.
[ -f "$CFG/lib/replaceGuard.mjs" ] || {
  echo "missing $CFG/lib/replaceGuard.mjs — stage platform/deployment/aws/lib/ with the script" >&2
  exit 1
}
docker exec "$CID" mkdir -p /app/lib
docker cp "$CFG/lib/replaceGuard.mjs" "$CID:/app/lib/replaceGuard.mjs"
docker cp "$CFG/LEAN15M_DEPLOY_2026-08-22.json" "$CID:/tmp/LEAN15M_DEPLOY_2026-08-22.json"

echo "==================== DRY RUN ===================="
docker exec -w /app -e DEPLOY_STATUS="${DEPLOY_STATUS:-inactive}" "$CID" \
  node replace_mtf_lean15m_13coin.mjs /tmp/LEAN15M_DEPLOY_2026-08-22.json --dry

if [ "${DRY_ONLY:-0}" = "1" ]; then echo "DRY_ONLY=1 — stopping before apply"; exit 0; fi

echo "==================== APPLY ======================"
docker exec -w /app -e DEPLOY_STATUS="${DEPLOY_STATUS:-inactive}" "$CID" \
  node replace_mtf_lean15m_13coin.mjs /tmp/LEAN15M_DEPLOY_2026-08-22.json --apply

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
curl -s -o /dev/null -w "site healthz: %{http_code}\n" https://${DOMAIN}/healthz || true
echo DONE
