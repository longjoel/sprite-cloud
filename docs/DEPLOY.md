# Deployment Guide

Production Games Vault has two roles:

| Role | Runs where | Purpose |
|---|---|---|
| Gateway | Docker/VPS/server | `gv-web` + PostgreSQL + optional TURN |
| Host | Linux box with ROMs/GPU | `gv-server` systemd service |

`gv-worker` is not deployed separately; the runtime is merged into `gv-server`.

## Architecture

```text
┌──────────────────────────────────────────────────────┐
│ Gateway server                                       │
│  ├─ reverse proxy / TLS → gv-web (:3000)             │
│  ├─ PostgreSQL                                       │
│  └─ optional coturn (:3478 udp/tcp)                  │
├──────────────────────────────────────────────────────┤
│ Host machine                                         │
│  ├─ gv-server systemd service                        │
│  ├─ ROM roots                                        │
│  └─ libretro core cache                              │
└──────────────────────────────────────────────────────┘
```

gv-server polls gv-web for commands. Players use the gateway URL in their browser; WebRTC handles media transport.

## Build

From the repo root:

```bash
./scripts/build-release.sh
```

Manual equivalent:

```bash
cargo build --release -p gv-server
cd gv-web
pnpm install --frozen-lockfile
pnpm build
```

## Gateway deploy

Use a deploy directory containing `ops/vps/docker-compose.yml` and an `.env` derived from `ops/vps/.env.example`.

Required env:

| Var | Purpose |
|---|---|
| `AUTH_SECRET` | Auth.js/NextAuth session encryption |
| `AUTH_URL` | Public gateway origin |
| `DATABASE_URL` | Postgres connection string |
| `GV_WEB_SCHEMA_PUSH_ON_START` | `1` for simple self-hosted schema updates |
| `GV_ICE_STUN_URLS` | STUN URLs |
| `GV_ICE_TURN_URLS` | TURN URLs, recommended for public internet play |
| `GV_ICE_TURN_USERNAME` | TURN username |
| `GV_ICE_TURN_CREDENTIAL` | TURN credential |

Start:

```bash
docker compose up -d
```

First run:

```bash
docker logs <gv-web-container>
# Copy the setup code, then visit https://your-gateway.example/setup
```

## Host deploy

Install `gv-server` and create a systemd service:

```bash
sudo install -m 755 target/release/gv-server /usr/local/bin/gv-server
sudo cp ops/dev-host/gv-server.service /etc/systemd/system/
sudo systemctl daemon-reload
```

Pair the host from the gateway dashboard:

```bash
gv-server pair ABCD-EFGH --gv-web-url https://your-gateway.example
```

Set ROM roots either in config or env:

```toml
[rom]
roots = ["/srv/storage/games/roms"]
```

Then start:

```bash
sudo systemctl enable --now gv-server
```

## Host config

`/etc/games-vault/config.toml` for system services:

```toml
[gv_web]
url = "https://your-gateway.example"

[auth]
api_key = "gvsk_..."
server_id = "..."

[rom]
roots = ["/srv/storage/games/roms"]
```

## Verify

```bash
# gateway
curl -fsS https://your-gateway.example/api/health

# host
systemctl is-active gv-server
journalctl -u gv-server -n 100 --no-pager

# TURN, if used
ss -tuln | grep 3478
```

## Ports

| Port | Service | Access |
|---|---|---|
| 443 | gv-web through reverse proxy | public |
| 3000 | gv-web container/app | local/proxy |
| 3478 | TURN | public UDP/TCP if configured |
| 5432 | PostgreSQL | private only |
| 8787 | gv-server local player endpoint | LAN/host network |

## Crash recovery

- `gv-server` should run under systemd with `Restart=on-failure`.
- `gv-web` should run under Docker Compose with `restart: unless-stopped`.
- The browser can re-request a session if the host restarts.
