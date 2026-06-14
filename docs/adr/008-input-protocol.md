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

- Input contract needs `seat` field (0–3)
- Worker must handle two DataChannels (`"diagnostics"` + `"input"`)
- Browser creates both channels before `createOffer()`
