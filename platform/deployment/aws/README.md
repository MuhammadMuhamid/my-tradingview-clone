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
