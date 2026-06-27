# DataChannel Protocol — Browser ↔ Host Runtime

The `"diagnostics"` DataChannel carries both binary input and JSON control
messages over a single WebRTC DataChannel. The browser (offerer) creates it,
the host runtime (answerer) receives it via `ondatachannel`.

## Peer authentication

Every peer MUST authenticate as its first message after the DataChannel opens.
The auth message is a JSON object:

```json
{"cmd": "auth", "host_token": "..."}
```

The host runtime compares the token against the session's host token set during
session negotiation:

| Match | Role | Capabilities |
|-------|------|-------------|
| Match | **Host** | Full control — binary input, save/load, bitrate, keyframes |
| No match | **Viewer** | Binary input + ping only |
| No auth within 5 s | — | DataChannel closed |

Auth is re-sent on every reconnect — the host token is generated once
per browser session and reused across reconnects.

## Message discrimination

The receiver checks `msg.data.len()`:
- **3 bytes** → RetroArch binary input (always allowed)
- **Anything else** → UTF-8 JSON (role-gated)

## Binary input (RetroArch format)

```
[0] u8  port   — seat number (host=0, viewers assigned sequentially)
[1] u8  state  — low byte of 16-bit joypad mask (LE)
[2] u8  state  — high byte
```

Sent on every input state change (keydown, keyup, gamepad poll delta).
Always allowed — the port byte identifies the player seat, not the peer role.

### Joypad bit layout (RetroArch)

| Bit | Button   | Keyboard      | Gamepad (standard)    |
|-----|----------|---------------|------------------------|
| 0   | B        | Z             | Button 1 (circle/B)    |
| 1   | Y        | —             | —                      |
| 2   | Select   | W             | Button 8 (share)       |
| 3   | Start    | Q / Enter / Space | Button 9 (options) |
| 4   | Up       | ArrowUp       | D-pad up / axis 1 < −0.5 |
| 5   | Down     | ArrowDown     | D-pad down / axis 1 > 0.5 |
| 6   | Left     | ArrowLeft / A | D-pad left / axis 0 < −0.5 |
| 7   | Right    | ArrowRight / D| D-pad right / axis 0 > 0.5 |
| 8   | A        | X             | Button 0 (cross/A)     |
| 9   | X        | —             | —                      |
| 10  | L        | —             | Button 4 (L1)          |
| 11  | R        | —             | Button 5 (R1)          |
| 12  | L2       | —             | Button 6               |
| 13  | R2       | —             | Button 7               |
| 14  | L3       | —             | —                      |
| 15  | R3       | —             | —                      |

Keyboard-only bits: 2 (W/Select), 3 (Q/Start).  
Gamepad-exclusive bits: 1, 9–15 (not mapped to keyboard).

### Sending (browser reference)

```js
// Accumulate bitmask into this._inputState, then:
const s = this._inputState;
const buf = new Uint8Array([0, s & 0xFF, s >> 8]);
this._dc.send(buf.buffer);
```

### Receiving (worker reference)

```rust
if msg.data.len() == 3 {
    let port = msg.data[0] as u32;
    let state = u16::from_le_bytes([msg.data[1], msg.data[2]]);
    tx.send(CoreCommand::SetInput { port, state })?;
}
```

## JSON messages

All JSON messages are objects with at minimum a `"cmd"` string field.

### Browser → Host runtime

| cmd | Role | Fields | Notes |
|-----|------|--------|-------|
| `"auth"` | any | `host_token` | **Must be first message.** Sets peer role. |
| `"ping"` | any | `seq`, `client_ts` | RTT measurement, every 2 s |
| `"save_state"` | host | `slot` (1–9) | Save emulator state |
| `"load_state"` | host | `slot` (1–9) | Load emulator state |
| `"set_bitrate"` | host | `kbps` | Dev tool: adjust encoder bitrate |
| `"set_pattern"` | host | `pattern` ("bars"|"square") | Dev tool: test pattern |
| `"force_keyframe"` | host | — | Request VP8 keyframe |

```json
{"cmd": "auth", "host_token": "abc123-def456"}
{"cmd": "save_state", "slot": 3}
{"cmd": "ping", "seq": 1, "client_ts": 12345.6}
```

### Host runtime → Browser

| type | Fields | Notes |
|------|--------|-------|
| `"pong"` | `seq`, `server_ts_ms` | Response to ping |
| `"stats"` | `video`, `audio`, `pipeline` | Per-frame diagnostics (every N frames) |
| `"save_result"` | `slot`, `ok` | Result of save/load state |

```json
{"type": "pong", "seq": 1, "server_ts_ms": 1700000000000}
{"type": "save_result", "slot": 3, "ok": true}
```

## Viewer enforcement

Viewer peers that attempt privileged commands get a warning logged and the
message is dropped. No error is sent back — hostile input is simply ignored.

```
[DC] viewer attempted privileged command: save_state — dropping
```

## RTT measurement

1. Browser sends `{"cmd":"ping","seq":N,"client_ts":performance.now()}`
2. Worker replies `{"type":"pong","seq":N,"server_ts_ms":...}`
3. Browser computes `rttMs = performance.now() - client_ts`
4. Pending pings capped at 20 entries (leaked pings are cleaned)

## Save/load state lifecycle

1. User clicks slot N in the player UI (host only)
2. Browser sends `{"cmd":"save_state","slot":N}` over DataChannel
3. The host runtime saves state, writes to disk, replies `{"type":"save_result","slot":N,"ok":true}`
4. Browser shows toast (green for ok, red for failure)

## Reconnection

The DataChannel is tied to the WebRTC session. On disconnect:
1. Browser detects `connectionState === "disconnected"` / `"failed"`
2. After 5 s grace period, enters error state
3. Reconnects by starting a new game + new WebRTC session (up to 5 attempts)
4. Auth is re-sent on each new DataChannel — host token persists
5. Save states persist on disk — reconnected sessions can load from any slot
