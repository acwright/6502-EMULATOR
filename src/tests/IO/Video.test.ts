import { Video, DISPLAY_WIDTH, DISPLAY_HEIGHT } from '../../core/IO/Video'

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
 * Helper: tick until the front buffer holds a frame built entirely from the
 * state the test has set up, stopping on display line 260.
 *
 * That is two frames of cycles, less a line. A line is built a line ahead (§3),
 * so a fresh or reset card has already built display line 1 from its reset
 * state before a test writes anything; once the counter has been round, every
 * line of the frame it presents next — border rows included — was built after
 * the setup. Stopping at 260 rather than 261 keeps the *next* frame's line 0,
 * which is built as 261 begins, from reporting its sprites over the frame being
 * looked at.
 */
const renderOneFrame = (vdp: Video, frequency: number = 1000000): void => {
  // Each tick = 1 cycle. Cycles per frame = frequency / 60.
  const cycles = Math.ceil((2 * frequency) / 60) - 1 - Math.ceil(frequency / 60 / 262)
  for (let i = 0; i < cycles; i++) {
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
      expect(vdp.getMode().legacy).toBe('graphics-i')
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
      expect(vdp.getMode().legacy).toBe('graphics-ii')

      // Text: reg 1 bit 4
      writeRegister(vdp, 0, 0x00)
      writeRegister(vdp, 1, 0x10)
      expect(vdp.getMode().legacy).toBe('text')

      // Multicolor: reg 1 bit 3
      writeRegister(vdp, 1, 0x08)
      expect(vdp.getMode().legacy).toBe('multicolor')

      // Graphics I: no special bits
      writeRegister(vdp, 0, 0x00)
      writeRegister(vdp, 1, 0x00)
      expect(vdp.getMode().legacy).toBe('graphics-i')
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
      expect(vdp.getMode().legacy).toBe('graphics-i')
    })

    it('should detect Graphics II mode (reg 0 bit 1)', () => {
      writeRegister(vdp, 0, 0x02)
      expect(vdp.getMode().legacy).toBe('graphics-ii')
    })

    it('should detect Text mode (reg 1 bit 4)', () => {
      writeRegister(vdp, 0, 0x00)
      writeRegister(vdp, 1, 0x10)
      expect(vdp.getMode().legacy).toBe('text')
    })

    it('should detect Multicolor mode (reg 1 bit 3)', () => {
      writeRegister(vdp, 0, 0x00)
      writeRegister(vdp, 1, 0x08)
      expect(vdp.getMode().legacy).toBe('multicolor')
    })

    // §9's table resolves the combinations the TMS9918 leaves undocumented, row
    // by row: `M1` is "1 × ×", so Text beats both others; `M2` is "1 ×" under
    // `M1` = 0, so Multicolor beats Graphics II. The code before Phase 8 let
    // `M3` win over everything, which is the opposite of the first row.
    it('lets M1 win over M2 and M3, as §9 orders them', () => {
      writeRegister(vdp, 0, 0x02) // M3
      writeRegister(vdp, 1, 0x18) // M1 and M2
      expect(vdp.getMode().legacy).toBe('text')
      expect(vdp.getMode().geometry).toBe('text')
    })

    it('lets M2 win over M3', () => {
      writeRegister(vdp, 0, 0x02) // M3
      writeRegister(vdp, 1, 0x08) // M2
      expect(vdp.getMode().legacy).toBe('multicolor')
    })

    it('draws Text, not Compact, when M1 and M3 are both set', () => {
      // The geometry is what the precedence decides, and it is visible: the
      // name table is read at Text's stride of 40 rather than Compact's 32.
      setupTextMode(vdp)
      writeRegister(vdp, 0, 0x02) // M3 as well
      writeVramBytes(vdp, 0x3800 + 40, [...'ROW TWO'].map((c) => c.charCodeAt(0)))
      expect(vdp.textGrid()[1]!.startsWith('ROW TWO')).toBe(true)
    })

    describe('getMode', () => {
      // Every field of §9's table for one geometry, so a golden or a debugger
      // reply that carries the object carries the right numbers.
      const GEOMETRIES = [
        { vmode: 0x1, geometry: 'text', cols: 40, rows: 24, cellWidth: 6, width: 240, lines: 192, originX: 40, originY: 24 },
        { vmode: 0x2, geometry: 'compact', cols: 32, rows: 24, cellWidth: 8, width: 256, lines: 192, originX: 32, originY: 24 },
        { vmode: 0x3, geometry: 'graphics', cols: 32, rows: 30, cellWidth: 8, width: 256, lines: 240, originX: 32, originY: 0 },
        { vmode: 0x4, geometry: 'full', cols: 40, rows: 30, cellWidth: 8, width: 320, lines: 240, originX: 0, originY: 0 }
      ] as const

      for (const expected of GEOMETRIES) {
        it(`reports VMODE $${expected.vmode} as ${expected.geometry}, with no legacy mode`, () => {
          writeRegister(vdp, 0x0d, expected.vmode)
          expect(vdp.getMode()).toEqual({ ...expected, legacy: null })
        })
      }

      it('reports the legacy submode by the TMS9918 mode and the geometry it lands on', () => {
        expect(vdp.getMode()).toMatchObject({ vmode: 0, legacy: 'graphics-i', geometry: 'compact' })

        writeRegister(vdp, 1, 0x10)
        expect(vdp.getMode()).toMatchObject({ vmode: 0, legacy: 'text', geometry: 'text' })

        // Asked for Graphics II, drawn as Graphics I on the Compact grid: both
        // halves are reported, because either alone would mislead.
        writeRegister(vdp, 1, 0x00)
        writeRegister(vdp, 0, 0x02)
        expect(vdp.getMode()).toMatchObject({ vmode: 0, legacy: 'graphics-ii', geometry: 'compact' })
      })

      it('reports a reserved VMODE as written, resolving to the legacy submode', () => {
        writeRegister(vdp, 0x0d, 0x07)
        expect(vdp.getMode()).toMatchObject({ vmode: 7, legacy: 'graphics-i', geometry: 'compact' })
      })
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
      expect(vdp.getMode().legacy).toBe('graphics-ii')
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

  // All four of §9's grids, not only the two the legacy submode can reach. The
  // last cell of the last row is the one that catches a wrong stride or a wrong
  // row count, because both move it.
  describe.each([
    { vmode: 0x1, name: 'Text', cols: 40, rows: 24 },
    { vmode: 0x2, name: 'Compact', cols: 32, rows: 24 },
    { vmode: 0x3, name: 'Graphics', cols: 32, rows: 30 },
    { vmode: 0x4, name: 'Full', cols: 40, rows: 30 }
  ])('in $name mode', ({ vmode, cols, rows }) => {
    it(`reads ${cols} x ${rows} cells`, () => {
      const vdp = new Video()
      writeRegister(vdp, 0x0d, vmode)
      writeRegister(vdp, 0x10, 0x04) // L0NAME: name table at $1000
      writeVramBytes(vdp, 0x1000, [0x41])
      writeVramBytes(vdp, 0x1000 + cols * rows - 1, [0x5a])

      const grid = vdp.textGrid()
      expect(grid).toHaveLength(rows)
      expect(grid.every((line) => line.length === cols)).toBe(true)
      expect(grid[0]![0]).toBe('A')
      expect(grid[rows - 1]![cols - 1]).toBe('Z')
    })
  })
})

describe('debugger accessors', () => {
  it('peeks at STAT0 and STAT1 without acknowledging them (§6)', () => {
    const vdp = new Video()
    writeRegister(vdp, 1, 0x60) // display on, vblank interrupt enabled
    renderOneFrame(vdp)
    expect(vdp.peekStatus(0) & 0x80).toBe(0x80)
    expect(vdp.peekStatus(1) & 0x01).toBe(0x01)

    // Looking twice sees the same thing, and /INT is still asserted — which a
    // port read would have released.
    expect(vdp.peekStatus(0) & 0x80).toBe(0x80)
    expect(vdp.peekStatus(1) & 0x01).toBe(0x01)
    expect(vdp.tick(1_000_000)).toBe(0x80)

    expect(vdp.read(1) & 0x80).toBe(0x80) // the program's read acknowledges
    expect(vdp.peekStatus(0) & 0x80).toBe(0)
  })

  it('peeks at the identification register, as a program selecting STAT4 would read it (§16)', () => {
    const vdp = new Video()
    expect(vdp.peekStatus(4)).toBe(0xac)
  })

  it('resets both port pairs to pointer 0, direction read, flip-flop cleared (§15)', () => {
    const vdp = new Video()
    setWriteAddress(vdp, 0x1234)
    vdp.write(3, 0x99)
    vdp.reset(false)

    const reset = { pointer: 0, readMode: true, readAhead: 0, awaitingCommand: false, payload: 0 }
    expect(vdp.portState('a')).toEqual(reset)
    expect(vdp.portState('b')).toEqual(reset)
    expect(new Video().portState('a')).toEqual(reset)
  })

  it('reports each port pair separately, without disturbing either', () => {
    const vdp = new Video()
    setWriteAddress(vdp, 0x1234) // port A
    vdp.write(3, 0x99) // port B: first half of a command pair

    expect(vdp.portState('a')).toEqual({
      pointer: 0x1234,
      readMode: false,
      readAhead: 0,
      awaitingCommand: false,
      payload: 0x34
    })
    expect(vdp.portState('b')).toMatchObject({ awaitingCommand: true, payload: 0x99 })

    // Port B finishes the command it was halfway through, onto register 7.
    vdp.write(3, 0x87)
    expect(vdp.getRegister(7)).toBe(0x99)
  })
})

/**
 * The oracle the VDP rewrite is measured against.
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
    expect(vdp.frameIndices()[0]).toBe(7 /* cyan */)
  })

  it('distinguishes two indices the palette renders identically', () => {
    // Transparent and black are both opaque black in the output, so the RGBA
    // buffer cannot tell a renderer that drew one from a renderer that drew the
    // other. That is the whole reason this accessor exists.
    const vdp = new Video()
    setupTextMode(vdp)
    writeRegister(vdp, 7, 0x10) // foreground black(1) on backdrop transparent(0)
    renderOneFrame(vdp)

    expect(vdp.frameIndices()[0]).toBe(0 /* transparent */)
    expect(rgbaAt(vdp, 0)).toEqual([0x00, 0x00, 0x00, 0xff]) // same as black

    writeRegister(vdp, 7, 0x01) // backdrop black(1)
    renderOneFrame(vdp)

    expect(vdp.frameIndices()[0]).toBe(1 /* black */)
    expect(rgbaAt(vdp, 0)).toEqual([0x00, 0x00, 0x00, 0xff]) // indistinguishable
  })

  it('holds a whole frame, updated only when one completes', () => {
    // What makes a capture at an arbitrary cycle count reproducible: like
    // `buffer`, this is the last *complete* frame, never a half-drawn one.
    const vdp = new Video()
    setupGraphicsI(vdp)
    clearSprites(vdp)
    renderOneFrame(vdp)
    expect(vdp.frameIndices()[0]).toBe(7 /* cyan */)

    writeRegister(vdp, 7, 0x14) // backdrop dark blue
    for (let i = 0; i < 1000; i++) vdp.tick(1000000)
    expect(vdp.frameIndices()[0]).toBe(7 /* cyan */)

    renderOneFrame(vdp)
    expect(vdp.frameIndices()[0]).toBe(4 /* dark blue */)
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
      expect(vdp.getRegister(0x24)).toBe(0x10) // SPRLIMIT 16 (§18: the most every line builds in time)
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
   * The raster does not move with the mode (§3). Screen lines are the clock and
   * the display line is the screen line less the picture's top border, so a
   * change between a 192- and a 240-line geometry moves it by 24 at the next
   * line start — and vertical blank still comes exactly once in the frame it
   * happens in, a frame beginning at screen line 0 (§14).
   */
  describe('screen lines and a change of picture height (§3, §14, §15)', () => {
    it('moves the display line 24 on when the picture grows from 192 to 240 lines', () => {
      const vdp = new Video()
      setReg(vdp, 0x01, 0x40) // 192 lines
      tickUntil(vdp, 'reached line 100', () => vdp.getDisplayLine() === 100)

      setReg(vdp, 0x0d, 0x03) // Graphics
      expect(vdp.getDisplayLine()).toBe(100) // not at the write...
      tickUntil(vdp, 'began another line', () => vdp.getDisplayLine() !== 100)
      expect(vdp.getDisplayLine()).toBe(125) // ...at the next line start, 24 on
    })

    it('moves it 24 back when the picture shrinks, so a line compares twice', () => {
      const vdp = new Video()
      setReg(vdp, 0x01, 0x40)
      setReg(vdp, 0x0d, 0x03) // Graphics
      setReg(vdp, 0x0b, 90) // IRQLINE
      setReg(vdp, 0x0a, 0x02) // IRQEN: scanline compare
      setReg(vdp, 0x0e, 0x01) // STATSEL_B = STAT1

      tickUntil(vdp, 'began line 90', () => vdp.getDisplayLine() === 90)
      expect(readStatus(vdp, 1)).toBe(0x02)
      tickUntil(vdp, 'reached line 100', () => vdp.getDisplayLine() === 100)

      setReg(vdp, 0x0d, 0x01) // Text: 192 lines
      tickUntil(vdp, 'began another line', () => vdp.getDisplayLine() !== 100)
      expect(vdp.getDisplayLine()).toBe(77)
      tickUntil(vdp, 'began line 90 again', () => vdp.getDisplayLine() === 90)
      expect(readStatus(vdp, 1)).toBe(0x02) // the same frame, the same number
    })

    it('raises vertical blank at once when a shrinking picture has already passed its new end', () => {
      const vdp = new Video()
      setReg(vdp, 0x01, 0x40)
      setReg(vdp, 0x0d, 0x04) // Full: the picture ends at screen line 240
      setReg(vdp, 0x0a, 0x01) // IRQEN: vertical blank
      setReg(vdp, 0x0e, 0x01) // STATSEL_B = STAT1

      tickUntil(vdp, 'began line 220', () => vdp.getDisplayLine() === 220)
      expect(vdp.peekStatus(1)).toBe(0) // Full's picture has not ended

      setReg(vdp, 0x0d, 0x02) // Compact: its picture ends at screen line 216
      tickUntil(vdp, 'began another line', () => vdp.getDisplayLine() !== 220)
      expect(vdp.getDisplayLine()).toBe(197)
      expect(vdp.getStatus() & 0x80).toBe(0x80) // already past it, so now
      expect(readStatus(vdp, 1)).toBe(0x01)

      tickUntil(vdp, 'began the next frame', () => vdp.getDisplayLine() === 238) // screen line 0
      expect(vdp.peekStatus(1)).toBe(0) // once in that frame
      tickUntil(vdp, 'began line 192', () => vdp.getDisplayLine() === 192)
      expect(vdp.peekStatus(1)).toBe(0x01) // and once in this one, at its own end
    })

    it('raises it once when the picture grows across the start of a frame', () => {
      // A change in the top border skips display line 0 altogether. The frame
      // begins at screen line 0 all the same, and its picture ends once.
      const vdp = new Video()
      setReg(vdp, 0x01, 0x40) // 192 lines
      setReg(vdp, 0x0a, 0x01)
      setReg(vdp, 0x0e, 0x01)

      runToEndOfPicture(vdp)
      expect(readStatus(vdp, 1)).toBe(0x01)
      tickUntil(vdp, 'reached the top border', () => vdp.getDisplayLine() === 243) // screen line 5

      setReg(vdp, 0x0d, 0x03) // Graphics
      tickUntil(vdp, 'began another line', () => vdp.getDisplayLine() !== 243)
      expect(vdp.getDisplayLine()).toBe(6)
      tickUntil(vdp, 'began line 239', () => vdp.getDisplayLine() === 239)
      expect(vdp.peekStatus(1)).toBe(0)
      tickUntil(vdp, 'began line 240', () => vdp.getDisplayLine() === 240)
      expect(vdp.peekStatus(1)).toBe(0x01)
    })

    it('keeps the raster through a warm reset, and starts a cold one at display line 0', () => {
      const vdp = new Video()
      setReg(vdp, 0x01, 0x40)
      setReg(vdp, 0x0d, 0x03) // Graphics
      tickUntil(vdp, 'reached line 100', () => vdp.getDisplayLine() === 100)

      vdp.reset(false)
      expect(vdp.getDisplayLine()).toBe(100) // the line being scanned carries on
      tickUntil(vdp, 'began another line', () => vdp.getDisplayLine() !== 100)
      expect(vdp.getDisplayLine()).toBe(77) // numbered for the reset geometry, 192 lines

      vdp.reset(true)
      expect(vdp.getDisplayLine()).toBe(0)
    })

    it('restores the raster from a snapshot, and from one that predates it', () => {
      const vdp = new Video()
      setReg(vdp, 0x01, 0x40)
      tickUntil(vdp, 'reached line 100', () => vdp.getDisplayLine() === 100)
      const state = vdp.serialize()

      const restored = new Video()
      restored.deserialize(state)
      tickUntil(restored, 'began another line', () => restored.getDisplayLine() !== 100)
      expect(restored.getDisplayLine()).toBe(101)

      const { screenLine: _screenLine, ...older } = state
      const fromOlder = new Video()
      fromOlder.deserialize(older)
      tickUntil(fromOlder, 'began another line', () => fromOlder.getDisplayLine() !== 100)
      expect(fromOlder.getDisplayLine()).toBe(101)
    })
  })

  /**
   * §14's vertical blanking window, which is the whole reason the flag fires at
   * the end of the *picture* rather than the end of the frame.
   *
   * The spec's figures and this raster's disagree by exactly half a line, and
   * both numbers are asserted so that either one moving fails here. The reason
   * is arithmetic rather than a bug: §3's frame is 525 VGA lines at 59.94 Hz —
   * 262 display lines and one odd VGA line — while this emulator runs 262 equal
   * lines at exactly 60 Hz, as §18 records. So it has half a line less of
   * blanking, and each of its lines is a shade shorter, which is where the cycle
   * figures' ~1% and ~2% shortfalls come from.
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
    it('sets STAT3 b1 through each VGA line’s horizontal blanking, twice a display line', () => {
      const vdp = new Video()
      setReg(vdp, 0x0f, 0x03) // STATSEL_A = STAT3
      tickUntil(vdp, 'began a line', () => vdp.getDisplayLine() === 1)

      // One display line, sampled every cycle: 20% of each of its two VGA lines.
      const samples: number[] = []
      while (vdp.getDisplayLine() === 1) {
        samples.push(readStatus(vdp) & 0x02)
        vdp.tick(FREQUENCY)
      }
      const runs = samples.reduce(
        (count, bit, index) => count + (bit !== 0 && (index === 0 || samples[index - 1] === 0) ? 1 : 0),
        0
      )
      expect(runs).toBe(2)
      const blanked = samples.filter((bit) => bit !== 0).length / samples.length
      expect(blanked).toBeGreaterThan(0.15)
      expect(blanked).toBeLessThan(0.25)
    })

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
      expect(readStatus(vdp)).toBe(0x04) // 0.4, the revision of VDP-SPEC.md
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

    it('latches the scanline compare at the start of the line IRQLINE names', () => {
      const vdp = new Video()
      setReg(vdp, 0x01, 0x40)
      setReg(vdp, 0x0b, 100) // IRQLINE = display line 100
      setReg(vdp, 0x0a, 0x02) // IRQEN: scanline compare only

      // Not while the counter is still on line 99...
      tickUntil(vdp, 'reached line 99', () => vdp.getDisplayLine() === 99)
      expect(vdp.tick(FREQUENCY) & 0x80).toBe(0)

      // ...but the instant line 100 begins, so a handler finds STAT2 reading
      // the line it asked for (§14).
      tickUntil(vdp, 'began line 100', () => vdp.getDisplayLine() === 100)
      expect(vdp.tick(FREQUENCY) & 0x80).toBe(0x80)
      setReg(vdp, 0x0f, 0x02) // STATSEL_A = STAT2
      expect(readStatus(vdp)).toBe(100)
      setReg(vdp, 0x0f, 0x01) // STATSEL_A = STAT1
      expect(readStatus(vdp)).toBe(0x02) // the compare, and nothing else
      expect(vdp.tick(FREQUENCY) & 0x80).toBe(0) // acknowledged, /INT released
    })

    it('raises vertical blank and IRQLINE = 192 together, at the start of line 192', () => {
      const vdp = new Video()
      setReg(vdp, 0x01, 0x60) // display on, vblank enabled, 192 lines
      setReg(vdp, 0x0b, 192)
      setReg(vdp, 0x0a, 0x03) // vblank and scanline compare
      setReg(vdp, 0x0f, 0x01) // STAT1

      tickUntil(vdp, 'began line 192', () => vdp.getDisplayLine() === 192)
      expect(vdp.peekStatus(1)).toBe(0x03)
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

    it('leaves STAT0 alone when a handler acknowledges through STAT1 on port B', () => {
      // The point of the second port (§4, §6): a handler reads STAT1 on port B,
      // and the F flag foreground code is polling on port A survives it.
      const vdp = new Video()
      setReg(vdp, 0x01, 0x60)
      setReg(vdp, 0x0e, 0x01) // STATSEL_B = STAT1
      // No sprites: a fresh card's 32 slots of zeroed VRAM all cover line 0, and
      // at the reset SPRLIMIT of 16 they would overflow and set OVF beside F.
      setReg(vdp, 0x23, 0x26)

      runToEndOfPicture(vdp)
      expect(readStatus(vdp, 1)).toBe(0x01) // vertical blank latched
      expect(vdp.tick(FREQUENCY) & 0x80).toBe(0) // acknowledged, /INT released
      expect(readStatus(vdp, 0)).toBe(0x80) // and F is still there for port A
    })

    it('acknowledges vblank, overflow and collision with a STAT0 read, as TMS9918 code does', () => {
      const vdp = new Video()
      setReg(vdp, 0x01, 0x60)
      setReg(vdp, 0x0b, 100)
      setReg(vdp, 0x0a, 0x03) // vblank and scanline compare

      runToEndOfPicture(vdp)
      expect(vdp.peekStatus(1)).toBe(0x03)
      expect(readStatus(vdp, 0) & 0x80).toBe(0x80)
      // The vblank latch went with F. The scanline compare has no STAT0 flag, so
      // only a STAT1 read acknowledges it — and /INT stays asserted until then.
      expect(vdp.peekStatus(1)).toBe(0x02)
      expect(vdp.tick(FREQUENCY) & 0x80).toBe(0x80)
    })

    it('releases /INT when the source is disabled, and raises it again if re-enabled', () => {
      const vdp = new Video()
      setReg(vdp, 0x01, 0x60)
      runToEndOfPicture(vdp)
      expect(vdp.tick(FREQUENCY) & 0x80).toBe(0x80)

      setReg(vdp, 0x01, 0x40) // IE off, nothing read
      expect(vdp.tick(FREQUENCY) & 0x80).toBe(0)
      expect(vdp.peekStatus(1)).toBe(0)

      setReg(vdp, 0x01, 0x60) // back on before anything acknowledged it
      expect(vdp.tick(FREQUENCY) & 0x80).toBe(0x80)
    })

    it('raises vertical blank once a frame, even when a mode change moves the picture’s end', () => {
      const vdp = new Video()
      setReg(vdp, 0x01, 0x40) // 192 lines
      setReg(vdp, 0x0a, 0x01)
      setReg(vdp, 0x0e, 0x01) // STATSEL_B = STAT1

      tickUntil(vdp, 'began line 193', () => vdp.getDisplayLine() === 193)
      expect(readStatus(vdp, 1)).toBe(0x01) // acknowledged
      setReg(vdp, 0x0d, 0x03) // Graphics: the picture now ends at 240
      tickUntil(vdp, 'began line 241', () => vdp.getDisplayLine() === 241)
      expect(vdp.peekStatus(1)).toBe(0) // not a second time this frame

      tickUntil(vdp, 'began the next frame', () => vdp.getDisplayLine() === 0)
      tickUntil(vdp, 'began line 241', () => vdp.getDisplayLine() === 241)
      expect(vdp.peekStatus(1)).toBe(0x01) // the next frame's, at 240
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

// ================================================================
//  The tile engine (§8) and the geometries it draws into (§9)
// ================================================================

const poke = (vdp: Video, address: number, bytes: number[]): void => {
  bytes.forEach((byte, offset) => vdp.setVramByte(address + offset, byte))
}

/** A frame, as palette indices — the goldens' strict oracle. */
const frame = (vdp: Video): Uint8Array => {
  renderOneFrame(vdp)
  return vdp.frameIndices()
}

const pixel = (indices: Uint8Array, x: number, y: number): number =>
  indices[y * DISPLAY_WIDTH + x]!

const pixels = (indices: Uint8Array, x: number, y: number, count: number): number[] =>
  Array.from(indices.subarray(y * DISPLAY_WIDTH + x, y * DISPLAY_WIDTH + x + count))

describe('the tile engine (§8)', () => {
  /** `VMODE` values (§9). `$0` is the legacy submode. */
  const LEGACY = 0x0
  const TEXT = 0x1
  const COMPACT = 0x2
  const GRAPHICS = 0x3
  const FULL = 0x4

  /** `LxCTRL` b1:0 — bit depth, as a shift count. */
  const BPP1 = 0
  const BPP2 = 1
  const BPP4 = 2
  const BPP8 = 3

  /** `LxCTRL` b3:2 — where a cell's color byte comes from. */
  const PER_CELL = 0
  const PER_GROUP = 1
  const PER_ROW = 2
  const NO_ATTRIBUTES = 3

  const control = (
    depth: number,
    source: number,
    { opaque = true, enabled = true } = {}
  ): number => depth | (source << 2) | (enabled ? 0x10 : 0) | (opaque ? 0x20 : 0)

  /**
   * Where this suite's tables live, spaced so that Full mode's 1200-byte name
   * and attribute tables — the largest §9 has — do not run into each other.
   * `L0ATTR` is a ×$400 granule everywhere except the legacy submode.
   */
  const NAME_TABLE = 0x0000
  const ATTR_TABLE = 0x1000
  const PATTERN_TABLE = 0x2000
  const SPRITE_PATTERNS = 0x2800
  const SPRITE_TABLE = 0x3800

  /** `COLOR` b3:0, and so the backdrop while `L0PAL` is 0. */
  const BACKDROP = 0x0e

  /**
   * The palette index a solid sprite of attribute `$0F` draws outside the
   * legacy submode.
   *
   * The same four bytes of a slot say different things on either side of §9's
   * line, and the tests below are about *whether* a sprite was drawn rather
   * than in what colour. Here the attribute byte is a sub-palette and `SPRCTRL`
   * resets to 4bpp, so a pattern byte of `$FF` is two pixels of value 15 in
   * sub-palette 15 — `(15 × 16 + 15) & $FF`, entry 255 (§10). In the legacy
   * submode the same bytes would be 1bpp and entry 15. Both readings are pinned
   * by the §10 suite.
   */
  const VMODE_SPRITE = 255

  /**
   * A card showing one geometry, with layer 0's three tables at the addresses
   * above and the sprite list terminated out of the way.
   *
   * Every `VMODE` geometry draws sprites — only the legacy submode's Text mode
   * does not (§9, §10) — so a test that did not park `SPRATTR` somewhere empty
   * and stop the list would find 32 sprites of whatever its name table happens
   * to hold drawn over the picture.
   */
  const card = (vmode: number, ctrl: number): Video => {
    const vdp = new Video()
    writeRegister(vdp, 0x01, 0x40) // MODE1: display on, no interrupt
    writeRegister(vdp, 0x07, BACKDROP) // COLOR
    writeRegister(vdp, 0x0d, vmode) // VMODE
    writeRegister(vdp, 0x10, NAME_TABLE >> 10) // L0NAME
    writeRegister(vdp, 0x11, ATTR_TABLE >> 10) // L0ATTR
    writeRegister(vdp, 0x12, PATTERN_TABLE >> 11) // L0PAT
    writeRegister(vdp, 0x15, ctrl) // L0CTRL
    writeRegister(vdp, 0x20, SPRITE_TABLE >> 7) // SPRATTR
    vdp.setVramByte(SPRITE_TABLE, 0xd0) // $D0: the list ends here
    return vdp
  }

  /** The top-left corner of each geometry's picture (§3). */
  const ORIGIN = {
    text: { x: 40, y: 24 },
    compact: { x: 32, y: 24 },
    graphics: { x: 32, y: 0 },
    full: { x: 0, y: 0 }
  }

  // ----------------------------------------------------------------
  //  Bit depth x attribute source
  // ----------------------------------------------------------------

  describe('1bpp, where the color byte is a pair of nibbles (§8)', () => {
    /** %10100000 — two pixels of foreground, then background. */
    const PATTERN = 0xa0
    const COLORS = 0x39 // foreground 3, background 9
    const EXPECTED = [3, 9, 3, 9, 9, 9, 9, 9]

    it('takes a color byte per cell, the only source two cells can differ in', () => {
      const vdp = card(COMPACT, control(BPP1, PER_CELL))
      poke(vdp, NAME_TABLE, [7, 7]) // both cells draw pattern 7
      poke(vdp, PATTERN_TABLE + 7 * 8, [PATTERN])
      poke(vdp, ATTR_TABLE, [COLORS, 0x4c]) // and are coloured differently

      const indices = frame(vdp)
      expect(pixels(indices, ORIGIN.compact.x, ORIGIN.compact.y, 8)).toEqual(EXPECTED)
      expect(pixels(indices, ORIGIN.compact.x + 8, ORIGIN.compact.y, 8)).toEqual([
        4, 12, 4, 12, 12, 12, 12, 12
      ])
    })

    it('takes one byte per eight patterns, which is Graphics I’s color table', () => {
      const vdp = card(COMPACT, control(BPP1, PER_GROUP))
      poke(vdp, NAME_TABLE, [9]) // pattern 9 is in group 1
      poke(vdp, PATTERN_TABLE + 9 * 8, [PATTERN])
      poke(vdp, ATTR_TABLE, [0x00, COLORS]) // group 0, then group 1

      expect(pixels(frame(vdp), ORIGIN.compact.x, ORIGIN.compact.y, 8)).toEqual(EXPECTED)
    })

    it('takes one byte per pattern row, which is what Graphics II could do', () => {
      const vdp = card(COMPACT, control(BPP1, PER_ROW))
      poke(vdp, NAME_TABLE, [2])
      poke(vdp, PATTERN_TABLE + 2 * 8, [PATTERN, PATTERN])
      poke(vdp, ATTR_TABLE + 2 * 8, [COLORS, 0x51]) // a pair for each of eight rows

      const indices = frame(vdp)
      expect(pixels(indices, ORIGIN.compact.x, ORIGIN.compact.y, 4)).toEqual([3, 9, 3, 9])
      expect(pixels(indices, ORIGIN.compact.x, ORIGIN.compact.y + 1, 4)).toEqual([5, 1, 5, 1])
    })

    it('fetches no attribute at all and takes COLOR, which is what text mode does', () => {
      const vdp = card(COMPACT, control(BPP1, NO_ATTRIBUTES))
      writeRegister(vdp, 0x07, COLORS) // COLOR is now the color byte
      poke(vdp, NAME_TABLE, [0])
      poke(vdp, PATTERN_TABLE, [PATTERN])
      // A written attribute table is proof it is not read: it says 0, which
      // with per-cell coloring would draw the whole line transparent.
      poke(vdp, ATTR_TABLE, [0x00])

      expect(pixels(frame(vdp), ORIGIN.compact.x, ORIGIN.compact.y, 8)).toEqual(EXPECTED)
    })
  })

  describe('2, 4 and 8bpp, where the color byte is an attribute byte (§8)', () => {
    it('unpacks four 2bpp pixels from each of a row’s two bytes', () => {
      const vdp = card(COMPACT, control(BPP2, PER_CELL))
      poke(vdp, NAME_TABLE, [0])
      poke(vdp, PATTERN_TABLE, [0x1b, 0xe4]) // 0,1,2,3 then 3,2,1,0
      poke(vdp, ATTR_TABLE, [0x02]) // sub-palette 2 → entries 8-11

      expect(pixels(frame(vdp), ORIGIN.compact.x, ORIGIN.compact.y, 8)).toEqual([
        8, 9, 10, 11, 11, 10, 9, 8
      ])
    })

    it('unpacks two 4bpp pixels from each of a row’s four bytes', () => {
      const vdp = card(COMPACT, control(BPP4, PER_CELL))
      poke(vdp, NAME_TABLE, [0])
      poke(vdp, PATTERN_TABLE, [0x12, 0x34, 0x56, 0x78])
      poke(vdp, ATTR_TABLE, [0x03]) // sub-palette 3 → entries 48-63

      expect(pixels(frame(vdp), ORIGIN.compact.x, ORIGIN.compact.y, 8)).toEqual([
        49, 50, 51, 52, 53, 54, 55, 56
      ])
    })

    it('takes an 8bpp pixel straight from each of a row’s eight bytes', () => {
      const vdp = card(COMPACT, control(BPP8, PER_CELL))
      poke(vdp, NAME_TABLE, [0])
      poke(vdp, PATTERN_TABLE, [0x01, 0x40, 0x80, 0xc0, 0x11, 0x22, 0x33, 0xff])
      poke(vdp, ATTR_TABLE, [0x0f]) // b3:0 ignored at 8bpp: one group of 256

      expect(pixels(frame(vdp), ORIGIN.compact.x, ORIGIN.compact.y, 8)).toEqual([
        0x01, 0x40, 0x80, 0xc0, 0x11, 0x22, 0x33, 0xff
      ])
    })

    it('reads no attribute byte with source “none”, which is sub-palette 0', () => {
      const vdp = card(COMPACT, control(BPP2, NO_ATTRIBUTES))
      writeRegister(vdp, 0x16, 0x03) // L0PAL = 3: the top quarter of the palette
      poke(vdp, NAME_TABLE, [0])
      poke(vdp, PATTERN_TABLE, [0x1b, 0x00])
      poke(vdp, ATTR_TABLE, [0x0f]) // not read

      // (L0PAL & 3) x 64 + subpal x 4 + value, with subpal pinned to 0.
      expect(pixels(frame(vdp), ORIGIN.compact.x, ORIGIN.compact.y, 4)).toEqual([
        192, 193, 194, 195
      ])
    })

    it('draws a 4bpp layer with no attribute table from palette row L0PAL', () => {
      // §8: with no attribute byte to carry a sub-palette, `LxPAL` is the row. It
      // is the only way such a layer can choose its colours at all.
      const vdp = card(COMPACT, control(BPP4, NO_ATTRIBUTES))
      writeRegister(vdp, 0x16, 0x0f) // L0PAL = 15
      poke(vdp, NAME_TABLE, [0])
      poke(vdp, PATTERN_TABLE, [0x12, 0x34, 0x00, 0x00])

      expect(pixels(frame(vdp), ORIGIN.compact.x, ORIGIN.compact.y, 4)).toEqual([
        0xf1, 0xf2, 0xf3, 0xf4
      ])
    })

    it('has nothing left for L0PAL to say at 4bpp once there is an attribute byte', () => {
      // Sixteen 4bpp groups already cover the palette, so `(group x 16 + value)
      // & $FF` drops `LxPAL` whenever the attribute byte names the sub-palette.
      const vdp = card(COMPACT, control(BPP4, PER_CELL))
      writeRegister(vdp, 0x16, 0x0f) // L0PAL = 15
      poke(vdp, NAME_TABLE, [0])
      poke(vdp, ATTR_TABLE, [0x00])
      poke(vdp, PATTERN_TABLE, [0x12, 0x34, 0x00, 0x00])

      expect(pixels(frame(vdp), ORIGIN.compact.x, ORIGIN.compact.y, 4)).toEqual([1, 2, 3, 4])
    })
  })

  // ----------------------------------------------------------------
  //  Palette mapping (§8)
  // ----------------------------------------------------------------

  describe('palette mapping (§8)', () => {
    it('makes L0PAL name the sixteen colors a 1bpp cell’s nibbles index', () => {
      const vdp = card(COMPACT, control(BPP1, PER_CELL))
      writeRegister(vdp, 0x16, 0x05) // L0PAL = 5 → palette row 5
      poke(vdp, NAME_TABLE, [0])
      poke(vdp, PATTERN_TABLE, [0xc0])
      poke(vdp, ATTR_TABLE, [0x39])

      expect(pixels(frame(vdp), ORIGIN.compact.x, ORIGIN.compact.y, 4)).toEqual([
        0x53, 0x53, 0x59, 0x59
      ])
    })

    it('gives 2bpp sixty-four groups of four, a quarter of the palette at a time', () => {
      const vdp = card(COMPACT, control(BPP2, PER_CELL))
      writeRegister(vdp, 0x16, 0x03) // L0PAL = 3
      poke(vdp, NAME_TABLE, [0])
      poke(vdp, PATTERN_TABLE, [0x1b, 0x00])
      poke(vdp, ATTR_TABLE, [0x05]) // sub-palette 5

      // (3 & 3) x 64 + 5 x 4 + value
      expect(pixels(frame(vdp), ORIGIN.compact.x, ORIGIN.compact.y, 4)).toEqual([
        212, 213, 214, 215
      ])
    })

    it('gives 4bpp sixteen groups of sixteen, which is the whole palette', () => {
      const vdp = card(COMPACT, control(BPP4, PER_CELL))
      poke(vdp, NAME_TABLE, [0])
      poke(vdp, PATTERN_TABLE, [0x12, 0x00, 0x00, 0x00])
      poke(vdp, ATTR_TABLE, [0x05]) // sub-palette 5 → entries 80-95

      expect(pixels(frame(vdp), ORIGIN.compact.x, ORIGIN.compact.y, 2)).toEqual([81, 82])
    })
  })

  // ----------------------------------------------------------------
  //  Transparency (§8)
  // ----------------------------------------------------------------

  describe('index 0 and LxCTRL b5 (§8)', () => {
    it('shows the backdrop through either nibble of a 1bpp pair when transparent', () => {
      const vdp = card(COMPACT, control(BPP1, PER_CELL, { opaque: false }))
      poke(vdp, NAME_TABLE, [0])
      poke(vdp, PATTERN_TABLE, [0xa0])
      poke(vdp, ATTR_TABLE, [0x03]) // foreground 0, background 3

      const indices = frame(vdp)
      expect(pixels(indices, ORIGIN.compact.x, ORIGIN.compact.y, 4)).toEqual([
        BACKDROP, 3, BACKDROP, 3
      ])

      // And the other way round: a background nibble of 0 is as transparent as
      // a foreground one, exactly as TMS9918 color 0 is.
      poke(vdp, ATTR_TABLE, [0x30])
      expect(pixels(frame(vdp), ORIGIN.compact.x, ORIGIN.compact.y, 4)).toEqual([
        3, BACKDROP, 3, BACKDROP
      ])
    })

    it('draws entry 0 of the group instead when index 0 is opaque', () => {
      const vdp = card(COMPACT, control(BPP1, PER_CELL, { opaque: true }))
      writeRegister(vdp, 0x16, 0x05) // L0PAL = 5 → entry $50, not the backdrop
      poke(vdp, NAME_TABLE, [0])
      poke(vdp, PATTERN_TABLE, [0xa0])
      poke(vdp, ATTR_TABLE, [0x03])

      expect(pixels(frame(vdp), ORIGIN.compact.x, ORIGIN.compact.y, 4)).toEqual([
        0x50, 0x53, 0x50, 0x53
      ])
    })

    it('leaves a 4bpp value of 0 transparent too, and opaque when b5 is set', () => {
      const transparent = card(COMPACT, control(BPP4, PER_CELL, { opaque: false }))
      poke(transparent, NAME_TABLE, [0])
      poke(transparent, PATTERN_TABLE, [0x01, 0x00, 0x00, 0x00])
      poke(transparent, ATTR_TABLE, [0x02]) // sub-palette 2 → entries 32-47
      expect(pixels(frame(transparent), ORIGIN.compact.x, ORIGIN.compact.y, 2)).toEqual([
        BACKDROP, 33
      ])

      const opaque = card(COMPACT, control(BPP4, PER_CELL, { opaque: true }))
      poke(opaque, NAME_TABLE, [0])
      poke(opaque, PATTERN_TABLE, [0x01, 0x00, 0x00, 0x00])
      poke(opaque, ATTR_TABLE, [0x02])
      expect(pixels(frame(opaque), ORIGIN.compact.x, ORIGIN.compact.y, 2)).toEqual([32, 33])
    })
  })

  // ----------------------------------------------------------------
  //  The attribute byte (§8)
  // ----------------------------------------------------------------

  describe('the attribute byte at 2, 4 and 8bpp (§8)', () => {
    const FLIP_X = 0x10
    const FLIP_Y = 0x20
    const PRIORITY = 0x40
    const PATTERN_BIT8 = 0x80

    it('mirrors a cell horizontally on b4', () => {
      const vdp = card(COMPACT, control(BPP4, PER_CELL))
      poke(vdp, NAME_TABLE, [0])
      poke(vdp, PATTERN_TABLE, [0x12, 0x34, 0x56, 0x78])
      poke(vdp, ATTR_TABLE, [FLIP_X])

      expect(pixels(frame(vdp), ORIGIN.compact.x, ORIGIN.compact.y, 8)).toEqual([
        8, 7, 6, 5, 4, 3, 2, 1
      ])
    })

    it('mirrors a cell vertically on b5', () => {
      const vdp = card(COMPACT, control(BPP4, PER_CELL))
      poke(vdp, NAME_TABLE, [0])
      poke(vdp, PATTERN_TABLE + 7 * 4, [0x12, 0x00, 0x00, 0x00]) // the bottom row
      poke(vdp, ATTR_TABLE, [FLIP_Y])

      // Flipped, the bottom row is drawn at the top of the cell.
      expect(pixels(frame(vdp), ORIGIN.compact.x, ORIGIN.compact.y, 2)).toEqual([1, 2])
    })

    it('carries the ninth pattern-index bit in b7, reaching 512 tiles', () => {
      const vdp = card(COMPACT, control(BPP2, PER_CELL))
      poke(vdp, NAME_TABLE, [1])
      poke(vdp, PATTERN_TABLE + 1 * 16, [0x1b, 0x00]) // tile 1
      poke(vdp, PATTERN_TABLE + 257 * 16, [0xe4, 0x00]) // tile 257
      poke(vdp, ATTR_TABLE, [PATTERN_BIT8])

      expect(pixels(frame(vdp), ORIGIN.compact.x, ORIGIN.compact.y, 4)).toEqual([3, 2, 1, 0])
    })

    it('ignores that bit at 8bpp, where 512 tiles would not fit in the VRAM', () => {
      const vdp = card(COMPACT, control(BPP8, PER_CELL))
      poke(vdp, NAME_TABLE, [1])
      poke(vdp, PATTERN_TABLE + 1 * 64, [0x11, 0x22])
      poke(vdp, ATTR_TABLE, [PATTERN_BIT8])

      expect(pixels(frame(vdp), ORIGIN.compact.x, ORIGIN.compact.y, 2)).toEqual([0x11, 0x22])
    })

    it('leaves b6 to the compositor, which is §12 and is not built yet', () => {
      // Priority lifts a cell above ordinary sprites. Resolving that needs the
      // six-level compositor layer 1 arrives with, in Phase 7; until then the
      // bit changes nothing, and this is the test that should move when it does.
      const vdp = card(COMPACT, control(BPP4, PER_CELL))
      poke(vdp, NAME_TABLE, [0])
      poke(vdp, PATTERN_TABLE, [0x12, 0x00, 0x00, 0x00])
      poke(vdp, ATTR_TABLE, [PRIORITY])

      expect(pixels(frame(vdp), ORIGIN.compact.x, ORIGIN.compact.y, 2)).toEqual([1, 2])
    })
  })

  // ----------------------------------------------------------------
  //  Geometry (§9)
  // ----------------------------------------------------------------

  describe('the geometries VMODE selects (§9)', () => {
    /** A card whose every cell draws a solid 1bpp pattern of foreground 3. */
    const solid = (vmode: number): Video => {
      const vdp = card(vmode, control(BPP1, PER_CELL))
      for (let cell = 0; cell < 1200; cell++) {
        vdp.setVramByte(NAME_TABLE + cell, 0)
        vdp.setVramByte(ATTR_TABLE + cell, 0x33)
      }
      for (let row = 0; row < 8; row++) vdp.setVramByte(PATTERN_TABLE + row, 0xff)
      return vdp
    }

    it('puts Text’s 40 x 24 of 6 x 8 at x 40, y 24', () => {
      const indices = frame(solid(TEXT))
      expect(pixel(indices, 39, 24)).toBe(BACKDROP)
      expect(pixel(indices, 40, 24)).toBe(3)
      expect(pixel(indices, 279, 215)).toBe(3)
      expect(pixel(indices, 280, 215)).toBe(BACKDROP)
      expect(pixel(indices, 40, 23)).toBe(BACKDROP)
      expect(pixel(indices, 40, 216)).toBe(BACKDROP)
    })

    it('puts Compact’s 32 x 24 of 8 x 8 at x 32, y 24', () => {
      const indices = frame(solid(COMPACT))
      expect(pixel(indices, 31, 24)).toBe(BACKDROP)
      expect(pixel(indices, 32, 24)).toBe(3)
      expect(pixel(indices, 287, 215)).toBe(3)
      expect(pixel(indices, 288, 215)).toBe(BACKDROP)
    })

    it('gives Graphics 32 x 30 of 8 x 8 — the full height, side borders only', () => {
      const indices = frame(solid(GRAPHICS))
      expect(pixel(indices, 31, 0)).toBe(BACKDROP)
      expect(pixel(indices, 32, 0)).toBe(3)
      expect(pixel(indices, 287, 239)).toBe(3)
      expect(pixel(indices, 288, 239)).toBe(BACKDROP)
    })

    it('gives Full 40 x 30 of 8 x 8 and no border at all', () => {
      const indices = frame(solid(FULL))
      expect(pixel(indices, 0, 0)).toBe(3)
      expect(pixel(indices, 319, 239)).toBe(3)
      expect(indices.every((index) => index === 3)).toBe(true)
    })

    it('draws six pixels of each Text cell and ignores the other two (§8)', () => {
      const vdp = card(TEXT, control(BPP1, PER_CELL))
      poke(vdp, NAME_TABLE, [0, 1]) // cell 0 solid, cell 1 empty
      poke(vdp, PATTERN_TABLE, [0xff])
      poke(vdp, PATTERN_TABLE + 8, [0x00])
      poke(vdp, ATTR_TABLE, [0x39, 0x39])

      // Eight-pixel cells would put foreground at x 46 and 47.
      expect(pixels(frame(vdp), 40, 24, 12)).toEqual([3, 3, 3, 3, 3, 3, 9, 9, 9, 9, 9, 9])
    })

    it('strides the name table by the geometry’s column count', () => {
      const vdp = card(GRAPHICS, control(BPP1, PER_CELL))
      poke(vdp, NAME_TABLE + 32, [1]) // the first cell of the second row
      poke(vdp, PATTERN_TABLE + 8, [0xff])
      poke(vdp, ATTR_TABLE + 32, [0x39])

      expect(pixel(frame(vdp), 32, 8)).toBe(3)
    })
  })

  // ----------------------------------------------------------------
  //  Geometry x depth x attribute source (§8, §9)
  // ----------------------------------------------------------------

  /**
   * The engine's three parameters, crossed.
   *
   * Everything above takes one at a time: a depth in the Compact geometry, an
   * attribute source in the Compact geometry, a geometry drawing one solid 1bpp
   * pattern. The crossings are where the address arithmetic lives, and none of
   * them were covered — the name table's stride is the geometry's column count,
   * the attribute table is indexed by a cell number that stride produces, and a
   * Text cell is six pixels wide at every depth rather than only at the one the
   * TMS9918 had.
   *
   * So: one probe cell, drawn in all sixty-four combinations of §9's four
   * geometries with §8's four depths and four attribute sources, and read back
   * from wherever the geometry puts it.
   */
  describe('geometry x depth x attribute source (§8, §9)', () => {
    const GEOMETRIES = [
      { name: 'Text', vmode: TEXT, cols: 40, cellWidth: 6, origin: ORIGIN.text },
      { name: 'Compact', vmode: COMPACT, cols: 32, cellWidth: 8, origin: ORIGIN.compact },
      { name: 'Graphics', vmode: GRAPHICS, cols: 32, cellWidth: 8, origin: ORIGIN.graphics },
      { name: 'Full', vmode: FULL, cols: 40, cellWidth: 8, origin: ORIGIN.full }
    ] as const

    /** Far enough into the grid that a wrong stride or origin misses it. */
    const PROBE_COL = 3
    const PROBE_ROW = 2

    /**
     * And read from the fourth row *inside* the cell rather than its first, so
     * that the pattern's row stride — one, two, four or eight bytes, by depth —
     * is crossed with the rest as well. A probe on row 0 sits at offset 0 of its
     * tile at every depth and so says nothing about it.
     */
    const PROBE_PIXEL_ROW = 3

    /** Pattern 9 is in group 1, so a per-group fetch is not a fetch of byte 0. */
    const PROBE_PATTERN = 9

    /** `COLOR`, which is also the colour byte when the source is "none" at 1bpp. */
    const COLORS = 0x39 // foreground 3, background 9

    /** The sub-palette every source but "none" carries at 2, 4 and 8bpp. */
    const SUB_PALETTE = 0x05

    /** Bits per pixel at each depth code, for §8's palette mapping. */
    const BITS = [1, 2, 4, 8]

    /**
     * The probe cell's top pattern row at each depth, and the pixel values it
     * unpacks to: §8's "most significant bit or nibble leftmost", over 1, 2, 4
     * or 8 bytes a row.
     */
    const DEPTHS = [
      { name: '1bpp', depth: BPP1, row: [0xa0], values: [1, 0, 1, 0, 0, 0, 0, 0] },
      { name: '2bpp', depth: BPP2, row: [0x1b, 0x1b], values: [0, 1, 2, 3, 0, 1, 2, 3] },
      {
        name: '4bpp',
        depth: BPP4,
        row: [0x01, 0x23, 0x45, 0x67],
        values: [0, 1, 2, 3, 4, 5, 6, 7]
      },
      { name: '8bpp', depth: BPP8, row: [0, 1, 2, 3, 4, 5, 6, 7], values: [0, 1, 2, 3, 4, 5, 6, 7] }
    ] as const

    const SOURCES = [
      { name: 'a byte per cell', source: PER_CELL },
      { name: 'a byte per pattern group', source: PER_GROUP },
      { name: 'a byte per pattern row', source: PER_ROW },
      { name: 'no attribute fetch', source: NO_ATTRIBUTES }
    ] as const

    /**
     * The one address §8 says each source reads the probe's colour byte from.
     *
     * "None" reads none: at 1bpp `COLOR` is the byte, and at the other depths
     * the layer takes sub-palette 0 with no flip and no ninth pattern bit,
     * which is what an all-zero attribute byte already says.
     */
    const attributeAddress = (source: number, cols: number): number | null => {
      switch (source) {
        case PER_CELL:
          return ATTR_TABLE + PROBE_ROW * cols + PROBE_COL
        case PER_GROUP:
          return ATTR_TABLE + (PROBE_PATTERN >> 3)
        case PER_ROW:
          return ATTR_TABLE + PROBE_PATTERN * 8 + PROBE_PIXEL_ROW
        default:
          return null
      }
    }

    /**
     * §8's palette mapping for the probe, with `L0PAL` at 0.
     *
     * At 1bpp a pattern bit picks one of the colour byte's two nibbles, and the
     * answer is the same for all four sources because the byte "none" reads out
     * of `COLOR` is set to the same byte the other three read out of the
     * attribute table — the source says *where* the byte is, never what it
     * means. At 2, 4 and 8bpp the sub-palette names a group `2^bpp` entries
     * wide, and there "none" genuinely differs: it is group 0.
     */
    const expectedIndices = (depth: number, source: number): number[] => {
      const { values } = DEPTHS.find((entry) => entry.depth === depth)!
      if (depth === BPP1) {
        const foreground = COLORS >> 4
        const background = COLORS & 0x0f
        return values.map((value) => (value === 0 ? background : foreground))
      }
      const subPalette = source === NO_ATTRIBUTES ? 0 : SUB_PALETTE
      const groupBase = (subPalette << BITS[depth]!) & 0xff
      return values.map((value) => groupBase + value)
    }

    for (const geometry of GEOMETRIES) {
      describe(`${geometry.name}: ${geometry.cols} columns of ${geometry.cellWidth} pixels`, () => {
        for (const { name: depthName, depth, row } of DEPTHS) {
          for (const { name: sourceName, source } of SOURCES) {
            it(`draws ${depthName} coloured by ${sourceName}`, () => {
              const vdp = card(geometry.vmode, control(depth, source))
              writeRegister(vdp, 0x07, COLORS) // COLOR, the byte "none" reads at 1bpp

              // The name table is zero everywhere else, so this is the only cell
              // drawing pattern 9 — and it lands on (3, 2) only if the stride is
              // the geometry's column count.
              poke(vdp, NAME_TABLE + PROBE_ROW * geometry.cols + PROBE_COL, [PROBE_PATTERN])
              poke(
                vdp,
                PATTERN_TABLE + PROBE_PATTERN * (8 << depth) + PROBE_PIXEL_ROW * (1 << depth),
                [...row]
              )

              // Written at the address this source reads and nowhere else. The
              // rest of the attribute table is zero, so a fetch from the wrong
              // place colours the cell out of a byte of zeros and fails.
              const address = attributeAddress(source, geometry.cols)
              if (address !== null) poke(vdp, address, [depth === BPP1 ? COLORS : SUB_PALETTE])

              const x = geometry.origin.x + PROBE_COL * geometry.cellWidth
              const y = geometry.origin.y + PROBE_ROW * 8 + PROBE_PIXEL_ROW
              expect(pixels(frame(vdp), x, y, geometry.cellWidth)).toEqual(
                expectedIndices(depth, source).slice(0, geometry.cellWidth)
              )
            })
          }
        }
      })
    }

    /**
     * Flipping crossed with the six-pixel cell, the one place two of the three
     * parameters genuinely interact.
     *
     * §8 draws the leftmost six pixels of a Text row and ignores the other two,
     * so a mirrored Text cell is the mirror of the six that are drawn. Mirroring
     * all eight and then showing the left six would put the cell's *last* six
     * on screen instead, backwards — `[8, 7, 6, 5, 4, 3]` rather than what this
     * asks for.
     */
    it('mirrors the six pixels a Text cell draws, not the eight it holds', () => {
      const vdp = card(TEXT, control(BPP4, PER_CELL))
      poke(vdp, NAME_TABLE, [0])
      poke(vdp, PATTERN_TABLE, [0x12, 0x34, 0x56, 0x78]) // values 1-8 across the row
      poke(vdp, ATTR_TABLE, [0x10]) // b4: flip horizontally

      expect(pixels(frame(vdp), ORIGIN.text.x, ORIGIN.text.y, 6)).toEqual([6, 5, 4, 3, 2, 1])
    })
  })

  // ----------------------------------------------------------------
  //  The legacy submode (§9)
  // ----------------------------------------------------------------

  describe('the legacy submode (§9)', () => {
    /** A legacy card: `VMODE` = `$0`, so `M1`/`M2`/`M3` choose the mode. */
    const legacy = (mode0: number, mode1: number): Video => {
      const vdp = new Video()
      writeRegister(vdp, 0x00, mode0)
      writeRegister(vdp, 0x01, 0x40 | mode1) // display on
      writeRegister(vdp, 0x07, BACKDROP)
      writeRegister(vdp, 0x10, NAME_TABLE >> 10)
      writeRegister(vdp, 0x12, PATTERN_TABLE >> 11)
      writeRegister(vdp, 0x20, SPRITE_TABLE >> 7)
      vdp.setVramByte(SPRITE_TABLE, 0xd0)
      return vdp
    }

    const GRAPHICS_I = { mode0: 0x00, mode1: 0x00 }
    const GRAPHICS_II = { mode0: 0x02, mode1: 0x00 }
    const MULTICOLOR = { mode0: 0x00, mode1: 0x08 }
    const LEGACY_TEXT = { mode0: 0x00, mode1: 0x10 }

    it('colors Graphics I per pattern group, from L0ATTR x $40', () => {
      const vdp = legacy(GRAPHICS_I.mode0, GRAPHICS_I.mode1)
      writeRegister(vdp, 0x11, ATTR_TABLE >> 6) // ×$40, not ×$400
      poke(vdp, NAME_TABLE, [9])
      poke(vdp, PATTERN_TABLE + 9 * 8, [0xa0])
      poke(vdp, ATTR_TABLE, [0x00, 0x39]) // group 1 holds patterns 8-15

      expect(pixels(frame(vdp), ORIGIN.compact.x, ORIGIN.compact.y, 4)).toEqual([3, 9, 3, 9])
    })

    it('scales L0ATTR by $40 only here — VMODE’s modes use the $400 granule', () => {
      const vdp = card(COMPACT, control(BPP1, PER_GROUP))
      writeRegister(vdp, 0x11, 0x10) // a legacy program means $0400 by this
      poke(vdp, NAME_TABLE, [0])
      poke(vdp, PATTERN_TABLE, [0xa0])
      poke(vdp, 0x0400, [0x39])

      // Outside the legacy submode the same $10 means $4000, which is empty:
      // both nibbles 0, and with index 0 opaque that is entry 0 across the cell.
      expect(pixels(frame(vdp), ORIGIN.compact.x, ORIGIN.compact.y, 4)).toEqual([0, 0, 0, 0])
    })

    it('colors Text from COLOR with no attribute fetch, in 40 x 24 of 6 x 8', () => {
      const vdp = legacy(LEGACY_TEXT.mode0, LEGACY_TEXT.mode1)
      writeRegister(vdp, 0x07, 0x39) // COLOR: foreground 3, background 9
      poke(vdp, NAME_TABLE, [0])
      poke(vdp, PATTERN_TABLE, [0xa0])

      const indices = frame(vdp)
      expect(pixels(indices, ORIGIN.text.x, ORIGIN.text.y, 6)).toEqual([3, 9, 3, 9, 9, 9])
      expect(pixel(indices, 39, 24)).toBe(9) // border, which is also COLOR b3:0
    })

    it('pins the depth and attribute source whatever L0CTRL says', () => {
      const vdp = legacy(GRAPHICS_I.mode0, GRAPHICS_I.mode1)
      writeRegister(vdp, 0x11, ATTR_TABLE >> 6)
      writeRegister(vdp, 0x15, control(BPP4, PER_CELL)) // ignored here (§9)
      poke(vdp, NAME_TABLE, [0])
      poke(vdp, PATTERN_TABLE, [0xa0])
      poke(vdp, ATTR_TABLE, [0x39])

      expect(pixels(frame(vdp), ORIGIN.compact.x, ORIGIN.compact.y, 4)).toEqual([3, 9, 3, 9])
    })

    it('still honors L0CTRL’s enable bit, which §9 does not pin', () => {
      const vdp = legacy(GRAPHICS_I.mode0, GRAPHICS_I.mode1)
      writeRegister(vdp, 0x15, control(BPP1, PER_GROUP, { enabled: false }))
      writeRegister(vdp, 0x11, ATTR_TABLE >> 6)
      poke(vdp, NAME_TABLE, [0])
      poke(vdp, PATTERN_TABLE, [0xff])
      poke(vdp, ATTR_TABLE, [0x39])

      expect(pixel(frame(vdp), ORIGIN.compact.x, ORIGIN.compact.y)).toBe(BACKDROP)
    })

    it('leaves a colour-0 nibble transparent whatever L0CTRL b5 says, as a TMS9918 does', () => {
      // `L0CTRL` resets with index 0 opaque, for the new modes. A TMS9918 cell
      // coloured 0 shows the backdrop, not black, and a Graphics I program
      // that relies on it has to get what it had (§9).
      const vdp = legacy(GRAPHICS_I.mode0, GRAPHICS_I.mode1)
      expect(vdp.getRegister(0x15) & 0x20).toBe(0x20) // opaque, from reset
      writeRegister(vdp, 0x11, ATTR_TABLE >> 6)
      poke(vdp, NAME_TABLE, [0])
      poke(vdp, PATTERN_TABLE, [0xf0]) // four foreground pixels, four background
      poke(vdp, ATTR_TABLE, [0x70]) // foreground 7, background 0

      expect(pixels(frame(vdp), ORIGIN.compact.x, ORIGIN.compact.y, 8)).toEqual([
        7, 7, 7, 7, BACKDROP, BACKDROP, BACKDROP, BACKDROP
      ])
    })

    it('draws Graphics II as Graphics I rather than hanging the raster', () => {
      const vdp = legacy(GRAPHICS_II.mode0, GRAPHICS_II.mode1)
      writeRegister(vdp, 0x11, ATTR_TABLE >> 6)
      poke(vdp, NAME_TABLE, [0])
      poke(vdp, PATTERN_TABLE, [0xa0])
      poke(vdp, ATTR_TABLE, [0x39])

      expect(vdp.getMode().legacy).toBe('graphics-ii')
      expect(pixels(frame(vdp), ORIGIN.compact.x, ORIGIN.compact.y, 4)).toEqual([3, 9, 3, 9])
    })

    it('draws Multicolor as Graphics I for the same reason', () => {
      const vdp = legacy(MULTICOLOR.mode0, MULTICOLOR.mode1)
      writeRegister(vdp, 0x11, ATTR_TABLE >> 6)
      poke(vdp, NAME_TABLE, [0])
      poke(vdp, PATTERN_TABLE, [0xa0])
      poke(vdp, ATTR_TABLE, [0x39])

      expect(vdp.getMode().legacy).toBe('multicolor')
      expect(pixels(frame(vdp), ORIGIN.compact.x, ORIGIN.compact.y, 4)).toEqual([3, 9, 3, 9])
    })

    /** A solid 8x8 sprite in the picture's top-left corner, and nothing else. */
    const cornerSprite = (vdp: Video): void => {
      writeRegister(vdp, 0x21, SPRITE_PATTERNS >> 11) // SPRPAT
      poke(vdp, SPRITE_PATTERNS, [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])
      // Y = $FF is one line above the picture (§10), so the sprite's second
      // pattern row is what lands on the first line of it.
      poke(vdp, SPRITE_TABLE, [0xff, 0x00, 0x00, 0x0f])
      poke(vdp, SPRITE_TABLE + 4, [0xd0])
    }

    it('draws no sprites in Text, as the TMS9918 does not', () => {
      const vdp = legacy(LEGACY_TEXT.mode0, LEGACY_TEXT.mode1)
      writeRegister(vdp, 0x07, 0x39) // COLOR: foreground 3, background 9
      cornerSprite(vdp)

      // The layer's pattern 0 is blank, so the corner is background: 9 if the
      // sprite was not drawn, and the sprite's own colour if it was.
      expect(pixel(frame(vdp), ORIGIN.text.x, ORIGIN.text.y)).toBe(9)
    })

    it('draws them in VMODE’s Text geometry, which is not the TMS9918’s (§10)', () => {
      const vdp = card(TEXT, control(BPP1, NO_ATTRIBUTES))
      writeRegister(vdp, 0x07, 0x39)
      cornerSprite(vdp)

      expect(pixel(frame(vdp), ORIGIN.text.x, ORIGIN.text.y)).toBe(VMODE_SPRITE)
    })

    it('takes the reserved VMODE codes back to it, the mode the card powers up in', () => {
      const vdp = legacy(GRAPHICS_I.mode0, GRAPHICS_I.mode1)
      writeRegister(vdp, 0x0d, 0x0f) // reserved (§9)
      writeRegister(vdp, 0x11, ATTR_TABLE >> 6)
      poke(vdp, NAME_TABLE, [0])
      poke(vdp, PATTERN_TABLE, [0xa0])
      poke(vdp, ATTR_TABLE, [0x39])

      expect(pixels(frame(vdp), ORIGIN.compact.x, ORIGIN.compact.y, 4)).toEqual([3, 9, 3, 9])
    })

    it('is what VMODE resets to, so a card that is never told a mode is one', () => {
      expect(new Video().getRegister(0x0d)).toBe(LEGACY)
    })
  })

  // ----------------------------------------------------------------
  //  Layer control and the backdrop
  // ----------------------------------------------------------------

  describe('LxCTRL b4 and the backdrop (§8, §11)', () => {
    it('draws nothing from a disabled layer, leaving the backdrop', () => {
      const vdp = card(COMPACT, control(BPP1, PER_CELL, { enabled: false }))
      poke(vdp, NAME_TABLE, [0])
      poke(vdp, PATTERN_TABLE, [0xff])
      poke(vdp, ATTR_TABLE, [0x39])

      expect(pixel(frame(vdp), ORIGIN.compact.x, ORIGIN.compact.y)).toBe(BACKDROP)
    })

    it('still draws sprites over it — a layer is not the display enable', () => {
      const vdp = card(COMPACT, control(BPP1, PER_CELL, { enabled: false }))
      writeRegister(vdp, 0x21, SPRITE_PATTERNS >> 11) // SPRPAT
      poke(vdp, SPRITE_PATTERNS, [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])
      poke(vdp, SPRITE_TABLE, [0xff, 0x00, 0x00, 0x0f])
      poke(vdp, SPRITE_TABLE + 4, [0xd0])

      expect(pixel(frame(vdp), ORIGIN.compact.x, ORIGIN.compact.y)).toBe(VMODE_SPRITE)
    })

    it('puts the backdrop at (L0PAL x 16) + (COLOR & $0F), border included', () => {
      const vdp = card(COMPACT, control(BPP1, PER_CELL))
      writeRegister(vdp, 0x16, 0x07) // L0PAL = 7
      writeRegister(vdp, 0x07, 0x05) // COLOR b3:0 = 5

      const indices = frame(vdp)
      expect(pixel(indices, 0, 0)).toBe(0x75)
      expect(pixel(indices, 319, 239)).toBe(0x75)
    })

    it('paints the border from the backdrop as it is on each line, not once a frame', () => {
      // §11 makes the border the backdrop and §3 builds each line a line ahead,
      // so a raster split that changes COLOR moves the border on the same line
      // as the picture — here from display line 102, the first built after a
      // write made while line 100 was being scanned.
      const vdp = card(COMPACT, control(BPP1, PER_CELL, { enabled: false }))
      renderOneFrame(vdp) // on display line 261, the next frame about to begin
      const runTo = (line: number): void => {
        while (vdp.getDisplayLine() !== line) vdp.tick(1_000_000)
      }
      runTo(100)
      writeRegister(vdp, 0x07, 0x06)
      runTo(215) // display line 215, row 239, was built as 214 began

      const indices = vdp.frameIndices()
      const y = ORIGIN.compact.y
      expect(pixel(indices, 0, y + 101)).toBe(BACKDROP) // border, line 101: built as 100 began
      expect(pixel(indices, 0, y + 102)).toBe(0x06) // border, line 102
      expect(pixel(indices, ORIGIN.compact.x, y + 102)).toBe(0x06) // picture, same line
      expect(pixel(indices, 0, 239)).toBe(0x06) // the bottom border
      expect(pixel(indices, 0, 0)).toBe(BACKDROP) // the top border, scanned before the write
    })
  })
})

/**
 * Sprites (§10), the second of the two acceptance targets' halves.
 *
 * The engine underneath these is 64 slots wide, 32 sprites deep per line and
 * four bit depths tall, and almost none of that is reachable by the software
 * this branch has to keep working: WIZARDSLAB writes `$D0` into the first slot
 * and draws none at all, and the BIOS runs a Text screen, which has none. The
 * goldens therefore say nothing about any of this, and these tests are the only
 * thing that does.
 *
 * Everything is read as palette indices, the goldens' strict oracle, in the
 * Graphics geometry — 32 x 30 of 8 x 8 at x 32, no vertical border — so a
 * display line is a screen line and a sprite's Y is the row it appears on.
 */
describe('sprites (§10)', () => {
  /** Where this suite's tables live. The layer is off, so it needs none. */
  const SPRITE_TABLE = 0x3800
  const SPRITE_PATTERNS = 0x2800

  /** `COLOR` b3:0, and so the backdrop a sprite is seen against. */
  const BACKDROP = 0x0e

  /** `SPRCTRL` b5:4 — sprite bit depth, as a shift count (§5). */
  const BPP1 = 0
  const BPP2 = 1
  const BPP4 = 2
  const BPP8 = 3

  /** `VMODE` (§9): `$3` is Graphics, `$4` Full, `$0` the legacy submode. */
  const GRAPHICS = 0x3
  const FULL = 0x4

  /** The `$D0` that ends the list while `SPRCTRL` b2 is set (§10). */
  const TERMINATOR = 0xd0

  const sprctrl = ({
    enabled = true,
    collision = true,
    terminator = true,
    detailed = false,
    depth = BPP1
  } = {}): number =>
    (enabled ? 0x01 : 0) |
    (collision ? 0x02 : 0) |
    (terminator ? 0x04 : 0) |
    (detailed ? 0x08 : 0) |
    (depth << 4)

  /**
   * A card showing sprites and nothing else.
   *
   * Layer 0 is disabled, so every pixel that is not a sprite is the backdrop —
   * which makes "was this drawn" a question about one palette index rather than
   * about what a tile happened to be doing underneath. `SPRCTRL` defaults to
   * 1bpp here rather than to its reset 4bpp, because a 1bpp pattern is one byte
   * per row and most of what these tests assert is about position, not colour.
   */
  const card = (control = sprctrl(), vmode = GRAPHICS): Video => {
    const vdp = new Video()
    writeRegister(vdp, 0x01, 0x40) // MODE1: display on, 8x8, unmagnified
    writeRegister(vdp, 0x07, BACKDROP) // COLOR
    writeRegister(vdp, 0x0d, vmode) // VMODE
    writeRegister(vdp, 0x15, 0x00) // L0CTRL: layer 0 off
    writeRegister(vdp, 0x20, SPRITE_TABLE >> 7) // SPRATTR
    writeRegister(vdp, 0x21, SPRITE_PATTERNS >> 11) // SPRPAT
    writeRegister(vdp, 0x23, control) // SPRCTRL
    vdp.setVramByte(SPRITE_TABLE, TERMINATOR) // an empty list
    return vdp
  }

  /**
   * Write one slot, and end the list after it (§10).
   *
   * Slots written in ascending order each overwrite the terminator the one
   * before left, so a test that wants four sprites writes four and says nothing
   * about the fifth. `ends: false` leaves the terminator off, for the tests
   * that want a gap between two slots rather than the end of the list.
   */
  const sprite = (
    vdp: Video,
    slot: number,
    { y = 0, x = 0, pattern = 0, attributes = 0, ends = true } = {}
  ): void => {
    const base = SPRITE_TABLE + slot * 4
    poke(vdp, base, [y, x, pattern, attributes])
    if (ends) vdp.setVramByte(base + 4, TERMINATOR)
  }

  /**
   * Park the slots below `slots` where they cover no line, list unbroken.
   *
   * Y = 240 is the first row below a 240-line picture (§10) and is not the
   * `$D0` terminator, so a test reaching for a high slot can empty the ones in
   * front of it without also ending the list in front of it.
   */
  const park = (vdp: Video, slots: number): void => {
    for (let slot = 0; slot < slots; slot++) vdp.setVramByte(SPRITE_TABLE + slot * 4, 240)
  }

  /** A solid 8 x 8 pattern of 1s — eight bytes, one row each (§10). */
  const SOLID_1BPP = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]

  /**
   * A 1bpp sprite in sub-palette 1, and the index it draws.
   *
   * §10's mapping with `SPRPAL` at its reset 0: the group is `0 × 16 + 1`, a
   * 1bpp group is two entries wide, and so a set pixel is `(1 × 2 + 1) & $FF` —
   * entry 3. Every position test uses this pair, so a 3 in an expectation means
   * "a sprite pixel here" and `BACKDROP` means "none".
   */
  const ATTR = 0x01
  const SPRITE = 3

  /** A pixel of the Graphics picture, whose origin is x 32, y 0 (§3). */
  const shown = (indices: Uint8Array, x: number, y: number): number => pixel(indices, 32 + x, y)

  const shownRow = (indices: Uint8Array, x: number, y: number, count: number): number[] =>
    pixels(indices, 32 + x, y, count)

  /** Read a status register through port A, selecting it first (§6). */
  const status = (vdp: Video, select: number): number => {
    writeRegister(vdp, 0x0f, select) // STATSEL_A
    return vdp.read(1)
  }

  // ----------------------------------------------------------------
  //  The attribute table
  // ----------------------------------------------------------------

  describe('the attribute table (§10)', () => {
    it('draws a sprite from the four bytes of one slot', () => {
      const vdp = card()
      poke(vdp, SPRITE_PATTERNS, SOLID_1BPP)
      sprite(vdp, 0, { y: 0, x: 0, attributes: ATTR })

      const indices = frame(vdp)
      expect(shownRow(indices, 0, 0, 9)).toEqual([3, 3, 3, 3, 3, 3, 3, 3, BACKDROP])
      expect(shownRow(indices, 0, 7, 9)).toEqual([3, 3, 3, 3, 3, 3, 3, 3, BACKDROP])
      expect(shown(indices, 0, 8)).toBe(BACKDROP)
    })

    it('evaluates 64 of them, four bytes apart', () => {
      const vdp = card()
      writeRegister(vdp, 0x22, 64) // SPRCOUNT: all of them
      poke(vdp, SPRITE_PATTERNS, SOLID_1BPP)
      // The 63 slots below it are parked off the bottom of the picture, so the
      // only sprite that can draw is the last one — which it cannot do unless
      // all 64 slots are evaluated.
      park(vdp, 63)
      sprite(vdp, 63, { y: 0, x: 16, attributes: ATTR })

      expect(shown(frame(vdp), 16, 0)).toBe(SPRITE)
    })

    it('evaluates only the slots below SPRCOUNT', () => {
      const vdp = card()
      writeRegister(vdp, 0x22, 2) // SPRCOUNT = 2: slots 0 and 1
      poke(vdp, SPRITE_PATTERNS, SOLID_1BPP)
      sprite(vdp, 0, { x: 0, attributes: ATTR })
      sprite(vdp, 1, { x: 16, attributes: ATTR })
      sprite(vdp, 2, { x: 32, attributes: ATTR })

      const indices = frame(vdp)
      expect(shown(indices, 0, 0)).toBe(SPRITE)
      expect(shown(indices, 16, 0)).toBe(SPRITE)
      expect(shown(indices, 32, 0)).toBe(BACKDROP)
    })

    it('draws nothing at all with SPRCOUNT at 0', () => {
      const vdp = card()
      writeRegister(vdp, 0x22, 0)
      poke(vdp, SPRITE_PATTERNS, SOLID_1BPP)
      sprite(vdp, 0, { attributes: ATTR })

      expect(shown(frame(vdp), 0, 0)).toBe(BACKDROP)
    })

    it('takes its base from SPRATTR x $80 over eight bits, reaching $7F80 (§5)', () => {
      const vdp = card()
      const table = 0x7f80
      writeRegister(vdp, 0x20, table >> 7) // $FF — the top of the field
      poke(vdp, SPRITE_PATTERNS, SOLID_1BPP)
      poke(vdp, table, [0, 24, 0, ATTR])
      vdp.setVramByte(table + 4, TERMINATOR)

      expect(shown(frame(vdp), 24, 0)).toBe(SPRITE)
    })

    it('takes its patterns from SPRPAT x $800 over eight bits, reaching $F800 (§5)', () => {
      const vdp = card()
      const patterns = 0xf800
      writeRegister(vdp, 0x21, patterns >> 11) // $1F
      poke(vdp, patterns, SOLID_1BPP)
      sprite(vdp, 0, { x: 8, attributes: ATTR })

      expect(shown(frame(vdp), 8, 0)).toBe(SPRITE)
    })
  })

  // ----------------------------------------------------------------
  //  Position
  // ----------------------------------------------------------------

  describe('vertical position (§10)', () => {
    /** A sprite whose eight rows are distinguishable from one another. */
    const STAIRCASE = [0x80, 0x40, 0x20, 0x10, 0x08, 0x04, 0x02, 0x01]

    it('puts the sprite’s top edge on the display line Y names', () => {
      const vdp = card()
      poke(vdp, SPRITE_PATTERNS, STAIRCASE)
      sprite(vdp, 0, { y: 100, attributes: ATTR })

      const indices = frame(vdp)
      expect(shown(indices, 0, 99)).toBe(BACKDROP)
      expect(shown(indices, 0, 100)).toBe(SPRITE) // pattern row 0
      expect(shown(indices, 7, 107)).toBe(SPRITE) // pattern row 7
      expect(shown(indices, 7, 108)).toBe(BACKDROP)
    })

    it('reads 241-255 as -15…-1, which is how a sprite enters from the top', () => {
      const vdp = card()
      poke(vdp, SPRITE_PATTERNS, STAIRCASE)
      sprite(vdp, 0, { y: 0xfd, attributes: ATTR }) // -3: rows 0-2 are above

      const indices = frame(vdp)
      // Display line 0 shows pattern row 3, whose single pixel is at x 3.
      expect(shownRow(indices, 0, 0, 8)).toEqual([
        BACKDROP,
        BACKDROP,
        BACKDROP,
        SPRITE,
        BACKDROP,
        BACKDROP,
        BACKDROP,
        BACKDROP
      ])
    })

    it('is one line higher than a TMS9918 would put it, Y being the top edge', () => {
      const vdp = card()
      poke(vdp, SPRITE_PATTERNS, STAIRCASE)
      sprite(vdp, 0, { y: 0xff, attributes: ATTR })

      // $FF means -1 (§10), so the first line of the picture shows pattern row
      // 1 — where a 9918's Y + 1 convention would show row 0. This is the one
      // place §10's single rule for every mode diverges from the part it is
      // compatible with, and it is written down rather than emulated around.
      const indices = frame(vdp)
      expect(shownRow(indices, 0, 0, 2)).toEqual([BACKDROP, SPRITE]) // row 1
      expect(shownRow(indices, 0, 6, 8)).toEqual([
        BACKDROP,
        BACKDROP,
        BACKDROP,
        BACKDROP,
        BACKDROP,
        BACKDROP,
        BACKDROP,
        SPRITE
      ]) // row 7, the last of the pattern
    })

    it('keeps 240 positive — the first row below a 240-line picture', () => {
      const vdp = card()
      poke(vdp, SPRITE_PATTERNS, SOLID_1BPP)
      sprite(vdp, 0, { y: 240, attributes: ATTR })

      // Not -16, which would put it across the top eight lines of the screen.
      expect(frame(vdp).every((index) => index === BACKDROP)).toBe(true)
    })
  })

  describe('horizontal position — nine bits (§10)', () => {
    it('takes X bits 7:0 from the slot and bit 8 from attribute b7', () => {
      const vdp = card(sprctrl(), FULL) // 320 wide, so 300 is on screen
      poke(vdp, SPRITE_PATTERNS, SOLID_1BPP)
      sprite(vdp, 0, { x: 300 - 256, attributes: ATTR | 0x80 })

      const indices = frame(vdp)
      expect(pixel(indices, 299, 0)).toBe(BACKDROP)
      expect(pixel(indices, 300, 0)).toBe(SPRITE)
      expect(pixel(indices, 307, 0)).toBe(SPRITE)
    })

    it('reads 384-511 as -128…-1, which is how a sprite enters from the left', () => {
      const vdp = card()
      poke(vdp, SPRITE_PATTERNS, SOLID_1BPP)
      // 508: X bit 8 set, low byte $FC, so -4 — half of it off the left edge.
      sprite(vdp, 0, { x: 0xfc, attributes: ATTR | 0x80 })

      const indices = frame(vdp)
      expect(shownRow(indices, 0, 0, 5)).toEqual([SPRITE, SPRITE, SPRITE, SPRITE, BACKDROP])
    })

    it('clips at the right edge of the picture rather than wrapping', () => {
      const vdp = card()
      poke(vdp, SPRITE_PATTERNS, SOLID_1BPP)
      sprite(vdp, 0, { x: 252, attributes: ATTR }) // four pixels over the edge

      const indices = frame(vdp)
      expect(shownRow(indices, 252, 0, 4)).toEqual([SPRITE, SPRITE, SPRITE, SPRITE])
      // The four that fell off did not reappear on the left, and the picture's
      // right-hand border is still the backdrop.
      expect(shownRow(indices, 0, 0, 4)).toEqual([BACKDROP, BACKDROP, BACKDROP, BACKDROP])
      expect(pixel(indices, 288, 0)).toBe(BACKDROP)
    })
  })

  // ----------------------------------------------------------------
  //  Patterns
  // ----------------------------------------------------------------

  describe('bit depth, from SPRCTRL b5:4 (§10)', () => {
    it('reads eight bytes per 8 x 8 at 1bpp, MSB leftmost', () => {
      const vdp = card(sprctrl({ depth: BPP1 }))
      poke(vdp, SPRITE_PATTERNS, [0x81])
      sprite(vdp, 0, { attributes: ATTR })

      expect(shownRow(frame(vdp), 0, 0, 8)).toEqual([
        SPRITE,
        BACKDROP,
        BACKDROP,
        BACKDROP,
        BACKDROP,
        BACKDROP,
        BACKDROP,
        SPRITE
      ])
    })

    it('reads sixteen at 2bpp, two bytes to a row', () => {
      const vdp = card(sprctrl({ depth: BPP2 }))
      poke(vdp, SPRITE_PATTERNS, [0x1b, 0xe4]) // 0,1,2,3 then 3,2,1,0
      sprite(vdp, 0, { attributes: 0x02 }) // sub-palette 2 → entries 8-11

      expect(shownRow(frame(vdp), 0, 0, 8)).toEqual([BACKDROP, 9, 10, 11, 11, 10, 9, BACKDROP])
    })

    it('reads thirty-two at 4bpp, high nibble leftmost', () => {
      const vdp = card(sprctrl({ depth: BPP4 }))
      poke(vdp, SPRITE_PATTERNS, [0x12, 0x34, 0x56, 0x78])
      sprite(vdp, 0, { attributes: 0x02 }) // sub-palette 2 → entries 32-47

      expect(shownRow(frame(vdp), 0, 0, 8)).toEqual([33, 34, 35, 36, 37, 38, 39, 40])
    })

    it('reads sixty-four at 8bpp, where the byte is the palette index', () => {
      const vdp = card(sprctrl({ depth: BPP8 }))
      poke(vdp, SPRITE_PATTERNS, [0x00, 0x7f, 0x80, 0xff, 0x01, 0x02, 0x03, 0x04])
      // §8: at 8bpp one group covers the whole palette, so there is nothing
      // left for the sub-palette to say and `$0F` says it anyway.
      sprite(vdp, 0, { attributes: 0x0f })

      expect(shownRow(frame(vdp), 0, 0, 8)).toEqual([BACKDROP, 0x7f, 0x80, 0xff, 1, 2, 3, 4])
    })

    it('leaves a pattern value of 0 transparent at every depth', () => {
      for (const depth of [BPP1, BPP2, BPP4, BPP8]) {
        const vdp = card(sprctrl({ depth }))
        // Nothing poked: the whole pattern is zeros, and a sprite of zeros is a
        // sprite of nothing — there is no `LxCTRL` b5 for sprites (§10).
        sprite(vdp, 0, { attributes: 0x0f })

        expect(shown(frame(vdp), 0, 0)).toBe(BACKDROP)
      }
    })
  })

  describe('size and magnification, from MODE1 b1:0 (§10)', () => {
    /**
     * A 16 x 16 pattern whose four quadrants are told apart by being solid or
     * empty: top left and bottom right are drawn, the other two are not.
     *
     * §10 lays the quadrants out in TMS9918 order — top left, bottom left, top
     * right, bottom right — so this is the test that the order is that and not
     * the reading order it looks like it should be.
     */
    const QUADRANTS = [
      ...SOLID_1BPP, // top left
      ...new Array(8).fill(0x00), // bottom left
      ...new Array(8).fill(0x00), // top right
      ...SOLID_1BPP // bottom right
    ]

    it('draws 16 x 16 from four quadrants in TMS9918 order', () => {
      const vdp = card()
      writeRegister(vdp, 0x01, 0x42) // MODE1: display on, 16x16
      // Index 4 counts 8 x 8 patterns: its quadrants are patterns 4 to 7.
      poke(vdp, SPRITE_PATTERNS + 4 * 8, QUADRANTS)
      sprite(vdp, 0, { pattern: 4, attributes: ATTR })

      const indices = frame(vdp)
      expect(shown(indices, 0, 0)).toBe(SPRITE) // top left
      expect(shown(indices, 8, 0)).toBe(BACKDROP) // top right
      expect(shown(indices, 0, 8)).toBe(BACKDROP) // bottom left
      expect(shown(indices, 8, 8)).toBe(SPRITE) // bottom right
      expect(shown(indices, 15, 15)).toBe(SPRITE)
      expect(shown(indices, 16, 15)).toBe(BACKDROP)
    })

    it('counts the pattern index in 8 x 8 patterns at 16 x 16, low bits and all', () => {
      // §10: a 16 x 16 sprite with index N draws patterns N to N + 3 — the
      // TMS9918's rule, at every depth. Index 5 is not index 4: its top-left
      // quadrant is pattern 5, which is QUADRANTS' second, empty one.
      const vdp = card()
      writeRegister(vdp, 0x01, 0x42)
      poke(vdp, SPRITE_PATTERNS + 4 * 8, QUADRANTS)
      sprite(vdp, 0, { pattern: 5, attributes: ATTR })

      const indices = frame(vdp)
      expect(shown(indices, 0, 0)).toBe(BACKDROP) // pattern 5, empty
      expect(shown(indices, 0, 8)).toBe(BACKDROP) // pattern 6, empty
      expect(shown(indices, 8, 0)).toBe(SPRITE) // pattern 7, solid
    })

    it('counts 8 x 8 patterns at 4bpp too, thirty-two bytes apart', () => {
      const vdp = card(sprctrl({ depth: BPP4 }))
      writeRegister(vdp, 0x01, 0x42) // 16x16
      poke(vdp, SPRITE_PATTERNS + 3 * 32, new Array(32).fill(0x11)) // pattern 3
      sprite(vdp, 0, { pattern: 3, attributes: 0x00 })

      const indices = frame(vdp)
      expect(shown(indices, 0, 0)).toBe(1) // top left is pattern 3 itself
      expect(shown(indices, 0, 8)).toBe(BACKDROP) // bottom left is pattern 4
    })

    it('magnifies every sprite x2 on MODE1 b0, pixels and rows alike', () => {
      const vdp = card()
      writeRegister(vdp, 0x01, 0x41) // MODE1: display on, 8x8 magnified
      poke(vdp, SPRITE_PATTERNS, [0x80]) // one pixel, top left of the pattern
      sprite(vdp, 0, { attributes: ATTR })

      const indices = frame(vdp)
      expect(shownRow(indices, 0, 0, 3)).toEqual([SPRITE, SPRITE, BACKDROP])
      expect(shownRow(indices, 0, 1, 3)).toEqual([SPRITE, SPRITE, BACKDROP])
      expect(shown(indices, 0, 2)).toBe(BACKDROP)
    })

    it('makes a magnified 16 x 16 cover 32 x 32 pixels', () => {
      const vdp = card()
      writeRegister(vdp, 0x01, 0x43) // MODE1: display on, 16x16 magnified
      poke(vdp, SPRITE_PATTERNS + 4 * 8, new Array(32).fill(0xff))
      sprite(vdp, 0, { pattern: 4, attributes: ATTR })

      const indices = frame(vdp)
      expect(shown(indices, 31, 31)).toBe(SPRITE)
      expect(shown(indices, 32, 31)).toBe(BACKDROP)
      expect(shown(indices, 31, 32)).toBe(BACKDROP)
    })
  })

  describe('flipping, from attribute b4 and b5 (§10)', () => {
    const FLIP_X = 0x10
    const FLIP_Y = 0x20

    it('mirrors a sprite horizontally on b4', () => {
      const vdp = card()
      poke(vdp, SPRITE_PATTERNS, [0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80])
      sprite(vdp, 0, { attributes: ATTR | FLIP_X })

      expect(shownRow(frame(vdp), 6, 0, 2)).toEqual([BACKDROP, SPRITE])
    })

    it('mirrors a sprite vertically on b5', () => {
      const vdp = card()
      poke(vdp, SPRITE_PATTERNS, [0xff])
      sprite(vdp, 0, { attributes: ATTR | FLIP_Y })

      const indices = frame(vdp)
      expect(shown(indices, 0, 0)).toBe(BACKDROP)
      expect(shown(indices, 0, 7)).toBe(SPRITE)
    })

    it('flips a 16 x 16 sprite’s quadrant arrangement with it', () => {
      const vdp = card()
      writeRegister(vdp, 0x01, 0x42) // 16x16
      // Top left quadrant only.
      poke(vdp, SPRITE_PATTERNS + 4 * 8, [...SOLID_1BPP, ...new Array(24).fill(0x00)])
      sprite(vdp, 0, { pattern: 4, attributes: ATTR | FLIP_X })

      const indices = frame(vdp)
      expect(shown(indices, 0, 0)).toBe(BACKDROP)
      expect(shown(indices, 8, 0)).toBe(SPRITE) // the quadrant moved with the flip
      expect(shown(indices, 8, 8)).toBe(BACKDROP)
    })
  })

  // ----------------------------------------------------------------
  //  Priority, the per-line limit and overflow
  // ----------------------------------------------------------------

  describe('priority among sprites (§10)', () => {
    it('gives the pixel to the lower table index', () => {
      const vdp = card()
      poke(vdp, SPRITE_PATTERNS, SOLID_1BPP)
      sprite(vdp, 0, { attributes: 0x01 }) // entry 3
      sprite(vdp, 1, { attributes: 0x02 }) // entry 5, and behind

      expect(shown(frame(vdp), 0, 0)).toBe(3)
    })

    it('draws sprites over layer 0, which is as much of §12 as one layer says', () => {
      const vdp = card()
      // A layer of solid foreground 5 under a sprite of entry 3.
      writeRegister(vdp, 0x15, 0x30) // L0CTRL: 1bpp, per cell, enabled, opaque
      writeRegister(vdp, 0x10, 0x00) // L0NAME at $0000
      writeRegister(vdp, 0x11, 0x01) // L0ATTR at $0400
      writeRegister(vdp, 0x12, 0x02) // L0PAT at $1000
      poke(vdp, 0x0400, [0x55, 0x55])
      poke(vdp, 0x1000, SOLID_1BPP)
      poke(vdp, SPRITE_PATTERNS, SOLID_1BPP)
      sprite(vdp, 0, { attributes: ATTR })

      const indices = frame(vdp)
      expect(shown(indices, 0, 0)).toBe(SPRITE)
      expect(shown(indices, 8, 0)).toBe(5) // the layer, beside the sprite
    })
  })

  describe('the per-line limit and SPRLIMIT (§10)', () => {
    /** Three sprites, eight pixels apart, all covering display lines 0-7. */
    const three = (vdp: Video): void => {
      poke(vdp, SPRITE_PATTERNS, SOLID_1BPP)
      sprite(vdp, 0, { x: 0, attributes: ATTR })
      sprite(vdp, 1, { x: 8, attributes: ATTR })
      sprite(vdp, 2, { x: 16, attributes: ATTR })
    }

    it('draws SPRLIMIT of them and drops the excess, highest index first', () => {
      const vdp = card()
      writeRegister(vdp, 0x24, 2) // SPRLIMIT
      three(vdp)

      const indices = frame(vdp)
      expect(shown(indices, 0, 0)).toBe(SPRITE)
      expect(shown(indices, 8, 0)).toBe(SPRITE)
      expect(shown(indices, 16, 0)).toBe(BACKDROP)
    })

    it('drops for the overflowing line only', () => {
      const vdp = card()
      writeRegister(vdp, 0x24, 1) // SPRLIMIT: one sprite a line
      poke(vdp, SPRITE_PATTERNS, SOLID_1BPP)
      sprite(vdp, 0, { y: 0, x: 0, attributes: ATTR }) // lines 0-7
      sprite(vdp, 1, { y: 4, x: 8, attributes: ATTR }) // lines 4-11

      const indices = frame(vdp)
      expect(shown(indices, 8, 4)).toBe(BACKDROP) // dropped where they overlap
      expect(shown(indices, 8, 8)).toBe(SPRITE) // drawn where it is alone
    })

    it('draws thirty-two on a line, which is where the ceiling is', () => {
      const vdp = card()
      writeRegister(vdp, 0x22, 64) // SPRCOUNT
      writeRegister(vdp, 0x24, 0xff) // SPRLIMIT past its range: 32 is the most
      poke(vdp, SPRITE_PATTERNS, [0x80])
      for (let slot = 0; slot < 40; slot++) sprite(vdp, slot, { x: slot * 4, attributes: ATTR })

      const indices = frame(vdp)
      expect(shown(indices, 31 * 4, 0)).toBe(SPRITE)
      expect(shown(indices, 32 * 4, 0)).toBe(BACKDROP)
    })

    it('keeps OVF and the index until STAT0 is read, however many frames go by', () => {
      const vdp = card()
      writeRegister(vdp, 0x24, 2)
      three(vdp)
      renderOneFrame(vdp)
      writeRegister(vdp, 0x24, 32) // nothing overflows any more
      renderOneFrame(vdp)

      expect(vdp.getStatus() & 0x5f).toBe(0x42) // still OVF, still sprite 2
      expect(status(vdp, 0) & 0x40).toBe(0x40)
      expect(vdp.getStatus() & 0x5f).toBe(0) // the read cleared them
    })

    it('sets STAT0 b6 and its index field to the first sprite dropped', () => {
      const vdp = card()
      writeRegister(vdp, 0x24, 2)
      three(vdp)
      renderOneFrame(vdp)

      expect(vdp.getStatus() & 0x40).toBe(0x40) // OVF
      expect(vdp.getStatus() & 0x1f).toBe(2)
    })

    it('names slots 32-63 in STAT7, which STAT0’s five bits cannot', () => {
      const vdp = card()
      writeRegister(vdp, 0x22, 64) // SPRCOUNT
      writeRegister(vdp, 0x24, 32) // SPRLIMIT at its ceiling, so slot 32 is the first dropped
      poke(vdp, SPRITE_PATTERNS, [0x80])
      for (let slot = 0; slot < 34; slot++) sprite(vdp, slot, { x: slot * 4, attributes: ATTR })
      renderOneFrame(vdp)

      // Sprite 32 is the first dropped, and five bits of 32 are zero.
      expect(vdp.getStatus() & 0x1f).toBe(0)
      expect(status(vdp, 7)).toBe(32)
    })

    it('follows the last overflowing line in STAT7 and latches the first in STAT0', () => {
      const vdp = card()
      writeRegister(vdp, 0x24, 2) // SPRLIMIT
      poke(vdp, SPRITE_PATTERNS, SOLID_1BPP)
      // Three sprites on lines 0-7, three more on lines 8-15.
      for (const slot of [0, 1, 2]) sprite(vdp, slot, { y: 0, x: slot * 8, attributes: ATTR })
      for (const slot of [3, 4, 5]) sprite(vdp, slot, { y: 8, x: slot * 8, attributes: ATTR })
      renderOneFrame(vdp)

      expect(vdp.getStatus() & 0x1f).toBe(2) // the first line's casualty
      expect(status(vdp, 7)).toBe(5) // the last line's
    })

    it('raises the overflow interrupt once a frame, when IRQEN b2 enables it', () => {
      const vdp = card()
      writeRegister(vdp, 0x24, 2) // SPRLIMIT
      writeRegister(vdp, 0x0a, 0x04) // IRQEN: sprite overflow only
      three(vdp)
      renderOneFrame(vdp)

      expect(vdp.tick(1_000_000) & 0x80).toBe(0x80)
      expect(status(vdp, 1)).toBe(0x04) // STAT1: the overflow, and nothing else
      expect(vdp.tick(1_000_000) & 0x80).toBe(0) // acknowledged
    })

    it('drops the same sprites every frame — §10 has no flicker in it', () => {
      const vdp = card()
      writeRegister(vdp, 0x24, 2)
      three(vdp)

      const first = Uint8Array.from(frame(vdp))
      const second = Uint8Array.from(frame(vdp))
      expect(second).toEqual(first)
      expect(shown(second, 16, 0)).toBe(BACKDROP) // sprite 2, dropped again
    })
  })

  // ----------------------------------------------------------------
  //  Collision
  // ----------------------------------------------------------------

  describe('collision (§10)', () => {
    /** Two sprites of one pixel each, at the same place unless told otherwise. */
    const overlap = (vdp: Video, { apart = false } = {}): void => {
      poke(vdp, SPRITE_PATTERNS, [0x80])
      sprite(vdp, 0, { x: 0, attributes: ATTR })
      sprite(vdp, 1, { x: apart ? 8 : 0, attributes: ATTR })
    }

    it('sets STAT0 b5 when two sprites cover one pixel', () => {
      const vdp = card()
      overlap(vdp)
      renderOneFrame(vdp)

      expect(vdp.getStatus() & 0x20).toBe(0x20)
    })

    it('leaves it clear when they only come close', () => {
      const vdp = card()
      overlap(vdp, { apart: true })
      renderOneFrame(vdp)

      expect(vdp.getStatus() & 0x20).toBe(0)
    })

    it('detects nothing while SPRCTRL b1 is clear', () => {
      const vdp = card(sprctrl({ collision: false }))
      overlap(vdp)
      renderOneFrame(vdp)

      expect(vdp.getStatus() & 0x20).toBe(0)
    })

    it('collides on coverage, not on what was drawn', () => {
      // Sprite 1 loses every pixel to sprite 0 (§10's priority is the table
      // index), and collides on all of them anyway: §10 tests collision before
      // priority resolution.
      const vdp = card()
      poke(vdp, SPRITE_PATTERNS, SOLID_1BPP)
      sprite(vdp, 0, { attributes: 0x01 })
      sprite(vdp, 1, { attributes: 0x02 })
      renderOneFrame(vdp)

      expect(shown(vdp.frameIndices(), 0, 0)).toBe(3) // sprite 0's colour
      expect(vdp.getStatus() & 0x20).toBe(0x20)
    })

    it('raises it once a frame however quickly the handler acknowledges', () => {
      // Eight lines of overlap. A handler that reads STAT1 the moment /INT
      // asserts must not be interrupted again on the next colliding line (§14).
      const vdp = card()
      writeRegister(vdp, 0x0a, 0x08) // IRQEN: sprite collision only
      poke(vdp, SPRITE_PATTERNS, SOLID_1BPP)
      sprite(vdp, 0, { attributes: ATTR })
      sprite(vdp, 1, { attributes: ATTR })

      // Two frames, stopping on display line 260 (see renderOneFrame).
      let interrupts = 0
      const cycles = Math.ceil((2 * 1_000_000) / 60) - 1 - Math.ceil(1_000_000 / 60 / 262)
      for (let cycle = 0; cycle < cycles; cycle++) {
        if (vdp.tick(1_000_000) & 0x80) {
          interrupts++
          status(vdp, 1)
        }
      }
      expect(interrupts).toBe(2) // two frames, one each
    })

    it('raises the collision interrupt once a frame, when IRQEN b3 enables it', () => {
      const vdp = card()
      writeRegister(vdp, 0x0a, 0x08) // IRQEN: sprite collision only
      poke(vdp, SPRITE_PATTERNS, SOLID_1BPP) // 64 colliding pixels, one interrupt
      sprite(vdp, 0, { attributes: ATTR })
      sprite(vdp, 1, { attributes: ATTR })
      renderOneFrame(vdp)

      expect(vdp.tick(1_000_000) & 0x80).toBe(0x80)
      expect(status(vdp, 1)).toBe(0x08)
      expect(vdp.tick(1_000_000) & 0x80).toBe(0)
    })

    describe('the detailed map, behind SPRCTRL b3 (§6, §10)', () => {
      it('records both members of a colliding pair', () => {
        const vdp = card(sprctrl({ detailed: true }))
        poke(vdp, SPRITE_PATTERNS, [0x80])
        park(vdp, 3) // slots 0-2 cover no line and do not end the list
        sprite(vdp, 1, { attributes: ATTR, ends: false })
        sprite(vdp, 3, { attributes: ATTR })
        renderOneFrame(vdp)

        expect(status(vdp, 8)).toBe(0b0000_1010) // sprites 1 and 3
      })

      it('records all three when three sprites meet on one pixel', () => {
        const vdp = card(sprctrl({ detailed: true }))
        poke(vdp, SPRITE_PATTERNS, [0x80])
        for (const slot of [0, 1, 2]) sprite(vdp, slot, { attributes: ATTR })
        renderOneFrame(vdp)

        expect(status(vdp, 8)).toBe(0b0000_0111)
      })

      it('names sprite 63 in STAT15 b7', () => {
        const vdp = card(sprctrl({ detailed: true }))
        writeRegister(vdp, 0x22, 64) // SPRCOUNT
        poke(vdp, SPRITE_PATTERNS, [0x80])
        park(vdp, 62)
        sprite(vdp, 62, { attributes: ATTR })
        sprite(vdp, 63, { attributes: ATTR })
        renderOneFrame(vdp)

        expect(status(vdp, 8)).toBe(0)
        expect(status(vdp, 15)).toBe(0b1100_0000)
      })

      it('records nothing while b3 is clear, sticky bit or no sticky bit', () => {
        const vdp = card(sprctrl({ detailed: false }))
        poke(vdp, SPRITE_PATTERNS, [0x80])
        sprite(vdp, 0, { attributes: ATTR })
        sprite(vdp, 1, { attributes: ATTR })
        renderOneFrame(vdp)

        expect(vdp.getStatus() & 0x20).toBe(0x20) // COL, which costs nothing
        expect(status(vdp, 8)).toBe(0) // and the map, which does
      })

      it('clears on a status read, with the flag it details', () => {
        const vdp = card(sprctrl({ detailed: true }))
        poke(vdp, SPRITE_PATTERNS, [0x80])
        sprite(vdp, 0, { attributes: ATTR })
        sprite(vdp, 1, { attributes: ATTR })
        renderOneFrame(vdp)

        expect(status(vdp, 8)).toBe(0b0000_0011)
        expect(status(vdp, 0) & 0x20).toBe(0x20) // reading STAT0 acknowledges
        expect(status(vdp, 8)).toBe(0)
      })

      it('accumulates until STAT0 is read, with the COL bit it details', () => {
        const vdp = card(sprctrl({ detailed: true }))
        poke(vdp, SPRITE_PATTERNS, [0x80])
        sprite(vdp, 0, { attributes: ATTR })
        sprite(vdp, 1, { attributes: ATTR })
        renderOneFrame(vdp)
        expect(status(vdp, 8)).toBe(0b0000_0011)

        // Moved apart. Frames go by, and the map still says what happened — a
        // program polling once a second must not miss a collision (§6, §10).
        sprite(vdp, 1, { x: 8, attributes: ATTR })
        renderOneFrame(vdp)
        expect(status(vdp, 8)).toBe(0b0000_0011)
        expect(vdp.getStatus() & 0x20).toBe(0x20)

        // Reading STAT0 clears both, and nothing sets them again.
        status(vdp, 0)
        expect(status(vdp, 8)).toBe(0)
        renderOneFrame(vdp)
        expect(status(vdp, 8)).toBe(0)
        expect(vdp.getStatus() & 0x20).toBe(0)
      })

      it('clears on a STAT0 read and not on a STAT1 read', () => {
        const vdp = card(sprctrl({ detailed: true }))
        writeRegister(vdp, 0x0a, 0x08) // IRQEN: collision
        poke(vdp, SPRITE_PATTERNS, [0x80])
        sprite(vdp, 0, { attributes: ATTR })
        sprite(vdp, 1, { attributes: ATTR })
        renderOneFrame(vdp)

        expect(status(vdp, 1)).toBe(0x08) // a handler acknowledging on STAT1
        expect(status(vdp, 8)).toBe(0b0000_0011) // leaves the detail for STAT0
        expect(vdp.getStatus() & 0x20).toBe(0x20)
      })
    })
  })

  // ----------------------------------------------------------------
  //  SPRCTRL and SPRPAL
  // ----------------------------------------------------------------

  describe('SPRCTRL (§5, §10)', () => {
    it('draws no sprites at all while b0 is clear', () => {
      const vdp = card(sprctrl({ enabled: false }))
      poke(vdp, SPRITE_PATTERNS, SOLID_1BPP)
      sprite(vdp, 0, { attributes: ATTR })

      expect(shown(frame(vdp), 0, 0)).toBe(BACKDROP)
    })

    it('ends the list at a Y of $D0 while b2 is set', () => {
      const vdp = card()
      poke(vdp, SPRITE_PATTERNS, SOLID_1BPP)
      sprite(vdp, 0, { y: TERMINATOR, x: 0, attributes: ATTR })
      sprite(vdp, 1, { y: 0, x: 8, attributes: ATTR })

      const indices = frame(vdp)
      expect(shown(indices, 0, 208)).toBe(BACKDROP) // the terminator drew nothing
      expect(shown(indices, 8, 0)).toBe(BACKDROP) // and nothing after it did
    })

    it('draws row 208 like any other while b2 is clear, which 240 lines needs', () => {
      const vdp = card(sprctrl({ terminator: false }))
      writeRegister(vdp, 0x22, 2) // SPRCOUNT bounds the table instead
      poke(vdp, SPRITE_PATTERNS, SOLID_1BPP)
      sprite(vdp, 0, { y: TERMINATOR, x: 0, attributes: ATTR })
      sprite(vdp, 1, { y: 0, x: 8, attributes: ATTR })

      const indices = frame(vdp)
      expect(shown(indices, 0, 208)).toBe(SPRITE)
      expect(shown(indices, 8, 0)).toBe(SPRITE)
    })

    it('resets to $27 — enabled, colliding, terminating, 4bpp (§15)', () => {
      expect(new Video().getRegister(0x23)).toBe(0x27)
    })
  })

  describe('SPRPAL (§5, §10)', () => {
    it('is LxPAL’s equivalent: the palette group’s high bits', () => {
      const vdp = card()
      writeRegister(vdp, 0x25, 0x03) // SPRPAL = 3
      poke(vdp, SPRITE_PATTERNS, [0x80])
      sprite(vdp, 0, { attributes: 0x01 })

      // §10: `((SPRPAL × 16 + subpal) × 2^bpp + value) & $FF`, which at 1bpp
      // with sub-palette 1 is `(49 × 2 + 1)` — entry 99.
      expect(shown(frame(vdp), 0, 0)).toBe(99)
    })

    it('reaches the whole palette at 4bpp through the sub-palette alone', () => {
      const vdp = card(sprctrl({ depth: BPP4 }))
      poke(vdp, SPRITE_PATTERNS, [0xf0])
      sprite(vdp, 0, { attributes: 0x0f }) // sub-palette 15, value 15

      expect(shown(frame(vdp), 0, 0)).toBe(0xff)
    })
  })

  // ----------------------------------------------------------------
  //  The legacy submode (§9)
  // ----------------------------------------------------------------

  describe('in the legacy submode (§9)', () => {
    /**
     * A legacy card: `VMODE` = `$0`, `M1`/`M2`/`M3` all clear, so Graphics I —
     * the mode the card powers up in and the one WIZARDSLAB runs. Layer 0 is
     * disabled, as it is everywhere else in this suite, because §9 keeps
     * `L0CTRL`'s enable bit live even where it pins the depth.
     */
    const legacyCard = (control = sprctrl()): Video => {
      const vdp = new Video()
      writeRegister(vdp, 0x01, 0x40) // MODE1: display on, 8x8, unmagnified
      writeRegister(vdp, 0x07, BACKDROP)
      writeRegister(vdp, 0x15, 0x00) // L0CTRL: layer 0 off
      writeRegister(vdp, 0x20, SPRITE_TABLE >> 7) // SPRATTR
      writeRegister(vdp, 0x21, SPRITE_PATTERNS >> 11) // SPRPAT
      writeRegister(vdp, 0x23, control) // SPRCTRL
      vdp.setVramByte(SPRITE_TABLE, TERMINATOR)
      return vdp
    }

    /** Graphics I's picture is the Compact geometry: 32 x 24 at x 32, y 24. */
    const legacyShown = (indices: Uint8Array, x: number, y: number): number =>
      pixel(indices, 32 + x, 24 + y)

    it('pins sprites to 1bpp whatever SPRCTRL b5:4 says', () => {
      // `SPRCTRL` says 8bpp, where these eight bytes would be one row of eight
      // pixels. At 1bpp they are eight rows of one, and that is what is drawn.
      // Y = 0 is display line 1: the TMS9918's first row is at Y + 1 (§9).
      const vdp = legacyCard(sprctrl({ depth: BPP8 }))
      poke(vdp, SPRITE_PATTERNS, [0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80])
      sprite(vdp, 0, { attributes: 0x0f })

      const indices = frame(vdp)
      expect(legacyShown(indices, 0, 1)).toBe(15)
      expect(legacyShown(indices, 0, 8)).toBe(15)
      expect(legacyShown(indices, 1, 1)).toBe(BACKDROP)
    })

    it('draws a sprite’s first row on the line after Y, as the TMS9918 does', () => {
      const vdp = legacyCard()
      poke(vdp, SPRITE_PATTERNS, SOLID_1BPP)
      sprite(vdp, 0, { y: 0xff, attributes: 0x0f }) // -1, so display line 0

      const indices = frame(vdp)
      expect(legacyShown(indices, 0, 0)).toBe(15) // pattern row 0
      expect(legacyShown(indices, 0, 7)).toBe(15) // pattern row 7
      expect(legacyShown(indices, 0, 8)).toBe(BACKDROP)
    })

    it('reads $E1-$FF as -31…-1, so a 32-line sprite can slide in from the top', () => {
      const vdp = legacyCard()
      writeRegister(vdp, 0x01, 0x43) // 16x16 magnified: 32 lines
      poke(vdp, SPRITE_PATTERNS, new Array(32).fill(0xff))
      // -31, and drawn from the line after: rows -30 to 1, so the last two show.
      sprite(vdp, 0, { y: 0xe1, attributes: 0x0f })

      const indices = frame(vdp)
      expect(legacyShown(indices, 0, 1)).toBe(15)
      expect(legacyShown(indices, 0, 2)).toBe(BACKDROP)
    })

    it('forces the $D0 terminator on whatever SPRCTRL b2 says', () => {
      const vdp = legacyCard(sprctrl({ terminator: false }))
      poke(vdp, SPRITE_PATTERNS, [0x80])
      vdp.setVramByte(SPRITE_TABLE, TERMINATOR) // slot 0 ends the list
      sprite(vdp, 1, { attributes: 0x0f, ends: false })

      expect(frame(vdp).every((index) => index === BACKDROP)).toBe(true)
    })

    it('ignores attribute b4-b6, which were unused bits on a TMS9918', () => {
      const vdp = legacyCard()
      poke(vdp, SPRITE_PATTERNS, [0x80]) // one pixel, top left
      sprite(vdp, 0, { attributes: 0x0f | 0x70 }) // flip X, flip Y, priority

      const indices = frame(vdp)
      expect(legacyShown(indices, 0, 1)).toBe(15) // not mirrored to x 7 or row 7
      expect(legacyShown(indices, 7, 8)).toBe(BACKDROP)
    })

    it('reads attribute b3:0 as a palette index rather than a sub-palette', () => {
      const vdp = legacyCard()
      poke(vdp, SPRITE_PATTERNS, [0x80])
      sprite(vdp, 0, { attributes: 0x03 })

      // Direct: entry 3. As a sub-palette it would be `(3 × 2 + 1)` = entry 7.
      expect(legacyShown(frame(vdp), 0, 1)).toBe(3)
    })

    it('ignores SPRPAL: the index is into palette row 0, the TMS9918’s sixteen', () => {
      const vdp = legacyCard()
      writeRegister(vdp, 0x25, 0x01) // SPRPAL = 1, which a legacy program never writes
      poke(vdp, SPRITE_PATTERNS, [0x80])
      sprite(vdp, 0, { attributes: 0x03 })

      expect(legacyShown(frame(vdp), 0, 1)).toBe(3)
    })

    it('reads attribute b7 as the early clock: 32 pixels left, not 256', () => {
      const vdp = legacyCard()
      poke(vdp, SPRITE_PATTERNS, [0x80])
      sprite(vdp, 0, { x: 40, attributes: 0x0f | 0x80 })

      const indices = frame(vdp)
      expect(legacyShown(indices, 8, 1)).toBe(15)
      expect(legacyShown(indices, 40, 1)).toBe(BACKDROP)
    })

    it('draws colour 0 not at all, and collides with it anyway', () => {
      const vdp = legacyCard()
      poke(vdp, SPRITE_PATTERNS, [0x80])
      sprite(vdp, 0, { attributes: 0x00 }) // transparent, and in front
      sprite(vdp, 1, { attributes: 0x0f }) // white, and behind
      renderOneFrame(vdp)

      // The TMS9918's transparent sprite: invisible, does not occlude what is
      // behind it, and collides all the same — which is what the idiom is for.
      expect(legacyShown(vdp.frameIndices(), 0, 1)).toBe(15)
      expect(vdp.getStatus() & 0x20).toBe(0x20)
    })
  })
})

// ================================================================
//  Layer 1, compositing and scrolling (§12, §13)
// ================================================================

/**
 * The second layer, the six-level priority order, and the scroll registers.
 *
 * All three are one phase because they are one mechanism: a layer is a block of
 * seven registers, priority is what decides between two of them, and a scroll
 * offset is what makes the second layer worth having. Neither acceptance target
 * has any of it — `L1CTRL` resets disabled and `LxSCRX`/`LxSCRY` reset to 0, so
 * the goldens are silent here by construction and these tests are the oracle.
 *
 * Everything is read in the Graphics geometry, 32 x 30 of 8 x 8 at x 32 with no
 * vertical border, so a display line is a screen line and the map is 256 x 240.
 */
describe('two layers, priority and scrolling (§12, §13)', () => {
  const GRAPHICS = 0x3
  const FULL = 0x4
  const TEXT = 0x1

  const BPP1 = 0
  const BPP4 = 2
  const PER_CELL = 0
  const NO_ATTRIBUTES = 3

  const control = (
    depth: number,
    source: number,
    { opaque = false, enabled = true, scrxBit8 = false } = {}
  ): number =>
    depth | (source << 2) | (enabled ? 0x10 : 0) | (opaque ? 0x20 : 0) | (scrxBit8 ? 0x40 : 0)

  /** Each layer's tables, kept apart so the two can be told from each other. */
  const L0 = { name: 0x0000, attr: 0x1000, pattern: 0x2000 }
  const L1 = { name: 0x4000, attr: 0x5000, pattern: 0x6000 }
  const SPRITE_TABLE = 0x3800
  const SPRITE_PATTERNS = 0x3000

  /** `COLOR` b3:0 — the backdrop, and so "nothing drew here". */
  const BACKDROP = 0x0e

  /** Palette indices each source paints, distinct so a pixel names its source. */
  const L0_INK = 0x01
  const L1_INK = 0x02
  const SPRITE_INK = 0xff // 4bpp sub-palette 15, value 15 — §10's mapping

  /**
   * A card with both layers pointed at their own tables and the sprite list
   * terminated out of the way.
   *
   * Both layers start 1bpp, per-cell, index 0 transparent — which is what makes
   * "this pixel is backdrop" mean "neither layer drew here" rather than "layer 0
   * drew its background nibble".
   */
  const card = (vmode: number = GRAPHICS): Video => {
    const vdp = new Video()
    writeRegister(vdp, 0x01, 0x40) // MODE1: display on, no interrupt
    writeRegister(vdp, 0x07, BACKDROP) // COLOR
    writeRegister(vdp, 0x0d, vmode) // VMODE
    writeRegister(vdp, 0x10, L0.name >> 10) // L0NAME
    writeRegister(vdp, 0x11, L0.attr >> 10) // L0ATTR
    writeRegister(vdp, 0x12, L0.pattern >> 11) // L0PAT
    writeRegister(vdp, 0x15, control(BPP1, PER_CELL)) // L0CTRL
    writeRegister(vdp, 0x18, L1.name >> 10) // L1NAME
    writeRegister(vdp, 0x19, L1.attr >> 10) // L1ATTR
    writeRegister(vdp, 0x1a, L1.pattern >> 11) // L1PAT
    writeRegister(vdp, 0x1d, control(BPP1, PER_CELL)) // L1CTRL
    writeRegister(vdp, 0x20, SPRITE_TABLE >> 7) // SPRATTR
    writeRegister(vdp, 0x21, SPRITE_PATTERNS >> 11) // SPRPAT
    vdp.setVramByte(SPRITE_TABLE, 0xd0) // $D0: the list ends here
    return vdp
  }

  /** The Graphics geometry's origin (§3): x 32, no vertical border. */
  const X0 = 32

  /** What a layer drew at screen pixel (x, y) of the picture. */
  const shown = (indices: Uint8Array, x: number, y = 0): number => pixel(indices, X0 + x, y)

  /**
   * Fill one cell of a layer with a solid 1bpp tile of `ink`.
   *
   * Pattern `$FF` in every row and a colour byte whose foreground nibble is the
   * ink, so the cell is eight opaque pixels wide and nothing else in the layer
   * is — the surrounding cells draw pattern 0, whose background nibble is 0 and
   * therefore transparent.
   */
  const solidCell = (
    vdp: Video,
    tables: { name: number; attr: number; pattern: number },
    { cell = 0, tile = 1, ink = 1 } = {}
  ): void => {
    poke(vdp, tables.name + cell, [tile])
    poke(vdp, tables.pattern + tile * 8, [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])
    poke(vdp, tables.attr + cell, [ink << 4])
  }

  // ----------------------------------------------------------------
  //  The second layer (§5, §8)
  // ----------------------------------------------------------------

  describe('layer 1 — the same engine, a second register block (§5, §8)', () => {
    it('draws nothing until L1CTRL b4 is set, which reset leaves clear', () => {
      const vdp = card()
      writeRegister(vdp, 0x1d, control(BPP1, PER_CELL, { enabled: false }))
      solidCell(vdp, L1, { ink: L1_INK })

      expect(shown(frame(vdp), 0)).toBe(BACKDROP)
    })

    it('resets disabled, with index 0 transparent — L1CTRL = $0C (§5)', () => {
      const vdp = new Video()
      expect(vdp.getRegister(0x1d)).toBe(0x0c)
      expect(vdp.getRegister(0x15)).toBe(0x3c)
    })

    it('reads its own name, attribute and pattern tables', () => {
      const vdp = card()
      solidCell(vdp, L1, { ink: L1_INK })

      // Layer 0's tables are empty, so every pixel of layer 1's cell is its own.
      expect(pixels(frame(vdp), X0, 0, 9)).toEqual([
        L1_INK, L1_INK, L1_INK, L1_INK, L1_INK, L1_INK, L1_INK, L1_INK, BACKDROP
      ])
    })

    it('takes its own depth, attribute source and palette group from L1CTRL', () => {
      const vdp = card()
      // 4bpp with no attribute fetch, so `L1PAL` is the palette row (§8): a
      // pattern nibble of 5 is entry 7 x 16 + 5.
      writeRegister(vdp, 0x1d, control(BPP4, NO_ATTRIBUTES))
      writeRegister(vdp, 0x1e, 0x07) // L1PAL
      poke(vdp, L1.name, [1])
      poke(vdp, L1.pattern + 1 * 32, [0x50, 0x00, 0x00, 0x00])

      expect(pixels(frame(vdp), X0, 0, 2)).toEqual([0x75, BACKDROP])
    })

    it('scales L1ATTR by $400 even in the legacy submode, which is layer 0 only', () => {
      // §9 pins layer 0's depth and attribute source and reinterprets `L0ATTR`
      // as a x$40 granule. Layer 1 is unaffected by all of it.
      const vdp = card(0x0) // VMODE = legacy
      writeRegister(vdp, 0x01, 0x40) // Graphics I: M1, M2, M3 all clear
      solidCell(vdp, L1, { ink: L1_INK })

      expect(shown(frame(vdp), 0, 24)).toBe(L1_INK) // y 24: the Compact origin
    })

    it('keeps the two blocks independent — L0 registers do not move L1', () => {
      const vdp = card()
      solidCell(vdp, L1, { ink: L1_INK })
      writeRegister(vdp, 0x10, 0x3f) // L0NAME somewhere else entirely
      writeRegister(vdp, 0x12, 0x1f) // L0PAT likewise

      expect(shown(frame(vdp), 0)).toBe(L1_INK)
    })
  })

  // ----------------------------------------------------------------
  //  §12's six levels
  // ----------------------------------------------------------------

  describe('priority resolution (§12)', () => {
    /**
     * One pixel with a candidate from every source, each able to claim priority.
     *
     * Layer 0 and layer 1 both draw a solid 4bpp cell over the pixel and one
     * sprite covers it, so which index comes out names which level won. The
     * layers are 4bpp because b6 is an attribute-byte bit and there is no
     * attribute byte at 1bpp — the colour byte's b6 is half the foreground
     * nibble there (§8).
     */
    const contested = ({ l0 = 0x00, l1 = 0x00, sprite = 0x0f } = {}): Video => {
      const vdp = card()
      for (const [ctrl, pal, tables, attribute] of [
        [0x15, 0x16, L0, l0],
        [0x1d, 0x1e, L1, l1]
      ] as const) {
        writeRegister(vdp, ctrl, control(BPP4, PER_CELL))
        writeRegister(vdp, pal, 0x00)
        poke(vdp, tables.name, [1])
        poke(vdp, tables.attr, [attribute])
      }
      // Layer 0 draws value 1 and layer 1 value 2, in sub-palette 0 of each —
      // so L0_INK and L1_INK come straight out of §8's 4bpp mapping.
      poke(vdp, L0.pattern + 32, [0x11, 0x11, 0x11, 0x11])
      poke(vdp, L1.pattern + 32, [0x22, 0x22, 0x22, 0x22])

      poke(vdp, SPRITE_PATTERNS, new Array(32).fill(0xff))
      poke(vdp, SPRITE_TABLE, [0x00, 0x00, 0x00, sprite])
      poke(vdp, SPRITE_TABLE + 4, [0xd0])
      return vdp
    }

    it('level 0 — the backdrop, when nothing else draws', () => {
      const vdp = contested({ sprite: 0x00 })
      writeRegister(vdp, 0x15, control(BPP4, PER_CELL, { enabled: false }))
      writeRegister(vdp, 0x1d, control(BPP4, PER_CELL, { enabled: false }))
      poke(vdp, SPRITE_TABLE, [0xd0])

      expect(shown(frame(vdp), 0)).toBe(BACKDROP)
    })

    it('level 1 — layer 0, over the backdrop and nothing else', () => {
      const vdp = contested()
      writeRegister(vdp, 0x1d, control(BPP4, PER_CELL, { enabled: false }))
      poke(vdp, SPRITE_TABLE, [0xd0])

      expect(shown(frame(vdp), 0)).toBe(L0_INK)
    })

    it('level 2 — an ordinary sprite, over an ordinary layer 0', () => {
      const vdp = contested()
      writeRegister(vdp, 0x1d, control(BPP4, PER_CELL, { enabled: false }))

      expect(shown(frame(vdp), 0)).toBe(SPRITE_INK)
    })

    it('level 3 — an ordinary layer 1, over an ordinary sprite', () => {
      expect(shown(frame(contested()), 0)).toBe(L1_INK)
    })

    it('level 4 — layer 0 with b6 set, over an ordinary sprite', () => {
      const vdp = contested({ l0: 0x40 })
      writeRegister(vdp, 0x1d, control(BPP4, PER_CELL, { enabled: false }))

      // The sprite walks behind the scenery, which is what the bit is for.
      expect(shown(frame(vdp), 0)).toBe(L0_INK)
    })

    it('level 5 — a sprite with b6 set, over an ordinary layer 1', () => {
      expect(shown(frame(contested({ sprite: 0x4f })), 0)).toBe(SPRITE_INK)
    })

    it('level 6 — layer 1 with b6 set, over everything', () => {
      const vdp = contested({ l0: 0x40, l1: 0x40, sprite: 0x4f })

      expect(shown(frame(vdp), 0)).toBe(L1_INK)
    })

    it('puts a priority layer 0 over an ordinary layer 1 — 4 beats 3, not 6', () => {
      // Worth pinning because the prose only mentions sprites: "lifts that tile
      // above ordinary sprites". §12's table lifts it above an ordinary layer 1
      // too, and the table is the specification.
      const vdp = contested({ l0: 0x40 })
      poke(vdp, SPRITE_TABLE, [0xd0])
      expect(shown(frame(vdp), 0)).toBe(L0_INK)

      const raised = contested({ l0: 0x40, l1: 0x40 })
      poke(raised, SPRITE_TABLE, [0xd0])
      expect(shown(frame(raised), 0)).toBe(L1_INK)
    })

    it('puts a priority sprite under a priority layer 1 — 5 beats 3, not 6', () => {
      const vdp = contested({ l1: 0x40, sprite: 0x4f })

      expect(shown(frame(vdp), 0)).toBe(L1_INK)
    })

    it('resolves the default arrangement back to front: L0, sprites, L1', () => {
      // No priority bit anywhere, the three sources side by side rather than
      // stacked, so the order is read off one line instead of one pixel.
      const vdp = contested()
      poke(vdp, L1.name, [0, 0, 1]) // layer 1 moves to the third cell
      poke(vdp, SPRITE_TABLE, [0x00, 0x08, 0x00, 0x0f]) // sprite in the second

      const indices = frame(vdp)
      expect(shown(indices, 0)).toBe(L0_INK)
      expect(shown(indices, 8)).toBe(SPRITE_INK)
      expect(shown(indices, 16)).toBe(L1_INK)
    })

    it('lets a transparent layer 1 pixel show what is under it', () => {
      const vdp = contested()
      poke(vdp, L1.pattern + 32, [0x20, 0x20, 0x20, 0x20]) // value 0 in pixel 1

      const indices = frame(vdp)
      expect(shown(indices, 0)).toBe(L1_INK)
      expect(shown(indices, 1)).toBe(SPRITE_INK)
    })

    it('occludes everything below an opaque layer 1, LxCTRL b5 (§12)', () => {
      const vdp = contested()
      writeRegister(vdp, 0x1d, control(BPP4, PER_CELL, { opaque: true }))
      poke(vdp, L1.pattern + 32, [0x20, 0x20, 0x20, 0x20]) // value 0 in pixel 1

      // Index 0 opaque means the layer never contributes a transparent pixel,
      // so the sprite under it is gone rather than showing through.
      expect(pixels(frame(vdp), X0, 0, 2)).toEqual([L1_INK, 0x00])
    })

    it('draws nothing from a disabled layer, whatever its priority bits say', () => {
      const vdp = contested({ l1: 0x40 })
      writeRegister(vdp, 0x1d, control(BPP4, PER_CELL, { enabled: false }))

      expect(shown(frame(vdp), 0)).toBe(SPRITE_INK)
    })

    it('keeps sprite-against-sprite priority the table index, under a layer', () => {
      // §10 settles which sprite owns the pixel before §12 is asked anything,
      // so a higher-priority sprite lower down the table still loses the pixel
      // to the sprite above it — and takes its level with it.
      const vdp = contested()
      poke(vdp, SPRITE_TABLE, [0x00, 0x00, 0x00, 0x0f]) // slot 0: ordinary
      poke(vdp, SPRITE_TABLE + 4, [0x00, 0x00, 0x00, 0x4f]) // slot 1: in front
      poke(vdp, SPRITE_TABLE + 8, [0xd0])

      expect(shown(frame(vdp), 0)).toBe(L1_INK)
    })

    it('collides sprites hidden behind a layer — collision is before priority', () => {
      const vdp = contested()
      poke(vdp, SPRITE_TABLE, [0x00, 0x00, 0x00, 0x0f])
      poke(vdp, SPRITE_TABLE + 4, [0x00, 0x00, 0x00, 0x0f])
      poke(vdp, SPRITE_TABLE + 8, [0xd0])
      renderOneFrame(vdp)

      expect(shown(vdp.frameIndices(), 0)).toBe(L1_INK) // both are under layer 1
      expect(vdp.getStatus() & 0x20).toBe(0x20) // and both collided anyway
    })

    it('gives a 1bpp cell no priority bit — b6 is half the foreground nibble', () => {
      const vdp = card()
      solidCell(vdp, L0, { ink: 0x04 }) // $40: foreground 4, background 0
      poke(vdp, SPRITE_PATTERNS, new Array(8).fill(0xff))
      poke(vdp, SPRITE_TABLE, [0x00, 0x00, 0x00, 0x0f])
      poke(vdp, SPRITE_TABLE + 4, [0xd0])

      // If b6 were read as priority here the sprite would be behind the cell.
      expect(shown(frame(vdp), 0)).toBe(SPRITE_INK)
    })
  })

  // ----------------------------------------------------------------
  //  §13's scroll registers
  // ----------------------------------------------------------------

  describe('scrolling (§13)', () => {
    /**
     * A layer whose first row of cells counts 0, 1, 2, … across the map, each
     * cell a solid 1bpp tile of its own colour.
     *
     * Reading a pixel then says which map column is at that screen column, and
     * a pixel inside a cell says how far into it the scroll has gone.
     */
    const ruler = (
      vdp: Video,
      tables: { name: number; attr: number; pattern: number },
      cols: number,
      rows = 1
    ): void => {
      for (let col = 0; col < cols; col++) {
        poke(vdp, tables.pattern + (col + 1) * 8, new Array(8).fill(0xff))
        for (let row = 0; row < rows; row++) {
          poke(vdp, tables.name + row * cols + col, [col + 1])
          // Foreground cycles 1-15: index 0 would be transparent (§8).
          poke(vdp, tables.attr + row * cols + col, [((col % 15) + 1) << 4])
        }
      }
    }

    const inkOf = (col: number): number => (col % 15) + 1

    it('offsets the view into the map by LxSCRX, in pixels', () => {
      const vdp = card()
      ruler(vdp, L0, 32)
      writeRegister(vdp, 0x13, 8) // L0SCRX = 8: one whole cell

      const indices = frame(vdp)
      expect(shown(indices, 0)).toBe(inkOf(1))
      expect(shown(indices, 8)).toBe(inkOf(2))
    })

    it('scrolls by a pixel, not a cell — LxSCRX = 3 splits the first cell', () => {
      const vdp = card()
      ruler(vdp, L0, 32)
      writeRegister(vdp, 0x13, 3)

      const indices = frame(vdp)
      // Five pixels of cell 0's right-hand end, then all eight of cell 1.
      expect(pixels(indices, X0, 0, 5)).toEqual(new Array(5).fill(inkOf(0)))
      expect(pixels(indices, X0 + 5, 0, 8)).toEqual(new Array(8).fill(inkOf(1)))
    })

    it('offsets the view by LxSCRY, per pixel, the same way', () => {
      const vdp = card()
      // A tile whose eight rows are eight different patterns, so a vertical
      // offset inside a cell is visible as which row is on the top line.
      poke(vdp, L0.name, [1])
      poke(vdp, L0.pattern + 8, [0x80, 0x40, 0x20, 0x10, 0x08, 0x04, 0x02, 0x01])
      poke(vdp, L0.attr, [0x10])
      writeRegister(vdp, 0x14, 3) // L0SCRY = 3

      // Screen line 0 shows the tile's row 3: %00010000, a pixel at column 3.
      expect(pixels(frame(vdp), X0, 0, 5)).toEqual([BACKDROP, BACKDROP, BACKDROP, 1, BACKDROP])
    })

    it('wraps X at the map width, which is the picture width (§13)', () => {
      const vdp = card()
      ruler(vdp, L0, 32)
      writeRegister(vdp, 0x13, 248) // 31 cells: the last one is at screen x 0

      const indices = frame(vdp)
      expect(shown(indices, 0)).toBe(inkOf(31))
      expect(shown(indices, 8)).toBe(inkOf(0)) // and the map has come round
      expect(shown(indices, 16)).toBe(inkOf(1))
    })

    it('wraps Y at the map height, which is the picture height (§13)', () => {
      const vdp = card()
      poke(vdp, L0.name, [1]) // cell 0, 0: the top-left of the map
      poke(vdp, L0.pattern + 8, new Array(8).fill(0xff))
      poke(vdp, L0.attr, [0x10])
      writeRegister(vdp, 0x14, 232) // 240 - 8: the map's last cell row

      const indices = frame(vdp)
      expect(shown(indices, 0, 0)).toBe(BACKDROP) // the empty last row
      expect(shown(indices, 0, 8)).toBe(1) // then row 0 comes round
    })

    it('wraps Text mode at 240, not at 256 — the map is the picture (§13)', () => {
      const vdp = card(TEXT)
      writeRegister(vdp, 0x11, L0.attr >> 10) // L0ATTR is a $400 granule outside legacy
      ruler(vdp, L0, 40)
      writeRegister(vdp, 0x13, 240) // one whole map width: back where it started

      // 40 x 6 = 240. A 256-wide map would show cell 2 here instead of cell 0.
      expect(pixel(frame(vdp), 40, 24)).toBe(inkOf(0))
    })

    it('reaches all 320 of Full mode via LxCTRL b6, the ninth bit of LxSCRX', () => {
      const vdp = card(FULL)
      ruler(vdp, L0, 40)
      writeRegister(vdp, 0x15, control(BPP1, PER_CELL, { scrxBit8: true }))
      writeRegister(vdp, 0x13, 312 & 0xff) // with b6 that is 312 — 39 whole cells

      const indices = frame(vdp)
      expect(pixel(indices, 0, 0)).toBe(inkOf(39))
      expect(pixel(indices, 8, 0)).toBe(inkOf(0))
    })

    it('leaves b6 out of the scroll when it is clear, whatever the register says', () => {
      const vdp = card(FULL)
      ruler(vdp, L0, 40)
      writeRegister(vdp, 0x13, 56) // the same low byte, b8 clear

      expect(pixel(frame(vdp), 0, 0)).toBe(inkOf(7))
    })

    it('scrolls the two layers independently', () => {
      const vdp = card()
      ruler(vdp, L0, 32)
      poke(vdp, L1.name + 4, [1]) // one opaque cell of layer 1, at map x 32
      poke(vdp, L1.pattern + 8, new Array(8).fill(0xff))
      poke(vdp, L1.attr + 4, [0xf0])
      writeRegister(vdp, 0x13, 8) // L0SCRX
      writeRegister(vdp, 0x1b, 24) // L1SCRX

      const indices = frame(vdp)
      expect(shown(indices, 0)).toBe(inkOf(1)) // layer 0 moved one cell
      expect(shown(indices, 8)).toBe(0x0f) // layer 1 moved three
    })

    it('scrolls the attribute table with the map, not with the screen', () => {
      const vdp = card()
      ruler(vdp, L0, 32)
      writeRegister(vdp, 0x13, 8)

      // Cell 1's colour byte, not cell 0's, has come to screen column 0 — the
      // attribute is indexed by the map cell the name byte came from.
      expect(shown(frame(vdp), 0)).toBe(inkOf(1))
    })

    it('leaves sprites in screen space — scrolling a layer does not move them', () => {
      const vdp = card()
      poke(vdp, SPRITE_PATTERNS, new Array(32).fill(0xff))
      poke(vdp, SPRITE_TABLE, [0x00, 0x10, 0x00, 0x0f])
      poke(vdp, SPRITE_TABLE + 4, [0xd0])
      writeRegister(vdp, 0x13, 8)
      writeRegister(vdp, 0x1b, 64)

      expect(shown(frame(vdp), 16)).toBe(SPRITE_INK)
    })

    it('draws the same picture at LxSCRX = 0 as at LxSCRX = the map width', () => {
      const at = (scroll: number): Uint8Array => {
        const vdp = card()
        ruler(vdp, L0, 32)
        writeRegister(vdp, 0x13, scroll & 0xff)
        writeRegister(vdp, 0x15, control(BPP1, PER_CELL, { scrxBit8: scroll > 0xff }))
        return Uint8Array.from(frame(vdp))
      }

      expect(at(256)).toEqual(at(0))
    })

    // ----------------------------------------------------------------
    //  Sampled per scanline (§13)
    // ----------------------------------------------------------------

    it('samples the scroll registers per scanline, not per frame', () => {
      const vdp = card()
      ruler(vdp, L0, 32, 30) // every cell row, so the split has picture on both sides

      // Run the frame by hand, changing `L0SCRX` from the scanline compare —
      // which is what a raster split is, and the only way to tell a per-line
      // sample from a per-frame one.
      writeRegister(vdp, 0x0a, 0x02) // IRQEN b1: scanline compare
      writeRegister(vdp, 0x0b, 100) // IRQLINE = display line 100
      writeRegister(vdp, 0x0f, 0x01) // STATSEL_A = STAT1, which acknowledges it

      let bent = false
      for (let cycle = 0; cycle < Math.ceil(1000000 / 60); cycle++) {
        if (vdp.tick(1000000) && !bent) {
          bent = true
          writeRegister(vdp, 0x13, 8) // one cell to the left
          vdp.read(1) // acknowledge, so the handler runs once
        }
      }

      // The compare fires as line 100 begins, when line 101 has already been
      // built; the handler's write, however prompt, reaches line 102 (§3, §14).
      const indices = vdp.frameIndices()
      expect(shown(indices, 0, 101)).toBe(inkOf(0))
      expect(shown(indices, 0, 102)).toBe(inkOf(1))
      expect(bent).toBe(true)
    })

    it("resets both layers' scroll registers to zero (§15)", () => {
      const vdp = new Video()
      for (const register of [0x13, 0x14, 0x1b, 0x1c]) {
        expect(vdp.getRegister(register)).toBe(0x00)
      }
      expect(vdp.getRegister(0x15) & 0x40).toBe(0x00) // L0CTRL b6, the ninth bit
      expect(vdp.getRegister(0x1d) & 0x40).toBe(0x00)
    })
  })
})
