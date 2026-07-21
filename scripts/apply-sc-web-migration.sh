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
#   2. Applies it via psql inside the sc-web-postgres-1 container
#   3. Fails on any SQL error (ON_ERROR_STOP=1)
#   4. Runs a lightweight verification query (checks tables exist)
#
# The migration must be applied BEFORE deploying the new sc-web code.
# Order: generate migration → review → apply → deploy
# ────────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

VPS_HOST="${GV_VPS_HOST:?set GV_VPS_HOST to your gateway host}"
VPS_USER="${GV_VPS_USER:-root}"
PG_CONTAINER="${GV_PG_CONTAINER:-sc-web-postgres-1}"
PG_USER="${GV_PG_USER:-sprite_cloud}"
PG_DB="${GV_PG_DB:-sprite_cloud}"

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
log "applying migration: $MIGRATION_NAME"

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
log "  2. Deploy sc-web: scripts/deploy-sc-web.sh"
log "  3. Verify health:  curl -s ${GV_WEB_URL:-https://your-gateway.example}/api/health"
