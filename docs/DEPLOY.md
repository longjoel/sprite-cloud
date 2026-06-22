# Deployment Guide

Production deployment of Games Vault across two machines: the **VAULT** (bare-metal host running gv-server + gv-worker) and the **VPS** (Docker host running gv-web + PostgreSQL + coturn).

---

## Architecture

```
┌──────────────────────────────────────────────────────┐
│  VPS (lngnckr.tech)                                  │
│  ├─ Traefik → gv-web (:3000, host network)           │
│  ├─ PostgreSQL (:5432)                               │
│  └─ coturn (:3478/udp, :3478/tcp)                    │
├──────────────────────────────────────────────────────┤
│  VAULT (N100, 192.168.86.126)                        │
│  ├─ gv-server  systemd service                       │
│  └─ gv-worker  spawned on demand (dynamic port)      │
└──────────────────────────────────────────────────────┘
```

gv-web runs **only** on the VPS. The VAULT has no web server — gv-server polls the VPS-hosted gv-web for commands.

---

## Directory layout

### VAULT (bare metal)

```
/usr/local/bin/
├── gv-server          gv-server release binary
└── gv-worker           gv-worker release binary

/etc/games-vault/
└── config.toml         gv-server config (web URL, auth, ROM roots)

/var/lib/games-vault/
├── RELEASE_COMMIT      deployed git SHA
├── RELEASE_MANIFEST.json
└── cores/              libretro core .so files

/var/log/games-vault/   JSON log output (via journald)
/tmp/gv-workers/        worker PID files
```

### VPS (Docker)

```
/docker/gv-web/
├── docker-compose.yml
├── .env                env vars (secrets: AUTH_SECRET, DATABASE_URL)
├── RELEASE_COMMIT      deployed git SHA
└── RELEASE_MANIFEST.json
```

---

## Build

All Rust binaries and the web bundle are built from the monorepo root:

```bash
cd ~/projects/games-vault

# Option A: full release build + deploy scripts
./scripts/build-release.sh

# Option B: manual
cargo build --release -p gv-server -p gv-worker
cd gv-web && pnpm build
```

---

## Deploy

Use the release scripts. Do NOT deploy manually unless debugging.

### Host (VAULT)

```bash
./scripts/deploy-vault.sh          # build + install + restart
./scripts/deploy-vault.sh --no-restart   # install without restarting
```

What it does:
1. Runs `build-release.sh` (Rust release + gv-web prod bundle)
2. Installs `gv-server` and `gv-worker` to `/usr/local/bin/`
3. Writes `RELEASE_COMMIT` and `RELEASE_MANIFEST.json` to `/var/lib/games-vault/`
4. Restarts `gv-server.service`

### Web (VPS)

```bash
./scripts/deploy-vps-web.sh          # build + ship + restart + health check
./scripts/deploy-vps-web.sh --skip-build  # ship pre-built artifacts
```

What it does:
1. Runs `build-release.sh` (if not skipped)
2. Builds Docker image `gv-web-prod:<sha>` and `gv-web-prod:latest`
3. Ships image to VPS via `docker save | gzip | ssh | docker load`
4. Restarts the `gv-web` service via `docker compose up -d`
5. Polls `https://lngnckr.tech/api/health` until it responds

---

## Verify

After every deploy:

```bash
./scripts/smoke-test.sh
```

Checks:
- Local release marker present at `/var/lib/games-vault/RELEASE_COMMIT`
- Remote release marker present at `/docker/gv-web/RELEASE_COMMIT`
- VPS public health endpoint returns 200

---

## Systemd unit

Repo-tracked at `ops/vault/gv-server.service`. Deploy with:

```bash
sudo cp ops/vault/gv-server.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now gv-server
```

### Key details

| Setting | Value | Why |
|---------|-------|-----|
| `User` | `games-vault` | dedicated service account |
| `EnvironmentFile` | `/etc/games-vault.env` | ICE/STUN/TURN vars |
| `XDG_CONFIG_HOME` | `/etc` | config path → `/etc/games-vault/config.toml` |
| `ExecStartPre` | `mkdir -p /tmp/gv-workers` | worker PID dir |
| `ProtectSystem` | `strict` | read-only filesystem except listed paths |
| `ReadWritePaths` | `/var/lib/games-vault`, `/tmp/gv-workers` | |
| `DeviceAllow` | `/dev/dri rw` | GPU access for encoding |

---

## Configuration

### gv-server (`/etc/games-vault/config.toml`)

```toml
[gv_web]
url = "https://lngnckr.tech"
worker_bin = "/usr/local/bin/gv-worker"

[auth]
api_key = "gvsk_..."
server_id = "9e0bf60c-..."

[rom]
roots = ["/srv/storage/games/roms"]
```

### gv-web env (`/docker/gv-web/.env`)

Template at `ops/vps/.env.example`. Required vars:

| Var | Purpose |
|-----|---------|
| `AUTH_SECRET` | NextAuth session encryption (secret) |
| `DATABASE_URL` | PostgreSQL connection string (secret — contains password) |
| `GV_ICE_STUN_URLS` | comma-separated STUN URLs |
| `GV_ICE_TURN_URLS` | comma-separated TURN URLs |
| `GV_ICE_TURN_USERNAME` | TURN username |
| `GV_ICE_TURN_CREDENTIAL` | TURN credential (secret) |

---

## Logging

All Rust components log structured JSON to stdout. systemd captures into journald.

```bash
journalctl -u gv-server -f          # follow
journalctl -u gv-server --since today
journalctl -u gv-server -n 100      # last 100 lines
```

---

## Health checks

```bash
# gv-web (public)
curl -s https://lngnckr.tech/api/health

# gv-server
systemctl is-active gv-server

# TURN
ss -tuln | grep 3478

# Release markers
cat /var/lib/games-vault/RELEASE_COMMIT
ssh root@lngnckr.tech 'cat /docker/gv-web/RELEASE_COMMIT'
```

---

## Firewall / ports

| Port | Service | Access |
|------|---------|--------|
| 443  | gv-web (Traefik) | public |
| 3478 | coturn TURN | public (UDP + TCP) |
| 5432 | PostgreSQL | VPS localhost only |
| dynamic | gv-worker WebRTC/HTTP | LAN only, CORS-gated |

---

## Crash recovery

- **gv-server** restarts automatically (`Restart=on-failure`, 5s delay)
- **gv-web** restarts automatically (`restart: unless-stopped` in Docker Compose)
- Worker processes are ephemeral — gv-server spawns new ones on demand
- On server restart, `reap_stale_workers()` cleans up orphaned workers from `/tmp/gv-workers/`
- The browser must re-submit a `start_game` command after a worker crash
