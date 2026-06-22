#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/release-common.sh
source "$SCRIPT_DIR/release-common.sh"

require_cmd docker
require_cmd ssh
require_cmd curl

SKIP_BUILD=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-build) SKIP_BUILD=1; shift ;;
    *) fail "unknown flag: $1" ;;
  esac
done

VPS_HOST="${VPS_HOST:-lngnckr.tech}"
VPS_USER="${VPS_USER:-root}"
VPS_APP_DIR="${GV_VPS_APP_DIR:-/docker/gv-web}"
SERVICE_NAME="${GV_VPS_SERVICE:-gv-web}"
PUBLIC_HEALTH_URL="${GV_PUBLIC_HEALTH_URL:-https://lngnckr.tech/api/health}"
IMAGE_SHA_TAG="gv-web-prod:${GV_SHORT_SHA}"
IMAGE_LATEST_TAG="gv-web-prod:latest"
WEB_PACKAGE_VERSION="$(python3 - <<'PY'
import json
with open('gv-web/package.json', 'r', encoding='utf-8') as f:
    print(json.load(f)['version'])
PY
)"

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  "$SCRIPT_DIR/build-release.sh"
fi

cd "$PROJECT_DIR"
log "building $IMAGE_SHA_TAG and $IMAGE_LATEST_TAG"
docker build -f docker/gv-web/Dockerfile.prod \
  --build-arg GV_WEB_GIT_SHA="$GV_SHA" \
  --build-arg GV_WEB_VERSION="$WEB_PACKAGE_VERSION" \
  --build-arg GV_WEB_RELEASED_AT_UTC="$GV_BUILT_AT" \
  -t "$IMAGE_SHA_TAG" -t "$IMAGE_LATEST_TAG" .

log "shipping image to $VPS_USER@$VPS_HOST"
docker save "$IMAGE_SHA_TAG" "$IMAGE_LATEST_TAG" | ssh "$VPS_USER@$VPS_HOST" docker load

REMOTE_SCRIPT=$(cat <<'EOS'
set -euo pipefail
APP_DIR="$1"
SERVICE_NAME="$2"
SHA="$3"
RELEASED_AT="$4"
cd "$APP_DIR"
printf '%s\n' "$SHA" > RELEASE_COMMIT
python3 - <<'PY' "$SHA" "$RELEASED_AT" "$APP_DIR/RELEASE_MANIFEST.json"
import json, sys
sha, released_at, path = sys.argv[1:4]
with open(path, 'w', encoding='utf-8') as f:
    json.dump({'git_sha': sha, 'released_at_utc': released_at}, f, indent=2)
    f.write('\n')
PY
docker compose up -d "$SERVICE_NAME"
docker compose ps "$SERVICE_NAME"
EOS
)
ssh "$VPS_USER@$VPS_HOST" bash -s -- "$VPS_APP_DIR" "$SERVICE_NAME" "$GV_SHA" "$GV_BUILT_AT" <<< "$REMOTE_SCRIPT"

for attempt in $(seq 1 30); do
  if curl -fsS "$PUBLIC_HEALTH_URL" >/dev/null 2>&1; then
    log "public health OK: $PUBLIC_HEALTH_URL"
    log "vps deploy complete at $GV_SHA"
    exit 0
  fi
  sleep 2
done

fail "public health never became ready: $PUBLIC_HEALTH_URL"
