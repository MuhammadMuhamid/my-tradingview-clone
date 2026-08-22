#!/usr/bin/env bash
set -euo pipefail

: "${AWS_REGION:?Set AWS_REGION}"
: "${BACKEND_REPOSITORY:?Set BACKEND_REPOSITORY from CloudFormation outputs}"
: "${FRONTEND_REPOSITORY:?Set FRONTEND_REPOSITORY from CloudFormation outputs}"
: "${OPTIMIZER_REPOSITORY:?Set OPTIMIZER_REPOSITORY from CloudFormation outputs}"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REGISTRY="${BACKEND_REPOSITORY%%/*}"
TAG="${IMAGE_TAG:-$(date -u +%Y%m%d%H%M%S)}"

aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "$REGISTRY"
docker build --platform linux/amd64 --target runtime -t "$BACKEND_REPOSITORY:$TAG" "$ROOT/backend"
docker build --platform linux/amd64 --target optimizer -t "$OPTIMIZER_REPOSITORY:$TAG" "$ROOT/backend"
docker build --platform linux/amd64 --build-arg BACKEND_URL=http://backend:4000 -t "$FRONTEND_REPOSITORY:$TAG" "$ROOT/frontend"
docker push "$BACKEND_REPOSITORY:$TAG"
docker push "$OPTIMIZER_REPOSITORY:$TAG"
docker push "$FRONTEND_REPOSITORY:$TAG"
printf 'IMAGE_TAG=%s\n' "$TAG"
