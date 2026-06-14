# ADR 014: Session and room model

**Status:** Proposed
**Date:** 2026-06-14

## Context

v1 has rooms (arcade cabinets, shared sessions, room codes, spectator
mode). v2 has a `sessions` database table and `SpawnedWorker` tracking
but no room abstraction. What carries forward?

## Decision

**Start minimal — sessions are the primitive.** Rooms, arcade cabinets,
and spectator mode are built on top of sessions, not separate concepts.

### Session lifecycle

```
created → ready → connected → stopped
```

- **created**: `start_game` command submitted, waiting for gv-server
- **ready**: gv-server spawned worker, notified gv-web, worker URL available
- **connected**: browser has an active WebRTC connection to the worker
- **stopped**: `stop_game` command processed, worker killed

### Room (future)

A room is a session with additional metadata:
- `room_code`: 6-character invite code
- `max_seats`: 1–4
- `is_persistent`: arcade cabinets
- `spectator_allowed`: boolean

Rooms are not implemented in v2 MVP. The session model supports them
when needed.

## Consequences

- v2 MVP has no rooms, no arcade cabinets, no spectator mode.
- These are layered on top of sessions when the v1 feature set is
  ported forward.
- The session DB schema already has the columns needed for room metadata
  (via `payload` JSONB).
