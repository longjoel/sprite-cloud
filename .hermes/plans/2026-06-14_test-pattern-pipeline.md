# Test-Pattern Pipeline with Stats Overlay — Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Turn the worker→player WebRTC pipeline into an observable test harness. When no emulator core is loaded, the worker streams a test pattern with audio, the player renders a stats HUD (FPS, bitrate, latency), and both sides exchange diagnostic data over a DataChannel. This gives us a concrete baseline to measure latency, throughput, and pipeline health before adding real game content.

**Architecture:** Worker adds a DataChannel alongside the video track — it pushes per-frame stats (frame number, encoded bytes, encode μs) and echoes pings for RTT measurement. An audio track (440 Hz test tone) proves the audio pipeline. Player renders a translucent HUD overlay on the `<video>` element showing real-time FPS, bitrate, latency, resolution, and connection state.

**Input contract (designed for multi-seat from day one):** A single WebRTC connection can drive multiple player seats — e.g. one laptop with keyboard (P1) + gamepad (P2). The player declares which seats it occupies via `?seats=0,1` in the URL. Every input message over the DataChannel includes a `seat` field (0–3) so the worker routes the event to the correct emulator port regardless of which client sent it. The worker's input handler is seat-aware from the first implementation; no retrofitting later. This stays entirely in test-pattern mode — no emulator core is touched.

**Tech Stack:** Rust (axum, webrtc-rs, libvpx), vanilla JS (no framework), WebRTC DataChannel + RTCDataChannel JS API

**Current state:** Worker sends VP8 video only (no DataChannel, no audio track). Player receives video via ontrack, renders to `<video>`, shows a one-line text status. No stats, no DataChannel, no audio, no input forwarding.

---

### Task 1: Add audio test tone track to worker

**Objective:** Worker creates an audio track alongside video and streams a 440 Hz sine wave test tone. This proves the audio pipeline works end-to-end before we need real emulator audio.

**Files:**
- Modify: `gv-worker/src/main.rs:200-220` (add audio track after video track creation)
- Create: `gv-worker/src/test_tone.rs` (sine wave generator)
- Modify: `gv-worker/src/main.rs:1-5` (add `mod test_tone`)

**Step 1: Create test_tone.rs**

```rust
//! 440 Hz sine wave test tone — 16-bit mono PCM @ 48 kHz.
//!
//! Generates 960 samples per frame (20 ms at 48 kHz), suitable for
//! the Opus codec's default frame size.

pub const SAMPLE_RATE: u32 = 48_000;
pub const CHANNELS: u16 = 1;
pub const SAMPLES_PER_FRAME: usize = 960; // 20ms @ 48kHz

/// Generate one frame of 440 Hz sine wave samples.
/// Returns i16 interleaved mono PCM.
pub fn generate_tone(frame_num: u64) -> Vec<i16> {
    let freq = 440.0;
    let samples = SAMPLES_PER_FRAME;
    let mut buf = Vec::with_capacity(samples);
    let phase_offset = (frame_num as f64 * samples as f64) / SAMPLE_RATE as f64 * freq * 2.0 * std::f64::consts::PI;
    for i in 0..samples {
        let t = i as f64 / SAMPLE_RATE as f64;
        let sample = (phase_offset + t * freq * 2.0 * std::f64::consts::PI).sin();
        buf.push((sample * 16_384.0) as i16); // -18 dBFS to avoid clipping
    }
    buf
}
```

**Step 2: Wire audio track in `do_webrtc_handshake`**

After the video track creation (around line 220), add:

```rust
// ---- Create audio track ----
let audio_track = Arc::new(TrackLocalStaticSample::new(
    RTCRtpCodecCapability {
        mime_type: webrtc::api::media_engine::MIME_TYPE_OPUS.to_owned(),
        clock_rate: 48_000,
        channels: 2,
        sdp_fmtp_line: "minptime=10;useinbandfec=1".to_string(),
        rtcp_feedback: vec![],
    },
    "audio".to_owned(),
    "gv-worker".to_owned(),
));

peer_connection
    .add_track(Arc::clone(&audio_track) as Arc<dyn TrackLocal + Send + Sync>)
    .await
    .map_err(|e| format!("add audio track: {}", e))?;
```

**Step 3: Stream audio frames alongside video**

Modify `stream_vp8_frames` to also send audio. Add `audio_track` parameter. In the tick loop, every tick:

```rust
let tone = test_tone::generate_tone(frame_num);
let audio_sample = Sample {
    data: bytemuck::cast_slice(&tone).to_vec().into(),
    duration: frame_interval,
    packet_timestamp: (frame_num as u32).wrapping_mul(48_000 / 30),
    ..Default::default()
};
if let Err(e) = audio_track.write_sample(&audio_sample).await {
    tracing::error!("[STREAM] Audio write error: {}", e);
}
```

**Step 4: Verify**

```bash
cd gv-worker && cargo test
```

Expected: 13 tests pass (no audio-specific test yet — that comes later).

**Step 5: Commit**

```bash
git add gv-worker/src/test_tone.rs gv-worker/src/main.rs
git commit -m "feat(worker): add 440 Hz test tone audio track"
```

---

### Task 2: Add DataChannel for stats + ping/pong to worker

**Objective:** Worker creates a DataChannel alongside video/audio, sends per-frame stats (JSON), and echoes incoming pings for RTT measurement.

**Files:**
- Modify: `gv-worker/src/main.rs:180-220` (add DataChannel after PC creation)
- Modify: `gv-worker/src/main.rs:313-392` (stream_vp8_frames sends stats over DC)

**Step 1: Create DataChannel in `do_webrtc_handshake`**

After `peer_connection` is created (line 184):

```rust
// ---- Create DataChannel for stats + ping/pong ----
let dc = peer_connection
    .create_data_channel("diagnostics", None)
    .await
    .map_err(|e| format!("create data channel: {}", e))?;

// Echo pings for RTT measurement
let dc_rx = Arc::new(tokio::sync::Mutex::new(dc.detach().await.map_err(|e| format!("detach dc: {}", e))?));

dc.on_message(Box::new({
    let dc_write = dc_rx.clone();
    move |msg| {
        let dc = dc_write.clone();
        Box::pin(async move {
            let text = String::from_utf8_lossy(&msg.data);
            if text.trim() == "ping" {
                let dc = dc.lock().await;
                if let Some(ref dc) = *dc {
                    let _ = dc.write(&bytes::Bytes::from("pong")).await;
                }
            }
        })
    }
}));
```

**Step 2: Send per-frame stats in stream loop**

After encoding a frame, send stats over DataChannel:

```rust
let stats = serde_json::json!({
    "type": "stats",
    "frame": frame_num,
    "bytes": encoded.len(),
    "encode_us": encode_duration.as_micros(),
});
if let Some(ref dc) = *dc_write.lock().await {
    let _ = dc.write(&bytes::Bytes::from(stats.to_string())).await;
}
```

Add `dc_write: Arc<Mutex<Option<webrtc::data_channel::RTCDataChannel>>>` parameter to `stream_vp8_frames`.

**Step 3: Measure encode duration**

Wrap the `encoder.encode()` call with `std::time::Instant::now()`.

**Step 4: Verify**

```bash
cd gv-worker && cargo build 2>&1
```

Expected: compiles clean. Run tests. Expected: 13 pass.

**Step 5: Commit**

```bash
git add gv-worker/src/main.rs
git commit -m "feat(worker): add DataChannel with stats push + ping/pong"
```

---

### Task 3: Overhaul player HTML/CSS for stats HUD

**Objective:** Replace the bare `<pre id="status">` with a proper stats overlay that shows connection state, FPS, bitrate, latency, and resolution. Dark semi-transparent HUD in the top-left corner.

**Files:**
- Modify: `gv-web/public/player/index.html` (full rewrite of styles + layout)

**Step 1: Rewrite `index.html`**

Replace the entire file with:

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Games Vault — Player</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #0a0a0a;
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100vh;
    overflow: hidden;
    font: 13px/1.4 'SF Mono', 'Cascadia Code', 'Fira Code', monospace;
  }
  #stage { position: relative; }
  video {
    image-rendering: pixelated;
    max-width: 100vw;
    max-height: 100vh;
    display: block;
  }
  /* ---- HUD overlay ---- */
  #hud {
    position: absolute;
    top: 8px; left: 8px;
    background: rgba(0,0,0,0.72);
    color: #eee;
    padding: 8px 12px;
    border-radius: 6px;
    font-size: 12px;
    min-width: 180px;
    pointer-events: none;
  }
  #hud .label { color: #888; margin-right: 6px; }
  #hud .value { color: #0f0; }
  #hud .warn  { color: #fa0; }
  #hud .err   { color: #f44; }
  #hud .dim   { color: #666; }
  #hud .row   { margin-bottom: 2px; white-space: nowrap; }
  /* ---- Fullscreen button ---- */
  #fullscreen-btn {
    position: absolute;
    bottom: 8px; right: 8px;
    background: rgba(0,0,0,0.5);
    color: #aaa;
    border: 1px solid #444;
    padding: 4px 8px;
    border-radius: 4px;
    cursor: pointer;
    font: inherit;
    font-size: 11px;
    pointer-events: auto;
  }
  #fullscreen-btn:hover { background: rgba(255,255,255,0.1); color: #fff; }
  /* ---- Connecting state ---- */
  #connecting {
    position: absolute;
    top: 50%; left: 50%;
    transform: translate(-50%, -50%);
    color: #aaa;
    font-size: 14px;
    text-align: center;
  }
  .spinner {
    width: 24px; height: 24px;
    border: 2px solid #333;
    border-top-color: #0f0;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
    margin: 0 auto 8px;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
  <div id="stage">
    <video id="video" autoplay playsinline muted></video>
    <div id="connecting"><div class="spinner"></div>connecting…</div>
    <div id="hud" style="display:none">
      <div class="row"><span class="label">state</span><span class="value" id="st-state">—</span></div>
      <div class="row"><span class="label">fps</span><span class="value" id="st-fps">—</span></div>
      <div class="row"><span class="label">bitrate</span><span class="value" id="st-br">—</span></div>
      <div class="row"><span class="label">rtt</span><span class="value" id="st-rtt">—</span></div>
      <div class="row"><span class="label">res</span><span class="dim" id="st-res">—</span></div>
      <div class="row"><span class="label">audio</span><span class="dim" id="st-audio">—</span></div>
      <div class="row"><span class="label">seats</span><span class="dim" id="st-seats">—</span></div>
    </div>
    <button id="fullscreen-btn" onclick="toggleFullscreen()">⛶ fullscreen</button>
  </div>
  <script type="module" src="index.js"></script>
</body>
</html>
```

**Step 2: Verify**

Open in browser. The layout should render with a black background, a centered video area, and a hidden HUD div.

**Step 3: Commit**

```bash
git add gv-web/public/player/index.html
git commit -m "feat(player): add stats HUD layout and fullscreen button"
```

---

### Task 4: Build stats collector + HUD renderer in player JS

**Objective:** Add a `StatsCollector` class that tracks frame count, incoming bytes, and computes rolling FPS/bitrate. Wire it to the HUD DOM elements. Expose it from the module for testing.

**Files:**
- Modify: `gv-web/public/player/index.js` (add StatsCollector class, wire to GvPlayer)

**Step 1: Add StatsCollector class**

```js
// ── StatsCollector ──────────────────────────────────────────────────────

const STATS_WINDOW_MS = 2000; // Rolling window for FPS/bitrate calculation

export class StatsCollector {
  constructor() {
    this._frames = [];        // [{ts: DOMHighResTimeStamp, bytes: number}]
    this._totalFrames = 0;
    this._totalBytes = 0;
    this._firstFrameTs = null;
    this._startTime = performance.now();
  }

  recordFrame(byteCount) {
    const now = performance.now();
    this._frames.push({ ts: now, bytes: byteCount });
    this._totalFrames++;
    this._totalBytes += byteCount;
    if (this._firstFrameTs === null) this._firstFrameTs = now;

    // Prune old entries outside the window
    const cutoff = now - STATS_WINDOW_MS;
    while (this._frames.length > 0 && this._frames[0].ts < cutoff) {
      this._frames.shift();
    }
  }

  get fps() {
    if (this._frames.length < 2) return 0;
    const elapsed = (this._frames[this._frames.length - 1].ts - this._frames[0].ts) / 1000;
    return elapsed > 0 ? Math.round(this._frames.length / elapsed) : 0;
  }

  get bitrateKbps() {
    if (this._frames.length < 2) return 0;
    const totalBytes = this._frames.reduce((s, f) => s + f.bytes, 0);
    const elapsed = (this._frames[this._frames.length - 1].ts - this._frames[0].ts) / 1000;
    // kbps = (bytes * 8 / 1000) / seconds
    return elapsed > 0 ? Math.round((totalBytes * 8) / 1000 / elapsed) : 0;
  }

  get totalFrames() { return this._totalFrames; }
  get totalBytes() { return this._totalBytes; }
  get uptime() { return (performance.now() - this._startTime) / 1000; }

  reset() {
    this._frames = [];
    this._totalFrames = 0;
    this._totalBytes = 0;
    this._firstFrameTs = null;
    this._startTime = performance.now();
  }
}
```

**Step 2: Wire StatsCollector to HUD rendering**

Add a `_renderHud()` method to GvPlayer that's called on stats updates:

```js
_renderHud() {
  const set = (id, text, cls) => {
    const el = document.getElementById(id);
    if (el) { el.textContent = text; el.className = cls || 'value'; }
  };
  if (!this._stats) return;

  set('st-state', this._state, this._state === 'error' ? 'err' : this._state === 'connected' ? 'value' : 'warn');
  set('st-fps', this._stats.fps, 'value');
  set('st-br', this._stats.bitrateKbps > 0 ? `${this._stats.bitrateKbps} kbps` : '—', 'value');
  set('st-rtt', this._rttMs !== null ? `${this._rttMs} ms` : '—', this._rttMs !== null && this._rttMs > 100 ? 'warn' : 'value');
  set('st-res', `${VIDEO_WIDTH}×${VIDEO_HEIGHT}`, 'dim');
  set('st-seats', this._occupiedSeats ? [...this._occupiedSeats].join(',') : '—', 'dim');
}
```

**Step 3: Expose from module**

Add `export { StatsCollector }` to the module exports.

**Step 4: Commit**

```bash
git add gv-web/public/player/index.js
git commit -m "feat(player): add StatsCollector class with rolling FPS/bitrate"
```

---

### Task 5: Handle DataChannel in player — stats ingestion + ping/pong

**Objective:** Player receives per-frame stats over the DataChannel, feeds them to StatsCollector, and measures RTT via ping/pong. Updates the HUD every ~500ms.

**Files:**
- Modify: `gv-web/public/player/index.js` (add DataChannel handling to GvPlayer.connect)

**Step 1: Listen for DataChannel on the peer connection**

In `connect()`, after creating `this._pc`, add:

```js
// Handle DataChannel from worker
this._pc.ondatachannel = (event) => {
  const dc = event.channel;
  dc.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'stats') {
        this._stats.recordFrame(msg.bytes || 0);
      }
    } catch {
      // non-JSON message (e.g., "pong")
      if (e.data === 'pong') {
        this._lastPongTs = performance.now();
      }
    }
  };
  this._dataChannel = dc;
};
```

**Step 2: Add ping/pong loop**

```js
_startPingLoop() {
  this._pingTimer = setInterval(() => {
    if (this._dataChannel && this._dataChannel.readyState === 'open') {
      this._lastPingTs = performance.now();
      this._dataChannel.send('ping');
    }
  }, 1000); // Ping every 1 second
}

get rttMs() {
  if (this._lastPingTs === null || this._lastPongTs === null) return null;
  return Math.round(this._lastPongTs - this._lastPingTs);
}
```

**Step 3: Add HUD refresh interval**

```js
_startHudRefresh() {
  this._hudTimer = setInterval(() => this._renderHud(), 500);
}
```

Start it in `connect()`, clear in `disconnect()`.

**Step 4: Update `disconnect()` to clean up timers**

```js
disconnect() {
  // ... existing cleanup ...
  if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
  if (this._hudTimer) { clearInterval(this._hudTimer); this._hudTimer = null; }
  this._lastPingTs = null;
  this._lastPongTs = null;
  this._dataChannel = null;
}
```

**Step 5: Verify**

Run tests:
```bash
cd gv-player && node --test tests/player.test.js
```

Expected: existing 8 unit tests pass. Add new test for StatsCollector (Task 6).

**Step 6: Commit**

```bash
git add gv-web/public/player/index.js
git commit -m "feat(player): DataChannel stats ingestion + ping/pong RTT"
```

---

### Task 6: Add StatsCollector unit tests

**Objective:** Test the rolling FPS/bitrate calculations.

**Files:**
- Modify: `gv-player/tests/player.test.js`

**Step 1: Add test suite**

```js
describe("StatsCollector", () => {
  let stats;

  before(() => {
    stats = new StatsCollector();
  });

  it("starts with zero fps and bitrate", () => {
    assert.equal(stats.fps, 0);
    assert.equal(stats.bitrateKbps, 0);
  });

  it("computes fps from recorded frames", async () => {
    stats.reset();
    const now = performance.now();
    // Simulate 30 frames over 1 second
    for (let i = 0; i < 30; i++) {
      stats.recordFrame(1000);
    }
    // Can't mock performance.now precisely, but fps should be > 0
    assert.ok(stats.fps > 0, "fps should be positive after recording frames");
  });

  it("resets to zero", () => {
    stats.reset();
    assert.equal(stats.fps, 0);
    assert.equal(stats.totalFrames, 0);
  });
});
```

Import `StatsCollector` at the top.

**Step 2: Run tests**

```bash
cd gv-player && node --test tests/player.test.js
```

Expected: 11 tests pass (8 existing + 3 new).

**Step 3: Commit**

```bash
git add gv-player/tests/player.test.js
git commit -m "test(player): add StatsCollector unit tests"
```

---

### Task 7: Add keyboard input forwarding with seat model

**Objective:** Player captures keyboard and gamepad events, tags them with a `seat` number (0–3), and sends them as JSON over the DataChannel. Worker logs received input with seat routing. A single browser can serve multiple seats (e.g. keyboard=P1 seat 0, gamepad=P2 seat 1).

**Files:**
- Modify: `gv-web/public/player/index.js` (add keyboard/gamepad listener, send over DC with seat)
- Modify: `gv-worker/src/main.rs` (log received input with seat)

**Step 1: Parse seat assignment from URL**

In the auto-connect bootstrap:

```js
const seatParam = params.get('seats') || '0';
const seats = seatParam.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
const occupiedSeats = new Set(seats.length ? seats : [0]);
```

**Step 2: Map input sources to seats**

```js
// Map from input source to seat number
const inputMap = new Map();
// Default: keyboard → seat 0
inputMap.set('keyboard', seats[0] ?? 0);
// Gamepad index → next available seat
window.addEventListener('gamepadconnected', (e) => {
  if (seats.length > 1) {
    inputMap.set(`gamepad-${e.gamepad.index}`, seats[1] ?? 1);
  }
});
```

**Step 3: Player — keyboard/gamepad capture with seat**

```js
const GAME_KEYS = new Set([
  'ArrowUp','ArrowDown','ArrowLeft','ArrowRight',
  'Enter','Escape','Space','ShiftLeft','ShiftRight',
  'KeyZ','KeyX','KeyA','KeyS','KeyQ','KeyW',
  'Digit1','Digit2','Digit3','Digit4',
]);

function sendInput(seat, code, pressed) {
  if (!player._dataChannel || player._dataChannel.readyState !== 'open') return;
  player._dataChannel.send(JSON.stringify({
    type: 'input',
    seat,
    source: 'keyboard',
    code,
    pressed,
    ts: performance.now(),
  }));
}

document.addEventListener('keydown', (e) => {
  if (!GAME_KEYS.has(e.code)) return;
  e.preventDefault();
  const seat = inputMap.get('keyboard') ?? 0;
  sendInput(seat, e.code, true);
});

document.addEventListener('keyup', (e) => {
  if (!GAME_KEYS.has(e.code)) return;
  e.preventDefault();
  const seat = inputMap.get('keyboard') ?? 0;
  sendInput(seat, e.code, false);
});
```

**Step 4: Worker — log received input with seat**

In the DataChannel `on_message` handler:

```rust
if let Ok(msg) = serde_json::from_str::<serde_json::Value>(&text) {
    if msg.get("type").and_then(|v| v.as_str()) == Some("input") {
        let seat = msg.get("seat").and_then(|v| v.as_u64()).unwrap_or(0);
        let code = msg.get("code").and_then(|v| v.as_str()).unwrap_or("?");
        let pressed = msg.get("pressed").and_then(|v| v.as_bool()).unwrap_or(false);
        let source = msg.get("source").and_then(|v| v.as_str()).unwrap_or("unknown");
        tracing::info!(
            "[INPUT] seat={} source={} code={} pressed={}",
            seat, source, code, pressed
        );
        return;
    }
}
```

**Step 5: Gamepad polling loop**

```js
function pollGamepads() {
  const gamepads = navigator.getGamepads();
  for (const gp of gamepads) {
    if (!gp) continue;
    const seat = inputMap.get(`gamepad-${gp.index}`);
    if (seat === undefined) continue;
    // Send button state for the 16 standard buttons
    for (let i = 0; i < Math.min(gp.buttons.length, 16); i++) {
      if (gp.buttons[i].pressed) {
        sendInput(seat, `Button${i}`, true);
      }
    }
    // Send axes as directional input
    const axes = gp.axes;
    if (Math.abs(axes[0]) > 0.5) sendInput(seat, axes[0] < 0 ? 'AxisLeft' : 'AxisRight', true);
    if (Math.abs(axes[1]) > 0.5) sendInput(seat, axes[1] < 0 ? 'AxisUp' : 'AxisDown', true);
  }
  requestAnimationFrame(pollGamepads);
}
// Start gamepad polling when a gamepad is connected
window.addEventListener('gamepadconnected', () => {
  requestAnimationFrame(pollGamepads);
});
```

**Step 6: Verify**

```bash
cd gv-worker && cargo build 2>&1
```

Expected: compiles clean.

**Step 7: Commit**

```bash
git add gv-web/public/player/index.js gv-worker/src/main.rs
git commit -m "feat: multi-seat input forwarding (keyboard + gamepad) over DataChannel"
```

---

### Task 8: Wire fullscreen toggle in player

**Objective:** The fullscreen button toggles fullscreen mode on the `#stage` container (not just the video — so the HUD stays visible).

**Files:**
- Modify: `gv-web/public/player/index.html` (button already exists; add JS)

**Step 1: Add fullscreen toggle function**

At the bottom of index.js (in the auto-connect bootstrap):

```js
window.toggleFullscreen = () => {
  const el = document.getElementById('stage') || document.documentElement;
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    el.requestFullscreen();
  }
};
```

**Step 2: Verify**

Open player in browser, click fullscreen button. Should enter/exit fullscreen with HUD intact.

**Step 3: Commit**

```bash
git add gv-web/public/player/index.js
git commit -m "feat(player): fullscreen toggle"
```

---

### Task 9: Handle audio track in player

**Objective:** Player detects and renders incoming audio tracks alongside video. Updates HUD audio indicator.

**Files:**
- Modify: `gv-web/public/player/index.js` (handle audio track in ontrack)

**Step 1: Handle audio in ontrack**

Replace the `ontrack` handler:

```js
this._pc.ontrack = (event) => {
  const track = event.track;
  if (track.kind === 'video') {
    if (!this._mediaStream) {
      this._mediaStream = new MediaStream();
      this._video.srcObject = this._mediaStream;
    }
    this._mediaStream.addTrack(track);
    if (this.onTrack) {
      try { this.onTrack(track); } catch { /* safety */ }
    }
  } else if (track.kind === 'audio') {
    if (!this._mediaStream) {
      this._mediaStream = new MediaStream();
      this._video.srcObject = this._mediaStream;
    }
    this._mediaStream.addTrack(track);
    this._hasAudio = true;
  }
};
```

**Step 2: Update HUD audio indicator**

In `_renderHud()`:

```js
set('st-audio', this._hasAudio ? '✓' : '—', this._hasAudio ? 'value' : 'dim');
```

**Step 3: Clean up MediaStream in disconnect**

```js
if (this._mediaStream) {
  this._mediaStream.getTracks().forEach(t => t.stop());
  this._mediaStream = null;
}
this._hasAudio = false;
```

**Step 4: Verify**

No new tests — audio track handling depends on browser WebRTC implementation. Visual verification: connect to worker, HUD should show `✓` for audio.

**Step 5: Commit**

```bash
git add gv-web/public/player/index.js
git commit -m "feat(player): handle audio track from worker"
```

---

### Task 10: End-to-end verification

**Objective:** Confirm the full pipeline works: worker starts, player connects, video plays with stats HUD, audio indicator shows, ping/pong RTT updates, keyboard input appears in worker logs.

**Step 1: Start worker**

```bash
cd /root/projects/games-vault && cargo run -p gv-worker
```

**Step 2: Start gv-web**

```bash
cd gv-web && pnpm dev
```

**Step 3: Open player in browser**

Navigate to `http://localhost:3001/player/index.html?worker=http://localhost:<PORT>` (port from worker output).

**Step 4: Verify**

- [ ] Video plays (bouncing square visible)
- [ ] Stats HUD shows FPS, bitrate, RTT, resolution
- [ ] Audio indicator shows ✓
- [ ] Fullscreen button works
- [ ] Arrow key presses appear in worker stderr as structured JSON logs
- [ ] RTT updates every ~1s

**Step 5: Run all tests**

```bash
cd gv-worker && cargo test
cd gv-player && node --test tests/player.test.js
cd gv-web && npx vitest run
```

Expected: all existing tests pass. New tests: 3 StatsCollector tests pass.

---

## Verification checklist

- [ ] gv-worker: 13 existing tests pass + compiles clean
- [ ] gv-player: 11 tests pass (8 existing + 3 new StatsCollector)
- [ ] gv-web: 28 API route tests pass, build clean
- [ ] Worker streams audio + video (visual + HUD verification)
- [ ] HUD shows FPS, bitrate, RTT, resolution, audio status
- [ ] Ping/pong RTT updates
- [ ] Keyboard input logged by worker with `seat`, `source`, `code`, `pressed` fields
- [ ] Gamepad input logged when controller is connected and buttons/axes change
- [ ] Two seats can be declared via `?seats=0,1` — keyboard goes to seat 0, gamepad to seat 1
- [ ] Fullscreen toggle works
- [ ] HUD shows occupied seats in the seats row
