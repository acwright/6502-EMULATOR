.setcpu "65C02"

; =============================================================================
;   Flash Cart — banking, and a cartridge that writes to itself
; =============================================================================
;   A 131,072-byte AC6502 Flash Cart (SST39SF010A) that draws two screens and
;   then stops. It is the golden fixture for everything the 32K cart cannot
;   reach, which is to say for 6502-VCS `PLAN.md` §§2-3.
;
;     1s   three-banks      three lines of text, each read out of a different
;                           8 KB bank through the $C000-$DFFF window
;     --   self-programmed  a byte programmed into the save bank by a JEDEC
;                           sequence, and read back
;
;   Two things about it are not incidental, and both are the reason it is a
;   golden rather than a unit test.
;
;   **Every line of code is in FIXED.** $E000-$FFFF is the primary chip's last
;   8 KB whatever the bank register holds, and a `jsr` out of a bank returns to
;   an address whose meaning has changed underneath it. The banks hold data and
;   nothing else.
;
;   **The programming routine is copied into RAM and run there.** While the
;   chip is programming it answers every read with status, including the
;   instruction fetches in the fixed region — so a routine that polled from
;   flash would be executing a status register. `DESIGN.md` requires RAM for
;   exactly this, and the emulator models the busy window so that a cart which
;   got it wrong hangs here as it would on the board.
;
;   Interrupts stay off throughout. A busy chip would answer the vector fetch
;   too, and this program has nothing to interrupt.
; =============================================================================

; =============================================================================
;   The machine
; =============================================================================

VC_DATA             := $9C00     ; R/W — VRAM data, auto-incrementing (§4)
VC_REG              := $9C01     ; W   — command port, port A
VC_STATUS           := $9C01     ; R   — status port, port A

; =============================================================================
;   The mapper (6502-VCS PLAN.md §2)
; =============================================================================
;   The bank register is write-only at ANY address in $E000-$FFFF; $E000 is the
;   convention 6502-CRT's template uses. A write there latches the register and
;   reaches no flash, which is why this program can store to an address inside
;   its own code without disturbing a byte of it.
;
;   RESB clears the register to 0, so a cart wakes up on bank 0 and does not
;   have to assume it.

BANK                = $E000
WINDOW              = $C000      ; $C000-$DFFF: whichever bank is selected

; The JEDEC unlock addresses of §3 are in flash space, and the window is what
; puts them there: flash $5555 is bank 2's $1555, flash $2AAA is bank 1's
; $0AAA. Writing to CPU $D555 with bank 2 selected is therefore flash $5555.
UNLOCK_BANK_1       = $02
UNLOCK_ADDR_1       = $D555      ; -> flash $5555
UNLOCK_BANK_2       = $01
UNLOCK_ADDR_2       = $CAAA      ; -> flash $2AAA

CMD_UNLOCK_1        = $AA
CMD_UNLOCK_2        = $55
CMD_PROGRAM         = $A0

; Where the 6502-CRT template tells a cartridge to keep its saves: the highest
; usable bank, which on a 128K part is $0E and flash sector 28.
SAVE_BANK           = $0E
SAVE_VALUE          = $5A        ; $FF & $5A is $5A — a program only clears bits

; The three banks the first screen reads its text out of.
TEXT_BANK_0         = $00
TEXT_BANK_1         = $01
TEXT_BANK_2         = $02

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

DISP_OFF            = $00
DISP_ON             = $40
SPR_OFF             = $26        ; `SPRCTRL` b0 clear: sprites off

VMODE_TEXT          = $01        ; 40 x 24 cells of 6 x 8 (§9)
CTRL_1BPP_CELL      = $30        ; 1bpp, a colour byte per cell, enabled

; =============================================================================
;   VRAM layout
; =============================================================================
;   Under $0800, so the 2 KB the card's own reset puts there (§7) is left to
;   the font. Nothing here uploads a character set.

NAME                = $0000      ; name table      — 960 bytes
ATTR                = $0400      ; attribute table — 960 bytes, one per cell

L0NAME_VAL          = $00        ; NAME / $400
L0ATTR_VAL          = $01        ; ATTR / $400
L0PAT_VAL           = $01        ; $0800, where reset put the font

COLS                = 40
ROWS                = 24

; =============================================================================
;   Zero page and RAM
; =============================================================================
;   6502.inc marks the low zero page free for a program that has taken the
;   machine over, and a cartridge is by definition such a program.

PTR                 = $40        ; 2 bytes — the row being drawn
ADDR                = $42        ; 2 bytes — a VRAM address
TMP                 = $44        ; 2 bytes
ROW                 = $46
BEFORE              = $47        ; the save byte as the .crt left it
AFTER               = $48        ; and after the cartridge programmed it

; Where the programming routine is copied to. Anywhere in RAM will do; what
; matters is that it is not in the chip it is about to make busy.
PROG_RAM            = $0300

HOLD_FRAMES         = 60         ; one second at 60 Hz

.segment "FIXED"

; =============================================================================
;   CartReset — the cartridge entry point
; =============================================================================

CartReset:
  sei
  cld
  ldx #$ff
  txs

  jsr SetupVideo
  jsr ClearScreen
  jsr DrawAttributes

  ; --- Screen 1: three banks through one window ------------------------------
  lda #<Title
  ldx #>Title
  ldy #1
  jsr DrawRow

  lda #TEXT_BANK_0
  ldy #4
  jsr DrawBankRow
  lda #TEXT_BANK_1
  ldy #6
  jsr DrawBankRow
  lda #TEXT_BANK_2
  ldy #8
  jsr DrawBankRow

  lda #<FixedNote
  ldx #>FixedNote
  ldy #11
  jsr DrawRow

  jsr ShowAndHold

  ; --- Screen 2: the cartridge programs its own flash ------------------------
  ; Read the save byte as the image left it, before anything has written to it.
  lda #SAVE_BANK
  sta BANK
  lda WINDOW
  sta BEFORE

  jsr CopyProgrammer
  jsr PROG_RAM

  ; And read it back, which is the whole point: the byte came out of the chip,
  ; not out of a variable the routine kept.
  lda #SAVE_BANK
  sta BANK
  lda WINDOW
  sta AFTER

  lda #<SaveNote
  ldx #>SaveNote
  ldy #14
  jsr DrawRow
  lda #<SaveResult
  ldx #>SaveResult
  ldy #16
  jsr DrawRow

  ; The two byte values, into the dashes the template left for them.
  lda #<(16 * COLS + 10)
  ldx #>(16 * COLS + 10)
  jsr SetWrite
  lda BEFORE
  jsr WriteHex
  lda #<(16 * COLS + 23)
  ldx #>(16 * COLS + 23)
  jsr SetWrite
  lda AFTER
  jsr WriteHex

Forever:
  bra Forever

; =============================================================================
;   The programming routine, as it runs from RAM
; =============================================================================
;   Assembled for PROG_RAM and copied there. `.org` moves the labels without
;   moving the bytes, which still sit in FIXED where the copy reads them.
;
;   The unlock writes go to banks 2 and 1 because that is where the window puts
;   flash $5555 and $2AAA. The final write is to the save bank, and it is a
;   write to the *chip* rather than to the register because it is below $E000.
; =============================================================================

ProgrammerSrc:
  .org PROG_RAM

Programmer:
  lda #UNLOCK_BANK_1
  sta BANK
  lda #CMD_UNLOCK_1
  sta UNLOCK_ADDR_1
  lda #UNLOCK_BANK_2
  sta BANK
  lda #CMD_UNLOCK_2
  sta UNLOCK_ADDR_2
  lda #UNLOCK_BANK_1
  sta BANK
  lda #CMD_PROGRAM
  sta UNLOCK_ADDR_1

  lda #SAVE_BANK
  sta BANK
  lda #SAVE_VALUE
  sta WINDOW

  ; The data poll of §3. While the chip is busy every read of it returns status
  ; — DQ7 complemented, DQ6 toggling — so this cannot match until the 20 µs
  ; window closes and reads go back to being data.
@Poll:
  lda WINDOW
  cmp #SAVE_VALUE
  bne @Poll
  rts

ProgrammerEnd:
  .reloc

PROGRAMMER_LEN = ProgrammerEnd - Programmer

CopyProgrammer:
  ldx #PROGRAMMER_LEN - 1
@Byte:
  lda ProgrammerSrc,x
  sta PROG_RAM,x
  dex
  bpl @Byte
  rts

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

SetupVideo:
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
  lda #$00                          ; palette row 0
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
  lda #L0PAT_VAL
  ldx #R_L0PAT
  jmp SetReg

; =============================================================================
;   Drawing
; =============================================================================

; The whole name table to spaces: 960 cells, three and three-quarter pages.
ClearScreen:
  lda #<NAME
  ldx #>NAME
  jsr SetWrite
  lda #<(ROWS * COLS)
  sta TMP
  lda #>(ROWS * COLS)
  sta TMP+1
  lda #' '
@Cell:
  sta VC_DATA
  dec TMP
  bne @Cell
  dec TMP+1
  bpl @Cell
  rts

; The VRAM address of row Y, into ADDR. NAME is $0000, so this is row x 40 —
; x32 plus x8, which is two shifts apart and needs no multiply.
RowAddr:
  sty TMP
  stz TMP+1
  asl TMP
  rol TMP+1                         ; x2
  asl TMP
  rol TMP+1                         ; x4
  asl TMP
  rol TMP+1                         ; x8
  lda TMP
  sta ADDR
  lda TMP+1
  sta ADDR+1                        ; keep x8
  asl TMP
  rol TMP+1                         ; x16
  asl TMP
  rol TMP+1                         ; x32
  clc
  lda TMP
  adc ADDR
  sta ADDR
  lda TMP+1
  adc ADDR+1
  sta ADDR+1
  rts

; Draw the 40 bytes at A/X into row Y.
DrawRow:
  sta PTR
  stx PTR+1
  jsr RowAddr
  lda ADDR
  ldx ADDR+1
  jsr SetWrite
  ldy #0
@Cell:
  lda (PTR),y
  sta VC_DATA
  iny
  cpy #COLS
  bne @Cell
  rts

; Draw row Y out of bank A.
;
; The bank is selected and then read at $C000 — which is the whole demonstration:
; the same forty addresses hold three different strings, and this routine is
; three identical instructions away from drawing any of them. It runs from
; FIXED, so the code it is executing does not move when the window does.
DrawBankRow:
  sta BANK
  lda #<WINDOW
  ldx #>WINDOW
  jmp DrawRow

; A as two hex digits, straight into the VRAM pointer.
WriteHex:
  pha
  lsr a
  lsr a
  lsr a
  lsr a
  jsr HexDigit
  sta VC_DATA
  pla
  and #$0F
  jsr HexDigit
  sta VC_DATA
  rts

HexDigit:
  cmp #10
  bcc @Digit
  adc #'A' - 10 - 1                 ; carry is set, hence the extra -1
  rts
@Digit:
  adc #'0'
  rts

; One ink per row, so that every cell's colour byte is read rather than one
; value being written 960 times.
DrawAttributes:
  lda #<ATTR
  ldx #>ATTR
  jsr SetWrite
  stz ROW
@Row:
  ldy ROW
  lda Inks,y
  ldx #COLS
@Cell:
  sta VC_DATA
  dex
  bne @Cell
  inc ROW
  lda ROW
  cmp #ROWS
  bne @Row
  rts

; =============================================================================
;   Data — in FIXED, because it is read while the window is pointed elsewhere
; =============================================================================

; Foreground nibble on black (1), one per row: the title white on dark blue,
; the three bank rows in three different inks, the save rows in two more.
Inks:
  ;      0    1    2    3    4    5    6    7
  .byte $F1, $F4, $F1, $F1, $B1, $F1, $31, $F1
  ;      8    9   10   11   12   13   14   15
  .byte $71, $F1, $F1, $E1, $F1, $F1, $91, $F1
  ;     16   17   18   19   20   21   22   23
  .byte $D1, $F1, $F1, $F1, $F1, $F1, $F1, $F1

;            0123456789012345678901234567890123456789
Title:
  .byte "  FLASH CART 128K: BANKING AND A SAVE   "
FixedNote:
  .byte "  ...AND THIS CODE RUNS FROM $E000-$FFFF"
SaveNote:
  .byte "  PROGRAMMED BANK $0E, $C000, FROM RAM: "
SaveResult:
  .byte "  BEFORE $--    AFTER $--               "

; =============================================================================
;   The banks
; =============================================================================
;   Forty bytes each, at the same address, reached by writing one byte to
;   $E000. The bank number is in the text so that a golden frame showing the
;   wrong one is a wrong picture rather than a subtle one.

.segment "BANK00"
  .byte "  BANK $00 AT $C000: THE FIRST 8 KB     "

.segment "BANK01"
  .byte "  BANK $01 AT $C000: THE SECOND 8 KB    "

.segment "BANK02"
  .byte "  BANK $02 AT $C000: THE THIRD 8 KB     "

; =============================================================================
;   CPU vectors — in VECTORS, which is never bankable
; =============================================================================

IrqTrampoline:
  rti

NmiTrampoline:
  rti

.segment "VECTORS"

  .word NmiTrampoline
  .word CartReset
  .word IrqTrampoline
