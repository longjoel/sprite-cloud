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

# ── compatible deployment preflight ───────────────────────────────────

log "verifying compatible sc-web deployment health before backup and migration..."
HEALTH_JSON="$(ssh "$VPS_USER@$VPS_HOST" "curl -fsS http://localhost:3000/api/health")"
grep -Eq '"phase4c_library_owner"[[:space:]]*:[[:space:]]*"sc-server"' <<<"$HEALTH_JSON" \
  || fail "deployed sc-web is healthy but not Phase 4c migration-ready"

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

# ── verify privacy cutover + application health ───────────────────────

log "verifying legacy privacy tables are absent..."

VERIFY_SQL="SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('favorites','pinned_games','recent_plays','game_files','games','server_rom_roots');"
LEGACY_COUNT="$(ssh "$VPS_USER@$VPS_HOST" "docker exec '$PG_CONTAINER' psql -U '$PG_USER' -d '$PG_DB' -Atc \"$VERIFY_SQL\"")"
[[ "$LEGACY_COUNT" == "0" ]] || fail "privacy cutover incomplete: $LEGACY_COUNT legacy tables remain"

log "verifying sc-web health..."
ssh "$VPS_USER@$VPS_HOST" "curl -fsS http://localhost:3000/api/health >/dev/null"

log "migration $MIGRATION_NAME complete"
log "verified backup: $BACKUP_FILE"
log "legacy privacy tables: 0"
log "sc-web health: ok"
