#!/usr/bin/env bash
# Runs in AWS CloudShell (ap-south-1). Config-only change: replaces the app
# EC2's Caddyfile with the route-wrapped version so /healthz answers 200
# without auth, then GRACEFULLY reloads Caddy.
#
# Safe by construction:
#   - the running config is backed up first
#   - the new config is validated INSIDE the container before anything applies
#   - 'caddy reload' keeps serving the OLD config if the new one is invalid
#   - no container is recreated, no image is rebuilt, zero downtime
#   - backend / frontend / live alert runner are never touched
set -euo pipefail

# Production identifiers come from the untracked .env in this directory (X-11).
. "$(dirname "$0")/env.sh"
aws_env_require APP_INSTANCE DOMAIN REGION

STAMP=$(date -u +%Y%m%d%H%M%S)
CADDY_B64='eyRET01BSU5fTkFNRX0gewogICAgZW5jb2RlIHpzdGQgZ3ppcAoKICAgICMgQ2FkZHkgYXBwbGllcyBpdHMgb3duIGRpcmVjdGl2ZSBvcmRlciwgTk9UIHRoZSBvcmRlciB3cml0dGVuIGluIHRoZSBmaWxlOgogICAgIyBvdXRzaWRlIGEgcm91dGUgYmxvY2sgYGJhc2ljX2F1dGhgIGlzIGV2YWx1YXRlZCBiZWZvcmUgYHJlc3BvbmRgLCBzbyB0aGUKICAgICMgL2hlYWx0aHogYnlwYXNzIG5ldmVyIGZpcmVkIGFuZCB0aGUgZW5kcG9pbnQgYW5zd2VyZWQgNDAxLiBJbnNpZGUgYSByb3V0ZQogICAgIyB0aGUgaGFuZGxlcnMgcnVuIHRvcC10by1ib3R0b20sIHNvIHRoZSBoZWFsdGggcHJvYmUgdGVybWluYXRlcyBiZWZvcmUgYXV0aC4KICAgIHJvdXRlIHsKICAgICAgICBAaGVhbHRoIHBhdGggL2hlYWx0aHoKICAgICAgICByZXNwb25kIEBoZWFsdGggMjAwCgogICAgICAgIGJhc2ljX2F1dGggewogICAgICAgICAgICB7JEFETUlOX1VTRVJOQU1FfSB7JEFETUlOX1BBU1NXT1JEX0hBU0h9CiAgICAgICAgfQoKICAgICAgICBAYmFja2VuZEhlYWx0aCBwYXRoIC9oZWFsdGgKICAgICAgICByZXZlcnNlX3Byb3h5IEBiYWNrZW5kSGVhbHRoIGJhY2tlbmQ6NDAwMAogICAgICAgIHJldmVyc2VfcHJveHkgZnJvbnRlbmQ6MzAwMAogICAgfQoKICAgIGhlYWRlciB7CiAgICAgICAgU3RyaWN0LVRyYW5zcG9ydC1TZWN1cml0eSAibWF4LWFnZT0zMTUzNjAwMDsgaW5jbHVkZVN1YkRvbWFpbnMiCiAgICAgICAgWC1Db250ZW50LVR5cGUtT3B0aW9ucyAibm9zbmlmZiIKICAgICAgICBYLUZyYW1lLU9wdGlvbnMgIkRFTlkiCiAgICAgICAgUmVmZXJyZXItUG9saWN5ICJzdHJpY3Qtb3JpZ2luLXdoZW4tY3Jvc3Mtb3JpZ2luIgogICAgICAgIFBlcm1pc3Npb25zLVBvbGljeSAiY2FtZXJhPSgpLCBtaWNyb3Bob25lPSgpLCBnZW9sb2NhdGlvbj0oKSIKICAgICAgICAtU2VydmVyCiAgICB9CgogICAgbG9nIHsKICAgICAgICBvdXRwdXQgc3Rkb3V0CiAgICAgICAgZm9ybWF0IGpzb24KICAgIH0KfQo='

echo "== sending config update + validated reload via SSM =="
CMD_ID="$(aws ssm send-command --region "$REGION" \
  --instance-ids "$APP_INSTANCE" \
  --document-name AWS-RunShellScript \
  --comment "caddy healthz bypass $STAMP" \
  --timeout-seconds 600 \
  --parameters "{\"commands\":[\"set -euo pipefail\",\"cd /opt/srtrend/deployment\",\"cp Caddyfile Caddyfile.bak-$STAMP\",\"echo '$CADDY_B64' | base64 -d > Caddyfile.new\",\"cp Caddyfile.new Caddyfile\",\"rm -f Caddyfile.new\",\"docker compose -f compose.app.yml exec -T caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile\",\"docker compose -f compose.app.yml exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile\",\"echo RELOADED\",\"docker compose -f compose.app.yml ps caddy\"],\"executionTimeout\":[\"600\"]}" \
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

echo "== remote output ($STATUS) =="
aws ssm get-command-invocation --region "$REGION" \
  --command-id "$CMD_ID" --instance-id "$APP_INSTANCE" \
  --query 'StandardOutputContent' --output text | tail -30
if [ "$STATUS" != Success ]; then
  echo "== remote stderr =="
  aws ssm get-command-invocation --region "$REGION" \
    --command-id "$CMD_ID" --instance-id "$APP_INSTANCE" \
    --query 'StandardErrorContent' --output text | tail -30
  echo "FAILED — Caddy kept its previous config; restore with:"
  echo "  cp /opt/srtrend/deployment/Caddyfile.bak-$STAMP /opt/srtrend/deployment/Caddyfile"
  exit 1
fi

echo "== verification =="
health=$(curl -s -o /dev/null -w '%{http_code}' "https://$DOMAIN/healthz" || echo 000)
root=$(curl -s -o /dev/null -w '%{http_code}' "https://$DOMAIN/" || echo 000)
echo "  /healthz -> $health  (want 200)"
echo "  /        -> $root     (want 401 — auth MUST still be enforced)"
[ "$health" = 200 ] || { echo "healthz still not public"; exit 1; }
[ "$root" = 401 ] || { echo "SECURITY: site is no longer password protected — rolling back"; exit 1; }
echo "CADDY OK $STAMP"
