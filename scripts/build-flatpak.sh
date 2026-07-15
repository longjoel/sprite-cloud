#!/bin/bash
# Build the Games Vault Flatpak.
# Requires: flatpak-builder, org.gnome.Platform//47, org.gnome.Sdk//47

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
MANIFEST="$SCRIPT_DIR/org.spritecloud.GamesVault.yml"
BUILD_DIR="$SCRIPT_DIR/.flatpak-build"
REPO_DIR="$SCRIPT_DIR/repo"

echo "[flatpak] Installing GNOME 47 runtime + SDK (if missing)..."
flatpak install -y --user org.gnome.Platform//47 org.gnome.Sdk//47 2>/dev/null || true

echo "[flatpak] Building..."
rm -rf "$BUILD_DIR" "$REPO_DIR"
mkdir -p "$REPO_DIR"

flatpak-builder \
    --force-clean \
    --repo="$REPO_DIR" \
    --install-deps-from=flathub \
    --user \
    "$BUILD_DIR" \
    "$MANIFEST"

echo "[flatpak] Exporting Flatpak bundle..."
flatpak build-bundle \
    "$REPO_DIR" \
    "$REPO_ROOT/games-vault.flatpak" \
    org.spritecloud.GamesVault \
    stable

echo "[flatpak] Done: $REPO_ROOT/games-vault.flatpak"
ls -lh "$REPO_ROOT/games-vault.flatpak"
