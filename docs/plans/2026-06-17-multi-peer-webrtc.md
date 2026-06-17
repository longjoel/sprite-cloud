# Multi-Peer WebRTC: Players, Watchers, Chat — Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Worker supports up to 4 players (seat 0-3) + up to 10 watchers (seat 4-13) via multiple simultaneous WebRTC peer connections, with per-room chat over DataChannel.

**Architecture:** Replace the worker's single-peer model (`peer_connection: Mutex<Option<Arc<RTCPeerConnection>>>`) with a `PeerRegistry` that fans out encoded frames to all connected peer tracks. One streaming loop, N tracks. Core is loaded once by the host; guests join existing sessions. Seats assigned by client token with persistence across reconnects.

**Tech Stack:** Rust (gv-worker, gv-server), TypeScript (gv-web notify/command routes), vanilla JS (embedded player)

**Related issues:** #219 (TURN), #173 (seat assignment follow-up), #237 (link cable — separate feature)

---

## Security model (baked into each task)

| Threat | Mitigation | Where |
|---|---|---|
| Guest SDP kills host session | Per-peer PC creation, no cancel on guest join | Task 2, 4 |
| Watcher sends input to core | `PeerRole::Watcher` drops binary input at DC layer | Task 6 |
| Guest claims seat 0 (host) | `client_token` map, seat 0 reserved for `host_token` match | Task 5 |
| Room flooding (>10 watchers) | Reject SDP with "room full" after cap | Task 10 |
| Chat spam / abuse | Max message length (512 bytes), rate limit per peer | Task 8 |
| Stale tracks from disconnected peers | Remove from registry on peer disconnect | Task 3 |

## Design decisions (confirmed with user)

1. **Seat persistence across reconnects.** Client token (browser-generated UUID) maps to seat. Same token on reconnect → same seat. Survives browser refresh.
2. **Host = seat 0.** Only the peer whose auth matches `host_token` gets seat 0. Immutable for session lifetime.
3. **Chat = DataChannel only.** No HTTP polling chat. Chat is available only after WebRTC connects.
4. **Room codes.** Keep existing `room_token` (32-char hex in URL). No 6-char room code for now.
5. **Watcher cap.** Reject guest SDP with "room full" error after 10 watchers. Basic error — no fancy UI yet.

---

## Current state (what exists before tasks)

- `gv-worker/src/main_body.rs`: `AppState` has single `peer_connection`, single `cancel`, single `stream_handle`. `do_webrtc_handshake` kills old session on every SDP.
- `gv-worker/src/lib.rs`: Route `/sdp` → `handle_offer` → `do_webrtc_handshake`.
- `gv-server/src/main.rs`: Guest SDP offers with `room_token` are blocked with `command_result` (stopgap from session fix).
- Core handles (`core_frame_rx`, `core_cmd_tx`, etc.) live inside `do_webrtc_handshake` scope, not in `AppState`.
- VP8 encoder + audio pipeline created per-`do_webrtc_handshake` call.
- DataChannel auth via `host_token` already implemented per ADR 017.
- Input: binary RetroArch format, port byte = seat. `binary_input_allowed` checks `PeerRole::Host`.
- gv-web notify route: upserts sessions by game_id+server_id. Room token regenerated on reconnect.
- Browser player: `connectViaRelay` sends `sdp_offer` with `room_token`. Polls for SDP answer.

---

## Layer 1: Worker multi-peer refactor

### Task 1: Extract core + encoder into shared AppState

**Objective:** Move core handles, VP8 encoder, and audio pipeline from `do_webrtc_handshake` scope into `AppState` so they persist across peer connections.

**Files:**
- Modify: `gv-worker/src/main_body.rs`

**Step 1: Add shared core state to AppState**

Add these fields after the existing `exit_signal` field (around line 87):
```rust
/// Core handles — created once by the host, reused by all peers.
core_frame_rx: Mutex<Option<std::sync::mpsc::Receiver<Vec<u8>>>>,
core_cmd_tx: Mutex<Option<std::sync::mpsc::Sender<CoreCommand>>>,
core_sample_rate: Mutex<Option<f64>>,
/// Shared encoder — one instance, fanned out to all peer tracks.
encoder: Mutex<Option<vp8_encoder::Vp8Encoder>>,
/// Shared audio pipeline — one instance, fanned out to all peer tracks.
audio_pipeline: Mutex<Option<AudioPipeline>>,
/// Boolean flag: has the core been loaded yet?
core_loaded_flag: AtomicBool,
```

And initialize them in `gv-worker/src/lib.rs` where `AppState` is constructed.

**Step 2: Add a core init method**

```rust
impl AppState {
    async fn ensure_core_loaded(&self) -> Result<(), String> {
        if self.core_loaded_flag.load(Ordering::Relaxed) {
            return Ok(());
        }
        // Existing spawn_core_thread logic here, moved from do_webrtc_handshake
        // Store handles in AppState fields
        // Set core_loaded_flag = true
        Ok(())
    }
}
```

**Step 3: Modify do_webrtc_handshake to use shared state**

Instead of calling `core_bridge::spawn_core_thread()` and creating encoder/audio inline, call `state.ensure_core_loaded().await?` and use the shared encoder/audio from state.

**Verification:** Host connects, worker loads core once. Guest connects, core is NOT reloaded. Check logs show "[CORE] loading" only once.

---

### Task 2: Multi-peer track registry

**Objective:** Replace single `peer_connection` with a registry of video + audio tracks that the streaming loop writes to.

**Files:**
- Modify: `gv-worker/src/main_body.rs`

**Step 1: Define PeerState struct**

Add after existing `AppState` definition:
```rust
struct PeerState {
    /// Client token from browser (persistent across reconnects)
    client_token: String,
    /// Assigned seat: 0=host, 1-3=players, 4+=watchers
    seat: u8,
    /// Peer role (Host, Player, Watcher)
    role: PeerRole,
    /// WebRTC peer connection
    pc: Arc<RTCPeerConnection>,
    /// DataChannel (set after auth)
    dc: Mutex<Option<Arc<webrtc::data_channel::RTCDataChannel>>>,
    /// Per-peer cancel — cancels only this peer's ICE/DC tasks
    cancel: CancellationToken,
}

struct PeerRegistry {
    /// Active peer connections, keyed by client_token
    peers: Mutex<HashMap<String, PeerState>>,
    /// Video tracks — one per connected peer. Stream loop writes to all.
    video_tracks: Mutex<Vec<Arc<TrackLocalStaticSample>>>,
    /// Audio tracks — one per connected peer.
    audio_tracks: Mutex<Vec<Arc<TrackLocalStaticSample>>>,
    /// Seat → client_token mapping (for reconnects)
    seat_map: Mutex<HashMap<u8, String>>,
}
```

**Step 2: Add PeerRegistry to AppState**

Replace `peer_connection: Mutex<Option<Arc<RTCPeerConnection>>>` with:
```rust
peer_registry: PeerRegistry,
```

Update initialization in `gv-worker/src/lib.rs`.

**Step 3: Add peer add/remove methods**

```rust
impl PeerRegistry {
    async fn add_peer(&self, client_token: String, seat: u8, role: PeerRole, pc: Arc<RTCPeerConnection>,
                      video_track: Arc<TrackLocalStaticSample>, audio_track: Arc<TrackLocalStaticSample>) {
        let mut peers = self.peers.lock().await;
        let mut video = self.video_tracks.lock().await;
        let mut audio = self.audio_tracks.lock().await;
        let mut seats = self.seat_map.lock().await;
        
        // Remove old entry for this client_token if reconnecting
        if let Some(old) = peers.remove(&client_token) {
            old.cancel.cancel();
            video.retain(|t| !Arc::ptr_eq(t, &old_video_track));
            audio.retain(|t| !Arc::ptr_eq(t, &old_audio_track));
        }
        
        peers.insert(client_token.clone(), PeerState { client_token, seat, role, pc, dc: Mutex::new(None), cancel: CancellationToken::new() });
        video.push(video_track);
        audio.push(audio_track);
        seats.insert(seat, client_token);
    }
    
    async fn remove_peer(&self, client_token: &str) {
        // Remove from peers, tracks, seat_map
    }
    
    fn peer_count(&self) -> usize {
        // Return total connected peers
    }
    
    fn next_available_seat(&self) -> u8 {
        // Return next free seat (1-3 for players, 4+ for watchers)
    }
}
```

**Verification:** Host connects → 1 peer in registry. Guest connects → 2 peers. Guest disconnects → 1 peer. Registry correctly tracks additions/removals.

---

### Task 3: Streaming loop fan-out

**Objective:** Modify the streaming loop to write encoded frames to ALL tracks in the registry.

**Files:**
- Modify: `gv-worker/src/main_body.rs` (streaming loop section, ~line 870-1000)

**Step 1: Change the loop to iterate all tracks**

Current code writes to a single `video_track` and `audio_track`. Change to:
```rust
async fn stream_frames(
    mut core_rx: std::sync::mpsc::Receiver<Vec<u8>>,
    encoder: Arc<std::sync::Mutex<vp8_encoder::Vp8Encoder>>,
    registry: Arc<PeerRegistry>,
    cancel: CancellationToken,
    sample_rate: Option<f64>,
    audio_pipeline: Arc<tokio::sync::Mutex<Option<AudioPipeline>>>,
) {
    let mut tick = tokio::time::interval(Duration::from_secs_f64(1.0 / enc_fps));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    
    loop {
        tokio::select! {
            _ = cancel.cancelled() => break,
            _ = tick.tick() => {
                // Skip encode if no peers are connected
                if registry.peer_count() == 0 {
                    // Drain core frames to avoid buildup
                    while core_rx.try_recv().is_ok() {}
                    continue;
                }
                
                // Encode frame
                let encoded = { encoder.lock().unwrap().encode(&rgb)? };
                
                // Write to ALL video tracks
                let video_tracks = registry.video_tracks.lock().await;
                for track in video_tracks.iter() {
                    let _ = track.write_sample(&sample).await;
                }
                
                // Write to ALL audio tracks
                let audio_tracks = registry.audio_tracks.lock().await;
                // ... same pattern ...
            }
        }
    }
}
```

**Step 2: Stream loop lifecycle**

The stream loop starts when the first peer (host) connects and runs until the worker exits. It no longer cancels on peer disconnect — it just skips encoding when peer count is 0.

**Verification:** Host connects → stream runs. Host disconnects, guest still connected → stream still runs. All peers disconnect → stream skips encode (idle). New peer connects → stream resumes.

---

### Task 4: Per-peer SDP negotiation (guest join path)

**Objective:** Extract per-peer WebRTC setup from `do_webrtc_handshake` so guests can join without killing the host.

**Files:**
- Modify: `gv-worker/src/main_body.rs` (new function `add_guest_peer`)
- Modify: `gv-worker/src/lib.rs` (new route or modify `/sdp` handler)

**Step 1: Create `add_guest_peer` function**

```rust
/// Handle a guest joining an existing session. Creates a new peer connection
/// with its own tracks, negotiates SDP, and adds to the registry.
async fn add_guest_peer(
    state: Arc<AppState>,
    offer_sdp: &str,
    client_token: String,
    seat: u8,
    role: PeerRole,
) -> Result<SdpAnswer, String> {
    // Build peer connection (reuse existing API + media engine from state)
    let pc = build_peer_connection(&state).await?;
    
    // Create video + audio tracks
    let video_track = create_video_track();
    let audio_track = create_audio_track();
    pc.add_track(video_track.clone()).await?;
    pc.add_track(audio_track.clone()).await?;
    
    // Set up DataChannel handler (per-peer auth)
    setup_datachannel_handler(&pc, state.clone(), client_token.clone(), seat).await;
    
    // SDP exchange
    pc.set_remote_description(RTCSessionDescription::offer(offer_sdp)?).await?;
    let answer = pc.create_answer(None).await?;
    pc.set_local_description(answer.clone()).await?;
    
    // ICE gathering
    wait_for_ice_gathering(&pc).await?;
    let local = pc.local_description().await.ok_or("no local desc")?;
    
    // Add to registry
    state.peer_registry.add_peer(client_token, seat, role, pc, video_track, audio_track).await;
    
    Ok(SdpAnswer { sdp: local.sdp })
}
```

**Step 2: Modify `/sdp` handler to distinguish host vs guest**

```rust
async fn handle_offer(state, offer) {
    let client_token = offer.client_token.as_deref().unwrap_or("");
    let is_host = offer.host_token.as_deref() == Some(&state.host_token.lock().await.as_deref().unwrap_or(""));
    
    if is_host && state.peer_registry.peer_count() == 0 {
        // Host first connect — full session init (load core, start stream)
        let answer = do_webrtc_handshake(state, &offer.sdp).await?;
        // Add host to registry as seat 0
        state.peer_registry.add_peer(client_token.to_string(), 0, PeerRole::Host, ...).await;
        Ok(answer)
    } else if state.core_loaded_flag.load(Ordering::Relaxed) {
        // Guest join — add to existing session
        let seat = state.peer_registry.next_available_seat();
        let role = if seat <= 3 { PeerRole::Player } else { PeerRole::Watcher };
        let answer = add_guest_peer(state, &offer.sdp, client_token.to_string(), seat, role).await?;
        Ok(answer)
    } else {
        Err("session not ready".into())
    }
}
```

**Step 3: `do_webrtc_handshake` no longer cancels previous session**

Remove `old_cancel.cancel()` and `handle.abort()`. The function now only initializes the session (first peer).

**Verification:** Host connects → core loads, stream starts. Guest connects → core NOT reloaded, new PC added to registry, stream continues for both.

---

### Task 5: Seat assignment with client token persistence

**Objective:** Assign seats based on client token. Same token on reconnect → same seat.

**Files:**
- Modify: `gv-worker/src/main_body.rs` (seat assignment logic)
- Modify: `gv-web/public/player/play.js` (client token generation)

**Step 1: Generate client token in browser**

In `play.js`, generate a client token at `startPlayer` call (similar to `hostToken`):
```javascript
const clientToken = randomUUID();
// Pass to connectViaRelay
await player.connectViaRelay(serverId, gameId, hostToken, joinToken || undefined, clientToken);
```

**Step 2: Pass client_token in SDP offer**

In `index.js` `connectViaRelay`, add `client_token` to the SDP payload:
```javascript
payload: { game_id: gameId, sdp: offer.sdp, host_token: hostToken, client_token: clientToken }
```

**Step 3: Worker seat assignment**

In `add_guest_peer`:
```rust
let seat = {
    let seats = state.peer_registry.seat_map.lock().await;
    if let Some(existing_seat) = seats.iter().find(|(_, token)| *token == &client_token) {
        // Reconnect — return same seat
        existing_seat.0
    } else {
        // New peer — assign next available
        next_player_seat(seats)
    }
};
```

Host always gets seat 0 (only if `host_token` matches).

**Step 4: Persist seat across reconnects**

When a peer disconnects, keep the seat→client_token mapping in `seat_map`. Only clear it when the session ends.

**Verification:** Player B connects → gets seat 1. Player B refreshes → reconnects → gets seat 1 again. Player C connects → gets seat 2.

---

### Task 6: Input routing per seat + peer role

**Objective:** Forward binary input to core with correct port (seat number). Drop input from watchers.

**Files:**
- Modify: `gv-worker/src/main_body.rs` (binary input handler)

**Step 1: Modify binary input handler**

Current code sends `port` byte from the message. For multi-peer, override the port with the sender's assigned seat:
```rust
if msg.data.len() == 3 {
    let seat = {
        let peers = state.peer_registry.peers.lock().await;
        peers.get(&sender_client_token).map(|p| p.seat).unwrap_or(0)
    };
    
    // Watchers cannot send input
    let role = peers.get(&sender_client_token).map(|p| p.role);
    if role == Some(PeerRole::Watcher) {
        tracing::debug!("[DC] watcher input dropped");
        return;
    }
    
    let state_bits = u16::from_le_bytes([msg.data[1], msg.data[2]]);
    let _ = core_tx.as_ref().map(|tx| {
        tx.try_send(CoreCommand::SetInput { port: seat as u32, state: state_bits })
    });
}
```

**Step 2: Expand PeerRole enum**

Add `Player` variant:
```rust
enum PeerRole {
    Host,     // seat 0, full permissions
    Player,   // seat 1-3, input only
    Watcher,  // seat 4+, receive-only
}
```

Update `binary_input_allowed` to accept `Host` and `Player`.

**Verification:** Host presses A → core receives port=0. Player B (seat 1) presses A → core receives port=1. Watcher presses A → input dropped, warning logged.

---

## Layer 2: Chat

### Task 7: DataChannel chat message type

**Objective:** Add `chat` command to the DataChannel protocol. Worker broadcasts to all peers.

**Files:**
- Modify: `gv-worker/src/main_body.rs` (DataChannel message handler)
- Modify: `gv-web/public/player/index.js` (send + receive chat)

**Step 1: Worker chat handler**

In the DataChannel `on_message` handler:
```rust
// After existing binary + auth checks:
if let Ok(msg) = serde_json::from_str::<serde_json::Value>(&text) {
    if msg.get("cmd") == Some(&json!("chat")) {
        let text = msg.get("text").and_then(|v| v.as_str()).unwrap_or("");
        if text.len() > 512 {
            return; // drop oversized
        }
        let sender_seat = /* get from peer */;
        broadcast_chat(&state.peer_registry, sender_seat, text, &sender_client_token).await;
        return;
    }
}
```

**Step 2: Broadcast function**

```rust
async fn broadcast_chat(registry: &PeerRegistry, from_seat: u8, text: &str, skip_token: &str) {
    let msg = serde_json::json!({
        "type": "chat",
        "seat": from_seat,
        "text": text,
    });
    let payload = serde_json::to_string(&msg).unwrap();
    
    let peers = registry.peers.lock().await;
    for (token, peer) in peers.iter() {
        if token == skip_token { continue; }
        if let Some(dc) = peer.dc.lock().await.as_ref() {
            if dc.ready_state() == RTCDataChannelState::Open {
                let _ = dc.send_text(&payload).await;
            }
        }
    }
}
```

**Step 3: Browser send + receive**

In `index.js`:
```javascript
// Send
sendChat(text) {
    this._sendJSON({ cmd: "chat", text: text.substring(0, 512) });
}

// Receive (in _handleDataChannelMessage)
case "chat":
    this._onChatMessage?.(msg.seat, msg.text);
    break;
```

**Verification:** Host sends chat → guest receives. Guest sends chat → host + other guests receive. Message >512 bytes dropped.

---

### Task 8: Chat UI in embedded player

**Objective:** Add chat overlay to the embedded player HTML/JS.

**Files:**
- Modify: `gv-worker/src/embedded/index.html`
- Modify: `gv-worker/src/embedded/index.js` (or `gv-web/public/player/index.js`)

**Step 1: Chat UI elements**

Add to the player HTML:
```html
<div id="chat-panel" class="hidden">
    <div id="chat-messages"></div>
    <input id="chat-input" type="text" maxlength="512" placeholder="Chat…" />
</div>
<button id="chat-toggle">💬</button>
```

**Step 2: Chat JS logic**

```javascript
// Toggle visibility
document.getElementById('chat-toggle').onclick = () => {
    document.getElementById('chat-panel').classList.toggle('hidden');
};

// Send on Enter
document.getElementById('chat-input').onkeydown = (e) => {
    if (e.key === 'Enter') {
        const text = e.target.value.trim();
        if (text) player.sendChat(text);
        e.target.value = '';
    }
};

// Receive
player._onChatMessage = (seat, text) => {
    const div = document.createElement('div');
    div.textContent = `[P${seat + 1}] ${text}`;
    document.getElementById('chat-messages').appendChild(div);
    div.scrollIntoView({ behavior: 'smooth' });
};
```

**Verification:** Press 💬 → chat panel appears. Type message, press Enter → sent via DataChannel. Other peer receives → appears in their chat panel.

---

## Layer 3: Room management

### Task 9: Room state broadcast

**Objective:** When a peer connects or disconnects, broadcast updated player/watcher list to all peers.

**Files:**
- Modify: `gv-worker/src/main_body.rs`

**Step 1: Broadcast function**

```rust
async fn broadcast_room_state(registry: &PeerRegistry) {
    let peers = registry.peers.lock().await;
    let players: Vec<_> = peers.iter()
        .filter(|(_, p)| p.role == PeerRole::Host || p.role == PeerRole::Player)
        .map(|(_, p)| serde_json::json!({ "seat": p.seat, "connected": true }))
        .collect();
    let watcher_count = peers.iter().filter(|(_, p)| p.role == PeerRole::Watcher).count();
    
    let msg = serde_json::json!({
        "type": "room_state",
        "players": players,
        "watchers": watcher_count,
    });
    
    // Broadcast to all
    for (_, peer) in peers.iter() {
        if let Some(dc) = peer.dc.lock().await.as_ref() {
            if dc.ready_state() == RTCDataChannelState::Open {
                let _ = dc.send_text(&serde_json::to_string(&msg).unwrap()).await;
            }
        }
    }
}
```

**Step 2: Call on connect/disconnect**

In `PeerRegistry::add_peer` and `remove_peer`, call `broadcast_room_state` after the mutation.

**Step 3: Browser handler**

In `_handleDataChannelMessage`:
```javascript
case "room_state":
    this._onRoomState?.(msg.players, msg.watchers);
    break;
```

**Verification:** Host connects → receives `room_state` with 1 player. Guest joins → both receive updated state with 2 players. Guest disconnects → host receives updated state.

---

### Task 10: Watcher cap enforcement

**Objective:** Reject guest SDP when 10 watchers are already connected.

**Files:**
- Modify: `gv-worker/src/main_body.rs` (add_guest_peer)
- Modify: `gv-server/src/main.rs` (SDP relay error handling)

**Step 1: Worker-side cap check**

In `add_guest_peer`, before creating peer connection:
```rust
let watcher_count = {
    let peers = state.peer_registry.peers.lock().await;
    peers.values().filter(|p| p.role == PeerRole::Watcher).count()
};
if role == PeerRole::Watcher && watcher_count >= 10 {
    return Err("room full".to_string());
}
```

**Step 2: gv-server error relay**

In gv-server's SDP relay handler, when the worker returns an error:
```rust
Err(e) if e.contains("room full") => {
    // Notify guest browser with error
    let result = serde_json::json!({ "error": "room_full", "message": "Room is full (max 10 watchers)" });
    client.command_result(&cmd.id, &cmd.lease_token, &result).await?;
}
```

**Verification:** 10 watchers connected → 11th guest gets "room full" error. Player connects (seat 1-3) → accepted even with 10 watchers.

---

## Layer 4: gv-server SDP relay re-enable

### Task 11: Re-enable guest SDP forwarding

**Objective:** Remove the guest SDP block in gv-server. Forward guest SDP to worker with client_token. Relay answer back to guest browser.

**Files:**
- Modify: `gv-server/src/main.rs` (remove `is_guest` block)
- Modify: `gv-server/src/gv_web.rs` (SDP relay response handling)

**Step 1: Remove the guest SDP block**

In `gv-server/src/main.rs`, remove the `is_guest` check and `command_result` call (the block added in the session fix). Restore the original SDP forwarding logic. The forwarding code was:
```rust
if let Some(worker) = workers.get(game_id) {
    let internal_url = internal_worker_url(&worker.url);
    // POST {internal_url}/sdp with sdp
    // On success: notify_sdp with answer
}
```

**Step 2: Forward client_token to worker**

Add `client_token` to the forwarded SDP JSON:
```rust
let client_token = cmd.payload.get("client_token").and_then(|v| v.as_str()).unwrap_or("");
.json(&serde_json::json!({ "sdp": sdp, "client_token": client_token }))
```

**Step 3: Handle worker errors**

When the worker returns an error (non-2xx or error in SDP answer), relay the error to the guest via `command_result`:
```rust
Ok(resp) if !resp.status().is_success() => {
    let body = resp.text().await.unwrap_or_default();
    let result = serde_json::json!({ "error": "worker_error", "message": body });
    client.command_result(&cmd.id, &cmd.lease_token, &result).await?;
}
```

**Step 4: Browser handles relay errors**

In `index.js` `_pollForAnswer`, after getting the notify response, check for `error` field:
```javascript
if (data.error) {
    throw new Error(data.message || data.error);
}
```

**Verification:** Guest connects → SDP forwarded to worker → worker returns answer → guest browser receives SDP answer → WebRTC connects. Host stream continues uninterrupted.

---

### Task 12: Browser-side client token + seat display

**Objective:** Generate client token, pass it through the relay, display seat number in UI.

**Files:**
- Modify: `gv-web/public/player/play.js`
- Modify: `gv-web/public/player/index.js`

**Step 1: Client token in play.js**

In `startPlayer`:
```javascript
const clientToken = randomUUID();
// ... pass to doConnect closure and connectViaRelay
await player.connectViaRelay(serverId, gameId, hostToken, joinToken || undefined, clientToken);
```

**Step 2: Client token in index.js connectViaRelay**

```javascript
async connectViaRelay(serverId, gameId, hostToken, roomToken, clientToken) {
    // ...
    payload: { game_id: gameId, sdp: offer.sdp, host_token: hostToken, client_token: clientToken }
}
```

**Step 3: Seat display from room_state**

When `room_state` message arrives with the player's own seat, show it in UI:
```javascript
case "room_state":
    const myPlayer = msg.players.find(p => /* match client token */);
    if (myPlayer) this._mySeat = myPlayer.seat;
    updateSeatDisplay();
```

**Verification:** Host sees "P1" indicator. Player B sees "P2" indicator. Watcher sees "Watching" indicator.

---

## Task 13: Integration smoke test

**Objective:** End-to-end test of the full multi-peer flow.

**Steps:**
1. Start gv-worker (via gv-server)
2. Host connects via WebRTC → verifies video + audio
3. Guest 1 connects (player) → verifies video + audio, sends input → verified on host's screen
4. Guest 2 connects (watcher) → verifies video + audio, sends input → dropped (watcher)
5. Chat: host sends message → both guests receive
6. Guest 1 disconnects → host + guest 2 get updated room_state
7. Guest 1 reconnects → gets same seat back
8. 11 watchers attempt → 11th gets "room full"
9. Host stops game → all peers disconnected, worker exits cleanly

**Verification:** All steps pass without crashes, stream interruptions, or stale state.

---

## Out of scope (existing issues)

- **#219 TURN support** — needed for remote guests behind restrictive NAT. gv-ice-config already supports TURN URLs. Separate issue.
- **#237 Link cable multiplayer** — different architecture (multiple workers, local TCP). Separate feature.
- **#173 Viewer input seat assignment follow-up** — closed by this plan (Task 5).
- **Fancy room UI** — player names, avatars, spectator count badges, kick button. Post-MVP polish.
