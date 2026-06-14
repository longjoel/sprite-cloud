# ADR 009: Emulator core integration

**Status:** Proposed
**Date:** 2026-06-14

## Context

gv-worker currently streams a test pattern (bouncing square + test tone).
To stream real games, it must load a libretro core, feed it a ROM, and
capture video/audio frames from `retro_run()`. Nosebleed (the v1 runtime)
already does this in Rust. The question is whether gv-worker embeds
libretro directly or reuses Nosebleed's implementation.

## Options

### A: Embed libretro directly in gv-worker
- Link against `libretro.h`, load `.so` cores via `dlopen`
- Re-implement core discovery, loading, AV info extraction, frame capture,
  audio capture, input injection, save states
- Fully self-contained — no Nosebleed dependency
- **Effort:** High. Duplicates ~2,000+ lines of Nosebleed's core loading,
  video/audio pipeline, input mapping, and save state logic.

### B: Extract a shared `libretro-runner` crate
- Pull Nosebleed's core-loading, frame-capture, audio-capture, and input
  injection into a standalone Rust crate (`libretro-runner`)
- Both Nosebleed and gv-worker depend on it
- Shared bug fixes, shared core compatibility
- **Effort:** Medium. Refactor Nosebleed to expose its internals as a
  library crate. gv-worker then uses it with minimal glue.

### C: Spawn Nosebleed as a subprocess
- gv-worker spawns Nosebleed with `--headless --output-raw` or similar
- Captures raw video frames via pipe/shared memory
- **Effort:** Low for prototyping, but high latency and fragile IPC
- Defeats the purpose of v2's clean architecture

## Decision

**Option B — extract a shared `libretro-runner` crate from Nosebleed.**

## Rationale

- Nosebleed already handles core loading, platform quirks (Gambatte,
  mGBA, Genesis, SNES, N64, FBNeo), aspect ratio detection, save states,
  and audio resampling. Reimplementing all of that is error-prone and
  wastes the investment in Nosebleed.
- A shared crate means one source of truth for core compatibility.
  Fixes to Gambatte save-RAM flushing or mGBA defaults apply everywhere.
- gv-worker stays focused on WebRTC streaming and session management.
  The emulator runtime is a library dependency, not its responsibility.
- The refactor benefits Nosebleed too (cleaner internal API, testable
  in isolation).

## Consequences

- **Nosebleed refactor required.** Must extract `libretro-runner` with:
  - Core discovery + loading (DLopen, `retro_api` struct)
  - AV info extraction (`retro_get_system_av_info`)
  - Frame capture (`retro_run` → video buffer → RGB/RGB565 → RGB24)
  - Audio capture (`retro_run` → audio buffer → interleaved PCM)
  - Input injection (`retro_input_state_t` for keyboard/gamepad)
  - Save states (`retro_serialize`/`unserialize`)
  - Core options (optional for MVP)
- gv-worker adds `libretro-runner` as a Cargo dependency.
- Nosebleed itself becomes a thin CLI + WebSocket/WebRTC frontend on top
  of `libretro-runner`.

## Core compatibility scope

Initial supported cores (carried forward from Nosebleed's catalog):

| Core | System | Notes |
|------|--------|-------|
| Gambatte | GB/GBC | Save-RAM flush on unload |
| mGBA | GBA | Default for GB/GBC/GBA |
| Genesis Plus GX | Genesis/MD | |
| Snes9x | SNES | |
| Mupen64Plus-Next | N64 | GLideN64 video, non-square pixels |
| FBNeo | Arcade | Requires BIOS/system files |

See `references/v2-pipeline-gap-analysis.md` for the full integration plan.
