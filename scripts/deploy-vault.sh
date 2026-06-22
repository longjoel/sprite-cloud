#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/release-common.sh
source "$SCRIPT_DIR/release-common.sh"

require_cmd install
require_cmd python3
require_cmd systemctl

SKIP_BUILD=0
NO_RESTART=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-build) SKIP_BUILD=1; shift ;;
    --no-restart) NO_RESTART=1; shift ;;
    *) fail "unknown flag: $1" ;;
  esac
done

BIN_DIR="${GV_VAULT_BIN_DIR:-/usr/local/bin}"
RELEASE_STATE_DIR="${GV_VAULT_STATE_DIR:-/var/lib/games-vault}"
SERVICE_NAME="${GV_VAULT_SERVICE:-gv-server.service}"
WEB_HEALTH_URL="${GV_LOCAL_HEALTH_URL:-http://localhost:3000/api/health}"

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  "$SCRIPT_DIR/build-release.sh"
fi

cd "$PROJECT_DIR"
log "installing release binaries into $BIN_DIR"
sudo install -m 755 target/release/gv-server "$BIN_DIR/gv-server"
sudo install -m 755 target/release/gv-worker "$BIN_DIR/gv-worker"
sudo mkdir -p "$RELEASE_STATE_DIR"
printf '%s\n' "$GV_SHA" | sudo tee "$RELEASE_STATE_DIR/RELEASE_COMMIT" >/dev/null
sudo cp "$(manifest_path)" "$RELEASE_STATE_DIR/RELEASE_MANIFEST.json"

if [[ "$NO_RESTART" -eq 0 ]]; then
  log "restarting $SERVICE_NAME"
  sudo systemctl restart "$SERVICE_NAME"
  sudo systemctl is-active --quiet "$SERVICE_NAME" || fail "$SERVICE_NAME failed to restart"
fi

log "running worker smoke test"
SMOKE_OUTPUT="$(sudo -u games-vault env GV_BIND_ADDR=127.0.0.1 timeout 8 "$BIN_DIR/gv-worker" 0 2>&1 || true)"
printf '%s\n' "$SMOKE_OUTPUT" | grep -q 'WORKER_READY' || fail "worker smoke test failed: $SMOKE_OUTPUT"

if curl -fsS "$WEB_HEALTH_URL" >/dev/null 2>&1; then
  log "local web health OK: $WEB_HEALTH_URL"
else
  warn "local web health failed: $WEB_HEALTH_URL"
fi

log "vault deploy complete at $GV_SHA"
