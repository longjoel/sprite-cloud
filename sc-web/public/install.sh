#!/usr/bin/env bash
set -euo pipefail

# Sprite Cloud — one-liner sc-server installer
# Usage: curl -fsSL https://sprite-cloud.com/install.sh | bash

REPO="longjoel/sprite-cloud"
BINARIES=("sc-server" "sc-core")
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
[ -n "$TAG" ] || err "Could not detect latest release — check internet connection"
log "Latest release: $TAG"

# ── Download and verify required binaries ──────────────────────
for BIN in "${BINARIES[@]}"; do
  URL="https://github.com/$REPO/releases/download/$TAG/${BIN}-${ARCH}"
  SHA_URL="${URL}.sha256"

  log "Downloading $BIN ($ARCH)..."
  HTTP_CODE="$(curl -sSL -o "$TMP/$BIN" -w '%{http_code}' "$URL" 2>/dev/null || true)"

  if [ "$HTTP_CODE" = "404" ]; then
    log "No prebuilt $BIN binary for $ARCH — build from source:"
    echo ""
    echo "  git clone https://github.com/$REPO.git"
    echo "  cd sprite-cloud"
    echo "  cargo build --release -p sc-server -p sc-core"
    echo "  cp target/release/sc-server target/release/sc-core $INSTALL_DIR/"
    echo ""
    exit 1
  fi

  [ "$HTTP_CODE" = "200" ] || err "$BIN download failed (HTTP $HTTP_CODE)"
  chmod +x "$TMP/$BIN"

  # Use the digest rather than the recorded asset path so releases created by
  # older workflows remain verifiable.
  if curl -fsSL "$SHA_URL" -o "$TMP/$BIN.sha256" 2>/dev/null; then
    EXPECTED_SHA="$(cut -d ' ' -f1 "$TMP/$BIN.sha256")"
    [[ "$EXPECTED_SHA" =~ ^[0-9a-fA-F]{64}$ ]] || err "Invalid $BIN checksum file"
    (cd "$TMP" && printf '%s  %s\n' "$EXPECTED_SHA" "$BIN" | sha256sum -c - >/dev/null) \
      || err "$BIN checksum verification failed"
  else
    err "No $BIN checksum available for $TAG"
  fi

  done_log "Downloaded $BIN $TAG ($ARCH)"
done

# ── Install transactionally in the destination filesystem ──────
mkdir -p "$INSTALL_DIR"
STAGED_CORE="$(mktemp "$INSTALL_DIR/.sc-core.XXXXXX")" || err "Could not stage sc-core in $INSTALL_DIR"
if ! cp "$TMP/sc-core" "$STAGED_CORE" || ! chmod 0755 "$STAGED_CORE"; then
  rm -f "$STAGED_CORE"
  err "Could not stage verified sc-core"
fi
STAGED_SERVER="$(mktemp "$INSTALL_DIR/.sc-server.XXXXXX")" || {
  rm -f "$STAGED_CORE"
  err "Could not stage sc-server in $INSTALL_DIR"
}
if ! cp "$TMP/sc-server" "$STAGED_SERVER" || ! chmod 0755 "$STAGED_SERVER"; then
  rm -f "$STAGED_CORE" "$STAGED_SERVER"
  err "Could not stage verified sc-server"
fi

BACKUP_CORE=""
BACKUP_SERVER=""
if [ -e "$INSTALL_DIR/sc-core" ]; then
  BACKUP_CORE="$(mktemp "$INSTALL_DIR/.sc-core.backup.XXXXXX")" || err "Could not stage sc-core rollback"
  cp -p "$INSTALL_DIR/sc-core" "$BACKUP_CORE" || err "Could not back up sc-core"
fi
if [ -e "$INSTALL_DIR/sc-server" ]; then
  BACKUP_SERVER="$(mktemp "$INSTALL_DIR/.sc-server.backup.XXXXXX")" || err "Could not stage sc-server rollback"
  cp -p "$INSTALL_DIR/sc-server" "$BACKUP_SERVER" || err "Could not back up sc-server"
fi

REPLACED_CORE=false
REPLACED_SERVER=false
rollback_install() {
  if $REPLACED_SERVER; then
    if [ -n "$BACKUP_SERVER" ]; then mv -f "$BACKUP_SERVER" "$INSTALL_DIR/sc-server"; else rm -f "$INSTALL_DIR/sc-server"; fi
  fi
  if $REPLACED_CORE; then
    if [ -n "$BACKUP_CORE" ]; then mv -f "$BACKUP_CORE" "$INSTALL_DIR/sc-core"; else rm -f "$INSTALL_DIR/sc-core"; fi
  fi
  rm -f "$STAGED_CORE" "$STAGED_SERVER" "$BACKUP_CORE" "$BACKUP_SERVER"
}
trap 'rollback_install; exit 130' INT TERM HUP

REPLACED_CORE=true
if ! mv -f "$STAGED_CORE" "$INSTALL_DIR/sc-core"; then
  rollback_install
  err "Could not atomically install sc-core"
fi
REPLACED_SERVER=true
if ! mv -f "$STAGED_SERVER" "$INSTALL_DIR/sc-server"; then
  rollback_install
  err "Could not atomically install sc-server; previous binaries restored"
fi
trap - INT TERM HUP
rm -f "$BACKUP_CORE" "$BACKUP_SERVER"
done_log "Installed to $INSTALL_DIR/sc-core"
done_log "Installed to $INSTALL_DIR/sc-server"

# ── Verify ─────────────────────────────────────────────────────
"$INSTALL_DIR/sc-server" --version 2>/dev/null || warn "sc-server installed but --version check failed"
test -x "$INSTALL_DIR/sc-core" || err "sc-core was not installed as an executable"

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
echo "  2. Open https://sprite-cloud.com/dashboard"
echo "  3. Generate a Pairing Code"
echo "  4. Run:  sc-server pair <code> --sc-web-url https://sprite-cloud.com"
echo ""
echo "  For auto-start on boot:"
echo "    sc-server install"
echo "    systemctl --user enable --now sc-server"
echo "    (Run both as your login user; do not use sudo with systemctl --user.)"
echo ""
