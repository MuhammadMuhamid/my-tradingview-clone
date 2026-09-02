#!/usr/bin/env bash
# Restore a Platform custom-format dump into an explicitly identified, fresh
# database. This never drops, truncates, cleans, or reads ambient DATABASE_URL.
set -euo pipefail

usage() {
  echo "usage: PLATFORM_RESTORE_DESTINATION_URL=<postgres-url> PLATFORM_RESTORE_EXPECT_DATABASE=<name> $0 <backup.dump>" >&2
  exit 2
}

[ "$#" -eq 1 ] || usage
: "${PLATFORM_RESTORE_DESTINATION_URL:?Set PLATFORM_RESTORE_DESTINATION_URL explicitly; DATABASE_URL is not used}"
: "${PLATFORM_RESTORE_EXPECT_DATABASE:?Set PLATFORM_RESTORE_EXPECT_DATABASE to the intended fresh database name}"

BACKUP_PATH="$1"
MANIFEST_PATH="${BACKUP_PATH}.manifest"
[ -s "$BACKUP_PATH" ] || {
  echo "restore-platform-db: backup is missing or empty: $BACKUP_PATH" >&2
  exit 1
}
[ -s "$MANIFEST_PATH" ] || {
  echo "restore-platform-db: manifest is missing or empty: $MANIFEST_PATH" >&2
  exit 1
}

for tool in psql pg_restore; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "restore-platform-db: required PostgreSQL tool not found: $tool" >&2
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

manifest_value() {
  awk -F= -v wanted="$1" '$1 == wanted { sub(/^[^=]*=/, ""); print }' "$MANIFEST_PATH"
}

FORMAT="$(manifest_value format)"
EXPECTED_SHA256="$(manifest_value dump_sha256)"
SOURCE_SERVER_MAJOR="$(manifest_value server_major)"
PG_DUMP_MAJOR="$(manifest_value pg_dump_major)"
EXTENSIONS="$(manifest_value extensions)"
EXPECTED_MIGRATIONS_SHA256="$(manifest_value schema_migrations_sha256)"

[ "$FORMAT" = "trading-scene-platform-postgresql-custom-v1" ] || {
  echo "restore-platform-db: unsupported or malformed manifest format" >&2
  exit 1
}
[[ "$EXPECTED_SHA256" =~ ^[0-9a-f]{64}$ ]] || {
  echo "restore-platform-db: malformed dump checksum in manifest" >&2
  exit 1
}
[[ "$SOURCE_SERVER_MAJOR" =~ ^[0-9]+$ ]] || {
  echo "restore-platform-db: malformed source PostgreSQL major version" >&2
  exit 1
}
[[ "$PG_DUMP_MAJOR" =~ ^[0-9]+$ ]] || {
  echo "restore-platform-db: malformed pg_dump major version" >&2
  exit 1
}
[[ "$EXPECTED_MIGRATIONS_SHA256" =~ ^[0-9a-f]{64}$ ]] || {
  echo "restore-platform-db: malformed migration checksum in manifest" >&2
  exit 1
}

ACTUAL_SHA256="$(sha256_file "$BACKUP_PATH")"
[ "$ACTUAL_SHA256" = "$EXPECTED_SHA256" ] || {
  echo "restore-platform-db: backup checksum does not match manifest" >&2
  exit 1
}
pg_restore --list "$BACKUP_PATH" >/dev/null || {
  echo "restore-platform-db: backup is not a readable PostgreSQL custom archive" >&2
  exit 1
}

PG_RESTORE_VERSION="$(pg_restore --version | sed -E 's/^pg_restore \(PostgreSQL\) //')"
PG_RESTORE_MAJOR="${PG_RESTORE_VERSION%%.*}"
[ "$PG_RESTORE_MAJOR" -eq "$PG_DUMP_MAJOR" ] || {
  echo "restore-platform-db: pg_restore major $PG_RESTORE_MAJOR does not match backup tool major $PG_DUMP_MAJOR" >&2
  exit 1
}

DESTINATION_DATABASE="$(psql --dbname="$PLATFORM_RESTORE_DESTINATION_URL" -XAtq \
  -v ON_ERROR_STOP=1 -c "SELECT current_database()")"
[ "$DESTINATION_DATABASE" = "$PLATFORM_RESTORE_EXPECT_DATABASE" ] || {
  echo "restore-platform-db: connected database '$DESTINATION_DATABASE' does not match explicitly expected '$PLATFORM_RESTORE_EXPECT_DATABASE'" >&2
  exit 1
}
case "$DESTINATION_DATABASE" in
  postgres|template0|template1)
    echo "restore-platform-db: refusing PostgreSQL maintenance/template database: $DESTINATION_DATABASE" >&2
    exit 1
    ;;
esac

DESTINATION_VERSION_NUM="$(psql --dbname="$PLATFORM_RESTORE_DESTINATION_URL" -XAtq \
  -v ON_ERROR_STOP=1 -c "SHOW server_version_num")"
DESTINATION_MAJOR="$((DESTINATION_VERSION_NUM / 10000))"
[ "$DESTINATION_MAJOR" -eq "$SOURCE_SERVER_MAJOR" ] || {
  echo "restore-platform-db: destination PostgreSQL major $DESTINATION_MAJOR does not match source major $SOURCE_SERVER_MAJOR" >&2
  exit 1
}

USER_RELATIONS="$(psql --dbname="$PLATFORM_RESTORE_DESTINATION_URL" -XAtq \
  -v ON_ERROR_STOP=1 -c \
  "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast' AND c.relkind IN ('r','p','v','m','S','f')")"
USER_SCHEMAS="$(psql --dbname="$PLATFORM_RESTORE_DESTINATION_URL" -XAtq \
  -v ON_ERROR_STOP=1 -c \
  "SELECT count(*) FROM pg_namespace WHERE nspname <> 'public' AND nspname NOT IN ('pg_catalog','information_schema') AND nspname !~ '^pg_toast'")"
NONDEFAULT_EXTENSIONS="$(psql --dbname="$PLATFORM_RESTORE_DESTINATION_URL" -XAtq \
  -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM pg_extension WHERE extname <> 'plpgsql'")"
[ "$USER_RELATIONS" -eq 0 ] && [ "$USER_SCHEMAS" -eq 0 ] && [ "$NONDEFAULT_EXTENSIONS" -eq 0 ] || {
  echo "restore-platform-db: destination is not fresh and empty; create a new database instead" >&2
  exit 1
}

TIMESCALE_VERSION=""
IFS=',' read -r -a EXTENSION_ITEMS <<< "$EXTENSIONS"
for item in "${EXTENSION_ITEMS[@]}"; do
  [ -n "$item" ] || continue
  name="${item%%:*}"
  version="${item#*:}"
  [[ "$name" =~ ^[A-Za-z0-9_-]+$ && "$version" =~ ^[A-Za-z0-9._-]+$ ]] || {
    echo "restore-platform-db: malformed extension entry in manifest" >&2
    exit 1
  }
  [ "$name" = "plpgsql" ] && continue
  # Both values passed this script's strict identifier/version allowlist above.
  AVAILABLE="$(psql --dbname="$PLATFORM_RESTORE_DESTINATION_URL" -XAtq \
    -v ON_ERROR_STOP=1 -c \
    "SELECT count(*) FROM pg_available_extension_versions WHERE name = '$name' AND version = '$version'")"
  [ "$AVAILABLE" -gt 0 ] || {
    echo "restore-platform-db: required extension is unavailable at the recorded version: $name $version" >&2
    exit 1
  }
  if [ "$name" = "timescaledb" ]; then
    TIMESCALE_VERSION="$version"
  fi
done

if [ -n "$TIMESCALE_VERSION" ]; then
  psql --dbname="$PLATFORM_RESTORE_DESTINATION_URL" -Xq -v ON_ERROR_STOP=1 -c \
    "CREATE EXTENSION timescaledb VERSION '$TIMESCALE_VERSION'; SELECT timescaledb_pre_restore();"
fi

restore_status=0
pg_restore --exit-on-error --no-owner --no-acl \
  --dbname="$PLATFORM_RESTORE_DESTINATION_URL" "$BACKUP_PATH" || restore_status=$?

if [ -n "$TIMESCALE_VERSION" ]; then
  psql --dbname="$PLATFORM_RESTORE_DESTINATION_URL" -Xq -v ON_ERROR_STOP=1 \
    -c "SELECT timescaledb_post_restore();" || restore_status=$?
fi
[ "$restore_status" -eq 0 ] || {
  echo "restore-platform-db: restore failed; discard this partial destination and create a new one" >&2
  exit "$restore_status"
}

RESTORED_EXTENSIONS="$(psql --dbname="$PLATFORM_RESTORE_DESTINATION_URL" -XAtq \
  -v ON_ERROR_STOP=1 -c \
  "SELECT coalesce(string_agg(extname || ':' || extversion, ',' ORDER BY extname), '') FROM pg_extension")"
[ "$RESTORED_EXTENSIONS" = "$EXTENSIONS" ] || {
  echo "restore-platform-db: restored extension versions do not match the backup manifest" >&2
  exit 1
}

RESTORED_MIGRATIONS="$(psql --dbname="$PLATFORM_RESTORE_DESTINATION_URL" -XAtq \
  -v ON_ERROR_STOP=1 -c \
  "SELECT coalesce(string_agg(filename, ',' ORDER BY filename), '') FROM schema_migrations")"
RESTORED_MIGRATIONS_SHA256="$(printf '%s' "$RESTORED_MIGRATIONS" | sha256_text)"
[ "$RESTORED_MIGRATIONS_SHA256" = "$EXPECTED_MIGRATIONS_SHA256" ] || {
  echo "restore-platform-db: restored migration state does not match the backup manifest" >&2
  exit 1
}

echo "Platform database restored into explicit fresh destination: $DESTINATION_DATABASE"
