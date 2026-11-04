#!/usr/bin/env bash
# Runs in AWS CloudShell. Puts the execution Bot on its own EC2 instance and
# connects the production Platform to it. See BOT-DEPLOY.md for the order.
#
# The Bot gets its own instance because it is the only component that holds
# exchange keys; the Platform server is public and already short of memory.
#
# Safety rules this script enforces:
#   - A first deployment is DRY_RUN=true. Nothing here ever arms live orders.
#   - MAINNET_MANUAL_TRADING_ENABLED must stay false; deploy refuses otherwise.
#   - An existing Bot .env is never rewritten, because ENCRYPTION_KEY and
#     SCRYPT_SALT are what decrypt stored API keys.
#   - No secret travels in an SSM command. SSM keeps command text in its
#     history, so each server reads Secrets Manager or generates its own.
#   - There is no terminate command. Deleting a Bot is a decision for the console.
set -euo pipefail

REGION=ap-south-1
APP_INSTANCE=i-09888f3320763000f
OLD_BOT_REGION=ap-southeast-2
BOT_NAME=trading-scene-execution-bot
BOT_DOMAIN=bot.alphawebstudioz.com
BOT_TYPE="${BOT_TYPE:-t3.micro}"
# Paired with Platform by `platform/scripts/release.sh gate`. Change them together.
BOT_SHA=76d17c5a7732
BOT_REPO=MuhammadMuhamid/3commabotclone
HMAC_SECRET=trading-scene/execution-bot/control-plane-hmac
SETUP_SECRET=trading-scene/execution-bot/setup-token
ROLE="$BOT_NAME-role"
SG_NAME="$BOT_NAME-sg"

ec2() { aws ec2 --region "$REGION" "$@"; }
sm() { aws secretsmanager --region "$REGION" "$@"; }
say() { printf '\n== %s ==\n' "$*"; }
die() { printf 'STOPPED: %s\n' "$*" >&2; exit 1; }

# Instance id of the Bot, or empty.
bot_instance() {
  ec2 describe-instances \
    --filters "Name=tag:Name,Values=$BOT_NAME" \
              "Name=instance-state-name,Values=pending,running,stopping,stopped" \
    --query 'Reservations[0].Instances[0].InstanceId' --output text | sed 's/^None$//'
}
require_bot_instance() {
  local id; id="$(bot_instance)"
  [ -n "$id" ] || die "no $BOT_NAME instance; run launch first"
  printf '%s' "$id"
}
platform_ip() {
  ec2 describe-instances --instance-ids "$APP_INSTANCE" \
    --query 'Reservations[0].Instances[0].PublicIpAddress' --output text
}
instance_ip() {
  ec2 describe-instances --instance-ids "$1" \
    --query 'Reservations[0].Instances[0].PublicIpAddress' --output text
}
app_role() {
  local arn
  arn="$(ec2 describe-instances --instance-ids "$APP_INSTANCE" \
    --query 'Reservations[0].Instances[0].IamInstanceProfile.Arn' --output text)"
  aws iam get-instance-profile --instance-profile-name "${arn##*/}" \
    --query 'InstanceProfile.Roles[0].RoleName' --output text
}

# Sends a script over SSM, waits for it, and prints its output.
run_remote() {
  local instance="$1" script="$2" params id status
  params="$(jq -n --arg c "echo $(base64 -w0 <<<"$script") | base64 -d | bash" \
    '{commands: [$c], executionTimeout: ["2400"]}')"
  id="$(aws ssm send-command --region "$REGION" --instance-ids "$instance" \
    --document-name AWS-RunShellScript --timeout-seconds 600 \
    --parameters "$params" --query Command.CommandId --output text)"
  while :; do
    sleep 10
    status="$(aws ssm get-command-invocation --region "$REGION" --command-id "$id" \
      --instance-id "$instance" --query Status --output text 2>/dev/null || echo Pending)"
    case "$status" in Pending|InProgress|Delayed) continue ;; esac
    break
  done
  aws ssm get-command-invocation --region "$REGION" --command-id "$id" \
    --instance-id "$instance" --query '[StandardOutputContent,StandardErrorContent]' --output text
  [ "$status" = Success ] || die "remote command finished as $status"
}

# ── Scripts that run on the Bot server ──────────────────────────────────────
remote_deploy() {
  cat <<EOF
set -euo pipefail
REGION=$REGION
BOT_DOMAIN=$BOT_DOMAIN
BOT_SHA=$BOT_SHA
BOT_REPO=$BOT_REPO
HMAC_SECRET=$HMAC_SECRET
SETUP_SECRET=$SETUP_SECRET
PLATFORM_IP=${1:-PLATFORM_IP_UNSET}
EOF
  cat <<'EOF'
ROOT=/opt/tradingbot
SHARED="$ROOT/shared"
RELEASE="$ROOT/releases/$BOT_SHA"
mkdir -p "$SHARED" "$ROOT/releases"
chmod 750 "$ROOT"
free -m | grep -q '^Swap: *0' && { echo "swap is not on; refusing to build on this box"; exit 1; }

secret() { aws secretsmanager get-secret-value --region "$REGION" --secret-id "$1" --query SecretString --output text; }

if [ ! -f "$SHARED/backend.env" ]; then
  echo "first deployment: writing backend.env with DRY_RUN=true"
  umask 077
  {
    echo "PORT=4000"
    echo "NODE_ENV=production"
    echo "PUBLIC_URL=https://$BOT_DOMAIN"
    echo "CORS_ORIGIN=https://$BOT_DOMAIN"
    echo "SECURE_COOKIES=true"
    echo "DRY_RUN=true"
    echo "DATABASE_URL=file:/app/data/bot.db"
    echo "BINANCE_TESTNET=true"
    echo "MANUAL_TRADING_ENABLED=true"
    echo "MAINNET_MANUAL_TRADING_ENABLED=false"
    echo "EXCHANGE_STOPS_ENABLED=false"
    echo "ENCRYPTION_KEY=$(openssl rand -hex 32)"
    echo "SCRYPT_SALT=$(openssl rand -hex 16)"
    echo "JWT_SECRET=$(openssl rand -hex 64)"
    echo "MANUAL_TRADING_HMAC_SECRET=$(secret "$HMAC_SECRET")"
    echo "SETUP_TOKEN=$(secret "$SETUP_SECRET")"
  } > "$SHARED/backend.env"
  umask 022
else
  echo "keeping the existing backend.env"
fi
grep -q '^MAINNET_MANUAL_TRADING_ENABLED=false$' "$SHARED/backend.env" \
  || { echo "MAINNET_MANUAL_TRADING_ENABLED is not false; refusing to deploy"; exit 1; }
grep -q '^DRY_RUN=true$' "$SHARED/backend.env" \
  || echo "WARNING: DRY_RUN is not true in the existing backend.env; it was left as it is"

rm -rf "$RELEASE"
mkdir -p "$RELEASE"
curl -sfL "https://github.com/$BOT_REPO/archive/$BOT_SHA.tar.gz" | tar -xz --strip-components=1 -C "$RELEASE"
ln -sfn "$SHARED/backend.env" "$RELEASE/backend/.env"

cat > "$SHARED/Caddyfile" <<'CADDY'
{$BOT_DOMAIN} {
    encode zstd gzip
    route {
        # Signed Platform commands only come from the Platform server. The HMAC
        # is the real control; this keeps the route off the public internet.
        @manualFromElsewhere {
            path /api/manual-trading /api/manual-trading/*
            not remote_ip {$PLATFORM_IP}
        }
        respond @manualFromElsewhere 403

        @webhooks path /api/webhooks/*
        request_body @webhooks {
            max_size 10KB
        }

        # Straight to the backend, so its `trust proxy 1` sees one hop.
        @backend path /api/* /health
        reverse_proxy @backend backend:4000
        reverse_proxy frontend:80
    }
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        -Server
    }
}
CADDY

cat > "$SHARED/compose.production.yml" <<'YAML'
services:
  backend:
    image: ${BOT_BACKEND_IMAGE}
  frontend:
    image: ${BOT_FRONTEND_IMAGE}
  caddy:
    image: caddy:2.8-alpine
    restart: unless-stopped
    environment:
      BOT_DOMAIN: ${BOT_DOMAIN}
      PLATFORM_IP: ${PLATFORM_IP}
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ${SHARED_DIR}/Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      - frontend
volumes:
  caddy_data:
  caddy_config:
YAML

TAG="${BOT_SHA:0:12}"
cat > "$SHARED/compose.env" <<ENV
BOT_BACKEND_IMAGE=trading-bot-backend:$TAG
BOT_FRONTEND_IMAGE=trading-bot-frontend:$TAG
BOT_DOMAIN=$BOT_DOMAIN
PLATFORM_IP=$PLATFORM_IP
SHARED_DIR=$SHARED
ENV

docker run --rm -e "BOT_DOMAIN=$BOT_DOMAIN" -e "PLATFORM_IP=$PLATFORM_IP" \
  -v "$SHARED/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2.8-alpine \
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

echo "building images; this takes several minutes on a small instance"
docker build -t "trading-bot-backend:$TAG" "$RELEASE/backend"
docker build --build-arg VITE_API_URL= -t "trading-bot-frontend:$TAG" "$RELEASE/frontend"

cd "$RELEASE"
docker compose -p tradingbot --env-file "$SHARED/compose.env" \
  -f docker-compose.yml -f "$SHARED/compose.production.yml" up -d --no-build
ln -sfn "$RELEASE" "$ROOT/current"

status=starting
for _ in $(seq 1 36); do
  status="$(docker inspect -f '{{.State.Health.Status}}' tradingbot-backend-1 2>/dev/null || echo starting)"
  [ "$status" = healthy ] && break
  sleep 5
done
[ "$status" = healthy ] || { docker logs --tail 40 tradingbot-backend-1 2>&1 | grep -v -iE 'secret|key|token'; echo "BACKEND UNHEALTHY"; exit 1; }
echo "backend healthy"
echo "Binance testnet from this server: HTTP $(curl -s -m 10 -o /dev/null -w '%{http_code}' https://testnet.binance.vision/api/v3/ping)"
echo "DEPLOY OK $BOT_SHA"
EOF
}

remote_flags() {
  cat <<'EOF'
set -euo pipefail
cd /opt/tradingbot/shared
grep -E '^(DRY_RUN|BINANCE_TESTNET|MANUAL_TRADING_ENABLED|MAINNET_MANUAL_TRADING_ENABLED|EXCHANGE_STOPS_ENABLED|PUBLIC_URL)=' backend.env
grep -q '^SETUP_TOKEN=' backend.env && echo "SETUP_TOKEN still present" || echo "SETUP_TOKEN removed"
readlink /opt/tradingbot/current
docker ps --format '{{.Names}}  {{.Status}}'
free -m | head -3
EOF
}

remote_finish_setup() {
  cat <<'EOF'
set -euo pipefail
cd /opt/tradingbot/shared
sed -i '/^SETUP_TOKEN=/d' backend.env
cd /opt/tradingbot/current
docker compose -p tradingbot --env-file /opt/tradingbot/shared/compose.env \
  -f docker-compose.yml -f /opt/tradingbot/shared/compose.production.yml up -d --no-build --force-recreate backend
echo "SETUP_TOKEN removed; registration is closed"
EOF
}

remote_stop() {
  cat <<'EOF'
set -euo pipefail
cd /opt/tradingbot/current
docker compose -p tradingbot --env-file /opt/tradingbot/shared/compose.env \
  -f docker-compose.yml -f /opt/tradingbot/shared/compose.production.yml stop
echo "Bot stopped. Its data is kept. TP/SL polling is not running while it is stopped."
EOF
}

# ── Script that runs on the Platform server ─────────────────────────────────
remote_platform_switch() {
  cat <<EOF
set -euo pipefail
REGION=$REGION
ENABLED=$1
BOT_DOMAIN=$BOT_DOMAIN
HMAC_SECRET=$HMAC_SECRET
EOF
  cat <<'EOF'
cd /opt/srtrend/deployment
grep -q 'MANUAL_TRADING_ENABLED' compose.app.yml \
  || { echo "this Platform release does not pass the manual-trading settings; deploy it first"; exit 1; }
cp .env ".env.bak-manual-$(date -u +%Y%m%d%H%M%S)"
chmod 600 .env.bak-manual-*
sed -i '/^MANUAL_TRADING_ENABLED=/d;/^MANUAL_TRADING_BOT_URL=/d;/^MANUAL_TRADING_HMAC_SECRET=/d' .env
echo "MANUAL_TRADING_ENABLED=$ENABLED" >> .env
if [ "$ENABLED" = true ]; then
  value="$(aws secretsmanager get-secret-value --region "$REGION" --secret-id "$HMAC_SECRET" --query SecretString --output text)"
  [ "${#value}" -ge 32 ] || { echo "control-plane secret could not be read"; exit 1; }
  echo "MANUAL_TRADING_BOT_URL=https://$BOT_DOMAIN" >> .env
  echo "MANUAL_TRADING_HMAC_SECRET=$value" >> .env
fi
docker compose --env-file .env -f compose.app.yml up -d backend
status=starting
for _ in $(seq 1 36); do
  cid="$(docker compose --env-file .env -f compose.app.yml ps -q backend)"
  status="$(docker inspect -f '{{.State.Health.Status}}' "$cid" 2>/dev/null || echo starting)"
  [ "$status" = healthy ] && break
  sleep 5
done
[ "$status" = healthy ] || { echo "PLATFORM BACKEND UNHEALTHY; restore the newest .env.bak-manual-* and run compose up"; exit 1; }
echo "Platform manual trading set to $ENABLED; backend healthy"
EOF
}

# ── Commands ────────────────────────────────────────────────────────────────
cmd_inventory() {
  say "DNS"
  local dns_ip; dns_ip="$(getent ahostsv4 "$BOT_DOMAIN" | awk 'NR==1{print $1}' || true)"
  echo "$BOT_DOMAIN -> ${dns_ip:-does not resolve}"
  for r in "$REGION" "$OLD_BOT_REGION"; do
    say "Instances in $r"
    aws ec2 --region "$r" describe-instances \
      --filters Name=instance-state-name,Values=pending,running,stopping,stopped \
      --query 'Reservations[].Instances[].[InstanceId,State.Name,InstanceType,PublicIpAddress,Tags[?Key==`Name`]|[0].Value]' \
      --output table
    if [ -n "$dns_ip" ]; then
      say "Does $dns_ip belong to this account in $r?"
      aws ec2 --region "$r" describe-addresses --filters "Name=public-ip,Values=$dns_ip" \
        --query 'Addresses[].[PublicIp,InstanceId,AllocationId]' --output table
    fi
  done
  say "Secrets"
  sm list-secrets --filters Key=name,Values=trading-scene/execution-bot \
    --query 'SecretList[].Name' --output text
  say "Inventory done; nothing was changed"
}

cmd_launch() {
  [ -z "$(bot_instance)" ] || die "$BOT_NAME already exists"
  for r in "$REGION" "$OLD_BOT_REGION"; do
    local old
    old="$(aws ec2 --region "$r" describe-instances \
      --filters Name=tag:Name,Values=signal-bot Name=instance-state-name,Values=pending,running,stopping,stopped \
      --query 'Reservations[].Instances[].InstanceId' --output text)"
    [ -z "$old" ] || [ "${ALLOW_OLD_BOT:-}" = yes ] \
      || die "old signal-bot found in $r ($old). It may hold real keys. Decide what to do with it, then rerun with ALLOW_OLD_BOT=yes"
  done

  say "Secrets"
  local secret_arns=() name arn
  for name in "$HMAC_SECRET" "$SETUP_SECRET"; do
    arn="$(sm list-secrets --filters "Key=name,Values=$name" --query 'SecretList[0].ARN' --output text | sed 's/^None$//')"
    if [ -z "$arn" ]; then
      arn="$(sm create-secret --name "$name" --secret-string "$(openssl rand -hex 32)" --query ARN --output text)"
      echo "created $name"
    else
      echo "kept $name"
    fi
    secret_arns+=("$arn")
  done
  local hmac_arn="${secret_arns[0]}" all_arns
  all_arns="$(printf '%s\n' "${secret_arns[@]}" | jq -R . | jq -s .)"

  say "IAM"
  if ! aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
    aws iam create-role --role-name "$ROLE" --assume-role-policy-document \
      '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
    aws iam attach-role-policy --role-name "$ROLE" \
      --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
  fi
  aws iam put-role-policy --role-name "$ROLE" --policy-name read-bot-secrets --policy-document \
    "$(jq -n --argjson r "$all_arns" '{Version:"2012-10-17",Statement:[{Effect:"Allow",Action:"secretsmanager:GetSecretValue",Resource:$r}]}')"
  if ! aws iam get-instance-profile --instance-profile-name "$ROLE" >/dev/null 2>&1; then
    aws iam create-instance-profile --instance-profile-name "$ROLE" >/dev/null
    aws iam add-role-to-instance-profile --instance-profile-name "$ROLE" --role-name "$ROLE"
    sleep 15
  fi
  # The Platform server may read the shared control-plane key, and nothing else new.
  aws iam put-role-policy --role-name "$(app_role)" --policy-name read-bot-control-plane-key --policy-document \
    "$(jq -n --arg r "$hmac_arn" '{Version:"2012-10-17",Statement:[{Effect:"Allow",Action:"secretsmanager:GetSecretValue",Resource:$r}]}')"

  say "Network"
  local subnet vpc sg
  subnet="$(ec2 describe-instances --instance-ids "$APP_INSTANCE" --query 'Reservations[0].Instances[0].SubnetId' --output text)"
  vpc="$(ec2 describe-instances --instance-ids "$APP_INSTANCE" --query 'Reservations[0].Instances[0].VpcId' --output text)"
  sg="$(ec2 describe-security-groups --filters "Name=group-name,Values=$SG_NAME" "Name=vpc-id,Values=$vpc" \
    --query 'SecurityGroups[0].GroupId' --output text | sed 's/^None$//')"
  if [ -z "$sg" ]; then
    sg="$(ec2 create-security-group --group-name "$SG_NAME" --description "Execution Bot HTTP and HTTPS" \
      --vpc-id "$vpc" --query GroupId --output text)"
    ec2 authorize-security-group-ingress --group-id "$sg" --protocol tcp --port 80 --cidr 0.0.0.0/0 >/dev/null
    ec2 authorize-security-group-ingress --group-id "$sg" --protocol tcp --port 443 --cidr 0.0.0.0/0 >/dev/null
  fi

  say "Instance ($BOT_TYPE)"
  local ami user_data id alloc eip
  ami="$(aws ssm get-parameter --region "$REGION" \
    --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 \
    --query Parameter.Value --output text)"
  user_data="$(cat <<'BOOT'
#!/bin/bash
set -euxo pipefail
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
sysctl -w vm.swappiness=10
echo 'vm.swappiness=10' > /etc/sysctl.d/90-swappiness.conf
dnf update -y
dnf install -y docker jq
mkdir -p /usr/local/lib/docker/cli-plugins
curl -fsSL https://github.com/docker/compose/releases/download/v2.29.7/docker-compose-linux-x86_64 \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
chmod 0755 /usr/local/lib/docker/cli-plugins/docker-compose
systemctl enable --now docker amazon-ssm-agent
BOOT
)"
  id="$(ec2 run-instances --image-id "$ami" --instance-type "$BOT_TYPE" \
    --subnet-id "$subnet" --security-group-ids "$sg" \
    --iam-instance-profile "Name=$ROLE" \
    --metadata-options HttpTokens=required,HttpEndpoint=enabled \
    --block-device-mappings '[{"DeviceName":"/dev/xvda","Ebs":{"VolumeSize":20,"VolumeType":"gp3","Encrypted":true,"DeleteOnTermination":false}}]' \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$BOT_NAME}]" \
    --user-data "$user_data" --query 'Instances[0].InstanceId' --output text)"
  ec2 wait instance-running --instance-ids "$id"
  alloc="$(ec2 allocate-address --domain vpc --query AllocationId --output text)"
  ec2 associate-address --instance-id "$id" --allocation-id "$alloc" >/dev/null
  eip="$(ec2 describe-addresses --allocation-ids "$alloc" --query 'Addresses[0].PublicIp' --output text)"

  say "Launched $id"
  echo "Next: in Hostinger DNS, set the A record 'bot' to $eip"
  echo "Then wait for it to resolve and run: bash bot-stack.sh deploy"
}

cmd_deploy() {
  local id ip resolved
  id="$(require_bot_instance)"
  ip="$(instance_ip "$id")"
  resolved="$(getent ahostsv4 "$BOT_DOMAIN" | awk 'NR==1{print $1}' || true)"
  [ "$resolved" = "$ip" ] || die "$BOT_DOMAIN resolves to '${resolved:-nothing}', not $ip. Update DNS first, or TLS cannot be issued"
  run_remote "$id" "$(remote_deploy "$(platform_ip)")" | tail -25
  say "Next: bash bot-stack.sh verify"
}

cmd_verify() {
  local id; id="$(require_bot_instance)"
  say "Bot settings (no secrets)"
  run_remote "$id" "$(remote_flags)"
  say "From this CloudShell"
  echo "health: HTTP $(curl -s -m 15 -o /dev/null -w '%{http_code}' "https://$BOT_DOMAIN/health") (expect 200)"
  echo "manual route from outside the Platform: HTTP $(curl -s -m 15 -o /dev/null -w '%{http_code}' "https://$BOT_DOMAIN/api/manual-trading/state") (expect 403)"
}

cmd_setup_token() {
  sm get-secret-value --secret-id "$SETUP_SECRET" --query SecretString --output text
}
cmd_finish_setup() { run_remote "$(require_bot_instance)" "$(remote_finish_setup)"; }
cmd_stop_bot() { run_remote "$(require_bot_instance)" "$(remote_stop)"; }

cmd_platform_on() {
  [ "$(curl -s -m 15 -o /dev/null -w '%{http_code}' "https://$BOT_DOMAIN/health")" = 200 ] \
    || die "the Bot is not answering at https://$BOT_DOMAIN/health"
  run_remote "$APP_INSTANCE" "$(remote_platform_switch true)" | tail -8
}
cmd_platform_off() { run_remote "$APP_INSTANCE" "$(remote_platform_switch false)" | tail -8; }

# Prints a remote script unrun, so it can be read or syntax-checked.
cmd_print_remote() {
  case "${1:-}" in
    deploy) remote_deploy "${2:-PLATFORM_IP_UNSET}" ;;
    flags) remote_flags ;;
    finish-setup) remote_finish_setup ;;
    stop) remote_stop ;;
    platform-on) remote_platform_switch true ;;
    platform-off) remote_platform_switch false ;;
    *) die "print-remote: deploy|flags|finish-setup|stop|platform-on|platform-off" ;;
  esac
}

case "${1:-}" in
  inventory) cmd_inventory ;;
  launch) cmd_launch ;;
  deploy) cmd_deploy ;;
  verify) cmd_verify ;;
  setup-token) cmd_setup_token ;;
  finish-setup) cmd_finish_setup ;;
  platform-on) cmd_platform_on ;;
  platform-off) cmd_platform_off ;;
  stop-bot) cmd_stop_bot ;;
  print-remote) shift; cmd_print_remote "$@" ;;
  *) die "usage: bot-stack.sh inventory|launch|deploy|verify|setup-token|finish-setup|platform-on|platform-off|stop-bot|print-remote" ;;
esac
