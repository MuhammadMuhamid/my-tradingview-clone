#!/usr/bin/env bash
set -euo pipefail

MODE="${1:?usage: install-dashboard-sync.sh push|pull BACKUP_BUCKET}"
BUCKET="${2:?usage: install-dashboard-sync.sh push|pull BACKUP_BUCKET}"
[[ "$MODE" == "push" || "$MODE" == "pull" ]] || { echo "mode must be push or pull" >&2; exit 2; }

install -d -m 0750 /opt/srtrend/deployment
cat >/opt/srtrend/deployment/dashboard-sync.env <<EOF
BACKUP_BUCKET=${BUCKET}
EOF
chmod 0600 /opt/srtrend/deployment/dashboard-sync.env

cat >/etc/systemd/system/srtrend-dashboard-sync.service <<EOF
[Unit]
Description=SRTrend optimizer dashboard ${MODE}
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
EnvironmentFile=/opt/srtrend/deployment/dashboard-sync.env
ExecStart=/opt/srtrend/source/platform/deployment/aws/sync-optimizer-dashboards.sh ${MODE}
EOF

cat >/etc/systemd/system/srtrend-dashboard-sync.timer <<'EOF'
[Unit]
Description=Refresh SRTrend optimizer dashboard every minute

[Timer]
OnBootSec=45s
OnUnitActiveSec=60s
AccuracySec=10s
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now srtrend-dashboard-sync.timer
systemctl start srtrend-dashboard-sync.service
