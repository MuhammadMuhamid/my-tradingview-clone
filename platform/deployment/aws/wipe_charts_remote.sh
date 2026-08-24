#!/usr/bin/env bash
# Runs ON the app EC2. Touches chart_layouts ONLY.
set -euo pipefail
MODE="${1:-inventory}"
cd /opt/srtrend/deployment
set -a; . ./.env; set +a          # DATABASE_URL — never echoed

# DATABASE_URL uses sslmode=verify-full, so psql needs the RDS root CA. Fetch
# Amazon's regional bundle and point libpq at it via PGSSLROOTCERT — this keeps
# full certificate verification rather than downgrading sslmode.
CA=/tmp/rds-ca-ap-south-1.pem
if [ ! -s "$CA" ]; then
  curl -fsS -o "$CA" https://truststore.pki.rds.amazonaws.com/ap-south-1/ap-south-1-bundle.pem
fi
echo "rds ca bundle: $(wc -c < "$CA") bytes"

PSQL=(docker run --rm -i -e PGSSLROOTCERT=/rds-ca.pem -v "$CA":/rds-ca.pem:ro
      postgres:16-alpine psql "$DATABASE_URL" -v ON_ERROR_STOP=1)

echo "=== saved chart layouts ==="
"${PSQL[@]}" -P pager=off -c "
SELECT name, symbol, timeframe, strategy_key, updated_at::date AS updated
FROM chart_layouts ORDER BY updated_at DESC;"
BEFORE=$("${PSQL[@]}" -t -A -c "SELECT count(*) FROM chart_layouts;" | tr -d '[:space:]')
echo "total layouts: $BEFORE"

echo "=== untouched (read-only, for reference) ==="
"${PSQL[@]}" -P pager=off -c "
SELECT (SELECT count(*) FROM deployments) AS deployments,
       (SELECT count(*) FROM deployments WHERE status='active') AS active,
       (SELECT count(*) FROM alerts) AS alert_history;"

if [ "$MODE" != "--delete" ]; then
  echo "INVENTORY ONLY — nothing changed. Re-run with --delete to remove all layouts."
  exit 0
fi

echo "=== deleting ALL $BEFORE chart layouts ==="
"${PSQL[@]}" -c "DELETE FROM chart_layouts;"
AFTER=$("${PSQL[@]}" -t -A -c "SELECT count(*) FROM chart_layouts;" | tr -d '[:space:]')
echo "layouts: $BEFORE -> $AFTER"
echo "=== confirming deployments/alerts untouched ==="
"${PSQL[@]}" -P pager=off -c "
SELECT (SELECT count(*) FROM deployments) AS deployments,
       (SELECT count(*) FROM deployments WHERE status='active') AS active,
       (SELECT count(*) FROM alerts) AS alert_history;"
[ "$AFTER" = "0" ] || { echo "unexpected: layouts remain"; exit 1; }
echo "CHARTS CLEARED"
