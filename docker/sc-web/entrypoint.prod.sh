#!/bin/sh
set -eu

cd /app/sc-web
export NODE_PATH=/app/schema-tools/node_modules

if [ "${GV_WEB_SCHEMA_PUSH_ON_START:-0}" = "1" ]; then
  table_count=$(node -e "
    const postgres = require('postgres');
    const sql = postgres(process.env.DATABASE_URL, { max: 1 });
    sql\`SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'\`.then(rows => {
      console.log(Number(rows[0].count));
      sql.end();
    }).catch(() => { console.log(-1); sql.end(); });
  ")
  if [ "$table_count" != "0" ]; then
    echo "[sc-web] refusing schema push on a nonempty database; apply reviewed migrations explicitly" >&2
    exit 1
  fi
  echo "[sc-web] initializing empty DB schema..."
  NODE_PATH=/app/schema-tools/node_modules \
    /app/schema-tools/node_modules/.bin/drizzle-kit push --force
else
  echo "[sc-web] skipping DB schema push; apply migrations explicitly before deploy"
fi

# ── Pre-flight: setup code generation ──────────────────────────────────
# If the users table is empty, generate the raw capability that instrumentation
# imports into invite_codes as the one-use bootstrap invitation.

SETUP_CODE_FILE="/tmp/sc-setup-code"

if [ "${GV_WEB_SKIP_SETUP_INIT:-0}" = "1" ]; then
  echo "[sc-web] skipping setup init (GV_WEB_SKIP_SETUP_INIT=1)"
else
  user_count=$(node -e "
    const postgres = require('postgres');
    const sql = postgres(process.env.DATABASE_URL, { max: 1 });
    sql\`SELECT count(*) FROM users\`.then(rows => {
      console.log(Number(rows[0].count));
      sql.end();
    }).catch(() => { console.log(-1); sql.end(); });
  ")

  if [ "$user_count" = "0" ]; then
    echo "[sc-web] zero users detected — generating bootstrap invitation capability..."
    SETUP_CODE=$(node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))")
    umask 077
    printf '%s\n' "$SETUP_CODE" > "$SETUP_CODE_FILE"
    printf '\n╔════════════════════════════════════════════════════════════════╗\n'
    printf '║              Sprite Cloud — First Run                          ║\n'
    printf '╠════════════════════════════════════════════════════════════════╣\n'
    SETUP_URL="${AUTH_URL:-${NEXTAUTH_URL:-}}"
    if [ -n "$SETUP_URL" ]; then
      printf '║  Visit %s\n' "${SETUP_URL%/}/invite/$SETUP_CODE"
    else
      printf '║  Visit /invite/%s on your gateway URL\n' "$SETUP_CODE"
    fi
    printf '╚════════════════════════════════════════════════════════════════╝\n\n'
  elif [ "$user_count" -gt 0 ] 2>/dev/null; then
    echo "[sc-web] users exist — cleaning stale setup code"
    rm -f "$SETUP_CODE_FILE"
  fi
fi

echo "[sc-web] starting production server..."
exec node /app/sc-web/server.js
