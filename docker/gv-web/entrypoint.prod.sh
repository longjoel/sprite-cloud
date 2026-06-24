#!/bin/sh
set -eu

cd /app/gv-web

if [ "${GV_WEB_SCHEMA_PUSH_ON_START:-0}" = "1" ]; then
  echo "[gv-web] pushing DB schema..."
  npx drizzle-kit push --force
else
  echo "[gv-web] skipping DB schema push; apply migrations explicitly before deploy"
fi

echo "[gv-web] starting production server..."
exec node /app/gv-web/server.js
