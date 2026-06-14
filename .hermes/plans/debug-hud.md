# Debug HUD — Full Instrumentation Plan

**Goal:** Fill the web player with every relevant stat. Debug version — pull every lever.

## Architecture

The HUD has three data sources:
1. **DataChannel `"diagnostics"`** — worker pushes per-frame stats JSON (already implemented, every 10th frame)
2. **`RTCPeerConnection.getStats()`** — browser polls WebRTC internals (1 Hz)
3. **Local tracking** — the player tracks its own events (SDP timing, ICE state, DataChannel state)

Worker-side changes for new stats and lever controls.

---

## Task 1 — Expand worker DataChannel stats payload

**File:** `gv-worker/src/main.rs`

Current payload is sparse:
```json
{"type":"stats","frame":10,"bytes":1234,"encode_us":42}
```

Expand to:
```json
{
  "type": "stats",
  "frame": 100,
  "video": {
    "bytes": 1234,
    "encode_us": 42,
    "keyframe": false
  },
  "audio": {
    "bytes": 180,
    "encode_us": 8
  },
  "pipeline": {
    "drop": 0,
    "audio_write_err": 0,
    "uptime_sec": 42
  }
}
```

**Changes:**
- Track keyframe flag from VP8 encoder (`need_keyframe` was just toggled — we can track the flag *before* encode)
- Track audio encode time
- Track cumulative drop count, audio write error count, uptime
- Send on every 5th frame (was 10th) for smoother HUD updates (~6 Hz)

---

## Task 2 — Worker control channel (receive levers)

**File:** `gv-worker/src/main.rs`

Worker already receives DataChannel messages for ping/pong. Extend to handle control messages:

```json
{"type":"cmd","cmd":"set_bitrate","kbps":1000}
{"type":"cmd","cmd":"set_pattern","pattern":"bars"}
{"type":"cmd","cmd":"force_keyframe"}
{"type":"cmd","cmd":"ping","seq":1,"client_ts":1719000000000}
```

**Changes:**
- Switch on `msg.type === "cmd"` in the DataChannel `on_message` handler
- `set_bitrate`: update a shared `AtomicU32` that the encoder reads each frame (requires encoder to accept runtime bitrate changes — check libvpx API for `vpx_codec_enc_config_set`)
- `set_pattern`: toggle between `generate_bouncing_square` and `generate_color_bars`
- `force_keyframe`: set `encoder.need_keyframe = true`
- `ping`: respond with `{"type":"pong","seq":N,"server_ts":...}` for proper RTT (currently just echoes raw "ping" → "pong")

**Pitfall:** libvpx `vpx_codec_enc_config_set` may not support runtime bitrate changes on VP8. If not, recreate the encoder on bitrate change.

---

## Task 3 — DataChannel handling in player

**File:** `gv-web/public/player/index.js`

Player currently ignores incoming DataChannel messages. Need to:
- Listen for `datachannel` event on peer connection
- Parse JSON messages by `type` field
- Dispatch to stats accumulator and RTT tracker
- Expose `ondatachannel` callback and public getters for stats

```js
// New public API
player.stats        // { video: {...}, audio: {...}, pipeline: {...}, rtt_ms: null }
player.rttMs        // latest ping/pong round-trip
player.onStats      // callback(stats) — fired on each stats update
```

**Changes:**
- `connect()`: listen for `this._pc.ondatachannel`, store reference
- Parse incoming messages, update internal stats object
- Track RTT: send ping every 2s, compute delta on pong
- Expose stats via getter

---

## Task 4 — WebRTC getStats() polling

**File:** `gv-web/public/player/index.js`

Poll `RTCPeerConnection.getStats()` at 1 Hz. Extract:

| Category | Stat | getStats key |
|----------|------|-------------|
| Connection | ICE state | `peerConnection.iceConnectionState` |
| Connection | Signaling state | `peerConnection.signalingState` |
| Candidate pair | RTT | `candidate-pair.currentRoundTripTime` |
| Candidate pair | Available bitrate | `candidate-pair.availableOutgoingBitrate` |
| Candidate pair | Local address | `candidate-pair.local.address` |
| Candidate pair | Remote address | `candidate-pair.remote.address` |
| Inbound video | Packets received | `inbound-rtp[type=video].packetsReceived` |
| Inbound video | Packets lost | `inbound-rtp[type=video].packetsLost` |
| Inbound video | FPS | `inbound-rtp[type=video].framesPerSecond` |
| Inbound video | Frames decoded | `inbound-rtp[type=video].framesDecoded` |
| Inbound video | Keyframes decoded | `inbound-rtp[type=video].keyFramesDecoded` |
| Inbound video | Jitter (s) | `inbound-rtp[type=video].jitter` |
| Inbound video | Decode time | `inbound-rtp[type=video].totalDecodeTime` |
| Inbound video | Resolution | `inbound-rtp[type=video].frameWidth` × `frameHeight` |
| Inbound audio | Packets received | `inbound-rtp[type=audio].packetsReceived` |
| Inbound audio | Packets lost | `inbound-rtp[type=audio].packetsLost` |
| Inbound audio | Jitter | `inbound-rtp[type=audio].jitter` |
| Inbound audio | Audio level | `inbound-rtp[type=audio].audioLevel` |
| Transport | DTLS state | `transport.dtlsState` |
| Transport | Bytes sent/rcvd | `transport.bytesSent` / `bytesReceived` |

**Pitfall:** `getStats()` is async and returns a `Map` — iterate it. Some keys only appear on some browsers (Safari vs Chrome). Use `||` fallbacks.

---

## Task 5 — Pipeline reachability indicators (Xbox-style)

**Layout:** Top bar with color-coded dots

```
● HTTP   ● SDP    ● ICE    ● Video   ● Audio   ● DC    ● STUN
```

Each dot:
- **Gray** = unchecked / idle
- **Yellow** = in progress (connecting…)
- **Green** = reachable, active
- **Red** = failed / unreachable
- **Flashing** = degraded (e.g., packets lost but still connected)

Logic:
- `HTTP`: green when `fetch(sdpUrl)` returns OK
- `SDP`: green when `setRemoteDescription` succeeds
- `ICE`: green when `connectionState === "connected"`, yellow when `"connecting"`, red when `"failed"`
- `Video`: green when `inbound-rtp[type=video]` has `packetsReceived > 0`
- `Audio`: green when `inbound-rtp[type=audio]` has `packetsReceived > 0`
- `DC`: green when DataChannel `readyState === "open"`
- `STUN`: green when candidate pair has `state === "succeeded"` and is not a host-host (i.e., srflx or relay), yellow if host-host only (LAN)

---

## Task 6 — Stats panels

**Layout:** Two collapsible panels flanking the video, semi-transparent overlays.

### Panel A — Video Pipeline
```
Resolution      320×240 @ 30 fps
Encoded         1,234 bytes/frame (296 kbps)
Encode Time     42 µs avg
Decode Time     1.2 ms avg (browser)
Frames In       1,500 | Lost 3 (0.2%)
Jitter          2.1 ms
Keyframes       5
Jitter Buffer   8 ms
```

### Panel B — Network
```
ICE             connected
Candidate       host → srflx
RTT             4.2 ms (candidate) | 5.1 ms (DC ping)
DTLS            connected
Bitrate Avail   2.4 Mbps
Bytes           1.2 MB ↓ | 48 KB ↑
```

### Bottom Bar — Controls
```
[Bitrate: ===o=== 500 kbps]  [Pattern: ▾ Square]  [Force KF]  [Ping]
```

---

## Task 7 — HTML/CSS HUD layout

**File:** `gv-web/public/player/index.html` (or new `hud.css`)

- Video remains centered, max 80vh
- Top bar: fixed position, background `rgba(0,0,0,0.85)`, flex row of indicators
- Stats panels: absolute positioned left/right, `max-width: 280px`, semi-transparent bg, monospace font
- Collapsible: click indicator dots to toggle panels
- Bottom bar: fixed position, flex row of controls
- All HUD elements use `pointer-events: none` except interactive controls
- Video and HUD are siblings in a container div, not overlays (cleaner stacking)

---

## Task 8 — Player lever plumbing

Wire the bottom-bar controls to DataChannel commands:

| Control | DataChannel Message |
|---------|-------------------|
| Bitrate slider | `{"type":"cmd","cmd":"set_bitrate","kbps":N}` |
| Pattern dropdown | `{"type":"cmd","cmd":"set_pattern","pattern":"bars"\|"square"}` |
| Force KF button | `{"type":"cmd","cmd":"force_keyframe"}` |
| Ping button | `{"type":"cmd","cmd":"ping","seq":N,"client_ts":T}` |
| Reconnect button | `player.disconnect()` → `player.connect(url)` |

Slider should update on `input` (not just `change`) for live feedback, but debounce DataChannel sends to 200ms to avoid flooding.

---

## Task 9 — Player stats DOM binding

**File:** `gv-web/public/player/index.html` + `index.js`

- Create a `HudRenderer` class or inline functions that take the stats objects and update DOM
- Update at requestAnimationFrame rate (but only when stats change — flag-based)
- Use `textContent` for text, class toggles for dot colors
- Format helpers: `formatBytes(n)`, `formatMs(n)`, `formatPercent(part, total)`

---

## Task 10 — Worker runtime config updates

**File:** `gv-worker/src/main.rs`

- `set_bitrate`: Call `vpx_codec_enc_config_set()` with new `rc_target_bitrate`. If unsupported by libvpx, destroy and recreate `Vp8Encoder`.
- `set_pattern`: Shared `AtomicU8` pattern selector (0 = square, 1 = bars). Read atomically each frame.
- `force_keyframe`: Set `encoder.need_keyframe = true` (need access to encoder in the message handler — wrap in `Arc<Mutex<Vp8Encoder>>`)
- `ping`: Respond with `server_ts` (monotonic µs) for accurate RTT

---

## Independence

- Tasks 1–2 are worker-only, testable with `cargo test`
- Tasks 3–4 are player-only, testable with mock DataChannel and stats objects
- Tasks 5–9 are HTML/CSS/JS, testable in browser with a running worker
- Task 10 is worker-only

## Order

```
1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10
```

Worker stats expansion first (gives richer DataChannel payload), then player consumes them, then UI.

## Verification

After each task:
- `cargo test` passes (Rust)
- `pnpm test` passes (gv-web API tests)
- `node --test gv-player/tests/player.test.js` passes (player unit tests)

After full HUD:
- Open `http://<lan-ip>:3001/player/index.html?worker=http://<lan-ip>:PORT`
- All 7 pipeline dots go green
- Stats panels populate with live data
- Bitrate slider changes encoder output in real-time
- Pattern dropdown switches between square and color bars
- Ping shows RTT < 5ms on LAN
