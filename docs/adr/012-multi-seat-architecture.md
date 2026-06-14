# ADR 012: Multi-seat architecture

**Status:** Proposed
**Date:** 2026-06-14

## Context

Games Vault supports multiplayer (2–4 players on the same game). In v1,
a single Nosebleed process handles all seats — input arrives via WebSocket
from multiple browsers. In v2, the worker does WebRTC P2P. The question
is how seats map to connections.

## Options

### A: One connection, multiple seats (local multiplayer)
- A single browser connects to the worker via WebRTC
- That browser sends input for all seats (keyboard = P1, gamepad = P2, etc.)
- Worker injects input into the core per-seat
- **Effort:** Low. Already planned with `seat` field in input contract.
  `?seats=0,1` URL param tells the player which seats it controls.

### B: Multiple connections, one worker (remote multiplayer)
- Each player's browser gets its own WebRTC connection to the same worker
- Worker maintains multiple peer connections, routes input per-connection
- Each player sees the same video stream (or a split view)
- **Effort:** High. Worker needs multi-peer WebRTC (not supported by
  current single-peer-per-worker model).

### C: Multiple workers, one server (peer-to-peer between workers)
- Each player gets their own worker
- Workers communicate via gv-server relay (or WebRTC between workers)
- Netplay-style architecture — each worker runs its own core instance
- **Effort:** Very high. Requires core determinism, input delay, rollback.

## Decision

**Option A for MVP.** Single connection drives all seats. Remote
multiplayer (Option B/C) is a separate feature track post-MVP.

## Consequences

- Input contract: `{ seat: 0–3, ... }` in every DataChannel message.
- `?seats=0,1` URL param. Player UI shows seat indicators.
- No multi-browser-per-worker infrastructure needed.
- Remote multiplayer is not blocked — just deferred. The input contract
  already has the `seat` field, which works for both models.
