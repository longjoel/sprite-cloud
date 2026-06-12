#!/usr/bin/env bash
set -euo pipefail

# Compare local main and deployed prod commit marker.
#
# Prerequisites:
#   - A secrets/env file with VPS_SSH_TARGET and VPS_SSH_PASSWORD
#   - Default path: ./deploy.env (overridable via DEPLOY_SECRETS_FILE)

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SECRETS_FILE="${DEPLOY_SECRETS_FILE:-${REPO_DIR}/deploy.env}"

# shellcheck disable=SC1090
set -a; source "$SECRETS_FILE"; set +a
: "${VPS_SSH_TARGET:?VPS_SSH_TARGET is required}"
: "${VPS_SSH_PASSWORD:?VPS_SSH_PASSWORD is required}"

cd "$REPO_DIR"
git fetch origin main >/dev/null
LOCAL_MAIN="$(git rev-parse origin/main)"
PROD_SHA="$(sshpass -p "$VPS_SSH_PASSWORD" ssh -o StrictHostKeyChecking=no "$VPS_SSH_TARGET" 'cat /opt/games-vault/RELEASE_COMMIT 2>/dev/null || true')"

if [[ -z "$PROD_SHA" ]]; then
  echo "WARN: /opt/games-vault/RELEASE_COMMIT not found on prod"
  exit 2
fi

echo "origin/main: $LOCAL_MAIN"
echo "prod release: $PROD_SHA"

if [[ "$LOCAL_MAIN" == "$PROD_SHA" ]]; then
  echo "SYNC: prod matches origin/main"
  exit 0
fi

echo "DRIFT: prod != origin/main"
exit 1
