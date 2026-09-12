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
 * the new bus, register file and VRAM with the TMS9918's four mode-specific
 * renderers still running on top of them. Everything below the register file is
 * still the old chip and is replaced in Phases 2–7. The goldens in
 * `src/tests/goldens/` are what keeps the picture honest in between.
 *
 * Ports (§4), decoded from A1:A0 and mirrored across `$9C00`-`$9FFF`:
 *   `$9C00` VC_DATA   / `$9C01` VC_REG   — VRAM data and command/status, port A
 *   `$9C02` VC_DATA2  / `$9C03` VC_REG2  — the same again, port B
 *
 * Display modes, for now still the TMS9918's four:
 *   Graphics I   - 32x24 tiles, 8x8 patterns, 1-of-8 color groups
 *   Graphics II  - 32x24 tiles, 8x8 patterns, per-row color
 *   Text         - 40x24 tiles, 6x8 patterns, no sprites
 *   Multicolor   - 32x24 blocks, 4x4 colored cells
 *
 * Output: 256x192 active area centered in a 320x240 RGBA buffer
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

// TMS9918 Palette – RGBA bytes (transparent rendered as opaque black)
const TMS_PALETTE: ReadonlyArray<readonly [number, number, number, number]> = [
  [0x00, 0x00, 0x00, 0xFF], // 0  Transparent (opaque black on display)
  [0x00, 0x00, 0x00, 0xFF], // 1  Black
  [0x21, 0xC9, 0x42, 0xFF], // 2  Medium Green
  [0x5E, 0xDC, 0x78, 0xFF], // 3  Light Green
  [0x54, 0x55, 0xED, 0xFF], // 4  Dark Blue
  [0x7D, 0x75, 0xFC, 0xFF], // 5  Light Blue
  [0xD3, 0x52, 0x4D, 0xFF], // 6  Dark Red
  [0x43, 0xEB, 0xF6, 0xFF], // 7  Cyan
  [0xFD, 0x55, 0x54, 0xFF], // 8  Medium Red
  [0xFF, 0x79, 0x78, 0xFF], // 9  Light Red
  [0xD3, 0xC1, 0x53, 0xFF], // 10 Dark Yellow
  [0xE5, 0xCE, 0x80, 0xFF], // 11 Light Yellow
  [0x21, 0xB0, 0x3C, 0xFF], // 12 Dark Green
  [0xC9, 0x5B, 0xBA, 0xFF], // 13 Magenta
  [0xCC, 0xCC, 0xCC, 0xFF], // 14 Grey
  [0xFF, 0xFF, 0xFF, 0xFF], // 15 White
]

// VRAM (§7) — 64 KB, flat, addressed as a 16-bit space.
const VRAM_SIZE = 1 << 16       // 64KB
const VRAM_MASK = VRAM_SIZE - 1  // 0xFFFF

// Active display resolution
const TMS_PIXELS_X = 256
const TMS_PIXELS_Y = 192

// Output buffer resolution
export const DISPLAY_WIDTH = 320
export const DISPLAY_HEIGHT = 240

// Tile / character layout
const GRAPHICS_NUM_COLS = 32
const GRAPHICS_CHAR_WIDTH = 8
const TEXT_NUM_COLS = 40
const TEXT_CHAR_WIDTH = 6
const TEXT_PADDING_PX = 8

// Pattern table
const PATTERN_BYTES = 8
const GFXI_COLOR_GROUP_SIZE = 8

// Sprites
const MAX_SPRITES = 32
const SPRITE_ATTR_Y = 0
const SPRITE_ATTR_X = 1
const SPRITE_ATTR_NAME = 2
const SPRITE_ATTR_COLOR = 3
const SPRITE_ATTR_BYTES = 4
const LAST_SPRITE_YPOS = 0xD0
const MAX_SCANLINE_SPRITES = 4

// Status register flags
const STATUS_INT = 0x80
const STATUS_5S = 0x40
const STATUS_COL = 0x20

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
const REG_L1CTRL = 0x1d
const REG_SPRATTR = 0x20
const REG_SPRPAT = 0x21
const REG_SPRCOUNT = 0x22
const REG_SPRCTRL = 0x23
const REG_SPRLIMIT = 0x24

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

// Border offsets (centering 256x192 in 320x240)
const BORDER_X = (DISPLAY_WIDTH - TMS_PIXELS_X) / 2   // 32
const BORDER_Y = (DISPLAY_HEIGHT - TMS_PIXELS_Y) / 2  // 24

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

  /** Status register (read-only from CPU side) */
  private status: number = 0

  /**
   * The two port pairs (§4). Port A is `$9C00`/`$9C01`, port B `$9C02`/`$9C03`.
   */
  private readonly portA = new VideoPort()
  private readonly portB = new VideoPort()

  /** Current display mode (derived from registers) */
  private mode: TmsMode = TmsMode.GRAPHICS_I

  /** 64 KB Video RAM (§7) */
  private vram = new Uint8Array(VRAM_SIZE)

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
    this.vram[offset & VRAM_MASK] = value & 0xff
  }

  /** Per-pixel sprite collision mask for the current scanline */
  private rowSpriteBits = new Uint8Array(TMS_PIXELS_X)

  /** Temporary scanline pixel buffer (color palette indices) */
  private scanlinePixels = new Uint8Array(TMS_PIXELS_X)

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

  /** Cycle accumulator for scanline timing */
  private cycleAccumulator: number = 0

  /** Current scanline being processed (0 – 261) */
  private currentScanline: number = 0

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
    const cyclesPerScanline = cyclesPerFrame / TOTAL_SCANLINES

    this.cycleAccumulator++

    while (this.cycleAccumulator >= cyclesPerScanline) {
      this.cycleAccumulator -= cyclesPerScanline
      this.processScanline()
    }

    // Return IRQ status based on interrupt flag in status register
    return (this.status & STATUS_INT) ? 0x80 : 0
  }

  reset(coldStart: boolean): void {
    this.status = 0
    // Both port pairs: pointer 0, direction read, flip-flop cleared (§15).
    this.portA.reset()
    this.portB.reset()
    this.resetRegisters()
    this.cycleAccumulator = 0
    this.currentScanline = 0
    this.updateMode()
    // A warm reset leaves VRAM alone — the chip has no clear-on-reset and the
    // image survives a RESET pulse on hardware, matching the C reference.
    // A cold start is a power cycle, and every other memory card (RAM,
    // RAMBank) zeroes itself for one; leaving the last frame's tiles and
    // patterns behind made "power cycle" mean something different for the
    // video card than for the rest of the machine.
    if (coldStart) this.vram.fill(0)
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
    this.vram[port.pointer] = data
    this.advance(port)
  }

  /**
   * Read the status register named by this port's `STATSEL`, and reset the
   * port's command flip-flop (§6).
   *
   * Phase 2 gives `STATSEL` its meaning: for now only `STAT0` exists, which is
   * what both ports select at reset.
   */
  private readStatus(port: VideoPort): number {
    const value = this.status
    this.status = 0
    port.stage = 0
    return value
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
  // Still the TMS9918's narrow base fields: `L0NAME` masked to 4 bits, the
  // pattern bases to 3. §5 widens all of them to 8 so they can reach anywhere in
  // the 64 KB, but that belongs with the renderer that uses the extra range —
  // Phase 4, where the four mode-specific renderers below become one engine.
  // Widening them here would give programs addresses the renderers cannot draw
  // from, and would move the goldens for no gain. Legacy values land in exactly
  // the same place either way.

  private nameTableAddr(): number {
    return (this.reg(TMS_REG_NAME_TABLE) & 0x0F) << 10
  }

  /**
   * The name table read out as text, for a debugger.
   *
   * Every mode lays its name table out as one byte per 8-pixel-tall tile row,
   * so this doesn't need to know how each mode paints pixels — only its column
   * count, which text mode alone widens to 40. Bytes are CP437 code points,
   * per the BIOS's character generator; see CP437.ts.
   */
  textGrid(): string[] {
    const cols = this.mode === TmsMode.TEXT ? TEXT_NUM_COLS : GRAPHICS_NUM_COLS
    const rows = TMS_PIXELS_Y / 8
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

  private colorTableAddr(): number {
    const mask = this.mode === TmsMode.GRAPHICS_II ? 0x80 : 0xFF
    return (this.reg(TMS_REG_COLOR_TABLE) & mask) << 6
  }

  private patternTableAddr(): number {
    const mask = this.mode === TmsMode.GRAPHICS_II ? 0x04 : 0x07
    return (this.reg(TMS_REG_PATTERN_TABLE) & mask) << 11
  }

  private spriteAttrTableAddr(): number {
    return (this.reg(TMS_REG_SPRITE_ATTR_TABLE) & 0x7F) << 7
  }

  private spritePatternTableAddr(): number {
    return (this.reg(TMS_REG_SPRITE_PATT_TABLE) & 0x07) << 11
  }

  // ================================================================
  //  Color Helpers
  // ================================================================

  /** Backdrop / border color (low nibble of register 7) */
  private mainBgColor(): number {
    return this.reg(TMS_REG_FG_BG_COLOR) & 0x0F
  }

  /** Text-mode foreground (high nibble of register 7, transparent → backdrop) */
  private mainFgColor(): number {
    const c = this.reg(TMS_REG_FG_BG_COLOR) >> 4
    return c === TmsColor.TRANSPARENT ? this.mainBgColor() : c
  }

  /** Foreground from a color byte (high nibble, transparent → backdrop) */
  private fgColor(colorByte: number): number {
    const c = colorByte >> 4
    return c === TmsColor.TRANSPARENT ? this.mainBgColor() : c
  }

  /** Background from a color byte (low nibble, transparent → backdrop) */
  private bgColor(colorByte: number): number {
    const c = colorByte & 0x0F
    return c === TmsColor.TRANSPARENT ? this.mainBgColor() : c
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
  //  Timing / Scanline Processing
  // ================================================================

  private processScanline(): void {
    if (this.currentScanline === 0) {
      this.fillBackground()
    }

    if (this.currentScanline < TMS_PIXELS_Y) {
      this.renderScanline(this.currentScanline)
    }

    this.currentScanline++
    if (this.currentScanline >= TOTAL_SCANLINES) {
      // Frame complete – copy back buffer to front buffer
      this.backBuffer.copy(this.buffer)
      this.indexBuffer.set(this.backIndexBuffer)
      this.frameReady = true
      this.currentScanline = 0
    }
  }

  // ================================================================
  //  Scanline Rendering
  // ================================================================

  private renderScanline(y: number): void {
    const pixels = this.scanlinePixels

    if (!this.displayEnabled() || y >= TMS_PIXELS_Y) {
      pixels.fill(this.mainBgColor())
    } else {
      switch (this.mode) {
        case TmsMode.GRAPHICS_I:
          this.graphicsIScanLine(y, pixels)
          break
        case TmsMode.GRAPHICS_II:
          this.graphicsIIScanLine(y, pixels)
          break
        case TmsMode.TEXT:
          this.textScanLine(y, pixels)
          break
        case TmsMode.MULTICOLOR:
          this.multicolorScanLine(y, pixels)
          break
      }
    }

    // Set interrupt flag at end of active display
    if (y === TMS_PIXELS_Y - 1 && (this.reg(TMS_REG_1) & TMS_R1_INT_ENABLE)) {
      this.status |= STATUS_INT
    }

    this.writeScanlineToBuffer(y, pixels)
  }

  // ---- Graphics I ----

  private graphicsIScanLine(y: number, pixels: Uint8Array): void {
    const tileY = y >> 3
    const pattRow = y & 0x07
    const rowNamesAddr = this.nameTableAddr() + tileY * GRAPHICS_NUM_COLS
    const patternBase = this.patternTableAddr()
    const colorBase = this.colorTableAddr()

    for (let tileX = 0; tileX < GRAPHICS_NUM_COLS; tileX++) {
      const pattIdx = this.vram[(rowNamesAddr + tileX) & VRAM_MASK]
      let pattByte = this.vram[(patternBase + pattIdx * PATTERN_BYTES + pattRow) & VRAM_MASK]
      const colorByte = this.vram[(colorBase + (pattIdx >>> 3)) & VRAM_MASK]

      const fg = this.fgColor(colorByte)
      const bg = this.bgColor(colorByte)

      const base = tileX * GRAPHICS_CHAR_WIDTH
      for (let bit = 0; bit < GRAPHICS_CHAR_WIDTH; bit++) {
        pixels[base + bit] = (pattByte & 0x80) ? fg : bg
        pattByte = (pattByte << 1) & 0xFF
      }
    }

    this.outputSprites(y, pixels)
  }

  // ---- Graphics II ----

  private graphicsIIScanLine(y: number, pixels: Uint8Array): void {
    const tileY = y >> 3
    const pattRow = y & 0x07
    const rowNamesAddr = this.nameTableAddr() + tileY * GRAPHICS_NUM_COLS

    const nameMask = ((this.reg(TMS_REG_COLOR_TABLE) & 0x7F) << 3) | 0x07

    const pageThird = ((tileY & 0x18) >> 3)
      & (this.reg(TMS_REG_PATTERN_TABLE) & 0x03)
    const pageOffset = pageThird << 11

    const patternBase = this.patternTableAddr() + pageOffset
    const colorBase = this.colorTableAddr()
      + (pageOffset & ((this.reg(TMS_REG_COLOR_TABLE) & 0x60) << 6))

    for (let tileX = 0; tileX < GRAPHICS_NUM_COLS; tileX++) {
      const pattIdx = this.vram[(rowNamesAddr + tileX) & VRAM_MASK] & nameMask
      const pattRowOffset = pattIdx * PATTERN_BYTES + pattRow
      const pattByte = this.vram[(patternBase + pattRowOffset) & VRAM_MASK]
      const colorByte = this.vram[(colorBase + pattRowOffset) & VRAM_MASK]

      const fg = this.fgColor(colorByte)
      const bg = this.bgColor(colorByte)

      const base = tileX * GRAPHICS_CHAR_WIDTH
      for (let bit = 0; bit < GRAPHICS_CHAR_WIDTH; bit++) {
        pixels[base + bit] = ((pattByte << bit) & 0x80) ? fg : bg
      }
    }

    this.outputSprites(y, pixels)
  }

  // ---- Text ----

  private textScanLine(y: number, pixels: Uint8Array): void {
    const tileY = y >> 3
    const pattRow = y & 0x07
    const rowNamesAddr = this.nameTableAddr() + tileY * TEXT_NUM_COLS
    const patternBase = this.patternTableAddr()

    const bg = this.mainBgColor()
    const fg = this.mainFgColor()

    // Left and right padding
    for (let i = 0; i < TEXT_PADDING_PX; i++) {
      pixels[i] = bg
      pixels[TMS_PIXELS_X - TEXT_PADDING_PX + i] = bg
    }

    for (let tileX = 0; tileX < TEXT_NUM_COLS; tileX++) {
      const pattIdx = this.vram[(rowNamesAddr + tileX) & VRAM_MASK]
      const pattByte = this.vram[(patternBase + pattIdx * PATTERN_BYTES + pattRow) & VRAM_MASK]

      for (let bit = 0; bit < TEXT_CHAR_WIDTH; bit++) {
        pixels[TEXT_PADDING_PX + tileX * TEXT_CHAR_WIDTH + bit] =
          ((pattByte << bit) & 0x80) ? fg : bg
      }
    }
    // No sprites in Text mode
  }

  // ---- Multicolor ----

  private multicolorScanLine(y: number, pixels: Uint8Array): void {
    const tileY = y >> 3
    const pattRow = (Math.floor(y / 4) & 0x01) + (tileY & 0x03) * 2
    const namesAddr = this.nameTableAddr() + tileY * GRAPHICS_NUM_COLS
    const patternBase = this.patternTableAddr()

    for (let tileX = 0; tileX < GRAPHICS_NUM_COLS; tileX++) {
      const pattIdx = this.vram[(namesAddr + tileX) & VRAM_MASK]
      const colorByte = this.vram[(patternBase + pattIdx * PATTERN_BYTES + pattRow) & VRAM_MASK]

      const fg = this.fgColor(colorByte)
      const bg = this.bgColor(colorByte)

      const base = tileX * 8
      for (let i = 0; i < 4; i++) pixels[base + i] = fg
      for (let i = 4; i < 8; i++) pixels[base + i] = bg
    }

    this.outputSprites(y, pixels)
  }

  // ================================================================
  //  Sprite Rendering
  // ================================================================

  private outputSprites(y: number, pixels: Uint8Array): void {
    const mag = this.spriteMag()
    const sprite16 = this.spriteSize() === 16
    const sprSize = this.spriteSize()
    const spriteSizePx = sprSize * (mag ? 2 : 1)
    const attrTableAddr = this.spriteAttrTableAddr()
    const pattTableAddr = this.spritePatternTableAddr()

    let spritesShown = 0

    // Clear sprite-related status bits at start of frame, but preserve
    // the interrupt flag (bit 7) — it is only cleared on CPU status read
    if (y === 0) {
      this.status &= STATUS_INT
    }

    for (let spriteIdx = 0; spriteIdx < MAX_SPRITES; spriteIdx++) {
      const attrBase = attrTableAddr + spriteIdx * SPRITE_ATTR_BYTES
      let yPos: number = this.vram[(attrBase + SPRITE_ATTR_Y) & VRAM_MASK]

      // Stop processing at sentinel value
      if (yPos === LAST_SPRITE_YPOS) {
        if ((this.status & STATUS_5S) === 0) {
          this.status |= spriteIdx
        }
        break
      }

      // Handle wrap-around for sprites above the top of the screen
      if (yPos > 0xE0) {
        yPos -= 256
      }

      // First visible row is yPos + 1
      yPos += 1

      let pattRow = y - yPos
      if (mag) {
        pattRow >>= 1
      }

      // Skip sprite if not visible on this scanline
      if (pattRow < 0 || pattRow >= sprSize) {
        continue
      }

      // Clear collision mask on first visible sprite of this scanline
      if (spritesShown === 0) {
        this.rowSpriteBits.fill(0)
      }

      const spriteColor = this.vram[(attrBase + SPRITE_ATTR_COLOR) & VRAM_MASK] & 0x0F

      // Check scanline sprite limit
      spritesShown++
      if (spritesShown > MAX_SCANLINE_SPRITES) {
        if ((this.status & STATUS_5S) === 0) {
          this.status |= STATUS_5S | spriteIdx
        }
        break
      }

      // Sprite pattern data
      const pattIdx = this.vram[(attrBase + SPRITE_ATTR_NAME) & VRAM_MASK]
      const pattOffset = pattTableAddr + pattIdx * PATTERN_BYTES + pattRow

      // Early clock shifts sprite 32 pixels left
      const earlyClockBit = this.vram[(attrBase + SPRITE_ATTR_COLOR) & VRAM_MASK] & 0x80
      const earlyClockOffset = earlyClockBit ? -32 : 0
      const xPos = this.vram[(attrBase + SPRITE_ATTR_X) & VRAM_MASK] + earlyClockOffset

      let pattByte = this.vram[pattOffset & VRAM_MASK]
      let screenBit = 0
      let pattBit = 0

      const endXPos = Math.min(xPos + spriteSizePx, TMS_PIXELS_X)

      for (let screenX = xPos; screenX < endXPos; screenX++, screenBit++) {
        if (screenX >= 0) {
          // Check high bit of pattern byte
          if (pattByte & 0x80) {
            // Write pixel if sprite is non-transparent and no higher-priority non-transparent sprite already wrote here
            if (spriteColor !== TmsColor.TRANSPARENT && this.rowSpriteBits[screenX] < 2) {
              pixels[screenX] = spriteColor
            }

            // Collision detection
            if (this.rowSpriteBits[screenX]) {
              this.status |= STATUS_COL
            } else {
              this.rowSpriteBits[screenX] = spriteColor + 1
            }
          }
        }

        // Advance pattern bit (every pixel, or every other pixel if magnified)
        if (!mag || (screenBit & 0x01)) {
          pattByte = (pattByte << 1) & 0xFF
          pattBit++
          if (pattBit === GRAPHICS_CHAR_WIDTH && sprite16) {
            // Switch from left half (A/B) to right half (C/D) of 16×16 sprite
            pattBit = 0
            pattByte = this.vram[(pattOffset + PATTERN_BYTES * 2) & VRAM_MASK]
          }
        }
      }
    }
  }

  // ================================================================
  //  Buffer Management
  // ================================================================

  /** Fill entire back buffer with the current backdrop color */
  private fillBackground(): void {
    const bgIdx = this.mainBgColor()
    const [r, g, b, a] = TMS_PALETTE[bgIdx]
    for (let i = 0; i < this.backBuffer.length; i += 4) {
      this.backBuffer[i] = r
      this.backBuffer[i + 1] = g
      this.backBuffer[i + 2] = b
      this.backBuffer[i + 3] = a
    }
    this.backIndexBuffer.fill(bgIdx)
  }

  /** Write a rendered scanline into the back buffer at the correct position */
  private writeScanlineToBuffer(y: number, pixels: Uint8Array): void {
    const bufferY = y + BORDER_Y
    if (bufferY < 0 || bufferY >= DISPLAY_HEIGHT) return

    const rowOffset = bufferY * DISPLAY_WIDTH * 4
    const indexRowOffset = bufferY * DISPLAY_WIDTH
    for (let x = 0; x < TMS_PIXELS_X; x++) {
      const index = pixels[x] & 0x0F
      const offset = rowOffset + (BORDER_X + x) * 4
      const [r, g, b, a] = TMS_PALETTE[index]
      this.backBuffer[offset] = r
      this.backBuffer[offset + 1] = g
      this.backBuffer[offset + 2] = b
      this.backBuffer[offset + 3] = a
      this.backIndexBuffer[indexRowOffset + BORDER_X + x] = index
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
    this.registers[REGISTER_ALIAS[reg & REGISTER_MASK]!] = value & 0xff
    this.updateMode()
  }

  /** Read a VRAM byte directly (does not affect read-ahead buffer) */
  getVramByte(addr: number): number {
    return this.vram[addr & VRAM_MASK]
  }

  /** Write a VRAM byte directly (does not affect address pointer) */
  setVramByte(addr: number, value: number): void {
    this.vram[addr & VRAM_MASK] = value
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

  /** Peek at the status register without clearing it */
  getStatus(): number {
    return this.status
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
      status: this.status,
      ports: [this.portA.serialize(), this.portB.serialize()],
      vram: toBase64(this.vram),
      cycleAccumulator: this.cycleAccumulator,
      currentScanline: this.currentScanline,
      frameReady: this.frameReady
    }
  }

  deserialize(state: DeviceState): void {
    expectKind(state, this.kind)
    this.registers.set(readBytes(state, 'registers', NUM_REGISTERS))
    this.status = readNumber(state, 'status')
    const ports = readStates(state, 'ports', 2)
    this.portA.deserialize(ports[0]!)
    this.portB.deserialize(ports[1]!)
    this.vram.set(readBytes(state, 'vram', VRAM_SIZE))
    this.cycleAccumulator = readNumber(state, 'cycleAccumulator')
    this.currentScanline = readNumber(state, 'currentScanline')
    this.frameReady = readBoolean(state, 'frameReady')

    this.updateMode()
    // Start the redraw from the restored backdrop rather than the previous
    // machine's picture, so the frame in progress is not a blend of the two.
    this.fillBackground()
  }

}