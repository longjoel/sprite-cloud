#!/usr/bin/env bash
set -euo pipefail

# Deploy Games Vault to prod VPS from local main branch in a repeatable way.
# Requires: /root/.hermes/secrets/vps-72.62.243.69.env with VPS_SSH_TARGET + VPS_SSH_PASSWORD

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PUBLISH_DIR="/tmp/games-vault-main-publish"
SECRETS_FILE="/root/.hermes/secrets/vps-72.62.243.69.env"

if [[ ! -f "$SECRETS_FILE" ]]; then
  echo "Missing secrets file: $SECRETS_FILE" >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a; source "$SECRETS_FILE"; set +a
: "${VPS_SSH_TARGET:?VPS_SSH_TARGET is required}"
: "${VPS_SSH_PASSWORD:?VPS_SSH_PASSWORD is required}"

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
echo "==> Deploying commit $HEAD_SHA"

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

echo "==> Build + publish"
dotnet publish games-vault.csproj -c Release -r linux-x64 --self-contained true -o "$PUBLISH_DIR"

echo "==> Backup prod DB"
TS="$(date +%Y%m%d-%H%M%S)"
sshpass -p "$VPS_SSH_PASSWORD" ssh -o StrictHostKeyChecking=no "$VPS_SSH_TARGET" \
  "sudo cp /var/lib/games-vault/games-vault.db /var/lib/games-vault/games-vault.db.bak-$TS"

echo "==> Rsync publish output"
rsync -az --delete --partial \
  --exclude 'App_Data/' \
  -e "sshpass -p '$VPS_SSH_PASSWORD' ssh -o StrictHostKeyChecking=no" \
  "$PUBLISH_DIR/" "$VPS_SSH_TARGET:/opt/games-vault/"

echo "==> Ensure runtime dirs + marker + restart"
sshpass -p "$VPS_SSH_PASSWORD" ssh -o StrictHostKeyChecking=no "$VPS_SSH_TARGET" \
  "sudo mkdir -p /opt/games-vault/App_Data /opt/games-vault/wwwroot /var/lib/games-vault /srv/storage/games-vault && \
   echo '$HEAD_SHA' | sudo tee /opt/games-vault/RELEASE_COMMIT >/dev/null && \
   sudo chown -R games-vault:games-vault /opt/games-vault /var/lib/games-vault /srv/storage/games-vault && \
   sudo systemctl reset-failed games-vault 2>/dev/null; sudo systemctl restart games-vault && sleep 4 && systemctl is-active games-vault"

echo "==> Verify prod endpoints"
curl -fsS "https://lngnckr.tech/a45ee611-d6ae-41dd-b3ba-37712a2b954d/" >/dev/null
curl -fsS "https://lngnckr.tech/a45ee611-d6ae-41dd-b3ba-37712a2b954d/Arcade" >/dev/null

echo "DONE: prod deployed at commit $HEAD_SHA"