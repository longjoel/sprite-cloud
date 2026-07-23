#!/usr/bin/env bash
set -euo pipefail

# Sprite Cloud — one-liner sc-server installer
# Usage: curl -fsSL https://sprite-cloud.com/install.sh | bash

REPO="longjoel/sprite-cloud"
BIN="sc-server"
INSTALL_DIR="${SC_INSTALL_DIR:-/usr/local/bin}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

log()   { printf '  \033[36m→\033[0m %s\n' "$*"; }
done_log() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn()  { printf '  \033[33m⚠\033[0m %s\n' "$*" >&2; }
err()   { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# ── Privilege check ───────────────────────────────────────────
if [ "$(id -u)" -eq 0 ]; then
  warn "Running as root — installing system-wide to $INSTALL_DIR"
else
  # User install — use ~/.local/bin if preferred
  if [ ! -w "$INSTALL_DIR" ] && [ -z "${SC_INSTALL_DIR:-}" ]; then
    INSTALL_DIR="$HOME/.local/bin"
    mkdir -p "$INSTALL_DIR"
    log "Installing to $INSTALL_DIR (user-local)"
    # Add to PATH for this session
    case ":$PATH:" in
      *:"$INSTALL_DIR":*) ;;
      *) export PATH="$INSTALL_DIR:$PATH" ;;
    esac
  fi
fi

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
  armv7l) err "32-bit ARM not supported — need aarch64 (Raspberry Pi 3/4/5 with 64-bit OS)" ;;
  *) err "Unsupported architecture: $ARCH" ;;
esac

log "Detected: $OS / $ARCH"

# ── Dependency check ───────────────────────────────────────────
for cmd in curl tar; do
  command -v "$cmd" >/dev/null 2>&1 || err "$cmd is required — install it first (apt install $cmd)"
done

# GStreamer runtime — needed at runtime, warn if missing
if ! ldconfig -p 2>/dev/null | grep -q libgstreamer-1.0; then
  warn "GStreamer 1.0 not found — install it before starting:"
  warn "  sudo apt install gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-plugins-ugly gstreamer1.0-libav"
fi

# ── Fetch latest release ───────────────────────────────────────
log "Detecting latest release..."
API="https://api.github.com/repos/$REPO/releases/latest"
TAG="$(curl -fsSL "$API" 2>/dev/null | grep '"tag_name"' | head -1 | sed 's/.*"tag_name": *"//;s/".*//')"
[ -n "$TAG" ] || err "Could not detect latest release tag — is the repo public?"
log "Latest release: $TAG"

# ── Download binary ────────────────────────────────────────────
URL="https://github.com/$REPO/releases/download/$TAG/${BIN}-${ARCH}"
SHA_URL="${URL}.sha256"

log "Downloading $BIN ($ARCH)..."
curl -fsSL "$URL" -o "$TMP/$BIN"
chmod +x "$TMP/$BIN"

# Verify checksum if available
if curl -fsSL "$SHA_URL" -o "$TMP/$BIN.sha256" 2>/dev/null; then
  (cd "$TMP" && sha256sum -c "$BIN.sha256" 2>/dev/null) || warn "Checksum verification failed — continuing anyway"
else
  warn "No checksum available for verification"
fi

done_log "Downloaded $BIN $TAG ($ARCH)"

# ── Install ────────────────────────────────────────────────────
cp "$TMP/$BIN" "$INSTALL_DIR/$BIN"
done_log "Installed to $INSTALL_DIR/$BIN"

# ── Verify ─────────────────────────────────────────────────────
"$INSTALL_DIR/$BIN" --version 2>/dev/null || warn "Binary installed but --version check failed"

echo ""
printf '  \033[32m%s\033[0m\n' "✓ sc-server $TAG installed successfully"
echo ""

# ── Next steps ─────────────────────────────────────────────────
echo "  Next steps:"
echo ""
echo "  1. Run the setup wizard:"
echo "       sc-server setup"
echo "     (This checks your NAT, configures STUN, and sets ROM paths.)"
echo ""
echo "  2. Sign in at https://sprite-cloud.com/signin"
echo "  3. Go to Dashboard → Generate Pairing Code"
echo "  4. Run:  sc-server pair <code> --sc-web-url https://sprite-cloud.com"
echo ""
echo "  For auto-start on boot:"
echo "    sc-server --install"
echo "    systemctl --user enable --now sc-server"
echo ""
