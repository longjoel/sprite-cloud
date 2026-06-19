# Games Vault v3 — Bare-Metal Dev Plan

**Date:** 2026-06-18  
**Applies to:** `feat/v3-desktop-app` and onward

## Architecture Change

Docker is gone. gv-worker and gv-server run directly on the host ("as close to the metal as they can"). gv-web deploys to lngnckr.tech on push. This gives us:

- **Real GPU access** — no Docker GPU passthrough hacks
- **Real GStreamer** — host's VAAPI, x264enc, render nodes
- **Real networking** — LAN IP detection, mDNS (when ready)
- **Production parity** — desktop users won't use Docker either

```
┌─────────────────────────────────────────────────┐
│  VPS (72.62.243.69)                              │
│  ┌──────────┐                                    │
│  │ gv-web   │  Next.js on :3000                  │
│  │ postgres │  :5433                             │
│  │ Traefik  │  routes lngnckr.tech → :3000       │
│  └──────────┘                                    │
└─────────────────────────────────────────────────┘
         ▲ HTTPS
         │
    ┌────┴─────────────────────────────────────┐
    │  Gaming Desktop (SSH access coming)        │
    │  ┌──────────┐   ┌──────────────┐          │
    │  │gv-server │──▶│  gv-worker   │          │
    │  │  :8976   │   │  :dynamic    │          │
    │  └──────────┘   └──────────────┘          │
    │  GPU: AMD / NVIDIA (real hardware)         │
    └────────────────────────────────────────────┘

    ┌─────────────────────────────────────────┐
    │  Raspberry Pi (SSH access coming)         │
    │  Test target: ARM build, software encode  │
    │  No GPU — validates sw fallback path      │
    └─────────────────────────────────────────┘

    ┌─────────────────────────────────────────┐
    │  This machine (N100, headless)            │
    │  Dev + CI — build, test, iterate         │
    │  Intel iGPU — VAAPI available             │
    └─────────────────────────────────────────┘
```

## Dev Workflow

### gv-web deploys on push

gv-web is already deployed to the VPS. On push to the production branch, a webhook triggers redeploy:

```
git push origin feat/v3-desktop-app
  → GitHub webhook notifies VPS
    → VPS pulls, rebuilds gv-web, restarts container
```

Until we set up CI for gv-web, manual deploy:

```bash
# On VPS
ssh vps "cd /docker/gv-web && git pull && docker compose up -d --build gv-web"
```

### gv-server + gv-worker run bare-metal

No Docker. Start directly:

```bash
# Build
cargo build --release -p gv-server -p gv-worker

# Copy worker to standard location
cp target/release/gv-worker /usr/local/bin/gv-worker

# Start server (connects to lngnckr.tech)
GV_WEB_URL=https://lngnckr.tech \
GV_WORKER_BIN=/usr/local/bin/gv-worker \
gv-server start
```

### Testing targets

| Machine | GPU | Encoder | Purpose |
|---------|-----|---------|---------|
| This N100 | Intel iGPU | vaapih264enc | Dev + verify VAAPI path |
| Gaming Desktop | AMD/NVIDIA | vah264enc/nvh264enc | Primary test target |
| Raspberry Pi | None | x264enc (sw) | ARM + software fallback validation |
| VPS | None | x264enc (sw) | gv-web serving only |

### Smoke test checklist

After each issue:

1. **Build:** `cargo build --release -p gv-worker -p gv-server`
2. **Test:** `cargo test -p gv-worker -p gv-server`
3. **Encoder probe:** `cargo test -p gv-worker -- encoder_probe` — must find at least x264enc
4. **H.264 pipeline:** `GV_GST_VIDEO_CODEC=h264 gv-worker <port>` — must start without encoder errors
5. **VP8 regression:** Default worker — must still stream VP8
6. **gv-web deploy:** Verify lngnckr.tech loads, can pair with local gv-server

## Config for bare-metal testing

```bash
# .env or export before gv-server start

# gv-web connection
GV_WEB_URL=https://lngnckr.tech

# Worker binary
GV_WORKER_BIN=/usr/local/bin/gv-worker

# GPU (optional — auto-detected in #377)
GV_GST_VIDEO_CODEC=h264             # or auto
GV_GST_VIDEO_H264_ENCODER=auto      # or specific: vaapih264enc, x264enc

# Core (test with 2048 for smoke tests)
GV_CORE_PATH=/path/to/2048_libretro.so

# Auth
LAN_AUTH_ALLOW_PUBLIC=1             # on VPS-hosted gv-web

# ICE (for remote play testing)
GV_ICE_STUN_URLS=stun:stun.l.google.com:19302
```

## Docker cleanup completed

- [x] `docker compose down` — gv-web container stopped and removed
- [x] docker-compose.yml still exists as reference, not used for dev
- [x] VPS still runs gv-web in Docker (production deployment, not dev)
- [ ] Remove docker-compose.yml from local dev flow (keep for reference)
- [ ] Update scripts/dev-start.sh to not reference Docker
