#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

aws cloudformation validate-template --template-body "file://$ROOT/deployment/aws/cloudformation.yml" >/dev/null
docker compose -f "$ROOT/deployment/aws/compose.app.yml" config --quiet
docker compose -f "$ROOT/deployment/aws/compose.compute.yml" config --quiet
(cd "$ROOT/backend" && npm run typecheck && npm test && npm run build)
(cd "$ROOT/frontend" && npm run typecheck && npm run build)
echo "AWS deployment package validated"
