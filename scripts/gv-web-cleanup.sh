#!/usr/bin/env bash
set -euo pipefail
# Run gv-web database cleanup inside the production Docker container.
# Schedule via cron on the VPS:
#   */10 * * * * /root/projects/games-vault/scripts/gv-web-cleanup.sh

VPS_HOST="${GV_VPS_HOST:-lngnckr.tech}"
VPS_USER="${GV_VPS_USER:-root}"
CONTAINER="${GV_WEB_CONTAINER:-gv-web-gv-web-1}"

ssh "$VPS_USER@$VPS_HOST" "docker exec $CONTAINER node scripts/cleanup.js"
