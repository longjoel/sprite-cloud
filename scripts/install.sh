#!/usr/bin/env bash
# Games Vault — one-liner self-hosted install
# curl -sSL https://lngnckr.tech/install.sh | sh
set -euo pipefail

BOLD='\033[1m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
RED='\033[0;31m'
NC='\033[0m'

log()  { printf "${CYAN}→${NC} %s\n" "$*"; }
ok()   { printf "${GREEN}✓${NC} %s\n" "$*"; }
err()  { printf "${RED}✗${NC} %s\n" "$*" >&2; exit 1; }

# ── Detect OS ──────────────────────────────────────────────────────────
UNAME_S=$(uname -s)
UNAME_M=$(uname -m)

if [ "$UNAME_S" != "Linux" ]; then
  err "Games Vault requires Linux (detected: $UNAME_S)"
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

printf "${BOLD}Games Vault — Self-Hosted Install${NC}\n"
printf "  OS:     ${GREEN}%s${NC}\n" "$OS_ID"
printf "  Arch:   ${GREEN}%s${NC}\n" "$ARCH"
printf "  Pkg:    ${GREEN}%s${NC}\n" "$PKG_MGR"
echo ""

# ── Install system dependencies ────────────────────────────────────────
log "Installing system dependencies (GStreamer, Opus, VP8, GL)…"

case "$PKG_MGR" in
  apt)
    sudo apt-get update -qq
    sudo apt-get install -y -qq --no-install-recommends $GST_PKGS curl ca-certificates
    ;;
  dnf)
    sudo dnf install -y -q $GST_PKGS curl ca-certificates
    ;;
  pacman)
    sudo pacman -Syu --noconfirm --needed $GST_PKGS curl ca-certificates
    ;;
esac

ok "system dependencies installed"

# ── Create system user ─────────────────────────────────────────────────
if ! id games-vault >/dev/null 2>&1; then
  log "Creating games-vault user…"
  sudo useradd -r -s /usr/sbin/nologin -m -d /var/lib/games-vault games-vault
  ok "user games-vault created"
else
  ok "user games-vault already exists"
fi

# ── Download binary ────────────────────────────────────────────────────
BIN_URL="${GV_BIN_URL:-https://github.com/longjoel/games-vault/releases/latest/download/gv-server-${ARCH}}"
BIN_PATH="/usr/local/bin/gv-server"

log "Downloading gv-server ($ARCH)…"
sudo curl -sSL "$BIN_URL" -o "$BIN_PATH"
sudo chmod +x "$BIN_PATH"
ok "gv-server installed to $BIN_PATH"

# ── Core directory ─────────────────────────────────────────────────────
CORES_DIR="/var/lib/games-vault/cores"
sudo mkdir -p "$CORES_DIR"
sudo chown games-vault:games-vault "$CORES_DIR"
ok "cores directory: $CORES_DIR"

# ── Config ─────────────────────────────────────────────────────────────
CONFIG_DIR="/etc/games-vault"
CONFIG_FILE="$CONFIG_DIR/config.toml"
sudo mkdir -p "$CONFIG_DIR"

log "Configuration"
echo ""

printf "  ${CYAN}Web URL${NC} [https://lngnckr.tech]: "
read -r WEB_URL
WEB_URL="${WEB_URL:-https://lngnckr.tech}"

printf "  ${CYAN}ROM directory${NC} [/srv/storage/games/roms]: "
read -r ROM_DIR
ROM_DIR="${ROM_DIR:-/srv/storage/games/roms}"

sudo tee "$CONFIG_FILE" > /dev/null << EOF
[gv_web]
url = "${WEB_URL}"

[rom]
roots = ["${ROM_DIR}"]
EOF

sudo chown -R games-vault:games-vault "$CONFIG_DIR"
sudo chmod 600 "$CONFIG_FILE"
ok "config written to $CONFIG_FILE"

# ── Systemd service (disabled until paired) ────────────────────────────
SERVICE_FILE="/etc/systemd/system/gv-server.service"

log "Installing systemd service…"

sudo tee "$SERVICE_FILE" > /dev/null << EOF
[Unit]
Description=Games Vault Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=games-vault
Group=games-vault
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
ReadWritePaths=/var/lib/games-vault /tmp/gv-workers
PrivateTmp=yes
PrivateDevices=no
DeviceAllow=/dev/dri rw

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
ok "systemd service installed (disabled — pair first)"

# ── Done ───────────────────────────────────────────────────────────────
echo ""
printf "${GREEN}${BOLD}========================================${NC}\n"
printf "${GREEN}${BOLD}  Games Vault installed!${NC}\n"
printf "${GREEN}${BOLD}========================================${NC}\n"
echo ""
printf "  Next steps:\n"
echo ""
printf "  ${BOLD}1. Pair your server:${NC}\n"
printf "     Go to ${CYAN}${WEB_URL}${NC} → Pair Server → copy the code\n"
printf "     Run: ${BOLD}gv-server pair <CODE>${NC}\n"
echo ""
printf "  ${BOLD}2. Start the service:${NC}\n"
printf "     ${BOLD}sudo systemctl enable --now gv-server${NC}\n"
echo ""
printf "  Status:  ${BOLD}sudo systemctl status gv-server${NC}\n"
printf "  Logs:    ${BOLD}sudo journalctl -u gv-server -f${NC}\n"
printf "  Config:  ${BOLD}${CONFIG_FILE}${NC}\n"
printf "  Cores:   ${BOLD}${CORES_DIR}${NC}\n"
echo ""
printf "  Games auto-download cores from the buildbot.\n"
printf "  Place ROMs in ${BOLD}${ROM_DIR}${NC} and they'll appear in the web UI.\n"
