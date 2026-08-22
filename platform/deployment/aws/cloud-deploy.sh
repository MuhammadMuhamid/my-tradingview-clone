#!/usr/bin/env bash
# Runs in AWS CloudShell (ap-south-1) next to an uploaded src-<TAG>.tar.gz.
# Safe rollout: RDS snapshot → upload bundle to the stack bucket → SSM build
# + roll on the app EC2 → poll the command → verify public health endpoint.
set -euo pipefail

TAG="${1:?usage: cloud-deploy.sh <tag> (expects ./src-<tag>.tar.gz)}"
REGION=ap-south-1
BUCKET=srtrend-production-backupbucket-qawhaukynxzt
APP_INSTANCE=i-09888f3320763000f
DB_ID=srtrend-production-database-xwpbny18v09d
DOMAIN=mytradingview.alphawebstudioz.com
BUNDLE="src-$TAG.tar.gz"

[ -f "$BUNDLE" ] || { echo "missing $BUNDLE in current directory"; exit 1; }

echo "== 1/5 pre-deploy RDS snapshot pre-deploy-$TAG =="
aws rds create-db-snapshot --region "$REGION" \
  --db-instance-identifier "$DB_ID" \
  --db-snapshot-identifier "pre-deploy-$TAG" >/dev/null
aws rds wait db-snapshot-available --region "$REGION" \
  --db-snapshot-identifier "pre-deploy-$TAG"
echo "snapshot available"

echo "== 2/5 uploading source bundle =="
aws s3 cp "$BUNDLE" "s3://$BUCKET/deploy/$BUNDLE"

echo "== 3/5 building + rolling on app EC2 (SSM) =="
CMD_ID="$(aws ssm send-command --region "$REGION" \
  --instance-ids "$APP_INSTANCE" \
  --document-name AWS-RunShellScript \
  --comment "deploy $TAG" \
  --timeout-seconds 3600 \
  --parameters "{\"commands\":[\"set -euo pipefail\",\"aws s3 cp s3://$BUCKET/deploy/$BUNDLE /tmp/$BUNDLE\",\"mkdir -p /opt/srtrend-src-$TAG\",\"tar -xzf /tmp/$BUNDLE -C /opt/srtrend-src-$TAG\",\"rm -f /tmp/$BUNDLE\",\"bash /opt/srtrend-src-$TAG/platform/deployment/aws/update-app.sh $TAG\"],\"executionTimeout\":[\"3600\"]}" \
  --query 'Command.CommandId' --output text)"
echo "ssm command: $CMD_ID"

STATUS=InProgress
while [ "$STATUS" = InProgress ] || [ "$STATUS" = Pending ] || [ "$STATUS" = Delayed ]; do
  sleep 15
  STATUS="$(aws ssm get-command-invocation --region "$REGION" \
    --command-id "$CMD_ID" --instance-id "$APP_INSTANCE" \
    --query 'Status' --output text 2>/dev/null || echo InProgress)"
  echo "  $(date -u +%H:%M:%S) $STATUS"
done

echo "== 4/5 remote output ($STATUS) =="
aws ssm get-command-invocation --region "$REGION" \
  --command-id "$CMD_ID" --instance-id "$APP_INSTANCE" \
  --query 'StandardOutputContent' --output text | tail -60
if [ "$STATUS" != Success ]; then
  echo "== remote stderr =="
  aws ssm get-command-invocation --region "$REGION" \
    --command-id "$CMD_ID" --instance-id "$APP_INSTANCE" \
    --query 'StandardErrorContent' --output text | tail -40
  echo "DEPLOY FAILED — old containers keep running; see rollback hint in output above"
  exit 1
fi

echo "== 5/5 public health check =="
for _ in $(seq 1 12); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "https://$DOMAIN/healthz" || echo 000)"
  [ "$code" = 200 ] && break
  sleep 5
done
echo "https://$DOMAIN/healthz -> $code"
[ "$code" = 200 ] || { echo "public health check failed"; exit 1; }

echo "DEPLOY OK $TAG"
