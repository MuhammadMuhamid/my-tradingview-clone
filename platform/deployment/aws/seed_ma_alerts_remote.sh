#!/usr/bin/env bash
# Runs ON the app EC2 (via SSM), AFTER update-app.sh.
# Seeds the 39-coin watchlist, the 1h layouts with all ten MA lines, and the
# 15/21 SMA approach alerts, inside the running backend container so it uses
# the production DATABASE_URL. Idempotent — every write is an upsert.
set -euo pipefail

DEPLOY=/opt/srtrend/deployment
cd "$DEPLOY"
CID="$(docker compose --env-file .env -f compose.app.yml ps -q backend)"
[ -n "$CID" ] || { echo "backend container not found"; exit 1; }

echo "== seeding via container ${CID:0:12} =="
docker exec -i -w /app "$CID" node dist/scripts/seedMaWatchlist.js
echo "OK"
