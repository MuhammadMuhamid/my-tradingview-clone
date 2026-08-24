#!/usr/bin/env bash
set -euo pipefail

: "${BACKUP_BUCKET:?Set BACKUP_BUCKET to the private bucket created by the stack}"
MODE="${1:-push}"
PREFIX="s3://${BACKUP_BUCKET}/optimizer-dashboard"

case "$MODE" in
  push)
    ROOT="${OPTIMIZER_ROOT:-/opt/srtrend/optimizers}"
    OUT="${DASHBOARD_DIR:-/opt/srtrend/dashboard}"
    python3 /opt/srtrend/source/platform/backend/scripts/export_optimizer_dashboards.py "$ROOT" "$OUT"
    aws s3 sync "$OUT/" "$PREFIX/" --sse AES256 --delete
    ;;
  pull)
    OUT="${DASHBOARD_DIR:-/opt/srtrend/optimizer-dashboard}"
    mkdir -p "$OUT"
    aws s3 sync "$PREFIX/" "$OUT/" --delete
    ;;
  *)
    echo "usage: $0 push|pull" >&2
    exit 2
    ;;
esac
