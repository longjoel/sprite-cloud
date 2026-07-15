#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/release-common.sh
source "$SCRIPT_DIR/release-common.sh"

require_cmd cargo
require_cmd pnpm

log "building gv-web production bundle"
cd "$PROJECT_DIR"
pnpm --filter gv-web build

log "building AppImage via Tauri (gv-desktop)"
cd "$PROJECT_DIR/gv-desktop"
cargo tauri build --bundles appimage

# Tauri v2 outputs AppImage at:
#   src-tauri/target/release/bundle/appimage/<product>_<version>_amd64.AppImage
APPIMAGE_DIR="$PROJECT_DIR/gv-desktop/target/release/bundle/appimage"
APPIMAGE="$(echo "$APPIMAGE_DIR"/*.AppImage)"
if [ ! -f "$APPIMAGE" ]; then
  fail "AppImage not found in $APPIMAGE_DIR"
fi

log "AppImage built: $APPIMAGE"
echo "$APPIMAGE"
