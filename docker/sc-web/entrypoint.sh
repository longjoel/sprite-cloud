#!/bin/sh
set -eu

echo "[sc-web] pushing DB schema..."
cd /app/sc-web
npx drizzle-kit push --force

echo "[sc-web] starting Next.js dev server..."
exec npx next dev -p 3000
