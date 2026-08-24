#!/usr/bin/env bash
set -euo pipefail

# Production identifiers come from the untracked .env in this directory (X-11).
. "$(dirname "$0")/env.sh"
aws_env_require BUCKET DB_HOST DB_SECRET REGION

ROOT=/opt/srtrend
DEPLOY="$ROOT/deployment"
SOURCE="$ROOT-src/platform"

mkdir -p "$DEPLOY"
cp "$SOURCE/deployment/aws/compose.app.yml" "$DEPLOY/compose.app.yml"
cp "$SOURCE/deployment/aws/Caddyfile" "$DEPLOY/Caddyfile"
sed -i 's/LIVE_RUNNER_ENABLED: "true"/LIVE_RUNNER_ENABLED: ${LIVE_RUNNER_ENABLED:-false}/' "$DEPLOY/compose.app.yml"

aws s3 cp "s3://$BUCKET/deploy/backend.env" /tmp/backend.env
umask 077
KEY="$(sed -n 's/^ALERT_ENCRYPTION_KEY=//p' /tmp/backend.env)"
SECRET="$(aws secretsmanager get-secret-value --region "$REGION" --secret-id "$DB_SECRET" --query SecretString --output text)"
DB_USER="$(jq -r .username <<<"$SECRET")"
DB_PASS="$(jq -r .password <<<"$SECRET")"
DB_ENC="$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=""))' "$DB_PASS")"
DB_URL="postgres://${DB_USER}:${DB_ENC}@${DB_HOST}:5432/platform?sslmode=verify-full"

ADMIN_PASSWORD="$(openssl rand -base64 24 | tr -d '\n')"
ADMIN_HASH="$(docker run --rm caddy:2.8-alpine caddy hash-password --plaintext "$ADMIN_PASSWORD")"
ADMIN_HASH_ESCAPED="${ADMIN_HASH//\$/\$\$}"

printf '%s\n' \
  'BACKEND_IMAGE=srtrend-backend:latest' \
  'FRONTEND_IMAGE=srtrend-frontend:latest' \
  'AWS_REGION=ap-south-1' \
  'LOG_GROUP=/srtrend/app' \
  'DOMAIN_NAME=${DOMAIN}' \
  'ADMIN_USERNAME=admin' \
  "ADMIN_PASSWORD_HASH=$ADMIN_HASH_ESCAPED" \
  "DATABASE_URL=$DB_URL" \
  "ALERT_ENCRYPTION_KEY=$KEY" \
  'LIVE_RUNNER_ENABLED=false' > "$DEPLOY/.env"

printf '%s' "$ADMIN_PASSWORD" > "$ROOT/admin-password.txt"
chmod 600 "$DEPLOY/.env" "$ROOT/admin-password.txt"
cd "$DEPLOY"
curl -fsSL https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -o "$DEPLOY/global-bundle.pem"
chmod 644 "$DEPLOY/global-bundle.pem"
docker compose --env-file .env -f compose.app.yml up -d
rm -f /tmp/backend.env
