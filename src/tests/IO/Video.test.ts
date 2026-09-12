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

    it('should not set interrupt flag when interrupts are disabled', () => {
      writeRegister(vdp, 1, 0x40) // Display active, interrupts disabled

      renderOneFrame(vdp)

      expect(vdp.getStatus() & 0x80).toBe(0)
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
      // Dark blue palette: [0x54, 0x55, 0xED, 0xFF]
      const offset = (24 * 320 + 32) * 4 // First active pixel in buffer
      expect(vdp.buffer[offset]).toBe(0x54)     // R
      expect(vdp.buffer[offset + 1]).toBe(0x55) // G
      expect(vdp.buffer[offset + 2]).toBe(0xED) // B
      expect(vdp.buffer[offset + 3]).toBe(0xFF) // A

      // Right padding: last 8 pixels of active area
      const rightPaddingX = 32 + 248 // BORDER_X + (256 - 8)
      const offsetRight = (24 * 320 + rightPaddingX) * 4
      expect(vdp.buffer[offsetRight]).toBe(0x54)
      expect(vdp.buffer[offsetRight + 1]).toBe(0x55)
      expect(vdp.buffer[offsetRight + 2]).toBe(0xED)
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
      // Cyan palette: [0x43, 0xEB, 0xF6, 0xFF]
      expect(vdp.buffer[0]).toBe(0x43)
      expect(vdp.buffer[1]).toBe(0xEB)
      expect(vdp.buffer[2]).toBe(0xF6)
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
      // Dark blue: [0x54, 0x55, 0xED, 0xFF]
      expect(vdp.buffer[offset]).toBe(0x54)
      expect(vdp.buffer[offset + 1]).toBe(0x55)
      expect(vdp.buffer[offset + 2]).toBe(0xED)
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
