#!/usr/bin/env bash
# Runs ON the app EC2 (via SSM). Rolls backend+frontend to a new immutable
# image tag built from an extracted source bundle at /opt/srtrend-src-<TAG>.
#
# Deliberately preserves /opt/srtrend/deployment/.env — it holds the live
# DATABASE_URL, ALERT_ENCRYPTION_KEY, admin hash and LIVE_RUNNER_ENABLED.
# Only the two image lines are rewritten; a timestamped .env backup is kept.
set -euo pipefail

TAG="${1:?usage: update-app.sh <tag>}"
ROOT=/opt/srtrend
DEPLOY="$ROOT/deployment"
SRC="/opt/srtrend-src-$TAG/platform"

[ -d "$SRC/backend" ] || { echo "source bundle missing at $SRC"; exit 1; }
[ -f "$DEPLOY/.env" ] || { echo "$DEPLOY/.env missing — refusing to proceed"; exit 1; }

echo "== building images srtrend-backend:$TAG / srtrend-frontend:$TAG =="
docker build --target runtime -t "srtrend-backend:$TAG" "$SRC/backend"
docker build --build-arg BACKEND_URL=http://backend:4000 -t "srtrend-frontend:$TAG" "$SRC/frontend"

echo "== updating deployment config (env backup: .env.bak-$TAG) =="
cp "$DEPLOY/.env" "$DEPLOY/.env.bak-$TAG"
chmod 600 "$DEPLOY/.env.bak-$TAG"
sed -i "s|^BACKEND_IMAGE=.*|BACKEND_IMAGE=srtrend-backend:$TAG|" "$DEPLOY/.env"
sed -i "s|^FRONTEND_IMAGE=.*|FRONTEND_IMAGE=srtrend-frontend:$TAG|" "$DEPLOY/.env"
cp "$SRC/deployment/aws/compose.app.yml" "$DEPLOY/compose.app.yml"
cp "$SRC/deployment/aws/Caddyfile" "$DEPLOY/Caddyfile"

echo "== non-secret deployment flags =="
grep -E '^(BACKEND_IMAGE|FRONTEND_IMAGE|LIVE_RUNNER_ENABLED|DOMAIN_NAME|AWS_REGION|LOG_GROUP)=' "$DEPLOY/.env" || true

echo "== rolling containers =="
cd "$DEPLOY"
docker compose --env-file .env -f compose.app.yml up -d backend frontend

echo "== waiting for backend health =="
status=starting
for _ in $(seq 1 36); do
  cid="$(docker compose --env-file .env -f compose.app.yml ps -q backend)"
  status="$(docker inspect -f '{{.State.Health.Status}}' "$cid" 2>/dev/null || echo starting)"
  [ "$status" = healthy ] && break
  sleep 5
done
if [ "$status" != healthy ]; then
  echo "BACKEND UNHEALTHY — recent logs follow; roll back with:"
  echo "  cp $DEPLOY/.env.bak-$TAG $DEPLOY/.env && cd $DEPLOY && docker compose --env-file .env -f compose.app.yml up -d backend frontend"
  docker compose --env-file .env -f compose.app.yml logs --tail 60 backend || true
  exit 1
fi

echo "== backend boot log (migrations / runner) =="
docker compose --env-file .env -f compose.app.yml logs --tail 40 backend | grep -Ei "migration|live runner|listening|subscrib|error" || true

echo "== container status =="
docker compose --env-file .env -f compose.app.yml ps

echo "OK $TAG"
