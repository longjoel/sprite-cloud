# Audio fixtures — mono-channel verification

Deterministic tone ROMs for verifying that mono-hardware platforms stream
identical L/R audio (issue #686). All built from source, no copyrighted
game content, no RNG/input/IRQ.

## Files

| File | Platform | Source |
|---|---|---|
| `tone.nes` | NES (NROM, mapper 0) | `tone.s` + `nes16.cfg` |
| `gb-tone.gb` | Game Boy / Game Boy Color | `make-gb-tone.py` |

- `tone.s` — ca65 source: APU pulse channel 1, constant square wave.
  **No vblank wait** — with rendering disabled nestopia never sets the
  vblank flag, so a `bit $2002` wait spins forever and the ROM is silent.
- `nes16.cfg` — ld65 config. **Required**: the default `-t nes` config
  targets a 32 KB PRG cart and places the reset vectors in a region a
  16 KB cart never maps — the core boots to $0000 and produces silence.
  This config keeps vectors inside the single 16 KB bank ($BFFA).
- `gb-tone.gb` — hand-assembled SM83: NR52=$80, NR50=$77, NR51=$11,
  NR10=$00, NR11=$80, NR12=$F0, NR13=$F0, NR14=$87, then spin. The
  Nintendo logo (0x104–0x133) is **required** — mGBA rejects logo-less
  ROMs (`retro_load_game` returns false). Standard homebrew practice.

Rebuild:
```sh
ca65 -o tone.o tone.s && ld65 -C nes16.cfg -o tone.nes tone.o
python3 make-gb-tone.py gb-tone.gb
```

## Verification matrix (as of 2026-08-04, v0.12.13)

Probe: `libretro-runner/tests/audio_probe.rs` (150 frames, per-channel
energy, unequal-pair count; `TEST_AUDIO_STRICT=1` fails on any silence
or channel asymmetry). CI runs it for NES + GB.

| Platform | Core | Result |
|---|---|---|
| NES | nestopia_libretro.so | ✅ verified — 0 unequal pairs, identical L/R energy |
| Game Boy | mgba_libretro.so | ✅ verified — 0 unequal pairs |
| Game Boy Color | mgba_libretro.so (CGB flag) | ✅ verified — 0 unequal pairs |
| FDS | nestopia_libretro.so (same core) | by construction — same core as verified NES |
| Master System / Game Gear | genesis_plus_gx_libretro.so | ⚠️ probe attempted; tone ROM did not boot (silent), fixture needs work — flagged mono by construction (PSG has no panning), NOT yet empirically verified |
| Neo Geo Pocket (Color) | mednafen_ngp_libretro.so | by construction — mono hardware, no core probe yet |
| Atari 2600/5200/7800 | stella2014 / a5200 / prosystem | by construction — mono hardware, no core probe yet |
| Pokemon Mini | pokemini_libretro.so | by construction — mono hardware, no core probe yet |

Stereo-capable platforms (GBA, SNES, PSX, PCE, VB, Lynx, WS, Sega CD,
Saturn, DC, ...) are deliberately NOT forced mono — forcing would destroy
real stereo content.
