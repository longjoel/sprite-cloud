#!/usr/bin/env bash
# deploy.sh — Build gv-web-prod image and deploy to VPS
#
# Usage:
#   ./scripts/deploy.sh              # build + deploy
#   ./scripts/deploy.sh --build-only  # just build the image locally
#
# Requirements:
#   - SSH key authorized on VPS (ssh lngnckr.tech must work)
#   - Docker running on VPS
#
set -euo pipefail

VPS_HOST="${VPS_HOST:-lngnckr.tech}"
VPS_USER="${VPS_USER:-root}"
IMAGE="gv-web-prod:latest"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

echo "=== Building $IMAGE ==="
docker build -f docker/gv-web/Dockerfile.prod -t "$IMAGE" .

if [ "${1:-}" = "--build-only" ]; then
    echo "=== Build complete (--build-only) ==="
    exit 0
fi

echo "=== Transferring image to $VPS_HOST ==="
docker save "$IMAGE" | ssh "$VPS_USER@$VPS_HOST" docker load

echo "=== Restarting gv-web on VPS ==="
ssh "$VPS_USER@$VPS_HOST" '
    cd /docker/gv-web && \
    docker compose down gv-web && \
    docker compose up -d gv-web && \
    echo "Waiting for health check..." && \
    sleep 5 && \
    docker compose ps
'

echo "=== Deploy complete ==="
echo "Verify: curl -s https://$VPS_HOST/api/health"
