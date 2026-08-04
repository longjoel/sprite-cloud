; Deterministic APU tone ROM (NROM, mapper 0) — no input, no IRQ, no RNG.
; Constant square wave on pulse channel 1. No vblank wait (rendering off;
; the APU does not need the PPU).
;
; Build: ca65 -o tone.o tone.s && ld65 -C nes16.cfg -o tone.nes tone.o

.segment "HEADER"
    .byte "NES", $1A
    .byte $01        ; 16 KB PRG
    .byte $01        ; 8 KB CHR ROM (all zero tiles)
    .byte $00        ; mapper 0, vertical mirroring
    .byte $00, $00, $00, $00, $00, $00, $00, $00, $00

.segment "CODE"

reset:
    sei
    ; Enable pulse channel 1
    lda #$01
    sta $4015
    ; $4000: duty 10, constant volume, volume 15
    lda #$BF
    sta $4000
    ; $4001: no sweep
    lda #$00
    sta $4001
    ; $4002/$4003: period $08AD -> ~50 Hz @ 1.789773 MHz
    lda #$AD
    sta $4002
    lda #$08
    sta $4003

loop:
    jmp loop

.segment "CHARS"
    .res 8192, $00

.segment "VECTORS"
    .word reset   ; NMI (unused)
    .word reset   ; RESET
    .word reset   ; IRQ (unused)
