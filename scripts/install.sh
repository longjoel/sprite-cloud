#!/usr/bin/env bash
# Sprite Cloud — one-liner self-hosted install
#   curl -sSL https://... | sh            # system-wide (needs sudo)
#   curl -sSL https://... | sh -s -- --rootless  # user-only (no sudo)
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
  aarch64) ARCH="arm64" ;;
  armv7l)  ARCH="armv7" ;;
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
  CONFIG_DIR="/etc/sprite-cloud"
  DATA_DIR="/var/lib/sprite-cloud"
  SYSTEMD_DIR="/etc/systemd/system"
  SYSTEMCTL="sudo systemctl"
  SU_CMD="sprite-cloud:sprite-cloud"
fi

CORES_DIR="${DATA_DIR}/cores"
CONFIG_FILE="${CONFIG_DIR}/config.toml"
BIN_PATH="${BIN_DIR}/sc-server"

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

$SUDO mkdir -p "$BIN_DIR" "$CONFIG_DIR" "$DATA_DIR" "$CORES_DIR"

if ! $ROOTLESS; then
  $SUDO chown -R "$SU_CMD" "$DATA_DIR"
fi

ok "directories created"

# ── Download binary ────────────────────────────────────────────────────
BIN_URL="${GV_BIN_URL:-https://github.com/longjoel/sprite-cloud/releases/latest/download/sc-server-${ARCH}}"

log "Downloading sc-server ($ARCH)…"
$SUDO curl -sSL "$BIN_URL" -o "$BIN_PATH"
$SUDO chmod +x "$BIN_PATH"
ok "sc-server installed to $BIN_PATH"

# ── Config ─────────────────────────────────────────────────────────────
log "Configuration"
echo ""

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

[rom]
roots = ["${ROM_DIR}"]
EOF

if $ROOTLESS; then
  $SUDO chmod 600 "$CONFIG_FILE"
else
  $SUDO chown "$SU_CMD" "$CONFIG_DIR"
  $SUDO chmod 600 "$CONFIG_FILE"
fi

ok "config written to $CONFIG_FILE"

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
Environment="RUST_LOG=info"
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
Environment="RUST_LOG=info"
ExecStart=${BIN_PATH} start
Restart=on-failure
RestartSec=5
LimitNOFILE=65536

# Security hardening
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=${DATA_DIR} /tmp/sc-sessions
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
printf "     Go to ${CYAN}${WEB_URL}${NC} → Pair Server → copy the code\n"
printf "     Run: ${BOLD}sc-server pair <CODE> --sc-web-url ${WEB_URL}${NC}\n"
echo ""
printf "  ${BOLD}2. Start the service:${NC}\n"
printf "     ${BOLD}${SYSTEMCTL} enable --now sc-server${NC}\n"
echo ""
printf "  Status:  ${BOLD}${SYSTEMCTL} status sc-server${NC}\n"
printf "  Logs:    ${BOLD}journalctl ${SYSTEMCTL/#systemctl/} -u sc-server -f${NC}\n"
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
