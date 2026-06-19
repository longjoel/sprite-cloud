#!/bin/sh
set -eu

echo "[gv-server] entrypoint starting..."

# Verify required binaries exist
for bin in /usr/local/bin/gv-server /usr/local/bin/gv-worker; do
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
if ! ldd /usr/local/bin/gv-worker >/dev/null 2>&1; then
  echo "[gv-server] WARNING: gv-worker has unmet library dependencies:"
  ldd /usr/local/bin/gv-worker || true
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
gv-server start
EXIT_CODE=$?

# Exit code 2 = auth failure (API key rejected, database recreated, etc.)
# Don't loop — the operator must re-pair before the server can work.
if [ "$EXIT_CODE" -eq 2 ]; then
  echo ""
  echo "==========================================="
  echo "  Server needs re-pairing."
  echo "  Run: gv-server pair <CODE>"
  echo "  Get a code from the gv-web Settings page."
  echo "  Container will stay up for inspection."
  echo "==========================================="
  echo ""
  # Sleep forever so the operator can docker exec in and re-pair
  while true; do sleep 3600; done
fi

exit "$EXIT_CODE"
