import { Video, TmsMode, TmsColor } from '../../components/IO/Video'

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
const renderOneFrame = (vdp: Video, frequency: number = 2000000): void => {
  // At 2MHz: cyclesPerFrame ≈ 33333, each tick = 128 cycles → ~261 ticks/frame
  const ticksPerFrame = Math.ceil((frequency / 60) / 128)
  for (let i = 0; i < ticksPerFrame; i++) {
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

    it('should mask register index to 3 bits', () => {
      writeRegister(vdp, 0x08, 0xAA) // reg 8 → reg 0
      expect(vdp.getRegister(0)).toBe(0xAA)
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

    it('should wrap VRAM address at 16KB boundary', () => {
      // Write at the end of VRAM
      setWriteAddress(vdp, 0x3FFF)
      vdp.write(0, 0xEE)
      // Next write should wrap to 0x0000
      vdp.write(0, 0xFF)

      expect(vdp.getVramByte(0x3FFF)).toBe(0xEE)
      expect(vdp.getVramByte(0x0000)).toBe(0xFF)
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

    it('should call raiseIRQ when interrupt flag is set', () => {
      const irqFn = jest.fn()
      vdp.raiseIRQ = irqFn

      writeRegister(vdp, 1, 0x60) // Display active + interrupts enabled
      clearSprites(vdp)

      renderOneFrame(vdp)

      expect(irqFn).toHaveBeenCalled()
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

    it('should mask VRAM address to 14 bits', () => {
      vdp.setVramByte(0xFFFF, 0xCD)
      expect(vdp.getVramByte(0x3FFF)).toBe(0xCD)
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
