# ADR 004: PID file crash recovery

**Status:** Accepted  
**Date:** 2026-06-14

## Context

gv-server spawns gv-worker processes. If gv-server crashes (SIGKILL, OOM,
power loss), the worker processes continue running as orphans. On restart,
gv-server must clean up these orphans.

## Decision

gv-server writes a PID file to `/tmp/gv-workers/<game_id>.pid` on spawn
and removes it on clean kill. On startup, `reap_stale_workers()` scans
the directory and kills any processes whose PID files still exist.

## Rationale

- **Simple and filesystem-based**: No in-memory process tracking needed
  across restarts. The filesystem is the source of truth.
- **Survives crashes**: PID files persist across gv-server crashes
  (they're on disk, not in memory).
- **Game ID as key**: Each game session has a unique PID file name,
  preventing collisions.
- **No process manager dependency**: Unlike systemd-managed services,
  the workers are ephemeral and dynamic — PID files are the lightest
  possible process inventory.

## Consequences

- `/tmp/gv-workers/` must be writable by the gv-server user.
- PID files can become stale if a worker crashes but gv-server doesn't
  (the reaper checks if the PID is still alive via `kill(0)` before
  attempting to terminate).
- On system reboot, `/tmp` is cleared — no stale PID files survive a
  reboot. This is acceptable because the OS kills all processes on reboot.
