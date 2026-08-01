# Sprite Cloud — Quickstart

Three roles. Pick yours.

| You want to… | You need | Time |
|---|---|---|
| **Play** games | A browser | 30 seconds |
| **Host** games (share your ROMs) | A Linux machine with ROMs | 5 minutes |
| **Admin** (run the gateway) | A server with Docker | 10 minutes |

---

## 🎮 Play

```
1. Open your browser
2. Go to the gateway URL (your admin sends this)
3. Sign up with email + password
4. Click a game → Play
```

That's it. WebRTC runs in the browser — no install, no plugins.

---

## 🖥️ Host (share your ROMs)

You need a Linux machine with your ROM files. The host streams games to players through a gateway.

### 1. Install sc-server

```bash
curl -fsSL https://sprite-cloud.com/install.sh | bash
sc-server setup

# Or build from source:
cargo build --release -p sc-core -p sc-server
sudo cp target/release/sc-server /usr/local/bin/
```

This also needs GStreamer (VP8 + Opus encoding):

```bash
# Debian/Ubuntu
sudo apt install gstreamer1.0-plugins-bad gstreamer1.0-plugins-good gstreamer1.0-plugins-ugly

# Fedora
sudo dnf install gstreamer1-plugins-bad-free gstreamer1-plugins-good gstreamer1-plugins-ugly-free

# Arch
sudo pacman -S gst-plugins-bad gst-plugins-good gst-plugins-ugly
```

Setup saves the ROM root and core directory in `~/.config/sprite-cloud/config.toml`. Those values survive pairing, service restarts, and binary upgrades.

Full installation, upgrade, systemd, persistence, and troubleshooting documentation: **[docs/SC-SERVER-INSTALL.md](docs/SC-SERVER-INSTALL.md)**.

### 2. Pair with a gateway

```
1. Go to the gateway → Dashboard → "Generate pairing code"
2. Copy the command shown:
   sc-server pair ABCD-EFGH --sc-web-url https://your-gateway.com
3. Run it on your host machine
```

This saves your server's credentials to `~/.config/sprite-cloud/config.toml`.

### 3. Start

```bash
sc-server start
```

Your server-owned library appears through the gateway. ROM metadata and filesystem paths remain on the game host.

### Optional: Run at boot

```bash
sc-server install
systemctl --user daemon-reload
systemctl --user enable --now sc-server
```

Run all three commands as your login user. Do not prefix `systemctl --user` with `sudo`.

---

## ⚙️ Admin (run your own gateway)

The gateway is the web interface for sign-up, pairing, coordination, and signaling. Each `sc-server` owns its local game library and metadata. One gateway serves many hosts and players.

### Requirements

- A server with Docker, Docker Compose, and OpenSSL + public domain (or LAN)
- 2 GB RAM, Postgres + Node.js

### 1. Clone and start

```bash
git clone https://github.com/longjoel/sprite-cloud
cd sprite-cloud
```

Generate a protected `.env` file before starting Compose:

```bash
if [ -e .env ]; then
  echo ".env already exists; refusing to replace deployed secrets" >&2
  exit 1
fi
umask 077
cat > .env <<EOF
POSTGRES_PASSWORD=$(openssl rand -hex 32)
AUTH_SECRET=$(openssl rand -hex 32)
AUTH_URL=https://your-domain.com
EOF
```

Replace `AUTH_URL` with the public origin for your gateway. Keep `.env` private and backed up: changing `POSTGRES_PASSWORD` after Postgres initializes does not change the database user's existing password.

Create a `docker-compose.yml` in the same deploy directory:

```yaml
services:
  postgres:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: sprite_cloud
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env}
      POSTGRES_DB: sprite_cloud
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U sprite_cloud"]
      interval: 5s

  sc-web:
    build:
      context: .
      dockerfile: docker/sc-web/Dockerfile.prod
    restart: unless-stopped
    ports:
      - "3000:3000"
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      AUTH_SECRET: ${AUTH_SECRET:?set AUTH_SECRET in .env}
      AUTH_URL: ${AUTH_URL:?set AUTH_URL in .env}
      DATABASE_URL: postgresql://sprite_cloud:${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env}@postgres:5432/sprite_cloud
      # Empty-database initialization only; existing DBs require explicit migrations.
      GV_WEB_SCHEMA_PUSH_ON_START: "1"
      GV_ICE_STUN_URLS: stun:stun.l.google.com:19302
      # Optional TURN (recommended for players outside LAN):
      # GV_ICE_TURN_URLS: turn:your-turn-server:3478
      # GV_ICE_TURN_USERNAME: turn-user
      # GV_ICE_TURN_CREDENTIAL: replace-with-a-generated-secret

volumes:
  pgdata:
```

```bash
docker compose up -d
```

### 2. First-run setup

```bash
docker logs sc-web-sc-web-1   # shows the setup code
```

Visit `https://your-domain.com/setup` → enter the code → create admin account.

### 3. Connectivity health check

Open:

```text
https://your-domain.com/api/health
```

Look for the `connectivity` block.

Use these product-language modes:

- `lan-only` → same-machine/LAN play only; remote guests are not reliable yet
- `stun-capable` → normal home-network guests may work; hostile NAT / cellular may still fail
- `turn-capable` → recommended mode for reliable remote guest multiplayer
- `misconfigured` → TURN looks configured but is unusable; fix credentials/config before testing again

Healthy example for remote guests:

```json
{
  "mode": "turn-capable",
  "turn_ready": true,
  "transport_policy": "all"
}
```

Unhealthy example:

```json
{
  "mode": "misconfigured",
  "turn_ready": false,
  "diagnostics": [
    "TURN URL is configured but username/credential is missing — relay is not actually usable."
  ]
}
```

### 4. Done

Your gateway is live. Send the URL to players and hosts.

---

## 🔗 How it connects

```
Browser (player)
    │  WebRTC (video + input)
    ▼
sc-server (host) ── polls ──▶ sc-web (gateway)
    │                            │
    └── streams game ◀───────────┘  (routes commands)
```

- **Player** visits the gateway, clicks Play → browser gets a WebRTC offer
- **Host** polls the gateway for commands → runs the game in-process → streams video
- **Gateway** handles auth, pairing, coordination, signaling, and command queuing

No port forwarding on the host. WebRTC + TURN handles NAT traversal.

---

## 📦 What runs where

| Component | Machine | Purpose |
|-----------|---------|---------|
| Browser | Player's device | WebRTC client, gamepad input |
| sc-server | Host machine | Polls gateway, runs emulator cores, encodes video/audio |
| sc-web | Gateway server | Web UI, auth, pairing, coordination, signaling |
| Postgres | Gateway server | Users, server registrations, sessions, coordination state |
| TURN server | Any public VPS | NAT traversal relay |
