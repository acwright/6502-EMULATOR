import { IO } from '../IO'

/**
 * TMS9918 Video Display Processor Emulation
 *
 * Port mapping (address bit 0):
 *   Even address (bit 0 = 0): VRAM data read/write
 *   Odd  address (bit 0 = 1): Register/address write / status read
 *
 * Display modes:
 *   Graphics I   - 32x24 tiles, 8x8 patterns, 1-of-8 color groups
 *   Graphics II  - 32x24 tiles, 8x8 patterns, per-row color
 *   Text         - 40x24 tiles, 6x8 patterns, no sprites
 *   Multicolor   - 32x24 blocks, 4x4 colored cells
 *
 * Output: 256x192 active area centered in a 320x240 RGBA buffer
 *
 * Reference: vrEmuTms9918 by Troy Schrapel
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

// VRAM
const VRAM_SIZE = 1 << 14       // 16KB
const VRAM_MASK = VRAM_SIZE - 1  // 0x3FFF

// Active display resolution
const TMS_PIXELS_X = 256
const TMS_PIXELS_Y = 192

// Output buffer resolution
const DISPLAY_WIDTH = 320
const DISPLAY_HEIGHT = 240

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

// Register indices
const TMS_REG_0 = 0
const TMS_REG_1 = 1
const TMS_REG_NAME_TABLE = 2
const TMS_REG_COLOR_TABLE = 3
const TMS_REG_PATTERN_TABLE = 4
const TMS_REG_SPRITE_ATTR_TABLE = 5
const TMS_REG_SPRITE_PATT_TABLE = 6
const TMS_REG_FG_BG_COLOR = 7
const TMS_NUM_REGISTERS = 8

// Timing (NTSC)
const TOTAL_SCANLINES = 262
const FRAMES_PER_SECOND = 60

// Border offsets (centering 256x192 in 320x240)
const BORDER_X = (DISPLAY_WIDTH - TMS_PIXELS_X) / 2   // 32
const BORDER_Y = (DISPLAY_HEIGHT - TMS_PIXELS_Y) / 2  // 24

export class Video implements IO {

  // ---- VDP internal state ----

  /** Eight write-only registers */
  private registers = new Uint8Array(TMS_NUM_REGISTERS)

  /** Status register (read-only from CPU side) */
  private status: number = 0

  /** Current VRAM address for CPU access (auto-increments) */
  private currentAddress: number = 0

  /** Address / register write stage (0 or 1) */
  private regWriteStage: number = 0

  /** Holds first stage byte written to the control port */
  private regWriteStage0Value: number = 0

  /** Read-ahead buffer for VRAM reads */
  private readAheadBuffer: number = 0

  /** Current display mode (derived from registers) */
  private mode: TmsMode = TmsMode.GRAPHICS_I

  /** 16 KB Video RAM */
  private vram = new Uint8Array(VRAM_SIZE)

  /** Per-pixel sprite collision mask for the current scanline */
  private rowSpriteBits = new Uint8Array(TMS_PIXELS_X)

  /** Temporary scanline pixel buffer (color palette indices) */
  private scanlinePixels = new Uint8Array(TMS_PIXELS_X)

  /** 320 × 240 RGBA output buffer for SDL rendering (front buffer – always a complete frame) */
  buffer: Buffer = Buffer.alloc(DISPLAY_WIDTH * DISPLAY_HEIGHT * 4)

  /** Back buffer where scanlines are rendered progressively */
  private backBuffer: Buffer = Buffer.alloc(DISPLAY_WIDTH * DISPLAY_HEIGHT * 4)

  /** True when a complete frame has been copied to the front buffer */
  frameReady: boolean = false

  /** Cycle accumulator for scanline timing */
  private cycleAccumulator: number = 0

  /** Current scanline being processed (0 – 261) */
  private currentScanline: number = 0

  // ================================================================
  //  IO Interface
  // ================================================================

  read(address: number): number {
    if (address & 1) {
      return this.readStatus()
    }
    return this.readData()
  }

  write(address: number, data: number): void {
    if (address & 1) {
      this.writeAddr(data)
    } else {
      this.writeData(data)
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

  reset(_coldStart: boolean): void {
    this.regWriteStage0Value = 0
    this.currentAddress = 0
    this.regWriteStage = 0
    this.status = 0
    this.readAheadBuffer = 0
    this.registers.fill(0)
    this.cycleAccumulator = 0
    this.currentScanline = 0
    this.updateMode()
    // VRAM intentionally left in unknown state (matches C reference)
    this.fillBackground()
  }

  // ================================================================
  //  VDP Data / Control Ports
  // ================================================================

  /**
   * Write to the control (address / register) port.
   * Two-stage write:
   *   Stage 0 – latches the low byte (address LSB or register value)
   *   Stage 1 – interprets the high byte:
   *     bit 7 set   → register write  (bits 0-2 = register index)
   *     bit 7 clear → address set      (bit 6: 0 = read, 1 = write)
   */
  private writeAddr(data: number): void {
    if (this.regWriteStage === 0) {
      this.regWriteStage0Value = data
      this.regWriteStage = 1
    } else {
      if (data & 0x80) {
        // Register write
        this.registers[data & 0x07] = this.regWriteStage0Value
        this.updateMode()
      } else {
        // Address set
        this.currentAddress = this.regWriteStage0Value | ((data & 0x3F) << 8)
        if ((data & 0x40) === 0) {
          // Read mode – pre-fetch byte and auto-increment
          this.readAheadBuffer = this.vram[this.currentAddress & VRAM_MASK]
          this.currentAddress++
        }
      }
      this.regWriteStage = 0
    }
  }

  /** Write data to VRAM at the current address (auto-increments) */
  private writeData(data: number): void {
    this.regWriteStage = 0
    this.readAheadBuffer = data
    this.vram[this.currentAddress & VRAM_MASK] = data
    this.currentAddress++
  }

  /**
   * Read the status register.
   * Clears the status flags and resets the write stage.
   */
  private readStatus(): number {
    const tmp = this.status
    this.status = 0
    this.regWriteStage = 0
    return tmp
  }

  /** Read data from VRAM via the read-ahead buffer (auto-increments) */
  private readData(): number {
    this.regWriteStage = 0
    const value = this.readAheadBuffer
    this.readAheadBuffer = this.vram[this.currentAddress & VRAM_MASK]
    this.currentAddress++
    return value
  }

  // ================================================================
  //  Mode Detection
  // ================================================================

  private updateMode(): void {
    if (this.registers[TMS_REG_0] & TMS_R0_MODE_GRAPHICS_II) {
      this.mode = TmsMode.GRAPHICS_II
    } else {
      const bits = (this.registers[TMS_REG_1] & (TMS_R1_MODE_MULTICOLOR | TMS_R1_MODE_TEXT)) >> 3
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

  private nameTableAddr(): number {
    return (this.registers[TMS_REG_NAME_TABLE] & 0x0F) << 10
  }

  private colorTableAddr(): number {
    const mask = this.mode === TmsMode.GRAPHICS_II ? 0x80 : 0xFF
    return (this.registers[TMS_REG_COLOR_TABLE] & mask) << 6
  }

  private patternTableAddr(): number {
    const mask = this.mode === TmsMode.GRAPHICS_II ? 0x04 : 0x07
    return (this.registers[TMS_REG_PATTERN_TABLE] & mask) << 11
  }

  private spriteAttrTableAddr(): number {
    return (this.registers[TMS_REG_SPRITE_ATTR_TABLE] & 0x7F) << 7
  }

  private spritePatternTableAddr(): number {
    return (this.registers[TMS_REG_SPRITE_PATT_TABLE] & 0x07) << 11
  }

  // ================================================================
  //  Color Helpers
  // ================================================================

  /** Backdrop / border color (low nibble of register 7) */
  private mainBgColor(): number {
    return this.registers[TMS_REG_FG_BG_COLOR] & 0x0F
  }

  /** Text-mode foreground (high nibble of register 7, transparent → backdrop) */
  private mainFgColor(): number {
    const c = this.registers[TMS_REG_FG_BG_COLOR] >> 4
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
    return this.registers[TMS_REG_1] & TMS_R1_SPRITE_16 ? 16 : 8
  }

  private spriteMag(): boolean {
    return !!(this.registers[TMS_REG_1] & TMS_R1_SPRITE_MAG2)
  }

  private displayEnabled(): boolean {
    return !!(this.registers[TMS_REG_1] & TMS_R1_DISP_ACTIVE)
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
    if (y === TMS_PIXELS_Y - 1 && (this.registers[TMS_REG_1] & TMS_R1_INT_ENABLE)) {
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

    const nameMask = ((this.registers[TMS_REG_COLOR_TABLE] & 0x7F) << 3) | 0x07

    const pageThird = ((tileY & 0x18) >> 3)
      & (this.registers[TMS_REG_PATTERN_TABLE] & 0x03)
    const pageOffset = pageThird << 11

    const patternBase = this.patternTableAddr() + pageOffset
    const colorBase = this.colorTableAddr()
      + (pageOffset & ((this.registers[TMS_REG_COLOR_TABLE] & 0x60) << 6))

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
  }

  /** Write a rendered scanline into the back buffer at the correct position */
  private writeScanlineToBuffer(y: number, pixels: Uint8Array): void {
    const bufferY = y + BORDER_Y
    if (bufferY < 0 || bufferY >= DISPLAY_HEIGHT) return

    const rowOffset = bufferY * DISPLAY_WIDTH * 4
    for (let x = 0; x < TMS_PIXELS_X; x++) {
      const offset = rowOffset + (BORDER_X + x) * 4
      const [r, g, b, a] = TMS_PALETTE[pixels[x] & 0x0F]
      this.backBuffer[offset] = r
      this.backBuffer[offset + 1] = g
      this.backBuffer[offset + 2] = b
      this.backBuffer[offset + 3] = a
    }
  }

  // ================================================================
  //  Public Accessors (testing / debugging)
  // ================================================================

  /** Read a VDP register value */
  getRegister(reg: number): number {
    return this.registers[reg & 0x07]
  }

  /** Write a VDP register value directly (bypasses control-port staging) */
  setRegister(reg: number, value: number): void {
    this.registers[reg & 0x07] = value
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

}