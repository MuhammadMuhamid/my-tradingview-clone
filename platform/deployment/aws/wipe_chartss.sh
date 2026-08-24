#!/usr/bin/env bash
# Runs in AWS CloudShell (ap-south-1). CHART LAYOUTS ONLY.
#
#   ./wipe_chartss.sh            → read-only list of saved layouts
#   ./wipe_chartss.sh --delete   → RDS snapshot, then delete every saved layout
#
# The script that actually runs on the instance is wipe_charts_remote.sh, in
# this directory. Read it before running this (OPT-28).
#
# Deployments, alert history and the live alert runner are NOT touched.
set -euo pipefail

# Production identifiers come from the untracked .env in this directory (X-11).
. "$(dirname "$0")/env.sh"
aws_env_require APP_INSTANCE DB_ID REGION

MODE="${1:-inventory}"
STAMP=$(date -u +%Y%m%d%H%M%S)
# OPT-28: the script that runs on the instance used to be a base64 blob on this
# line. Nobody reviewing this file could read what it was about to execute
# against the production database — the one property a destructive script most
# needs. It is now the tracked, reviewable sibling below, encoded at send time.
REMOTE="$(dirname "$0")/wipe_charts_remote.sh"
[ -f "$REMOTE" ] || { echo "missing $REMOTE" >&2; exit 1; }
PAYLOAD="$(base64 < "$REMOTE" | tr -d '
')"

if [ "$MODE" = "--delete" ]; then
  echo "== pre-wipe RDS snapshot pre-charts-$STAMP =="
  aws rds create-db-snapshot --region "$REGION" \
    --db-instance-identifier "$DB_ID" \
    --db-snapshot-identifier "pre-charts-$STAMP" >/dev/null
  aws rds wait db-snapshot-available --region "$REGION" \
    --db-snapshot-identifier "pre-charts-$STAMP"
  echo "snapshot available: pre-charts-$STAMP"
fi

echo "== running on app EC2 via SSM ($MODE) =="
CMD_ID="$(aws ssm send-command --region "$REGION" \
  --instance-ids "$APP_INSTANCE" \
  --document-name AWS-RunShellScript \
  --comment "chart layouts $MODE $STAMP" \
  --timeout-seconds 900 \
  --parameters "{\"commands\":[\"set -euo pipefail\",\"echo '$PAYLOAD' | base64 -d > /tmp/charts.sh\",\"chmod +x /tmp/charts.sh\",\"/tmp/charts.sh $MODE\",\"rm -f /tmp/charts.sh\"],\"executionTimeout\":[\"900\"]}" \
  --query 'Command.CommandId' --output text)"
echo "ssm command: $CMD_ID"

STATUS=InProgress
while [ "$STATUS" = InProgress ] || [ "$STATUS" = Pending ] || [ "$STATUS" = Delayed ]; do
  sleep 10
  STATUS="$(aws ssm get-command-invocation --region "$REGION" \
    --command-id "$CMD_ID" --instance-id "$APP_INSTANCE" \
    --query 'Status' --output text 2>/dev/null || echo InProgress)"
  echo "  $(date -u +%H:%M:%S) $STATUS"
done

echo "== output ($STATUS) =="
aws ssm get-command-invocation --region "$REGION" \
  --command-id "$CMD_ID" --instance-id "$APP_INSTANCE" \
  --query 'StandardOutputContent' --output text
if [ "$STATUS" != Success ]; then
  echo "== stderr =="
  aws ssm get-command-invocation --region "$REGION" \
    --command-id "$CMD_ID" --instance-id "$APP_INSTANCE" \
    --query 'StandardErrorContent' --output text | tail -30
  exit 1
fi
