#!/bin/sh
set -eu

echo "[gv-web] pushing DB schema..."
cd /app/gv-web
npx drizzle-kit push

echo "[gv-web] starting Next.js dev server..."
exec npx next dev -p 3000
