#!/usr/bin/env python3
"""Build a valid Game Boy tone ROM entirely in Python (hand-assembled SM83).

Constant square wave on channel 1, no input/IRQ/RNG. Deterministic.
"""
import sys

LOGO = bytes.fromhex(
    "CEED6666CC0D000B03730083000C000D"
    "0008111F8889000EDCCC6EE6DDDD9999"
    "BBBB67636E0EECCCDDDC99FBBBB3333E"
)

def main() -> int:
    rom = bytearray(0x8000)

    # Interrupt vectors: reti (unused)
    for vec in (0x40, 0x48, 0x50, 0x58, 0x60, 0x68, 0x70, 0x78):
        rom[vec] = 0xD9

    # Entry point: nop; jp $0150
    rom[0x100] = 0x00
    rom[0x101] = 0xC3
    rom[0x102] = 0x50
    rom[0x103] = 0x01

    # Header
    rom[0x104:0x134] = LOGO
    title = b"SC AUDIO PROBE"
    rom[0x134:0x134 + len(title)] = title
    rom[0x147] = 0x00  # cartridge type: ROM only
    rom[0x148] = 0x00  # ROM size: 32 KB
    rom[0x149] = 0x00  # RAM size: none
    rom[0x14A] = 0x00  # destination: Japan
    rom[0x14B] = 0x33  # old licensee
    rom[0x14C] = 0x00  # version
    total = sum(rom[0x134:0x14C]) & 0xFF
    rom[0x14D] = (-total) & 0xFF

    # Code @ 0x150: APU power on, ch1 square wave, loop forever
    code = bytes.fromhex(
        "3E 80 E0 26"   # ld a,$80; ld ($FF26),a  ; NR52 power
        "3E 77 E0 24"   # ld a,$77; ld ($FF24),a  ; NR50 vol both
        "3E 11 E0 25"   # ld a,$11; ld ($FF25),a  ; NR51 ch1->both
        "3E 00 E0 10"   # ld a,$00; ld ($FF10),a  ; NR10 sweep off
        "3E 80 E0 11"   # ld a,$80; ld ($FF11),a  ; NR11 duty 50%
        "3E F0 E0 12"   # ld a,$F0; ld ($FF12),a  ; NR12 vol 15
        "3E F0 E0 13"   # ld a,$F0; ld ($FF13),a  ; NR13 period lo
        "3E 87 E0 14"   # ld a,$87; ld ($FF14),a  ; NR14 trigger
        "18 FE"         # loop: jr loop
    )
    rom[0x150:0x150 + len(code)] = code

    out = sys.argv[1] if len(sys.argv) > 1 else "gb-tone.gb"
    open(out, "wb").write(rom)
    print(f"wrote {out} ({len(rom)} bytes)")
    return 0

if __name__ == "__main__":
    sys.exit(main())
