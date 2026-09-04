#!/usr/bin/env bash
# Native, full-fidelity Platform database backup. The dedicated source variable
# is intentional: never inherit DATABASE_URL for an operator recovery action.
set -euo pipefail

usage() {
  echo "usage: PLATFORM_BACKUP_SOURCE_URL=<postgres-url> $0 <new-backup.dump>" >&2
  exit 2
}

[ "$#" -eq 1 ] || usage
: "${PLATFORM_BACKUP_SOURCE_URL:?Set PLATFORM_BACKUP_SOURCE_URL explicitly; DATABASE_URL is not used}"

BACKUP_PATH="$1"
MANIFEST_PATH="${BACKUP_PATH}.manifest"
BACKUP_DIR="$(dirname "$BACKUP_PATH")"
[ -d "$BACKUP_DIR" ] || {
  echo "backup-platform-db: output directory does not exist: $BACKUP_DIR" >&2
  exit 1
}
[ ! -e "$BACKUP_PATH" ] || {
  echo "backup-platform-db: refusing to overwrite: $BACKUP_PATH" >&2
  exit 1
}
[ ! -e "$MANIFEST_PATH" ] || {
  echo "backup-platform-db: refusing to overwrite: $MANIFEST_PATH" >&2
  exit 1
}

for tool in psql pg_dump pg_restore; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "backup-platform-db: required PostgreSQL tool not found: $tool" >&2
    exit 1
  }
done

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

sha256_text() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
  else
    shasum -a 256 | awk '{print $1}'
  fi
}

umask 077
TMP_DUMP="${BACKUP_PATH}.partial.$$"
TMP_MANIFEST="${MANIFEST_PATH}.partial.$$"
cleanup() {
  rm -f "$TMP_DUMP" "$TMP_MANIFEST"
}
trap cleanup EXIT HUP INT TERM

SERVER_VERSION_NUM="$(psql --dbname="$PLATFORM_BACKUP_SOURCE_URL" -XAtq \
  -v ON_ERROR_STOP=1 -c "SHOW server_version_num")"
DATABASE_NAME="$(psql --dbname="$PLATFORM_BACKUP_SOURCE_URL" -XAtq \
  -v ON_ERROR_STOP=1 -c "SELECT current_database()")"
MIGRATIONS="$(psql --dbname="$PLATFORM_BACKUP_SOURCE_URL" -XAtq \
  -v ON_ERROR_STOP=1 -c \
  "SELECT coalesce(string_agg(filename, ',' ORDER BY filename), '') FROM schema_migrations")"
EXTENSIONS="$(psql --dbname="$PLATFORM_BACKUP_SOURCE_URL" -XAtq \
  -v ON_ERROR_STOP=1 -c \
  "SELECT coalesce(string_agg(extname || ':' || extversion, ',' ORDER BY extname), '') FROM pg_extension")"

SERVER_MAJOR="$((SERVER_VERSION_NUM / 10000))"
if [ "$SERVER_MAJOR" -lt 15 ]; then
  echo "backup-platform-db: Platform migrations require PostgreSQL 15 or newer" >&2
  exit 1
fi

pg_dump --format=custom --no-owner --no-acl \
  --dbname="$PLATFORM_BACKUP_SOURCE_URL" --file="$TMP_DUMP"
pg_restore --list "$TMP_DUMP" >/dev/null

DUMP_SHA256="$(sha256_file "$TMP_DUMP")"
MIGRATIONS_SHA256="$(printf '%s' "$MIGRATIONS" | sha256_text)"
PG_DUMP_VERSION="$(pg_dump --version | sed -E 's/^pg_dump \(PostgreSQL\) //')"
PG_DUMP_MAJOR="${PG_DUMP_VERSION%%.*}"
CREATED_UTC="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

{
  printf 'format=trading-scene-platform-postgresql-custom-v1\n'
  printf 'created_utc=%s\n' "$CREATED_UTC"
  printf 'source_database=%s\n' "$DATABASE_NAME"
  printf 'server_version_num=%s\n' "$SERVER_VERSION_NUM"
  printf 'server_major=%s\n' "$SERVER_MAJOR"
  printf 'pg_dump_version=%s\n' "$PG_DUMP_VERSION"
  printf 'pg_dump_major=%s\n' "$PG_DUMP_MAJOR"
  printf 'extensions=%s\n' "$EXTENSIONS"
  printf 'schema_migrations=%s\n' "$MIGRATIONS"
  printf 'schema_migrations_sha256=%s\n' "$MIGRATIONS_SHA256"
  printf 'dump_sha256=%s\n' "$DUMP_SHA256"
} > "$TMP_MANIFEST"

mv "$TMP_DUMP" "$BACKUP_PATH"
mv "$TMP_MANIFEST" "$MANIFEST_PATH"
trap - EXIT HUP INT TERM
echo "Platform database backup created: $BACKUP_PATH"
echo "Compatibility and integrity manifest: $MANIFEST_PATH"
