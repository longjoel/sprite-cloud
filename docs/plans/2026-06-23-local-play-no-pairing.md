# Self-Contained Local Play — No Pairing, No Internet

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Install gv-server, run `gv-server local`, open browser to `http://server-ip:8090`, browse ROMs, click play — no pairing, no accounts, no VPS, no internet required.

**Architecture:** gv-server gets a `local` subcommand that starts a lightweight Axum HTTP server. It serves a game browser UI and API endpoints for listing ROMs and spawning workers. The browser connects directly to gv-worker via WebRTC (same direct-SDP path the LAN guest already uses).

**Tech Stack:** Rust (gv-server, Axum), vanilla HTML/CSS/JS (browser UI, reuses Humidor design tokens), existing gv-worker binary (already serving `/player` + `/sdp`).

---

## What we reuse (three projects, zero duplication)

| Component | From | Reused as-is? |
|---|---|---|
| **Player page** (index.html + bundle) | gv-worker assets (rust-embed) | ✅ Served by gv-worker at `/player` — browser connects directly |
| **/sdp endpoint** | gv-worker | ✅ Direct SDP handshake — no relay needed |
| **Worker spawning** | gv-server worker.rs | ✅ Already spawns gv-worker, reads `WORKER_READY port=N` |
| **ROM scanning** | gv-server scan.rs | ✅ `scan_roms()`, `browse_path()`, `resolve_within_roots()` |
| **Design tokens** | gv-web globals.css | ✅ Copy-paste the `:root` block into browser UI HTML |
| **Config** | gv-server config.toml | ✅ Same `[rom].roots` — no new config surface |
| **ICE config** | gv-server env vars | ✅ `GV_ICE_*` env vars already set in systemd unit |

**What's NEW:**
- `local` subcommand + Axum HTTP server (gv-server, ~200 lines)
- Game browser UI (single HTML file, ~250 lines)
- API endpoints: `/api/games`, `/api/games/{id}/play` (~80 lines)

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│ Browser (LAN)                                       │
│  http://192.168.86.126:8090/                        │
│                                                     │
│  1. Loads game browser UI                           │
│  2. GET /api/games → list of ROMs                   │
│  3. User clicks "Play" → POST /api/games/{id}/play  │
│  4. Gets { worker_url, peer_token }                 │
│  5. window.location =                               │
│     http://192.168.86.126:PORT/player?              │
│       peer_token=...&seat=0&role=host               │
│  6. Direct WebRTC to worker                         │
└────────────────────┬────────────────────────────────┘
                     │ HTTP
┌────────────────────▼────────────────────────────────┐
│ gv-server (port 8090)                               │
│                                                     │
│  GET  /                    → game browser HTML      │
│  GET  /api/games           → [{id, name, platform}] │
│  POST /api/games/{id}/play → spawns worker,         │
│                               returns connection URL│
│                                                     │
│  Spawns: gv-worker --port 0 --rom ...               │
│  Reads:  WORKER_READY port=41723                    │
│  Returns: { worker_url: "http://...", peer_token }  │
└────────────────────┬────────────────────────────────┘
                     │ subprocess
┌────────────────────▼────────────────────────────────┐
│ gv-worker (random port)                             │
│                                                     │
│  GET  /player                  → embedded index.html│
│  GET  /player/player-bundle.js → JS bundle          │
│  POST /sdp                     → WebRTC handshake    │
│                                                     │
│  Streams: VP8 video + Opus audio via WebRTC         │
│  Input:   3-byte binary via DataChannel              │
└─────────────────────────────────────────────────────┘
```

No relay. The browser and worker are on the same LAN. Direct SDP, direct WebRTC.

---

## Security model

| Threat | Mitigation |
|---|---|
| Anyone on LAN can play | By design — this is the feature |
| Path traversal in play request | `resolve_within_roots()` — already exists |
| Worker port scanning | Random port, `WORKER_READY` only printed to stderr |
| Stale worker processes | gv-server tracks spawned workers, kills on idle |

No auth. No tokens. This is for trusted LAN use only.

---

## Tasks

### Task 1: Add `local` subcommand to gv-server CLI

**Files:** `gv-server/src/main.rs`

Add a new variant to the Command enum and wire it to a new module:

```rust
#[derive(Subcommand)]
enum Command {
    // ... existing variants ...
    /// Start local HTTP server for LAN-only play (no pairing required)
    Local {
        /// Port to listen on (default: 8090)
        #[arg(long, default_value = "8090")]
        port: u16,
    },
}
```

```rust
match cli.command {
    // ... existing arms ...
    Command::Local { port } => local::serve(port).await,
}
```

**Verification:** `gv-server local --help` shows the new subcommand.

---

### Task 2: Create `local` module with Axum HTTP server

**Files:** `gv-server/src/local.rs` (new)

Skeleton:

```rust
//! Self-contained local-play HTTP server.
//! Serves a game browser UI and APIs for listing ROMs and spawning workers.

use axum::{Router, routing::get, routing::post};
use std::sync::Arc;
use tokio::sync::Mutex;

mod api;
mod ui;

pub async fn serve(port: u16) -> anyhow::Result<()> {
    let state = Arc::new(AppState {
        rom_roots: config::rom_roots(),
        workers: Mutex::new(HashMap::new()),
    });

    let app = Router::new()
        .route("/", get(ui::serve_index))
        .route("/api/games", get(api::list_games))
        .route("/api/games/{id}/play", post(api::start_play))
        .with_state(state);

    let addr = format!("0.0.0.0:{port}");
    tracing::info!("[LOCAL] serving at http://{}", addr);
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}
```

**Dependencies to add to Cargo.toml:**
```toml
axum = "0.7"
tower-http = { version = "0.6", features = ["cors"] }
```

**Verification:** `cargo check` passes.

---

### Task 3: Implement `/api/games` endpoint

**Files:** `gv-server/src/local/api.rs` (new)

Scans ROM roots and returns a flat list of playable files:

```rust
use axum::{Json, extract::State};
use serde::Serialize;

#[derive(Serialize)]
struct GameEntry {
    id: String,        // base64-encoded relative path (URL-safe)
    name: String,      // filename without extension
    platform: String,  // detected from extension / DAT matching
    relative_path: String,
}

async fn list_games(State(state): State<Arc<AppState>>) -> Json<Vec<GameEntry>> {
    let mut games = Vec::new();
    for root in &state.rom_roots {
        if let Ok(files) = scan::scan_roms(root) {
            for f in files {
                games.push(GameEntry {
                    id: base64_url(&f.relative_path),
                    name: f.name.clone(),
                    platform: platform::detect(&f.relative_path).unwrap_or("unknown".into()),
                    relative_path: f.relative_path.clone(),
                });
            }
        }
    }
    Json(games)
}
```

Reuse `scan::scan_roms()` and `platform::detect()` — both already exist.

**Verification:** `curl http://localhost:8090/api/games` returns JSON array of games.

---

### Task 4: Implement `/api/games/{id}/play` endpoint

**Files:** `gv-server/src/local/api.rs`

Spawns a worker for the selected game and returns connection details:

```rust
#[derive(Serialize)]
struct PlayResponse {
    worker_url: String,
    peer_token: String,
}

async fn start_play(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<PlayResponse>, StatusCode> {
    let rel_path = base64_decode(&id)?;
    let full_path = find_in_roots(&rel_path, &state.rom_roots)?;
    
    // Spawn worker — reuses existing spawn logic
    let worker = worker::spawn(0, &full_path).await?;
    
    let peer_token = generate_token();
    let response = PlayResponse {
        worker_url: worker.url.clone(),
        peer_token,
    };
    
    // Track for cleanup
    state.workers.lock().await.insert(worker.url.clone(), worker);
    
    Ok(Json(response))
}
```

Reuse `worker::spawn()` which already handles port 0 (random), reads `WORKER_READY port=N`, builds URL.

**Verification:** POST to `/api/games/{id}/play` spawns a worker process and returns a valid URL.

---

### Task 5: Build the game browser UI

**Files:** `gv-server/src/local/ui.rs` (serves embedded HTML)

A single self-contained HTML page with inline CSS/JS. Uses the Humidor design tokens (same as gv-web globals.css and embedded player).

**Route:** `GET /` → serves this HTML via `rust-embed` or `include_str!`

Key sections:
- **Header:** "Games Vault" branding, server name
- **Grid:** Game cards with name, platform badge, click to play
- **Filter:** Search box to filter by name
- **States:** Loading, empty ("No ROMs found — check rom_roots config"), error
- **Design:** Matches the Humidor dark theme (mahogany/brass/cream/neon)

The JS flow:
1. On load: `fetch('/api/games')` → populate grid
2. On card click: `fetch('/api/games/{id}/play', {method:'POST'})` → get worker_url
3. `window.location.href = worker_url + '/player?peer_token=...&seat=0&role=host'`

**Verification:** Open `http://localhost:8090/` → see game grid → click → worker starts → player loads.

---

### Task 6: Worker idle cleanup

**Files:** `gv-server/src/local.rs`

When a worker's peer disconnects (or after a timeout with no connections), kill the worker process:

```rust
// Spawn a background task that periodically checks if any workers
// have been idle too long (no active connections for 5 minutes)
tokio::spawn(async move {
    loop {
        tokio::time::sleep(Duration::from_secs(60)).await;
        // Check and reap idle workers
    }
});
```

**Verification:** Start a game, close browser, worker is killed within 5 minutes.

---

### Task 7: Register Axum dependency and build

**Files:** `gv-server/Cargo.toml`

```toml
axum = "0.7"
tower-http = { version = "0.6", features = ["cors"] }
serde = { version = "1", features = ["derive"] }  # likely already present
```

**Verification:** `cargo build --release -p gv-server` succeeds.

---

### Task 8: End-to-end smoke test

1. Run `gv-server local --port 8090`
2. Open `http://localhost:8090/` on same machine
3. Should see game grid with ROMs from configured roots
4. Click a game → worker spawns → player loads
5. Game streams, input works
6. Close browser → worker eventually cleaned up

---

## Current state (before implementation)

- gv-server currently has NO HTTP server — only a WebSocket client to gv-web
- gv-server already has ROM scanning (`scan.rs`), worker spawning (`worker.rs`), platform detection (`platform.rs`)
- gv-worker already serves `/player` and `/sdp` with direct WebRTC support
- The existing systemd unit sets `GV_ICE_*` env vars

## Files to create/modify

| File | Action |
|---|---|
| `gv-server/src/main.rs` | Add `Local` subcommand |
| `gv-server/src/local.rs` | New — module with Axum server + state |
| `gv-server/src/local/api.rs` | New — `/api/games`, `/api/games/{id}/play` |
| `gv-server/src/local/ui.rs` | New — serve game browser HTML |
| `gv-server/Cargo.toml` | Add `axum`, `tower-http` |
