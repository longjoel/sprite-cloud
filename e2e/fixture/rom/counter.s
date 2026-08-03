;; ─────────────────────────────────────────────────────────────────────
;; sprite-cloud e2e fixture ROM
;;
;; A deterministic NES homebrew used by the browser E2E harness (#662).
;;
;; Behavior:
;;   - Boots to a fixed scene: four decimal digits, "0000", centered.
;;   - A button  -> counter += 1 (mod 10000)
;;   - B button  -> counter -= 1 (mod 10000)
;;   - Start     -> counter = 0
;;   - The 16-bit counter is mirrored to SRAM ($6000/$6001) whenever it
;;     changes, so battery-backed save files can be observed. On boot the
;;     counter always starts at 0 — boot output is identical every run
;;     (determinism contract for the E2E).
;;
;; Determinism properties:
;;   - No RNG, no audio, no interrupts, no mapper tricks.
;;   - Single 60fps polling loop; frame content depends only on the
;;     counter value and elapsed frame count.
;;   - Mapper 0 (NROM), 32KB PRG, CHR-RAM (font uploaded at init).
;;
;; Build (from e2e/fixture/rom):
;;   cl65 -t nes -o counter.nes counter.s
;;
;; License: MIT (see e2e/fixture/LICENSE). Written for Sprite Cloud E2E.
;; ─────────────────────────────────────────────────────────────────────

.segment "HEADER"
  .byte "NES", $1A          ; iNES magic
  .byte $02                 ; 2 x 16KB PRG
  .byte $00                 ; 0 x 8KB CHR (CHR-RAM)
  .byte %00000000           ; mapper 0, horizontal mirroring
  .byte %00000000           ; no mapper, no battery
  .byte $00, $00, $00, $00  ; unused
  .byte $00, $00, $00, $00  ; unused

.segment "ZEROPAGE"
counter:    .res 2          ; 16-bit counter (little endian)
buttons:    .res 1          ; current frame buttons
prev_buttons: .res 1        ; previous frame buttons (edge detect)
tmp:        .res 2          ; scratch for division
digits:     .res 4          ; 4 decimal digits (most significant first)

.segment "CODE"

;; ── reset ────────────────────────────────────────────────────────────
reset:
  sei
  cld
  ldx #$40
  stx $4017                 ; disable APU frame IRQ
  ldx #$ff
  txs                       ; stack to top of page 1
  inx
  stx $2000                 ; PPUCTRL = 0 (NMI off)
  stx $2001                 ; PPUMASK = 0 (rendering off)
  stx $4010                 ; disable DMC IRQ

;; wait for first vblank (PPU warmup)
vblank1:
  bit $2002
  bpl vblank1

;; zero RAM pages $00-$07
clear_ram:
  lda #$00
  sta $0000, x
  sta $0100, x
  sta $0200, x
  sta $0300, x
  sta $0400, x
  sta $0500, x
  sta $0600, x
  sta $0700, x
  inx
  bne clear_ram

;; wait for second vblank
vblank2:
  bit $2002
  bpl vblank2

;; ── upload font to CHR-RAM (tiles $00-$09 = digits 0-9) ─────────────
  lda #$00
  sta $2006
  sta $2006                 ; PPU addr = $0000
  ldx #$00
font_loop:
  lda font, x
  sta $2007
  inx
  cpx #160                  ; 10 digits x 16 bytes (plane 0 + plane 1)
  bne font_loop

;; ── palette: bg = dark blue, fg = white ─────────────────────────────
  lda #$3f
  sta $2006
  lda #$00
  sta $2006
  ldx #$00
pal_loop:
  lda palette, x
  sta $2007
  inx
  cpx #$04
  bne pal_loop

;; ── clear nametable $2000-$23FF ─────────────────────────────────────
  lda #$20
  sta $2006
  lda #$00
  sta $2006
  ldx #$00
  lda #$00
nt_clear:
  sta $2007
  inx
  bne nt_clear              ; $2000-$20FF
nt_clear2:
  sta $2007
  inx
  cpx #$00
  bne nt_clear2             ; $2100-$21FF
  ldx #$00
nt_clear3:
  sta $2007
  inx
  cpx #$00
  bne nt_clear3             ; $2200-$22FF
  ldx #$00
nt_clear4:
  sta $2007
  inx
  cpx #$00
  bne nt_clear4             ; $2300-$23FF

;; ── initial digit draw (counter = 0) ────────────────────────────────
  lda #$00
  sta counter
  sta counter+1
  jsr update_display

;; ── enable rendering ─────────────────────────────────────────────────
  lda #%00001000            ; PPUCTRL: bg pattern table 0, NMI off
  sta $2000
  lda #%00001110            ; PPUMASK: show bg + sprites
  sta $2001

;; ── main loop ────────────────────────────────────────────────────────
;; wait_vblank FIRST so update_display's $2007 writes land during the
;; vblank window (writes during active scanlines are ignored by the PPU).
main:
  jsr wait_vblank
  jsr read_buttons
  jsr handle_buttons
  jmp main

;; ── read controller 1 ────────────────────────────────────────────────
read_buttons:
  lda #$01
  sta $4016
  lda #$00
  sta $4016
  ldx #$08
rb_loop:
  lda $4016
  lsr a
  rol buttons
  dex
  bne rb_loop
  rts

;; ── handle A/B/Start with edge detection ────────────────────────────
handle_buttons:
  lda buttons
  eor prev_buttons          ; changed bits
  and buttons               ; ... that are now pressed (rising edge)
  sta tmp
  lda buttons
  sta prev_buttons

  lda tmp
  and #%10000000            ; A = bit 7 (ROL order: A,B,Sl,St,U,D,L,R read 1st → bit 7)
  beq check_b
  inc counter
  bne a_no_hi
  inc counter+1
a_no_hi:
  ;; wrap at 10000 (0x2710): reset to 0
  lda counter+1
  cmp #$27
  bcc a_ok                  ; hi < 0x27 -> below 10000
  bne a_reset               ; hi > 0x27 -> overflow
  lda counter
  cmp #$10
  bcc a_ok                  ; hi == 0x27 && lo < 0x10 -> 9999 or less
a_reset:
  lda #$00
  sta counter
  sta counter+1
a_ok:
  jsr update_display
  rts

check_b:
  lda tmp
  and #%01000000            ; B = bit 6 (second read → bit 6)
  beq check_start
  lda counter
  bne b_dec_lo
  lda counter+1
  beq b_wrap
b_dec_lo:
  lda counter
  sec
  sbc #$01
  sta counter
  lda counter+1
  sbc #$00
  sta counter
  jmp b_done
b_wrap:
  lda #$27                  ; wrap to 9999
  sta counter+1
  lda #$0f
  sta counter
b_done:
  jsr update_display
  rts

check_start:
  lda tmp
  and #%00010000            ; Start = bit 4 (4th read)
  beq buttons_done
  lda #$00
  sta counter
  sta counter+1
  jsr update_display
buttons_done:
  rts

;; ── wait for vblank ──────────────────────────────────────────────────
wait_vblank:
  bit $2002
  bpl wait_vblank
  rts

;; ── update_display: split counter into 4 decimal digits + draw ──────
;; Writes digit tile indices to nametable $202A-$202D (row 1, col 10).
update_display:
  ;; reflect counter into SRAM ($6000/$6001) for save-file observability
  lda counter
  sta $6000
  lda counter+1
  sta $6001

  ;; d0 = counter / 1000, remainder in tmp
  lda counter
  sta tmp
  lda counter+1
  sta tmp+1
  ldx #$00
div1000:
  lda tmp
  cmp #<1000
  lda tmp+1
  sbc #>1000
  bcc div1000_done
  lda tmp
  sec
  sbc #<1000
  sta tmp
  lda tmp+1
  sbc #>1000
  sta tmp+1
  inx
  jmp div1000
div1000_done:
  stx digits               ; thousands
  ;; remainder in tmp -> now /100
  ldx #$00
div100:
  lda tmp
  cmp #<100
  lda tmp+1
  sbc #>100
  bcc div100_done
  lda tmp
  sec
  sbc #<100
  sta tmp
  lda tmp+1
  sbc #>100
  sta tmp+1
  inx
  jmp div100
div100_done:
  stx digits+1             ; hundreds
  ldx #$00
div10:
  lda tmp
  cmp #<10
  lda tmp+1
  sbc #>10
  bcc div10_done
  lda tmp
  sec
  sbc #<10
  sta tmp
  lda tmp+1
  sbc #>10
  sta tmp+1
  inx
  jmp div10
div10_done:
  stx digits+2             ; tens
  lda tmp                  ; ones (already < 10)
  sta digits+3

  ;; draw at nametable $202A-$202D
  lda #$20
  sta $2006
  lda #$2a
  sta $2006
  ldx #$00
draw_loop:
  lda digits, x
  sta $2007
  inx
  cpx #$04
  bne draw_loop

  ;; CRITICAL: writing $2006 during vblank also sets the PPU scroll
  ;; (T register).  At the next pre-render line V=T copies, shifting the
  ;; whole screen by the digit address.  Reset scroll to (0,0) with
  ;; $2005 writes ONLY — a trailing $2006 write would re-corrupt the
  ;; fine-Y scroll bits.
  lda #$00
  sta $2005                 ; fine X = 0
  sta $2005                 ; fine Y = 0, coarse X = 0, coarse Y = 0
  rts

;; ── font: 10 digits, 16 bytes each (NES pattern-table layout) ──────
;; Each tile = 8 bytes plane 0 + 8 bytes plane 1.  Plane 0 holds the
;; glyph (bit7 = leftmost pixel), plane 1 is all zero so each pixel is
;; 2-bit color 0 (bg) or 1 (fg).  Digit N lives at tile N, so writing
;; tile index N to the nametable renders digit N.
font:
  ;; 0
  .byte $70, $88, $88, $88, $88, $88, $70, $00, $00, $00, $00, $00, $00, $00, $00, $00
  ;; 1
  .byte $10, $30, $10, $10, $10, $10, $38, $00, $00, $00, $00, $00, $00, $00, $00, $00
  ;; 2
  .byte $70, $88, $08, $18, $20, $40, $f8, $00, $00, $00, $00, $00, $00, $00, $00, $00
  ;; 3
  .byte $70, $88, $08, $70, $08, $88, $70, $00, $00, $00, $00, $00, $00, $00, $00, $00
  ;; 4
  .byte $88, $88, $88, $f8, $08, $08, $08, $00, $00, $00, $00, $00, $00, $00, $00, $00
  ;; 5
  .byte $f8, $80, $80, $f0, $08, $88, $70, $00, $00, $00, $00, $00, $00, $00, $00, $00
  ;; 6
  .byte $70, $80, $80, $f0, $88, $88, $70, $00, $00, $00, $00, $00, $00, $00, $00, $00
  ;; 7
  .byte $f8, $08, $10, $10, $20, $20, $20, $00, $00, $00, $00, $00, $00, $00, $00, $00
  ;; 8
  .byte $70, $88, $88, $70, $88, $88, $70, $00, $00, $00, $00, $00, $00, $00, $00, $00
  ;; 9
  .byte $70, $88, $88, $78, $08, $88, $70, $00, $00, $00, $00, $00, $00, $00, $00, $00

palette:
  .byte $0f   ; universal bg: dark blue
  .byte $30   ; fg: white
  .byte $0f
  .byte $0f

;; ── vectors ──────────────────────────────────────────────────────────
.segment "VECTORS"
  .word reset   ; NMI (unused)
  .word reset   ; RESET
  .word reset   ; IRQ (unused)
