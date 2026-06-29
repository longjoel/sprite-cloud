# Changelog

All notable changes to Sprite Cloud will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims for [Semantic Versioning](https://semver.org/spec/v2.0.0.html) after the initial public release.

## v0.5.0 — 2026-06-27

Initial public release preparation. The project is pre-1.0; all changes so far are tracked below from the point the repo was prepared for public visibility.

## Unreleased

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
