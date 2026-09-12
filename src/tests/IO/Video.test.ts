import { Video, TmsMode, TmsColor, DISPLAY_WIDTH, DISPLAY_HEIGHT } from '../../core/IO/Video'

/**
 * Helper: write a register value through the control port (two-stage write)
 */
const writeRegister = (vdp: Video, reg: number, value: number): void => {
  vdp.write(1, value)          // Stage 0: register value
  vdp.write(1, 0x80 | reg)    // Stage 1: register number with bit 7 set
}

/**
 * Helper: set VRAM write address through the control port
 */
const setWriteAddress = (vdp: Video, addr: number): void => {
  vdp.write(1, addr & 0xFF)           // Stage 0: address low byte
  vdp.write(1, ((addr >> 8) & 0x3F) | 0x40) // Stage 1: address high + write flag
}

/**
 * Helper: set VRAM read address through the control port
 */
const setReadAddress = (vdp: Video, addr: number): void => {
  vdp.write(1, addr & 0xFF)           // Stage 0: address low byte
  vdp.write(1, (addr >> 8) & 0x3F)    // Stage 1: address high (no write flag)
}

/**
 * Helper: write a sequence of bytes to VRAM starting at an address
 */
const writeVramBytes = (vdp: Video, addr: number, bytes: number[]): void => {
  setWriteAddress(vdp, addr)
  for (const b of bytes) {
    vdp.write(0, b) // Data port
  }
}

/**
 * Helper: setup Graphics I mode with standard table addresses
 */
const setupGraphicsI = (vdp: Video): void => {
  writeRegister(vdp, 0, 0x00) // No external VDP, Graphics I
  writeRegister(vdp, 1, 0x60) // 16K, display active, interrupts enabled, Graphics I
  writeRegister(vdp, 2, 0x0E) // Name table at 0x3800
  writeRegister(vdp, 3, 0x00) // Color table at 0x0000
  writeRegister(vdp, 4, 0x04) // Pattern table at 0x2000
  writeRegister(vdp, 5, 0x76) // Sprite attr at 0x3B00
  writeRegister(vdp, 6, 0x03) // Sprite pattern at 0x1800
  writeRegister(vdp, 7, 0x17) // FG=black(1), BG=cyan(7)
}

/**
 * Helper: setup Graphics II mode with standard table addresses
 */
const setupGraphicsII = (vdp: Video): void => {
  writeRegister(vdp, 0, 0x02) // Graphics II mode
  writeRegister(vdp, 1, 0x60) // 16K, display active, interrupts enabled
  writeRegister(vdp, 2, 0x0E) // Name table at 0x3800
  writeRegister(vdp, 3, 0x7F) // Color table mask
  writeRegister(vdp, 4, 0x07) // Pattern table mask
  writeRegister(vdp, 5, 0x76) // Sprite attr at 0x3B00
  writeRegister(vdp, 6, 0x03) // Sprite pattern at 0x1800
  writeRegister(vdp, 7, 0x17) // FG=black(1), BG=cyan(7)
}

/**
 * Helper: setup Text mode
 */
const setupTextMode = (vdp: Video): void => {
  writeRegister(vdp, 0, 0x00) // No external VDP
  writeRegister(vdp, 1, 0x70) // 16K, display active, interrupts, Text mode
  writeRegister(vdp, 2, 0x0E) // Name table at 0x3800
  writeRegister(vdp, 4, 0x04) // Pattern table at 0x2000
  writeRegister(vdp, 7, 0xF4) // FG=white(15), BG=dark blue(4)
}

/**
 * Helper: tick enough times to render exactly one complete frame.
 * Must not overshoot into the next frame (scanline 0 of the next
 * frame clears the status register during sprite processing).
 */
const renderOneFrame = (vdp: Video, frequency: number = 1000000): void => {
  // Each tick = 1 cycle. Cycles per frame = frequency / 60.
  const cyclesPerFrame = Math.ceil(frequency / 60)
  for (let i = 0; i < cyclesPerFrame; i++) {
    vdp.tick(frequency)
  }
}

/**
 * Helper: clear sprite attribute table (set all Y positions to 0xD0 = stop)
 */
const clearSprites = (vdp: Video, spriteAttrAddr: number = 0x3B00): void => {
  setWriteAddress(vdp, spriteAttrAddr)
  for (let i = 0; i < 32; i++) {
    vdp.write(0, 0xD0) // Y = stop sentinel
    vdp.write(0, 0x00) // X
    vdp.write(0, 0x00) // Name
    vdp.write(0, 0x00) // Color
  }
}

describe('Video (TMS9918 VDP)', () => {
  let vdp: Video

  beforeEach(() => {
    vdp = new Video()
  })

  // ================================================================
  //  Initialization & Reset
  // ================================================================

  describe('Initialization', () => {
    it('should initialize with all registers zeroed', () => {
      for (let i = 0; i < 8; i++) {
        expect(vdp.getRegister(i)).toBe(0)
      }
    })

    it('should initialize in Graphics I mode', () => {
      expect(vdp.getMode()).toBe(TmsMode.GRAPHICS_I)
    })

    it('should initialize with display disabled', () => {
      expect(vdp.isDisplayEnabled()).toBe(false)
    })

    it('should initialize status register to 0', () => {
      expect(vdp.getStatus()).toBe(0)
    })

    it('should have a 320x240 RGBA output buffer', () => {
      expect(vdp.buffer.length).toBe(320 * 240 * 4)
    })
  })

  describe('Reset', () => {
    it('should clear registers on reset', () => {
      writeRegister(vdp, 1, 0x60)
      writeRegister(vdp, 7, 0xF1)
      vdp.reset(true)
      for (let i = 0; i < 8; i++) {
        expect(vdp.getRegister(i)).toBe(0)
      }
    })

    it('should clear status register on reset', () => {
      // Trigger an interrupt
      writeRegister(vdp, 1, 0x60)
      renderOneFrame(vdp)
      expect(vdp.getStatus() & 0x80).toBeTruthy()

      vdp.reset(true)
      expect(vdp.getStatus()).toBe(0)
    })

    it('should reset write stage on reset', () => {
      // Write only the first stage byte
      vdp.write(1, 0x42) // Stage 0 only
      vdp.reset(true)
      // Now writing two bytes should work correctly as a fresh two-stage write
      writeRegister(vdp, 7, 0xAB)
      expect(vdp.getRegister(7)).toBe(0xAB)
    })

    it('should keep VRAM across a warm reset', () => {
      vdp.writeVRAM(0x100, 0xAB)
      vdp.reset(false)
      expect(vdp.readVRAM(0x100)).toBe(0xAB)
    })

    it('should zero VRAM on a cold start, like the other memory cards', () => {
      vdp.writeVRAM(0x000, 0xAB)
      vdp.writeVRAM(0x1FFF, 0xCD)
      vdp.writeVRAM(0x3FFF, 0xEF)
      vdp.reset(true)
      expect(vdp.readVRAM(0x000)).toBe(0x00)
      expect(vdp.readVRAM(0x1FFF)).toBe(0x00)
      expect(vdp.readVRAM(0x3FFF)).toBe(0x00)
    })
  })

  // ================================================================
  //  Register Read/Write
  // ================================================================

  describe('Register Access', () => {
    it('should write and read back register values', () => {
      for (let reg = 0; reg < 8; reg++) {
        writeRegister(vdp, reg, 0x55 + reg)
        expect(vdp.getRegister(reg)).toBe(0x55 + reg)
      }
    })

    it('should mask the register index to 7 bits, not 3 (§4)', () => {
      // The TMS9918 decoded three bits, so a command byte of $88 landed on
      // register 0. This decodes seven, so it lands on register 8 — which is
      // what makes $08-$7F reachable at all.
      writeRegister(vdp, 0x08, 0xAA)
      expect(vdp.getRegister(0x08)).toBe(0xAA)
      expect(vdp.getRegister(0x00)).toBe(0x00)

      // Only bit 7 of the command byte is consumed; $80 | $80 wraps to 0.
      writeRegister(vdp, 0x80, 0x5A)
      expect(vdp.getRegister(0x00)).toBe(0x5A)
    })

    it('should update display mode on register write', () => {
      // Graphics II: reg 0 bit 1
      writeRegister(vdp, 0, 0x02)
      expect(vdp.getMode()).toBe(TmsMode.GRAPHICS_II)

      // Text: reg 1 bit 4
      writeRegister(vdp, 0, 0x00)
      writeRegister(vdp, 1, 0x10)
      expect(vdp.getMode()).toBe(TmsMode.TEXT)

      // Multicolor: reg 1 bit 3
      writeRegister(vdp, 1, 0x08)
      expect(vdp.getMode()).toBe(TmsMode.MULTICOLOR)

      // Graphics I: no special bits
      writeRegister(vdp, 0, 0x00)
      writeRegister(vdp, 1, 0x00)
      expect(vdp.getMode()).toBe(TmsMode.GRAPHICS_I)
    })
  })

  // ================================================================
  //  VRAM Access
  // ================================================================

  describe('VRAM Access', () => {
    it('should write and read VRAM data', () => {
      setWriteAddress(vdp, 0x0000)
      vdp.write(0, 0x42)
      vdp.write(0, 0x43)
      vdp.write(0, 0x44)

      // Read back
      setReadAddress(vdp, 0x0000)
      expect(vdp.read(0)).toBe(0x42) // Pre-fetched during address set
      expect(vdp.read(0)).toBe(0x43) // Next byte
      expect(vdp.read(0)).toBe(0x44)
    })

    it('should auto-increment address on write', () => {
      setWriteAddress(vdp, 0x1000)
      for (let i = 0; i < 10; i++) {
        vdp.write(0, i)
      }

      // Verify the bytes were written sequentially
      for (let i = 0; i < 10; i++) {
        expect(vdp.getVramByte(0x1000 + i)).toBe(i)
      }
    })

    it('should auto-increment address on read', () => {
      // Write sequential values
      for (let i = 0; i < 5; i++) {
        vdp.setVramByte(0x2000 + i, 0xA0 + i)
      }

      setReadAddress(vdp, 0x2000)
      for (let i = 0; i < 5; i++) {
        expect(vdp.read(0)).toBe(0xA0 + i)
      }
    })

    it('should implement read-ahead buffer correctly', () => {
      vdp.setVramByte(0x0000, 0x11)
      vdp.setVramByte(0x0001, 0x22)
      vdp.setVramByte(0x0002, 0x33)

      // Setting read address pre-fetches first byte
      setReadAddress(vdp, 0x0000)
      // First read returns the pre-fetched byte (0x11), and fetches next (0x22)
      expect(vdp.read(0)).toBe(0x11)
      // Second read returns 0x22 (previously fetched), fetches 0x33
      expect(vdp.read(0)).toBe(0x22)
      expect(vdp.read(0)).toBe(0x33)
    })

    it('should run past the old 16KB boundary into the next bank (§4)', () => {
      // A real TMS9918 wrapped here. This does not: the pointer is a 16-bit
      // counter and VINC carries into the bank bits. Deliberately broken
      // behavior, and nothing in the AC6502 software suite relied on the wrap.
      setWriteAddress(vdp, 0x3FFF)
      vdp.write(0, 0xEE)
      vdp.write(0, 0xFF)

      expect(vdp.getVramByte(0x3FFF)).toBe(0xEE)
      expect(vdp.getVramByte(0x4000)).toBe(0xFF)
      expect(vdp.getVramByte(0x0000)).toBe(0x00)
    })

    it('should reset write stage on data port operations', () => {
      // Start a control port write (stage 0)
      vdp.write(1, 0x42) // Stage 0

      // A data write should reset the write stage
      setWriteAddress(vdp, 0x0000) // Need address set first
      vdp.write(0, 0x55)

      // Now a full two-stage register write should work
      writeRegister(vdp, 7, 0xCC)
      expect(vdp.getRegister(7)).toBe(0xCC)
    })
  })

  // ================================================================
  //  Status Register
  // ================================================================

  describe('Status Register', () => {
    it('should read and clear status register', () => {
      // Enable display and interrupts
      writeRegister(vdp, 1, 0x60)
      clearSprites(vdp)

      renderOneFrame(vdp)

      // Status should have interrupt flag
      const status = vdp.read(1) // Read status through control port
      expect(status & 0x80).toBeTruthy()

      // Reading status should have cleared it
      expect(vdp.getStatus()).toBe(0)
    })

    it('should reset write stage on status read', () => {
      // Start a control port write (stage 0)
      vdp.write(1, 0x42) // Stage 0

      // Reading status should reset the write stage
      vdp.read(1)

      // Now a full two-stage register write should work
      writeRegister(vdp, 7, 0xDD)
      expect(vdp.getRegister(7)).toBe(0xDD)
    })
  })

  // ================================================================
  //  Mode Detection
  // ================================================================

  describe('Mode Detection', () => {
    it('should detect Graphics I mode', () => {
      writeRegister(vdp, 0, 0x00)
      writeRegister(vdp, 1, 0x00)
      expect(vdp.getMode()).toBe(TmsMode.GRAPHICS_I)
    })

    it('should detect Graphics II mode (reg 0 bit 1)', () => {
      writeRegister(vdp, 0, 0x02)
      expect(vdp.getMode()).toBe(TmsMode.GRAPHICS_II)
    })

    it('should detect Text mode (reg 1 bit 4)', () => {
      writeRegister(vdp, 0, 0x00)
      writeRegister(vdp, 1, 0x10)
      expect(vdp.getMode()).toBe(TmsMode.TEXT)
    })

    it('should detect Multicolor mode (reg 1 bit 3)', () => {
      writeRegister(vdp, 0, 0x00)
      writeRegister(vdp, 1, 0x08)
      expect(vdp.getMode()).toBe(TmsMode.MULTICOLOR)
    })

    it('should prioritize Graphics II over other modes', () => {
      writeRegister(vdp, 0, 0x02)
      writeRegister(vdp, 1, 0x10) // Also set Text bit
      expect(vdp.getMode()).toBe(TmsMode.GRAPHICS_II)
    })
  })

  // ================================================================
  //  Display-Enabled Flag
  // ================================================================

  describe('Display Enable', () => {
    it('should report display disabled when BLANK bit is clear', () => {
      writeRegister(vdp, 1, 0x00) // Display inactive
      expect(vdp.isDisplayEnabled()).toBe(false)
    })

    it('should report display enabled when BLANK bit is set', () => {
      writeRegister(vdp, 1, 0x40) // Display active
      expect(vdp.isDisplayEnabled()).toBe(true)
    })
  })

  // ================================================================
  //  Interrupt Generation
  // ================================================================

  describe('Interrupt Generation', () => {
    it('should set interrupt flag after rendering active display', () => {
      writeRegister(vdp, 1, 0x60) // Display active + interrupts enabled
      clearSprites(vdp)

      renderOneFrame(vdp)

      expect(vdp.getStatus() & 0x80).toBeTruthy()
    })

    /**
     * The divergence Phase 2 fixed, kept here as the test that used to assert
     * the opposite.
     *
     * `STAT0` b7 is a flag, not an interrupt: it says the picture ended, and it
     * says so whether or not anything is enabled to act on it (§6). The old
     * renderer gated it on register 1's IE bit, which broke the one idiom the
     * flag exists for — and broke it for the BIOS, which runs its video console
     * with the vblank interrupt off. See the §14 block at the foot of this file
     * for what `IRQEN` does instead.
     */
    it('should set the F flag even when the interrupt is disabled', () => {
      writeRegister(vdp, 1, 0x40) // Display active, interrupts disabled
      clearSprites(vdp)

      renderOneFrame(vdp)

      expect(vdp.getStatus() & 0x80).toBeTruthy()
      // ...and no interrupt with it.
      expect(vdp.tick(1000000) & 0x80).toBe(0)
    })

    it('should return IRQ status from tick when interrupt flag is set', () => {
      writeRegister(vdp, 1, 0x60) // Display active + interrupts enabled
      clearSprites(vdp)

      renderOneFrame(vdp)

      // After frame, tick should return 0x80 indicating IRQ
      const result = vdp.tick(1000000)
      expect(result & 0x80).toBe(0x80)
    })
  })

  // ================================================================
  //  Graphics I Rendering
  // ================================================================

  describe('Graphics I Mode Rendering', () => {
    it('should render a tile with pattern data', () => {
      setupGraphicsI(vdp)
      clearSprites(vdp)

      // Set name table entry: tile 0 at position (0,0)
      vdp.setVramByte(0x3800, 0x00) // Name table: tile index 0

      // Set a simple pattern for tile 0 (alternating lines)
      // Pattern table at 0x2000
      vdp.setVramByte(0x2000, 0xFF) // Row 0: all pixels on
      vdp.setVramByte(0x2001, 0x00) // Row 1: all pixels off
      vdp.setVramByte(0x2002, 0xFF) // Row 2: all pixels on
      vdp.setVramByte(0x2003, 0x00) // Row 3: all pixels off
      vdp.setVramByte(0x2004, 0xFF) // Row 4: all pixels on
      vdp.setVramByte(0x2005, 0x00) // Row 5: all pixels off
      vdp.setVramByte(0x2006, 0xFF) // Row 6: all pixels on
      vdp.setVramByte(0x2007, 0x00) // Row 7: all pixels off

      // Set color for tile 0 (group 0, indices 0-7)
      // Color table at 0x0000, each entry covers 8 tiles
      // FG = white (0xF), BG = black (0x1) → 0xF1
      vdp.setVramByte(0x0000, 0xF1)

      renderOneFrame(vdp)

      // Check pixel at (0,0) in the active area → should be FG color (white = 15)
      // Buffer position: (BORDER_X, BORDER_Y) = (32, 24) in RGBA
      const offset = (24 * 320 + 32) * 4
      // White = (0xFF, 0xFF, 0xFF, 0xFF)
      expect(vdp.buffer[offset]).toBe(0xFF)
      expect(vdp.buffer[offset + 1]).toBe(0xFF)
      expect(vdp.buffer[offset + 2]).toBe(0xFF)
      expect(vdp.buffer[offset + 3]).toBe(0xFF)

      // Row 1 (pattern byte = 0x00) should be BG color (black = 1)
      const offsetRow1 = (25 * 320 + 32) * 4
      expect(vdp.buffer[offsetRow1]).toBe(0x00)
      expect(vdp.buffer[offsetRow1 + 1]).toBe(0x00)
      expect(vdp.buffer[offsetRow1 + 2]).toBe(0x00)
      expect(vdp.buffer[offsetRow1 + 3]).toBe(0xFF)
    })
  })

  // ================================================================
  //  Text Mode Rendering
  // ================================================================

  describe('Text Mode Rendering', () => {
    it('should render left and right padding with background color', () => {
      setupTextMode(vdp)

      renderOneFrame(vdp)

      // Left padding: first 8 pixels should be BG color (dark blue = 4)
      // Dark blue is palette entry 4, $55E → [0x55, 0x55, 0xEE, 0xFF]
      const offset = (24 * 320 + 32) * 4 // First active pixel in buffer
      expect(vdp.buffer[offset]).toBe(0x55)     // R
      expect(vdp.buffer[offset + 1]).toBe(0x55) // G
      expect(vdp.buffer[offset + 2]).toBe(0xEE) // B
      expect(vdp.buffer[offset + 3]).toBe(0xFF) // A

      // Right padding: last 8 pixels of active area
      const rightPaddingX = 32 + 248 // BORDER_X + (256 - 8)
      const offsetRight = (24 * 320 + rightPaddingX) * 4
      expect(vdp.buffer[offsetRight]).toBe(0x55)
      expect(vdp.buffer[offsetRight + 1]).toBe(0x55)
      expect(vdp.buffer[offsetRight + 2]).toBe(0xEE)
    })
  })

  // ================================================================
  //  Border Rendering
  // ================================================================

  describe('Border Rendering', () => {
    it('should fill border with backdrop color', () => {
      writeRegister(vdp, 1, 0x40) // Display active
      writeRegister(vdp, 7, 0x07) // BG = cyan (7)

      renderOneFrame(vdp)

      // Check top-left corner (border area)
      // Cyan is palette entry 7, $4EE → [0x44, 0xEE, 0xEE, 0xFF]
      expect(vdp.buffer[0]).toBe(0x44)
      expect(vdp.buffer[1]).toBe(0xEE)
      expect(vdp.buffer[2]).toBe(0xEE)
      expect(vdp.buffer[3]).toBe(0xFF)
    })

    it('should use black for transparent backdrop', () => {
      writeRegister(vdp, 1, 0x40) // Display active
      writeRegister(vdp, 7, 0x00) // BG = transparent (0)

      renderOneFrame(vdp)

      // Transparent renders as opaque black
      expect(vdp.buffer[0]).toBe(0x00)
      expect(vdp.buffer[1]).toBe(0x00)
      expect(vdp.buffer[2]).toBe(0x00)
      expect(vdp.buffer[3]).toBe(0xFF)
    })
  })

  // ================================================================
  //  Blanked Display
  // ================================================================

  describe('Blanked Display', () => {
    it('should fill active area with backdrop when display is disabled', () => {
      writeRegister(vdp, 1, 0x20) // Display disabled, interrupts enabled
      writeRegister(vdp, 7, 0x04) // BG = dark blue (4)

      renderOneFrame(vdp)

      // Active area pixel should be backdrop color
      const offset = (24 * 320 + 32) * 4
      // Dark blue, $55E: [0x55, 0x55, 0xEE, 0xFF]
      expect(vdp.buffer[offset]).toBe(0x55)
      expect(vdp.buffer[offset + 1]).toBe(0x55)
      expect(vdp.buffer[offset + 2]).toBe(0xEE)
    })
  })

  // ================================================================
  //  Sprite Processing
  // ================================================================

  describe('Sprite Processing', () => {
    beforeEach(() => {
      setupGraphicsI(vdp)
      clearSprites(vdp)
    })

    it('should render a simple 8x8 sprite', () => {
      // Sprite pattern at 0x1800 (sprite pattern table)
      // Pattern 0: solid 8x8 block
      for (let row = 0; row < 8; row++) {
        vdp.setVramByte(0x1800 + row, 0xFF) // All pixels set
      }

      // Sprite 0 attribute: Y=0, X=0, Name=0, Color=white(15)
      vdp.setVramByte(0x3B00 + 0, 0xFF)  // Y = 0xFF → yPos becomes 0 (+1 offset)
      vdp.setVramByte(0x3B00 + 1, 0x00)  // X = 0
      vdp.setVramByte(0x3B00 + 2, 0x00)  // Name = 0
      vdp.setVramByte(0x3B00 + 3, 0x0F)  // Color = 15 (white)

      // Sentinel for sprite 1
      vdp.setVramByte(0x3B00 + 4, 0xD0)

      renderOneFrame(vdp)

      // Check pixel at sprite position (0,0) in active area
      const offset = (24 * 320 + 32) * 4
      // White overlay: [0xFF, 0xFF, 0xFF, 0xFF]
      expect(vdp.buffer[offset]).toBe(0xFF)
      expect(vdp.buffer[offset + 1]).toBe(0xFF)
      expect(vdp.buffer[offset + 2]).toBe(0xFF)
      expect(vdp.buffer[offset + 3]).toBe(0xFF)
    })

    it('should stop processing sprites at Y = 0xD0 sentinel', () => {
      // Sprite 0: sentinel
      vdp.setVramByte(0x3B00 + 0, 0xD0)

      // Sprite 1: should not be processed
      vdp.setVramByte(0x3B00 + 4, 0x00)
      vdp.setVramByte(0x3B00 + 5, 0x00)
      vdp.setVramByte(0x3B00 + 6, 0x00)
      vdp.setVramByte(0x3B00 + 7, 0x0F)

      // Pattern for sprite 1
      for (let row = 0; row < 8; row++) {
        vdp.setVramByte(0x1800 + row, 0xFF)
      }

      renderOneFrame(vdp)

      // Pixel should NOT be white (sprite 1 not rendered)
      const offset = (25 * 320 + 32) * 4
      expect(vdp.buffer[offset]).not.toBe(0xFF)
    })

    it('should detect sprite collision (STATUS_COL)', () => {
      // Two sprites overlapping at the same position
      // Sprite 0: Y=0, X=0
      vdp.setVramByte(0x3B00 + 0, 0xFF)  // Y → 0
      vdp.setVramByte(0x3B00 + 1, 0x00)  // X = 0
      vdp.setVramByte(0x3B00 + 2, 0x00)  // Name = 0
      vdp.setVramByte(0x3B00 + 3, 0x0F)  // Color = 15

      // Sprite 1: Y=0, X=0 (overlapping)
      vdp.setVramByte(0x3B00 + 4, 0xFF)  // Y → 0
      vdp.setVramByte(0x3B00 + 5, 0x00)  // X = 0
      vdp.setVramByte(0x3B00 + 6, 0x00)  // Name = 0
      vdp.setVramByte(0x3B00 + 7, 0x0E)  // Color = 14 (grey)

      // Sentinel
      vdp.setVramByte(0x3B00 + 8, 0xD0)

      // Pattern 0: at least one pixel set
      vdp.setVramByte(0x1800, 0x80) // Top-left pixel

      renderOneFrame(vdp)

      expect(vdp.getStatus() & 0x20).toBeTruthy() // STATUS_COL
    })

    it('should set 5th sprite flag when more than 4 sprites on a scanline', () => {
      // Place 5 sprites on scanline 0
      for (let i = 0; i < 5; i++) {
        const base = 0x3B00 + i * 4
        vdp.setVramByte(base + 0, 0xFF)     // Y → 0
        vdp.setVramByte(base + 1, i * 16)   // X = spaced apart
        vdp.setVramByte(base + 2, 0x00)     // Name = 0
        vdp.setVramByte(base + 3, 0x0F)     // Color = 15
      }

      // Sentinel after sprite 5
      vdp.setVramByte(0x3B00 + 20, 0xD0)

      // Pattern: all pixels set
      for (let row = 0; row < 8; row++) {
        vdp.setVramByte(0x1800 + row, 0xFF)
      }

      renderOneFrame(vdp)

      const status = vdp.getStatus()
      expect(status & 0x40).toBeTruthy()    // STATUS_5S flag
      expect(status & 0x1F).toBe(4)         // 5th sprite index
    })
  })

  // ================================================================
  //  Direct Accessor Methods
  // ================================================================

  describe('Direct Accessors', () => {
    it('should read/write VRAM directly', () => {
      vdp.setVramByte(0x1234, 0xAB)
      expect(vdp.getVramByte(0x1234)).toBe(0xAB)
    })

    it('should mask VRAM addresses to 16 bits (§7)', () => {
      vdp.setVramByte(0xFFFF, 0xCD)
      expect(vdp.getVramByte(0xFFFF)).toBe(0xCD)
      expect(vdp.getVramByte(0x3FFF)).toBe(0x00) // no longer the same byte

      vdp.setVramByte(0x1FFFF, 0x77) // 17 bits in, wraps to $FFFF
      expect(vdp.getVramByte(0xFFFF)).toBe(0x77)
    })

    it('should read/write registers directly', () => {
      vdp.setRegister(3, 0xFF)
      expect(vdp.getRegister(3)).toBe(0xFF)
    })

    it('should update mode when setting register directly', () => {
      vdp.setRegister(0, 0x02)
      expect(vdp.getMode()).toBe(TmsMode.GRAPHICS_II)
    })
  })
})

describe('direct VRAM access', () => {
  /**
   * The CPU can only reach VRAM through the address latch and the
   * auto-incrementing data port, which moves the pointer and refills the
   * read-ahead buffer. Inspecting memory must not disturb the machine.
   */
  it('reads and writes without touching the address latch', () => {
    const video = new Video()

    video.writeVRAM(0x1234, 0x5a)
    expect(video.readVRAM(0x1234)).toBe(0x5a)
    expect(video.vramSize).toBe(1 << 16) // 64 KB (§7)
  })

  it('wraps at the top of the 64K, as the address counter does', () => {
    const video = new Video()
    video.writeVRAM(0x0000, 0x11)
    expect(video.readVRAM(0x10000)).toBe(0x11)
  })
})

describe('textGrid', () => {
  it('reads text mode as 40 columns of CP437, one row per 8 pixel rows', () => {
    const vdp = new Video()
    setupTextMode(vdp)
    writeVramBytes(vdp, 0x3800, [...'HELLO, WORLD!'].map((c) => c.charCodeAt(0)))

    const grid = vdp.textGrid()
    expect(grid).toHaveLength(24)
    expect(grid[0]).toHaveLength(40)
    expect(grid[0]!.startsWith('HELLO, WORLD!')).toBe(true)
  })

  it('reads a graphics mode as 32 columns', () => {
    const vdp = new Video()
    setupGraphicsI(vdp)
    writeVramBytes(vdp, 0x3800, [...'READY'].map((c) => c.charCodeAt(0)))

    const grid = vdp.textGrid()
    expect(grid[0]).toHaveLength(32)
    expect(grid[0]!.startsWith('READY')).toBe(true)
  })

  it('reads the second row from the next tile row of the name table', () => {
    const vdp = new Video()
    setupTextMode(vdp)
    writeVramBytes(vdp, 0x3800 + 40, [...'ROW TWO'].map((c) => c.charCodeAt(0)))

    expect(vdp.textGrid()[1]!.startsWith('ROW TWO')).toBe(true)
  })
})

/**
 * The oracle the VDP rewrite is measured against (PLAN.md §3).
 *
 * These deliberately assert nothing about which RGBA a given index is — that is
 * the palette's business, and Phase 3 replaces it. What they pin is the
 * relationship: the index frame and the RGBA frame describe the same picture,
 * and the index frame says something the RGBA frame cannot.
 */
describe('frameIndices', () => {
  /** The RGBA quad the front buffer holds at a pixel. */
  const rgbaAt = (vdp: Video, pixel: number): number[] =>
    Array.from(vdp.buffer.subarray(pixel * 4, pixel * 4 + 4))

  it('is one byte per pixel of the 320x240 frame', () => {
    const vdp = new Video()
    expect(vdp.frameIndices()).toHaveLength(DISPLAY_WIDTH * DISPLAY_HEIGHT)
  })

  it('agrees with the RGBA front buffer pixel for pixel', () => {
    const vdp = new Video()
    setupGraphicsI(vdp)
    clearSprites(vdp)
    // Two glyphs' worth of pattern, so the frame is not one flat color.
    writeVramBytes(vdp, 0x2000, [0xff, 0x81, 0xa5, 0x99, 0x99, 0xa5, 0x81, 0xff])
    writeVramBytes(vdp, 0x0000, [0xf1]) // color group 0: white on black
    writeVramBytes(vdp, 0x3800, [0, 0, 0, 0, 0, 0, 0, 0])
    renderOneFrame(vdp)

    // Every occurrence of an index must carry the same color, and every color
    // must come from one index — a renderer that wrote the two buffers from
    // different decisions fails here. Mismatches are collected rather than
    // asserted per pixel: 76,800 expect() calls a frame is seconds of runtime.
    const colorOfIndex = new Map<number, string>()
    const indexOfColor = new Map<string, number>()
    const mismatches: string[] = []
    const indices = vdp.frameIndices()
    for (let i = 0; i < indices.length; i++) {
      const index = indices[i]!
      const color = rgbaAt(vdp, i).join(',')
      const seenColor = colorOfIndex.get(index)
      const seenIndex = indexOfColor.get(color)
      if (seenColor !== undefined && seenColor !== color) {
        mismatches.push(`pixel ${i}: index ${index} is (${color}), was (${seenColor})`)
      }
      if (seenIndex !== undefined && seenIndex !== index) {
        mismatches.push(`pixel ${i}: color (${color}) is index ${index}, was ${seenIndex}`)
      }
      colorOfIndex.set(index, color)
      indexOfColor.set(color, index)
    }
    expect(mismatches).toEqual([])
    expect(colorOfIndex.size).toBeGreaterThan(1)
  })

  it('carries the backdrop index across the border', () => {
    const vdp = new Video()
    setupGraphicsI(vdp) // register 7 = $17: backdrop cyan
    clearSprites(vdp)
    renderOneFrame(vdp)

    // The top-left corner is outside the 256x192 active area.
    expect(vdp.frameIndices()[0]).toBe(TmsColor.CYAN)
  })

  it('distinguishes two indices the palette renders identically', () => {
    // Transparent and black are both opaque black in the output, so the RGBA
    // buffer cannot tell a renderer that drew one from a renderer that drew the
    // other. That is the whole reason this accessor exists.
    const vdp = new Video()
    setupTextMode(vdp)
    writeRegister(vdp, 7, 0x10) // foreground black(1) on backdrop transparent(0)
    renderOneFrame(vdp)

    expect(vdp.frameIndices()[0]).toBe(TmsColor.TRANSPARENT)
    expect(rgbaAt(vdp, 0)).toEqual([0x00, 0x00, 0x00, 0xff]) // same as black

    writeRegister(vdp, 7, 0x01) // backdrop black(1)
    renderOneFrame(vdp)

    expect(vdp.frameIndices()[0]).toBe(TmsColor.BLACK)
    expect(rgbaAt(vdp, 0)).toEqual([0x00, 0x00, 0x00, 0xff]) // indistinguishable
  })

  it('holds a whole frame, updated only when one completes', () => {
    // What makes a capture at an arbitrary cycle count reproducible: like
    // `buffer`, this is the last *complete* frame, never a half-drawn one.
    const vdp = new Video()
    setupGraphicsI(vdp)
    clearSprites(vdp)
    renderOneFrame(vdp)
    expect(vdp.frameIndices()[0]).toBe(TmsColor.CYAN)

    writeRegister(vdp, 7, 0x14) // backdrop dark blue
    for (let i = 0; i < 1000; i++) vdp.tick(1000000)
    expect(vdp.frameIndices()[0]).toBe(TmsColor.CYAN)

    renderOneFrame(vdp)
    expect(vdp.frameIndices()[0]).toBe(TmsColor.DK_BLUE)
  })
})

/**
 * The bus the 6502-PICOVDP presents (§4, §5, §7) — the structural half of the
 * card, with the TMS9918's renderers still running on top of it.
 *
 * Register and VRAM widths and the port count are the things a program can
 * detect without drawing anything, so they are tested here rather than left to
 * the golden frames, which by design cannot see any of it.
 */
describe('the VDP bus', () => {
  /** Two writes to a command port: payload, then command byte. */
  const command = (vdp: Video, port: 0 | 1, payload: number, byte: number): void => {
    const address = port === 0 ? 1 : 3
    vdp.write(address, payload)
    vdp.write(address, byte)
  }

  /** Point a port at an address, for writing or for reading. */
  const pointAt = (vdp: Video, port: 0 | 1, addr: number, mode: 'read' | 'write'): void =>
    command(vdp, port, addr & 0xff, ((addr >> 8) & 0x3f) | (mode === 'write' ? 0x40 : 0x00))

  /** The data port of a pair. */
  const dataPort = (port: 0 | 1): number => (port === 0 ? 0 : 2)

  const setReg = (vdp: Video, reg: number, value: number): void =>
    command(vdp, 0, value, 0x80 | reg)

  describe('four ports decoded from A1:A0 (§4)', () => {
    it('mirrors the four ports across the whole 1 KB slot window', () => {
      // Slot 8 hands the card an offset into $9C00-$9FFF. Only A1:A0 are
      // decoded, so $9C05 is $9C01 and a program that uses the mirrors works.
      const vdp = new Video()
      pointAt(vdp, 0, 0x0123, 'write')
      vdp.write(0x3fc, 0x11) // mirror of VC_DATA
      vdp.write(0x100, 0x22) // and again
      expect(vdp.getVramByte(0x0123)).toBe(0x11)
      expect(vdp.getVramByte(0x0124)).toBe(0x22)
    })

    it('gives each pair its own pointer', () => {
      const vdp = new Video()
      pointAt(vdp, 0, 0x0100, 'write')
      pointAt(vdp, 1, 0x2000, 'write')

      vdp.write(0, 0xa0)
      vdp.write(2, 0xb0)
      vdp.write(0, 0xa1)
      vdp.write(2, 0xb1)

      expect([vdp.getVramByte(0x0100), vdp.getVramByte(0x0101)]).toEqual([0xa0, 0xa1])
      expect([vdp.getVramByte(0x2000), vdp.getVramByte(0x2001)]).toEqual([0xb0, 0xb1])
    })

    it('gives each pair its own prefetch byte', () => {
      const vdp = new Video()
      vdp.setVramByte(0x0100, 0xaa)
      vdp.setVramByte(0x2000, 0xbb)

      pointAt(vdp, 0, 0x0100, 'read')
      pointAt(vdp, 1, 0x2000, 'read')

      // Interleaved: a shared prefetch buffer would hand each port the other's
      // byte. Reading port B in between must not disturb port A's.
      expect(vdp.read(2)).toBe(0xbb)
      expect(vdp.read(0)).toBe(0xaa)
    })

    it('gives each pair its own command flip-flop, which is the point (§4)', () => {
      // The hazard the AC6502 documentation warns about: an interrupt landing
      // between the two halves of a command pair. With port B belonging to the
      // handler, port A's half-finished pair survives it.
      const vdp = new Video()
      vdp.write(1, 0x77) // port A: payload latched, command byte still to come

      // "Interrupt": a complete command pair on port B, plus a status read.
      command(vdp, 1, 0x42, 0x87)
      vdp.read(3)

      vdp.write(1, 0x87) // port A finishes its pair
      expect(vdp.getRegister(7)).toBe(0x77)
    })

    it('resets only the reading port’s flip-flop on a status read', () => {
      const vdp = new Video()
      vdp.write(1, 0x33) // port A: payload latched
      vdp.read(3) // status on port B

      vdp.write(1, 0x87)
      expect(vdp.getRegister(7)).toBe(0x33)

      vdp.write(1, 0x44) // port A: payload latched again
      vdp.read(1) // status on port A — this one does clear it

      // The next write is read as a payload, not as a command byte, so nothing
      // lands until a second write completes the pair.
      vdp.write(1, 0x87)
      expect(vdp.getRegister(7)).toBe(0x33)
    })

    it('lets both pairs write the same register file and the same VRAM', () => {
      const vdp = new Video()
      command(vdp, 1, 0x5a, 0x80 | 0x22) // SPRCOUNT, from port B
      expect(vdp.getRegister(0x22)).toBe(0x5a)

      pointAt(vdp, 1, 0x4321, 'write')
      vdp.write(2, 0x99)
      pointAt(vdp, 0, 0x4321, 'read')
      expect(vdp.read(0)).toBe(0x99)
    })
  })

  describe('a 128-register file (§5)', () => {
    it('reaches every register from the command port', () => {
      const vdp = new Video()
      for (let reg = 0; reg < 128; reg++) setReg(vdp, reg, (reg * 7) & 0xff)
      for (let reg = 0; reg < 128; reg++) {
        // $02-$06 alias into the layer and sprite blocks, so they read back what
        // the later write to their canonical address left.
        if (reg >= 0x02 && reg <= 0x06) continue
        expect(vdp.getRegister(reg)).toBe((reg * 7) & 0xff)
      }
    })

    it('makes $02-$06 the same storage as $10-$12, $20 and $21', () => {
      const vdp = new Video()
      const aliases: [number, number][] = [
        [0x02, 0x10], // L0NAME
        [0x03, 0x11], // L0ATTR
        [0x04, 0x12], // L0PAT
        [0x05, 0x20], // SPRATTR
        [0x06, 0x21] // SPRPAT
      ]

      for (const [legacy, modern] of aliases) {
        setReg(vdp, legacy, 0xa5)
        expect(vdp.getRegister(modern)).toBe(0xa5)

        setReg(vdp, modern, 0x5a)
        expect(vdp.getRegister(legacy)).toBe(0x5a)
      }
    })

    it('has the alias reach the renderer, not just the accessor', () => {
      // The proof that it is one byte and not two that are kept in step: write
      // the name table base through $10 only, and the Text renderer — which
      // knows nothing but register 2 — still finds it.
      const vdp = new Video()
      setupTextMode(vdp)
      setReg(vdp, 0x10, 0x0e) // name table at $3800, via the new address
      writeVramBytes(vdp, 0x3800, [...'ALIASED'].map((c) => c.charCodeAt(0)))
      expect(vdp.textGrid()[0]!.startsWith('ALIASED')).toBe(true)
    })

    it('takes the §15 reset values, not all zeros', () => {
      const vdp = new Video()
      vdp.setRegister(0x09, 0xff)
      vdp.setRegister(0x23, 0x00)
      vdp.reset(true)

      expect(vdp.getRegister(0x09)).toBe(0x01) // VINC +1
      expect(vdp.getRegister(0x0c)).toBe(0x3f) // PALBASE, palette at $FC00
      expect(vdp.getRegister(0x15)).toBe(0x3c) // L0CTRL enabled, index 0 opaque
      expect(vdp.getRegister(0x1d)).toBe(0x0c) // L1CTRL disabled
      expect(vdp.getRegister(0x22)).toBe(0x20) // SPRCOUNT 32
      expect(vdp.getRegister(0x23)).toBe(0x27) // SPRCTRL
      expect(vdp.getRegister(0x24)).toBe(0x20) // SPRLIMIT 32
      for (let reg = 0; reg < 8; reg++) expect(vdp.getRegister(reg)).toBe(0)
    })

    it('is in its reset state before anything resets it', () => {
      // There is no such state on the hardware, and a card whose VINC was 0
      // until the first reset had a VRAM pointer that never advanced.
      expect(new Video().getRegister(0x09)).toBe(0x01)
    })
  })

  describe('64 KB of VRAM, VBANK and VINC (§4, §7)', () => {
    it('takes pointer bits 15:14 from VBANK', () => {
      const vdp = new Video()
      setReg(vdp, 0x08, 0x02) // VBANK = 2 -> $8000
      pointAt(vdp, 0, 0x0123, 'write')
      vdp.write(0, 0x42)
      expect(vdp.getVramByte(0x8123)).toBe(0x42)
      expect(vdp.getVramByte(0x0123)).toBe(0x00)
    })

    it('ignores VBANK bits above the 64 KB that exists', () => {
      // §5: bits 1:0 are implemented; the rest read as written and are reserved
      // for a larger VRAM.
      const vdp = new Video()
      setReg(vdp, 0x08, 0xfd) // b1:0 = 01, everything above reserved
      pointAt(vdp, 0, 0x0010, 'write')
      vdp.write(0, 0x77)
      expect(vdp.getVramByte(0x4010)).toBe(0x77)
      expect(vdp.getRegister(0x08)).toBe(0xfd)
    })

    it('samples VBANK when the pointer is set, not when it is used', () => {
      const vdp = new Video()
      setReg(vdp, 0x08, 0x01)
      pointAt(vdp, 0, 0x0000, 'write')
      setReg(vdp, 0x08, 0x03) // moving the bank must not move a live pointer
      vdp.write(0, 0x11)
      expect(vdp.getVramByte(0x4000)).toBe(0x11)
      expect(vdp.getVramByte(0xc000)).toBe(0x00)
    })

    it('carries out of a bank rather than wrapping inside it (§4)', () => {
      // The one place TMS9918 behavior is deliberately broken: a streaming write
      // runs off the end of a bank into the next one.
      const vdp = new Video()
      setReg(vdp, 0x08, 0x00)
      pointAt(vdp, 0, 0x3ffe, 'write')
      for (const byte of [0x01, 0x02, 0x03, 0x04]) vdp.write(0, byte)

      expect([
        vdp.getVramByte(0x3ffe),
        vdp.getVramByte(0x3fff),
        vdp.getVramByte(0x4000),
        vdp.getVramByte(0x4001)
      ]).toEqual([0x01, 0x02, 0x03, 0x04])
      expect(vdp.getVramByte(0x0000)).toBe(0x00) // nothing wrapped to the base
    })

    it('wraps at the top of the 64 KB, having nowhere else to go', () => {
      const vdp = new Video()
      setReg(vdp, 0x08, 0x03)
      pointAt(vdp, 0, 0x3fff, 'write') // $FFFF
      vdp.write(0, 0xee)
      vdp.write(0, 0xff)
      expect(vdp.getVramByte(0xffff)).toBe(0xee)
      expect(vdp.getVramByte(0x0000)).toBe(0xff)
    })

    it('advances by the signed stride in VINC', () => {
      const vdp = new Video()
      setReg(vdp, 0x09, 0x04) // every fourth byte
      pointAt(vdp, 0, 0x0100, 'write')
      for (const byte of [0x11, 0x22, 0x33]) vdp.write(0, byte)
      expect([
        vdp.getVramByte(0x0100),
        vdp.getVramByte(0x0104),
        vdp.getVramByte(0x0108)
      ]).toEqual([0x11, 0x22, 0x33])
    })

    it('walks backwards on a negative stride', () => {
      const vdp = new Video()
      setReg(vdp, 0x09, 0xff) // -1
      pointAt(vdp, 0, 0x0102, 'write')
      for (const byte of [0x11, 0x22, 0x33]) vdp.write(0, byte)
      expect([
        vdp.getVramByte(0x0102),
        vdp.getVramByte(0x0101),
        vdp.getVramByte(0x0100)
      ]).toEqual([0x11, 0x22, 0x33])
    })

    it('stays put on a stride of zero', () => {
      const vdp = new Video()
      setReg(vdp, 0x09, 0x00)
      pointAt(vdp, 0, 0x0200, 'write')
      for (const byte of [0x11, 0x22, 0x33]) vdp.write(0, byte)
      expect(vdp.getVramByte(0x0200)).toBe(0x33) // the last one wins
      expect(vdp.getVramByte(0x0201)).toBe(0x00)
    })

    it('applies the stride to reads as well, prefetch included', () => {
      const vdp = new Video()
      for (let i = 0; i < 16; i++) vdp.setVramByte(0x0300 + i, 0xa0 + i)
      setReg(vdp, 0x09, 0x03)
      pointAt(vdp, 0, 0x0300, 'read')
      expect([vdp.read(0), vdp.read(0), vdp.read(0)]).toEqual([0xa0, 0xa3, 0xa6])
    })

    it('gives each port its own stride position, sharing one VINC', () => {
      const vdp = new Video()
      setReg(vdp, 0x09, 0x02)
      pointAt(vdp, 0, 0x0400, 'write')
      pointAt(vdp, 1, 0x0500, 'write')
      vdp.write(0, 0x11)
      vdp.write(2, 0x21)
      vdp.write(0, 0x12)
      vdp.write(2, 0x22)
      expect([vdp.getVramByte(0x0400), vdp.getVramByte(0x0402)]).toEqual([0x11, 0x12])
      expect([vdp.getVramByte(0x0500), vdp.getVramByte(0x0502)]).toEqual([0x21, 0x22])
    })

    /**
     * §4 says of the pointer carrying across a bank boundary: "`VBANK` reads
     * back updated." With one `VBANK` register and two independent pointers
     * that cannot be literally true — §4 also gives each port pair its own
     * pointer, and a shared bank would break the use it is there for (port B
     * parked on the sprite attribute table while port A streams through another
     * bank).
     *
     * So this implementation treats `VBANK` as what it is in the register map:
     * a byte that is sampled when a command sets a pointer. The carry lives in
     * the pointer, which is 16 bits wide and belongs to one port.
     *
     * This test pins that reading rather than asserting it is right. **It is an
     * open question for the specification, not settled here.** If §4 is revised
     * to say a carry writes back — to whichever port carried, or only to port
     * A — this is the test that should change, and the spec is where the
     * decision belongs.
     */
    it('leaves VBANK reading as written when a pointer carries out of its bank', () => {
      const vdp = new Video()
      setReg(vdp, 0x08, 0x00)
      pointAt(vdp, 0, 0x3fff, 'write')
      vdp.write(0, 0x01)
      vdp.write(0, 0x02) // the pointer is now in bank 1

      expect(vdp.getVramByte(0x4000)).toBe(0x02) // the pointer did carry
      expect(vdp.getRegister(0x08)).toBe(0x00) // ...and VBANK did not follow it
    })

    it('zeroes all 64 KB on a cold start', () => {
      const vdp = new Video()
      for (const address of [0x0000, 0x3fff, 0x8000, 0xffff]) vdp.writeVRAM(address, 0xab)
      vdp.reset(true)
      for (const address of [0x0000, 0x3fff, 0x8000, 0xffff]) {
        expect(vdp.readVRAM(address)).toBe(0x00)
      }
    })
  })
})

/**
 * Display timing, the status registers and the interrupt sources — §3, §6, §14.
 *
 * The TMS9918 had one status register, one interrupt and a scanline counter
 * nobody could read. This card has sixteen status registers behind a per-port
 * selector, four interrupt sources with separate enables and latches, and a
 * display line that counts from the top of the *picture* rather than the top of
 * the frame — which is what keeps a raster split in the same place when the mode
 * changes height underneath it.
 */
describe('display timing, status and interrupts', () => {
  /** Two writes to a command port: payload, then command byte. */
  const command = (vdp: Video, port: 0 | 1, payload: number, byte: number): void => {
    const address = port === 0 ? 1 : 3
    vdp.write(address, payload)
    vdp.write(address, byte)
  }

  const setReg = (vdp: Video, reg: number, value: number, port: 0 | 1 = 0): void =>
    command(vdp, port, value, 0x80 | reg)

  /** Read the status port of a pair — whichever register its `STATSEL` names. */
  const readStatus = (vdp: Video, port: 0 | 1 = 0): number => vdp.read(port === 0 ? 1 : 3)

  const FREQUENCY = 1_000_000
  const TOTAL_SCANLINES = 262

  /** Tick until `predicate` holds, or give up after a second of emulated time. */
  const tickUntil = (vdp: Video, what: string, predicate: () => boolean): number => {
    for (let cycles = 0; cycles <= FREQUENCY; cycles++) {
      if (predicate()) return cycles
      vdp.tick(FREQUENCY)
    }
    throw new Error(`never ${what} in a second of emulated time`)
  }

  /** Run to the instant the F flag sets, without reading it through a port. */
  const runToEndOfPicture = (vdp: Video): void => {
    tickUntil(vdp, 'ended the picture', () => (vdp.getStatus() & 0x80) !== 0)
  }

  describe('the display line counter (§3)', () => {
    it('counts from the first line of the picture and wraps at 262', () => {
      const vdp = new Video()
      setReg(vdp, 0x0f, 0x02) // STATSEL_A = STAT2, the display line

      expect(readStatus(vdp)).toBe(0)
      const seen = new Set<number>()
      for (let line = 0; line < TOTAL_SCANLINES; line++) {
        seen.add(readStatus(vdp))
        tickUntil(vdp, 'advanced a line', () => vdp.getDisplayLine() === (line + 1) % TOTAL_SCANLINES)
      }

      // 0-255 arrive once each, and 256-261 alias back onto 0-5 (§6), so the
      // 262 lines of a frame show 256 distinct values through an 8-bit port.
      expect(seen.size).toBe(256)
      expect(vdp.getDisplayLine()).toBe(0)
    })

    it('disambiguates the aliased lines 256-261 with STAT3 (§6)', () => {
      const vdp = new Video()
      setReg(vdp, 0x0f, 0x03) // STATSEL_A = STAT3

      // Display line 5 is picture; line 261, which STAT2 also reports as 5, is
      // the top border — and b0 is what tells a program which one it is in.
      tickUntil(vdp, 'reached line 5', () => vdp.getDisplayLine() === 5)
      expect(readStatus(vdp) & 0x01).toBe(0)

      tickUntil(vdp, 'reached line 261', () => vdp.getDisplayLine() === 261)
      expect(readStatus(vdp) & 0x01).toBe(0x01)
    })
  })

  /**
   * §14's vertical blanking window, which is the whole reason the flag fires at
   * the end of the *picture* rather than the end of the frame.
   *
   * The spec's figures and this raster's disagree by exactly half a line, and
   * both numbers are asserted so that either one moving fails here. The reason
   * is arithmetic rather than a bug: §3 describes the 525-line VGA raster at
   * 59.94 Hz, whose frame is 262.5 lines, while this emulator runs an integer
   * 262 lines at exactly 60 Hz. So it has half a line less of blanking, and each
   * of its lines is a shade shorter — which is where the cycle figures' ~1% and
   * ~2% shortfalls come from.
   */
  describe('the vertical blanking window (§14)', () => {
    const SPEC_WINDOW = {
      192: { lines: 70.5, cycles: 4480 },
      240: { lines: 22.5, cycles: 1430 }
    }

    /** Lines and cycles from the F flag to the first line of the next picture. */
    const measure = (vdp: Video): { flagAt: number; lines: number; cycles: number } => {
      runToEndOfPicture(vdp)
      const flagAt = vdp.getDisplayLine()
      const cycles = tickUntil(vdp, 'started the next picture', () => vdp.getDisplayLine() === 0)
      return { flagAt, lines: TOTAL_SCANLINES - flagAt, cycles }
    }

    it('is 70 lines in a 192-line mode, against the spec’s 70.5', () => {
      const vdp = new Video()
      setReg(vdp, 0x01, 0x40) // display on, legacy Graphics I: 192 lines

      const { flagAt, lines, cycles } = measure(vdp)
      const spec = SPEC_WINDOW[192]

      expect(flagAt).toBe(192) // the flag rose as display line 191 ended
      expect(lines).toBe(70)
      expect(spec.lines - lines).toBeCloseTo(0.5, 10)
      expect(cycles).toBeGreaterThan(spec.cycles * 0.97)
      expect(cycles).toBeLessThanOrEqual(spec.cycles)
    })

    it('collapses to 22 lines in a 240-line mode, against the spec’s 22.5', () => {
      const vdp = new Video()
      setReg(vdp, 0x01, 0x40)
      setReg(vdp, 0x0d, 0x03) // VMODE = Graphics: 32 x 30, 240 lines

      const { flagAt, lines, cycles } = measure(vdp)
      const spec = SPEC_WINDOW[240]

      expect(flagAt).toBe(240)
      expect(lines).toBe(22)
      expect(spec.lines - lines).toBeCloseTo(0.5, 10)
      expect(cycles).toBeGreaterThan(spec.cycles * 0.97)
      expect(cycles).toBeLessThanOrEqual(spec.cycles)
    })

    it('gives Full mode the same 240-line window as Graphics', () => {
      const vdp = new Video()
      setReg(vdp, 0x01, 0x40)
      setReg(vdp, 0x0d, 0x04) // VMODE = Full: 40 x 30
      expect(measure(vdp).flagAt).toBe(240)
    })

    it('leaves the reserved VMODE codes at the legacy height', () => {
      const vdp = new Video()
      setReg(vdp, 0x01, 0x40)
      setReg(vdp, 0x0d, 0x0f) // reserved (§9); nothing says it is 240 lines
      expect(measure(vdp).flagAt).toBe(192)
    })
  })

  describe('the status registers (§6)', () => {
    it('returns $AC from STAT4, which is how §16 detects the card', () => {
      const vdp = new Video()
      // §16's probe, verbatim: select STAT4 by writing $04 then $8F.
      vdp.write(1, 0x04)
      vdp.write(1, 0x8f)
      expect(vdp.read(1)).toBe(0xac)

      // ...and it puts STAT0 back the same way.
      vdp.write(1, 0x00)
      vdp.write(1, 0x8f)
      expect(vdp.read(1)).toBe(0x00)
    })

    it('reports a BCD firmware version and the full capability set', () => {
      const vdp = new Video()
      setReg(vdp, 0x0f, 0x05)
      expect(readStatus(vdp)).toBe(0x01) // 0.1, the revision of VDP-SPEC.md
      setReg(vdp, 0x0f, 0x06)
      // Two layers, 8bpp, sprite flip, hardware scroll, scanline IRQ, 64 KB.
      expect(readStatus(vdp)).toBe(0x3f)
    })

    it('gives each port its own selector, so one cannot disturb the other', () => {
      const vdp = new Video()
      setReg(vdp, 0x0f, 0x04) // STATSEL_A = STAT4, the identification byte
      setReg(vdp, 0x0e, 0x00) // STATSEL_B = STAT0

      runToEndOfPicture(vdp)

      // Port A reads its own register, and reading it does not acknowledge —
      // only STAT0 and STAT1 do (§6). The flag is still there for port B.
      expect(readStatus(vdp, 0)).toBe(0xac)
      expect(readStatus(vdp, 0)).toBe(0xac)
      expect(readStatus(vdp, 1) & 0x80).toBe(0x80)
      // ...which port B's read has now cleared, for both of them.
      expect(vdp.getStatus()).toBe(0)
    })

    it('resets a port’s command flip-flop whatever register was selected', () => {
      const vdp = new Video()
      setReg(vdp, 0x0f, 0x04) // a register with no side effects of its own

      vdp.write(1, 0x42) // the first half of a command pair, abandoned
      vdp.read(1)
      setReg(vdp, 0x07, 0xab) // a complete pair, which must land

      expect(vdp.getRegister(0x07)).toBe(0xab)
    })

    it('reads the reserved collision bitmap as zero until Phase 5', () => {
      const vdp = new Video()
      for (let select = 8; select <= 15; select++) {
        setReg(vdp, 0x0f, select)
        expect(readStatus(vdp)).toBe(0)
      }
    })
  })

  describe('interrupt sources (§14)', () => {
    it('asserts /INT only for a source that IRQEN enables', () => {
      const vdp = new Video()
      setReg(vdp, 0x01, 0x40) // display on, vblank interrupt off

      runToEndOfPicture(vdp)
      expect(vdp.getStatus() & 0x80).toBe(0x80) // the flag rose
      expect(vdp.tick(FREQUENCY) & 0x80).toBe(0) // ...and nothing came of it

      setReg(vdp, 0x0a, 0x01) // IRQEN: vertical blank
      readStatus(vdp) // acknowledge the flag from the frame before
      runToEndOfPicture(vdp)
      expect(vdp.tick(FREQUENCY) & 0x80).toBe(0x80)
    })

    it('leaves no trace in STAT1 of a source that was not enabled', () => {
      const vdp = new Video()
      setReg(vdp, 0x01, 0x40)
      setReg(vdp, 0x0b, 100) // IRQLINE, but IRQEN is clear
      setReg(vdp, 0x0f, 0x01) // STATSEL_A = STAT1

      runToEndOfPicture(vdp)
      expect(readStatus(vdp)).toBe(0)
    })

    it('latches the scanline compare at the line IRQLINE names', () => {
      const vdp = new Video()
      setReg(vdp, 0x01, 0x40)
      setReg(vdp, 0x0b, 100) // IRQLINE = display line 100
      setReg(vdp, 0x0a, 0x02) // IRQEN: scanline compare only
      setReg(vdp, 0x0f, 0x01) // STATSEL_A = STAT1

      // The compare fires at the start of the matching line, and this card
      // renders a line at a time — so the interrupt appears once the counter
      // has moved past 100, and not while it is still short of it.
      tickUntil(vdp, 'reached line 99', () => vdp.getDisplayLine() === 99)
      expect(vdp.tick(FREQUENCY) & 0x80).toBe(0)

      tickUntil(vdp, 'processed line 100', () => vdp.getDisplayLine() === 101)
      expect(vdp.tick(FREQUENCY) & 0x80).toBe(0x80)
      expect(readStatus(vdp)).toBe(0x02) // the compare, and nothing else
      expect(vdp.tick(FREQUENCY) & 0x80).toBe(0) // acknowledged, /INT released
    })

    it('holds /INT until the handler acknowledges, not until the frame ends', () => {
      const vdp = new Video()
      setReg(vdp, 0x01, 0x60) // display on, vblank interrupt enabled

      runToEndOfPicture(vdp)
      // A whole frame later, with no status read in between, it is still there.
      tickUntil(vdp, 'started another picture', () => vdp.getDisplayLine() === 0)
      tickUntil(vdp, 'reached the middle of the picture', () => vdp.getDisplayLine() === 96)
      expect(vdp.tick(FREQUENCY) & 0x80).toBe(0x80)

      readStatus(vdp)
      expect(vdp.tick(FREQUENCY) & 0x80).toBe(0)
    })

    it('acknowledges through STAT1 as well as STAT0, and loses the flags either way', () => {
      const vdp = new Video()
      setReg(vdp, 0x01, 0x60)
      setReg(vdp, 0x0e, 0x01) // STATSEL_B = STAT1

      runToEndOfPicture(vdp)
      expect(readStatus(vdp, 1)).toBe(0x01) // vertical blank latched
      // §6 warns that reading both in one handler loses information: the
      // second read is the one that finds nothing left.
      expect(readStatus(vdp, 0)).toBe(0x00)
      expect(vdp.tick(FREQUENCY) & 0x80).toBe(0)
    })

    /**
     * §14 makes `MODE1` b5 and `IRQEN` b0 one bit under two names. The card
     * keeps the two bytes in step on every write rather than resolving the
     * alias on every read, so what this really asserts is that no sequence of
     * writes can leave a reader able to catch them disagreeing.
     */
    it('makes MODE1 b5 and IRQEN b0 the same bit', () => {
      const vdp = new Video()

      setReg(vdp, 0x01, 0x60) // legacy: enable through register 1
      expect(vdp.getRegister(0x0a) & 0x01).toBe(0x01)

      setReg(vdp, 0x0a, 0x00) // and disable through IRQEN
      expect(vdp.getRegister(0x01) & 0x20).toBe(0)

      setReg(vdp, 0x0a, 0x0f) // every source, vertical blank among them
      expect(vdp.getRegister(0x01) & 0x20).toBe(0x20)

      setReg(vdp, 0x01, 0x40) // legacy code turning it off again
      expect(vdp.getRegister(0x0a)).toBe(0x0e) // ...and only that bit moved
    })

    it('releases /INT on reset', () => {
      const vdp = new Video()
      setReg(vdp, 0x01, 0x60)
      runToEndOfPicture(vdp)
      expect(vdp.tick(FREQUENCY) & 0x80).toBe(0x80)

      vdp.reset(false)
      expect(vdp.tick(FREQUENCY) & 0x80).toBe(0)
      expect(vdp.getStatus()).toBe(0)
    })
  })
})

/**
 * The palette (§11) — 256 entries of 12-bit RGB, living in VRAM.
 *
 * The TMS9918's sixteen colours were burned into the chip; these are 512 bytes
 * of ordinary video memory at `PALBASE`, which the card keeps a cache of and
 * snoops writes into. That makes the palette a thing a program can *change*, and
 * it makes when a change takes effect a question with an answer: on the next
 * pixel drawn, with no reload command and no dirty flag.
 *
 * The legacy renderers still emit four-bit indices, so everything below that
 * draws a picture draws it out of row 0 — which is why row 0 is the TMS9918's
 * colours quantized, and why `COLOR = $1F` is still black on white.
 */
describe('the palette (§11)', () => {
  const PALETTE_BASE = 0xfc00
  const PALETTE_BYTES = 512

  /** Two writes to the command port of pair A: payload, then command byte. */
  const command = (vdp: Video, payload: number, byte: number): void => {
    vdp.write(1, payload)
    vdp.write(1, byte)
  }

  /** Point the data port at any of the 64 KB: bank from A15:A14, rest from A13:A0. */
  const pointAt = (vdp: Video, addr: number): void => {
    command(vdp, (addr >> 14) & 0x03, 0x80 | 0x08) // VBANK
    command(vdp, addr & 0xff, ((addr >> 8) & 0x3f) | 0x40)
  }

  /** Store one entry the way a program would, through a data port. */
  const writeEntry = (vdp: Video, index: number, rgb: number): void => {
    pointAt(vdp, PALETTE_BASE + index * 2)
    vdp.write(0, (rgb >> 8) & 0x0f)
    vdp.write(0, rgb & 0xff)
  }

  /** One entry as it is stored in VRAM: `%0000RRRR`, `%GGGGBBBB`. */
  const storedEntry = (vdp: Video, index: number, base = PALETTE_BASE): number =>
    ((vdp.getVramByte(base + index * 2) & 0x0f) << 8) | vdp.getVramByte(base + index * 2 + 1)

  /** The border's RGB after a complete frame — the backdrop, through the palette. */
  const borderRGB = (vdp: Video): number[] => {
    renderOneFrame(vdp)
    return Array.from(vdp.buffer.subarray(0, 3))
  }

  /** A 12-bit entry expanded the way the output path expands it: nibble × 17. */
  const expand = (rgb: number): number[] => [(rgb >> 8) & 0x0f, (rgb >> 4) & 0x0f, rgb & 0x0f].map(
    (nibble) => nibble * 17
  )

  /** Display on, backdrop `index`, nothing else drawn. */
  const showBackdrop = (vdp: Video, index: number): void => {
    writeRegister(vdp, 1, 0x40)
    writeRegister(vdp, 7, index & 0x0f)
  }

  describe('the default palette', () => {
    /**
     * The sixteen colours the emulator rendered before this phase, 24-bit RGB,
     * as published by the AC6502 documentation for the TMS9918.
     *
     * They are here rather than in `Video.ts` because this is the only claim
     * left that can be wrong: the card holds §11's table, and §11 says that
     * table's row 0 is *these* values quantized. That is a statement about
     * history, and history belongs where it can fail.
     */
    const TMS_PALETTE_24BIT = [
      [0x00, 0x00, 0x00], [0x00, 0x00, 0x00], [0x21, 0xc9, 0x42], [0x5e, 0xdc, 0x78],
      [0x54, 0x55, 0xed], [0x7d, 0x75, 0xfc], [0xd3, 0x52, 0x4d], [0x43, 0xeb, 0xf6],
      [0xfd, 0x55, 0x54], [0xff, 0x79, 0x78], [0xd3, 0xc1, 0x53], [0xe5, 0xce, 0x80],
      [0x21, 0xb0, 0x3c], [0xc9, 0x5b, 0xba], [0xcc, 0xcc, 0xcc], [0xff, 0xff, 0xff]
    ]

    /**
     * Python's `round`, which is what generated §11's table: a tie breaks toward
     * the even number. `Math.round` breaks it upward instead, and the two are
     * not interchangeable here — see the three entries of row 15 below.
     */
    const roundHalfToEven = (value: number): number => {
      const whole = Math.floor(value)
      const fraction = value - whole
      if (fraction > 0.5) return whole + 1
      if (fraction < 0.5) return whole
      return whole % 2 === 0 ? whole : whole + 1
    }

    /** §11's generator, verbatim: a sixteen-step ramp through a pure hue. */
    const ramp = (base: number[]): number[][] => {
      const out: number[][] = []
      for (let n = 0; n < 16; n++) {
        out.push(
          n <= 7
            ? base.map((b) => roundHalfToEven((b * (n + 1)) / 8))
            : base.map((b) => b + roundHalfToEven(((15 - b) * (n - 7)) / 9))
        )
      }
      return out
    }

    const channels = (rgb: number): number[] => [(rgb >> 8) & 0x0f, (rgb >> 4) & 0x0f, rgb & 0x0f]

    it('fills 512 bytes at $FC00, two per entry', () => {
      const vdp = new Video()
      // Every entry is reachable and expanded, not just the sixteen the legacy
      // renderers can name — the cache is 256 wide from the first frame.
      for (let index = 0; index < 256; index++) {
        expect(vdp.paletteEntry(index)).toBe(storedEntry(vdp, index))
      }
      // And it stops there: $FE00 is free space in the §7 map, not palette.
      expect(vdp.getVramByte(PALETTE_BASE + PALETTE_BYTES)).toBe(0x00)
    })

    it('is row 0 the TMS9918 colours, quantized to 4 bits a channel', () => {
      const vdp = new Video()
      for (let index = 0; index < 16; index++) {
        expect(channels(vdp.paletteEntry(index))).toEqual(
          TMS_PALETTE_24BIT[index]!.map((value) => Math.round(value / 17))
        )
      }
    })

    it('is row 1 a grayscale ramp from $000 to $FFF', () => {
      const vdp = new Video()
      for (let index = 0; index < 16; index++) {
        expect(vdp.paletteEntry(16 + index)).toBe(index * 0x111)
      }
    })

    it('is rows 2-15 §11\'s ramp of the pure hue each holds at index 7', () => {
      const vdp = new Video()
      for (let row = 2; row < 16; row++) {
        const generated = ramp(channels(vdp.paletteEntry(row * 16 + 7)))
        for (let index = 0; index < 16; index++) {
          expect({ row, index, rgb: channels(vdp.paletteEntry(row * 16 + index)) }).toEqual({
            row,
            index,
            rgb: generated[index]
          })
        }
      }
    })

    it('rounds ties the way the spec\'s Python does, not the way Math.round does', () => {
      // Row 15's hue is $79C, and three of its steps land exactly on a half.
      // `Math.round` would make them $335, $456 and $68B; the published table
      // says $334, $446 and $68A, because Python rounds a tie toward even. The
      // table is what firmware will be written against, so it is what the card
      // holds — and this is the test that notices if someone "simplifies" the
      // transcription into a `Math.round` generator.
      const vdp = new Video()
      expect(vdp.paletteEntry(15 * 16 + 7)).toBe(0x79c)
      expect(vdp.paletteEntry(15 * 16 + 2)).toBe(0x334)
      expect(vdp.paletteEntry(15 * 16 + 3)).toBe(0x446)
      expect(vdp.paletteEntry(15 * 16 + 6)).toBe(0x68a)
    })

    it('renders COLOR = $1F as black on white', () => {
      // The compatibility claim the whole row makes, end to end: the BIOS's
      // console sets `COLOR` to $1F and expects black text on a white screen,
      // and it does not know the palette changed underneath it.
      const vdp = new Video()
      setupTextMode(vdp)
      writeRegister(vdp, 7, 0x1f) // foreground black (1) on backdrop white (15)
      writeVramBytes(vdp, 0x2000, [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])
      renderOneFrame(vdp)

      const rgbAt = (x: number, y: number): number[] =>
        Array.from(vdp.buffer.subarray((y * DISPLAY_WIDTH + x) * 4, (y * DISPLAY_WIDTH + x) * 4 + 3))

      expect(rgbAt(0, 0)).toEqual([0xff, 0xff, 0xff])   // border: white
      expect(rgbAt(32, 24)).toEqual([0xff, 0xff, 0xff]) // text mode's left padding
      expect(rgbAt(40, 24)).toEqual([0x00, 0x00, 0x00]) // the glyph itself: black
    })
  })

  describe('write snooping', () => {
    it('takes effect on the next pixel drawn, with no reload command', () => {
      const vdp = new Video()
      showBackdrop(vdp, 4)
      expect(borderRGB(vdp)).toEqual(expand(0x55e)) // the default dark blue

      writeEntry(vdp, 4, 0x0a3)
      expect(borderRGB(vdp)).toEqual(expand(0x0a3))
      expect(vdp.paletteEntry(4)).toBe(0x0a3)
    })

    it('snoops a debugger\'s writes as well as a program\'s', () => {
      // A palette poked over the port and a palette poked by a debugger have to
      // reach the screen the same way, or a program is only debuggable while it
      // is not being debugged.
      const vdp = new Video()
      showBackdrop(vdp, 7)

      vdp.setVramByte(PALETTE_BASE + 7 * 2, 0x0f)
      vdp.setVramByte(PALETTE_BASE + 7 * 2 + 1, 0x00)
      expect(vdp.paletteEntry(7)).toBe(0xf00)
      expect(borderRGB(vdp)).toEqual(expand(0xf00))

      vdp.writeVRAM(PALETTE_BASE + 7 * 2 + 1, 0xf0)
      expect(borderRGB(vdp)).toEqual(expand(0xff0))
    })

    it('watches the whole 512-byte window and not a byte more', () => {
      const vdp = new Video()

      // The bytes either side of the window are ordinary VRAM: writing them
      // must leave the entries at each end of the palette exactly as they were.
      const firstEntry = vdp.paletteEntry(0)
      const lastEntry = vdp.paletteEntry(255)
      vdp.setVramByte(PALETTE_BASE - 1, 0xff)
      vdp.setVramByte(PALETTE_BASE + PALETTE_BYTES, 0xff)
      expect(vdp.paletteEntry(0)).toBe(firstEntry)
      expect(vdp.paletteEntry(255)).toBe(lastEntry)

      // Both ends of the window itself are live, including the 240 entries no
      // legacy renderer can name.
      vdp.setVramByte(PALETTE_BASE, 0x0c)
      vdp.setVramByte(PALETTE_BASE + PALETTE_BYTES - 1, 0x9b)
      expect(vdp.paletteEntry(0)).toBe(0xc00)
      expect(vdp.paletteEntry(255)).toBe((lastEntry & 0xf00) | 0x9b)
    })
  })

  describe('PALBASE', () => {
    /** `PALBASE` is a 1 KB granule: $3F is $FC00, $3C is $F000. */
    const setPalbase = (vdp: Video, value: number): void => command(vdp, value, 0x80 | 0x0c)

    it('re-reads the whole window when it moves', () => {
      const vdp = new Video()
      showBackdrop(vdp, 1)

      // A second palette somewhere else in VRAM, one entry of which is green.
      pointAt(vdp, 0xf000 + 1 * 2)
      vdp.write(0, 0x00)
      vdp.write(0, 0xf0)
      expect(borderRGB(vdp)).toEqual(expand(0x000)) // still looking at $FC00

      setPalbase(vdp, 0x3c) // $F000
      expect(vdp.paletteEntry(1)).toBe(0x0f0)
      expect(borderRGB(vdp)).toEqual(expand(0x0f0))
    })

    it('moves the snoop with it', () => {
      const vdp = new Video()
      showBackdrop(vdp, 2)
      const setPalbaseTo = 0xf000

      setPalbase(vdp, 0x3c)
      writeEntry(vdp, 2, 0x123) // still addressed at $FC00 — now ordinary VRAM
      expect(storedEntry(vdp, 2)).toBe(0x123) // it did land there
      expect(vdp.paletteEntry(2)).not.toBe(0x123) // and the card did not see it
      expect(vdp.paletteEntry(2)).toBe(storedEntry(vdp, 2, setPalbaseTo))

      vdp.setVramByte(setPalbaseTo + 2 * 2, 0x05)
      vdp.setVramByte(setPalbaseTo + 2 * 2 + 1, 0x5a)
      expect(vdp.paletteEntry(2)).toBe(0x55a)
      expect(borderRGB(vdp)).toEqual(expand(0x55a))
    })
  })

  describe('reset (§15)', () => {
    it('writes the default palette into VRAM, warm reset included', () => {
      // §15 makes the palette window the one part of VRAM a reset defines, and
      // §11 says as much: "Reset clobbers $FC00-$FDFF." It is the exception to
      // this card keeping its image across a RESET pulse.
      const vdp = new Video()
      const white = vdp.paletteEntry(15)
      writeEntry(vdp, 15, 0x000)
      vdp.writeVRAM(0x0100, 0xab)
      expect(vdp.paletteEntry(15)).toBe(0x000)

      vdp.reset(false)
      expect(vdp.paletteEntry(15)).toBe(white)
      expect(storedEntry(vdp, 15)).toBe(white)
      expect(vdp.readVRAM(0x0100)).toBe(0xab) // the rest of VRAM survives
    })

    it('survives the cold start that zeroes the rest of VRAM', () => {
      const vdp = new Video()
      const grey = vdp.paletteEntry(14)
      vdp.writeVRAM(0x0100, 0xab)

      vdp.reset(true)
      expect(vdp.readVRAM(0x0100)).toBe(0x00)
      expect(vdp.paletteEntry(14)).toBe(grey)
      expect(storedEntry(vdp, 14)).toBe(grey)
    })

    it('writes it at PALBASE, which the register reset has just put back', () => {
      const vdp = new Video()
      command(vdp, 0x3c, 0x80 | 0x0c) // PALBASE = $F000
      vdp.reset(false)

      expect(vdp.getRegister(0x0c)).toBe(0x3f)
      expect(storedEntry(vdp, 15)).toBe(0xfff)
    })
  })

  it('comes back from a snapshot as the palette that was saved', () => {
    // The cache is derived state and is not in the snapshot — VRAM is, and the
    // palette is in VRAM. A restore that forgot to re-read it would draw the
    // previous machine's colours over the restored machine's picture.
    const saved = new Video()
    showBackdrop(saved, 3)
    writeEntry(saved, 3, 0xf0f)

    const restored = new Video()
    restored.deserialize(saved.serialize())

    expect(restored.paletteEntry(3)).toBe(0xf0f)
    expect(borderRGB(restored)).toEqual(expand(0xf0f))
  })
})
