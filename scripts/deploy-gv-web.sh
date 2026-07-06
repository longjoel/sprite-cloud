#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WEB_DIR="$PROJECT_DIR/gv-web"

VPS_HOST="${GV_VPS_HOST:-lngnckr.tech}"
VPS_USER="${GV_VPS_USER:-root}"
VPS_REPO_DIR="${GV_VPS_REPO_DIR:-/root/gv-source}"
VPS_ENV_FILE="${GV_VPS_ENV_FILE:-/root/games-vault/.env}"
GV_WEB_URL="${GV_WEB_URL:-https://lngnckr.tech}"
GV_WEB_PUBLIC_ORIGIN="${GV_WEB_PUBLIC_ORIGIN:-$GV_WEB_URL}"
CONTAINER="${GV_WEB_CONTAINER:-gv-web-gv-web-1}"
IMAGE="${GV_WEB_IMAGE:-gv-web-prod:latest}"

log()  { printf '[deploy-gv-web] %s\n' "$*"; }
fail() { printf '[deploy-gv-web][error] %s\n' "$*" >&2; exit 1; }
require_cmd() { command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"; }

ALLOW_DIRTY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --allow-dirty) ALLOW_DIRTY=1; shift ;;
    *) fail "unknown flag: $1" ;;
  esac
done

require_cmd git
require_cmd ssh
require_cmd rsync
require_cmd curl
require_cmd pnpm
require_cmd python3

cd "$PROJECT_DIR"
GV_SHA="$(git rev-parse HEAD)"
GV_SHORT_SHA="${GV_SHA:0:7}"
GV_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
GV_BUILT_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

if [[ "$ALLOW_DIRTY" -eq 0 ]]; then
  git diff --quiet || fail 'working tree is dirty — commit changes or use --allow-dirty'
  git diff --cached --quiet || fail 'staged changes present — commit changes or use --allow-dirty'
  [ -z "$(git ls-files -o --exclude-standard)" ] || fail 'untracked files present — clean up or use --allow-dirty'
fi

log "building gv-web locally"
(
  cd "$WEB_DIR"
  pnpm run lint
  pnpm run build
)

log "syncing monorepo to $VPS_USER@$VPS_HOST:$VPS_REPO_DIR"
rsync -az --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude '.next' \
  --exclude 'target' \
  "$PROJECT_DIR/" "$VPS_USER@$VPS_HOST:$VPS_REPO_DIR/"

log "building $IMAGE on VPS"
ssh "$VPS_USER@$VPS_HOST" "cd '$VPS_REPO_DIR' && docker build -f docker/gv-web/Dockerfile.prod -t '$IMAGE' --build-arg GV_WEB_GIT_SHA='$GV_SHORT_SHA' --build-arg GV_WEB_GIT_BRANCH='$GV_BRANCH' --build-arg GV_WEB_RELEASED_AT_UTC='$GV_BUILT_AT' ."

log "restarting production container via VPS helper"
ssh "$VPS_USER@$VPS_HOST" "cd '$VPS_REPO_DIR' && GV_WEB_ENV_FILE='$VPS_ENV_FILE' GV_WEB_CONTAINER='$CONTAINER' GV_WEB_IMAGE='$IMAGE' GV_WEB_PUBLIC_ORIGIN='$GV_WEB_PUBLIC_ORIGIN' bash ./deploy-gv-web.sh"

log "verifying public health"
HEALTH_JSON="$(curl -fsS "$GV_WEB_URL/api/health")"
STATUS="$(printf '%s' "$HEALTH_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin).get('status',''))")"
DEPLOYED_SHA="$(printf '%s' "$HEALTH_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)['versions']['web'].get('git_sha',''))")"
[ "$STATUS" = "ok" ] || fail "public health status is $STATUS"
[ "$DEPLOYED_SHA" = "$GV_SHORT_SHA" ] || fail "deployed sha mismatch: expected $GV_SHORT_SHA got $DEPLOYED_SHA"

log "verifying public routes"
curl -fsSI "$GV_WEB_URL/" >/dev/null
curl -fsSI "$GV_WEB_URL/watch" >/dev/null

log "deploy complete ($GV_SHORT_SHA)"
log "health: $GV_WEB_URL/api/health"
