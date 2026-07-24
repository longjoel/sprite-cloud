#!/bin/sh
set -eu

cd /app/sc-web

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
  npx drizzle-kit push --force
else
  echo "[sc-web] skipping DB schema push; apply migrations explicitly before startup"
fi

echo "[sc-web] starting Next.js dev server..."
exec npx next dev -p 3000
