#!/bin/sh
set -eu

echo "[gv-web] pushing DB schema..."
cd /app/gv-web
npx drizzle-kit push --force

echo "[gv-web] starting production server..."
exec node /app/gv-web/server.js
