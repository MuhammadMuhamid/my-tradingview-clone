#!/usr/bin/env bash
# Shared loader for the production identifiers these scripts operate on.
#
# The AWS account id, EC2 instance ids, RDS identifier, bucket name, Secrets
# Manager ARN and public hostname used to be hardcoded across eight scripts and
# `CLAUDE_HANDOFF.md`. None of them is a credential, but together they pin the
# exact hosts that terminate the money path, and they shorten reconnaissance
# considerably in a repository that has been copied around (finding X-11).
#
# They now live in `platform/deployment/aws/.env`, which is untracked. Copy
# `.env.example`, fill it in on the machine that runs these scripts, and keep it
# out of git — `.gitignore` already excludes it.
#
# Usage, from any script in this directory:
#     . "$(dirname "$0")/env.sh"
set -euo pipefail

_AWS_ENV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_AWS_ENV_FILE="${AWS_DEPLOY_ENV:-$_AWS_ENV_DIR/.env}"

# Two call sites, two ways in:
#   * CloudShell — the operator has a filled-in .env in this directory.
#   * On the app EC2 via SSM — the invoking command exports the values, and no
#     file is copied to the instance.
# So a missing file is not fatal here; a missing *value* is, and
# `aws_env_require` below is what reports it.
if [ -f "$_AWS_ENV_FILE" ]; then
  # shellcheck disable=SC1090
  . "$_AWS_ENV_FILE"
fi

# Fail on a template that was copied but not filled in, rather than issuing an
# AWS call against an empty identifier.
aws_env_require() {
  local missing=()
  for name in "$@"; do
    if [ -z "${!name:-}" ]; then missing+=("$name"); fi
  done
  if [ ${#missing[@]} -gt 0 ]; then
    cat >&2 <<MSG
deployment environment is incomplete: ${missing[*]}

These scripts act on live production infrastructure, so the identifiers are not
committed (finding X-11). Supply them one of two ways:

  * in CloudShell —
        cp $_AWS_ENV_DIR/.env.example $_AWS_ENV_DIR/.env
        \$EDITOR $_AWS_ENV_DIR/.env
    (or point AWS_DEPLOY_ENV at another file)

  * on the instance via SSM — export them in the invoking command.
MSG
    exit 1
  fi
}
