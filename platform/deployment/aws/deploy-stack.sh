#!/usr/bin/env bash
set -euo pipefail

: "${AWS_REGION:?Set AWS_REGION, recommended ap-southeast-1}"
: "${DOMAIN_NAME:?Set DOMAIN_NAME, for example chart.example.com}"

STACK_NAME="${STACK_NAME:-srtrend-production}"
ROOT="$(cd "$(dirname "$0")" && pwd)"

aws cloudformation deploy \
  --region "$AWS_REGION" \
  --stack-name "$STACK_NAME" \
  --template-file "$ROOT/cloudformation.yml" \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    DomainName="$DOMAIN_NAME" \
    HostedZoneId="${HOSTED_ZONE_ID:-}" \
    AppInstanceType="${APP_INSTANCE_TYPE:-t3.micro}" \
    ComputeInstanceType="${COMPUTE_INSTANCE_TYPE:-t3.micro}" \
    DBInstanceClass="${DB_INSTANCE_CLASS:-db.t4g.micro}"

aws cloudformation describe-stacks --region "$AWS_REGION" --stack-name "$STACK_NAME" \
  --query 'Stacks[0].Outputs[*].[OutputKey,OutputValue]' --output table
