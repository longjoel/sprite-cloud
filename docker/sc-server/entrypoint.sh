#!/bin/sh
set -eu

echo "[sc-server] entrypoint starting..."

# Verify required binary exists
bin=/usr/local/bin/sc-server
if [ ! -f "$bin" ]; then
  echo "[sc-server] ERROR: $bin not found — build host binary first (./scripts/dev-start.sh build)"
  exit 1
fi
if [ ! -x "$bin" ]; then
  echo "[sc-server] ERROR: $bin is not executable"
  exit 1
fi

# Verify shared libs are available (fail early)
if ! ldd /usr/local/bin/sc-server >/dev/null 2>&1; then
  echo "[sc-server] WARNING: sc-server has unmet library dependencies:"
  ldd /usr/local/bin/sc-server || true
fi

# ── One-liner pairing mode ───────────────────────────────────────────
# If GV_PAIR_CODE and GV_WEB_URL are set, auto-pair before starting.
# This lets users run a single `docker run` command without pre-creating config.
if [ -n "${GV_PAIR_CODE:-}" ] && [ -n "${GV_WEB_URL:-}" ]; then
  echo "[sc-server] auto-pairing with code $GV_PAIR_CODE → $GV_WEB_URL"
  sc-server pair "$GV_PAIR_CODE" --sc-web-url "$GV_WEB_URL"
fi

# ── Wait for sc-web ─────────────────────────────────────────────────
if [ "${GV_SKIP_WEB_WAIT:-0}" != "1" ]; then
  echo "[sc-server] waiting for sc-web..."
  until curl -sf http://localhost:3000/api/health >/dev/null 2>&1; do
    sleep 1
  done
  echo "[sc-server] sc-web is healthy"
fi

# Ensure core + save directories exist
mkdir -p /cores /saves /system

echo "[sc-server] starting..."
sc-server start
EXIT_CODE=$?

# Exit code 2 = auth failure (API key rejected, database recreated, etc.)
# Don't loop — the operator must re-pair before the server can work.
if [ "$EXIT_CODE" -eq 2 ]; then
  echo ""
  echo "==========================================="
  echo "  Server needs re-pairing."
  echo "  Run: sc-server pair <CODE>"
  echo "  Get a code from the sc-web Settings page."
  echo "  Container will stay up for inspection."
  echo "==========================================="
  echo ""
  # Sleep forever so the operator can docker exec in and re-pair
  while true; do sleep 3600; done
fi

exit "$EXIT_CODE"
