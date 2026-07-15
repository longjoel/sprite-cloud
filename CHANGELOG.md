# Changelog

All notable changes to Sprite Cloud will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims for [Semantic Versioning](https://semver.org/spec/v2.0.0.html) after the initial public release.

## v0.3.5 — 2026-07-15

### Added
- **Steam Deck desktop client**: Tauri v2 native app with AppImage build
  - Native gamepad polling via `gilrs` — bypasses Steam Input and browser Gamepad API entirely
  - Bridges raw gamepad state into webview, replacing `navigator.getGamepads()`
  - RetroPad button mapping for SNES/Genesis/Game Boy controller layouts
  - Fullscreen XMB shell with F11 toggle
  - Session persistence via freedesktop Secret Service keyring
  - Download from GitHub Releases as single `.AppImage` file

### Fixed
- Steam Deck built-in controller no longer claims P1 in browser — native gilrs owns the gamepad
- Big Picture mode no longer kills input — `gilrs` reads directly from `/dev/input/event*`

### Build
- `scripts/build-appimage.sh` — one-command AppImage build
- `scripts/release-appimage.sh` — release packaging with SHA256 checksums
- GitHub Actions release workflow builds AppImage on tag push

## v0.3.4 — 2026-07-14

### Added
- XMB keyboard and gamepad navigation wraps at all boundaries
- Max controller opacity level (0.95) for daylight visibility

### Changed
- Edit-mode resize handles enlarged to 56px hit areas with blue square indicators
- Drag feedback shows control name during repositioning
- "Return to Library" moved from top chrome into Options menu
- Room panel uses mobile bottom sheet on phones

### Fixed
- 114 lines of dead code removed (stale bottom bar, disconnect overlay, unused state)

## v0.5.0 — 2026-06-27

Initial public release preparation. The project is pre-1.0; all changes so far are tracked below from the point the repo was prepared for public visibility.

## Unreleased

## v0.7.0 — 2026-06-30

### Added

- Per-server core override system: dashboard users can change which libretro core
  each platform uses on a per-server basis
  - `PUT /api/servers/[server_id]/core-overrides` API endpoint
  - Cores section in ServerPanel with platform dropdowns
  - gv-server resolves overrides via `core_for_platform()`, stored in server metadata
- Public IP detection in gv-server (ipify.org) displayed in dashboard
- Named network interfaces display in ServerPanel (eth0, wg0, etc.)
- Runtime config display in dashboard (PC pool size, video scale height/max)
- Server-authenticated ROM import endpoint (`POST /api/server/import`)

### Changed

- **GB/GBC core**: switched from Gambatte back to SameBoy
  - Gambatte nightly build (`v0.5.0-netlink`) rejects all ROMs with
    "ROM is missing or too small" — confirmed broken at buildbot source
- **Audio**: capped native sample rate to 48 kHz in gv-core
  - SameBoy outputs 2.1 MHz audio; GStreamer's audioresample choked on 43:1 ratios
  - Bucket-average decimator in gv-core reduces to 48 kHz before shared memory
  - Eliminates all audio stutter, bursty silence, and resampler CPU thrash
- Atari 2600: switched from broken `stella_libretro.so` (v8, segfaults) to `stella2014_libretro.so`
- Dashboard UI unified: library and settings share identical nav bar conventions
- STUN/TURN display shows "not configured" explicitly when empty
- Stale session thresholds: Online ≤30min, Idle ≤24h (was overly aggressive)
- Removed broken "Live versions" table from dashboard
- Removed unreachable "Tools" footer from library page
- Gamepad overlay hidden on desktop by default, shows platform-appropriate buttons
- gv-core binary now deployed alongside gv-server on VAULT

### Fixed

- 56 stale game sessions cleaned up (development cruft)
- Phantom gv-server instance on VPS stealing commands from real VAULT server
- White border on player page (CSS body margin reset)
- Docker build cache masking Next.js changes (`--no-cache` forced rebuilds)
- Server name in dashboard now uses `os.hostname()` (VAULT) instead of UUID prefix

## v0.6.0 — 2026-06-27

### Added

- AGPL-3.0-or-later license with dual-license CLA framework
- Contributor License Agreement (`CLA.md`) for maintainer dual-licensing rights
- Contribution guide (`CONTRIBUTING.md`) and security policy (`SECURITY.md`)
- Third-party notice file (`NOTICE`) with GStreamer LGPL attribution
- GitHub pull request template, issue templates, and CODE_OF_CONDUCT
- DB-backed email/password authentication with setup-wizard first-user flow
  - `POST /api/auth/setup` — one-time setup code creates the first admin
  - `POST /api/auth/signup` — subsequent account creation
  - `POST /api/auth/verify` — host API key validation
- Pairing system: short-lived codes exchanged for server ID + API key
  - `POST /api/auth/pair/generate`
  - `POST /api/auth/pair/claim`
  - `gv-server pair <CODE> --gv-web-url <URL>` CLI command
- Host runtime (`gv-server`): polls gateway, runs libretro cores in-process, streams WebRTC media
- Gateway (`gv-web`): Next.js 15 web UI, library management, command relay, session records, room/sharing
- Browser player: vanilla JS WebRTC client served from the gateway
- In-process emulator session (core execution, GStreamer H.264/Opus encoding, WebRTC tracks)
- WebRTC DataChannel protocol: auth, binary input, save/load state, room sharing
- ICE/TURN config endpoint (`GET /api/ice-config`) with env-var configuration
- `/setup` wizard for first admin account creation
- ROM scanning, libretro core download/caching, platform-to-core mapping
- Room/share link flow: create, invite, join, resolve short codes
- Public host install script (`scripts/install.sh`) with systemd service setup
- Dev stack helper (`scripts/dev-start.sh`) for local development
- Build/release scripts (`scripts/build-release.sh`, `scripts/deploy-gv-web.sh`, `scripts/deploy-dev.sh`)
- Gateway smoke check (`tests/e2e-pipeline.sh`)
- Supported commands: `start_game`, `stop_game`, `sdp_offer`, `browse_files`, `scan_paths`
- Discord/social presence for the project

### Changed

- Architecture consolidated from three binaries (`gv-web` + `gv-server` + `gv-worker`) to two roles (`gv-web` + `gv-server`)
  - Emulator/runtime path merged into `gv-server`; no separate `gv-worker` process
  - In-process sessions, no cross-process IPC, no worker subprocess management
- All deployment docs updated to current architecture
- README, QUICKSTART, configuration reference rewritten for public audience
- Project documentation restructured:
  - Added `docs/ARCHITECTURE.md`
  - Rewrote `docs/API.md` as concise route reference
  - Rewrote `docs/DEVELOPMENT.md`, `docs/TESTING.md`
  - Updated `docs/PROTOCOL.md`, `docs/datachannel-protocol.md`, `docs/DEPLOY.md`
  - Removed obsolete architecture-history docs: `docs/plans/`, `docs/adr/`, `docs/architecture.html`, `docs/gv-worker-api.md`, `AUDIT_REPORT.md`
- CI workflow updated: `gv-worker` references replaced with the current workspace
- Docker Compose defaults use `localhost` instead of private test hostnames
- `scripts/deploy-vault.sh` → `scripts/deploy-dev.sh`, env vars renamed from `GV_VAULT_*` to `GV_DEV_*`
- Runtime temp directory moved from `/tmp/gv-workers` to `/tmp/gv-sessions`
- `source` field in launch events renamed from `"gv-worker"` to `"host-runtime"`
- Scripts folder pruned: removed one-off smoke scripts, wrapper deploy helpers, legacy test scripts
- Rust core-download tests serialized to prevent environment conflicts
- Git history rewritten to eliminate large historical blobs (ROMs, WASM cores, bundles)

### Removed

- Legacy LAN env-var user bootstrap (`LAN_USER`, `LAN_PASS`, `LAN_PASS_HASH`)
- Separate `gv-worker` crate and binary — runtime is in-process inside `gv-server`
- Old worker subprocess and IPC infrastructure (shm, PID files, spawn/kill lifecycle)
- `scripts/hash-password.mjs` — no longer needed with DB-backed auth
- `tests/load-test.sh` and `tests/chaos-test.sh` — referenced deleted architecture
- Hardcoded test-domain defaults (`lngnckr.tech`, `vault:3000`)
- Hardcoded TURN credentials from player assets
- Architecture history docs (39 old plans, 18 ADRs, audit report, stale architecture HTML)
- Stale `deploy-vault.sh`, `deploy-vps-web.sh`, `promote-main.sh`, `gv-web-cleanup.sh` scripts

### Fixed

- `gv-worker` crate test references in Rust test code
- Docker container naming drift (`gv-web-prod` → `gv-web`)
- API mock leakage in web test suite
- DB integration setup uses `drizzle-kit push --force` against disposable test database
- Rust core download tests no longer race on global `GV_CORES_DIR` env var

### Security

- Secrets, setup codes, API keys, TURN credentials, and connection strings are no longer hardcoded or committed
- No env-var-based admin bootstrap path — all accounts go through the setup wizard
- Setup codes are single-use, time-limited, and server-generated
