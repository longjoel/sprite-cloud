# gv-worker HTTP API Reference

gv-worker is a per-game WebRTC peer that streams VP8 video and Opus audio
to a browser. It exposes HTTP endpoints for session setup, diagnostics,
and health probing.

**Base URL:** `http://<host>:<port>` (port printed to stderr as `WORKER_READY port=N`)

---

## Endpoints

### POST /sdp — WebRTC SDP offer/answer exchange

Negotiates a new WebRTC peer connection. Cancels any previous streaming
session, parses the browser's SDP offer, performs the DTLS/ICE handshake,
and returns an SDP answer. A VP8 video stream and Opus audio stream start
immediately after the handshake succeeds.

**Request**
```
POST /sdp
Content-Type: application/json
```
```json
{ "sdp": "<SDP offer string>" }
```

**Response** `200 OK`
```json
{ "sdp": "<SDP answer string>" }
```

**Error responses**
| Status | Body | Cause |
|--------|------|-------|
| `400 Bad Request` | `"empty SDP offer"` | `sdp` field missing or empty |
| `500 Internal Server Error` | error message | Handshake failure (DTLS, ICE, encoder init) |

**Notes**

- The browser (offerer) must create the `"diagnostics"` DataChannel in its
  SDP offer. The worker receives it via `on_data_channel` after the SDP
  exchange. The worker cannot create the DataChannel as the answerer —
  webrtc-rs 0.17 does not include a data m-line in the SDP answer for
  locally-created DataChannels.
- CORS: allows localhost and auto-detected LAN IP subnet (`/24`) in dev,
  configurable via `ALLOWED_ORIGIN` env var in production.
- ICE gathering timeout: 10 seconds (configurable via
  `ICE_GATHERING_TIMEOUT_SECS` in `config.rs`).
- STUN server: configurable via `STUN_SERVER` env var (default:
  `stun:stun.l.google.com:19302`).

---

### GET /state — peer connection state

Returns the current WebRTC peer connection state for diagnostics.

**Request**
```
GET /state
```

**Response** `200 OK`
```json
{ "state": "Connected" }
```

Possible values: `"New"`, `"Connecting"`, `"Connected"`, `"Disconnected"`,
`"Failed"`, `"Closed"`, or `"no connection"` (no peer connection exists).

---

### GET /test-frame?frame=N — raw RGB24 frame

Returns a raw RGB24 test pattern frame for HTTP polling (no WebRTC needed).
Used by the built-in test page at `GET /`.

**Request**
```
GET /test-frame?frame=42
```

| Query param | Type | Default | Description |
|-------------|------|---------|-------------|
| `frame` | integer | `0` | Frame number (controls animation position) |

**Response** `200 OK`
```
Content-Type: application/octet-stream
```
Raw RGB24 bytes (320 × 240 × 3 = 230,400 bytes). Decode as
`<canvas>` or `<img>` with manual pixel manipulation.

---

### GET /health — liveness check

Returns 200 OK when the HTTP server is accepting requests. gv-server
probes this after reading `WORKER_READY` from stderr, before notifying
gv-web that the worker is available.

**Request**
```
GET /health
```

**Response** `200 OK` (no body)

---

### GET / — test page

Returns a self-contained HTML test page with an `<img>` element for
HTTP polling (`GET /test-frame?frame=N`) and a WebRTC connect button
that calls `POST /sdp`.

No query parameters. Used for ad-hoc dev testing.

---

## WebRTC Media

| Track | Codec | Resolution / Rate | Bitrate |
|-------|-------|-------------------|---------|
| Video | VP8 | 320×240 @ 30 fps | 500 kbps (configurable) |
| Audio | Opus | 48 kHz stereo | ~40 kbps |

### DataChannel `"diagnostics"`

Created by the browser in the SDP offer, received by the worker via
`on_data_channel`. Carries two bidirectional message types:

**Worker → Browser (stats push, every 5th frame)**
```json
{
  "type": "stats",
  "frame": 100,
  "video": { "bytes": 1234, "encode_us": 42, "keyframe": false },
  "audio": { "bytes": 180, "encode_us": 8 },
  "pipeline": { "drops": 0, "audio_write_errs": 0, "uptime_sec": 42 }
}
```

**Browser → Worker (control commands)**
```json
// Set encoder bitrate
{ "cmd": "set_bitrate", "kbps": 200 }

// Switch test pattern
{ "cmd": "set_pattern", "pattern": "bars" }

// Force next frame to be a keyframe
{ "cmd": "force_keyframe" }

// RTT ping (worker responds with pong)
{ "cmd": "ping", "seq": 1 }
```

**Worker → Browser (pong response)**
```json
{ "type": "pong", "seq": 1, "server_ts_ms": 1719000000000 }
```
