#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/release-common.sh
source "$SCRIPT_DIR/release-common.sh"

require_cmd cargo
require_cmd pnpm

log "building sc-web production bundle"
cd "$PROJECT_DIR"
pnpm --filter sc-web build

log "building AppImage via Tauri (sc-desktop)"
cd "$PROJECT_DIR/sc-desktop"
cargo tauri build --bundles appimage

# Tauri v2 outputs AppImage at:
#   src-tauri/target/release/bundle/appimage/<product>_<version>_amd64.AppImage
APPIMAGE_DIR="$PROJECT_DIR/sc-desktop/target/release/bundle/appimage"
APPIMAGE="$(echo "$APPIMAGE_DIR"/*.AppImage)"
if [ ! -f "$APPIMAGE" ]; then
  fail "AppImage not found in $APPIMAGE_DIR"
fi

log "AppImage built: $APPIMAGE"
echo "$APPIMAGE"
