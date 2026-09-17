.setcpu "65C02"

; =============================================================================
;   VDP Modes — the four 6502-PICOVDP geometries, one per screen
; =============================================================================
;   An AC6502 cartridge that puts each of `VMODE`'s four display modes on the
;   screen in turn, each at a different bit depth and attribute source, so that
;   the tile engine of `docs/VDP-SPEC.md` §8 and §9 is exercised from 6502 code
;   through the real port pair rather than by a test poking registers.
;
;     1s   Text     40 x 24 of 6 x 8   1bpp, per cell        (VMODE $1)
;     1s   Compact  32 x 24 of 8 x 8   2bpp, per cell        (VMODE $2)
;     1s   Graphics 32 x 30 of 8 x 8   4bpp, per cell        (VMODE $3)
;     1s   Full     40 x 30 of 8 x 8   8bpp, no attributes   (VMODE $4)
;
;   Then round again, forever. Nothing waits on input: a headless machine with
;   no keyboard attached walks the whole cycle from a cold reset, which is what
;   makes it usable as a golden fixture.
;
;   The four screens are chosen so that every geometry is crossed with a
;   different depth and a different way of colouring a cell, and so that between
;   them they show the things the legacy submode cannot reach: a text screen
;   where every cell carries its own colour pair, sub-palettes, flipping, the
;   attribute byte's ninth pattern-index bit, and 256 colours at once.
;
;   Sprites are deliberately off. They are §10's, they are pinned by the unit
;   tests and drawn by the VDP Layers cartridge, and leaving them out keeps every
;   pixel of this picture attributable to the tile engine.
;
;   Interrupts stay disabled throughout. This program polls `STAT0` b7 for the
;   vertical blank, and an interrupt handler that read the status register would
;   take the flag out from under it.
; =============================================================================

.segment "CART"

; =============================================================================
;   The machine
; =============================================================================
;   Declared here rather than pulled in from `6502.inc` in the 6502-CRT
;   template: this repository is the emulator, not the assembly toolchain, and
;   six symbols are cheaper to read than a vendored copy of the whole include.

VC_DATA             := $9C00     ; R/W — VRAM data, auto-incrementing (§4)
VC_REG              := $9C01     ; W   — command port, port A
VC_STATUS           := $9C01     ; R   — status port, port A

KernalInit          := $A078     ; Probe and initialise the I/O cards

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

; `FONT` (§5, §7): b7 clear is layer 0's pattern table, b6:0 the font ID.
FONT_CP437_L0       = $00

; `MODE1`: b6 display enable, b5 vblank IRQ enable. Both screens' worth of
; picture is drawn with the interrupt off — this program polls instead.
DISP_OFF            = $00
DISP_ON             = $40

; `SPRCTRL` with b0 clear: sprites off, everything else left at its reset value.
SPR_OFF             = $26

; `VMODE` b3:0 — the four geometries of §9.
VMODE_TEXT          = $01
VMODE_COMPACT       = $02
VMODE_GRAPHICS      = $03
VMODE_FULL          = $04

; `LxCTRL` (§8): b1:0 depth, b3:2 attribute source, b4 enable, b5 index 0 opaque.
;   $30 = 1bpp, per cell          $31 = 2bpp, per cell
;   $32 = 4bpp, per cell          $3F = 8bpp, no attribute fetch
CTRL_1BPP_CELL      = $30
CTRL_2BPP_CELL      = $31
CTRL_4BPP_CELL      = $32
CTRL_8BPP_NONE      = $3F

; =============================================================================
;   VRAM layout
; =============================================================================
;   One layout, reused by all four screens: each rebuilds the tables it needs
;   while the display is blanked. Everything sits below $4000 so that `VBANK`
;   stays 0 and a pointer is the fourteen bits the command protocol carries.
;
;   The bases are the §5 granules: name and attribute tables in 1 KB units,
;   pattern tables in 2 KB. Full mode's name table is 1200 bytes and so spans
;   two of its 1 KB blocks, which costs nothing — the table is contiguous from
;   its base like every other geometry's.

NAME                = $0000      ; name table      — up to 1200 bytes
ATTR                = $0800      ; attribute table — up to  960 bytes
PATTERN             = $1000      ; pattern table   — up to    2 KB
PATTERN_HIGH        = $3000      ; PATTERN + 256 tiles x 32 bytes, for bit 8

L0NAME_VAL          = $00        ; NAME    / $400
L0ATTR_VAL          = $02        ; ATTR    / $400
L0PAT_VAL           = $02        ; PATTERN / $800

; =============================================================================
;   Zero page — $3A upward is the user range the BIOS leaves alone
; =============================================================================

ROW                 = $3C
COL                 = $3D
TMP                 = $3E
TMP2                = $3F

; How long each screen is held, in frames. One second at 60 Hz.
HOLD_FRAMES         = 60

; =============================================================================
;   CartReset — the cartridge entry point
; =============================================================================

CartReset:
  ldx #$ff
  txs                               ; KernalInit does not reset the stack
  jsr KernalInit                    ; probe the I/O cards; leaves IRQs disabled

  ; No CLI. See the header: the vertical-blank poll below owns STAT0, and the
  ; Kernal's IRQ handler reading it would clear the flag before this does.

  jsr SetupCommon

Main:
  jsr Screen1Text
  jsr Screen2Compact
  jsr Screen3Graphics
  jsr Screen4Full
  bra Main

; =============================================================================
;   Talking to the VDP (§4)
; =============================================================================

; Write A into register X. Two bytes to the command port: the value, then the
; register number with b7 set.
SetReg:
  sta VC_REG
  txa
  ora #$80
  sta VC_REG
  rts

; Point the VRAM pointer at $XXAA for writing: the low byte, then the high six
; bits with b6 set. Bits 15:14 come from `VBANK`, which this program leaves at 0.
SetWrite:
  sta VC_REG
  txa
  ora #$40
  sta VC_REG
  rts

; Wait for the end of the picture. `STAT0` b7 is set at the end of the active
; display whatever `IRQEN` says (§6), and reading the port clears it.
WaitVBlank:
  lda VC_STATUS
  and #$80
  beq WaitVBlank
  rts

BlankDisplay:
  lda #DISP_OFF
  ldx #R_MODE1
  jmp SetReg

; Turn the picture on and leave it up for HOLD_FRAMES frames.
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

; =============================================================================
;   SetupCommon — everything the four screens share
; =============================================================================

SetupCommon:
  lda #$00                          ; VRAM A15:A14 — everything is in bank 0
  ldx #R_VBANK
  jsr SetReg
  lda #$01                          ; +1 per access, the classic stride
  ldx #R_VINC
  jsr SetReg
  lda #$00                          ; M3 clear; VMODE takes over from here
  ldx #R_MODE0
  jsr SetReg
  lda #SPR_OFF
  ldx #R_SPRCTRL
  jsr SetReg

  lda #L0NAME_VAL
  ldx #R_L0NAME
  jsr SetReg
  lda #L0ATTR_VAL
  ldx #R_L0ATTR
  jsr SetReg
  lda #L0PAT_VAL
  ldx #R_L0PAT
  jmp SetReg

; =============================================================================
;   Screen 1 — Text, 1bpp, a colour pair per cell
; =============================================================================
;   40 x 24 cells of 6 x 8, which is the geometry the BIOS console runs in — but
;   where legacy Text mode fetches no attribute at all and takes both its
;   colours from `COLOR`, this reads one byte per cell. Sixteen backgrounds
;   along the top row, sixteen foregrounds along the second, and a diagonal
;   wash over the character set below.
;
;   The patterns are the card's built-in font, loaded by `FONT` (§7) rather
;   than copied out of a BIOS ROM, so the cartridge draws the same screen on
;   any BIOS: §8 puts the leftmost six bits of a 1bpp row on screen in a
;   6-pixel cell, which is the format the font is in.

Screen1Text:
  jsr BlankDisplay
  jsr LoadCharset
  jsr S1Name
  jsr S1Attr

  lda #VMODE_TEXT
  ldx #R_VMODE
  jsr SetReg
  lda #CTRL_1BPP_CELL
  ldx #R_L0CTRL
  jsr SetReg
  lda #$00                          ; the sixteen colours the nibbles name
  ldx #R_L0PAL
  jsr SetReg
  lda #$F1                          ; backdrop black; the border is all of it
  ldx #R_COLOR
  jsr SetReg
  jmp ShowAndHold

; The character set: font $00 into the pattern table, as §7 says to: read
; `STAT0` to clear F, write `FONT`, and wait for F. The destination is
; `L0PAT` x $800 at the write, which SetupCommon left at PATTERN.
LoadCharset:
  lda VC_STATUS                     ; clear F
  lda #FONT_CP437_L0
  ldx #R_FONT
  jsr SetReg
  jmp WaitVBlank                    ; the load has landed when F sets

S1Name:
  lda #<NAME
  ldx #>NAME
  jsr SetWrite

  ldx #0                            ; row 0 and row 1: the two title lines
@Title:
  lda Title0,x
  sta VC_DATA
  inx
  cpx #40
  bne @Title
  ldx #0
@Title2:
  lda Title1,x
  sta VC_DATA
  inx
  cpx #40
  bne @Title2

  stz TMP                           ; rows 2-23: the character set, round and round
  ldy #22
@Row:
  ldx #40
@Col:
  lda TMP
  sta VC_DATA
  inc TMP
  dex
  bne @Col
  dey
  bne @Row
  rts

S1Attr:
  lda #<ATTR
  ldx #>ATTR
  jsr SetWrite

  stz COL                           ; row 0: black on each of the fourteen inks
  ldx #40
@Row0:
  lda COL
  and #$0f
  tay
  lda Inks,y
  ora #$10
  sta VC_DATA
  inc COL
  dex
  bne @Row0

  stz COL                           ; row 1: each of the fourteen inks on black
  ldx #40
@Row1:
  lda COL
  and #$0f
  tay
  lda Inks,y
  asl
  asl
  asl
  asl
  ora #$01
  sta VC_DATA
  inc COL
  dex
  bne @Row1

  lda #2                            ; rows 2-23: a diagonal wash over the charset
  sta ROW
@Row:
  stz COL
  ldx #40
@Col:
  lda ROW
  clc
  adc COL
  and #$0f
  tay
  lda Inks,y
  asl
  asl
  asl
  asl
  ora #$01
  sta VC_DATA
  inc COL
  dex
  bne @Col
  inc ROW
  lda ROW
  cmp #24
  bne @Row
  rts

; =============================================================================
;   Screen 2 — Compact, 2bpp, sub-palettes and flipping
; =============================================================================
;   32 x 24 of 8 x 8, the grid a Graphics I program lands in — run here at four
;   colours a cell. The attribute byte's b3:0 is a sub-palette rather than a
;   colour pair now, and §8's mapping makes it `(L0PAL & 3) x 64 + subpal x 4 +
;   value`: sixteen groups of four, a quarter of the palette at a time. b4 and
;   b5 mirror the cell, which is what the alternating tiles here show.

Screen2Compact:
  jsr BlankDisplay
  jsr S2Patterns
  jsr S2Name
  jsr S2Attr

  lda #VMODE_COMPACT
  ldx #R_VMODE
  jsr SetReg
  lda #CTRL_2BPP_CELL
  ldx #R_L0CTRL
  jsr SetReg
  lda #$00                          ; the first quarter of the palette
  ldx #R_L0PAL
  jsr SetReg
  lda #$01                          ; backdrop black, behind the border
  ldx #R_COLOR
  jsr SetReg
  jmp ShowAndHold

S2Patterns:
  lda #<PATTERN
  ldx #>PATTERN
  jsr SetWrite
  ldx #0
@Copy:
  lda Tiles2bpp,x
  sta VC_DATA
  inx
  cpx #(4 * 16)                     ; four tiles, sixteen bytes each
  bne @Copy
  rts

S2Name:
  lda #<NAME
  ldx #>NAME
  jsr SetWrite
  stz ROW
@Row:
  stz COL
@Col:
  lda ROW                           ; a frame of tile 3 around the edge
  beq @Edge
  cmp #23
  beq @Edge
  lda COL
  beq @Edge
  cmp #31
  beq @Edge
  lda ROW                           ; and ramp / checker alternating inside it
  clc
  adc COL
  and #$01
  inc a
  bra @Put
@Edge:
  lda #3
@Put:
  sta VC_DATA
  inc COL
  lda COL
  cmp #32
  bne @Col
  inc ROW
  lda ROW
  cmp #24
  bne @Row
  rts

S2Attr:
  lda #<ATTR
  ldx #>ATTR
  jsr SetWrite
  stz ROW
@Row:
  stz COL
@Col:
  lda ROW                           ; sub-palette walks diagonally, 0-15
  clc
  adc COL
  and #$0f
  sta TMP
  lda COL                           ; b4: mirror every other pair of columns
  and #$02
  beq @NoFlipX
  lda TMP
  ora #$10
  sta TMP
@NoFlipX:
  lda ROW                           ; b5: and every other pair of rows
  and #$02
  beq @NoFlipY
  lda TMP
  ora #$20
  sta TMP
@NoFlipY:
  lda TMP
  sta VC_DATA
  inc COL
  lda COL
  cmp #32
  bne @Col
  inc ROW
  lda ROW
  cmp #24
  bne @Row
  rts

; =============================================================================
;   Screen 3 — Graphics, 4bpp, sixteen colours a cell and the ninth pattern bit
; =============================================================================
;   32 x 30 of 8 x 8 — the full height, side borders only, and the mode §9 says
;   most new software should reach for. At 4bpp the sixteen sub-palettes already
;   cover the whole palette, so `L0PAL` has nothing left to say and every one of
;   the 256 colours is on screen at once: tile 0 is a sixteen-step ramp and the
;   attribute byte gives each row a different sub-palette.
;
;   Every eighth cell sets the attribute's b7, the ninth pattern-index bit, and
;   so draws pattern $100 — a tile past the 256 a name byte can name.

Screen3Graphics:
  jsr BlankDisplay
  jsr S3Patterns
  jsr S3Name
  jsr S3Attr

  lda #VMODE_GRAPHICS
  ldx #R_VMODE
  jsr SetReg
  lda #CTRL_4BPP_CELL
  ldx #R_L0CTRL
  jsr SetReg
  lda #$00
  ldx #R_L0PAL
  jsr SetReg
  lda #$01
  ldx #R_COLOR
  jsr SetReg
  jmp ShowAndHold

S3Patterns:
  lda #<PATTERN                     ; tiles 0 and 1, at the base
  ldx #>PATTERN
  jsr SetWrite
  ldx #0
@Copy:
  lda Tiles4bpp,x
  sta VC_DATA
  inx
  cpx #(2 * 32)                     ; two tiles, thirty-two bytes each
  bne @Copy

  lda #<PATTERN_HIGH                ; tile $100, which only b7 can reach
  ldx #>PATTERN_HIGH
  jsr SetWrite
  ldx #0
@High:
  lda Tile4bppHigh,x
  sta VC_DATA
  inx
  cpx #32
  bne @High
  rts

S3Name:
  lda #<NAME
  ldx #>NAME
  jsr SetWrite
  stz ROW
@Row:
  stz COL
@Col:
  lda COL                           ; a wedge every fourth column, ramp elsewhere
  and #$03
  cmp #$03
  bne @Ramp
  lda #1
  bra @Put
@Ramp:
  lda #0
@Put:
  sta VC_DATA
  inc COL
  lda COL
  cmp #32
  bne @Col
  inc ROW
  lda ROW
  cmp #30
  bne @Row
  rts

S3Attr:
  lda #<ATTR
  ldx #>ATTR
  jsr SetWrite
  stz ROW
@Row:
  stz COL
@Col:
  lda ROW                           ; one sub-palette per row: all 256 colours
  and #$0f
  sta TMP
  lda ROW                           ; b4: the wedges zigzag down alternate rows
  and #$01
  beq @NoFlipX
  lda TMP
  ora #$10
  sta TMP
@NoFlipX:
  lda COL                           ; b5: and stand on their heads every fourth
  and #$04
  beq @NoFlipY
  lda TMP
  ora #$20
  sta TMP
@NoFlipY:
  lda ROW                           ; b7: every eighth cell both ways draws $100
  and #$07
  bne @NoHigh
  lda COL
  and #$07
  bne @NoHigh
  lda TMP
  ora #$80
  sta TMP
@NoHigh:
  lda TMP
  sta VC_DATA
  inc COL
  lda COL
  cmp #32
  bne @Col
  inc ROW
  lda ROW
  cmp #30
  bne @Row
  rts

; =============================================================================
;   Screen 4 — Full, 8bpp, no attribute table at all
; =============================================================================
;   40 x 30 of 8 x 8 filling the whole 320 x 240 frame, edge to edge, with no
;   border for the backdrop to show in. At 8bpp with the attribute source set to
;   "none" there is no fetch and no sub-palette: §8's mapping leaves nothing of
;   the group and the pattern byte *is* the palette index, which is what makes
;   this the cheapest mode to render and the most expensive to fill.
;
;   The sixteen tiles are built here rather than carried in ROM — tile R holds
;   the sixteen entries of palette row R, eight along its top half and eight
;   along its bottom — so the screen is the whole palette, laid out diagonally.

Screen4Full:
  jsr BlankDisplay
  jsr S4Patterns
  jsr S4Name

  lda #VMODE_FULL
  ldx #R_VMODE
  jsr SetReg
  lda #CTRL_8BPP_NONE
  ldx #R_L0CTRL
  jsr SetReg
  lda #$00
  ldx #R_L0PAL
  jsr SetReg
  lda #$01
  ldx #R_COLOR
  jsr SetReg
  jmp ShowAndHold

; Sixteen tiles of 64 bytes: tile R, pixel (x, y) = R * 16 + (y & 4 ? 8 : 0) + x.
S4Patterns:
  lda #<PATTERN
  ldx #>PATTERN
  jsr SetWrite
  stz TMP                           ; TMP = the tile, 0-15
@Tile:
  stz ROW
@Row:
  stz COL
@Col:
  lda TMP                           ; R * 16 — the row of the palette
  asl
  asl
  asl
  asl
  sta TMP2
  lda ROW                           ; the bottom half holds the second eight
  and #$04
  beq @Top
  lda TMP2
  ora #$08
  sta TMP2
@Top:
  lda TMP2
  ora COL
  sta VC_DATA
  inc COL
  lda COL
  cmp #8
  bne @Col
  inc ROW
  lda ROW
  cmp #8
  bne @Row
  inc TMP
  lda TMP
  cmp #16
  bne @Tile
  rts

S4Name:
  lda #<NAME
  ldx #>NAME
  jsr SetWrite
  stz ROW
@Row:
  stz COL
@Col:
  lda ROW
  clc
  adc COL
  and #$0f
  sta VC_DATA
  inc COL
  lda COL
  cmp #40
  bne @Col
  inc ROW
  lda ROW
  cmp #30
  bne @Row
  rts

; =============================================================================
;   Data
; =============================================================================

; Two 40-column title lines, written straight into the name table as CP437.
Title0:
  .byte "   6502-PICOVDP   VMODE $1: TEXT MODE   "
Title0End:
Title1:
  .byte "  40 x 24 of 6 x 8, a colour per cell   "
Title1End:

.assert (Title0End - Title0) = 40, error, "title line 0 is not 40 columns"
.assert (Title1End - Title1) = 40, error, "title line 1 is not 40 columns"

; Sixteen entries of palette row 0, with 0 and 1 left out and the first two
; repeated at the end to fill the table. Both of those render black — index 0 is
; the TMS9918's transparent colour, drawn as itself because `L0CTRL` b5 is set
; here — and a cell coloured black on black is a cell that shows nothing, which
; is not what this screen is for.
Inks:
  .byte $2,$3,$4,$5,$6,$7,$8,$9,$a,$b,$c,$d,$e,$f,$2,$3

; --- 2bpp: two bytes a row, four pixels a byte, the leftmost pair in b7:6 ----
Tiles2bpp:
  ; 0 — flat, value 0
  .byte $00,$00, $00,$00, $00,$00, $00,$00
  .byte $00,$00, $00,$00, $00,$00, $00,$00
  ; 1 — a ramp across all four values: 0 0 1 1 2 2 3 3
  .byte $05,$af, $05,$af, $05,$af, $05,$af
  .byte $05,$af, $05,$af, $05,$af, $05,$af
  ; 2 — a checker of values 1 and 2
  .byte $66,$66, $99,$99, $66,$66, $99,$99
  .byte $66,$66, $99,$99, $66,$66, $99,$99
  ; 3 — a frame of value 3 around a field of value 1
  .byte $ff,$ff, $d5,$57, $d5,$57, $d5,$57
  .byte $d5,$57, $d5,$57, $d5,$57, $ff,$ff

; --- 4bpp: four bytes a row, two pixels a byte, the left one in b7:4 ---------
Tiles4bpp:
  ; 0 — every one of the sixteen values, 0-7 across the top, 8-15 across the
  ;     bottom, so one cell shows a whole sub-palette
  .byte $01,$23,$45,$67
  .byte $01,$23,$45,$67
  .byte $01,$23,$45,$67
  .byte $01,$23,$45,$67
  .byte $89,$ab,$cd,$ef
  .byte $89,$ab,$cd,$ef
  .byte $89,$ab,$cd,$ef
  .byte $89,$ab,$cd,$ef
  ; 1 — a wedge, asymmetric both ways so a flip is visible as a flip
  .byte $f0,$00,$00,$00
  .byte $ff,$00,$00,$00
  .byte $ff,$f0,$00,$00
  .byte $ff,$ff,$00,$00
  .byte $ff,$ff,$f0,$00
  .byte $ff,$ff,$ff,$00
  .byte $ff,$ff,$ff,$f0
  .byte $ff,$ff,$ff,$ff

; Pattern $100 — a cross, reached only through the attribute byte's b7.
Tile4bppHigh:
  .byte $f1,$11,$11,$1f
  .byte $1f,$11,$11,$f1
  .byte $11,$f1,$1f,$11
  .byte $11,$1f,$f1,$11
  .byte $11,$1f,$f1,$11
  .byte $11,$f1,$1f,$11
  .byte $1f,$11,$11,$f1
  .byte $f1,$11,$11,$1f

; =============================================================================
;   CPU vectors — a cartridge owns $FFFA-$FFFF
; =============================================================================
;   Interrupts are never enabled here, so the two trampolines exist only so that
;   a stray BRK lands somewhere defined rather than in whatever the fill byte
;   decodes as.

IrqTrampoline:
  rti

NmiTrampoline:
  rti

.segment "VECTORS"

  .word NmiTrampoline
  .word CartReset
  .word IrqTrampoline
