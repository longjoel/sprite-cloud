# E2E Fixture — deterministic homebrew NES ROM

Slice 1 of #662: a machine-verifiable, license-clean deterministic fixture for
the browser E2E harness.

## What this is

A tiny NES homebrew game written in 6502 assembly, built from source in CI
with `cc65` (MIT-licensed, pinned apt package). No downloaded ROMs, no
copyrighted assets — every byte of the ROM derives from `rom/counter.s`, so
determinism is verifiable by construction.

**The game:** boots to a fixed scene showing four decimal digits, `0000`,
centered in row 1. Pressing **A** increments the counter (mod 10000), **B**
decrements it, **Start** resets it to 0. The 16-bit counter is mirrored to
SRAM ($6000/$6001) on every change so the save-file flow can observe it.

**Determinism guarantees** (why this is a good E2E fixture):
- No RNG, no audio, no IRQs, no mapper tricks — pure NROM, vblank-synced
- Same ROM + same frame count + same input → byte-identical rendered frame
- Counter is RAM-backed and read/written synchronously, so save/load
  round-trips are exact

## Layout

```
e2e/fixture/
  rom/counter.s         6502 source (ca65 syntax, MIT)
  harness/counter_harness.c   headless libretro harness (dlsym, no X)
  harness/libretro.h     libretro API header (MIT, from libretro-common)
  build.sh              reproducible build: cl65 -> .nes, gcc -> harness
  verify.sh             determinism + behavior verification (fail-closed)
  LICENSE               MIT
```

## Build

Requires `cc65` (apt: `apt-get install cc65`) and `gcc`.

```sh
./build.sh            # outputs to out/ (rom/counter.nes + harness)
```

## Verify

Requires a nestopia libretro core. Default path is the sc-server cores dir;
override with `CORE=/path/to/nestopia_libretro.so`.

```sh
./verify.sh           # 4 checks, exits nonzero on any failure
```

Checks:
1. **Boot determinism** — two no-input 120-frame runs hash identically
2. **Input determinism** — two A-press runs hash identically
3. **Input response** — A-press frame differs from no-input frame
4. **Button behavior** — pixel-probes the digits: no-input `0000`,
   A `0001`, B `9999` (wrap), Start `0000`

## Golden hashes (nestopia v1.53.2, 120 frames, 256x240)

| scenario          | sha256 (frame)                                                      |
|-------------------|---------------------------------------------------------------------|
| no-input ×2       | `26d8cbea51b555f56abb95e9e791da1b95156098e2bcc64a40e679e9c66eb9fb` |
| A-press ×2        | `ee408045c67f91f50ab4c2ee47287b73d4952d5dc0e82480f14820ddaf0dd380` |

These are *recorded* values, not asserted by verify.sh (which compares runs
within one invocation) — they exist so a core-version bump that changes
rendering is visible as a golden mismatch during CI triage.

## How it's deterministic (the boring but important part)

- `read_buttons` strobes $4016 and shifts 8 reads through carry — the bit
  order after `rol` is A,B,Select,Start,Up,Down,Left,Right *reversed*, so the
  masks are `A=$80, B=$40, Start=$10`.
- Font lives in CHR-RAM as 16-byte tiles (plane 0 + plane 1), digit N at
  tile N — writing tile index N to the nametable renders digit N.
- Division is compare-first (no garbage remainder on borrow).
- `update_display` runs only inside vblank, and resets the PPU scroll with
  `$2005` writes afterwards — writing `$2006` would shift the screen.
- The harness **must** call `retro_set_controller_port_device(0, JOYPAD)`
  and answer `RETRO_DEVICE_ID_JOYPAD_MASK` — without both, nestopia never
  wires the gamepad and $4016 reads open-bus.
