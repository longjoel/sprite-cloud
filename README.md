# Games Vault

Retro game library and browser-based streaming. Monorepo.

## Architecture

```
gv-web          Next.js website (hosting, auth, library management)
gv-player       Vanilla JS WebRTC client — connects to gv-worker, plays video
gv-server       Rust binary — polls gv-web, spawns gv-worker on demand
gv-worker       Rust binary — per-game WebRTC peer with GStreamer VP8 + Opus encoding
```

Full protocol and wire formats: **[docs/PROTOCOL.md](docs/PROTOCOL.md)**

## Quick start

```bash
# 1. gv-web
cd gv-web
cp .env.example .env.local   # fill in GitHub OAuth + DB + SERVER_API_KEY
pnpm install
pnpm db:push                  # create tables
pnpm dev                      # http://localhost:3001

# 2. Pair a server
cd ..
cargo run -p gv-server -- pair <code-from-/dev>

# 3. Start the server
cargo run -p gv-server -- start

# 4. Build the worker
cargo build -p gv-worker-v2

# 5. Play — hit /dev, enter server_id, click Play
```

## Environment variables

See `.env.example` — single source of truth for all components.

## Deployment

For production, build with `--release` and set the worker binary path in
`~/.config/games-vault/config.toml`:

```toml
[gv_web]
url = "https://games.example.com"
worker_bin = "/opt/games-vault/gv-worker-v2"   # production binary

[auth]
api_key = "gvsk_..."
server_id = "a0000000-..."
```

`worker_bin` is optional — without it gv-server auto-detects
(`./target/release/gv-worker-v2` → `./target/debug/gv-worker-v2`) or falls back
to the `GV_WORKER_BIN` env var.

## Status

Early development — MVP video path working (WebRTC P2P, VP8 test pattern).
