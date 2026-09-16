.setcpu "65C02"

; =============================================================================
;   VDP Font — the 6502-PICOVDP's built-in font, three ways
; =============================================================================
;   An AC6502 cartridge that draws all 256 characters in Text mode three times,
;   each time from a font the card put there itself (`docs/VDP-SPEC.md` §7):
;
;     1s   reset      the font reset installs at $0800, untouched
;     1s   loaded     $0800-$0FFF filled with $FF, then `FONT` loads it back
;     --   relocated  `L0PAT` moved to $1000, then `FONT` loads it there
;
;   Then it stays on the third screen. Nothing waits on input, so a headless
;   machine walks all three from a cold reset, which is what makes it a golden
;   fixture.
;
;   It never calls `KernalInit` and never uploads a character set. Every other
;   fixture does — BIOS 1.x's `InitCharacters` copies $B800 to $0800 before the
;   first checkpoint — and that is why none of their goldens can see the reset
;   font. This one can see nothing else.
;
;   Interrupts stay disabled throughout. The program polls `STAT0` b7 for the
;   vertical blank, which is also how it waits for a `FONT` load: §7 completes a
;   load at the line start where vertical blank fires, before F sets, so the
;   first F after the command finds it done.
; =============================================================================

.segment "CART"

; =============================================================================
;   The machine
; =============================================================================

VC_DATA             := $9C00     ; R/W — VRAM data, auto-incrementing (§4)
VC_REG              := $9C01     ; W   — command port, port A
VC_STATUS           := $9C01     ; R   — status port, port A

; =============================================================================
;   VDP registers (§5)
; =============================================================================

R_MODE0             = $00
R_MODE1             = $01
R_COLOR             = $07
R_VBANK             = $08
R_VINC              = $09
R_VMODE             = $0D
R_L0NAME            = $10
R_L0ATTR            = $11
R_L0PAT             = $12
R_L0CTRL            = $15
R_L0PAL             = $16
R_SPRCTRL           = $23
R_FONT              = $30

; `MODE1`: b6 display enable. The vblank interrupt (b5) is never enabled.
DISP_OFF            = $00
DISP_ON             = $40

; `SPRCTRL` with b0 clear: sprites off, everything else at its reset value.
SPR_OFF             = $26

VMODE_TEXT          = $01        ; 40 x 24 cells of 6 x 8 (§9)
CTRL_1BPP_CELL      = $30        ; `L0CTRL`: 1bpp, a colour byte per cell, enabled, index 0 opaque

; `FONT` (§5, §7): b7 clear is layer 0's pattern table, b6:0 the font ID.
FONT_CP437_L0       = $00

; =============================================================================
;   VRAM layout
; =============================================================================
;   Everything below $4000, so `VBANK` stays 0. The name and attribute tables
;   sit under $0800 so that the reset font's 2 KB is left to the font.

NAME                = $0000      ; name table      — 960 bytes
ATTR                = $0400      ; attribute table — 960 bytes, one per cell
FONT_RESET          = $0800      ; where reset puts the font; `L0PAT` = $01
FONT_MOVED          = $1000      ; where screen 3 loads it;   `L0PAT` = $02

L0NAME_VAL          = $00        ; NAME       / $400
L0ATTR_VAL          = $01        ; ATTR       / $400
L0PAT_RESET         = $01        ; FONT_RESET / $800
L0PAT_MOVED         = $02        ; FONT_MOVED / $800

COLS                = 40
ROWS                = 24

; The character grid: 16 x 16, each character followed by a space, centred.
GRID_LEFT           = 4
GRID_TOP            = 4

; =============================================================================
;   Zero page
; =============================================================================

PTR                 = $3A        ; 2 bytes — table pointer
ROW                 = $3C
COL                 = $3D
CHAR                = $3E
TMP                 = $3F

; How long screens 1 and 2 are held, in frames. One second at 60 Hz.
HOLD_FRAMES         = 60

; =============================================================================
;   CartReset — the cartridge entry point
; =============================================================================

CartReset:
  sei
  cld
  ldx #$ff
  txs

  jsr SetupCommon

  ; Screen 1: the font reset left at $0800.
  jsr BlankDisplay
  lda #0
  jsr DrawScreen
  jsr ShowAndHold

  ; Screen 2: clobber it, and have the card load it back.
  jsr BlankDisplay
  lda #<FONT_RESET
  ldx #>FONT_RESET
  jsr FillFF
  jsr LoadFont
  lda #1
  jsr DrawScreen
  jsr ShowAndHold

  ; Screen 3: move the pattern table, clobber the new one, and load it there.
  jsr BlankDisplay
  lda #<FONT_MOVED
  ldx #>FONT_MOVED
  jsr FillFF
  lda #L0PAT_MOVED
  ldx #R_L0PAT
  jsr SetReg
  jsr LoadFont
  lda #2
  jsr DrawScreen
  lda #DISP_ON
  ldx #R_MODE1
  jsr SetReg

Forever:
  bra Forever

; =============================================================================
;   Talking to the VDP (§4)
; =============================================================================

; Write A into register X: the value, then the register number with b7 set.
SetReg:
  sta VC_REG
  txa
  ora #$80
  sta VC_REG
  rts

; Point the VRAM pointer at $XXAA for writing.
SetWrite:
  sta VC_REG
  txa
  ora #$40
  sta VC_REG
  rts

; Wait for the end of the picture: `STAT0` b7, which reading the port clears.
WaitVBlank:
  lda VC_STATUS
  and #$80
  beq WaitVBlank
  rts

BlankDisplay:
  lda #DISP_OFF
  ldx #R_MODE1
  jmp SetReg

ShowAndHold:
  lda #DISP_ON
  ldx #R_MODE1
  jsr SetReg
  ldx #HOLD_FRAMES
@Frame:
  jsr WaitVBlank
  dex
  bne @Frame
  rts

; Load font $00 into layer 0's pattern table, as §7 says to: read `STAT0` to
; clear F, write `FONT`, and wait for F. The destination is `L0PAT` × $800 as it
; stands at the write.
LoadFont:
  lda VC_STATUS                     ; clear F
  lda #FONT_CP437_L0
  ldx #R_FONT
  jsr SetReg
  jmp WaitVBlank                    ; the load has landed when F sets

; Fill the 2 KB at $XXAA with $FF.
FillFF:
  jsr SetWrite
  ldx #8                            ; eight pages of 256
  lda #$ff
@Page:
  ldy #0
@Byte:
  sta VC_DATA
  iny
  bne @Byte
  dex
  bne @Page
  rts

; =============================================================================
;   SetupCommon — the Text mode every screen shares
; =============================================================================

SetupCommon:
  lda #DISP_OFF
  ldx #R_MODE1
  jsr SetReg
  lda #$00                          ; VRAM A15:A14 — bank 0
  ldx #R_VBANK
  jsr SetReg
  lda #$01                          ; +1 per access
  ldx #R_VINC
  jsr SetReg
  lda #$00
  ldx #R_MODE0
  jsr SetReg
  lda #SPR_OFF
  ldx #R_SPRCTRL
  jsr SetReg

  lda #VMODE_TEXT
  ldx #R_VMODE
  jsr SetReg
  lda #CTRL_1BPP_CELL
  ldx #R_L0CTRL
  jsr SetReg
  lda #$00                          ; palette row 0: the nibbles are its colours
  ldx #R_L0PAL
  jsr SetReg
  lda #$F1                          ; backdrop black
  ldx #R_COLOR
  jsr SetReg

  lda #L0NAME_VAL
  ldx #R_L0NAME
  jsr SetReg
  lda #L0ATTR_VAL
  ldx #R_L0ATTR
  jsr SetReg
  lda #L0PAT_RESET                  ; $0800, where reset put the font
  ldx #R_L0PAT
  jmp SetReg

; =============================================================================
;   DrawScreen — the title for screen A (0-2), and all 256 characters
; =============================================================================

DrawScreen:
  asl a
  tax
  lda Titles,x
  sta PTR
  lda Titles+1,x
  sta PTR+1
  jsr DrawNames
  jmp DrawAttributes

; The name table, row by row: a title on row 1, the grid on rows 4-19, spaces
; everywhere else.
DrawNames:
  lda #<NAME
  ldx #>NAME
  jsr SetWrite
  stz CHAR
  stz ROW
@Row:
  stz COL
@Col:
  jsr NameAt
  sta VC_DATA
  inc COL
  lda COL
  cmp #COLS
  bne @Col
  inc ROW
  lda ROW
  cmp #ROWS
  bne @Row
  rts

; The byte for cell (ROW, COL), in A. Walks CHAR through the grid in order.
NameAt:
  lda ROW
  cmp #1
  bne @Grid
  ldy COL                           ; the title: 40 bytes at PTR
  lda (PTR),y
  rts
@Grid:
  sec
  sbc #GRID_TOP
  cmp #16
  bcs @Space                        ; not a grid row
  lda COL
  sec
  sbc #GRID_LEFT
  cmp #32
  bcs @Space                        ; not a grid column
  lsr a
  bcs @Space                        ; the space after each character
  lda CHAR
  inc CHAR
  rts
@Space:
  lda #' '
  rts

; The attribute table: white on dark blue for the title row, and one of eight
; inks on black for each grid row, so that every cell's colour byte is read.
DrawAttributes:
  lda #<ATTR
  ldx #>ATTR
  jsr SetWrite
  stz ROW
@Row:
  lda ROW
  cmp #1
  bne @Body
  lda #$F4                          ; white on dark blue
  bra @Fill
@Body:
  and #$07
  tay
  lda Inks,y
@Fill:
  ldx #COLS
@Col:
  sta VC_DATA
  dex
  bne @Col
  inc ROW
  lda ROW
  cmp #ROWS
  bne @Row
  rts

; =============================================================================
;   Data
; =============================================================================

; Foreground nibble on black (1): white, light yellow, light green, cyan,
; light red, magenta, light blue, grey.
Inks:
  .byte $F1, $B1, $31, $71, $91, $D1, $51, $E1

Titles:
  .word Title0, Title1, Title2

;            0123456789012345678901234567890123456789
Title0:
  .byte "  VDP FONT: THE FONT RESET PUT AT $0800 "
Title1:
  .byte "  VDP FONT: $FF, THEN FONT $00 AT $0800 "
Title2:
  .byte "  VDP FONT: L0PAT $02, FONT $00 AT $1000"

; =============================================================================
;   CPU vectors
; =============================================================================

IrqTrampoline:
  rti

NmiTrampoline:
  rti

.segment "VECTORS"

  .word NmiTrampoline
  .word CartReset
  .word IrqTrampoline
