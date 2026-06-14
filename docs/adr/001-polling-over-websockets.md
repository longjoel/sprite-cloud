# ADR 001: Polling over WebSockets

**Status:** Accepted  
**Date:** 2026-06-14

## Context

gv-server needs to receive commands from gv-web (start_game, stop_game).
The naive approach is a persistent WebSocket connection — gv-web pushes
commands as they arrive.

## Decision

gv-server polls `POST /api/server/poll` every 2 seconds (250ms when
recently active). No persistent WebSocket.

## Rationale

- Simpler implementation — no connection state on either side
- Works through reverse proxies without WebSocket upgrade config
- gv-web is stateless between poll requests (no in-memory subscriber map)
- Commands are rare (1–2 per minute), making polling overhead negligible
- A missed poll (server restart, transient network) is self-healing —
  the next poll picks up any pending commands via a cursor
- 2-second latency for command delivery is fine for a game start/stop
  flow (not real-time input)

## Consequences

- **Latency**: Up to 2 seconds between command submission and server pickup.
  Acceptable for start/stop, not for real-time input.
- **Idle load**: One HTTP request every 2 seconds per server. Trivial.
- **Cursor**: Commands are delivered once via a `delivered` flag in the
  database. No re-delivery, no deduplication needed.
- **Future**: If real-time commands are needed (chat, spectator count),
  they can use a separate WebSocket channel on gv-web without changing
  the command polling model.
