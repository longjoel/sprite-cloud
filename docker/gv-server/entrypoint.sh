#!/bin/sh
set -eu

echo "[gv-server] entrypoint starting..."

# Verify required files exist
for bin in /usr/local/bin/gv-server /usr/local/bin/gv-worker-v2; do
  if [ ! -f "$bin" ]; then
    echo "[gv-server] ERROR: $bin not found — build host binaries first (./scripts/dev-start.sh build)"
    exit 1
  fi
  if [ ! -x "$bin" ]; then
    echo "[gv-server] ERROR: $bin is not executable"
    exit 1
  fi
done

# Verify shared libs are available (fail early)
if ! ldd /usr/local/bin/gv-worker-v2 >/dev/null 2>&1; then
  echo "[gv-server] WARNING: gv-worker-v2 has unmet library dependencies:"
  ldd /usr/local/bin/gv-worker-v2 || true
fi

# Verify GV_API_KEY is set
if [ -z "${GV_API_KEY:-}" ]; then
  echo "[gv-server] ERROR: GV_API_KEY not set — run ./scripts/dev-start.sh pair first"
  exit 1
fi

# Wait for gv-web to be healthy
echo "[gv-server] waiting for gv-web..."
until curl -sf http://localhost:3000/api/health >/dev/null 2>&1; do
  sleep 1
done
echo "[gv-server] gv-web is healthy"

# Ensure core + save directories exist
mkdir -p /cores /saves /system

echo "[gv-server] starting..."
exec gv-server start
