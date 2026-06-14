# ADR 016: Save states and SRAM persistence

**Status:** Proposed
**Date:** 2026-06-14

## Context

libretro cores expose two forms of persistent game data:

- **SRAM** (Save RAM, `RETRO_MEMORY_SAVE_RAM`): Battery-backed cartridge memory.
  Auto-managed — the core handles reads/writes during gameplay. The frontend
  must flush it to disk on unload and restore it on load, or progress is lost.
- **Save states** (`retro_serialize`/`retro_unserialize`): Full emulator snapshots.
  Capture CPU registers, RAM, VRAM, everything. Large (KB to tens of MB).
  On-demand — user presses a button to save/load.

Nosebleed solved this with a file-based approach keyed on ROM filename stem.
Games Vault needs the same thing plus multi-tenant concerns (multiple workers,
VPS persistence, per-user save slots).

## Pain points from Nosebleed

1. **SRAM flush timing** — `retro_get_memory_data(RETRO_MEMORY_SAVE_RAM)` must be
   called BEFORE `retro_unload_game()`. After unload, the pointer is invalid.
   Some cores (Gambatte, mGBA) cache writes and only flush on unload.
2. **Partial writes** — Nosebleed uses `fs::write` directly. If the process
   crashes mid-write, the save file is corrupted (half-written). Fix: write to
   `.tmp`, fsync, rename.
3. **Game identification** — Nosebleed keys on ROM filename stem. Two different
   ROMs named `game.gb` collide. Fix: hash the ROM content (SHA-256, first 16 bytes
   as hex).
4. **Large save states** — N64 states can be 8+ MB. Serializing blocks the
   core thread (no `retro_run` during serialize). Fix: accept the blocking call;
   save states are on-demand, not per-frame.
5. **Thread safety** — `retro_serialize()` and `retro_run()` must not overlap.
   Our core thread already runs single-threaded (core_bridge.rs), so this is
   naturally safe.

## Decision

**File-based persistence, keyed by ROM content hash.** SRAM is automatic (save
on unload, restore on load). Save states are on-demand via DataChannel commands.

### Directory layout

```
{save_dir}/
  {game_hash}/           # SHA-256[:16] hex of ROM content
    battery.srm          # Battery-backed SRAM
    states/
      slot-01.state      # Save state slot 1
      slot-02.state      # Save state slot 2
      ...
```

ROMs arriving via Docker volume mounts get hashed on first load. The hash
identifies the game uniquely — two copies of `zelda.gb` with identical content
share saves, a ROM hack gets its own directory.

### SRAM lifecycle

```
Game loaded
  → compute ROM hash
  → if {save_dir}/{hash}/battery.srm exists:
      → read it, copy into retro_get_memory_data(RETRO_MEMORY_SAVE_RAM)
  → run frame loop...

Game unloaded (Core::drop or explicit unload_game)
  → call retro_get_memory_data(RETRO_MEMORY_SAVE_RAM)
  → if non-empty and differs from on-disk:
      → atomic write: write to battery.srm.tmp, fsync, rename to battery.srm
  → call retro_unload_game()
```

### Save state lifecycle

```
Browser: dc.send({cmd:"save_state",slot:1})
  → worker: {save_dir}/{hash}/states/  ensure exists
  → worker: retro_serialize_size() → alloc vec
  → worker: retro_serialize(vec) → write to slot-01.state.tmp → fsync → rename
  → worker: dc.send({type:"save_state_result",slot:1,ok:true,bytes:N})

Browser: dc.send({cmd:"load_state",slot:1})
  → worker: read slot-01.state
  → worker: retro_unserialize(data)
  → worker: dc.send({type:"load_state_result",slot:1,ok:true})
```

### What goes in libretro-runner vs gv-worker

**libretro-runner (Task 9):**
- `Core::sram() -> Option<Vec<u8>>` — copy SRAM out
- `Core::restore_sram(&self, data: &[u8])` — copy SRAM in
- `Core::save_state() -> Option<Vec<u8>>` — serialize
- `Core::load_state(&self, data: &[u8]) -> bool` — unserialize
- `Core::can_save_state() -> bool` — checks if serialize symbols are present
- `Core::can_sram() -> bool` — checks if memory symbols are present
- Zero file I/O in the runner — returns bytes, caller persists

**gv-worker (new task):**
- Hash ROM on load, derive save directory
- Auto-restore SRAM before first frame
- Auto-save SRAM on `Core::drop` (via a wrapper that calls save before unload)
- Handle `{cmd:"save_state",slot}` and `{cmd:"load_state",slot}` DataChannel commands
- Atomic file writes (`.tmp` → fsync → rename)
- Env var `GV_SAVE_DIR` (already exists, defaults to `/tmp`)

## Non-goals (MVP)

- Per-user save slots — single-user only. Multi-user path prefix comes later.
- Cloud sync — files on local disk, not DB or S3.
- Compression — raw save states. zstd later if needed.
- Save state preview thumbnails.

## Phase 2: Retrieval, deletion, upload

Once the signaling relay (issue #151) is in place, saves need a CRUD API:

### Where artifacts live

Worker's local filesystem at `GV_SAVE_DIR`. On VPS, this is a Docker
bind-mount to a persistent host directory (e.g. `/srv/games-vault/saves`).
Container restarts don't lose saves. Multiple workers share the same
volume if they mount the same host path.

### API (gv-web, relayed through gv-server → gv-worker)

```
GET  /api/saves/{sessionId}/list
  → [{ type: "sram", name: "battery.srm", size: 8192 },
     { type: "state", slot: 1, size: 1048576 }, ...]

GET  /api/saves/{sessionId}/download/sram
  → raw bytes of battery.srm (Content-Disposition: attachment)

GET  /api/saves/{sessionId}/download/state/{slot}
  → raw bytes of slot-NN.state

DELETE /api/saves/{sessionId}/sram
  → delete battery.srm (next load starts fresh)

DELETE /api/saves/{sessionId}/state/{slot}
  → delete slot-NN.state

POST /api/saves/{sessionId}/upload/sram
  Body: multipart/form-data with .srm file
  → overwrite battery.srm (then reload core or restore on next frame)

POST /api/saves/{sessionId}/upload/state/{slot}
  Body: multipart/form-data with .state file
  → overwrite slot-NN.state
```

### Worker endpoints (internal, 127.0.0.1 only)

These are called by gv-server, not the browser:

```
POST /internal/saves/sram        → { action: "read"|"write"|"delete", data?: base64 }
POST /internal/saves/state/{slot} → { action: "read"|"write"|"delete", data?: base64 }
GET  /internal/saves/list         → JSON array of { type, slot?, size }
```

The worker stores bytes in base64 over the internal HTTP channel.
gv-server re-encodes as raw bytes for browser download (multipart
or direct binary response).

### Why HTTP for saves when DataChannel exists?

- Browser download UX: `Content-Disposition: attachment` gives a proper
  file save dialog. DataChannel requires JS to buffer and trigger a blob
  download manually.
- Upload: multipart/form-data is the standard browser file upload mechanism.
  DataChannel would require reading a File object into an ArrayBuffer.
- Large states (8+ MB N64): HTTP streaming is simpler than chunked
  DataChannel reassembly.
- Save management doesn't need real-time latency — it's an occasional
  operation, not per-frame.

### Implementation order

1. Task 9 + 9.5 (SRAM auto-save + save state commands) — works today
2. Issue #151 (signaling relay) — gv-server relays HTTP to worker
3. Save CRUD endpoints on gv-web → gv-server → gv-worker
4. Optional: browser UI for save management (download/upload/delete buttons)

## Consequences

- SRAM "just works" — load a game, play, close, reopen, progress is there
- Save states give the player save-scumming (9 slots, RetroArch convention)
- ROM hash as key means moving/renaming ROMs doesn't break saves
- No new dependencies — `std::fs` + `sha2` (already in Cargo.lock via other deps)
