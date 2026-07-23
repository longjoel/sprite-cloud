#!/usr/bin/env bash
set -euo pipefail

# Sprite Cloud — one-liner sc-server installer
# Usage: curl -fsSL https://sprite-cloud.com/install.sh | bash

REPO="longjoel/sprite-cloud"
BIN="sc-server"
INSTALL_DIR="${SC_INSTALL_DIR:-/usr/local/bin}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

log()  { printf '  \033[36m→\033[0m %s\n' "$*"; }
done_log() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
err()  { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# ── OS / Arch detection ────────────────────────────────────────
OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS" in
  Linux)  OS="linux" ;;
  *)      err "Unsupported OS: $OS (only Linux supported)" ;;
esac
case "$ARCH" in
  x86_64|amd64) ARCH="x86_64" ;;
  aarch64|arm64) ARCH="aarch64" ;;
  *) err "Unsupported architecture: $ARCH" ;;
esac

# ── Fetch latest release ───────────────────────────────────────
log "Detecting latest release..."
API="https://api.github.com/repos/$REPO/releases/latest"
TAG="$(curl -fsSL "$API" | grep '"tag_name"' | head -1 | sed 's/.*"tag_name": *"//;s/".*//')"
[ -n "$TAG" ] || err "Could not detect latest release tag"
log "Latest release: $TAG"

# ── Download binary ────────────────────────────────────────────
URL="https://github.com/$REPO/releases/download/$TAG/${BIN}-${ARCH}"
log "Downloading $BIN ($ARCH) from $URL..."
curl -fsSL "$URL" -o "$TMP/$BIN"
chmod +x "$TMP/$BIN"
done_log "Downloaded $BIN $TAG ($ARCH)"

# ── Install ────────────────────────────────────────────────────
if [ -w "$INSTALL_DIR" ]; then
  cp "$TMP/$BIN" "$INSTALL_DIR/$BIN"
else
  sudo cp "$TMP/$BIN" "$INSTALL_DIR/$BIN"
fi
done_log "Installed to $INSTALL_DIR/$BIN"

# ── Verify ─────────────────────────────────────────────────────
"$INSTALL_DIR/$BIN" --version 2>/dev/null || true
done_log "$BIN $TAG installed successfully"

# ── Service hint ───────────────────────────────────────────────
log "To run as a background service:"
printf '  \033[33m%s\033[0m\n' "  sc-server --install"
printf '  \033[33m%s\033[0m\n' "  systemctl --user enable --now sc-server"
