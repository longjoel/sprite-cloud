#!/bin/sh
set -eu

cd /app/gv-web

if [ "${GV_WEB_SCHEMA_PUSH_ON_START:-0}" = "1" ]; then
  echo "[gv-web] pushing DB schema..."
  npx drizzle-kit push --force
else
  echo "[gv-web] skipping DB schema push; apply migrations explicitly before deploy"
fi

# ── Pre-flight: setup code generation ──────────────────────────────────
# If the users table is empty, generate a one-time setup code so the deployer
# can create the first admin account via /setup.

SETUP_CODE_FILE="/tmp/gv-setup-code"

user_count=$(node -e "
  const postgres = require('postgres');
  const sql = postgres(process.env.DATABASE_URL, { max: 1 });
  sql\`SELECT count(*) FROM users\`.then(rows => {
    console.log(Number(rows[0].count));
    sql.end();
  }).catch(() => { console.log(-1); sql.end(); });
")

if [ "${GV_WEB_SKIP_SETUP_INIT:-0}" = "1" ]; then
  echo "[gv-web] skipping setup init (GV_WEB_SKIP_SETUP_INIT=1)"
elif [ "$user_count" = "0" ]; then
  echo "[gv-web] zero users detected — generating setup code..."
  SETUP_CODE=$(node -e "console.log(require('crypto').randomBytes(8).toString('hex'))")
  echo "$SETUP_CODE" > "$SETUP_CODE_FILE"
  printf '\n╔══════════════════════════════════════════════╗\n'
  printf '║         Sprite Cloud — First Run             ║\n'
  printf '╠══════════════════════════════════════════════╣\n'
  SETUP_URL="${AUTH_URL:-${NEXTAUTH_URL:-}}"
  printf "║  Setup code: %-30s ║\n" "$SETUP_CODE"
  if [ -n "$SETUP_URL" ]; then
    printf "║  Visit %-33s ║\n" "${SETUP_URL%/}/setup"
  else
    printf '║  Visit /setup on your gateway URL        ║\n'
  fi
  printf '╚══════════════════════════════════════════════╝\n\n'
elif [ "$user_count" -gt 0 ] 2>/dev/null; then
  echo "[gv-web] users exist — cleaning stale setup code"
  rm -f "$SETUP_CODE_FILE"
fi

echo "[gv-web] starting production server..."
exec node /app/gv-web/server.js
