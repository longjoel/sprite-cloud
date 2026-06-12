#!/usr/bin/env bash
set -euo pipefail

# Compare local main and deployed prod commit marker.
#
# Prerequisites:
#   - SSH key-based authentication to the VPS target
#   - A secrets/env file with VPS_SSH_TARGET
#   - Default path: ./deploy.env (overridable via DEPLOY_SECRETS_FILE)

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SECRETS_FILE="${DEPLOY_SECRETS_FILE:-${REPO_DIR}/deploy.env}"

if [[ ! -f "$SECRETS_FILE" ]]; then
  echo "Missing secrets file: $SECRETS_FILE" >&2
  echo "Create it with VPS_SSH_TARGET variable." >&2
  exit 2
fi

# shellcheck disable=SC1090
set -a; source "$SECRETS_FILE"; set +a
: "${VPS_SSH_TARGET:?VPS_SSH_TARGET is required}"

cd "$REPO_DIR"
git fetch origin main >/dev/null
LOCAL_MAIN="$(git rev-parse origin/main)"
PROD_SHA="$(ssh -o StrictHostKeyChecking=no "$VPS_SSH_TARGET" 'cat /opt/games-vault/RELEASE_COMMIT 2>/dev/null || true')"

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
