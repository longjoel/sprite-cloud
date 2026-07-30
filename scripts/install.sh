#!/usr/bin/env bash
# Sprite Cloud — one-liner self-hosted install
#   curl -sSL https://... | bash            # system-wide (needs sudo)
#   curl -sSL https://... | bash -s -- --rootless  # user-only (no sudo)
set -euo pipefail

BOLD='\033[1m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'

log()  { printf "${CYAN}→${NC} %s\n" "$*"; }
ok()   { printf "${GREEN}✓${NC} %s\n" "$*"; }
warn() { printf "${YELLOW}!${NC} %s\n" "$*"; }
err()  { printf "${RED}✗${NC} %s\n" "$*" >&2; exit 1; }

ROOTLESS=false
WEB_URL=""
ROM_DIR=""
# Default TURN credential for sprite-cloud.com (override with GV_TURN_CREDENTIAL env var)
TURN_CREDENTIAL="${GV_TURN_CREDENTIAL:-0bf1912a8e569c803978495362f14dbb1f2ed50e7151c5fd26968748cd1eef7f}"

# ── Parse args ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --rootless)           ROOTLESS=true; shift ;;
    --web-url)            WEB_URL="$2"; shift 2 ;;
    --rom-dir)            ROM_DIR="$2"; shift 2 ;;
    --help|-h)
      printf "Usage: install.sh [--rootless] [--web-url URL] [--rom-dir PATH]\n"
      printf "  --rootless   Install as current user (no sudo)\n"
      printf "  --web-url    sc-web URL (skip prompt)\n"
      printf "  --rom-dir    ROM directory (skip prompt)\n"
      exit 0
      ;;
    *) err "unknown flag: $1 (use --help)" ;;
  esac
done

# Also support GV_ROOTLESS=1 env var
if [[ "${GV_ROOTLESS:-}" == "1" ]]; then
  ROOTLESS=true
fi

# ── Detect OS ──────────────────────────────────────────────────────────
UNAME_S=$(uname -s)
UNAME_M=$(uname -m)

if [ "$UNAME_S" != "Linux" ]; then
  err "Sprite Cloud requires Linux (detected: $UNAME_S)"
fi

case "$UNAME_M" in
  x86_64)  ARCH="x86_64" ;;
  aarch64) ARCH="aarch64" ;;
  armv7l)  err "unsupported architecture: armv7l (release assets are x86_64 and aarch64)" ;;
  *)       err "unsupported architecture: $UNAME_M" ;;
esac

if [ -f /etc/os-release ]; then
  . /etc/os-release
  OS_ID="${ID}"
else
  err "cannot detect OS (/etc/os-release not found)"
fi

case "$OS_ID" in
  ubuntu|debian|pop|linuxmint|raspbian)
    PKG_MGR="apt"
    GST_PKGS="libgstreamer1.0-0 gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-plugins-bad libopus0 libvpx9 libgl1 libegl1"
    ;;
  fedora|centos|rhel|rocky|almalinux|bazzite)
    PKG_MGR="dnf"
    GST_PKGS="gstreamer1 gstreamer1-plugins-base gstreamer1-plugins-good gstreamer1-plugins-bad-free opus libvpx libglvnd-egl"
    ;;
  arch|manjaro|endeavouros)
    PKG_MGR="pacman"
    GST_PKGS="gstreamer gst-plugins-base gst-plugins-good gst-plugins-bad opus libvpx libgl mesa"
    ;;
  *)
    err "unsupported OS: $OS_ID (supported: ubuntu, debian, fedora, arch)"
    ;;
esac

# ── Set paths ──────────────────────────────────────────────────────────
if $ROOTLESS; then
  MODE="rootless (user)"
  SUDO=""
  BIN_DIR="${HOME}/.local/bin"
  CONFIG_DIR="${HOME}/.config/sprite-cloud"
  DATA_DIR="${HOME}/.local/share/sprite-cloud"
  SYSTEMD_DIR="${HOME}/.config/systemd/user"
  SYSTEMCTL="systemctl --user"
  JOURNALCTL="journalctl --user"
  SU_CMD=""  # no user switch needed
else
  MODE="system-wide (root)"
  if [ "$(id -u)" -eq 0 ]; then
    SUDO=""
    warn "running as root — sudo prefix omitted"
  elif command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
  else
    err "sudo not found — run as root or use --rootless"
  fi
  BIN_DIR="/usr/local/bin"
  MANAGED_BIN_DIR="${DATA_DIR}/bin"
  CONFIG_DIR="/etc/sprite-cloud"
  DATA_DIR="/var/lib/sprite-cloud"
  SYSTEMD_DIR="/etc/systemd/system"
  SYSTEMCTL="${SUDO:+$SUDO }systemctl"
  JOURNALCTL="${SUDO:+$SUDO }journalctl"
  SU_CMD="sprite-cloud:sprite-cloud"
fi

CORES_DIR="${DATA_DIR}/cores"
CONFIG_FILE="${CONFIG_DIR}/config.toml"
BIN_PATH="${MANAGED_BIN_DIR}/sc-server"
CORE_BIN_PATH="${MANAGED_BIN_DIR}/sc-core"
MANAGED_BIN_PATH="${MANAGED_BIN_DIR}/sc-server"

printf "${BOLD}Sprite Cloud — Self-Hosted Install${NC}\n"
printf "  Mode:   ${CYAN}%s${NC}\n" "$MODE"
printf "  OS:     ${GREEN}%s${NC}\n" "$OS_ID"
printf "  Arch:   ${GREEN}%s${NC}\n" "$ARCH"
printf "  Pkg:    ${GREEN}%s${NC}\n" "$PKG_MGR"
printf "  Binary: ${GREEN}%s${NC}\n" "$BIN_PATH"
printf "  Config: ${GREEN}%s${NC}\n" "$CONFIG_FILE"
echo ""

# ── Install system dependencies ────────────────────────────────────────
if $ROOTLESS; then
  warn "rootless mode — skipping system package install"
  warn "install manually: ${GST_PKGS} curl ca-certificates"
else
  log "Installing system dependencies (GStreamer, Opus, VP8, GL)…"

  case "$PKG_MGR" in
    apt)
      $SUDO apt-get update -qq
      $SUDO apt-get install -y -qq --no-install-recommends $GST_PKGS curl ca-certificates
      ;;
    dnf)
      $SUDO dnf install -y -q $GST_PKGS curl ca-certificates
      ;;
    pacman)
      $SUDO pacman -Syu --noconfirm --needed $GST_PKGS curl ca-certificates
      ;;
  esac

  ok "system dependencies installed"
fi

# ── Create directories ─────────────────────────────────────────────────
if ! $ROOTLESS; then
  if ! id sprite-cloud >/dev/null 2>&1; then
    log "Creating sprite-cloud user…"
    $SUDO useradd -r -s /usr/sbin/nologin -m -d "$DATA_DIR" sprite-cloud
    ok "user sprite-cloud created"
  else
    ok "user sprite-cloud already exists"
  fi
fi

$SUDO mkdir -p "$BIN_DIR" "$MANAGED_BIN_DIR" "$CONFIG_DIR" "$DATA_DIR" "$CORES_DIR"

if ! $ROOTLESS; then
  $SUDO chown -R "$SU_CMD" "$DATA_DIR"
fi

ok "directories created"

# ── Migrate existing /usr/local/bin installation ──────────────────────
if ! $ROOTLESS && $SUDO test -e /usr/local/bin/sc-server && ! $SUDO test -e "$BIN_PATH"; then
  warn "existing /usr/local/bin installation detected — migrating to managed directory"
  $SUDO cp -p /usr/local/bin/sc-server "$BIN_PATH" || err "migration failed: sc-server"
  $SUDO cp -p /usr/local/bin/sc-core "$CORE_BIN_PATH" 2>/dev/null || true
  $SUDO chown "$SU_CMD" "$BIN_PATH" "$CORE_BIN_PATH" 2>/dev/null || true
  $SUDO mv /usr/local/bin/sc-server "/usr/local/bin/sc-server.migrated-$(date +%Y%m%dT%H%M%SZ)" 2>/dev/null || true
  $SUDO mv /usr/local/bin/sc-core "/usr/local/bin/sc-core.migrated-$(date +%Y%m%dT%H%M%SZ)" 2>/dev/null || true
  ok "binaries migrated to ${MANAGED_BIN_DIR}"
fi

# ── Download binary ────────────────────────────────────────────────────
BIN_URL="${GV_BIN_URL:-https://github.com/longjoel/sprite-cloud/releases/latest/download/sc-server-${ARCH}}"
SHA_URL="${GV_BIN_SHA256_URL:-${BIN_URL}.sha256}"
DOWNLOAD_DIR="$(mktemp -d)"
trap 'rm -rf "$DOWNLOAD_DIR"' EXIT
DOWNLOAD_BIN="$DOWNLOAD_DIR/sc-server"
DOWNLOAD_SHA="$DOWNLOAD_DIR/sc-server.sha256"

log "Downloading sc-server ($ARCH)…"
curl -fsSL "$BIN_URL" -o "$DOWNLOAD_BIN" || err "binary download failed"
curl -fsSL "$SHA_URL" -o "$DOWNLOAD_SHA" || err "checksum download failed"
EXPECTED_SHA="$(cut -d ' ' -f1 "$DOWNLOAD_SHA")"
[[ "$EXPECTED_SHA" =~ ^[0-9a-fA-F]{64}$ ]] || err "invalid checksum file"
(cd "$DOWNLOAD_DIR" && printf '%s  %s\n' "$EXPECTED_SHA" sc-server | sha256sum -c - >/dev/null) \
  || err "checksum verification failed"
# Keep both verified downloads staged before replacing either installed executable.
CORE_BIN_URL="${GV_CORE_BIN_URL:-https://github.com/longjoel/sprite-cloud/releases/latest/download/sc-core-${ARCH}}"
CORE_SHA_URL="${GV_CORE_BIN_SHA256_URL:-${CORE_BIN_URL}.sha256}"
DOWNLOAD_CORE="$DOWNLOAD_DIR/sc-core"
DOWNLOAD_CORE_SHA="$DOWNLOAD_DIR/sc-core.sha256"

log "Downloading sc-core ($ARCH)…"
curl -fsSL "$CORE_BIN_URL" -o "$DOWNLOAD_CORE" || err "sc-core download failed"
curl -fsSL "$CORE_SHA_URL" -o "$DOWNLOAD_CORE_SHA" || err "sc-core checksum download failed"
EXPECTED_CORE_SHA="$(cut -d ' ' -f1 "$DOWNLOAD_CORE_SHA")"
[[ "$EXPECTED_CORE_SHA" =~ ^[0-9a-fA-F]{64}$ ]] || err "invalid sc-core checksum file"
(cd "$DOWNLOAD_DIR" && printf '%s  %s\n' "$EXPECTED_CORE_SHA" sc-core | sha256sum -c - >/dev/null) \
  || err "sc-core checksum verification failed"
STAGED_CORE="$($SUDO mktemp "$MANAGED_BIN_DIR/.sc-core.XXXXXX")" || err "could not stage sc-core in $MANAGED_BIN_DIR"
if ! $SUDO install -m 0755 "$DOWNLOAD_CORE" "$STAGED_CORE"; then
  $SUDO rm -f "$STAGED_CORE"
  err "sc-core staging failed"
fi
STAGED_SERVER="$($SUDO mktemp "$MANAGED_BIN_DIR/.sc-server.XXXXXX")" || {
  $SUDO rm -f "$STAGED_CORE"
  err "could not stage sc-server in $MANAGED_BIN_DIR"
}
if ! $SUDO install -m 0755 "$DOWNLOAD_BIN" "$STAGED_SERVER"; then
  $SUDO rm -f "$STAGED_CORE" "$STAGED_SERVER"
  err "sc-server staging failed"
fi

BACKUP_CORE=""
BACKUP_SERVER=""
if $SUDO test -e "$CORE_BIN_PATH"; then
  BACKUP_CORE="$($SUDO mktemp "$MANAGED_BIN_DIR/.sc-core.backup.XXXXXX")" || err "could not stage sc-core rollback"
  $SUDO cp -p "$CORE_BIN_PATH" "$BACKUP_CORE" || err "could not back up sc-core"
fi
if $SUDO test -e "$BIN_PATH"; then
  BACKUP_SERVER="$($SUDO mktemp "$MANAGED_BIN_DIR/.sc-server.backup.XXXXXX")" || err "could not stage sc-server rollback"
  $SUDO cp -p "$BIN_PATH" "$BACKUP_SERVER" || err "could not back up sc-server"
fi

REPLACED_CORE=false
REPLACED_SERVER=false
rollback_install() {
  if $REPLACED_SERVER; then
    if [[ -n "$BACKUP_SERVER" ]]; then $SUDO mv -f "$BACKUP_SERVER" "$BIN_PATH"; else $SUDO rm -f "$BIN_PATH"; fi
  fi
  if $REPLACED_CORE; then
    if [[ -n "$BACKUP_CORE" ]]; then $SUDO mv -f "$BACKUP_CORE" "$CORE_BIN_PATH"; else $SUDO rm -f "$CORE_BIN_PATH"; fi
  fi
  $SUDO rm -f "$STAGED_CORE" "$STAGED_SERVER" "$BACKUP_CORE" "$BACKUP_SERVER"
}
trap 'rollback_install; exit 130' INT TERM HUP

REPLACED_CORE=true
if ! $SUDO mv -f "$STAGED_CORE" "$CORE_BIN_PATH"; then
  rollback_install
  err "atomic sc-core install failed"
fi
REPLACED_SERVER=true
if ! $SUDO mv -f "$STAGED_SERVER" "$BIN_PATH"; then
  rollback_install
  err "atomic sc-server install failed; previous binaries restored"
fi
trap - INT TERM HUP
$SUDO rm -f "$BACKUP_CORE" "$BACKUP_SERVER"
ok "sc-core installed to $CORE_BIN_PATH"
ok "sc-server installed to $BIN_PATH"

# ── Convenience symlink ──────────────────────────────────────────────────
if ! $ROOTLESS; then
  $SUDO ln -sf "$BIN_PATH" "/usr/local/bin/sc-server"
  ok "symlink created: /usr/local/bin/sc-server → $BIN_PATH"
fi

# ── ROM root (system-wide only) ────────────────────────────────────────
if ! $ROOTLESS && [[ -n "$ROM_DIR" ]] && [[ ! -d "$ROM_DIR" ]]; then
  $SUDO mkdir -p "$ROM_DIR"
  $SUDO chown "$SU_CMD" "$ROM_DIR"
  ok "ROM root created: $ROM_DIR"
fi

# ── Preflight: verify service can write to its binary directory ────────
if ! $ROOTLESS; then
  PROBE_FILE="${MANAGED_BIN_DIR}/.sc-install-write-probe-$$"
  if ! $SUDO touch "$PROBE_FILE" 2>/dev/null; then
    err "${MANAGED_BIN_DIR} is not writable — check filesystem permissions"
  fi
  $SUDO rm -f "$PROBE_FILE"
  ok "managed binary directory writable: ${MANAGED_BIN_DIR}"
fi

# ── Config ─────────────────────────────────────────────────────────────
log "Configuration"
echo ""

if [[ -f "$CONFIG_FILE" ]]; then
  warn "existing config preserved: $CONFIG_FILE"
  if [[ -z "$WEB_URL" ]]; then
    WEB_URL="$($SUDO sed -n 's/^[[:space:]]*url[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$CONFIG_FILE" | head -1)"
  fi
  if [[ -z "$ROM_DIR" ]]; then
    ROM_DIR="$($SUDO sed -n 's/^[[:space:]]*roots[[:space:]]*=[[:space:]]*\["\([^"]*\)".*/\1/p' "$CONFIG_FILE" | head -1)"
  fi
else
  if [[ -z "$WEB_URL" ]]; then
    printf "  ${CYAN}Web URL${NC} (for example https://your-gateway.example): "
    read -r WEB_URL
  fi

  if [[ -z "$WEB_URL" ]]; then
    err "Web URL is required. Re-run with --web-url https://your-gateway.example"
  fi

  if [[ -z "$ROM_DIR" ]]; then
    printf "  ${CYAN}ROM directory${NC} [/srv/storage/games/roms]: "
    read -r ROM_DIR
    ROM_DIR="${ROM_DIR:-/srv/storage/games/roms}"
  fi

  $SUDO tee "$CONFIG_FILE" > /dev/null << EOF
[sc_web]
url = "${WEB_URL}"

[auth]
api_key = ""
server_id = ""

[rom]
roots = ["${ROM_DIR}"]
EOF

  if $ROOTLESS; then
    $SUDO chmod 600 "$CONFIG_FILE"
  else
    $SUDO chmod 600 "$CONFIG_FILE"
  fi

  ok "config written to $CONFIG_FILE"
fi

if ! $ROOTLESS; then
  $SUDO chown "$SU_CMD" "$CONFIG_DIR" "$CONFIG_FILE"
fi

# ── Systemd service ────────────────────────────────────────────────────
SERVICE_FILE="${SYSTEMD_DIR}/sc-server.service"

if $ROOTLESS; then
  mkdir -p "$SYSTEMD_DIR"
fi

log "Installing systemd service…"

if $ROOTLESS; then
  # User-level service — runs as current user, no hardening directives
  cat > "$SERVICE_FILE" << EOF
[Unit]
Description=Sprite Cloud Server (user)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment="XDG_CONFIG_HOME=${HOME}/.config"
Environment="GV_CORES_DIR=${CORES_DIR}"
Environment="GV_DATA_DIR=${DATA_DIR}"
Environment="RUST_LOG=info"
Environment="GV_ICE_STUN_URLS=stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302"
Environment="GV_ICE_TURN_URLS=turn:sprite-cloud.com:3478?transport=udp"
Environment="GV_ICE_TURN_USERNAME=guest"
Environment="GV_ICE_TURN_CREDENTIAL=${TURN_CREDENTIAL:-}"
ExecStart=${BIN_PATH} start
Restart=on-failure
RestartSec=5
LimitNOFILE=65536

[Install]
WantedBy=default.target
EOF
else
  $SUDO tee "$SERVICE_FILE" > /dev/null << EOF
[Unit]
Description=Sprite Cloud Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=sprite-cloud
Group=sprite-cloud
Environment="XDG_CONFIG_HOME=/etc"
Environment="GV_CORES_DIR=${CORES_DIR}"
Environment="GV_DATA_DIR=${DATA_DIR}"
Environment="RUST_LOG=info"
Environment="GV_ICE_STUN_URLS=stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302"
Environment="GV_ICE_TURN_URLS=turn:sprite-cloud.com:3478?transport=udp"
Environment="GV_ICE_TURN_USERNAME=guest"
Environment="GV_ICE_TURN_CREDENTIAL=${TURN_CREDENTIAL:-}"
ExecStart=${MANAGED_BIN_PATH} start
Restart=on-failure
RestartSec=5
LimitNOFILE=65536

# Security hardening
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=${DATA_DIR} ${ROM_DIR} /tmp/sc-sessions
PrivateTmp=yes
PrivateDevices=no
DeviceAllow=/dev/dri rw

[Install]
WantedBy=multi-user.target
EOF
fi

$SYSTEMCTL daemon-reload
ok "systemd service installed (disabled — pair first)"

# ── Done ───────────────────────────────────────────────────────────────
echo ""
printf "${GREEN}${BOLD}========================================${NC}\n"
printf "${GREEN}${BOLD}  Sprite Cloud installed!${NC}\n"
printf "${GREEN}${BOLD}========================================${NC}\n"
echo ""
printf "  Next steps:\n"
echo ""
printf "  ${BOLD}1. Pair your server:${NC}\n"
printf "     Open ${CYAN}${WEB_URL%/}/dashboard${NC} → Pair Server → copy the code\n"
printf "     Run: ${BOLD}sc-server pair <CODE> --sc-web-url ${WEB_URL}${NC}\n"
echo ""
printf "  ${BOLD}2. Start the service:${NC}\n"
printf "     ${BOLD}${SYSTEMCTL} enable --now sc-server${NC}\n"
if $ROOTLESS; then
  printf "     Run this as your login user; ${BOLD}do not prefix it with sudo${NC}.\n"
fi
echo ""
printf "  Status:  ${BOLD}${SYSTEMCTL} status sc-server${NC}\n"
printf "  Logs:    ${BOLD}${JOURNALCTL} -u sc-server -f${NC}\n"
printf "  Config:  ${BOLD}${CONFIG_FILE}${NC}\n"
printf "  Cores:   ${BOLD}${CORES_DIR}${NC}\n"
echo ""
printf "  Games auto-download cores from the buildbot.\n"
printf "  Place ROMs in ${BOLD}${ROM_DIR}${NC} and they'll appear in the web UI.\n"

if $ROOTLESS; then
  echo ""
  warn "Rootless install — you must install system deps yourself:"
  printf "     ${BOLD}${GST_PKGS} curl ca-certificates${NC}\n"
fi
