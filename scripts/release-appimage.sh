#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/release-common.sh
source "$SCRIPT_DIR/release-common.sh"

require_cmd sha256sum

log "building AppImage via build-appimage.sh"
"$SCRIPT_DIR/build-appimage.sh"

# Locate the built AppImage.
APPIMAGE_DIR="$PROJECT_DIR/gv-desktop/target/release/bundle/appimage"
APPIMAGE="$(echo "$APPIMAGE_DIR"/*.AppImage)"
if [ ! -f "$APPIMAGE" ]; then
  fail "AppImage not found in $APPIMAGE_DIR"
fi

# Read version from gv-desktop/Cargo.toml or tauri.conf.json.
VERSION="$(awk -F\" '/^version/ {print $2; exit}' "$PROJECT_DIR/gv-desktop/Cargo.toml")"
if [ -z "$VERSION" ]; then
  fail "could not determine version from Cargo.toml"
fi

# Copy to repo root with versioned filename.
RELEASE_NAME="GamesVault-${VERSION}.AppImage"
RELEASE_PATH="$PROJECT_DIR/$RELEASE_NAME"
cp "$APPIMAGE" "$RELEASE_PATH"
log "copied AppImage to $RELEASE_PATH"

# Generate SHA256 checksum.
CHECKSUMS_PATH="$PROJECT_DIR/GamesVault-${VERSION}.sha256"
( cd "$PROJECT_DIR" && sha256sum "$RELEASE_NAME" > "$CHECKSUMS_PATH" )
log "checksum written to $CHECKSUMS_PATH"
cat "$CHECKSUMS_PATH"
