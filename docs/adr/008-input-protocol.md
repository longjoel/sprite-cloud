# ADR 008: Input protocol — DataChannel vs WebSocket

**Status:** Proposed
**Date:** 2026-06-14

## Context

Browser input (keyboard, gamepad) must reach the worker for the emulator
core to consume. The worker already has a bidirectional DataChannel
(`"diagnostics"`) carrying stats and control commands. The question is
whether game input should share that channel, get its own DataChannel,
or use a separate WebSocket.

## Options

### A: Shared DataChannel (single channel for stats + control + input)
- Reuses existing infrastructure
- One connection to manage
- Stats and input compete for bandwidth on the same SCTP stream

### B: Separate DataChannel (dedicated `"input"` channel)
- Ordered/unordered can differ per channel
- Cleaner separation of concerns
- Slightly more connection setup

### C: Separate WebSocket
- Easier to debug (text protocol, browser devtools)
- Works through proxies without WebRTC
- Extra connection, extra port, extra CORS config

## Decision

**Option B — dedicated `"input"` DataChannel.** Created by the browser
alongside `"diagnostics"` in the SDP offer. Carries only input frames.
Ordered delivery with low-latency label.

## Rationale

- Already have working DataChannel infrastructure
- Separate channel avoids input frames competing with stats JSON
- No extra connection/auth/proxy config (rides the existing P2P link)
- webrtc-rs supports multiple DataChannels per peer connection

## Consequences

- Input contract: browser sends joypad state every frame as a 16-bit
  bitmask matching RetroArch's RETRO_DEVICE_ID_JOYPAD_* layout.
  Multi-seat: array of masks, one per seat (seat 0 = index 0).
- Worker must handle two DataChannels (`"diagnostics"` + `"input"`)
- Browser creates both channels before `createOffer()`

## Input message format (RetroArch-compatible)

Browser → Worker over `"input"` DataChannel, binary (ArrayBuffer):

```
Offset | Size | Field
     0 |    1 | seat (u8, 0–3)
     1 |    2 | state (u16 LE, joypad bitmask)

Per RETRO_DEVICE_ID_JOYPAD_*:
  bit 0  = B        bit 8  = A
  bit 1  = Y        bit 9  = X
  bit 2  = Select   bit 10 = L
  bit 3  = Start    bit 11 = R
  bit 4  = Up       bit 12 = L2
  bit 5  = Down     bit 13 = R2
  bit 6  = Left     bit 14 = L3
  bit 7  = Right    bit 15 = R3
```

Full state sent every frame (not individual key events). Binary
encoding chosen over JSON for sub-millisecond parse and zero
allocation — matching RetroArch's network input protocol.

Keyboard/gamepad mapping (browser side) accumulates key state into
the mask; the mask is sent verbatim to the core via
`retro_set_controller_port_device` + `retro_set_input_state` callback.
