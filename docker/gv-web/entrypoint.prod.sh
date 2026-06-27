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
# If the users table is empty and no legacy env vars, generate a one-time
# setup code so the deployer can create the first admin account via /setup.

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
  echo "[gv-web] zero users detected — checking legacy env vars..."

  if [ -n "${LAN_USER:-}" ] && { [ -n "${LAN_PASS_HASH:-}" ] || [ -n "${LAN_PASS:-}" ]; }; then
    echo "[gv-web] bootstrapping from LAN_USER env var..."
    node -e "
      const postgres = require('postgres');
      const bcrypt = require('bcryptjs');
      const sql = postgres(process.env.DATABASE_URL, { max: 1 });
      (async () => {
        const hash = process.env.LAN_PASS_HASH || await bcrypt.hash(process.env.LAN_PASS || 'admin', 10);
        await sql\`INSERT INTO users (email, name, password_hash) VALUES (\${process.env.LAN_USER + '@vault.local'}, \${process.env.LAN_USER}, \${hash})\`;
        console.log('bootstrapped ' + process.env.LAN_USER);
        await sql.end();
      })().catch(e => { console.error(e); sql.end(); process.exit(1); });
    "
  else
    echo "[gv-web] no legacy env vars — generating setup code..."
    SETUP_CODE=$(node -e "console.log(require('crypto').randomBytes(8).toString('hex'))")
    echo "$SETUP_CODE" > "$SETUP_CODE_FILE"
    printf '\n╔══════════════════════════════════════════════╗\n'
    printf '║         Games Vault — First Run             ║\n'
    printf '╠══════════════════════════════════════════════╣\n'
    SETUP_URL="${AUTH_URL:-${NEXTAUTH_URL:-}}"
    printf "║  Setup code: %-30s ║\n" "$SETUP_CODE"
    if [ -n "$SETUP_URL" ]; then
      printf "║  Visit %-33s ║\n" "${SETUP_URL%/}/setup"
    else
      printf '║  Visit /setup on your gateway URL        ║\n'
    fi
    printf '╚══════════════════════════════════════════════╝\n\n'
  fi
elif [ "$user_count" -gt 0 ] 2>/dev/null; then
  echo "[gv-web] users exist — cleaning stale setup code"
  rm -f "$SETUP_CODE_FILE"
fi

echo "[gv-web] starting production server..."
exec node /app/gv-web/server.js
