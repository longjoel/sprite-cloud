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

### 1. Install gv-server

```bash
# From GitHub Releases (once CI is set up):
curl -fsSL https://get.gamesvault.app | sh

# For now: build from source
git clone https://github.com/longjoel/sprite-cloud
cd sprite-cloud
cargo build --release -p gv-core -p gv-server
sudo cp target/release/gv-server /usr/local/bin/
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

### 2. Pair with a gateway

```
1. Go to the gateway → Dashboard → "Generate pairing code"
2. Copy the command shown:
   gv-server pair ABCD-EFGH --gv-web-url https://your-gateway.com
3. Run it on your host machine
```

This saves your server's credentials to `~/.config/sprite-cloud/config.toml`.

### 3. Point at your ROMs

```bash
export GV_ROM_ROOTS=/path/to/roms,/path/to/more
```

### 4. Start

```bash
gv-server start
```

Your games appear in the library. Anyone with a gateway account can play them.

### Optional: Run at boot

```bash
systemctl enable --now gv-server
```

---

## ⚙️ Admin (run your own gateway)

The gateway is the web interface — sign-up, library, pairing, and command routing. One gateway serves many hosts and players.

### Requirements

- A server with Docker + public domain (or LAN)
- 2 GB RAM, Postgres + Node.js

### 1. Clone and start

```bash
git clone https://github.com/longjoel/sprite-cloud
cd sprite-cloud
```

Create a `docker-compose.yml` in a deploy directory:

```yaml
services:
  postgres:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: games_vault
      POSTGRES_PASSWORD: your-db-password
      POSTGRES_DB: games_vault
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U games_vault"]
      interval: 5s

  gv-web:
    build:
      context: .
      dockerfile: docker/gv-web/Dockerfile.prod
    restart: unless-stopped
    ports:
      - "3000:3000"
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      AUTH_SECRET: $(openssl rand -hex 32)
      AUTH_URL: https://your-domain.com
      DATABASE_URL: postgresql://games_vault:your-db-password@postgres:5432/games_vault
      GV_WEB_SCHEMA_PUSH_ON_START: "1"
      GV_ICE_STUN_URLS: stun:stun.l.google.com:19302
      # Optional TURN (recommended for players outside LAN):
      GV_ICE_TURN_URLS: turn:your-turn-server:3478
      GV_ICE_TURN_USERNAME: turn-user
      GV_ICE_TURN_CREDENTIAL: turn-pass

volumes:
  pgdata:
```

```bash
docker compose up -d
```

### 2. First-run setup

```bash
docker logs gv-web-gv-web-1   # shows the setup code
```

Visit `https://your-domain.com/setup` → enter the code → create admin account.

### 3. Done

Your gateway is live. Send the URL to players and hosts.

---

## 🔗 How it connects

```
Browser (player)
    │  WebRTC (video + input)
    ▼
gv-server (host) ── polls ──▶ gv-web (gateway)
    │                            │
    └── streams game ◀───────────┘  (routes commands)
```

- **Player** visits the gateway, clicks Play → browser gets a WebRTC offer
- **Host** polls the gateway for commands → runs the game in-process → streams video
- **Gateway** handles auth, library, pairing, and command queuing

No port forwarding on the host. WebRTC + TURN handles NAT traversal.

---

## 📦 What runs where

| Component | Machine | Purpose |
|-----------|---------|---------|
| Browser | Player's device | WebRTC client, gamepad input |
| gv-server | Host machine | Polls gateway, runs emulator cores, encodes video/audio |
| gv-web | Gateway server | Web UI, auth, library, pairing |
| Postgres | Gateway server | Users, servers, games, sessions |
| TURN server | Any public VPS | NAT traversal relay |
