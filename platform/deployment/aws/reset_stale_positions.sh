#!/usr/bin/env bash
# Runs ON the app EC2 via SSM. Copies reset_stale_positions.mjs into the backend
# container and runs it there (the container owns DATABASE_URL and pg).
# Pass --dry to preview.
set -euo pipefail
CFG="${CFG:-/tmp/lean15m}"
DEPLOY=/opt/srtrend/deployment
C="docker compose --env-file $DEPLOY/.env -f $DEPLOY/compose.app.yml"
CID="$($C ps -q backend)"
[ -n "$CID" ] || { echo "backend container not found"; exit 1; }
docker cp "$CFG/reset_stale_positions.mjs" "$CID:/app/reset_stale_positions.mjs"
docker exec -w /app "$CID" node reset_stale_positions.mjs "${1:-}"
