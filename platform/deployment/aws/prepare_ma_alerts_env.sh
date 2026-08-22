#!/usr/bin/env bash
# Runs ON the app EC2 (via SSM), BEFORE update-app.sh.
#
# Adds the settings the new sign-in and MA-alert code require. The backend
# refuses to boot when auth is enabled without a SESSION_SECRET, so this must
# succeed first or the roll will fail its health check.
#
# Idempotent: existing values are left alone, so re-running never rotates the
# session secret (which would sign every device out).
set -euo pipefail

DEPLOY=/opt/srtrend/deployment
ENV="$DEPLOY/.env"
[ -f "$ENV" ] || { echo "$ENV missing — refusing to proceed"; exit 1; }

cp "$ENV" "$ENV.bak-preMaAlerts-$(date +%Y%m%d%H%M%S)"
chmod 600 "$ENV".bak-* 2>/dev/null || true

set_default() {
  local key="$1" value="$2"
  if grep -qE "^${key}=" "$ENV"; then
    echo "  ${key} already set — keeping existing value"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV"
    echo "  ${key} added"
  fi
}

echo "== updating $ENV =="
# 48 random bytes; signs the session cookie. Never regenerated once present.
set_default SESSION_SECRET "$(openssl rand -base64 48 | tr -d '\n')"
set_default MA_ALERTS_ENABLED true
set_default COOKIE_SECURE true
set_default AUTH_ENABLED true
set_default VAPID_SUBJECT "mailto:alerts@$(grep -E '^DOMAIN_NAME=' "$ENV" | cut -d= -f2- | tr -d '\r')"

chmod 600 "$ENV"

echo
echo "== resulting non-secret flags =="
grep -E '^(AUTH_ENABLED|COOKIE_SECURE|MA_ALERTS_ENABLED|VAPID_SUBJECT|LIVE_RUNNER_ENABLED|DOMAIN_NAME|ADMIN_USERNAME)=' "$ENV"
echo
echo "SESSION_SECRET length: $(grep -E '^SESSION_SECRET=' "$ENV" | cut -d= -f2- | wc -c) chars"
echo "ADMIN_PASSWORD_HASH format: $(grep -E '^ADMIN_PASSWORD_HASH=' "$ENV" | cut -d= -f2- | cut -c1-7)... (bcrypt \$2 and scrypt are both accepted)"
echo "OK"
