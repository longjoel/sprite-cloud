# ADR 013: Save state persistence

**Status:** Proposed
**Date:** 2026-06-14

## Context

Games need to persist progress. v1 has battery saves (SRAM) and save
states (full core snapshot). In v2, the worker has no persistence layer.
Where do saves live, and who manages them?

## Options

### A: Worker writes to disk directly
- Worker calls `retro_serialize()` and writes to a file on the local
  filesystem
- Saves tied to the worker's ephemeral lifecycle (worker dies → saves
  are on that machine only)
- **Effort:** Low. Simple file I/O.

### B: gv-server manages saves
- Worker sends save data to gv-server via HTTP POST
- gv-server stores in a known directory or database
- Saves survive worker crashes and machine reboots
- **Effort:** Medium. Need save upload/download endpoints.

### C: Browser manages saves
- Worker sends save data to browser via DataChannel
- Browser stores in localStorage or IndexedDB
- Browser uploads to gv-web for cross-device sync
- **Effort:** High. Save data can be large (MBs for N64).

## Decision

**Option B — gv-server manages saves.** Worker sends save data to
gv-server after each `retro_run()` with a configurable interval
(every 60 seconds + on session end). gv-server stores in a per-game
directory under `/opt/games-vault/saves/<game_id>/`.

Save states (full core snapshots) use the same mechanism but are
triggered explicitly via DataChannel command (`{"cmd":"save_state"}`).

## Consequences

- Worker needs a save upload endpoint on gv-server (or gv-server polls
  the worker for a save file).
- Battery saves (SRAM) are written on a timer + on session end.
- Save states are larger but infrequent.
- gv-web can eventually expose saves for download/management.
