.setcpu "65C02"

; =============================================================================
;   VDP Layers — two layers, six priority levels and hardware scrolling
; =============================================================================
;   An AC6502 cartridge for the 6502-PICOVDP's second layer (`docs/VDP-SPEC.md`
;   §12 and §13), driven from 6502 code through the real port pair rather than
;   by a test poking registers.
;
;   Full mode, 40 x 30 of 8 x 8, edge to edge across the whole 320 x 240 frame,
;   both layers 4bpp with a colour byte per cell:
;
;     Layer 0   sky above, brick below, and a grey post every fifth column with
;               the attribute byte's b6 set — §12 level 4, which is in front of
;               an ordinary sprite. Index 0 opaque, so it covers the backdrop.
;               Scrolls left one pixel a frame, and up one pixel every eighth.
;
;     Layer 1   tree trunks over the lower rows, and across the top a band that
;               alternates two cells of banner — b6 set, §12 level 6 — with two
;               of awning, b6 clear and so level 3. Index 0 transparent, so the
;               trunks' edges and every empty cell show layer 0 through them.
;               Scrolls two pixels a frame, twice layer 0, which is parallax.
;
;     Sprites   four, magnified to 16 x 16, standing still while the scenery
;               moves past them. Two down among the trunks and two up at the
;               band, and in each pair one has b6 set and one does not:
;
;                 slot 0  (60, 176)  b6 clear — level 2: behind trunks and posts
;                 slot 1  (100, 176) b6 set   — level 5: in front of both
;                 slot 2  (160, 20)  b6 set   — level 5: in front of the awning,
;                                               behind the banner
;                 slot 3  (200, 20)  b6 clear — level 2: behind both
;
;   Between them the four sprites show every one of §12's six levels resolving
;   against a neighbour, and they show it moving: a sprite is occluded and
;   revealed as a post scrolls across it, which no static picture proves. Slot 2
;   is the one that separates 5 from 6 — the same sprite, in front of half the
;   band it crosses and behind the other half.
;
;   Full mode is the one that needs §13's ninth horizontal scroll bit. 320
;   pixels do not fit in `LxSCRX`, so bit 8 lives in `LxCTRL` b6 and the frame
;   loop writes the control register every time the scroll passes 255 — which
;   is why the demo is in this mode and not in the cheaper Graphics one.
;
;   Nothing waits on input: a headless machine with no keyboard attached runs
;   the whole thing from a cold reset, which is what makes it usable as a golden
;   fixture (PLAN.md §3). Interrupts stay disabled throughout — this program
;   polls `STAT0` b7 for the vertical blank, and a handler that read the status
;   register would take the flag out from under it.
; =============================================================================

.segment "CART"

; =============================================================================
;   The machine
; =============================================================================

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
R_L0SCRX            = $13
R_L0SCRY            = $14
R_L0CTRL            = $15
R_L0PAL             = $16
R_L1NAME            = $18
R_L1ATTR            = $19
R_L1PAT             = $1A
R_L1SCRX            = $1B
R_L1SCRY            = $1C
R_L1CTRL            = $1D
R_L1PAL             = $1E
R_SPRATTR           = $20
R_SPRPAT            = $21
R_SPRCOUNT          = $22
R_SPRCTRL           = $23
R_SPRPAL            = $25

; `MODE1`: b6 display enable, b5 vblank IRQ enable, b0 sprite magnification.
DISP_OFF            = $01
DISP_ON             = $41

VMODE_FULL          = $04        ; §9: 40 x 30 of 8 x 8, the whole frame

; `SPRCTRL` (§5): enabled, collision on, $D0 terminator, 4bpp — the reset value.
SPR_ON              = $27

; `LxCTRL` (§8, §13): b1:0 depth, b3:2 attribute source, b4 enable,
; b5 index 0 opaque, b6 horizontal scroll bit 8.
;   $32 = 4bpp, per cell, enabled, index 0 opaque    — the background
;   $12 = 4bpp, per cell, enabled, index 0 clear     — the overlay
CTRL_L0             = $32
CTRL_L1             = $12
CTRL_SCRX_BIT8      = $40

; =============================================================================
;   VRAM layout
; =============================================================================
;   Full mode's name and attribute tables are 1200 bytes, so each spans two of
;   §5's 1 KB blocks — contiguous from its base like every other geometry's.
;   Everything is below $4000, so `VBANK` stays 0 and a pointer is the fourteen
;   bits the command protocol carries.

L0_NAME             = $0000      ; 1200 bytes
L0_ATTR             = $0800      ; 1200 bytes
L1_NAME             = $1000      ; 1200 bytes
L1_ATTR             = $1800      ; 1200 bytes
PATTERNS            = $2000      ; shared by both layers, 4bpp: 32 bytes a tile
SPR_PATTERNS        = $2800
SPR_ATTR            = $3000

L0NAME_VAL          = $00        ; L0_NAME / $400
L0ATTR_VAL          = $02        ; L0_ATTR / $400
L1NAME_VAL          = $04        ; L1_NAME / $400
L1ATTR_VAL          = $06        ; L1_ATTR / $400
LXPAT_VAL           = $04        ; PATTERNS / $800
SPRPAT_VAL          = $05        ; SPR_PATTERNS / $800
SPRATTR_VAL         = $60        ; SPR_ATTR / $80

; =============================================================================
;   The map
; =============================================================================

COLS                = 40
ROWS                = 30
MAP_WIDTH           = 320        ; §13: the map is the same size as the screen
MAP_HEIGHT          = 240

GROUND_ROW          = 18         ; first row of brick
POST_EVERY          = 5          ; a priority post every fifth column
TRUNK_ROW           = 20         ; first row of tree trunks
TRUNK_EVERY         = 6
BANNER_ROW          = 2          ; the banner occupies rows 2 and 3
BANNER_ROWS         = 2
BANNER_EVERY        = 8
BANNER_RUN          = 2          ; two cells of banner, two of awning, four of sky
AWNING_RUN          = 4          ; ... the awning runs from BANNER_RUN to here

; Tiles, as indices into the shared pattern table.
TILE_BLANK          = 0
TILE_SKY            = 1
TILE_POST           = 2
TILE_BRICK          = 3
TILE_TRUNK          = 4
TILE_BANNER         = 5
TILE_AWNING         = 6
TILE_COUNT          = 7

; Attribute bytes (§8): b3:0 sub-palette, b6 priority. At 4bpp the palette index
; of a pixel is `subpal x 16 + value`, so a sub-palette is a palette row (§11).
ATTR_PRIORITY       = $40
ATTR_GROUND         = $0E        ; row 14 — the brown row
ATTR_POST           = $01 | ATTR_PRIORITY
ATTR_TRUNK          = $04
ATTR_BANNER         = $09 | ATTR_PRIORITY
ATTR_AWNING         = $0C        ; b6 clear: an ordinary layer 1 cell, level 3

; =============================================================================
;   Zero page — $3A upward is the user range the BIOS leaves alone
; =============================================================================

PTR                 = $3A        ; 2 bytes
ROW                 = $3C
COL                 = $3D
TMP                 = $3E        ; the "every Nth column" counter
SCR0X               = $40        ; 2 bytes — layer 0 horizontal scroll, 0-319
SCR1X               = $42        ; 2 bytes — layer 1, likewise
SCR0Y               = $44
FRAME               = $45

; =============================================================================
;   ADD_SCROLL_X — advance a 9-bit scroll, wrapping at the map width (§13)
; =============================================================================

.macro ADD_SCROLL_X slot, amount
  clc
  lda slot
  adc #amount
  sta slot
  lda slot + 1
  adc #0
  sta slot + 1
  cmp #>MAP_WIDTH                   ; below 256? then below 320
  bcc :+
  lda slot
  cmp #<MAP_WIDTH
  bcc :+
  sec                               ; past the right-hand edge: come round
  lda slot
  sbc #<MAP_WIDTH
  sta slot
  lda slot + 1
  sbc #>MAP_WIDTH
  sta slot + 1
:
.endmacro

; =============================================================================
;   CartReset — the cartridge entry point
; =============================================================================

CartReset:
  ldx #$ff
  txs                               ; KernalInit does not reset the stack
  jsr KernalInit                    ; probe the I/O cards; leaves IRQs disabled

  ; No CLI. See the header: the vertical-blank poll below owns STAT0, and the
  ; Kernal's IRQ handler reading it would clear the flag before this does.

  jsr SetupVdp
  jsr LoadPatterns
  jsr LoadSpritePattern
  jsr BuildLayer0
  jsr BuildLayer1
  jsr BuildSprites

  stz SCR0X
  stz SCR0X + 1
  stz SCR1X
  stz SCR1X + 1
  stz SCR0Y
  stz FRAME

  lda #DISP_ON
  ldx #R_MODE1
  jsr SetReg

Main:
  jsr WaitVBlank
  jsr Advance
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

; =============================================================================
;   SetupVdp — every register the picture needs, with the display off
; =============================================================================

SetupVdp:
  lda #DISP_OFF
  ldx #R_MODE1
  jsr SetReg
  lda #$00                          ; VRAM A15:A14 — everything is in bank 0
  ldx #R_VBANK
  jsr SetReg
  lda #$01                          ; +1 per access, the classic stride
  ldx #R_VINC
  jsr SetReg
  lda #$00                          ; M3 clear; VMODE takes over from here
  ldx #R_MODE0
  jsr SetReg
  lda #VMODE_FULL
  ldx #R_VMODE
  jsr SetReg
  lda #$00                          ; backdrop black — Full mode has no border,
  ldx #R_COLOR                      ; so this shows only through layer 1
  jsr SetReg

  lda #L0NAME_VAL
  ldx #R_L0NAME
  jsr SetReg
  lda #L0ATTR_VAL
  ldx #R_L0ATTR
  jsr SetReg
  lda #LXPAT_VAL                    ; both layers draw from one pattern table
  ldx #R_L0PAT
  jsr SetReg
  lda #CTRL_L0
  ldx #R_L0CTRL
  jsr SetReg
  lda #$00
  ldx #R_L0PAL
  jsr SetReg

  lda #L1NAME_VAL
  ldx #R_L1NAME
  jsr SetReg
  lda #L1ATTR_VAL
  ldx #R_L1ATTR
  jsr SetReg
  lda #LXPAT_VAL
  ldx #R_L1PAT
  jsr SetReg
  lda #CTRL_L1
  ldx #R_L1CTRL
  jsr SetReg
  lda #$00
  ldx #R_L1PAL
  jsr SetReg

  lda #SPRATTR_VAL
  ldx #R_SPRATTR
  jsr SetReg
  lda #SPRPAT_VAL
  ldx #R_SPRPAT
  jsr SetReg
  lda #4                            ; four slots evaluated
  ldx #R_SPRCOUNT
  jsr SetReg
  lda #$00
  ldx #R_SPRPAL
  jsr SetReg
  lda #SPR_ON
  ldx #R_SPRCTRL
  jmp SetReg

; =============================================================================
;   Advance — one frame of scrolling (§13)
; =============================================================================
;   Six register writes. The Kernal's `VideoScroll` moves 920 bytes through a
;   RAM buffer to do less than this; §13's point is that scrolling costs nothing
;   per frame, and this is what nothing looks like.

Advance:
  ADD_SCROLL_X SCR0X, 1             ; background: one pixel a frame
  ADD_SCROLL_X SCR1X, 2             ; foreground: two — parallax

  inc FRAME                         ; the vertical drift, one pixel in eight
  lda FRAME
  and #$07
  bne @noVertical
  inc SCR0Y
  lda SCR0Y
  cmp #<MAP_HEIGHT                  ; §13: Y wraps at the map height, 240 here
  bcc @noVertical
  stz SCR0Y
@noVertical:

  lda SCR0X                         ; bits 7:0 of layer 0's scroll
  ldx #R_L0SCRX
  jsr SetReg
  lda #CTRL_L0                      ; and bit 8, which lives in `LxCTRL` b6
  ldx SCR0X + 1
  beq @l0Written
  lda #CTRL_L0 | CTRL_SCRX_BIT8
@l0Written:
  ldx #R_L0CTRL
  jsr SetReg
  lda SCR0Y
  ldx #R_L0SCRY
  jsr SetReg

  lda SCR1X
  ldx #R_L1SCRX
  jsr SetReg
  lda #CTRL_L1
  ldx SCR1X + 1
  beq @l1Written
  lda #CTRL_L1 | CTRL_SCRX_BIT8
@l1Written:
  ldx #R_L1CTRL
  jmp SetReg

; =============================================================================
;   LoadPatterns — six 4bpp tiles, 32 bytes each (§8)
; =============================================================================

LoadPatterns:
  lda #<PATTERNS
  ldx #>PATTERNS
  jsr SetWrite
  ldx #0
@Byte:
  lda PatternData,x
  sta VC_DATA
  inx
  cpx #(TILE_COUNT * 32)
  bne @Byte
  rts

LoadSpritePattern:
  lda #<SPR_PATTERNS
  ldx #>SPR_PATTERNS
  jsr SetWrite
  ldx #0
@Byte:
  lda SpriteData,x
  sta VC_DATA
  inx
  cpx #32
  bne @Byte
  rts

; =============================================================================
;   BuildLayer0 — sky, brick, and a priority post every fifth column
; =============================================================================

BuildLayer0:
  lda #<L0_NAME
  ldx #>L0_NAME
  jsr SetWrite
  stz ROW
@NameRow:
  stz COL
  stz TMP
@NameCol:
  lda ROW
  cmp #GROUND_ROW
  bcc @Sky
  lda TMP                           ; on the ground: every fifth column a post
  bne @Brick
  lda #TILE_POST
  bra @NameEmit
@Brick:
  lda #TILE_BRICK
  bra @NameEmit
@Sky:
  lda #TILE_SKY
@NameEmit:
  sta VC_DATA
  jsr StepColumn
  ldx #POST_EVERY
  jsr WrapCounter
  lda COL
  cmp #COLS
  bne @NameCol
  inc ROW
  lda ROW
  cmp #ROWS
  bne @NameRow

  lda #<L0_ATTR
  ldx #>L0_ATTR
  jsr SetWrite
  stz ROW
@AttrRow:
  stz COL
  stz TMP
@AttrCol:
  lda ROW
  cmp #GROUND_ROW
  bcc @SkyAttr
  lda TMP
  bne @BrickAttr
  lda #ATTR_POST                    ; b6: §12 level 4, in front of a sprite
  bra @AttrEmit
@BrickAttr:
  lda #ATTR_GROUND
  bra @AttrEmit
@SkyAttr:
  lda ROW                           ; a band of sky per four rows, 0-4
  lsr
  lsr
@AttrEmit:
  sta VC_DATA
  jsr StepColumn
  ldx #POST_EVERY
  jsr WrapCounter
  lda COL
  cmp #COLS
  bne @AttrCol
  inc ROW
  lda ROW
  cmp #ROWS
  bne @AttrRow
  rts

; =============================================================================
;   BuildLayer1 — trunks below, a priority banner above, transparent between
; =============================================================================

BuildLayer1:
  lda #<L1_NAME
  ldx #>L1_NAME
  jsr SetWrite
  stz ROW
@NameRow:
  stz COL
  stz TMP
@NameCol:
  jsr Layer1Cell                    ; A = tile, and TMP is this column's phase
  sta VC_DATA
  jsr StepColumn
  ldx #TRUNK_EVERY * BANNER_EVERY / 2
  jsr WrapCounter                   ; 24 = lcm(6, 8): one counter for both bands
  lda COL
  cmp #COLS
  bne @NameCol
  inc ROW
  lda ROW
  cmp #ROWS
  bne @NameRow

  lda #<L1_ATTR
  ldx #>L1_ATTR
  jsr SetWrite
  stz ROW
@AttrRow:
  stz COL
  stz TMP
@AttrCol:
  jsr Layer1Cell
  cmp #TILE_TRUNK
  bne @NotTrunk
  lda #ATTR_TRUNK
  bra @AttrEmit
@NotTrunk:
  cmp #TILE_BANNER
  bne @NotBanner
  lda #ATTR_BANNER                  ; b6: §12 level 6, in front of everything
  bra @AttrEmit
@NotBanner:
  cmp #TILE_AWNING
  bne @Blank
  lda #ATTR_AWNING                  ; no b6: §12 level 3, under a priority sprite
  bra @AttrEmit
@Blank:
  lda #$00
@AttrEmit:
  sta VC_DATA
  jsr StepColumn
  ldx #TRUNK_EVERY * BANNER_EVERY / 2
  jsr WrapCounter
  lda COL
  cmp #COLS
  bne @AttrCol
  inc ROW
  lda ROW
  cmp #ROWS
  bne @AttrRow
  rts

; Which tile layer 1 puts at (ROW, COL), from TMP — the column's phase in 24.
Layer1Cell:
  lda ROW
  cmp #BANNER_ROW
  bcc @Empty
  cmp #(BANNER_ROW + BANNER_ROWS)
  bcs @Lower
  lda TMP                           ; two of banner, two of awning, four of sky
  and #(BANNER_EVERY - 1)
  cmp #BANNER_RUN
  bcc @Banner
  cmp #AWNING_RUN
  bcs @Empty
  lda #TILE_AWNING
  rts
@Banner:
  lda #TILE_BANNER
  rts
@Lower:
  lda ROW
  cmp #TRUNK_ROW
  bcc @Empty
  lda TMP                           ; a trunk every sixth column
  @DivSix:
  sec
  sbc #TRUNK_EVERY
  bcs @DivSix
  adc #TRUNK_EVERY                  ; the remainder, TMP mod 6
  bne @Empty
  lda #TILE_TRUNK
  rts
@Empty:
  lda #TILE_BLANK
  rts

; Shared by both builders: COL forward one, TMP forward one.
StepColumn:
  inc COL
  inc TMP
  rts

; TMP back to 0 when it reaches X.
WrapCounter:
  cpx TMP
  bne @Done
  stz TMP
@Done:
  rts

; =============================================================================
;   BuildSprites — four 16 x 16 sprites, two of them carrying b6 (§10, §12)
; =============================================================================

BuildSprites:
  lda #<SPR_ATTR
  ldx #>SPR_ATTR
  jsr SetWrite
  ldx #0
@Byte:
  lda SpriteAttrData,x
  sta VC_DATA
  inx
  cpx #(5 * 4)                      ; four slots and the $D0 terminator
  bne @Byte
  rts

; =============================================================================
;   Data
; =============================================================================

; Six 4bpp tiles. A row is four bytes, two pixels a byte, most significant
; nibble leftmost (§8); a tile is eight of those rows.
PatternData:
  ; 0 — blank. Transparent on layer 1; palette entry `subpal x 16` on layer 0,
  ;     which is opaque, so this is the mortar between the bricks.
  .repeat 8
  .byte $00, $00, $00, $00
  .endrepeat
  ; 1 — sky: a solid field of value 8
  .repeat 8
  .byte $88, $88, $88, $88
  .endrepeat
  ; 2 — post: solid value 13, and the cell that carries the priority bit
  .repeat 8
  .byte $DD, $DD, $DD, $DD
  .endrepeat
  ; 3 — brick: four rows of value 6, four of value 3
  .repeat 4
  .byte $66, $66, $66, $66
  .endrepeat
  .repeat 4
  .byte $33, $33, $33, $33
  .endrepeat
  ; 4 — trunk: value 11 through the middle four pixels, transparent either side
  .repeat 8
  .byte $00, $BB, $BB, $00
  .endrepeat
  ; 5 — banner: solid value 15, and the layer 1 cell that carries b6
  .repeat 8
  .byte $FF, $FF, $FF, $FF
  .endrepeat
  ; 6 — awning: solid value 10, the same band without the priority bit
  .repeat 8
  .byte $AA, $AA, $AA, $AA
  .endrepeat

; One 4bpp 8 x 8 sprite: a filled diamond of value 7, zero — and so transparent
; at every depth (§10) — around it.
SpriteData:
  .byte $00, $07, $70, $00
  .byte $00, $77, $77, $00
  .byte $07, $77, $77, $70
  .byte $77, $77, $77, $77
  .byte $77, $77, $77, $77
  .byte $07, $77, $77, $70
  .byte $00, $77, $77, $00
  .byte $00, $07, $70, $00

; Four slots of four bytes — Y, X, pattern, attributes — then the terminator.
; §10: Y is the sprite's top edge as a display line, and b6 of the attribute
; byte is §12's priority against the layers.
SpriteAttrData:
  .byte 176,  60, 0, $0A            ; among the trunks, ordinary
  .byte 176, 100, 0, $0A | $40      ; among the trunks, in front of them
  .byte  20, 160, 0, $0A | $40      ; over the awning, under the banner: 3 < 5 < 6
  .byte  20, 200, 0, $0A            ; under both — level 2 loses to either
  .byte $D0, $00, 0, $00            ; §10: $D0 ends the list

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
