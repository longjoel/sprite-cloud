#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/release-common.sh
source "$SCRIPT_DIR/release-common.sh"

require_cmd git

DEPLOY_FIRST=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --deploy-first) DEPLOY_FIRST=1; shift ;;
    *) fail "unknown flag: $1" ;;
  esac
done

require_clean_tree

if [[ "$DEPLOY_FIRST" -eq 1 ]]; then
  "$SCRIPT_DIR/build-release.sh"
  "$SCRIPT_DIR/deploy-vault.sh" --skip-build
  "$SCRIPT_DIR/deploy-vps-web.sh" --skip-build
  "$SCRIPT_DIR/smoke-test.sh"
fi

cd "$PROJECT_DIR"
CURRENT_BRANCH="$(git branch --show-current)"
CURRENT_SHA="$(git rev-parse HEAD)"

git fetch origin main
REMOTE_MAIN_SHA="$(git rev-parse origin/main)"

if ! git merge-base --is-ancestor "$REMOTE_MAIN_SHA" "$CURRENT_SHA"; then
  fail "current HEAD does not fast-forward origin/main — rebase or recover manually"
fi

TAG="known-good-$(date -u +%F)-${CURRENT_SHA:0:7}"

if [[ "$CURRENT_BRANCH" != "main" ]]; then
  git checkout main
  git merge --ff-only "$CURRENT_SHA"
fi

git push origin main
git tag -f "$TAG" "$CURRENT_SHA"
git push -f origin "$TAG"

log "main promoted to $CURRENT_SHA"
log "tag pushed: $TAG"
