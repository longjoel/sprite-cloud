# Multi-Peer WebRTC Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Support multiple simultaneous peers (players + watchers) connected to one gv-worker, with per-peer token auth from the start.

**Architecture:** Extract the GStreamer pipeline + libretro core into shared `AppState`. Replace the single `peer_connection` slot with a `PeerRegistry` that holds N peer connections. Fan out encoded video/audio frames to all peer tracks. Issue per-peer bearer tokens from gv-web, validated by gv-worker before ICE negotiation.

**Tech Stack:** Rust (webrtc-rs, axum, GStreamer), TypeScript (Next.js, Drizzle), vanilla JS (gv-player)

**Test strategy:** Two browser windows on the same machine. Host opens game in window A, shares via room_token, guest joins in window B as Viewer. All LAN-only — zero internet exposure during implementation.

---

## Security model (baked into each task)

| Threat | Mitigation | Where |
|---|---|---|
| Unauthenticated peer connects to worker | `/validate` endpoint requires per-peer bearer token before SDP accepted | Task 5 |
| Guest sends input (should be viewer-only) | DataChannel auth assigns role; input routing drops non-Host binary data | Task 9 |
| Token leak in SDP offer (plaintext host_token) | Per-peer tokens, host_token removed from SDP body; tokens validated server-side | Task 3, 5 |
| Worker overload (unlimited peers) | Max peer cap enforced at /offer — reject when full | Task 7 |
| Stale peer tokens survive session restart | Tokens scoped to session; worker clears registry on new session | Task 6 |
| Room token replay (guest re-uses old link) | Room tokens are single-use per session; `/room/join` returns fresh peer_token | Task 3 |

---

## Current state (what exists before we touch anything)

```
gv-worker-v2 AppState:
  peer_connection: Mutex<Option<Arc<RTCPeerConnection>>>   ← ONE slot
  host_token: Mutex<Option<String>>                         ← ONE shared secret
  stream_handle: Mutex<Option<JoinHandle<()>>>              ← ONE streaming task
  cancel: Mutex<CancellationToken>                          ← ONE cancel token

do_webrtc_handshake():
  1. Cancels previous session (cancel token + abort handle)   ← kills existing peer!
  2. Builds new MediaEngine + API + RTCPeerConnection
  3. Adds ONE video track + ONE audio track
  4. Creates ONE DataChannel → auth with host_token
  5. Spawns stream_frames() writing to ONE track pair

gv-web session schema:
  hostToken: text          ← singular
  roomToken: text          ← already unique, used for sharing
  maxSeats: int (default 1) ← already exists, unused

gv-server worker spawn:
  cmd.env("GV_HOST_TOKEN", token)    ← singular token via env
  cmd.env("GV_WORKER_CONTROL_TOKEN") ← per-worker, already correct
```

---

### Task 1: Issue per-peer tokens from gv-web

**Objective:** When host starts a game or guest joins via room_token, gv-web issues a cryptographically random per-peer token and stores it alongside the session.

**Files:**
- Modify: `gv-web/app/api/server/command/route.ts`
- Modify: `gv-web/app/api/room/join/route.ts`
- Modify: `gv-web/lib/db/schema.ts`

**DB schema change — add peer_tokens table:**

```typescript
// gv-web/lib/db/schema.ts — add after sessions table

export const peerTokens = pgTable("peer_tokens", {
  id: uuid("id").defaultRandom().primaryKey(),
  sessionId: uuid("session_id").references(() => sessions.id).notNull(),
  token: text("token").notNull().unique(),       // 32-char hex
  seat: integer("seat").notNull(),               // 0=host, 1..N=players/watchers
  role: text("role").notNull().default("viewer"), // "host" | "player" | "viewer"
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});
```

**Step 1: Write migration**

```bash
cd gv-web && pnpm drizzle-kit generate
```

**Step 2: Modify CMD_START_GAME — create host peer_token**

In `gv-web/app/api/server/command/route.ts`, after creating the session (line ~286), insert a peer_token:

```typescript
// After: await db.insert(sessions).values({...hostToken...})
// Add:
const hostPeerToken = crypto.randomBytes(16).toString("hex");
await db.insert(peerTokens).values({
  sessionId: /* the new session's id */,
  token: hostPeerToken,
  seat: 0,
  role: "host",
});
// Return host_peer_token in response
```

**Step 3: Modify /api/room/join — issue guest peer_token**

In `gv-web/app/api/room/join/route.ts`, after resolving the session, create a peer_token for the guest:

```typescript
// After session lookup (line ~38), add:
const guestPeerToken = crypto.randomBytes(16).toString("hex");
const seat = /* next available seat, up to maxSeats */;
await db.insert(peerTokens).values({
  sessionId: session.id,
  token: guestPeerToken,
  seat,
  role: "player", // or "viewer" if maxSeats reached
});

// Return peer_token in response alongside worker_url
return NextResponse.json({
  worker_url: session.workerUrl,
  game_id: session.gameId,
  peer_token: guestPeerToken,
  seat,
  role: seat < session.maxSeats ? "player" : "viewer",
});
```

**Step 4: Verify** — `pnpm tsc --noEmit` passes.

**Acceptance criteria:**
- `pnpm tsc --noEmit` clean
- START_GAME response includes `host_peer_token`
- `/api/room/join` response includes `peer_token` and `seat`

---

### Task 2: Pass peer tokens to gv-worker on spawn

**Objective:** gv-server serializes the peer token list and passes it to the worker as a JSON env var.

**Files:**
- Modify: `gv-server/src/worker.rs`
- Modify: `gv-worker-v2/src/config.rs`

**Step 1: gv-server — read peer tokens from command payload**

In `gv-server/src/worker.rs`, when processing a `start_game` command, the payload already has `host_token`. Add extraction of `peer_tokens` from the command payload (gv-web will include it):

```rust
// In the command processing path, after extracting host_token:
let peer_tokens_json = payload
    .get("peer_tokens")
    .and_then(|v| serde_json::to_string(v).ok());
```

**Step 2: Pass as env var**

```rust
if let Some(ref tokens) = peer_tokens_json {
    cmd.env("GV_PEER_TOKENS", tokens);
}
```

**Step 3: gv-worker — parse peer token list**

In `gv-worker-v2/src/config.rs`, add:

```rust
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct PeerToken {
    pub token: String,
    pub seat: u32,
    pub role: String, // "host" | "player" | "viewer"
}

pub fn peer_tokens() -> Vec<PeerToken> {
    static V: LazyLock<Vec<PeerToken>> = LazyLock::new(|| {
        std::env::var("GV_PEER_TOKENS")
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    });
    V.clone()
}
```

**Step 4: Verify** — `cargo build -p gv-server -p gv-worker-v2` compiles.

**Acceptance criteria:**
- Both crates compile
- Worker can parse `GV_PEER_TOKENS` JSON

---

### Task 3: Extract shared state — core + encoder → AppState (the refactor)

**Objective:** Move the GStreamer encoders and core frame receiver out of `do_webrtc_handshake()` into `AppState` so they survive across peer connect/disconnect cycles. This is the foundation — every subsequent task builds on it.

**Files:**
- Modify: `gv-worker-v2/src/main_body.rs`

**Current problem:** `do_webrtc_handshake()` owns the GStreamer encoders (`video_enc`, `audio_enc`) and the core frame receiver (`core_frame_rx`). It creates them during handshake and passes them to `stream_frames()`. When a new peer connects, the old handshake is canceled — taking the encoders with it.

**Change:**

Add to `AppState`:
```rust
struct AppState {
    // ... existing fields ...
    video_enc: Mutex<Option<Arc<Mutex<GstVideoEncoder>>>>,
    audio_enc: Mutex<Option<Arc<Mutex<Option<GstAudioEncoder>>>>>,
    core_frame_rx: Mutex<Option<std::sync::mpsc::Receiver<CoreFrame>>>,
    core_fps: Mutex<f64>,
}
```

Move encoder initialization from `do_webrtc_handshake()` into the caller (the core loading path in `main_body.rs` around the `start_core` / `handle_start` area). Store encoders in AppState once, then `do_webrtc_handshake()` reads from AppState instead of owning them.

```rust
// In do_webrtc_handshake, replace:
//   let video_enc = ...; let audio_enc = ...;
// with:
let video_enc = state.video_enc.lock().await.clone()
    .ok_or("no video encoder ready")?;
let audio_enc = state.audio_enc.lock().await.clone()
    .ok_or("no audio encoder ready")?;
```

**Step 1: Add fields to AppState** — defaults to `None`
**Step 2: Move encoder creation** into the startup path, store in AppState
**Step 3: Read from AppState in do_webrtc_handshake**
**Step 4: Build and verify** — `cargo build -p gv-worker-v2`

**Acceptance criteria:**
- `cargo build` succeeds
- Existing single-peer flow still works (encoders initialized once, read by handshake)

---

### Task 4: PeerRegistry — replace single peer_connection with HashMap

**Objective:** Replace `peer_connection: Mutex<Option<Arc<RTCPeerConnection>>>` with a registry that holds N peers, each with its DataChannel, role, and seat.

**Files:**
- Modify: `gv-worker-v2/src/main_body.rs`

**New type:**

```rust
use std::collections::HashMap;

struct PeerState {
    pc: Arc<RTCPeerConnection>,
    dc: Arc<tokio::sync::Mutex<Option<Arc<webrtc::data_channel::RTCDataChannel>>>>,
    role: PeerRole,
    seat: u32,
    video_track: Arc<TrackLocalStaticSample>,
    audio_track: Arc<TrackLocalStaticSample>,
}

type PeerId = String; // the peer_token (32-char hex)

struct AppState {
    // ... existing fields ...
    // REMOVE: peer_connection: Mutex<Option<Arc<RTCPeerConnection>>>,
    // ADD:
    peers: Mutex<HashMap<PeerId, PeerState>>,
    max_peers: usize, // from config, default 10
    // REMOVE: host_token: Mutex<Option<String>>,
    // ADD:
    peer_tokens: Vec<config::PeerToken>, // from GV_PEER_TOKENS
}
```

**Step 1: Define PeerState struct**
**Step 2: Replace peer_connection with peers HashMap in AppState**
**Step 3: Update all references to `state.peer_connection`** — this is search-and-replace level, but touches ~15 locations (connection_state handler, destruct timer, disconnect detection, SDP handler)
**Step 4: Build and fix compile errors iteratively**
**Step 5: Verify** — `cargo build -p gv-worker-v2`

**Acceptance criteria:**
- `cargo build` clean
- No more `peer_connection` or `host_token` fields on AppState
- Health endpoint still works (`/health` returns status)

---

### Task 5: Per-peer SDP negotiation — guest join without killing host

**Objective:** The `/sdp` endpoint accepts offers from multiple peers. Each offer includes a `peer_token`. The worker validates the token against `GV_PEER_TOKENS`, then creates a new RTCPeerConnection without disrupting existing peers.

**Files:**
- Modify: `gv-worker-v2/src/main_body.rs`

**Step 1: Add pre-ICE validation endpoint**

New route: `POST /validate` — validates a peer_token before the browser does the expensive SDP exchange:

```rust
#[derive(Debug, Deserialize)]
struct ValidateRequest {
    peer_token: String,
}

async fn handle_validate(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ValidateRequest>,
) -> Result<StatusCode, StatusCode> {
    // Check token is in the authorized list
    let valid = state.peer_tokens.iter().any(|t| t.token == req.peer_token);
    if !valid {
        return Err(StatusCode::UNAUTHORIZED);
    }
    // Check we're not at capacity
    let peers = state.peers.lock().await;
    if peers.len() >= state.max_peers {
        return Err(StatusCode::SERVICE_UNAVAILABLE); // 503
    }
    // Check this token isn't already connected
    if peers.contains_key(&req.peer_token) {
        return Err(StatusCode::CONFLICT); // 409
    }
    Ok(StatusCode::OK)
}
```

**Step 2: Modify SDP offer — extract peer_token instead of host_token**

Update `SdpOffer`:
```rust
struct SdpOffer {
    sdp: String,
    peer_token: String,  // was: host_token: Option<String>
}
```

**Step 3: Modify do_webrtc_handshake signature**

```rust
async fn do_webrtc_handshake(
    state: Arc<AppState>, 
    offer_sdp: &str,
    peer_token: &str,
) -> Result<SdpAnswer, String> {
```

**Step 4: Do NOT cancel existing peers**

Remove the block that cancels previous session:
```rust
// REMOVE THIS:
// let cancel = { let old = state.cancel.lock().await; old.cancel(); ... };
// { let mut h = state.stream_handle.lock().await; if let Some(handle) = h.take() { handle.abort(); } }
```

Instead, create a fresh RTCPeerConnection and add it to the registry.

**Step 5: Store peer in registry after SDP exchange succeeds**

```rust
// After: let answer_sdp = SdpAnswer { sdp: local_desc.sdp };
let peer_id = peer_token.to_string();
let peer_role = state.peer_tokens.iter()
    .find(|t| t.token == peer_token)
    .map(|t| match t.role.as_str() {
        "host" => PeerRole::Host,
        _ => PeerRole::Viewer,
    })
    .unwrap_or(PeerRole::Viewer);

state.peers.lock().await.insert(peer_id.clone(), PeerState {
    pc: Arc::clone(&pc),
    dc: dc_stream.clone(),
    role: peer_role,
    seat: /* from peer_tokens lookup */,
    video_track: Arc::clone(&video_track),
    audio_track: Arc::clone(&audio_track),
});
```

**Step 6: Add /validate route to router**

```rust
.route("/validate", post(handle_validate))
```

**Step 7: Verify** — `cargo build`

**Acceptance criteria:**
- `POST /validate` with invalid token → 401
- `POST /validate` with valid token → 200
- `POST /validate` when full (10 peers) → 503
- `POST /sdp` from second peer does NOT kill first peer's connection
- `cargo build` clean

---

### Task 6: Streaming loop fan-out — write frames to all peer tracks

**Objective:** `stream_frames()` currently writes to ONE `TrackLocalStaticSample`. Modify it to write to all peer tracks.

**Files:**
- Modify: `gv-worker-v2/src/main_body.rs`

**Step 1: Change stream_frames to fan out**

The key change in `stream_frames()`:

```rust
// BEFORE (writes to one track):
ctx.track.write_sample(&sample).await;

// AFTER (writes to all peers):
let peers = ctx.app_state.peers.lock().await;
for (peer_id, peer) in peers.iter() {
    if let Err(e) = peer.video_track.write_sample(&video_sample).await {
        tracing::warn!("[STREAM] write to peer {peer_id} failed: {e}");
    }
}
```

Same for audio samples.

**Step 2: Update StreamCtx**

Remove the single `track` and `audio_track` fields — they're now accessed via `app_state.peers`:

```rust
struct StreamCtx {
    // REMOVE: track, audio_track
    dc_stream: Arc<tokio::sync::Mutex<Option<Arc<webrtc::data_channel::RTCDataChannel>>>>,
    cancel: CancellationToken,
    app_state: Arc<AppState>,
    video_enc: Arc<tokio::sync::Mutex<GstVideoEncoder>>,
    audio_enc: Arc<tokio::sync::Mutex<Option<GstAudioEncoder>>>,
    core_frame_rx: Option<std::sync::mpsc::Receiver<crate::core_bridge::CoreFrame>>,
    fps: f64,
}
```

**Step 3: Handle peer disconnect during stream**

When a write fails, remove the peer from the registry:

```rust
if let Err(e) = peer.video_track.write_sample(&video_sample).await {
    tracing::warn!("[STREAM] peer {peer_id} disconnected: {e}");
    drop(peers); // release lock
    state.peers.lock().await.remove(peer_id);
}
```

**Step 4: Verify** — `cargo build`

**Acceptance criteria:**
- `cargo build` clean
- Existing single-peer still works (1 peer in registry, frames written)

---

### Task 7: Watcher cap enforcement

**Objective:** Reject new peer connections when `max_peers` (10) is reached.

**Files:**
- Modify: `gv-worker-v2/src/main_body.rs`

This is already partially done in Task 5 (the `/validate` check). Add a second check in `handle_offer` as defense-in-depth, and make `max_peers` configurable.

**Step 1: Add config constant**

In `gv-worker-v2/src/config.rs`:
```rust
pub fn max_peers() -> usize {
    static V: LazyLock<usize> = LazyLock::new(|| env_or("GV_MAX_PEERS", 10));
    *V
}
```

**Step 2: Use in AppState construction**

```rust
let state = Arc::new(AppState {
    // ...
    max_peers: config::max_peers(),
    // ...
});
```

**Step 3: Verify** — `cargo build`

**Acceptance criteria:**
- 11th peer connection attempt returns 503
- `GV_MAX_PEERS=5` configurable via env

---

### Task 8: DataChannel auth with per-peer tokens

**Objective:** Update the DataChannel auth handler to validate `peer_token` (not `host_token`) and assign the correct role.

**Files:**
- Modify: `gv-worker-v2/src/main_body.rs`

**Step 1: Update auth handler**

In the DataChannel `on_message` handler (around line 487-493), change:

```rust
// BEFORE:
if cmd_type == "auth" {
    if let Some(token) = cmd.get("host_token").and_then(|v| v.as_str()) {
        let is_host = session_token.as_deref() == Some(token);
        *role.lock().await = Some(if is_host { PeerRole::Host } else { PeerRole::Viewer });
    }
    return;
}

// AFTER:
if cmd_type == "auth" {
    if let Some(token) = cmd.get("peer_token").and_then(|v| v.as_str()) {
        // Look up role from authorized tokens
        let authorized = state.peer_tokens.iter().find(|t| t.token == token);
        *role.lock().await = authorized.map(|t| match t.role.as_str() {
            "host" => PeerRole::Host,
            "player" => PeerRole::Player,
            _ => PeerRole::Viewer,
        });
    }
    return;
}
```

**Step 2: Add PeerRole::Player variant**

```rust
enum PeerRole {
    Host,
    Player,   // NEW
    Viewer,
}
```

**Step 3: Update binary_input_allowed**

```rust
fn binary_input_allowed(role: Option<PeerRole>) -> bool {
    matches!(role, Some(PeerRole::Host) | Some(PeerRole::Player))
}
```

**Step 4: Verify** — `cargo build`

**Acceptance criteria:**
- Host peer_token → role=Host, input allowed
- Player peer_token → role=Player, input allowed
- Viewer peer_token → role=Viewer, input dropped
- Unknown token → stays None, auth timeout closes DC

---

### Task 9: Input routing per seat

**Objective:** When a peer sends input (binary or JSON), route it to the correct controller port based on their seat number.

**Files:**
- Modify: `gv-worker-v2/src/main_body.rs`

**Step 1: Tag binary input with seat**

In the DataChannel message handler, wrap `CoreCommand::SetInput` with the peer's seat:

```rust
// BEFORE:
let _ = tx.try_send(CoreCommand::SetInput { port, state });

// AFTER:
let peer_seat = /* get seat from peer registry */;
let _ = tx.try_send(CoreCommand::SetInput { port: peer_seat, state });
```

**Step 2: Tag JSON input with seat**

```rust
// BEFORE:
tx.try_send(CoreCommand::SetJoypad { port: ..., button, pressed })

// AFTER:
tx.try_send(CoreCommand::SetJoypad { port: peer_seat, button, pressed })
```

Drop the `port` field from client input — seat assignment is server-side.

**Step 3: Verify** — `cargo build`

**Acceptance criteria:**
- Host (seat=0) input goes to port 0
- Player (seat=1) input goes to port 1
- Viewer input is dropped entirely (Task 8 already handles this)

---

### Task 10: Room state broadcast on connect/disconnect

**Objective:** When a peer connects or disconnects, broadcast the updated peer list to all connected peers via DataChannel.

**Files:**
- Modify: `gv-worker-v2/src/main_body.rs`

**Step 1: Define state broadcast message**

```rust
fn build_room_state(peers: &HashMap<PeerId, PeerState>) -> serde_json::Value {
    let members: Vec<_> = peers.iter().map(|(id, p)| {
        serde_json::json!({
            "peer_id": &id[..8], // truncated for display
            "seat": p.seat,
            "role": match p.role {
                PeerRole::Host => "host",
                PeerRole::Player => "player",
                PeerRole::Viewer => "viewer",
            },
        })
    }).collect();
    serde_json::json!({"type": "room_state", "members": members})
}
```

**Step 2: Broadcast on connect (after DataChannel opens)**

In the DataChannel auth handler, after assigning role, broadcast to all peers.

**Step 3: Broadcast on disconnect**

In the peer disconnection detection handler (the `on_peer_connection_state_change` callback), after removing the peer, broadcast updated room state.

**Step 4: Verify** — `cargo build`

**Acceptance criteria:**
- New peer sees current room state on connect
- Existing peers receive updated state when someone joins/leaves
- Disconnected peer is removed from state broadcast

---

### Task 11: Update gv-player client for multi-peer

**Objective:** The browser client sends `peer_token` (not `host_token`) in SDP offers and DataChannel auth. Guest flow uses `/api/room/join` + `/validate` before connecting.

**Files:**
- Modify: `gv-web/public/player/index.js`
- Modify: `gv-web/public/player/play.js`

**Step 1: Change host_token → peer_token in SDP offer**

In `connectViaRelay`:
```javascript
// BEFORE:
payload: { game_id: gameId, sdp: offer.sdp, host_token: hostToken }

// AFTER:
payload: { game_id: gameId, sdp: offer.sdp, peer_token: this._peerToken }
```

**Step 2: Change DataChannel auth message**

```javascript
// BEFORE:
this._dc.send(JSON.stringify({ cmd: "auth", host_token: this._hostToken }));

// AFTER:
this._dc.send(JSON.stringify({ cmd: "auth", peer_token: this._peerToken }));
```

**Step 3: Add guest flow**

New method: `connectAsGuest(roomToken)`:
```javascript
async connectAsGuest(roomToken) {
  // 1. Resolve room_token → worker_url + peer_token
  const resp = await fetch("/api/room/join", {
    method: "POST",
    body: JSON.stringify({ room_token: roomToken }),
  });
  const { worker_url, peer_token, seat, role } = await resp.json();
  
  // 2. Validate peer_token with worker
  const validateResp = await fetch(`${worker_url}/validate`, {
    method: "POST",
    body: JSON.stringify({ peer_token }),
  });
  if (!validateResp.ok) throw new Error("worker rejected peer_token");
  
  // 3. Connect via relay with peer_token
  this._peerToken = peer_token;
  this._seat = seat;
  this._role = role;
  await this.connectViaRelay(serverId, gameId, peerToken, null, roomToken);
}
```

**Step 4: Seat display in UI** — show seat number and role

**Step 5: Verify** — open two browser windows, host + guest

**Acceptance criteria:**
- Host connects with peer_token, gets Host role, can play
- Guest connects with room_token → peer_token, gets Viewer role, sees video but can't send input
- `pnpm tsc --noEmit` clean

---

### Task 12: Integration smoke test

**Objective:** Automated test that verifies multi-peer end-to-end.

**Files:**
- Create: `tests/multi-peer-smoke.sh`

```bash
#!/usr/bin/env bash
# Multi-peer smoke test — host + guest, two browser contexts
set -euo pipefail

# 1. Auth as user, get session cookie
# 2. Start game via /api/server/command (CMD_START_GAME) → get host_peer_token + worker_token
# 3. Poll /api/server/notify for workerUrl + SDP answer
# 4. POST /api/room/share → get room_token
# 5. Auth as guest (or unauthenticated), POST /api/room/join with room_token → get guest_peer_token
# 6. POST /validate to worker with guest_peer_token → 200
# 7. Both peers complete SDP exchange
# 8. Verify both peer connections show in worker /state
# 9. Verify host input reaches core, guest input is dropped
```

**Acceptance criteria:**
- `bash tests/multi-peer-smoke.sh` exits 0 against running stack
- Test verifies: two peer connections, correct role assignment, input routing

---

## Verification checklist (after all tasks)

- [ ] `cargo build -p gv-worker-v2 -p gv-server` clean
- [ ] `pnpm tsc --noEmit` (in gv-web) clean
- [ ] `pnpm drizzle-kit generate` produces migration
- [ ] Host opens game, plays normally (regression)
- [ ] Guest joins via room_token, sees video, cannot send input
- [ ] 11th peer rejected with 503
- [ ] Worker `/health` shows peer count
- [ ] Worker `/state` shows all peer connections
- [ ] Peer disconnect removes from registry, broadcasts updated state
- [ ] `bash tests/multi-peer-smoke.sh` passes
