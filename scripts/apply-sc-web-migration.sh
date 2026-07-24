#!/usr/bin/env bash
set -euo pipefail

# ── apply-sc-web-migration.sh ──────────────────────────────────────────
# Apply a single Drizzle SQL migration to the production Postgres on VPS.
#
# Usage:
#   scripts/apply-sc-web-migration.sh sc-web/drizzle/0012_some_migration.sql
#
# What it does:
#   1. Validates the migration file exists and is readable
#   2. Creates and verifies a timestamped compressed production backup
#   3. Applies it via psql inside the sc-web-postgres-1 container
#   4. Fails on any SQL error (ON_ERROR_STOP=1)
#   5. Runs a lightweight verification query (checks tables exist)
#
# Follow the migration file's declared ordering. Destructive removals must run
# only after compatible sc-web code is deployed and health-checked; additive,
# backward-compatible migrations may run before their matching code.
# ────────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

VPS_HOST="${GV_VPS_HOST:?set GV_VPS_HOST to your gateway host}"
VPS_USER="${GV_VPS_USER:-root}"
PG_CONTAINER="${GV_PG_CONTAINER:-sc-web-postgres-1}"
PG_USER="${GV_PG_USER:-sprite_cloud}"
PG_DB="${GV_PG_DB:-sprite_cloud}"
BACKUP_DIR="${GV_DB_BACKUP_DIR:-/docker/sc-web/backups}"

log()  { printf '[migration] %s\n' "$*"; }
warn() { printf '[migration][warn] %s\n' "$*" >&2; }
fail() { printf '[migration][error] %s\n' "$*" >&2; exit 1; }

# ── validate args ──────────────────────────────────────────────────────

MIGRATION_FILE="${1:-}"
if [[ -z "$MIGRATION_FILE" ]]; then
  fail "usage: $0 <migration-file.sql>"
fi

# Resolve relative paths from PROJECT_DIR
if [[ "$MIGRATION_FILE" != /* ]]; then
  MIGRATION_FILE="$PROJECT_DIR/$MIGRATION_FILE"
fi

if [[ ! -f "$MIGRATION_FILE" ]]; then
  fail "migration file not found: $MIGRATION_FILE"
fi

MIGRATION_NAME="$(basename "$MIGRATION_FILE")"
[[ "$MIGRATION_NAME" =~ ^[A-Za-z0-9_.-]+\.sql$ ]] || fail "unsafe migration filename"
log "preparing migration: $MIGRATION_NAME"

for value in "$PG_CONTAINER" "$PG_USER" "$PG_DB"; do
  [[ "$value" =~ ^[A-Za-z0-9_.-]+$ ]] || fail "unsafe database identifier"
done
[[ "$BACKUP_DIR" =~ ^/[A-Za-z0-9_./-]+$ ]] || fail "unsafe backup directory"

# ── verified backup ────────────────────────────────────────────────────

BACKUP_FILE="$BACKUP_DIR/pre-${MIGRATION_NAME%.sql}-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
log "creating verified backup: $VPS_HOST:$BACKUP_FILE"
ssh "$VPS_USER@$VPS_HOST" "
  set -euo pipefail
  mkdir -p '$BACKUP_DIR'
  docker inspect '$PG_CONTAINER' >/dev/null
  docker exec '$PG_CONTAINER' pg_dump -U '$PG_USER' '$PG_DB' | gzip -9 > '$BACKUP_FILE'
  test -s '$BACKUP_FILE'
"
log "backup verified: $BACKUP_FILE"

# ── apply ──────────────────────────────────────────────────────────────

log "applying to $VPS_HOST:$PG_CONTAINER ..."

# Pipe the SQL through psql with ON_ERROR_STOP=1 so any error fails the script.
ssh "$VPS_USER@$VPS_HOST" "docker exec -i $PG_CONTAINER psql -U $PG_USER -d $PG_DB -v ON_ERROR_STOP=1" < "$MIGRATION_FILE"

log "migration applied successfully"

# ── verify schema ──────────────────────────────────────────────────────

log "verifying schema..."

VERIFY_SQL="
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
ORDER BY table_name;
"

ssh "$VPS_USER@$VPS_HOST" "docker exec -i $PG_CONTAINER psql -U $PG_USER -d $PG_DB -c '$VERIFY_SQL'"

log "migration $MIGRATION_NAME complete"
log ""
log "Next steps:"
log "  1. Verify the schema changes above look correct"
log "  2. Verify health: curl -s ${GV_WEB_URL:-https://your-gateway.example}/api/health"
