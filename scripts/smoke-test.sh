#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/release-common.sh
source "$SCRIPT_DIR/release-common.sh"

require_cmd curl

CHECK_LOCAL=1
CHECK_REMOTE=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --local-only) CHECK_REMOTE=0; shift ;;
    --remote-only) CHECK_LOCAL=0; shift ;;
    *) fail "unknown flag: $1" ;;
  esac
done

LOCAL_HEALTH_URL="${GV_LOCAL_HEALTH_URL:-http://localhost:3000/api/health}"
LOCAL_RELEASE_FILE="${GV_LOCAL_RELEASE_FILE:-/var/lib/sprite-cloud/RELEASE_COMMIT}"
REMOTE_RELEASE_FILE="${GV_REMOTE_RELEASE_FILE:-/docker/gv-web/RELEASE_COMMIT}"
PUBLIC_HEALTH_URL="${GV_PUBLIC_HEALTH_URL:-${GV_WEB_URL:+${GV_WEB_URL%/}/api/health}}"
VPS_HOST="${VPS_HOST:-${GV_VPS_HOST:-}}"
VPS_USER="${VPS_USER:-root}"

if [[ "$CHECK_LOCAL" -eq 1 ]]; then
  log "checking local release markers"
  if [[ -f "$LOCAL_RELEASE_FILE" ]]; then
    LOCAL_SHA="$(cat "$LOCAL_RELEASE_FILE")"
    log "local RELEASE_COMMIT=$LOCAL_SHA"
  else
    warn "missing local release file: $LOCAL_RELEASE_FILE"
  fi
  if systemctl is-active --quiet gv-server.service; then
    log "gv-server.service active"
  else
    fail "gv-server.service is not active"
  fi
  if curl -fsS "$LOCAL_HEALTH_URL" >/dev/null 2>&1; then
    log "local web health OK: $LOCAL_HEALTH_URL"
  else
    warn "local web health unreachable: $LOCAL_HEALTH_URL (expected when gv-web only runs on the VPS)"
  fi
fi

if [[ "$CHECK_REMOTE" -eq 1 ]]; then
  [[ -n "$VPS_HOST" ]] || fail "set VPS_HOST or GV_VPS_HOST for remote smoke test"
  [[ -n "$PUBLIC_HEALTH_URL" ]] || fail "set GV_WEB_URL or GV_PUBLIC_HEALTH_URL for remote smoke test"
  log "checking remote release markers"
  REMOTE_SHA="$(ssh "$VPS_USER@$VPS_HOST" "cat '$REMOTE_RELEASE_FILE'")"
  log "remote RELEASE_COMMIT=$REMOTE_SHA"
  curl -fsS "$PUBLIC_HEALTH_URL" >/dev/null
  log "public health OK: $PUBLIC_HEALTH_URL"
fi

log "smoke test complete"
