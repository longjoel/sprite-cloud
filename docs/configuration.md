# Configuration Reference

Every configuration knob across the v2 monorepo. Environment variables,
config files, and CLI arguments.

---

## gv-worker (Rust)

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `STUN_SERVER` | `stun:stun.l.google.com:19302` | STUN/TURN server for WebRTC NAT traversal. Format: `stun:host:port` or `turn:host:port?transport=tcp`. Production MUST use a dedicated TURN server. |
| `TARGET_BITRATE_KBPS` | `500` | VP8 encoder target bitrate (kbps). Conservative for 320×240. Tune for available bandwidth. |
| `ALLOWED_ORIGIN` | auto-detect | Comma-separated CORS origins. Dev default: `localhost:3001` + auto-detected LAN IP subnet (`/24`). Production: set to your gv-web URL. |

### Compile-time constants (`config.rs`)

| Constant | Value | Description |
|----------|-------|-------------|
| `VIDEO_WIDTH` | `320` | Video frame width (QVGA) |
| `VIDEO_HEIGHT` | `240` | Video frame height |
| `VIDEO_FPS` | `30` | Target frames per second |
| `FRAME_INTERVAL_MS` | `33` | Duration of one frame in ms |
| `AUDIO_SAMPLE_RATE` | `48_000` | Opus sample rate |
| `AUDIO_CHANNELS` | `2` | Stereo audio |
| `DC_RECEIVE_TIMEOUT_SECS` | `5` | Wait for browser DataChannel after SDP |
| `STATS_SEND_INTERVAL` | `5` | Send stats every N frames (~6 Hz) |
| `ICE_GATHERING_TIMEOUT_SECS` | `10` | Max wait for ICE candidate gathering |

### CLI arguments

```
gv-worker <port>
```

| Argument | Description |
|----------|-------------|
| `port` | Port to listen on. `0` = random available port (printed to stderr as `WORKER_READY port=N`). |

---

## gv-server (Rust)

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GV_WORKER_BIN` | auto-detect | Path to gv-worker-v2 binary. Resolution order: `config.toml` → env var → auto-detect (`./target/release/gv-worker-v2` → `./target/debug/gv-worker-v2`). |
| `GV_WORKER_HOST` | auto-detected LAN IP | Hostname in the worker connect URL sent to the browser. Falls back to `localhost`. |
| `GV_WEB_TIMEOUT_SECS` | `30` | HTTP request timeout for gv-web API calls (seconds). |
| `STUN_SERVER` | — | Passed through to gv-worker on spawn. |

### Config file

Location: `~/.config/games-vault/config.toml` (created by `gv-server pair`).

```toml
[gv_web]
url = "http://localhost:3001"
# worker_bin = "/opt/games-vault/gv-worker"  # optional

[auth]
api_key = "..."
server_id = "..."
```

### CLI arguments

```
gv-server pair [--url <gv-web-url>]
gv-server run [--url <gv-web-url>]
```

| Command | Description |
|---------|-------------|
| `pair` | Pair with gv-web using a 8-letter code, write `config.toml`. |
| `run` | Start polling for commands and managing workers. |

---

## gv-web (TypeScript / Next.js)

### Environment variables

File: `gv-web/.env.local` (gitignored). Template: `gv-web/.env.example`.

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | ✓ | PostgreSQL connection string |
| `AUTH_SECRET` | ✓ | NextAuth.js signing secret (`openssl rand -base64 32`) |
| `AUTH_GITHUB_ID` | ✓ | GitHub OAuth client ID |
| `AUTH_GITHUB_SECRET` | ✓ | GitHub OAuth client secret |
| `SERVER_API_KEY` | dev only | API key for the paired dev server (used by `/dev` dashboard) |
| `LAN_USER` | optional | LAN credentials auth username (enables the credentials provider) |
| `LAN_PASS` | optional | LAN credentials auth password |

### OAuth callback URL

```
http://<vault-host>:8080/api/auth/callback/github
```

Registered in the GitHub OAuth app settings.

---

## gv-player (JavaScript)

No env vars. Configuration via URL query parameters:

| Parameter | Required | Description |
|-----------|----------|-------------|
| `?worker=` | ✓ | Worker URL (e.g., `http://192.168.86.126:42757`). Auto-connects on load. |

Compile-time constants in `index.js`:

| Constant | Value | Description |
|----------|-------|-------------|
| `STUN_SERVER` | `stun:stun.l.google.com:19302` | WebRTC NAT traversal |
| `ICE_TIMEOUT_MS` | `15_000` | ICE gathering timeout |
| `DISCONNECTED_GRACE_MS` | `5_000` | Recovery grace period after disconnect |
| `PING_INTERVAL_MS` | `2000` | RTT ping interval |
| `MAX_PENDING_PINGS` | `20` | Max pending pings before clearing |

---

## .env.example files

Two `.env.example` files exist:

| File | Scope | Notes |
|------|-------|-------|
| `/.env.example` | Rust binaries (gv-server, gv-worker) | Sourced by the shell, not read by the binaries directly (they use `std::env::var`) |
| `gv-web/.env.example` | Next.js app | Copied to `.env.local` for local dev. Committed values are `***` placeholders. |

---

## Audit checklist

When adding a new env var or config knob:

1. ✓ Is it in the appropriate `.env.example`?
2. ✓ Is it excluded from git (`.env.local` in `.gitignore`)?
3. ✓ Does it have a reasonable default for dev?
4. ✓ Is the production value documented?
5. ✓ Are runtime-configurable constants committed with their `.env.example` entry in the same commit?
