#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${1:-$ROOT/deployment/aws/export}"
mkdir -p "$OUT"

PGURL="${LOCAL_DATABASE_URL:-postgres://platform:platform@127.0.0.1:5433/platform}"
pg_dump --format=custom --no-owner --no-acl "$PGURL" > "$OUT/platform.dump"

# The three surviving optimizer trees (2026-07-30). This is a FULL history
# export — results/ is several GB per tree, so expect a large archive.
tar -C "$ROOT/backend" -czf "$OUT/optimizer-state.tgz" \
  --exclude='*.log' --exclude='service.log' --exclude='service-error.log' \
  --exclude='__pycache__' --exclude='.optimizer.pid' \
  optimizer1y15m optimizer1y1h sr_optimizer1h

sha256sum "$OUT/platform.dump" "$OUT/optimizer-state.tgz" > "$OUT/SHA256SUMS"
echo "Export created in $OUT"
