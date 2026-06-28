#!/usr/bin/env bash
set -euo pipefail

# ── deploy-gv-web.sh ────────────────────────────────────────────────────
# Blessed one-command deploy for gv-web to the VPS Docker container.
#
# Usage:
#   scripts/deploy-gv-web.sh              # build + deploy (requires clean tree)
#   scripts/deploy-gv-web.sh --allow-dirty # deploy even with uncommitted changes
#
# What it does:
#   1. Verifies git tree is clean (unless --allow-dirty)
#   2. Runs `npm run build` in gv-web/
#   3. Packs standalone + static + public into a tar stream
#   4. Extracts into the running gv-web container on the VPS
#   5. Stamps the git SHA into a runtime-version.json file
#   6. Restarts the container
#   7. Verifies /api/health responds and reports the deployed SHA
# ────────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WEB_DIR="$PROJECT_DIR/gv-web"

VPS_HOST="${GV_VPS_HOST:?set GV_VPS_HOST to your gateway host}"
VPS_USER="${GV_VPS_USER:-root}"
CONTAINER="${GV_WEB_CONTAINER:-gv-web-gv-web-1}"
APP_DIR="${GV_WEB_APP_DIR:-/app/gv-web}"
HEALTH_URL="${GV_WEB_HEALTH_URL:-${GV_WEB_URL:?set GV_WEB_URL or GV_WEB_HEALTH_URL}/api/health}"

# ── helpers ────────────────────────────────────────────────────────────

log()  { printf '[deploy-gv-web] %s\n' "$*"; }
warn() { printf '[deploy-gv-web][warn] %s\n' "$*" >&2; }
fail() { printf '[deploy-gv-web][error] %s\n' "$*" >&2; exit 1; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

# ── flags ──────────────────────────────────────────────────────────────

ALLOW_DIRTY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --allow-dirty) ALLOW_DIRTY=1; shift ;;
    *) fail "unknown flag: $1" ;;
  esac
done

# ── prerequisites ──────────────────────────────────────────────────────

require_cmd git
require_cmd ssh
require_cmd curl

cd "$PROJECT_DIR"

GV_SHA="$(git rev-parse HEAD)"
GV_SHORT_SHA="${GV_SHA:0:7}"
GV_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
GV_BUILT_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

log "deploying gv-web"
log "  sha:      $GV_SHORT_SHA"
log "  branch:   $GV_BRANCH"
log "  built_at: $GV_BUILT_AT"

# ── check git cleanliness ──────────────────────────────────────────────

if [[ "$ALLOW_DIRTY" -eq 0 ]]; then
  if ! git diff --quiet || ! git diff --cached --quiet; then
    fail "working tree is dirty — commit/stash changes or use --allow-dirty"
  fi
  if [ -n "$(git ls-files -o --exclude-standard gv-web/)" ]; then
    fail "untracked files in gv-web/ — clean up or use --allow-dirty"
  fi
fi

# ── build ──────────────────────────────────────────────────────────────

log "building gv-web..."
cd "$WEB_DIR"
npm run build

# Stamp the runtime version file that the health endpoint reads.
RUNTIME_VERSION_FILE="$WEB_DIR/.next/runtime-version.json"
python3 - <<PY "$GV_SHA" "$GV_SHORT_SHA" "$GV_BRANCH" "$GV_BUILT_AT" "$RUNTIME_VERSION_FILE"
import json, sys
sha, short_sha, branch, built_at, path = sys.argv[1:6]
payload = {
    "git_sha": sha,
    "git_short_sha": short_sha,
    "git_branch": branch,
    "built_at_utc": built_at,
    "package_version": "0.1.0",
}
with open(path, "w", encoding="utf-8") as f:
    json.dump(payload, f, indent=2)
    f.write("\n")
PY

cd "$PROJECT_DIR"

# ── pack the deploy payload ────────────────────────────────────────────
# The container runs from /app/gv-web/. We pack:
#   .next/standalone/gv-web/*  → /app/gv-web/   (the runtime root)
#   .next/static/               → /app/gv-web/.next/static/
#   .next/runtime-version.json  → /app/gv-web/.next/runtime-version.json
#   public/player/              → /app/gv-web/public/player/

log "packing deploy payload..."

TMP_TAR="$(mktemp /tmp/gv-web-deploy.XXXXXX.tar.gz)"
trap 'rm -f "$TMP_TAR"' EXIT

# Tar the payload. We use --transform to strip the standalone parent dir.
tar czf "$TMP_TAR" \
  -C "$WEB_DIR/.next/standalone/gv-web" . \
  -C "$WEB_DIR/.next" static \
  -C "$WEB_DIR/.next" runtime-version.json \
  -C "$WEB_DIR" public/player 2>/dev/null || true

# Also include package.json for version info
tar czf "$TMP_TAR" \
  -C "$WEB_DIR/.next/standalone/gv-web" . \
  -C "$WEB_DIR/.next" static \
  -C "$WEB_DIR/.next" runtime-version.json \
  -C "$WEB_DIR" public/player \
  -C "$WEB_DIR" package.json

log "payload size: $(du -h "$TMP_TAR" | cut -f1)"

# ── ship to VPS ────────────────────────────────────────────────────────

log "shipping to $VPS_USER@$VPS_HOST ..."

# Clean .next from the container to prevent stale routes
ssh "$VPS_USER@$VPS_HOST" "docker exec $CONTAINER rm -rf $APP_DIR/.next && docker exec $CONTAINER mkdir -p $APP_DIR/.next"

# Extract into the container
cat "$TMP_TAR" | ssh "$VPS_USER@$VPS_HOST" "docker exec -i $CONTAINER tar xzf - -C $APP_DIR/"

# Fix tar prefix: -C "$WEB_DIR/.next" static puts static/ at root, but Next.js
# standalone expects .next/static/. Move it into place.
ssh "$VPS_USER@$VPS_HOST" "docker exec $CONTAINER sh -c '
  if [ -d $APP_DIR/static ] && [ ! -d $APP_DIR/.next/static ]; then
    mv $APP_DIR/static $APP_DIR/.next/static
  fi
  if [ -f $APP_DIR/runtime-version.json ] && [ ! -f $APP_DIR/.next/runtime-version.json ]; then
    mv $APP_DIR/runtime-version.json $APP_DIR/.next/runtime-version.json
  fi
'"

log "payload extracted into $CONTAINER:$APP_DIR/"

# ── restart ────────────────────────────────────────────────────────────

log "restarting $CONTAINER ..."
ssh "$VPS_USER@$VPS_HOST" "docker restart $CONTAINER"

# ── verify health ──────────────────────────────────────────────────────

log "waiting for healthy response..."
for attempt in $(seq 1 30); do
  if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

# Check the deployed SHA matches
HEALTH_JSON="$(curl -fsS "$HEALTH_URL")"
DEPLOYED_SHA="$(echo "$HEALTH_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin).get('versions',{}).get('web',{}).get('git_sha',''))" 2>/dev/null || echo "")"

if [[ -z "$DEPLOYED_SHA" ]]; then
  warn "could not read deployed SHA from health endpoint"
elif [[ "$DEPLOYED_SHA" == "$GV_SHA" ]]; then
  log "version verified: deployed SHA matches ($GV_SHORT_SHA)"
else
  warn "version mismatch: local=$GV_SHORT_SHA deployed=$DEPLOYED_SHA"
fi

log "deploy complete ($GV_SHORT_SHA)"
log "health: $HEALTH_URL"
