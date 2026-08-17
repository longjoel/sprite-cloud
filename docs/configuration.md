# Configuration Reference

Configuration for the current Sprite Cloud architecture: `sc-web` gateway + `sc-server` host runtime.

## sc-web gateway

File: `sc-web/.env.local` for local dev, or container environment in production.

| Variable | Required | Description |
|---|---:|---|
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `AUTH_SECRET` | yes | Auth.js/NextAuth session secret (`openssl rand -base64 32`) |
| `AUTH_URL` / `NEXTAUTH_URL` | prod | Public gateway origin, e.g. `https://games.example.com` |
| `GV_WEB_SCHEMA_PUSH_ON_START` | no | `1` only to initialize an empty database; nonempty databases refuse startup schema pushes |
| `GV_WEB_SKIP_SETUP_INIT` | no | `1` to suppress first-run setup-code generation |
| `GV_ICE_STUN_URLS` | no | Comma-separated STUN URLs; defaults to Google STUN when empty |
| `GV_ICE_TURN_URLS` | no | Comma-separated TURN URLs |
| `GV_ICE_TURN_USERNAME` | no | TURN username |
| `GV_ICE_TURN_CREDENTIAL` | no | TURN credential |
| `GV_ICE_TRANSPORT_POLICY` | no | `all` or `relay`; default `all` |

Auth is DB-backed email/password and enrollment is invite-only. When the
`users` table is empty, the server initializes a protected one-time bootstrap
invitation and emits its URL to server logs. Open that invitation at `/setup`
to create the first admin account. Subsequent accounts require an invitation
from an existing administrator; there is no public signup or reusable setup
code.

## sc-server host runtime

`sc-server setup` writes the persistent ROM, core, gateway, and ICE configuration. `sc-server pair <CODE> --sc-web-url <URL>` adds or refreshes credentials without discarding those setup choices.

For the complete lifecycle, see **[SC-SERVER-INSTALL.md](SC-SERVER-INSTALL.md)**.

The CLI normally uses the user XDG configuration directory. `/etc/sprite-cloud/config.toml` is selected only when a managed system unit explicitly sets `XDG_CONFIG_HOME=/etc`; pair that unit as its service account.

Config locations:

| Install mode | Path |
|---|---|
| user/rootless | `~/.config/sprite-cloud/config.toml` |
| system service | `/etc/sprite-cloud/config.toml` when `XDG_CONFIG_HOME=/etc` |

Example:

```toml
[sc_web]
url = "https://games.example.com"

[auth]
api_key = "scsk_..."
server_id = "..."

[rom]
roots = ["/srv/storage/games/roms"]

[cores]
dir = "/usr/lib/libretro"

[dat]
dir = "/etc/sprite-cloud/dats"
files = ["/data/nointro/snes.dat"]
```

### DAT catalog (`[dat]`)

Optional. Points `sc-server` at No-Intro/Redump `.dat` catalogs used to
enrich staged ROMs with canonical identity (see the DAT matching policy in
the ingestion docs):

- `dir` — a directory scanned (non-recursively) for `*.dat` files, loaded
  in sorted filename order.
- `files` — an explicit list of DAT file paths, loaded after `dir`
  contents. Entries may live anywhere on disk.

Load behavior:

- At startup the server parses every configured catalog into one bounded
  in-memory index (per-file resource limits plus aggregate caps) and logs
  each catalog's name, version, and entry count.
- **No DAT → auto-commit; DAT match → `RomVerified` + canonical identity;
  DAT available but no match → `Unverified`.** DAT matching never blocks a
  commit.
- Rejected catalogs (unreadable, unparseable, over limits) are logged by
  filename and skipped; ROM uploads fall back to the no-DAT behavior.
- Send `SIGHUP` (or `systemctl reload` where wired) to re-read the config
  and atomically replace the index. If any configured catalog fails to
  load, the previous index stays in effect (last known-good).

Runtime env vars:

| Variable | Default | Description |
|---|---|---|
| `GV_WEB_TIMEOUT_SECS` | `30` | HTTP request timeout for gateway API calls |
| `GV_ROM_ROOTS` | `[rom].roots` from config | Comma-separated runtime override for persisted ROM roots |
| `GV_CORES_DIR` | `[cores].dir` from config, then workspace fallback | Runtime override for the persisted libretro core directory |
| `GV_BUILDBOT_URL` | libretro buildbot | Core download base URL |
| `GV_WORKER_HOST` | auto-detected LAN IP | Compatibility name for the host/IP advertised in player URLs for the local player endpoint |
| `GV_WORKER_PORT` | `8787` | Compatibility name for the port advertised in player URLs |
| `GV_PLAYER_BIND` | `0.0.0.0:8787` | Local player HTTP bind address |
| `GV_DATA_DIR` | platform local-data directory | Mutable server data directory, including shared library preferences |
| `GV_LIBRARY_STATE_PATH` | `$GV_DATA_DIR/library-state.json` | Explicit shared library preference/history file path |
| `GV_SAVE_DIR` | temp/default | Save-state/SRAM directory |
| `GV_SYSTEM_DIR` | temp/default | BIOS/system directory |

`GV_WORKER_HOST`/`GV_WORKER_PORT` are compatibility names for the browser-facing local player endpoint.

Explicit environment variables take precedence over persisted ROM/core values. Without an override, paired and standalone startup both load the values saved by setup.

Persistence boundaries:

| State | Default user path | Upgrade behavior |
|---|---|---|
| Pairing and setup config | `~/.config/sprite-cloud/config.toml` | preserved |
| Shared library preferences/history | `~/.local/share/sprite-cloud/library-state.json` | preserved |
| Downloaded cores | `[cores].dir` / `GV_CORES_DIR` | preserved outside the binary |
| Other mutable server data | `GV_DATA_DIR` | preserved outside the binary |

Do not remove these paths during an upgrade. The public installer replaces only the verified executable.

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
