# AWS production deployment

This package deploys the clone as three isolated layers:

- **App EC2**: Caddy HTTPS + password protection, Next.js UI, API, backtest worker and the latency-sensitive live alert runner.
- **Compute EC2**: the four continuous MA + R:R optimizers (current 15m,
  current 1h, one-year 15m, and one-year 1h). It has no inbound ports and
  cannot delay live signals.
- **RDS PostgreSQL 16**: private, encrypted, 14-day automated backups, reachable only by the two application security groups.

Both EC2 servers are administered with AWS Systems Manager Session Manager. Port 22 is never opened. ECR image scanning, CloudWatch logs and an encrypted/versioned S3 backup bucket are included.

## Required user-owned inputs

1. An AWS account with billing enabled and MFA on the root and administrator users.
2. AWS region `ap-south-1` (Mumbai), matching the existing production stack.
3. A domain or subdomain such as `chart.yourdomain.com`.
4. A strong dashboard username/password.
5. The **existing** `ALERT_ENCRYPTION_KEY` from the Mac. It must be reused exactly or stored webhook secrets cannot be decrypted after migration.

## Safe migration order

1. Deploy infrastructure with `deploy-stack.sh`.
2. Build and push images with `build-and-push.sh`.
3. Export the current DB and all four independent optimizer histories with
   `export-current-state.sh` and upload them to the stack's private S3 bucket.
4. Restore PostgreSQL and optimizer files while all cloud alert services remain stopped.
5. Start the cloud UI and optimizers, but keep the cloud live runner disabled.
6. Compare health, active deployment count, parameters, positions, latest bars, and a dry-run alert payload against the Mac.
7. At a confirmed flat-position maintenance window, stop the Mac live runner, start the AWS live runner, and verify only one runner is active. Never run both against the same bot.

## Commands after AWS credentials are configured

```bash
cd "platform/deployment/aws"
export AWS_REGION=ap-south-1
export DOMAIN_NAME=chart.example.com
./deploy-stack.sh
```

The scripts intentionally do not contain credentials. Runtime `.env` files belong only on the EC2 hosts with mode `0600`; never commit them or upload them in the source bundle.

## Rolling a new release onto the running app EC2

`update-app.sh` builds both images **on the app instance** from an extracted
source bundle. It does not fetch that bundle itself — `cloud-deploy.sh` does
the S3 download and extraction first, and running `update-app.sh` against a tag
that was never extracted exits with `source bundle missing at ...` before
touching anything.

```bash
TAG=$(date -u +%Y%m%d%H%M%S)
# from the repo root: bundle only what the images need
git archive --format=tar.gz --prefix=platform/ HEAD:platform \
  backend frontend deployment > "src-$TAG.tar.gz"
```

Upload it to `s3://<backup-bucket>/deploy/`, then, on the instance:

```bash
aws s3 cp "s3://<bucket>/deploy/src-$TAG.tar.gz" /tmp/b.tar.gz
mkdir -p "/opt/srtrend-src-$TAG"
tar -xzf /tmp/b.tar.gz -C "/opt/srtrend-src-$TAG"
nohup bash "/opt/srtrend-src-$TAG/platform/deployment/aws/update-app.sh" "$TAG" \
  > "/var/log/deploy-$TAG.log" 2>&1 &
```

Bundle only `backend frontend deployment`. A whole-tree archive pulls in
`Mystrategy/` (~20 MB of research data) that no image builds from.

Run it detached with a log. An in-place build takes many minutes and will
outlive a foreground SSM invocation.

### The app instance needs swap

**The `t3.micro` has 916 MB of RAM and cannot build the Next.js image without
swap.** Without it the OOM killer takes the SSM agent with it, and the instance
wedges: `describe-instance-status` still reports `running ok ok` while every
`send-command` returns `Undeliverable` / `ResponseCode -1`, and the only way
back is an EC2-level stop/start. Sustained high CPU during such a build is
thrashing, not progress.

Verify before deploying — `free -m` must show a non-zero `Swap` row:

```bash
if [ ! -e /swapfile ]; then fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048; fi
chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
grep -q swapfile /etc/fstab || echo "/swapfile none swap sw 0 0" >> /etc/fstab
free -m
```

Note the `-e` test rather than `-f`: a `/swapfile` can exist on disk while
being neither enabled nor listed in `/etc/fstab`, and a guard that skips the
whole block when the file is present will silently leave swap at zero. Trust
the `free -m` output, not the exit status.

The durable fix is to stop building on the instance at all: build the images
in CI, push to ECR, and have the box only pull. That removes the memory
ceiling from the deploy path entirely.

### Caddy is reloaded, not recreated

`update-app.sh` rolls only `backend` and `frontend`; Caddy holds the TLS
certificates and every live connection, so recreating it on each release would
drop traffic for no reason. But the script also **copies a new Caddyfile**, and
a running Caddy keeps serving the config it parsed at startup — so before this
was fixed a routing change landed on disk and did nothing.

That is not hypothetical: the release that added the `/readyz` route shipped
with `caddy` showing `Up 4 days`, and `/readyz` kept falling through to the
frontend and redirecting to `/login`. The stack was healthy; the check this
runbook tells you to trust was answering from a stale config.

The script now runs `caddy reload` after the backend is healthy. The reload
validates first and keeps the old config if the new one is broken — verified
against production by reloading a deliberately invalid file: the reload was
refused, Caddy never restarted, and the site served 200 throughout. A failed
reload is therefore loud but **not** fatal to the deploy: the app has already
rolled, and the previous routing stays live until someone fixes the Caddyfile.

### If the site is down mid-deploy

1. `aws rds describe-db-instances` — check `DBInstanceStatus` first. The app
   serves `/healthz` (Caddy) and `/login` long after the database is gone, so a
   200 there is not evidence the stack is ready. Check `/readyz`: it crosses
   the proxy and returns 503 unless the app can reach a fully migrated database.
2. `docker ps -a` — a compose roll that aborts on an unhealthy backend leaves
   the frontend in `Created` and never started. `docker compose --env-file .env
   -f compose.app.yml up -d` finishes it.
3. Roll back with the env backup the script wrote: `cp .env.bak-<TAG> .env`
   then bring the containers up again.
