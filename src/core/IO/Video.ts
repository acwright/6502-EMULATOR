import { IO } from '../IO'
import { CP437 } from './CP437'
import { expectKind, readBoolean, readBytes, readNumber, readStates, toBase64 } from '../DeviceState'
import type { DeviceState } from '../DeviceState'

/**
 * 6502-PICOVDP Video Display Processor.
 *
 * Specified in `docs/VDP-SPEC.md`, which the `§` references throughout this file
 * point at. It is a superset of the TMS9918A with a legacy submode: four ports,
 * 128 registers, 64 KB of VRAM, two tile layers at 1/2/4/8bpp, 64 sprites and a
 * 256-entry palette.
 *
 * **Mid-rewrite.** `PLAN.md` builds this card in phases, and what is here now is
 * the new bus, register file, VRAM, display timing, status registers, interrupt
 * sources, palette, tile engine and sprites. What is left is layer 1, and with it
 * §12's six-level priority resolution — the attribute byte's b6, on a tile or on
 * a sprite, is read by nobody yet — and the scroll registers; they arrive in
 * Phase 7. The goldens in `src/tests/goldens/` are what keeps the picture honest
 * in between.
 *
 * Ports (§4), decoded from A1:A0 and mirrored across `$9C00`-`$9FFF`:
 *   `$9C00` VC_DATA   / `$9C01` VC_REG   — VRAM data and command/status, port A
 *   `$9C02` VC_DATA2  / `$9C03` VC_REG2  — the same again, port B
 *
 * Geometries (§9), chosen by `VMODE`, which at reset hands the choice back to
 * the TMS9918's `M1`/`M2`/`M3` bits:
 *   Text      - 40x24 cells of 6x8, 240x192 at x 40, y 24
 *   Compact   - 32x24 cells of 8x8, 256x192 at x 32, y 24
 *   Graphics  - 32x30 cells of 8x8, 256x240 at x 32, y 0
 *   Full      - 40x30 cells of 8x8, the whole 320x240 frame
 *
 * Output: the picture drawn into a 320x240 RGBA buffer, backdrop everywhere else
 *
 * The TMS9918 emulation this grew out of: vrEmuTms9918 by Troy Schrapel,
 * https://github.com/visrealm/vrEmuTms9918
 */

// Display modes
export enum TmsMode {
  GRAPHICS_I = 0,
  GRAPHICS_II = 1,
  TEXT = 2,
  MULTICOLOR = 3,
}

// TMS9918 Color indices
export enum TmsColor {
  TRANSPARENT = 0,
  BLACK = 1,
  MED_GREEN = 2,
  LT_GREEN = 3,
  DK_BLUE = 4,
  LT_BLUE = 5,
  DK_RED = 6,
  CYAN = 7,
  MED_RED = 8,
  LT_RED = 9,
  DK_YELLOW = 10,
  LT_YELLOW = 11,
  DK_GREEN = 12,
  MAGENTA = 13,
  GREY = 14,
  WHITE = 15,
}

/**
 * The default palette (§11) — 256 entries of 12-bit RGB, written `$RGB`.
 *
 * Sixteen rows of sixteen, so that a 4bpp sub-palette selector picks a row:
 * row 0 the sixteen TMS9918 colors the ACE has always shown, row 1 a grayscale
 * ramp, rows 2-13 twelve hues at 30° intervals, row 14 brown and row 15
 * blue-grey. Each hue row is a shading ramp — dark at index 0, the pure hue at
 * index 7, tinted toward white at index 15 — so picking a row is picking a
 * color scheme.
 *
 * Row 0 is the old `TMS_PALETTE` quantized to 4 bits per channel, `round(v/17)`:
 * `$21C942` medium green becomes `$2C4`. The same nibble means the same color it
 * meant before, which is what lets `COLOR = $1F` still be black on white with no
 * software change — and every channel lands within 8 of where it was, which is
 * the bound `PIXEL_TOLERANCE` in the golden fixtures is set from.
 *
 * Transcribed from §11's table rather than computed from §11's `ramp()`, because
 * the two are not quite the same function: `ramp()` is Python, whose `round`
 * breaks a tie toward even, while JavaScript's `Math.round` breaks it upward.
 * They disagree in three entries of row 15 — the spec's `$334`, `$446` and
 * `$68A` against `Math.round`'s `$335`, `$456` and `$68B`. The published table
 * is what firmware will be written against, so the table is what is here; the
 * generator lives in the tests with the rounding rule the spec's Python actually
 * uses, so a regenerated palette and this transcription have to agree.
 */
const DEFAULT_PALETTE: ReadonlyArray<number> = [
  0x000, 0x000, 0x2c4, 0x6d7, 0x55e, 0x77f, 0xc55, 0x4ee, 0xf55, 0xf77, 0xcb5, 0xdc8, 0x2a4, 0xc5b, 0xccc, 0xfff, // 0  TMS9918 colors
  0x000, 0x111, 0x222, 0x333, 0x444, 0x555, 0x666, 0x777, 0x888, 0x999, 0xaaa, 0xbbb, 0xccc, 0xddd, 0xeee, 0xfff, // 1  grayscale
  0x200, 0x400, 0x600, 0x800, 0x900, 0xb00, 0xd00, 0xf00, 0xf22, 0xf33, 0xf55, 0xf77, 0xf88, 0xfaa, 0xfcc, 0xfdd, // 2  red
  0x210, 0x420, 0x630, 0x840, 0x950, 0xb60, 0xd70, 0xf80, 0xf92, 0xfa3, 0xfa5, 0xfb7, 0xfc8, 0xfda, 0xfdc, 0xfed, // 3  orange
  0x220, 0x440, 0x660, 0x880, 0x990, 0xbb0, 0xdd0, 0xff0, 0xff2, 0xff3, 0xff5, 0xff7, 0xff8, 0xffa, 0xffc, 0xffd, // 4  yellow
  0x120, 0x240, 0x360, 0x480, 0x590, 0x6b0, 0x7d0, 0x8f0, 0x9f2, 0xaf3, 0xaf5, 0xbf7, 0xcf8, 0xdfa, 0xdfc, 0xefd, // 5  chartreuse
  0x020, 0x040, 0x060, 0x080, 0x090, 0x0b0, 0x0d0, 0x0f0, 0x2f2, 0x3f3, 0x5f5, 0x7f7, 0x8f8, 0xafa, 0xcfc, 0xdfd, // 6  green
  0x021, 0x042, 0x063, 0x084, 0x095, 0x0b6, 0x0d7, 0x0f8, 0x2f9, 0x3fa, 0x5fa, 0x7fb, 0x8fc, 0xafd, 0xcfd, 0xdfe, // 7  spring green
  0x022, 0x044, 0x066, 0x088, 0x099, 0x0bb, 0x0dd, 0x0ff, 0x2ff, 0x3ff, 0x5ff, 0x7ff, 0x8ff, 0xaff, 0xcff, 0xdff, // 8  cyan
  0x012, 0x024, 0x036, 0x048, 0x059, 0x06b, 0x07d, 0x08f, 0x29f, 0x3af, 0x5af, 0x7bf, 0x8cf, 0xadf, 0xcdf, 0xdef, // 9  azure
  0x002, 0x004, 0x006, 0x008, 0x009, 0x00b, 0x00d, 0x00f, 0x22f, 0x33f, 0x55f, 0x77f, 0x88f, 0xaaf, 0xccf, 0xddf, // A  blue
  0x102, 0x204, 0x306, 0x408, 0x509, 0x60b, 0x70d, 0x80f, 0x92f, 0xa3f, 0xa5f, 0xb7f, 0xc8f, 0xdaf, 0xdcf, 0xedf, // B  violet
  0x202, 0x404, 0x606, 0x808, 0x909, 0xb0b, 0xd0d, 0xf0f, 0xf2f, 0xf3f, 0xf5f, 0xf7f, 0xf8f, 0xfaf, 0xfcf, 0xfdf, // C  magenta
  0x201, 0x402, 0x603, 0x804, 0x905, 0xb06, 0xd07, 0xf08, 0xf29, 0xf3a, 0xf5a, 0xf7b, 0xf8c, 0xfad, 0xfcd, 0xfde, // D  rose
  0x110, 0x321, 0x431, 0x642, 0x742, 0x852, 0xa63, 0xb73, 0xb84, 0xc96, 0xca7, 0xdb8, 0xdba, 0xecb, 0xedc, 0xfee, // E  brown / sepia
  0x112, 0x223, 0x334, 0x446, 0x468, 0x579, 0x68a, 0x79c, 0x8ac, 0x9ad, 0xabd, 0xbcd, 0xbce, 0xcde, 0xdee, 0xeef, // F  blue-grey
]

/**
 * The palette as VRAM sees it (§11): 512 bytes at `PALBASE`, two per entry.
 *
 *   entry n + 0   %0000RRRR
 *   entry n + 1   %GGGGBBBB
 */
const PALETTE_ENTRIES = 256
const PALETTE_BYTES = PALETTE_ENTRIES * 2

/**
 * `PALBASE` is a 1 KB granule over eight bits, of which six are meaningful in
 * 64 KB of VRAM (§5) — so the window starts at `$0000`-`$FC00` and, being 512
 * bytes, can never wrap the top.
 */
const PALETTE_BASE_SHIFT = 10
const PALETTE_BASE_MASK = 0x3f

/** 4-bit channel to 8-bit: `$0` → `$00`, `$F` → `$FF`. */
const CHANNEL_EXPAND = 0xff / 0x0f

// VRAM (§7) — 64 KB, flat, addressed as a 16-bit space.
const VRAM_SIZE = 1 << 16       // 64KB
const VRAM_MASK = VRAM_SIZE - 1  // 0xFFFF

// Output buffer resolution — §3's virtual frame, one byte of palette index per
// pixel, doubled to 640x480 by whatever is showing it.
export const DISPLAY_WIDTH = 320
export const DISPLAY_HEIGHT = 240

/** Every geometry's cell is eight pixels tall (§9). */
const CELL_HEIGHT = 8

/** A 1bpp pattern is one byte per row — the sprite format too (§8, §10). */
const PATTERN_BYTES = 8

// ================================================================
//  Sprites (§10)
// ================================================================

/** A sprite pattern is eight pixels wide per quadrant, at every depth (§10). */
const SPRITE_QUADRANT = 8

/** 64 slots of four bytes, of which `SPRCOUNT` are evaluated (§10). */
const SPRITE_SLOTS = 64

/** The most sprites one line can draw, and so `SPRLIMIT`'s ceiling (§5, §10). */
const SPRITE_LIMIT_MAX = 32

/** The four bytes of one slot (§10). */
const SPRITE_ATTR_Y = 0
const SPRITE_ATTR_X = 1
const SPRITE_ATTR_PATTERN = 2
const SPRITE_ATTR_ATTRIBUTES = 3
const SPRITE_ATTR_BYTES = 4

/**
 * `SPRCTRL` (§5), which resets to `$27`: enabled, collision on, `$D0`
 * terminator active, detailed collision off, 4bpp.
 */
const SPRCTRL_ENABLE = 0x01
const SPRCTRL_COLLISION = 0x02
const SPRCTRL_TERMINATOR = 0x04
const SPRCTRL_DETAILED = 0x08
const SPRCTRL_DEPTH = 0x30

/**
 * The Y that ends the list while `SPRCTRL` b2 is set (§10).
 *
 * Row 208: off the bottom of a 192-line legacy screen, but *on* a 240-line one,
 * which is why the bit exists at all. Software using the full height clears it
 * and bounds the table with `SPRCOUNT` instead.
 */
const SPRITE_TERMINATOR = 0xd0

/**
 * Y is the sprite's top edge as a display line; 241-255 mean -15…-1 (§10).
 *
 * 240 is still a positive position — §10 calls it the first row below a
 * 240-line picture — so the negative window starts one above it.
 *
 * This is deliberately **not** the TMS9918's Y + 1 convention, where `$FF` put
 * a sprite's first row on display line 0 and `$00` put it on line 1. §10 gives
 * one rule for every mode and this is it, so a legacy sprite sits one line
 * higher here than on a 9918. The alternative is two interpretations of the
 * same byte chosen by `VMODE`, which the spec does not describe.
 */
const SPRITE_Y_NEGATIVE = 241

/** X is 9 bits: 0-383 are on screen, 384-511 mean -128…-1 (§10). */
const SPRITE_X_NEGATIVE = 384
const SPRITE_X_RANGE = 512

/**
 * The sprite attribute byte (§10): b3:0 sub-palette, b4 flip X, b5 flip Y,
 * b6 priority, b7 X bit 8.
 *
 * b4 and b5 are `ATTR_FLIP_X`/`ATTR_FLIP_Y`, the same bits in the same places
 * as a tile's attribute byte. b6 lifts a sprite above layer 1 and is read by
 * the compositor, which is §12 and arrives in Phase 7.
 */
const SPRITE_SUBPALETTE = 0x0f
const SPRITE_X_BIT8 = 0x80

/**
 * Attribute b7 in the legacy submode: the TMS9918's early clock, which shifts
 * the sprite 32 pixels left rather than the 256 that X bit 8 would add (§9).
 */
const SPRITE_EARLY_CLOCK = 0x80
const SPRITE_EARLY_CLOCK_PIXELS = 32

/**
 * `STAT8`-`STAT15`, the 64-bit collision bitmap (§6, §10).
 *
 * Eight bytes, bit *s* of byte *s* >> 3 for sprite *s*, read through the status
 * port as the eight registers above `STAT7`.
 */
const COLLISION_MAP_FIRST_STATUS = 8
const COLLISION_MAP_BYTES = 8

/**
 * `STAT0` flags (§6) — the TMS9918's status register, bit for bit.
 *
 * `F` is the one worth naming carefully. It says the active picture has ended
 * this frame and it sets **regardless of `IRQEN`**, because `IRQEN` governs the
 * `/INT` pin and nothing else: polling `STAT0` for vertical blank with
 * interrupts disabled is a common idiom and it has to work. The interrupt that
 * usually accompanies it is a separate latch, in `STAT1`.
 */
const STAT0_F = 0x80
const STAT0_OVF = 0x40
const STAT0_COL = 0x20

/**
 * `STAT0` b4:0 — the low five bits of the first sprite dropped this frame (§6).
 *
 * Five bits cannot name slots 32-63, which is what `STAT7` is for. §6 keeps the
 * field this width on purpose: `STAT0` is the TMS9918's status register bit for
 * bit, so that `bit VC_STATUS` / `bmi` still finds vertical blank in b7.
 */
const STAT0_SPRITE_INDEX = 0x1f

/**
 * Interrupt sources (§14). One bit each, in the same position in `IRQEN`
 * (which enables) and in `STAT1` (which latches).
 */
const IRQ_VBLANK = 0x01
const IRQ_SCANLINE = 0x02
const IRQ_OVERFLOW = 0x04
const IRQ_COLLISION = 0x08

/** Which of the sixteen status registers a `STATSEL` byte names; b7:4 reserved (§5). */
const STATSEL_MASK = 0x0f

/**
 * `STAT4`, the identification byte (§6).
 *
 * §16's detection probe selects `STAT4` and compares against this. A TMS9918
 * decodes three register bits, so the probe's `$8F` lands on register 7 there
 * and the status read returns anything but `$AC` — which is how absence is
 * reported.
 */
const STAT_IDENTIFICATION = 0xac

/**
 * `STAT5`, the firmware version in BCD: high nibble major, low nibble minor.
 *
 * `$01` is 0.1, the revision on the title page of `docs/VDP-SPEC.md`. The
 * emulator has no firmware of its own to version, so it reports the revision of
 * the specification it implements; bump both together.
 */
const STAT_FIRMWARE_VERSION = 0x01

/**
 * `STAT6`, the capability bits (§6): two layers, 8bpp layer, sprite flip,
 * hardware scroll, scanline IRQ, 64 KB VRAM — all six.
 *
 * This describes the card the spec specifies, not how far `PLAN.md` has got:
 * software reads it to decide what a *chip* can do, and answering "no sprite
 * flip" in Phase 2 and "yes" in Phase 6 would make the answer a property of the
 * emulator's build date. The phases are this repository's business.
 */
const STAT_CAPABILITIES = 0x3f

// Register 0 bits
const TMS_R0_MODE_GRAPHICS_II = 0x02

// Register 1 bits
const TMS_R1_DISP_ACTIVE = 0x40
const TMS_R1_INT_ENABLE = 0x20
const TMS_R1_MODE_MULTICOLOR = 0x08
const TMS_R1_MODE_TEXT = 0x10
const TMS_R1_SPRITE_16 = 0x02
const TMS_R1_SPRITE_MAG2 = 0x01

// Register indices — the legacy core, $00-$07 (§5)
const TMS_REG_0 = 0
const TMS_REG_1 = 1
const TMS_REG_NAME_TABLE = 2
const TMS_REG_COLOR_TABLE = 3
const TMS_REG_PATTERN_TABLE = 4
const TMS_REG_SPRITE_ATTR_TABLE = 5
const TMS_REG_SPRITE_PATT_TABLE = 6
const TMS_REG_FG_BG_COLOR = 7

/**
 * 128 registers (§5). The TMS9918 decodes three bits of the command byte and
 * the F18A six; this decodes seven, so `$08`-`$7F` are always live and no mode
 * is reachable only by magic.
 */
const NUM_REGISTERS = 128
const REGISTER_MASK = NUM_REGISTERS - 1 // 0x7F

// Access and interrupts, $08-$0F (§5)
const REG_VBANK = 0x08
const REG_VINC = 0x09
const REG_IRQEN = 0x0a
const REG_IRQLINE = 0x0b
const REG_PALBASE = 0x0c
const REG_VMODE = 0x0d
const REG_STATSEL_B = 0x0e
const REG_STATSEL_A = 0x0f

// Layer 0, $10-$17; layer 1, $18-$1F; sprites, $20-$27 (§5)
const REG_L0NAME = 0x10
const REG_L0ATTR = 0x11
const REG_L0PAT = 0x12
const REG_L0CTRL = 0x15
const REG_L0PAL = 0x16
const REG_L1CTRL = 0x1d
const REG_SPRATTR = 0x20
const REG_SPRPAT = 0x21
const REG_SPRCOUNT = 0x22
const REG_SPRCTRL = 0x23
const REG_SPRLIMIT = 0x24
const REG_SPRPAL = 0x25

/** `LxCTRL` (§5, §8). */
const LXCTRL_DEPTH = 0x03
const LXCTRL_ATTR_SOURCE = 0x0c
const LXCTRL_ENABLE = 0x10
const LXCTRL_INDEX0_OPAQUE = 0x20

/**
 * Bit depth, as `LxCTRL` b1:0 encodes it (§8).
 *
 * The code is a shift count everywhere it is used, which is why it is kept as
 * the register's two bits rather than expanded to 1/2/4/8: a tile is
 * `8 << depth` bytes, a pattern row `1 << depth`, and `8 >> depth` pixels come
 * out of each of those bytes.
 */
const DEPTH_1BPP = 0
const DEPTH_8BPP = 3

/** Bits per pixel at each depth code, for the pixel unpacking. */
const DEPTH_BITS = [1, 2, 4, 8] as const

/**
 * Where a cell's color byte comes from, as `LxCTRL` b3:2 encodes it (§8).
 *
 * `PER_GROUP` is the TMS9918's Graphics I color table and `PER_ROW` is
 * Graphics II's scheme; both are 1bpp ideas, and having them here as ordinary
 * values of an engine parameter is what makes Graphics I fall out of the design
 * rather than needing a renderer of its own.
 */
const ATTR_PER_CELL = 0
const ATTR_PER_GROUP = 1
const ATTR_PER_ROW = 2
const ATTR_NONE = 3

/**
 * The attribute byte at 2, 4 and 8bpp (§8). At 1bpp the same byte is a pair of
 * fg/bg nibbles instead and none of these apply.
 *
 * b6 — priority, drawing the cell in front of ordinary sprites — is read by the
 * compositor, which is §12 and arrives with layer 1 in Phase 7. Nothing here
 * consults it yet.
 */
const ATTR_SUBPALETTE = 0x0f
const ATTR_FLIP_X = 0x10
const ATTR_FLIP_Y = 0x20
const ATTR_PATTERN_BIT8 = 0x80

/**
 * Where each register's byte actually lives (§5).
 *
 * `$02`-`$06` are aliases of registers in the layer and sprite blocks — the
 * same storage under two addresses — so that a legacy register write and the
 * symmetric new layout describe the same hardware. The alias resolves on the
 * way in and on the way out, which means the byte has exactly one home and
 * there is no pair of values that can disagree.
 */
const REGISTER_ALIAS = (() => {
  const alias = new Uint8Array(NUM_REGISTERS)
  for (let index = 0; index < NUM_REGISTERS; index++) alias[index] = index
  alias[TMS_REG_NAME_TABLE] = REG_L0NAME // $02 -> $10
  alias[TMS_REG_COLOR_TABLE] = REG_L0ATTR // $03 -> $11
  alias[TMS_REG_PATTERN_TABLE] = REG_L0PAT // $04 -> $12
  alias[TMS_REG_SPRITE_ATTR_TABLE] = REG_SPRATTR // $05 -> $20
  alias[TMS_REG_SPRITE_PATT_TABLE] = REG_SPRPAT // $06 -> $21
  return alias
})()

/**
 * Reset values for the registers that do not reset to zero (§15, and the tables
 * in §5). Everything absent here is `$00`.
 */
const REGISTER_RESET: ReadonlyArray<readonly [number, number]> = [
  [REG_VINC, 0x01], // +1, the TMS9918's fixed stride as a default
  [REG_PALBASE, 0x3f], // palette at $FC00
  [REG_L0CTRL, 0x3c], // 1bpp, no attribute table, enabled, index 0 opaque
  [REG_L1CTRL, 0x0c], // the same, but disabled and index 0 transparent
  [REG_SPRCOUNT, 0x20], // 32 slots
  [REG_SPRCTRL, 0x27], // enabled, collision on, $D0 terminator, 4bpp
  [REG_SPRLIMIT, 0x20] // 32 per scanline
]

/**
 * Put a register file into its reset state.
 *
 * Used both by `reset()` and by the field initializer, because there is no such
 * thing on the hardware as a card that has been made but not reset — and the
 * first register that stopped resetting to zero was `VINC`, where the difference
 * between a fresh object and a reset one is a VRAM pointer that never advances.
 */
function resetRegisterFile(registers: Uint8Array): Uint8Array {
  registers.fill(0)
  for (const [index, value] of REGISTER_RESET) registers[index] = value
  return registers
}

// Command byte decode (§4)
const CMD_REGISTER_WRITE = 0x80 // %1rrrrrrr — write register r
const CMD_ADDRESS_WRITE = 0x40 // %01aaaaaa — set the pointer for writing
const CMD_ADDRESS_MASK = 0x3f // the six pointer bits a command byte carries

/** Pointer bits the command protocol sets; 15:14 come from `VBANK` (§4). */
const POINTER_COMMAND_BITS = 14

/** A register byte read as a signed 8-bit value, which is how `VINC` is defined. */
const signed8 = (value: number): number => (value & 0x80 ? (value & 0xff) - 256 : value & 0xff)

// Timing (NTSC)
const TOTAL_SCANLINES = 262
const FRAMES_PER_SECOND = 60

/** `VMODE` b3:0 selects the geometry; b7:4 are reserved (§9). */
const VMODE_MASK = 0x0f

/**
 * One of §9's picture geometries: a cell grid, and where it sits in the frame.
 *
 * This is the only thing a display mode *is* on this card. Bit depth, where the
 * color of a cell comes from and which sixteen colors it names all come from
 * `LxCTRL` and `LxPAL` instead, per layer — so "Compact" means a 32x24 grid of
 * 8x8 cells and nothing more, and a program is free to run it at 4bpp with
 * per-cell attributes even though it is where a Graphics I program lands (§9).
 *
 * `originX`/`originY` centre the picture in the 320x240 frame, which is what
 * §3's position column says for all four: Text at x 40, the 8-pixel-cell
 * 192-line modes at x 32 y 24, Graphics at x 32 with no vertical border, Full
 * edge to edge. Everything outside is backdrop.
 */
interface Geometry {
  /** Cells across. */
  readonly cols: number
  /** Cells down. */
  readonly rows: number
  /** Pixels drawn from each cell's pattern row — 6 in Text, 8 elsewhere (§8). */
  readonly cellWidth: number
  /** `cols × cellWidth`: the picture's width in pixels. */
  readonly width: number
  /** `rows × 8`: lines of active picture, which is also §14's vblank boundary. */
  readonly lines: number
  /** Where the picture starts in the frame. */
  readonly originX: number
  readonly originY: number
}

const makeGeometry = (cols: number, rows: number, cellWidth: number): Geometry => {
  const width = cols * cellWidth
  const lines = rows * CELL_HEIGHT
  return {
    cols,
    rows,
    cellWidth,
    width,
    lines,
    originX: (DISPLAY_WIDTH - width) / 2,
    originY: (DISPLAY_HEIGHT - lines) / 2
  }
}

const GEOMETRY_TEXT = makeGeometry(40, 24, 6)
const GEOMETRY_COMPACT = makeGeometry(32, 24, 8)
const GEOMETRY_GRAPHICS = makeGeometry(32, 30, 8)
const GEOMETRY_FULL = makeGeometry(40, 30, 8)

/**
 * `VMODE` b3:0 to geometry (§9). `null` hands the choice to `M1`/`M2`/`M3`.
 *
 * `$0` is the legacy submode and resets there. The reserved codes `$5`-`$F`
 * resolve to it as well: §9 leaves them undefined, and answering with the mode
 * the card powers up in is the one answer that cannot surprise a program that
 * reached them by accident.
 */
const VMODE_GEOMETRY: ReadonlyArray<Geometry | null> = (() => {
  const table: Array<Geometry | null> = new Array(16).fill(null)
  table[0x1] = GEOMETRY_TEXT
  table[0x2] = GEOMETRY_COMPACT
  table[0x3] = GEOMETRY_GRAPHICS
  table[0x4] = GEOMETRY_FULL
  return table
})()

/**
 * Where horizontal blanking starts, as a fraction of the line (§3).
 *
 * The line is 800 pixel clocks of which 640 are active — the 640x480 VGA raster
 * this card drives — so the last fifth of every line is blanking. `STAT3` b1
 * reports it, and the cycle accumulator is what says how far into the line the
 * CPU has got.
 */
const HBLANK_FRACTION = 640 / 800

/**
 * One of the two independent port pairs (§4).
 *
 * `$9C02`/`$9C03` are a complete second copy of the interface, and what makes
 * them a second copy rather than a mirror is exactly this: each pair carries its
 * own pointer, direction, prefetch and flip-flop. That is what lets an interrupt
 * handler use port B while foreground code is halfway through a command pair on
 * port A — the hazard the AC6502 documentation warns about, gone without
 * `sei`/`cli` around every VDP access.
 *
 * The register file and VRAM are *not* here. Both ports write the same
 * registers and address the same 64 KB.
 */
class VideoPort {
  /**
   * The register holding this port's status selector — `$0F` for port A,
   * `$0E` for port B (§5).
   *
   * The selectors live in the shared register file rather than in the port, but
   * *which* of them a port obeys is the port's own property, and it is the last
   * piece of state that makes the two interfaces independent: a handler reading
   * `STAT2` on port B cannot move what foreground code sees on port A.
   */
  constructor(readonly statSelectRegister: number) {}

  /**
   * Full 16-bit VRAM pointer (§4).
   *
   * A command sets bits 13:0 and takes 15:14 from `VBANK`; after that the
   * pointer is a counter in its own right, and `VINC` carries it across bank
   * boundaries. The TMS9918 wrapped within 16 KB; this deliberately does not.
   */
  pointer = 0

  /**
   * True when the last command set the pointer for reading.
   *
   * Nothing in the renderer consults it — the prefetch that a read address
   * implies happens when the command lands, not later — but §4 names it as part
   * of a port's state, and a debugger inspecting a wedged machine wants to know
   * which way a port was pointed. Carried in snapshots for the same reason.
   */
  readMode = false

  /** Read-ahead prefetch byte (§4). */
  readAhead = 0

  /** First-byte/second-byte flip-flop: 0 = next write is the payload. */
  stage = 0

  /** The payload byte latched by the first write of a command pair. */
  payload = 0

  reset(): void {
    this.pointer = 0
    this.readMode = false
    this.readAhead = 0
    this.stage = 0
    this.payload = 0
  }

  serialize(): DeviceState {
    return {
      kind: 'video-port',
      pointer: this.pointer,
      readMode: this.readMode,
      readAhead: this.readAhead,
      stage: this.stage,
      payload: this.payload
    }
  }

  deserialize(state: DeviceState): void {
    expectKind(state, 'video-port')
    this.pointer = readNumber(state, 'pointer') & VRAM_MASK
    this.readMode = readBoolean(state, 'readMode')
    this.readAhead = readNumber(state, 'readAhead') & 0xff
    this.stage = readNumber(state, 'stage') & 1
    this.payload = readNumber(state, 'payload') & 0xff
  }
}

export class Video implements IO {

  readonly kind = 'video'

  // ---- VDP internal state ----

  /** 128 write-only registers (§5). Read state back through the status port. */
  private registers = resetRegisterFile(new Uint8Array(NUM_REGISTERS))

  /**
   * `STAT0` (§6): b7 F, b6 OVF, b5 COL, b4:0 the sprite index field.
   *
   * Flags, not interrupts. They set whether or not anything is enabled, and
   * they are what `bit VC_STATUS` / `bmi` has always tested.
   */
  private stat0: number = 0

  /**
   * `STAT1` (§14): which enabled interrupt sources are latched.
   *
   * A source latches only while its `IRQEN` bit is set, so this is exactly the
   * set of interrupts a handler is entitled to act on — and `/INT` is asserted
   * for precisely as long as it is non-zero. `STAT0` b7 is deliberately not the
   * same thing as b0 here: the flag records that the picture ended, this records
   * that an interrupt was raised about it.
   */
  private irqLatch: number = 0

  /**
   * `STAT7` (§6): the full six-bit index of the first sprite dropped on the
   * most recent overflowing line.
   *
   * `STAT0`'s five-bit field cannot name sprites 32-63, which is why this
   * exists. It tracks the latest overflowing line where `STAT0`'s latches the
   * first — a distinction that only starts to matter when a line can drop a
   * sprite more than once, in Phase 5.
   */
  private overflowSprite: number = 0

  /**
   * `STAT8`-`STAT15` (§6, §10): which sprites collided this frame.
   *
   * Maintained only while `SPRCTRL` b3 is set, which is why it is opt-in: on the
   * hardware the sprite line buffer has to carry an owner index per pixel to
   * know *which* sprites met, and §18 prices that at about 500 cycles on a
   * worst-case line. The sticky `COL` bit in `STAT0` needs none of it.
   *
   * Sticky for the frame, cleared by a status read along with every other
   * latched flag, and by the start of the next picture.
   */
  private collisionMap = new Uint8Array(COLLISION_MAP_BYTES)

  /**
   * The two port pairs (§4). Port A is `$9C00`/`$9C01`, port B `$9C02`/`$9C03`.
   */
  private readonly portA = new VideoPort(REG_STATSEL_A)
  private readonly portB = new VideoPort(REG_STATSEL_B)

  /** Current display mode (derived from registers) */
  private mode: TmsMode = TmsMode.GRAPHICS_I

  /** 64 KB Video RAM (§7) */
  private vram = new Uint8Array(VRAM_SIZE)

  /**
   * The palette (§11) as expanded RGBA, four bytes an entry.
   *
   * The palette itself lives in VRAM, in a 512-byte window at `PALBASE`; this is
   * the cache the card keeps of it, and `poke` snoops every write into that
   * window to keep the two in step. That is the whole mechanism — there is no
   * dirty flag to set and no reload command to forget, so a program that stores
   * a color sees it on the next pixel drawn.
   *
   * Alpha is not a palette property. The VDP has no notion of one; every entry
   * is opaque in the output buffer, including entry 0, which is transparent to
   * the *compositor* and opaque black on a screen.
   */
  private paletteCache = new Uint8Array(PALETTE_ENTRIES * 4)

  /**
   * Direct VRAM access for a debugger.
   *
   * The CPU can only reach VRAM through the address-latch and auto-increment
   * dance on the data port, which has side effects (it moves the pointer and
   * refills the read-ahead buffer). Inspecting memory must not disturb the
   * machine, so these bypass the port entirely.
   */
  get vramSize(): number {
    return VRAM_SIZE
  }

  readVRAM(offset: number): number {
    return this.vram[offset & VRAM_MASK]!
  }

  writeVRAM(offset: number, value: number): void {
    this.poke(offset & VRAM_MASK, value & 0xff)
  }

  /**
   * The sprite line buffer (§10, §18): which sprite covers each pixel of the
   * line being drawn, as its slot index plus one, and whether one has painted.
   *
   * Two questions, and they are not the same question. `owner` records coverage
   * — any pixel whose pattern value is non-zero, painted or not — because that
   * is what collides, and it holds the *lowest* slot covering the pixel so that
   * the detailed map can name both members of a pair. `painted` records that a
   * visible pixel has been written, which is what makes the lower slot win the
   * pixel; a legacy sprite coloured 0 covers without painting, exactly as a
   * TMS9918's transparent sprite collides without occluding.
   *
   * Cleared by the first sprite on each line rather than per line, so a line
   * with no sprites on it — every line of a text-mode screen — costs nothing.
   */
  private spriteLineOwner = new Uint8Array(DISPLAY_WIDTH)
  private spriteLinePainted = new Uint8Array(DISPLAY_WIDTH)

  /**
   * One scanline of the picture as palette indices, 0 – 255.
   *
   * Indexed from the left edge of the *picture*, not of the frame, so pixel 0
   * is at `geometry.originX` on screen; only the first `geometry.width` entries
   * are live. Full mode is the widest at 320, which is why it is a frame's worth.
   */
  private scanlinePixels = new Uint8Array(DISPLAY_WIDTH)

  /** 320 × 240 RGBA output buffer for SDL rendering (front buffer – always a complete frame) */
  buffer: Buffer = Buffer.alloc(DISPLAY_WIDTH * DISPLAY_HEIGHT * 4)

  /** Back buffer where scanlines are rendered progressively */
  private backBuffer: Buffer = Buffer.alloc(DISPLAY_WIDTH * DISPLAY_HEIGHT * 4)

  /**
   * The same two buffers again, one byte per pixel, holding the palette index
   * the RGBA above was looked up from. See frameIndices().
   */
  private indexBuffer = new Uint8Array(DISPLAY_WIDTH * DISPLAY_HEIGHT)
  private backIndexBuffer = new Uint8Array(DISPLAY_WIDTH * DISPLAY_HEIGHT)

  /** True when a complete frame has been copied to the front buffer */
  frameReady: boolean = false

  /** Cycle accumulator for scanline timing: CPU cycles into the current line. */
  private cycleAccumulator: number = 0

  /**
   * Cycles in one scanline at the frequency last ticked at.
   *
   * Derived, not state: `tick` recomputes it every cycle and nothing outside a
   * running machine has an opinion about it, which is why it is absent from
   * snapshots. `STAT3`'s horizontal blanking bit is the only reader.
   */
  private cyclesPerScanline: number = 0

  /**
   * The display line being processed, 0 – 261 (§3).
   *
   * Counted from the first line of the active picture **in the current mode**,
   * not from the top of the frame — so display line 0 is screen line 24 in the
   * 192-line modes and screen line 0 in the 240-line ones, and `IRQLINE = 80` is
   * ten character rows down whichever is running. It runs up through the
   * picture, the bottom border, blanking and the top border, and wraps at 262.
   */
  private displayLine: number = 0

  /**
   * A card that has been made is a card that has been reset.
   *
   * The register file takes its §15 values in its initializer for this reason,
   * and the palette is the same argument one step further on: §15 says VRAM is
   * undefined after reset *except* `$FC00`-`$FDFF`, which holds the default
   * palette. A `Video` that had never been reset would render every pixel
   * through 256 entries of black, which is not a state the hardware has.
   */
  constructor() {
    this.installDefaultPalette()
  }

  // ================================================================
  //  IO Interface
  // ================================================================

  /**
   * Four ports decoded from A1:A0 (§4), mirrored across `$9C00`-`$9FFF`.
   *
   *   A1=0 A0=0  `$9C00`  VC_DATA    VRAM data, port A
   *   A1=0 A0=1  `$9C01`  VC_REG     command / status, port A
   *   A1=1 A0=0  `$9C02`  VC_DATA2   VRAM data, port B
   *   A1=1 A0=1  `$9C03`  VC_REG2    command / status, port B
   */
  private portFor(address: number): VideoPort {
    return address & 2 ? this.portB : this.portA
  }

  read(address: number): number {
    const port = this.portFor(address)
    return address & 1 ? this.readStatus(port) : this.readData(port)
  }

  write(address: number, data: number): void {
    const port = this.portFor(address)
    if (address & 1) {
      this.writeCommand(port, data)
    } else {
      this.writeData(port, data)
    }
  }

  tick(frequency: number): number {
    const cyclesPerFrame = frequency / FRAMES_PER_SECOND
    this.cyclesPerScanline = cyclesPerFrame / TOTAL_SCANLINES

    this.cycleAccumulator++

    while (this.cycleAccumulator >= this.cyclesPerScanline) {
      this.cycleAccumulator -= this.cyclesPerScanline
      this.processScanline()
    }

    // `/INT` is level-driven and asserted while any enabled source is latched
    // (§14) — which, because a source only latches while it is enabled, is
    // exactly while `STAT1` is non-zero. It releases when the handler reads
    // `STAT0` or `STAT1`, not when the frame ends.
    return this.irqLatch ? 0x80 : 0
  }

  reset(coldStart: boolean): void {
    // `/INT` released, all interrupt flags clear (§15).
    this.acknowledgeInterrupts()
    // Both port pairs: pointer 0, direction read, flip-flop cleared (§15).
    this.portA.reset()
    this.portB.reset()
    this.resetRegisters()
    this.cycleAccumulator = 0
    this.displayLine = 0
    this.updateMode()
    // A warm reset leaves VRAM alone — the chip has no clear-on-reset and the
    // image survives a RESET pulse on hardware, matching the C reference.
    // A cold start is a power cycle, and every other memory card (RAM,
    // RAMBank) zeroes itself for one; leaving the last frame's tiles and
    // patterns behind made "power cycle" mean something different for the
    // video card than for the rest of the machine.
    if (coldStart) this.vram.fill(0)
    // §15: VRAM is undefined after a reset *except* `$FC00`-`$FDFF`, which holds
    // the default palette — on a warm reset too, which is the one case where
    // reset does reach into VRAM. The address is the reset `PALBASE`, `$FC00`,
    // because `resetRegisters` has just run.
    this.installDefaultPalette()
    this.fillBackground()
  }

  // ================================================================
  //  VDP Data / Control Ports
  // ================================================================

  /**
   * Write to a command port (§4). Two writes make one command:
   *
   *   1st write:  payload byte P
   *   2nd write:  command byte C
   *
   *   `%1rrrrrrr`  write register r (0–127) with P
   *   `%01aaaaaa`  set the VRAM pointer for **write** to {VBANK[1:0], a, P}
   *   `%00aaaaaa`  the same for **read**, and prefetch
   *
   * The TMS9918 decodes three register bits and the F18A six; this decodes
   * seven, which is what makes `$08`-`$7F` reachable without a mode switch.
   * Legacy writes of `$80`-`$87` still land on registers 0–7 unchanged.
   */
  private writeCommand(port: VideoPort, data: number): void {
    if (port.stage === 0) {
      port.payload = data
      port.stage = 1
      return
    }
    port.stage = 0

    if (data & CMD_REGISTER_WRITE) {
      this.setRegister(data & REGISTER_MASK, port.payload)
      return
    }

    // Bits 13:0 from the command pair, 15:14 from VBANK. The bank is sampled
    // here and then belongs to the pointer: a later VBANK write does not move a
    // pointer that has already been set, and a pointer that carries out of its
    // bank does not write back.
    const bank = this.reg(REG_VBANK) & 0x03
    port.pointer =
      (bank << POINTER_COMMAND_BITS) | ((data & CMD_ADDRESS_MASK) << 8) | port.payload
    port.readMode = (data & CMD_ADDRESS_WRITE) === 0

    if (port.readMode) {
      // Setting a read address fetches the byte at it immediately, so that the
      // first VC_DATA read returns what was asked for rather than the one after.
      port.readAhead = this.vram[port.pointer]!
      this.advance(port)
    }
  }

  /** Write data to VRAM at the port's pointer, which then advances by `VINC`. */
  private writeData(port: VideoPort, data: number): void {
    port.stage = 0
    port.readAhead = data
    this.poke(port.pointer, data)
    this.advance(port)
  }

  /**
   * Write one byte of VRAM, keeping the palette cache in step (§11).
   *
   * Every path into VRAM goes through here — both data ports and the debugger's
   * direct accessors — because the snoop is a property of the memory and not of
   * who wrote to it. A palette poked over the port and a palette poked by a
   * debugger have to reach the screen the same way, or a program is debuggable
   * only when it is not being debugged.
   */
  private poke(address: number, value: number): void {
    this.vram[address] = value
    // The window is 512 bytes on a 1 KB boundary, so it cannot wrap the top of
    // VRAM: one unsigned subtraction is the whole test, and an address below the
    // base underflows to something far larger than 512.
    const offset = (address - this.paletteBase()) >>> 0
    if (offset < PALETTE_BYTES) this.cachePaletteEntry(offset >> 1)
  }

  /**
   * Read the status register named by this port's `STATSEL`, and reset the
   * port's command flip-flop (§6).
   *
   * Sixteen registers share one address, and which one a read returns is a
   * property of the port rather than of the card — the reason the two selectors
   * are separate registers at all (§5). Both select `STAT0` at reset, which is
   * what every TMS9918-era program expects to find there.
   */
  private readStatus(port: VideoPort): number {
    port.stage = 0
    return this.statusRegister(this.reg(port.statSelectRegister) & STATSEL_MASK)
  }

  /**
   * One status register's value, with the side effects of reading it (§6).
   *
   * `STAT0` and `STAT1` acknowledge: either read clears every latched flag and
   * releases `/INT`, which is why §6 warns that reading both in one handler
   * loses information. The rest are pure reads of live state.
   */
  private statusRegister(select: number): number {
    switch (select) {
      case 0: {
        const value = this.stat0
        this.acknowledgeInterrupts()
        return value
      }
      case 1: {
        const value = this.irqLatch
        this.acknowledgeInterrupts()
        return value
      }
      // Display line, low 8 bits. Lines 256-261 alias to 0-5 here; `STAT3` b0
      // is what tells them apart, because those are blanking and 0-5 are not.
      case 2:
        return this.displayLine & 0xff
      case 3:
        return (this.verticalBlanking() ? 0x01 : 0) | (this.horizontalBlanking() ? 0x02 : 0)
      case 4:
        return STAT_IDENTIFICATION
      case 5:
        return STAT_FIRMWARE_VERSION
      case 6:
        return STAT_CAPABILITIES
      case 7:
        return this.overflowSprite
      // `STAT8`-`STAT15`, the collision bitmap (§6): bit *s* of `STAT(8 + s/8)`
      // for sprite *s*. The selector is masked to four bits, so every case left
      // is one of the eight. Zero while `SPRCTRL` b3 is clear, because nothing
      // was recorded — not because the register is absent.
      default:
        return this.collisionMap[select - COLLISION_MAP_FIRST_STATUS]!
    }
  }

  /** Read VRAM through the port's prefetch byte; the pointer advances by `VINC`. */
  private readData(port: VideoPort): number {
    port.stage = 0
    const value = port.readAhead
    port.readAhead = this.vram[port.pointer]!
    this.advance(port)
    return value
  }

  /**
   * Advance a port's pointer by the signed stride in `VINC` (§4).
   *
   * Signed, so a stride of `$FF` walks backwards, and `$00` leaves the pointer
   * where it is. The carry runs into the bank bits rather than wrapping within
   * 16 KB: a streaming write runs off the end of one bank into the next. This is
   * the one place TMS9918 behavior is deliberately broken, and the spec says so
   * — nothing in the AC6502 software suite relies on the old wrap.
   */
  private advance(port: VideoPort): void {
    port.pointer = (port.pointer + signed8(this.reg(REG_VINC))) & VRAM_MASK
  }

  // ================================================================
  //  Register File
  // ================================================================

  /**
   * One register's byte, through the alias table (§5).
   *
   * Everything inside the card reads registers this way, so a renderer asking
   * for `TMS_REG_NAME_TABLE` and a program writing `$10` are talking about the
   * same storage without either of them knowing it.
   */
  private reg(index: number): number {
    return this.registers[REGISTER_ALIAS[index]!]!
  }

  /**
   * Keep `MODE1` b5 and `IRQEN` b0 equal — they are one bit under two names
   * (§14).
   *
   * Legacy code enables the vertical blank interrupt by writing register 1, new
   * code by writing `IRQEN`, and both have to mean the same thing. The `$02`-`$06`
   * aliases solve the same problem by giving a register exactly one home; a
   * single *bit* cannot be aliased that way without a branch in `reg()`, which
   * every renderer pays for on every tile. So the two bytes are instead kept in
   * step on the way in — every write to either goes through here — and the
   * invariant is that no reader can ever catch them disagreeing.
   */
  private syncVblankEnable(written: number): void {
    if (written === TMS_REG_1) {
      const enabled = (this.registers[TMS_REG_1]! & TMS_R1_INT_ENABLE) !== 0
      this.registers[REG_IRQEN] = enabled
        ? this.registers[REG_IRQEN]! | IRQ_VBLANK
        : this.registers[REG_IRQEN]! & ~IRQ_VBLANK
    } else if (written === REG_IRQEN) {
      const enabled = (this.registers[REG_IRQEN]! & IRQ_VBLANK) !== 0
      this.registers[TMS_REG_1] = enabled
        ? this.registers[TMS_REG_1]! | TMS_R1_INT_ENABLE
        : this.registers[TMS_REG_1]! & ~TMS_R1_INT_ENABLE
    }
  }

  /** Take every register to its §15 reset value. */
  private resetRegisters(): void {
    resetRegisterFile(this.registers)
  }

  // ================================================================
  //  Mode Detection
  // ================================================================

  private updateMode(): void {
    if (this.reg(TMS_REG_0) & TMS_R0_MODE_GRAPHICS_II) {
      this.mode = TmsMode.GRAPHICS_II
    } else {
      const bits = (this.reg(TMS_REG_1) & (TMS_R1_MODE_MULTICOLOR | TMS_R1_MODE_TEXT)) >> 3
      switch (bits) {
        case 1:  this.mode = TmsMode.MULTICOLOR; break
        case 2:  this.mode = TmsMode.TEXT; break
        default: this.mode = TmsMode.GRAPHICS_I; break
      }
    }
  }

  // ================================================================
  //  Table Address Helpers
  // ================================================================
  //
  // §5 widens every layer base field to eight bits so it can reach anywhere in
  // the 64 KB: `L0NAME` and `L0ATTR` are 1 KB granules (six bits meaningful),
  // `L0PAT` a 2 KB one (five). Masking to 16 bits after the shift is the same
  // thing said once. A legacy program's values land exactly where they used to.
  //
  // The sprite bases are widened the same way: `SPRATTR` keeps its ×$80 granule
  // over eight bits, reaching $7F80, and `SPRPAT` becomes a ×$800 granule over
  // eight, reaching $F800 — §5's figures, and the range §7's memory map puts an
  // 8 KB sprite pattern table at.

  private nameTableAddr(): number {
    return (this.reg(REG_L0NAME) << 10) & VRAM_MASK
  }

  /**
   * The name table read out as text, for a debugger.
   *
   * Every geometry lays its name table out the same way — one byte per cell,
   * row by row — so this needs only the grid, which the geometry carries: 40x24
   * in Text, 32x24 in Compact, 32x30 in Graphics, 40x30 in Full. Bytes are CP437
   * code points, per the BIOS's character generator; see CP437.ts.
   */
  textGrid(): string[] {
    const { cols, rows } = this.geometry()
    const base = this.nameTableAddr()

    const lines: string[] = []
    for (let row = 0; row < rows; row++) {
      let line = ''
      for (let col = 0; col < cols; col++) {
        line += CP437[this.vram[(base + row * cols + col) & VRAM_MASK]!]
      }
      lines.push(line)
    }
    return lines
  }

  /**
   * The attribute table base (§5, §9).
   *
   * ×`$400` like every other 1 KB granule — *except* in the legacy submode,
   * where it is ×`$40` so that a Graphics I program's 32-byte color table lands
   * where it wrote it. That reinterpretation is the one register whose meaning
   * the legacy submode changes, and §9 says so in as many words.
   */
  private attrTableAddr(legacy: boolean): number {
    return (this.reg(REG_L0ATTR) << (legacy ? 6 : 10)) & VRAM_MASK
  }

  private patternTableAddr(): number {
    return (this.reg(REG_L0PAT) << 11) & VRAM_MASK
  }

  private spriteAttrTableAddr(): number {
    return (this.reg(TMS_REG_SPRITE_ATTR_TABLE) << 7) & VRAM_MASK
  }

  private spritePatternTableAddr(): number {
    return (this.reg(TMS_REG_SPRITE_PATT_TABLE) << 11) & VRAM_MASK
  }

  // ================================================================
  //  Palette (§11)
  // ================================================================

  /** The first byte of the 512-byte palette window. */
  private paletteBase(): number {
    return (this.reg(REG_PALBASE) & PALETTE_BASE_MASK) << PALETTE_BASE_SHIFT
  }

  /** Re-expand one entry from the two VRAM bytes that hold it. */
  private cachePaletteEntry(entry: number): void {
    const address = this.paletteBase() + entry * 2
    const red = this.vram[address & VRAM_MASK]! & 0x0f
    const greenBlue = this.vram[(address + 1) & VRAM_MASK]!
    const offset = entry * 4
    this.paletteCache[offset] = red * CHANNEL_EXPAND
    this.paletteCache[offset + 1] = (greenBlue >> 4) * CHANNEL_EXPAND
    this.paletteCache[offset + 2] = (greenBlue & 0x0f) * CHANNEL_EXPAND
    this.paletteCache[offset + 3] = 0xff
  }

  /**
   * Re-read the whole window.
   *
   * Snooping keeps the cache current while the palette stays put; this is for
   * the three times it does not — a reset, a restored snapshot, and a write to
   * `PALBASE`, which §11 specifies as re-reading the whole window because the
   * card is now looking at 512 different bytes.
   */
  private reloadPalette(): void {
    for (let entry = 0; entry < PALETTE_ENTRIES; entry++) this.cachePaletteEntry(entry)
  }

  /**
   * Write the default palette into VRAM at `PALBASE`, and load the cache (§11).
   *
   * Reset clobbers those 512 bytes — §11 says so in as many words, and nothing
   * in the reset-time memory map lives there. It is written through VRAM rather
   * than straight into the cache because that is where the palette *is*: a
   * program that reads `$FC00` back after a reset must find the default palette
   * there, and `VideoScroll`-style block moves through the window have to see
   * the same bytes the screen does.
   */
  private installDefaultPalette(): void {
    const base = this.paletteBase()
    for (let entry = 0; entry < PALETTE_ENTRIES; entry++) {
      const rgb = DEFAULT_PALETTE[entry]!
      this.vram[(base + entry * 2) & VRAM_MASK] = (rgb >> 8) & 0x0f
      this.vram[(base + entry * 2 + 1) & VRAM_MASK] = rgb & 0xff
    }
    this.reloadPalette()
  }

  // ================================================================
  //  Color Helpers
  // ================================================================

  /**
   * The backdrop: palette entry `(L0PAL × 16) + (COLOR & $0F)` (§11).
   *
   * Behind every layer, outside the picture, and what a transparent pixel
   * resolves to. `L0PAL` is 0 at reset, so for a legacy program it is register
   * 7's low nibble in palette row 0, exactly as it has always been.
   */
  private backdropIndex(): number {
    return (this.paletteGroupHigh() << 4) | (this.reg(TMS_REG_FG_BG_COLOR) & 0x0f)
  }

  /** `L0PAL` b3:0 — which sixteen colors layer 0's nibbles name (§8). */
  private paletteGroupHigh(): number {
    return this.reg(REG_L0PAL) & 0x0f
  }

  // ================================================================
  //  Sprite Helpers
  // ================================================================

  private spriteSize(): number {
    return this.reg(TMS_REG_1) & TMS_R1_SPRITE_16 ? 16 : 8
  }

  private spriteMag(): boolean {
    return !!(this.reg(TMS_REG_1) & TMS_R1_SPRITE_MAG2)
  }

  private displayEnabled(): boolean {
    return !!(this.reg(TMS_REG_1) & TMS_R1_DISP_ACTIVE)
  }

  // ================================================================
  //  Interrupts (§14)
  // ================================================================

  /**
   * Latch an interrupt source, if it is enabled.
   *
   * A disabled source leaves no trace in `STAT1`, so a handler reading it sees
   * its own interrupts and nothing else. The flags in `STAT0` do not go through
   * here — b7, b6 and b5 set whether or not anything is enabled, which is what
   * makes polling work.
   */
  private fireInterrupt(source: number): void {
    if (this.reg(REG_IRQEN) & source) this.irqLatch |= source
  }

  /**
   * Clear every latched flag and release `/INT` (§6).
   *
   * Reading `STAT0` or `STAT1` does this. `STAT0` goes with them: the F, OVF and
   * COL flags and the sprite index field are cleared by a status read on the
   * TMS9918 and that has not changed.
   */
  private acknowledgeInterrupts(): void {
    this.stat0 = 0
    this.irqLatch = 0
    this.overflowSprite = 0
    // §10: the collision map clears when `STAT0` or `STAT1` is read, with the
    // sticky bit it details.
    this.collisionMap.fill(0)
  }

  // ================================================================
  //  Display Geometry and Blanking (§3)
  // ================================================================

  /**
   * True while `M1`/`M2`/`M3` choose the mode rather than `VMODE` (§9).
   *
   * The reset state, and where both acceptance targets live. It pins layer 0 to
   * 1bpp, picks its attribute source from the TMS9918 mode, and rescales
   * `L0ATTR`; `LxCTRL`'s enable and opacity bits still apply, and layer 1 is
   * unaffected.
   */
  private legacySubmode(): boolean {
    return VMODE_GEOMETRY[this.reg(REG_VMODE) & VMODE_MASK] === null
  }

  /**
   * The picture's geometry (§9).
   *
   * `VMODE` names one of the four directly; in the legacy submode the choice
   * comes from the TMS9918 mode bits instead, which offer only two — Text's
   * 40x24 of 6x8, and the 32x24 of 8x8 that Graphics I, Graphics II and
   * Multicolor all land in.
   */
  private geometry(): Geometry {
    return (
      VMODE_GEOMETRY[this.reg(REG_VMODE) & VMODE_MASK] ??
      (this.mode === TmsMode.TEXT ? GEOMETRY_TEXT : GEOMETRY_COMPACT)
    )
  }

  /** Lines of active picture in the current mode (§3, §9). */
  private activeLines(): number {
    return this.geometry().lines
  }

  /** `STAT3` b0: the picture has ended and the next one has not started. */
  private verticalBlanking(): boolean {
    return this.displayLine >= this.activeLines()
  }

  /**
   * `STAT3` b1: the last fifth of the current line (§3).
   *
   * Scanlines are rendered whole here, so there is no beam position to report —
   * only how far the CPU has run into the line, which the cycle accumulator
   * already holds and is the same quantity a program timing a raster effect
   * cares about. Before the first tick there is no line to be inside.
   */
  private horizontalBlanking(): boolean {
    return (
      this.cyclesPerScanline > 0 &&
      this.cycleAccumulator >= this.cyclesPerScanline * HBLANK_FRACTION
    )
  }

  // ================================================================
  //  Timing / Scanline Processing
  // ================================================================

  private processScanline(): void {
    // Read once and pass it down. A program is free to write `VMODE` or the
    // mode bits mid-frame, and a line that rendered against one geometry and
    // then decided where to put itself against another would tear in a way no
    // hardware does.
    const geometry = this.geometry()

    if (this.displayLine === 0) {
      this.fillBackground()
      // The sprite flags describe one picture: `OVF`, `COL`, the index field
      // and the collision map all say "this happened while drawing this frame"
      // (§10), and each frame starts with none of it having happened. `F` is
      // not one of them — it says the picture *ended*, and only a status read
      // clears it (§6), which is what lets a program poll for it.
      this.stat0 &= STAT0_F
      this.overflowSprite = 0
      this.collisionMap.fill(0)
    }

    // Scanline compare fires at the start of the matching line (§14). `IRQLINE`
    // is eight bits and the display line runs to 261, so lines 256-261 cannot be
    // named — the comparison below is where that falls out, and §14 says nothing
    // useful happens there anyway.
    if (this.displayLine === this.reg(REG_IRQLINE)) {
      this.fireInterrupt(IRQ_SCANLINE)
    }

    if (this.displayLine < geometry.lines) {
      this.renderScanline(this.displayLine, geometry)
    }

    // The end of the active picture (§14) — display line 192 in Text and
    // Compact, 240 in Graphics and Full. Raised as the last active line
    // finishes, which is the same instant as the start of the line after it and
    // is where the TMS9918 emulation this grew out of raised F.
    //
    // The flag sets whether or not the interrupt is enabled, and whether or not
    // the display is on. That is the divergence this phase exists to fix: the
    // old code gated it on register 1's IE bit, so a program polling `STAT0`
    // for vertical blank with interrupts off waited forever.
    if (this.displayLine === geometry.lines - 1) {
      this.stat0 |= STAT0_F
      this.fireInterrupt(IRQ_VBLANK)
    }

    this.displayLine++
    if (this.displayLine >= TOTAL_SCANLINES) {
      // Frame complete – copy back buffer to front buffer
      this.backBuffer.copy(this.buffer)
      this.indexBuffer.set(this.backIndexBuffer)
      this.frameReady = true
      this.displayLine = 0
    }
  }

  // ================================================================
  //  The Tile Engine (§8)
  // ================================================================

  /**
   * One display line of the picture.
   *
   * Backdrop first, then layer 0 over it, then sprites over that — §12's
   * priority order with the two levels that exist so far. Layer 1 and the full
   * six-level resolution arrive in Phase 7.
   *
   * The backdrop pre-fill is not wasted work on top of an opaque layer: it is
   * what a transparent pixel resolves to, and at 2, 4 and 8bpp the engine
   * simply does not write those pixels.
   */
  private renderScanline(y: number, geometry: Geometry): void {
    const pixels = this.scanlinePixels
    const legacy = this.legacySubmode()

    pixels.fill(this.backdropIndex(), 0, geometry.width)

    if (this.displayEnabled()) {
      if (this.reg(REG_L0CTRL) & LXCTRL_ENABLE) this.drawLayer0(y, pixels, geometry, legacy)
      // The TMS9918 has no sprites in Text mode and the legacy submode is the
      // TMS9918. Every `VMODE` geometry has them, Text's 40x24 included (§10).
      if (!(legacy && this.mode === TmsMode.TEXT)) this.drawSprites(y, pixels, geometry, legacy)
    }

    this.writeScanlineToBuffer(y + geometry.originY, pixels, geometry)
  }

  /**
   * Layer 0, one scanline, at whatever depth and attribute source it is set to.
   *
   * This is the engine the four mode-specific renderers became. Every mode is a
   * name table mapping cells to patterns, a pattern table of pixels, and a
   * source of color (§8); Graphics I is this with the attribute source set to
   * per-pattern-group, and Text is this with no attribute fetch at all.
   *
   * The parameters are read once per line rather than once per cell — a program
   * that changes them mid-line is doing something the hardware cannot do either.
   */
  private drawLayer0(y: number, pixels: Uint8Array, geometry: Geometry, legacy: boolean): void {
    const control = this.reg(REG_L0CTRL)

    // §9: the legacy submode pins depth and attribute source and ignores
    // `L0CTRL`'s fields for both. Its opacity and enable bits still apply.
    const depth = legacy ? DEPTH_1BPP : control & LXCTRL_DEPTH
    const attributeSource = legacy
      ? this.mode === TmsMode.TEXT
        ? ATTR_NONE
        : ATTR_PER_GROUP
      : (control & LXCTRL_ATTR_SOURCE) >> 2

    const opaque = (control & LXCTRL_INDEX0_OPAQUE) !== 0
    const backdrop = this.backdropIndex()
    const paletteHigh = this.paletteGroupHigh() << 4
    const colorRegister = this.reg(TMS_REG_FG_BG_COLOR)

    const nameBase = this.nameTableAddr()
    const attrBase = this.attrTableAddr(legacy)
    const patternBase = this.patternTableAddr()

    const row = y & (CELL_HEIGHT - 1)
    const cellRow = (y / CELL_HEIGHT) | 0
    const cellBase = cellRow * geometry.cols
    const nameRow = nameBase + cellBase

    // The 1bpp case is both the legacy path and the hot one, so it gets its own
    // loop: the color byte resolves to two palette indices before the pixels
    // are touched, leaving a branchless inner loop over the pattern's bits.
    const oneBpp = depth === DEPTH_1BPP
    const bits = DEPTH_BITS[depth]!
    const valueMask = (1 << bits) - 1
    const pixelsPerByte = 8 / bits
    const byteShift = 3 - depth
    const tileBytes = CELL_HEIGHT << depth
    const rowBytes = 1 << depth

    for (let col = 0; col < geometry.cols; col++) {
      let pattern = this.vram[(nameRow + col) & VRAM_MASK]!

      // §8's four attribute sources. `NONE` at 1bpp is coloured by `COLOR`,
      // which is what makes today's text mode need no attribute table at all;
      // at the other depths it means sub-palette 0, no flip, no ninth pattern
      // bit — which is what an all-zero attribute byte already says.
      let attribute: number
      switch (attributeSource) {
        case ATTR_PER_CELL:
          attribute = this.vram[(attrBase + cellBase + col) & VRAM_MASK]!
          break
        case ATTR_PER_GROUP:
          attribute = this.vram[(attrBase + (pattern >> 3)) & VRAM_MASK]!
          break
        case ATTR_PER_ROW:
          attribute = this.vram[(attrBase + pattern * CELL_HEIGHT + row) & VRAM_MASK]!
          break
        default:
          attribute = oneBpp ? colorRegister : 0
          break
      }

      const left = col * geometry.cellWidth

      if (oneBpp) {
        // §8: foreground in b7:4, background in b3:0, each a 4-bit index into
        // the sixteen colors `L0PAL` names. Either nibble being 0 is
        // transparent unless index 0 is opaque — the TMS9918's rule, applied to
        // both halves of the byte exactly as it was there.
        const foreground = attribute >> 4
        const background = attribute & 0x0f
        const fgIndex = foreground === 0 && !opaque ? backdrop : paletteHigh | foreground
        const bgIndex = background === 0 && !opaque ? backdrop : paletteHigh | background

        let pixelBits = this.vram[(patternBase + pattern * PATTERN_BYTES + row) & VRAM_MASK]!
        for (let x = 0; x < geometry.cellWidth; x++) {
          pixels[left + x] = pixelBits & 0x80 ? fgIndex : bgIndex
          pixelBits = (pixelBits << 1) & 0xff
        }
        continue
      }

      // 2, 4 and 8bpp: the same byte is an attribute byte instead (§8). 8bpp
      // ignores the sub-palette — one group of 256 covers the whole palette —
      // and the ninth pattern bit, there being no room for 512 tiles of 64
      // bytes in 64 KB.
      if (depth !== DEPTH_8BPP && (attribute & ATTR_PATTERN_BIT8) !== 0) pattern |= 0x100
      const patternRow = (attribute & ATTR_FLIP_Y) !== 0 ? CELL_HEIGHT - 1 - row : row
      const rowAddress = patternBase + pattern * tileBytes + patternRow * rowBytes

      // §8's palette mapping: group `LxPAL × 16 + subpal`, each group `2^bpp`
      // entries wide, and the index `(group × 2^bpp + value) & $FF`. At 8bpp
      // that arithmetic leaves nothing of the group, which is the table's way of
      // saying the value *is* the palette index.
      const groupBase = ((paletteHigh | (attribute & ATTR_SUBPALETTE)) << bits) & 0xff
      const flipX = (attribute & ATTR_FLIP_X) !== 0

      for (let x = 0; x < geometry.cellWidth; x++) {
        // Flipping mirrors the pixels that are drawn, which in Text mode is the
        // leftmost six rather than all eight — the alternative would mirror the
        // cell and then show the wrong half of it.
        const from = flipX ? geometry.cellWidth - 1 - x : x
        const byte = this.vram[(rowAddress + (from >> byteShift)) & VRAM_MASK]!
        const shift = (pixelsPerByte - 1 - (from & (pixelsPerByte - 1))) * bits
        const value = (byte >> shift) & valueMask
        if (value !== 0 || opaque) pixels[left + x] = groupBase + value
      }
    }
  }

  // ================================================================
  //  Sprites (§10)
  // ================================================================

  /**
   * Every sprite that covers one display line, composited over the layer.
   *
   * 64 slots, `SPRCOUNT` of them evaluated in table order, up to `SPRLIMIT` of
   * them drawn. Lower indices win the pixel and the excess on a line is dropped
   * for that line only, with `STAT0` b6 and `STAT7` recording the first
   * casualty. Nothing rotates the starting slot, so the dropped sprites are the
   * same ones every frame: §10 says sprites do not flicker and that anyone who
   * wants flicker implements it.
   *
   * Sprites draw above layer 0 and below nothing, which is as much of §12's
   * priority order as one layer can express. The attribute byte's b6 — the bit
   * that lifts a sprite above layer 1 — is Phase 7's, with the compositor.
   *
   * The parameters are read once per line, not once per sprite: a program that
   * changes the sprite size halfway down a line is describing something the
   * hardware cannot do either.
   */
  private drawSprites(y: number, pixels: Uint8Array, geometry: Geometry, legacy: boolean): void {
    const control = this.reg(REG_SPRCTRL)
    if ((control & SPRCTRL_ENABLE) === 0) return

    // §9: the legacy submode pins sprites to 1bpp whatever `SPRCTRL` b5:4 says,
    // exactly as it pins layer 0's depth.
    const depth = legacy ? DEPTH_1BPP : (control & SPRCTRL_DEPTH) >> 4
    const collisionEnabled = (control & SPRCTRL_COLLISION) !== 0
    const detailed = (control & SPRCTRL_DETAILED) !== 0
    const terminates = (control & SPRCTRL_TERMINATOR) !== 0

    // `SPRCOUNT` bounds the table and `SPRLIMIT` the line (§5), both against a
    // hardware ceiling. §10 gives `SPRLIMIT` the range 1-32 and says nothing
    // about 0; the comparison below draws nothing for it, which needs no
    // special case to mean something coherent.
    const slots = Math.min(this.reg(REG_SPRCOUNT), SPRITE_SLOTS)
    const limit = Math.min(this.reg(REG_SPRLIMIT), SPRITE_LIMIT_MAX)

    const size = this.spriteSize()
    const magnified = this.spriteMag()
    const screenSize = magnified ? size * 2 : size
    const attrTable = this.spriteAttrTableAddr()
    const patternTable = this.spritePatternTableAddr()

    // §10's palette mapping is §8's with `SPRPAL` in `LxPAL`'s place: the index
    // of a pixel is `((SPRPAL × 16 + subpal) × 2^bpp + value) & $FF`.
    const paletteHigh = (this.reg(REG_SPRPAL) & 0x0f) << 4

    const bits = DEPTH_BITS[depth]!
    const valueMask = (1 << bits) - 1
    const pixelsPerByte = 8 / bits
    const byteShift = 3 - depth
    const rowBytes = 1 << depth
    /** One 8x8 quadrant; a 16x16 sprite is four of them, 8x8 is one (§10). */
    const quadrantBytes = SPRITE_QUADRANT << depth
    const patternBytes = size === 16 ? quadrantBytes * 4 : quadrantBytes

    const owner = this.spriteLineOwner
    const painted = this.spriteLinePainted
    let drawn = 0

    for (let slot = 0; slot < slots; slot++) {
      const attributeBase = attrTable + slot * SPRITE_ATTR_BYTES
      const topByte = this.vram[(attributeBase + SPRITE_ATTR_Y) & VRAM_MASK]!

      // §10: while `SPRCTRL` b2 is set — the reset state — a Y of `$D0` ends
      // the list here, as on the TMS9918.
      if (terminates && topByte === SPRITE_TERMINATOR) break

      // Y is the top edge as a display line, so a magnified sprite covers twice
      // as many lines from the same origin and each pattern row is drawn twice.
      const top = topByte >= SPRITE_Y_NEGATIVE ? topByte - 256 : topByte
      let row = y - top
      if (magnified) row >>= 1
      if (row < 0 || row >= size) continue

      // §10: when more than `SPRLIMIT` sprites cover a line the excess is
      // dropped, highest indices first — which, evaluating in table order, is
      // the same thing as stopping at the first one that does not fit.
      if (drawn >= limit) {
        this.reportOverflow(slot)
        break
      }

      // The line buffer holds one line, and only a line with a sprite on it
      // needs holding: this is what makes a sprite-free line free.
      if (drawn === 0) {
        owner.fill(0, 0, geometry.width)
        painted.fill(0, 0, geometry.width)
      }
      drawn++

      const attributes = this.vram[(attributeBase + SPRITE_ATTR_ATTRIBUTES) & VRAM_MASK]!
      const xByte = this.vram[(attributeBase + SPRITE_ATTR_X) & VRAM_MASK]!

      // §10: X is nine bits, b8 from the attribute byte, and 384-511 mean
      // -128…-1 — one rule in every mode, no reinterpretation. In the legacy
      // submode that same bit is the TMS9918's early clock and shifts the
      // sprite 32 pixels left rather than 256 (§9).
      let left: number
      if (legacy) {
        left = attributes & SPRITE_EARLY_CLOCK ? xByte - SPRITE_EARLY_CLOCK_PIXELS : xByte
      } else {
        const x = ((attributes & SPRITE_X_BIT8) << 1) | xByte
        left = x >= SPRITE_X_NEGATIVE ? x - SPRITE_X_RANGE : x
      }

      const from = left < 0 ? 0 : left
      const to = Math.min(left + screenSize, geometry.width)
      if (from >= to) continue // entirely off one side of the picture

      // §10: flipping applies to the whole sprite, quadrant arrangement
      // included, so it is applied in sprite space before the quadrant is
      // chosen. The legacy submode does not except b4 and b5 — §9 reinterprets
      // b7 and b3:0 and says nothing about the rest — and on a TMS9918 these
      // two were unused bits a program was told to write as zero.
      const patternRow = attributes & ATTR_FLIP_Y ? size - 1 - row : row
      const flipX = (attributes & ATTR_FLIP_X) !== 0

      // §10: a 16x16 sprite is four consecutive 8x8 patterns, so the index's
      // low two bits are ignored — the TMS9918's rule, now at every depth.
      let pattern = this.vram[(attributeBase + SPRITE_ATTR_PATTERN) & VRAM_MASK]!
      if (size === 16) pattern &= ~0x03
      const patternAddress = patternTable + pattern * patternBytes

      // The group §10's mapping counts from, `SPRPAL × 16 + subpal`, and the
      // first palette entry in it.
      //
      // In the legacy submode the group number *is* the palette index: §9 makes
      // b3:0 a direct index rather than a sub-palette, which is §8's 1bpp rule
      // with `SPRPAL` naming the sixteen colours it indexes — and `SPRPAL`
      // resets to 0, so for a legacy program they are palette row 0, exactly
      // the TMS9918's sixteen.
      const group = paletteHigh | (attributes & SPRITE_SUBPALETTE)
      const groupBase = (group << bits) & 0xff

      // Colour 0 on a TMS9918 is invisible but not absent: it collides, and it
      // does not occlude the sprite behind it. That is the whole point of the
      // idiom, so the pixels are walked and only the write is skipped.
      const invisible = legacy && (attributes & SPRITE_SUBPALETTE) === 0

      for (let x = from; x < to; x++) {
        let column = x - left
        if (magnified) column >>= 1
        const patternColumn = flipX ? size - 1 - column : column

        // The four quadrants of a 16x16 pattern are in TMS9918 order: top
        // left, bottom left, top right, bottom right (§10).
        const quadrant = size === 16 ? ((patternColumn >> 3) << 1) | (patternRow >> 3) : 0
        const address =
          patternAddress +
          quadrant * quadrantBytes +
          (patternRow & 7) * rowBytes +
          ((patternColumn & 7) >> byteShift)
        const byte = this.vram[address & VRAM_MASK]!
        const shift = (pixelsPerByte - 1 - ((patternColumn & 7) & (pixelsPerByte - 1))) * bits
        const value = (byte >> shift) & valueMask

        // §10: a pattern value of 0 is always transparent, at every depth.
        if (value === 0) continue

        // Collision is tested before priority resolution (§10, §12): a sprite
        // hidden behind another sprite — or behind a layer — still collides.
        const covering = owner[x]!
        if (covering === 0) {
          owner[x] = slot + 1
        } else if (collisionEnabled) {
          this.reportCollision(covering - 1, slot, detailed)
        }

        // Priority among sprites is the table index (§10), so the pixel belongs
        // to whichever sprite painted it first.
        if (painted[x] !== 0 || invisible) continue
        painted[x] = 1
        pixels[x] = legacy ? group : groupBase + value
      }
    }
  }

  /**
   * A line that dropped a sprite (§6, §10, §14).
   *
   * `STAT0` b4:0 and `STAT7` answer two different questions. b4:0 latches the
   * first sprite dropped in the frame and is sticky with the `OVF` bit beside
   * it; `STAT7` follows the most recent overflowing line, and is the only one
   * of the two that can name slots 32-63 at all. The interrupt is the first
   * dropping line's, not every line's, which §14's "first line on which
   * sprites are dropped" is the sticky bit's job to mean.
   */
  private reportOverflow(slot: number): void {
    if ((this.stat0 & STAT0_OVF) === 0) {
      this.stat0 |= STAT0_OVF | (slot & STAT0_SPRITE_INDEX)
      this.fireInterrupt(IRQ_OVERFLOW)
    }
    this.overflowSprite = slot
  }

  /**
   * Two sprites on one pixel (§10, §14).
   *
   * The sticky bit is always maintained and costs nothing. The 64-bit map is
   * the opt-in half — §18 prices the owner index the line buffer has to carry
   * at about 500 cycles on a worst-case line — and marks **both** members of
   * every pair, which for three sprites on one pixel means the lowest is paired
   * with each of the others and all three end up named.
   *
   * The interrupt is the frame's first colliding pixel (§14); the sticky bit is
   * again what makes that one interrupt rather than one per pixel.
   */
  private reportCollision(first: number, second: number, detailed: boolean): void {
    if ((this.stat0 & STAT0_COL) === 0) {
      this.stat0 |= STAT0_COL
      this.fireInterrupt(IRQ_COLLISION)
    }
    if (!detailed) return
    this.collisionMap[first >> 3] |= 1 << (first & 7)
    this.collisionMap[second >> 3] |= 1 << (second & 7)
  }

  // ================================================================
  //  Buffer Management
  // ================================================================

  /**
   * Fill the entire back buffer with the backdrop (§11).
   *
   * Run once at the top of each frame, so the border is the backdrop as it
   * stood when the frame began. The picture is drawn over it line by line; the
   * lines a 192-line geometry does not reach, and the columns outside the
   * picture in every geometry, are what is left of this.
   */
  private fillBackground(): void {
    const bgIdx = this.backdropIndex()
    const entry = bgIdx * 4
    const r = this.paletteCache[entry]!
    const g = this.paletteCache[entry + 1]!
    const b = this.paletteCache[entry + 2]!
    const a = this.paletteCache[entry + 3]!
    for (let i = 0; i < this.backBuffer.length; i += 4) {
      this.backBuffer[i] = r
      this.backBuffer[i + 1] = g
      this.backBuffer[i + 2] = b
      this.backBuffer[i + 3] = a
    }
    this.backIndexBuffer.fill(bgIdx)
  }

  /**
   * Write a rendered scanline into the back buffer, at the picture's position.
   *
   * `screenY` is a frame line, not a display line: the caller has already added
   * the geometry's vertical origin, which is 24 in the 192-line modes and 0 in
   * the 240-line ones. Columns outside the picture are not touched — they are
   * backdrop from `fillBackground`.
   *
   * Indices are eight bits wide now. The tile engine reaches all 256 entries
   * through `LxPAL` and the sub-palette, so the mask that used to keep this to
   * the TMS9918's row 0 would now be a way of losing pixels.
   */
  private writeScanlineToBuffer(screenY: number, pixels: Uint8Array, geometry: Geometry): void {
    if (screenY < 0 || screenY >= DISPLAY_HEIGHT) return

    const rowOffset = (screenY * DISPLAY_WIDTH + geometry.originX) * 4
    const indexRowOffset = screenY * DISPLAY_WIDTH + geometry.originX
    for (let x = 0; x < geometry.width; x++) {
      const index = pixels[x]!
      const offset = rowOffset + x * 4
      const entry = index * 4
      this.backBuffer[offset] = this.paletteCache[entry]!
      this.backBuffer[offset + 1] = this.paletteCache[entry + 1]!
      this.backBuffer[offset + 2] = this.paletteCache[entry + 2]!
      this.backBuffer[offset + 3] = this.paletteCache[entry + 3]!
      this.backIndexBuffer[indexRowOffset + x] = index
    }
  }

  // ================================================================
  //  Public Accessors (testing / debugging)
  // ================================================================

  /**
   * Read a VDP register, resolving the `$02`-`$06` aliases (§5).
   *
   * Seven bits of index now, not three: `getRegister(0x02)` and
   * `getRegister(0x10)` are the same byte, because on the hardware they are.
   */
  getRegister(reg: number): number {
    return this.reg(reg & REGISTER_MASK)
  }

  /** Write a VDP register directly (bypasses the command port's staging) */
  setRegister(reg: number, value: number): void {
    const index = REGISTER_ALIAS[reg & REGISTER_MASK]!
    this.registers[index] = value & 0xff
    this.syncVblankEnable(index)
    if (index === REG_PALBASE) this.reloadPalette()
    this.updateMode()
  }

  /** Read a VRAM byte directly (does not affect read-ahead buffer) */
  getVramByte(addr: number): number {
    return this.vram[addr & VRAM_MASK]
  }

  /** Write a VRAM byte directly (does not affect address pointer) */
  setVramByte(addr: number, value: number): void {
    this.poke(addr & VRAM_MASK, value)
  }

  /**
   * The frame as palette indices, for golden comparison. Debug only.
   *
   * `buffer` is the same frame after the palette lookup, and that lookup is
   * where a golden stops being able to tell a renderer bug from a change of
   * color: two indices that happen to share an RGBA value are indistinguishable
   * in it, and any change to the palette moves every pixel. This is the frame
   * before that, one byte per pixel, in the same row-major order — so a program
   * that draws the same picture produces byte-identical output here whatever the
   * palette holds. PLAN.md §3 makes it the strict oracle for the VDP rewrite,
   * with `buffer` kept beside it as the artifact a human can look at.
   *
   * A full frame, like `buffer`: written from the back buffer only when a frame
   * completes. Border pixels carry the backdrop index. Live, not a copy —
   * a caller keeping it across frames must copy it.
   */
  frameIndices(): Uint8Array {
    return this.indexBuffer
  }

  /**
   * One palette entry as the card has it cached, 12-bit `$RGB` (§11). Debug only.
   *
   * The palette lives in VRAM and `getVramByte` will read it there, but that is
   * what a program *stored*, not what the card will *draw*. The two part company
   * exactly when the cache is stale, which is the failure the snoop exists to
   * prevent, so a test that reads the stored bytes cannot see it. This is the
   * drawn side. All 256 entries, of which the legacy renderers reach row 0.
   */
  paletteEntry(index: number): number {
    const offset = (index & 0xff) * 4
    return (
      ((this.paletteCache[offset]! / CHANNEL_EXPAND) << 8) |
      ((this.paletteCache[offset + 1]! / CHANNEL_EXPAND) << 4) |
      this.paletteCache[offset + 2]! / CHANNEL_EXPAND
    )
  }

  /**
   * Peek at `STAT0` without the side effects of reading it (§6).
   *
   * A real status read acknowledges — it clears the flags and releases `/INT` —
   * so a debugger or a test that wants to know what the card is showing has to
   * come in by another door, or looking changes the answer.
   */
  getStatus(): number {
    return this.stat0
  }

  /**
   * The display line being scanned, 0 – 261 (§3). Debug only.
   *
   * Counted from the first line of the picture in the current mode, like
   * `IRQLINE` and `STAT2` — not from the top of the frame.
   */
  getDisplayLine(): number {
    return this.displayLine
  }

  /** Get the current display mode */
  getMode(): TmsMode {
    return this.mode
  }

  /** Get the display-enabled state */
  isDisplayEnabled(): boolean {
    return this.displayEnabled()
  }

  //
  // Snapshots
  //

  /**
   * Registers, VRAM and the scanline position — but not the framebuffers.
   *
   * The two 320x240 RGBA buffers are 300 KB each, and they are pure output:
   * every pixel in them is derived from VRAM and the registers, which are here.
   * Carrying them would multiply a 70 KB snapshot by nine to store something the
   * VDP redraws by itself within one emulated frame.
   *
   * The cost is worth stating plainly: immediately after a restore, `screen.png`
   * still shows the frame that was on screen before it, until the machine has run
   * a frame's worth of cycles. `screen.text` is correct at once, because it reads
   * the name table rather than pixels.
   *
   * `mode` is absent for a different reason — it is derived from registers 0 and
   * 1, so recomputing it is both cheaper and safer than trusting a stored copy
   * that could contradict them.
   *
   * The shape changed with the VDP: 128 registers rather than 8, 64 KB of VRAM
   * rather than 16, and two port pairs rather than one set of loose fields.
   * Snapshots carry a schema version for exactly this, and it is bumped to 2 —
   * a version 1 snapshot describes a TMS9918 and there is no honest way to read
   * one as this card.
   */
  serialize(): DeviceState {
    return {
      kind: this.kind,
      registers: toBase64(this.registers),
      stat0: this.stat0,
      irqLatch: this.irqLatch,
      overflowSprite: this.overflowSprite,
      collisionMap: toBase64(this.collisionMap),
      ports: [this.portA.serialize(), this.portB.serialize()],
      vram: toBase64(this.vram),
      cycleAccumulator: this.cycleAccumulator,
      displayLine: this.displayLine,
      frameReady: this.frameReady
    }
  }

  deserialize(state: DeviceState): void {
    expectKind(state, this.kind)
    this.registers.set(readBytes(state, 'registers', NUM_REGISTERS))
    this.stat0 = readNumber(state, 'stat0') & 0xff
    this.irqLatch = readNumber(state, 'irqLatch') & 0x0f
    this.overflowSprite = readNumber(state, 'overflowSprite') & 0x3f
    this.collisionMap.set(readBytes(state, 'collisionMap', COLLISION_MAP_BYTES))
    const ports = readStates(state, 'ports', 2)
    this.portA.deserialize(ports[0]!)
    this.portB.deserialize(ports[1]!)
    this.vram.set(readBytes(state, 'vram', VRAM_SIZE))
    this.cycleAccumulator = readNumber(state, 'cycleAccumulator')
    this.displayLine = readNumber(state, 'displayLine') % TOTAL_SCANLINES
    this.frameReady = readBoolean(state, 'frameReady')

    // The register file arrives as bytes, which is the one path into it that
    // does not go through `setRegister`. `IRQEN` b0 is the home of the vblank
    // enable (§14), so it is the one that decides if a hand-edited snapshot
    // has the two copies disagreeing.
    this.syncVblankEnable(REG_IRQEN)
    this.updateMode()
    // VRAM and `PALBASE` both arrived wholesale, so the cache describes the
    // previous machine's palette until it is read again (§11).
    this.reloadPalette()
    // Start the redraw from the restored backdrop rather than the previous
    // machine's picture, so the frame in progress is not a blend of the two.
    this.fillBackground()
  }

}