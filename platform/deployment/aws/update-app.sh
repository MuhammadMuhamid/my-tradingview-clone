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

# Each backup is a full copy of the live DATABASE_URL, ALERT_ENCRYPTION_KEY,
# SESSION_SECRET and admin hash. One deploy ago is what a rollback needs; the
# twenty before it are only extra copies of the credentials to steal, so keep a
# short tail and delete the rest. Newest-first by name works because TAG is a
# UTC timestamp.
ls -1 "$DEPLOY"/.env.bak-* 2>/dev/null | sort -r | tail -n +6 | while read -r old; do
  rm -f -- "$old"
done
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

# Caddy is long-lived and is deliberately NOT recreated by this script — it
# holds the TLS certificates and terminates every live connection. But the copy
# above rewrites its config file, and a running Caddy keeps serving the config it
# parsed at startup, so a routing change lands on disk and does nothing.
#
# That bit once: a release added the /readyz route, `docker ps` showed caddy
# "Up 4 days", and /readyz kept falling through to the frontend and redirecting
# to /login. The stack was fine; the check the runbook tells you to trust was
# answering from a config three releases old.
#
# `caddy reload` is graceful — it validates the new config first and keeps
# serving the old one if it is broken, so a bad Caddyfile cannot take the site
# down here. It runs AFTER the backend is healthy so the new routes only start
# pointing at a stack that can answer them.
echo "== reloading Caddy config =="
if docker compose --env-file .env -f compose.app.yml ps --status running caddy | grep -q caddy; then
  if docker compose --env-file .env -f compose.app.yml exec -T caddy \
       caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile; then
    echo "caddy reloaded"
  else
    # A refused reload means the OLD config is still serving: the site is up,
    # but it is not serving what this release intended. Loud, and not fatal —
    # failing the deploy here would leave the containers rolled and the script
    # exited, which is a worse place to be than a stale proxy config.
    echo "WARNING: caddy reload FAILED — the previous config is still active."
    echo "  The app rolled successfully; routing changes in this release are NOT live."
    echo "  Inspect with: docker compose --env-file .env -f compose.app.yml exec -T caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile"
  fi
else
  echo "caddy not running — starting it"
  docker compose --env-file .env -f compose.app.yml up -d caddy
fi

echo "== backend boot log (migrations / runner) =="
docker compose --env-file .env -f compose.app.yml logs --tail 40 backend | grep -Ei "migration|live runner|listening|subscrib|error" || true

echo "== container status =="
docker compose --env-file .env -f compose.app.yml ps

echo "OK $TAG"
