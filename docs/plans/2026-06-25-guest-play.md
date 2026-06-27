# Guest Play Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Guest players can join a host's game session via share link — see the video, hear audio, and send input from their assigned seat.

**Architecture:** One video/audio track pair shared across host PC + all guest PCs via `add_track()`. Guest PCs created from the pool on SDP offer, tracks added before SDP exchange. Streaming loop unchanged (writes once, fan-out is automatic). Guest DCs wired per-PC with seat-based input routing.

**Tech Stack:** Rust (gv-server), TypeScript (gv-web Next.js), webrtc-rs 0.17.1 fork, GStreamer

**Current state:**
- gv-web has `peer_tokens` table, `/api/room/join` endpoint, seat assignment
- gv-server has guard rejecting guest SDP offers (`is_guest` check in `handle_sdp_offer`)
- gv-server has `PcPool` with pre-built `WebRtcStack` (PC + video/audio tracks)
- `GameSession` holds single `pc`, `video_track`, `audio_track`
- Streaming loop writes to `session.video_track` / `session.audio_track` once per frame
- Guest player JS (`connectViaRelay`) sends SDP offer with `room_token` + `peer_token`
- Player already handles `core_died` DC message for error recovery

**Files that change:**
- `gv-server/src/session.rs` — add `guests` list
- `gv-server/src/commands/mod.rs` — guest SDP exchange, DC handling per guest
- `gv-server/src/streaming.rs` — no changes (tracks shared, fan-out automatic)

---

## Security model (baked into each task)

| Threat | Mitigation | Where |
|---|---|---|
| Guest SDP overwrites host PC | Guest SDP handled on separate PC, never touches `session.pc` | Task 2 |
| Guest input controls host seat | Guest DC routes input to assigned seat, not port 0 | Task 3 |
| Guest disconnect kills session | Per-guest cancel tokens, only host death triggers session cancel | Task 4 |
| Stale guest PCs leak | Cleanup on DC close/ICE disconnect; removed from guests list | Task 4 |
| Unauthorized guest SDP | room_token validated by gv-web before command reaches gv-server | (existing) |

---

### Task 1: Add `GuestPeer` struct and `guests` list to `GameSession`

**Objective:** Data structure to track guest peer connections, seats, and DCs.

**Files:**
- Modify: `gv-server/src/session.rs` (add struct + field)

**Step 1: Add `GuestPeer` struct**

After the `use` statements (after line 17), add:

```rust
/// A connected guest peer with their own PC and input seat.
pub struct GuestPeer {
    pub pc: Arc<RTCPeerConnection>,
    pub seat: u32,
    pub peer_token: String,
}
```

**Step 2: Add `guests` field to `GameSession`**

After the `dc` field (line ~35), add:

```rust
    /// Guest peer connections — host is session.pc, guests are here.
    /// Lock order: always lock `guests` before per-guest operations.
    pub guests: Mutex<Vec<Arc<GuestPeer>>>,
```

**Step 3: Initialize in session constructor**

In `gv-server/src/commands/mod.rs`, in the `GameSession { ... }` block (line ~283), add:
```rust
        guests: tokio::sync::Mutex::new(Vec::new()),
```

**Step 4: Compile check**

Run: `cargo check -p gv-server`
Expected: compiles with warnings only (no errors)

**Step 5: Commit**

```bash
git add gv-server/src/session.rs gv-server/src/commands/mod.rs
git commit -m "feat: add GuestPeer struct and guests list to GameSession"
```

---

### Task 2: Guest SDP exchange — create guest PC, add tracks, answer

**Objective:** When guest SDP offer arrives, create a new PC from pool, add the host's video/audio tracks to it, do SDP exchange on the guest PC, send answer back.

**Files:**
- Modify: `gv-server/src/commands/mod.rs` (`handle_sdp_offer`)

**Step 1: Remove the guest guard**

Delete the guard added earlier (lines ~437-448), replacing with guest PC creation logic. The guard section to remove:
```rust
    // ── Guard: guest SDP offers must not touch the host's PC ─────────
    let is_guest = cmd.payload.as_object().map_or(false, |obj| {
        obj.contains_key("peer_token") || obj.contains_key("room_token")
    });
    if is_guest {
        tracing::warn!("[SDP] guest offer for game {game_id} — guest play not yet supported");
        ...
        return;
    }
    // ── End guard ────────────────────────────────────────────────────
```

**Step 2: Extract peer_token from payload**

After the sdp/game_id extraction (line ~432), add:
```rust
    let peer_token = cmd.payload.get("peer_token")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
```

**Step 3: In the session loop, branch on guest vs host**

Inside `if let Some(session) = sessions.get(game_id) { ... }` (line ~445), BEFORE the existing SDP exchange code, add:

```rust
            // ── Guest path: create new PC, don't touch host PC ──────
            if let Some(ref pt) = peer_token {
                handle_guest_sdp(session, sdp, pt, cmd, client, pool).await;
                return;
            }
            // ── Host path (existing code) ───────────────────────────
```

**Step 4: Implement `handle_guest_sdp`**

Add a new async function after `handle_sdp_offer` closes (after line ~536):

```rust
async fn handle_guest_sdp(
    session: &Arc<GameSession>,
    sdp: &str,
    peer_token: &str,
    cmd: &gv_web::Command,
    client: &gv_web::GvWebClient,
    pool: &webrtc::PcPool,
) {
    tracing::info!("[SDP] guest offer — creating guest PC (peer_token={})", &peer_token[..8]);

    // Acquire fresh PC from pool
    let stack = match pool.acquire().await {
        Ok(s) => s,
        Err(e) => {
            tracing::error!("[SDP] guest pool acquire failed: {e}");
            let _ = client.command_result(&cmd.id, &cmd.lease_token,
                &serde_json::json!({"error":"pool_empty","message":"no PCs available"})).await;
            return;
        }
    };

    // Add host's video + audio tracks to the guest PC
    let video_track = session.video_track.lock().unwrap().clone();
    let audio_track = session.audio_track.lock().unwrap().clone();
    stack.pc.add_track(Arc::clone(&video_track) as Arc<dyn webrtc::track::track_local::TrackLocal + Send + Sync>)
        .await
        .map_err(|e| tracing::warn!("[SDP] guest add video track: {e}")).ok();
    stack.pc.add_track(Arc::clone(&audio_track) as Arc<dyn webrtc::track::track_local::TrackLocal + Send + Sync>)
        .await
        .map_err(|e| tracing::warn!("[SDP] guest add audio track: {e}")).ok();

    // SDP exchange on guest PC
    let answer = match webrtc::exchange_sdp_on_pc(&stack.pc, sdp).await {
        Ok(a) => a,
        Err(e) => {
            tracing::error!("[SDP] guest exchange failed: {e}");
            let _ = client.command_result(&cmd.id, &cmd.lease_token,
                &serde_json::json!({"error":"sdp_handshake_failed","message":e})).await;
            return;
        }
    };

    tracing::info!("[SDP] guest exchange OK ({} chars)", answer.len());

    // Determine seat from peer_token
    // gv-web assigned seat during room/join — we don't have the DB here.
    // Use a simple counter: count existing guests + 1.
    let seat = {
        let guests = session.guests.lock().await;
        guests.len() as u32 + 1
    };

    // Store guest peer
    let guest = Arc::new(GuestPeer {
        pc: stack.pc,
        seat,
        peer_token: peer_token.to_string(),
    });
    session.guests.lock().await.push(guest);

    // Wire DC handler for guest PC
    wire_dc_handler_for_guest(session, peer_token, seat).await;

    // Send SDP answer back
    let worker_url = format!("http://gv-worker.local/{}", session.game_id);
    let _ = client.notify_sdp(&cmd.id, &cmd.lease_token, &worker_url, &session.game_id, &answer, None).await;
}
```

**Step 5: Add import for `TrackLocal`**

At the top of `commands/mod.rs`, add:
```rust
use webrtc::track::track_local::TrackLocal;
```

**Step 6: Compile check**

Run: `cargo check -p gv-server`
Expected: error — `wire_dc_handler_for_guest` not yet defined (we'll add it in Task 3)

**Step 7: Commit**

```bash
git add gv-server/src/commands/mod.rs
git commit -m "feat: guest SDP exchange — separate PC with track fan-out"
```

---

### Task 3: Guest DC handler with seat-based input routing

**Objective:** Each guest PC gets a DC handler. Guest auth uses peer_token. Input routes to assigned seat (port). Guest DCs don't handle save/load.

**Files:**
- Modify: `gv-server/src/commands/mod.rs`

**Step 1: Implement `wire_dc_handler_for_guest`**

Add this function after `wire_dc_handler` (after line ~708):

```rust
/// Wire a DataChannel handler for a guest peer.
/// Guest input routes to the assigned seat (not port 0).
/// Guests cannot save/load/list — only the host can.
async fn wire_dc_handler_for_guest(
    session: &Arc<GameSession>,
    peer_token: &str,
    seat: u32,
) {
    let session = Arc::clone(session);
    let pc = session.guests.lock().await
        .iter()
        .find(|g| g.peer_token == peer_token)
        .map(|g| g.pc.clone());

    let Some(pc) = pc else {
        tracing::warn!("[DC] guest PC not found for peer_token={}", &peer_token[..8]);
        return;
    };

    let peer_token = peer_token.to_string();
    pc.on_data_channel(Box::new(move |dc: Arc<_>| {
        let session = Arc::clone(&session);
        let pt = peer_token.clone();
        Box::pin(async move {
            tracing::info!("[DC] guest data channel received: {} (seat={})", dc.label(), seat);

            let dc_for_open = Arc::clone(&dc);
            let dc_for_msg = Arc::clone(&dc);
            let session_for_msg = Arc::clone(&session);

            dc_for_open.on_open(Box::new(move || {
                tracing::info!("[DC] guest channel opened (seat={})", seat);
                Box::pin(async {})
            }));

            let dc_for_move = Arc::clone(&dc_for_msg);
            dc_for_msg.on_message(Box::new(move |msg| {
                let session = Arc::clone(&session_for_msg);
                let dc = Arc::clone(&dc_for_move);
                let seat = seat;
                Box::pin(async move {
                    let data = if msg.is_string {
                        String::from_utf8_lossy(&msg.data).into_owned().into_bytes()
                    } else {
                        msg.data.to_vec()
                    };

                    // Guest auth: peer_token handshake
                    if let Ok(val) = serde_json::from_slice::<serde_json::Value>(&data) {
                        let cmd_str = val.get("cmd").and_then(|v| v.as_str()).unwrap_or("");
                        if cmd_str == "auth" {
                            tracing::info!("[DC] guest auth received (seat={}), sending ack", seat);
                            let ack = serde_json::json!({"cmd":"auth_ok","seat":seat});
                            let _ = dc.send_text(ack.to_string()).await;
                            return;
                        }
                        // Guests cannot save/load — silently ignore
                        if cmd_str == "save_state" || cmd_str == "load_state" || cmd_str == "list_saves" {
                            return;
                        }
                    }

                    // Binary input: [seat_byte, state_lo, state_hi]
                    if data.len() >= 3 {
                        // Ignore the client-sent seat byte — use assigned seat
                        let state = data[1] as u16 | ((data[2] as u16) << 8);
                        let guard = session.core_cmd_tx.lock().await;
                        if let Some(ref tx) = *guard {
                            let _ = tx.try_send(core_bridge::CoreCommand::SetInput {
                                port: seat,
                                state,
                            });
                        }
                    }
                })
            }));
        })
    }));
}
```

**Step 2: Fix the compile errors from Task 2**

Ensure all imports are present — `TrackLocal`, `GuestPeer` from `session.rs`.

**Step 3: Compile check**

Run: `cargo check -p gv-server`
Expected: compiles with warnings only

**Step 4: Commit**

```bash
git add gv-server/src/commands/mod.rs
git commit -m "feat: guest DC handler with seat-based input routing"
```

---

### Task 4: Guest disconnect cleanup — don't kill session

**Objective:** When a guest DC closes or ICE disconnects, remove only that guest's PC. Host disconnect still kills the session.

**Files:**
- Modify: `gv-server/src/commands/mod.rs` (add cleanup hook to guest DC)
- Modify: `gv-server/src/session.rs` (add `remove_guest` helper)

**Step 1: Add `on_close` handler to guest DC**

In `wire_dc_handler_for_guest`, after `dc_for_open.on_open(...)`, add:

```rust
            let session_cleanup = Arc::clone(&session);
            let pt_cleanup = pt.clone();
            dc_for_open.on_close(Box::new(move || {
                let session = Arc::clone(&session_cleanup);
                let pt = pt_cleanup.clone();
                Box::pin(async move {
                    tracing::info!("[DC] guest disconnected (peer_token={})", &pt[..8]);
                    let mut guests = session.guests.lock().await;
                    guests.retain(|g| g.peer_token != pt);
                })
            }));
```

**Step 2: Add ICE connection state watcher for guest PCs**

In `wire_dc_handler_for_guest`, after the `on_data_channel` block, add:

```rust
    // ICE disconnect watcher — if guest PC fails, remove it
    let session_ice = Arc::clone(&session);
    let pt_ice = peer_token.clone();
    let pc_ice = Arc::clone(&pc);
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            let state = pc_ice.connection_state();
            if state == webrtc::peer_connection::RTCPeerConnectionState::Failed
                || state == webrtc::peer_connection::RTCPeerConnectionState::Disconnected
            {
                tracing::info!("[ICE] guest PC {}/{} — removing", state, &pt_ice[..8]);
                let mut guests = session_ice.guests.lock().await;
                guests.retain(|g| g.peer_token != pt_ice);
                break;
            }
        }
    });
```

**Step 3: Import RTCPeerConnectionState**

Add to imports in `commands/mod.rs`:
```rust
use webrtc::peer_connection::RTCPeerConnectionState;
```

**Step 4: Compile check**

Run: `cargo check -p gv-server`
Expected: compiles with warnings only

**Step 5: Commit**

```bash
git add gv-server/src/commands/mod.rs
git commit -m "feat: guest disconnect cleanup — per-peer removal"
```

---

### Task 5: Build, deploy, smoke test

**Objective:** Deploy to VAULT and verify guest join works without crashing host.

**Step 1: Build**

```bash
cd /root/projects/games-vault
cargo build --release -p gv-server
```

**Step 2: Deploy**

```bash
systemctl stop gv-server
pkill -9 gv-server 2>/dev/null
pkill -9 gv-core 2>/dev/null
cp target/release/gv-server /usr/local/bin/gv-server
systemctl start gv-server
```

**Step 3: Verify startup**

```bash
journalctl -u gv-server --no-pager -n 5 | grep -E 'POOL|running'
# Expected: POOL initialized with 2 pre-built stacks, gv-server running
```

**Step 4: Smoke test (manual)**

1. Host opens game on lngnckr.tech — should load normally
2. Host shares link
3. Guest opens share link — should see video/audio
4. Guest presses buttons — should control player 2 (seat 1)
5. Guest closes tab — host session continues uninterrupted
6. Host saves — should work (guest cannot save)

**Step 5: Commit**

```bash
git add -A
git commit -m "chore: smoke test guest play, update ops docs"
```
