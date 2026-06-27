# Configuration Reference

Configuration for the current Games Vault architecture: `gv-web` gateway + `gv-server` host runtime.

## gv-web gateway

File: `gv-web/.env.local` for local dev, or container environment in production.

| Variable | Required | Description |
|---|---:|---|
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `AUTH_SECRET` | yes | Auth.js/NextAuth session secret (`openssl rand -base64 32`) |
| `AUTH_URL` / `NEXTAUTH_URL` | prod | Public gateway origin, e.g. `https://games.example.com` |
| `GV_WEB_SCHEMA_PUSH_ON_START` | no | `1` to apply the current Drizzle schema on container startup |
| `GV_WEB_SKIP_SETUP_INIT` | no | `1` to suppress first-run setup-code generation |
| `GV_ICE_STUN_URLS` | no | Comma-separated STUN URLs; defaults to Google STUN when empty |
| `GV_ICE_TURN_URLS` | no | Comma-separated TURN URLs |
| `GV_ICE_TURN_USERNAME` | no | TURN username |
| `GV_ICE_TURN_CREDENTIAL` | no | TURN credential |
| `GV_ICE_TRANSPORT_POLICY` | no | `all` or `relay`; default `all` |

Auth is DB-backed email/password. First-run setup uses `/setup` and the setup code printed in container logs.

First admin account creation is handled by the `/setup` flow. When the `users` table is empty, the production entrypoint prints a one-time setup code to logs. Sign in to `/setup` with that code to create the first account.

## gv-server host runtime

`gv-server pair <CODE> --gv-web-url <URL>` writes the persistent config file.

Default config locations:

| Install mode | Path |
|---|---|
| user/rootless | `~/.config/games-vault/config.toml` |
| system service | `/etc/games-vault/config.toml` when `XDG_CONFIG_HOME=/etc` |

Example:

```toml
[gv_web]
url = "https://games.example.com"

[auth]
api_key = "gvsk_..."
server_id = "..."

[rom]
roots = ["/srv/storage/games/roms"]
```

Runtime env vars:

| Variable | Default | Description |
|---|---|---|
| `GV_WEB_TIMEOUT_SECS` | `30` | HTTP request timeout for gateway API calls |
| `GV_ROM_ROOTS` | from config | Comma-separated ROM roots used during pairing/startup |
| `GV_CORES_DIR` | workspace/test-data fallback | Libretro core cache/download directory |
| `GV_BUILDBOT_URL` | libretro buildbot | Core download base URL |
| `GV_WORKER_HOST` | auto-detected LAN IP | Compatibility name for the host/IP advertised in player URLs for the local player endpoint |
| `GV_WORKER_PORT` | `8787` | Compatibility name for the port advertised in player URLs |
| `GV_PLAYER_BIND` | `0.0.0.0:8787` | Local player HTTP bind address |
| `GV_SAVE_DIR` | temp/default | Save-state/SRAM directory |
| `GV_SYSTEM_DIR` | temp/default | BIOS/system directory |

`GV_WORKER_HOST`/`GV_WORKER_PORT` are compatibility names for the browser-facing local player endpoint.

## Core overrides

Override platform → core mapping with:

```bash
GV_CORE_OVERRIDE_PlayStation=swanstation_libretro.so
GV_CORE_OVERRIDE_Arcade=mame2003_plus_libretro.so
```

Platform names are sanitized by replacing spaces/hyphens with underscores.

## GStreamer tuning

| Variable | Default | Description |
|---|---|---|
| `GV_GST_VIDEO_CPU_USED` | `4` | Encoder speed/quality tradeoff |
| `GV_GST_VIDEO_THREADS` | `4` | Encoder threads |
| `GV_GST_VIDEO_BITRATE_KBPS` | `2000` | Video bitrate target |
| `GV_GST_VIDEO_DEADLINE` | `1` | Realtime encoder deadline |
| `GV_GST_VIDEO_SCALE_HEIGHT` | `0` | Integer-scale target height; `0` disables |
| `GV_GST_VIDEO_MAX_SCALE` | `4` | Max integer scale factor |
| `GV_GST_VIDEO_KEYFRAME_MAX_DIST` | `150` | Keyframe interval |
| `GV_GST_AUDIO_BITRATE` | `64000` | Opus bitrate |

## Audit checklist

When adding a config knob:

1. Add it to `.env.example` or config docs.
2. Keep secrets out of committed files.
3. Avoid hardcoded deployment domains.
4. Ensure the default is safe for public self-hosters.
5. Add/adjust tests if behavior changes.
