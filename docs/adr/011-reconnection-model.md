# ADR 011: Reconnection model

**Status:** Proposed
**Date:** 2026-06-14

## Context

When a gv-worker crashes or the browser disconnects, the game session is
lost. The player needs a path back in. Currently the user must manually
refresh the page — no automatic recovery.

## Options

### A: Auto-SDP reconnect (same worker)
- Browser detects disconnect, re-POSTs SDP to the same worker URL
- Worker restarts its streaming loop, re-encodes from the current frame
- Works for transient network blips but not worker crashes
- **Effort:** Low

### B: Re-command (new worker)
- Browser re-submits `start_game`, gv-server spawns a fresh worker
- Browser polls for new worker URL, connects
- Full session reset — game state lost unless save states are used
- Works for worker crashes
- **Effort:** Medium

### C: Hybrid (auto-SDP + fallback to re-command)
- Try auto-SDP reconnect first (fast, no server involvement)
- If worker is dead (connection refused), fall back to re-command flow
- **Effort:** High

## Decision

**Option A for MVP (auto-SDP), with Option B as manual recovery.**
The player can auto-retry SDP on disconnect with exponential backoff
(1s, 2s, 4s, 8s → give up). A "Reconnect" button in the player triggers
the re-command flow. Full hybrid recovery is nice-to-have post-MVP.

## Consequences

- Player needs reconnection UX (retry indicator, "Reconnect" button).
- Worker needs idempotent SDP handling (already done — cancels old
  session on new offer).
- Save states become important for re-command recovery (game state
  survives worker crash).
