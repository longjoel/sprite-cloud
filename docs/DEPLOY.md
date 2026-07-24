# Deployment Guide

Production Sprite Cloud has two roles:

| Role | Runs where | Purpose |
|---|---|---|
| Gateway | Docker/VPS/server | `sc-web` + PostgreSQL + optional TURN |
| Host | Linux box with ROMs/GPU | `sc-server` systemd service |

## Architecture

```text
┌──────────────────────────────────────────────────────┐
│ Gateway server                                       │
│  ├─ reverse proxy / TLS → sc-web (:3000)             │
│  ├─ PostgreSQL                                       │
│  └─ optional coturn (:3478 udp/tcp)                  │
├──────────────────────────────────────────────────────┤
│ Host machine                                         │
│  ├─ sc-server systemd service                        │
│  ├─ ROM roots                                        │
│  └─ libretro core cache                              │
└──────────────────────────────────────────────────────┘
```

sc-server polls sc-web for commands. Players use the gateway URL in their browser; WebRTC handles media transport.

## Build

From the repo root:

```bash
./scripts/build-release.sh
```

Manual equivalent:

```bash
cargo build --release -p sc-server
cd sc-web
pnpm install --frozen-lockfile
pnpm build
```

## Gateway deploy

Use the repo-tracked VPS templates plus the blessed deploy script. In this topology, `sc-web` and Postgres run with host networking on the VPS, and the live env file is `$VPS_ENV_FILE`.

Required env:

| Var | Purpose |
|---|---|
| `AUTH_SECRET` | Auth.js/NextAuth session encryption |
| `AUTH_URL` | Public gateway origin |
| `DATABASE_URL` | Postgres connection string — on the current VPS this must resolve to `postgresql://sprite_cloud:...@127.0.0.1:5432/sprite_cloud` |
| `GV_WEB_SCHEMA_PUSH_ON_START` | `1` only for empty-database initialization; apply reviewed migrations to existing databases |
| `GV_ICE_STUN_URLS` | STUN URLs |
| `GV_ICE_TURN_URLS` | TURN URLs, recommended for public internet play |
| `GV_ICE_TURN_USERNAME` | TURN username |
| `GV_ICE_TURN_CREDENTIAL` | TURN credential |

Build + deploy from the dev machine:

```bash
./scripts/deploy-sc-web.sh
```

What the script does:
- builds `sc-web` locally (`pnpm run lint && pnpm run build`)
- rsyncs the monorepo to the VPS build context
- builds `sc-web-prod:latest` on the VPS
- repairs stale `DATABASE_URL` in `$VPS_ENV_FILE` if needed
- restarts `sc-web-sc-web-1` on `--network host`
- forces `HOSTNAME=0.0.0.0` so Next binds a reachable interface
- verifies localhost health plus public `/`, `/watch`, and `/api/health`

Manual fallback on the VPS:

```bash
cd /root/sc-source
bash ./deploy-sc-web.sh
```

## Host deploy

For normal user and Bazzite installations, follow **[SC-SERVER-INSTALL.md](SC-SERVER-INSTALL.md)**. The default service is user-scoped:

```bash
curl -fsSL https://sprite-cloud.com/install.sh | bash
sc-server setup
sc-server pair <CODE> --sc-web-url https://sprite-cloud.com
sc-server install
systemctl --user daemon-reload
systemctl --user enable --now sc-server
```

Run `sc-server install` and every `systemctl --user` command as the login user, never through `sudo`. The full guide covers persisted ROM/core configuration, lingering, upgrades, and troubleshooting.

### Advanced managed system service

For a managed dedicated system account, use the repository installer:

```bash
sudo ./scripts/install.sh \
  --web-url https://your-gateway.example \
  --rom-dir /srv/storage/games/roms
```

Pair the managed host as the service account so credentials are written to the same config the unit reads:

```bash
sudo -u sprite-cloud env XDG_CONFIG_HOME=/etc \
  /usr/local/bin/sc-server pair ABCD-EFGH \
  --sc-web-url https://your-gateway.example
```

Do not run a plain `sc-server pair` as your login user for this system-service mode; that writes to your user config instead of `/etc/sprite-cloud/config.toml`.

Then start:

```bash
sudo systemctl enable --now sc-server
```

## Host config

`/etc/sprite-cloud/config.toml` for system services:

```toml
[sc_web]
url = "https://your-gateway.example"

[auth]
api_key = "scsk_..."
server_id = "..."

[rom]
roots = ["/srv/storage/games/roms"]

[cores]
dir = "/var/lib/sprite-cloud/cores"
```

## Verify

```bash
# gateway
curl -fsS https://your-gateway.example/api/health

# host
systemctl is-active sc-server
journalctl -u sc-server -n 100 --no-pager

# TURN, if used
ss -tuln | grep 3478
```

## Ports

| Port | Service | Access |
|---|---|---|
| 443 | sc-web through reverse proxy | public |
| 3000 | sc-web host-network app | local/proxy |
| 3478 | TURN | public UDP/TCP if configured |
| 5432 | PostgreSQL (host-network on current VPS) | private only |
| 8787 | sc-server local player endpoint | LAN/host network |

## Crash recovery

- `sc-server` should run under systemd with `Restart=on-failure`.
- `sc-web` should run under Docker Compose with `restart: unless-stopped`.
- The browser can re-request a session if the host restarts.
