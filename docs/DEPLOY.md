# Deployment Guide

Running Games Vault in production on a Linux server.

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Nginx (reverse proxy, TLS termination)          │
│  ├─ vault.local:8080  → gv-web :3001            │
│  └─ *.lngnckr.tech    → Traefik                 │
├─────────────────────────────────────────────────┤
│  gv-web       Next.js (pnpm start)              │
│  gv-server    systemd service                    │
│  gv-worker    spawned by gv-server (dynamic port)│
├─────────────────────────────────────────────────┤
│  PostgreSQL   :5432                              │
└─────────────────────────────────────────────────┘
```

---

## Directory layout

```
/opt/games-vault/           Application root
├── gv-server               gv-server binary (release build)
├── gv-worker                gv-worker binary (release build)
├── RELEASE_COMMIT           Git SHA of deployed version
└── (gv-web served from /opt/gv-web/)

/etc/systemd/system/
├── gv-server.service        gv-server unit
└── gv-web.service           (if not using process manager)

/etc/games-vault.env         Environment file for systemd
/var/log/games-vault/        JSON log output
```

---

## Build

### Rust binaries

```bash
# gv-server
cargo build --release -p gv-server
cp target/release/gv-server /opt/games-vault/gv-server

# gv-worker
cargo build --release -p gv-worker
cp target/release/gv-worker /opt/games-vault/gv-worker
```

### Next.js (gv-web)

```bash
cd gv-web
cp .env.example .env.production
# Edit .env.production with production values
pnpm install --frozen-lockfile
pnpm build
# Serve with: pnpm start (or PM2/systemd)
```

---

## Systemd unit

### gv-server

```ini
# /etc/systemd/system/gv-server.service
[Unit]
Description=Games Vault Server
After=network.target postgresql.service

[Service]
Type=simple
User=games-vault
Group=games-vault
WorkingDirectory=/opt/games-vault
EnvironmentFile=/etc/games-vault.env
ExecStart=/opt/games-vault/gv-server run
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=gv-server

# Security hardening
ProtectSystem=full
ProtectHome=yes
NoNewPrivileges=yes
ReadWritePaths=/opt/games-vault /tmp/gv-workers

[Install]
WantedBy=multi-user.target
```

### Activate

```bash
systemctl daemon-reload
systemctl enable gv-server
systemctl start gv-server
systemctl status gv-server
```

---

## Reverse proxy

### Nginx (Vault — bare metal)

```nginx
server {
    listen 8080;
    server_name vault.local;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # WebSocket support (Next.js HMR in dev, player connections)
    location /_next/webpack-hmr {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

### Traefik (gv-test VPS — Docker)

```yaml
# docker-compose.yml
labels:
  - "traefik.enable=true"
  - "traefik.http.routers.gv-test.rule=Host(`gv-test.lngnckr.tech`)"
  - "traefik.http.services.gv-test.loadbalancer.server.port=28080"
```

The app container uses `network_mode: host` so it binds to `127.0.0.1:28080`.
Traefik routes the external domain to this port.

---

## Environment file

```bash
# /etc/games-vault.env
GV_WORKER_BIN=/opt/games-vault/gv-worker
GV_WORKER_HOST=vault.local
GV_WEB_URL=http://localhost:3001
GV_WEB_TIMEOUT_SECS=30
STUN_SERVER=stun:stun.l.google.com:19302
TARGET_BITRATE_KBPS=500
ALLOWED_ORIGIN=http://vault.local:8080
```

---

## Logging

All Rust components output JSON to stdout. systemd captures this in the
journal. View logs:

```bash
journalctl -u gv-server -f          # follow
journalctl -u gv-server --since today
journalctl -u gv-server -n 100      # last 100 lines
```

Log rotation is handled by journald (`/etc/systemd/journald.conf`).

### Sample log entry

```json
{
  "timestamp": "2026-06-14T00:10:09.929Z",
  "level": "INFO",
  "fields": { "message": "gv-worker listening on port 54321" },
  "span": { "service": "gv-worker", "name": "" }
}
```

---

## Firewall

gv-worker ports are dynamic (0–65535). The reverse proxy handles all
external traffic — workers are only accessed on the LAN or via the proxy.

- **gv-web** port (3001): exposed to LAN via reverse proxy
- **gv-worker** ports (dynamic): LAN-only, CORS-gated
- **PostgreSQL** (5432): localhost only
- **WebRTC** ports: ephemeral UDP (ICE/STUN) — handled by the browser and worker directly

---

## Health check / monitoring

### gv-web

```bash
curl -s http://vault.local:8080/api/health
# {"status":"ok"}
```

### gv-server

```bash
systemctl is-active gv-server
# active
```

### gv-worker

Workers are ephemeral (one per game session). Health is checked by
gv-server at spawn time (`GET /health`).

---

## gv-test VPS (staging)

A separate Docker Compose deployment on a VPS for pre-production testing.

- **Host:** `srv1516066` (72.62.243.69)
- **Domain:** `gv-test.lngnckr.tech`
- **Stack:** Traefik → gv-test-app (:28080, `network_mode: host`) + PostgreSQL (:5433)
- **Deploy path:** `/docker/games-vault-test/`

```bash
# Deploy to gv-test
rsync -avz gv-web/ vps:/docker/games-vault-test/src/gv-web/
ssh vps "cd /docker/games-vault-test && docker compose build app && docker compose up -d app"
```

---

## Crash recovery

- gv-server restarts automatically (systemd `Restart=always`)
- On restart, `reap_stale_workers()` kills any workers left behind by a
  previous crash (scans `/tmp/gv-workers/` for PID files)
- gv-web does NOT auto-restart workers — the browser must re-submit a
  `start_game` command
