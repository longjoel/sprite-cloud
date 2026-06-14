# gv-player

Browser-side WebRTC client for Games Vault. Vanilla JavaScript — no
framework dependencies. Connects to a gv-worker, negotiates a WebRTC
peer connection, and renders the VP8 video + Opus audio stream.

## Quick start

```html
<!-- 1. Include a <video> element -->
<video id="video" muted playsinline controls></video>

<!-- 2. Load the script -->
<script type="module">
  import { GvPlayer } from "./index.js";
  const player = new GvPlayer(document.getElementById("video"));
  await player.connect("http://192.168.86.126:42757");
</script>
```

### Auto-connect bootstrap

When loaded directly in a browser with a `?worker=` query parameter,
the script auto-connects:

```
http://localhost:3001/player/index.html?worker=http://192.168.86.126:42757
```

Exposes `window.gvPlayer` for debugging in the browser console.

## API

### `new GvPlayer(video)`

Creates a player bound to an `<video>` element. Sets `autoplay`,
`playsinline`, and `muted` on the element for mobile compatibility.

### `player.connect(workerUrl)`

Negotiates a WebRTC peer connection with the worker at `workerUrl`.

1. Creates an `RTCPeerConnection` with STUN
2. Adds `recvonly` transceivers for video and audio
3. Creates a `"diagnostics"` DataChannel (must happen before `createOffer()`)
4. POSTs the SDP offer to `POST <workerUrl>/sdp`
5. Sets the remote SDP answer
6. On `ontrack`: adds tracks to the video element, unmutes, calls `play()`
7. Starts the RTT ping interval (2s)

Returns a promise that resolves when `setRemoteDescription` completes
(connection may still be in progress — watch `onStateChange`).

### `player.disconnect()`

Tears down the peer connection, DataChannel, media stream, ping interval,
and timers. Resets stats and RTT.

### `player.state` → `string`

Current connection state. One of: `"idle"`, `"connecting"`, `"connected"`,
`"error"`.

### `player.stats` → `object`

Latest worker stats from the `"diagnostics"` DataChannel. Updated at ~6 Hz.
Shape:
```js
{
  type: "stats",
  frame: 100,
  video: { bytes: 1234, encode_us: 42, keyframe: false },
  audio: { bytes: 180, encode_us: 8 },
  pipeline: { drops: 0, audio_write_errs: 0, uptime_sec: 42 }
}
```

### `player.rttMs` → `number | null`

Latest round-trip time from DataChannel ping/pong, in milliseconds.
Updated every 2 seconds. `null` until first pong.

### Callbacks

| Callback | Signature | Fires when |
|----------|-----------|------------|
| `player.onStateChange` | `(state, detail?)` | Connection state changes |
| `player.onTrack` | `(track)` | A media track is added |
| `player.onStats` | `(stats)` | New stats arrive on DataChannel |

## WebRTC connection lifecycle

```
IDLE → CONNECTING → CONNECTED
                  ↘ ERROR
```

- **IDLE**: No peer connection.
- **CONNECTING**: `connect()` called, SDP exchange in progress.
- **CONNECTED**: `connectionState === "connected"`.
- **ERROR**: `"failed"` (permanent) or `"disconnected"` with recovery
  timeout (5s grace period).

On `"failed"` or `"disconnected"` timeout:
- Calls `_cleanup()` which stops the ping interval, closes the
  DataChannel, and closes the peer connection.
- Does NOT auto-reconnect. Call `connect()` again to retry.

## Browser requirements

- WebRTC (`RTCPeerConnection`, `RTCDataChannel`)
- VP8 video codec
- Opus audio codec
- ES modules (`import`/`export`)
- `MediaStream` API

Tested on Chrome, Firefox, and Safari (iOS 15+). Mobile requires
`muted`, `playsinline`, and `controls` on the `<video>` element.

## Testing locally

### Unit tests (linkedom)

```bash
cd gv-web
pnpm test
```

28 vitest tests covering state machine transitions, SDP exchange,
DataChannel message handling, and cleanup.

### Manual smoke test

1. Start a gv-worker: `cd gv-worker && cargo run -- 0`
2. Note the `WORKER_READY port=N` output
3. Open: `http://localhost:3001/player/index.html?worker=http://localhost:<port>`
4. Verify video plays, stats populate (`window.gvPlayer.stats`),
   RTT shows (`window.gvPlayer.rttMs`)

### Browser console

```js
gvPlayer.state           // "connected"
gvPlayer.stats           // { video: {...}, audio: {...}, pipeline: {...} }
gvPlayer.rttMs           // 2.3
gvPlayer._dc             // RTCDataChannel (not null)
gvPlayer._dc.readyState  // "open"
```
