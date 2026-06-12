#!/usr/bin/env bash
set -euo pipefail

# Deploy Games Vault to production VPS from local main branch in a repeatable way.
#
# Prerequisites:
#   - SSH key-based authentication to the VPS target (user@host)
#   - A secrets/env file with VPS_SSH_TARGET and DEPLOY_BASE_URL
#   - Default path: ./deploy.env (overridable via DEPLOY_SECRETS_FILE variable)
#
# Usage:
#   DEPLOY_SECRETS_FILE=/path/to/secrets.env ./scripts/deploy-prod-from-main.sh

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SECRETS_FILE="${DEPLOY_SECRETS_FILE:-${REPO_DIR}/deploy.env}"
PUBLISH_DIR=""

cleanup() {
  if [[ -n "$PUBLISH_DIR" && -d "$PUBLISH_DIR" ]]; then
    rm -rf "$PUBLISH_DIR"
  fi
}
trap cleanup EXIT

if [[ ! -f "$SECRETS_FILE" ]]; then
  echo "Missing secrets file: $SECRETS_FILE" >&2
  echo "Create it with VPS_SSH_TARGET and DEPLOY_BASE_URL variables." >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a; source "$SECRETS_FILE"; set +a
: "${VPS_SSH_TARGET:?VPS_SSH_TARGET is required (e.g., user@vps.example.com)}"
: "${DEPLOY_BASE_URL:?DEPLOY_BASE_URL is required (e.g., https://example.com/path-base)}"

SSH_OPTS="-o StrictHostKeyChecking=no"

cd "$REPO_DIR"

CURRENT_BRANCH="$(git branch --show-current)"
if [[ "$CURRENT_BRANCH" != "main" ]]; then
  echo "ERROR: must run from main (current: $CURRENT_BRANCH)" >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "ERROR: working tree is dirty; commit or stash first" >&2
  git status --short
  exit 1
fi

echo "==> Fetching and fast-forwarding main"
git fetch origin main
git pull --ff-only origin main
HEAD_SHA="$(git rev-parse HEAD)"
ORIGIN_SHA="$(git rev-parse origin/main)"
if [[ "$HEAD_SHA" != "$ORIGIN_SHA" ]]; then
  echo "ERROR: local main ($HEAD_SHA) does not match origin/main ($ORIGIN_SHA)" >&2
  echo "Push or reset local commits before prod deploy." >&2
  exit 1
fi

echo "==> Deploying commit $HEAD_SHA"

echo "==> tracked binary audit"
python3 scripts/audit-tracked-binaries.py

echo "==> dotnet test"
dotnet test --configuration Release

echo "==> JS syntax check (node -c)"
while IFS= read -r js; do
  if ! node -c "$js" 2>&1; then
    echo "ERROR: JS syntax error in $js" >&2
    exit 1
  fi
done < <(find wwwroot -name '*.js' -type f 2>/dev/null)
echo "  all JS files pass syntax check"

PUBLISH_DIR="$(mktemp -d /var/tmp/games-vault-main-publish.XXXXXX)"
echo "==> Build + publish to $PUBLISH_DIR"
dotnet publish games-vault.csproj -c Release -r linux-x64 --self-contained true -o "$PUBLISH_DIR"

echo "==> Backup prod DB"
TS="$(date +%Y%m%d-%H%M%S)"
ssh $SSH_OPTS "$VPS_SSH_TARGET" \
  "sudo cp /var/lib/games-vault/games-vault.db /var/lib/games-vault/games-vault.db.bak-$TS"

echo "==> Rsync publish output"
rsync -az --delete --partial \
  --exclude 'App_Data/' \
  --exclude 'wwwroot/webplayer/' \
  -e "ssh $SSH_OPTS" \
  "$PUBLISH_DIR/" "$VPS_SSH_TARGET:/opt/games-vault/"

echo "==> Ensure runtime dirs + marker + restart"
ssh $SSH_OPTS "$VPS_SSH_TARGET" \
  "sudo mkdir -p /opt/games-vault/App_Data /opt/games-vault/wwwroot /var/lib/games-vault /srv/storage/games-vault && \
   echo '$HEAD_SHA' | sudo tee /opt/games-vault/RELEASE_COMMIT >/dev/null && \
   sudo chown -R games-vault:games-vault /opt/games-vault /var/lib/games-vault /srv/storage/games-vault && \
   sudo systemctl reset-failed games-vault 2>/dev/null; sudo systemctl restart games-vault && sleep 4 && systemctl is-active games-vault"

echo "==> Verify prod endpoints"
curl -fsS "${DEPLOY_BASE_URL}/" >/dev/null
curl -fsS "${DEPLOY_BASE_URL}/Arcade" >/dev/null

echo "DONE: prod deployed at commit $HEAD_SHA"
