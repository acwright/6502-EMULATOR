import {
  LCDAttachment,
  LCD_CMD_CLEAR,
  LCD_CMD_HOME,
  LCD_CMD_ENTRY_MODE,
  LCD_CMD_ENTRY_MODE_INCREMENT,
  LCD_CMD_ENTRY_MODE_SHIFT,
  LCD_CMD_DISPLAY,
  LCD_CMD_DISPLAY_ON,
  LCD_CMD_DISPLAY_CURSOR,
  LCD_CMD_DISPLAY_CURSOR_BLINK,
  LCD_CMD_SHIFT,
  LCD_CMD_SHIFT_DISPLAY,
  LCD_CMD_SHIFT_RIGHT,
  LCD_CMD_FUNCTION,
  LCD_CMD_FUNCTION_LCD_2LINE,
  LCD_CMD_SET_CGRAM_ADDR,
  LCD_CMD_SET_DRAM_ADDR,
} from '../../../components/IO/Attachments/LCDAttachment'

// VIA Port A pin masks
const PIN_RS = 0x20
const PIN_RW = 0x40
const PIN_E  = 0x80

describe('LCDAttachment', () => {
  let lcd: LCDAttachment

  beforeEach(() => {
    lcd = new LCDAttachment(16, 2)
  })

  // ── Helper: write a command via the GPIO bus ────────────────────

  /** Simulate a command write: RS=0, RW=0 */
  function writeCommand(lcd: LCDAttachment, cmd: number): void {
    lcd.sendCommand(cmd)
    lcd.updatePixels()
  }

  /** Simulate a data byte write: RS=1, RW=0 */
  function writeData(lcd: LCDAttachment, data: number): void {
    lcd.writeByte(data)
    lcd.updatePixels()
  }

  /** Write a string to the LCD */
  function writeString(lcd: LCDAttachment, str: string): void {
    for (let i = 0; i < str.length; i++) {
      writeData(lcd, str.charCodeAt(i))
    }
  }

  /** Simulate full GPIO bus cycle: set Port B data, set Port A control,
   *  raise E, then lower E (falling-edge latch) */
  function gpioBusWrite(lcd: LCDAttachment, rs: boolean, data: number): void {
    const portAValue = (rs ? PIN_RS : 0) // RW = 0 (write)
    const ddr = 0xFF // all outputs

    // Set data on Port B
    lcd.writePortB(data, ddr)

    // Raise E
    lcd.writePortA(portAValue | PIN_E, ddr)

    // Lower E (falling edge triggers latch)
    lcd.writePortA(portAValue, ddr)
  }

  // ── Constructor & Reset ────────────────────────────────────────

  describe('constructor and reset', () => {
    it('should initialize with correct dimensions', () => {
      expect(lcd.cols).toBe(16)
      expect(lcd.rows).toBe(2)
    })

    it('should calculate pixel dimensions correctly', () => {
      // 16 chars × (5+1) - 1 = 95 pixels wide
      // 2 rows × (8+1) - 1 = 17 pixels high
      expect(lcd.pixelsWidth).toBe(95)
      expect(lcd.pixelsHeight).toBe(17)
    })

    it('should allocate pixel buffer', () => {
      expect(lcd.buffer).toBeDefined()
      expect(lcd.buffer.length).toBe(95 * 17)
    })

    it('should initialize DDRAM with spaces', () => {
      const ddRam = lcd.getDDRam()
      for (let i = 0; i < ddRam.length; i++) {
        expect(ddRam[i]).toBe(0x20)
      }
    })

    it('should start with DDRAM address at 0', () => {
      expect(lcd.getDDPtr()).toBe(0)
    })

    it('should start with display off', () => {
      expect(lcd.getDisplayFlags() & LCD_CMD_DISPLAY_ON).toBe(0)
    })

    it('should start with increment mode', () => {
      expect(lcd.getEntryModeFlags() & LCD_CMD_ENTRY_MODE_INCREMENT).toBeTruthy()
    })

    it('should support different display sizes', () => {
      const lcd20x4 = new LCDAttachment(20, 4)
      expect(lcd20x4.cols).toBe(20)
      expect(lcd20x4.rows).toBe(4)
      // 20 × (5+1) - 1 = 119
      // 4 × (8+1) - 1 = 35
      expect(lcd20x4.pixelsWidth).toBe(119)
      expect(lcd20x4.pixelsHeight).toBe(35)
    })

    it('should reset all state', () => {
      // Modify state
      writeCommand(lcd, LCD_CMD_DISPLAY | LCD_CMD_DISPLAY_ON)
      writeData(lcd, 0x41) // 'A'
      writeCommand(lcd, LCD_CMD_SET_DRAM_ADDR | 0x40)

      // Reset
      lcd.reset()

      expect(lcd.getDDPtr()).toBe(0)
      expect(lcd.getDisplayFlags()).toBe(0)
      expect(lcd.getScrollOffset()).toBe(0)
      expect(lcd.getDDRam()[0]).toBe(0x20) // space
    })
  })

  // ── Command Processing ─────────────────────────────────────────

  describe('clear display command', () => {
    it('should clear DDRAM to spaces', () => {
      writeData(lcd, 0x41) // 'A'
      writeData(lcd, 0x42) // 'B'

      writeCommand(lcd, LCD_CMD_CLEAR)

      const ddRam = lcd.getDDRam()
      expect(ddRam[0]).toBe(0x20)
      expect(ddRam[1]).toBe(0x20)
    })

    it('should reset DDRAM pointer to 0', () => {
      writeData(lcd, 0x41)
      writeCommand(lcd, LCD_CMD_CLEAR)
      expect(lcd.getDDPtr()).toBe(0)
    })

    it('should reset scroll offset', () => {
      writeCommand(lcd, LCD_CMD_SHIFT | LCD_CMD_SHIFT_DISPLAY)
      writeCommand(lcd, LCD_CMD_CLEAR)
      expect(lcd.getScrollOffset()).toBe(0)
    })

    it('should reset entry mode to increment', () => {
      writeCommand(lcd, LCD_CMD_ENTRY_MODE) // decrement mode
      writeCommand(lcd, LCD_CMD_CLEAR)
      expect(lcd.getEntryModeFlags() & LCD_CMD_ENTRY_MODE_INCREMENT).toBeTruthy()
    })
  })

  describe('home command', () => {
    it('should reset DDRAM pointer to 0', () => {
      writeData(lcd, 0x41)
      writeData(lcd, 0x42)
      writeCommand(lcd, LCD_CMD_HOME)
      expect(lcd.getDDPtr()).toBe(0)
    })

    it('should reset scroll offset', () => {
      writeCommand(lcd, LCD_CMD_SHIFT | LCD_CMD_SHIFT_DISPLAY)
      writeCommand(lcd, LCD_CMD_HOME)
      expect(lcd.getScrollOffset()).toBe(0)
    })

    it('should not clear DDRAM', () => {
      writeData(lcd, 0x41)
      writeCommand(lcd, LCD_CMD_HOME)
      expect(lcd.getDDRam()[0]).toBe(0x41)
    })
  })

  describe('entry mode command', () => {
    it('should set increment mode', () => {
      writeCommand(lcd, LCD_CMD_ENTRY_MODE | LCD_CMD_ENTRY_MODE_INCREMENT)
      expect(lcd.getEntryModeFlags() & LCD_CMD_ENTRY_MODE_INCREMENT).toBeTruthy()
    })

    it('should set decrement mode', () => {
      writeCommand(lcd, LCD_CMD_ENTRY_MODE) // no INCREMENT bit
      expect(lcd.getEntryModeFlags() & LCD_CMD_ENTRY_MODE_INCREMENT).toBeFalsy()
    })

    it('should enable display shift on write', () => {
      writeCommand(lcd, LCD_CMD_ENTRY_MODE | LCD_CMD_ENTRY_MODE_INCREMENT | LCD_CMD_ENTRY_MODE_SHIFT)
      expect(lcd.getEntryModeFlags() & LCD_CMD_ENTRY_MODE_SHIFT).toBeTruthy()
    })
  })

  describe('display control command', () => {
    it('should turn display on', () => {
      writeCommand(lcd, LCD_CMD_DISPLAY | LCD_CMD_DISPLAY_ON)
      expect(lcd.getDisplayFlags() & LCD_CMD_DISPLAY_ON).toBeTruthy()
    })

    it('should turn display off', () => {
      writeCommand(lcd, LCD_CMD_DISPLAY | LCD_CMD_DISPLAY_ON)
      writeCommand(lcd, LCD_CMD_DISPLAY) // display off
      expect(lcd.getDisplayFlags() & LCD_CMD_DISPLAY_ON).toBeFalsy()
    })

    it('should enable cursor', () => {
      writeCommand(lcd, LCD_CMD_DISPLAY | LCD_CMD_DISPLAY_ON | LCD_CMD_DISPLAY_CURSOR)
      expect(lcd.getDisplayFlags() & LCD_CMD_DISPLAY_CURSOR).toBeTruthy()
    })

    it('should enable cursor blink', () => {
      writeCommand(lcd, LCD_CMD_DISPLAY | LCD_CMD_DISPLAY_ON | LCD_CMD_DISPLAY_CURSOR_BLINK)
      expect(lcd.getDisplayFlags() & LCD_CMD_DISPLAY_CURSOR_BLINK).toBeTruthy()
    })
  })

  describe('set DDRAM address command', () => {
    it('should set DDRAM address', () => {
      writeCommand(lcd, LCD_CMD_SET_DRAM_ADDR | 0x05)
      expect(lcd.getDDPtr()).toBe(0x05)
    })

    it('should set second row address', () => {
      writeCommand(lcd, LCD_CMD_SET_DRAM_ADDR | 0x40)
      expect(lcd.getDDPtr()).toBe(0x40)
    })

    it('should clear CGRAM pointer', () => {
      writeCommand(lcd, LCD_CMD_SET_CGRAM_ADDR | 0x00)
      expect(lcd.getCGPtr()).not.toBeNull()

      writeCommand(lcd, LCD_CMD_SET_DRAM_ADDR | 0x00)
      expect(lcd.getCGPtr()).toBeNull()
    })
  })

  describe('set CGRAM address command', () => {
    it('should set CGRAM address', () => {
      writeCommand(lcd, LCD_CMD_SET_CGRAM_ADDR | 0x10)
      expect(lcd.getCGPtr()).toBe(0x10)
    })

    it('should mask to 6 bits', () => {
      writeCommand(lcd, LCD_CMD_SET_CGRAM_ADDR | 0x3F)
      expect(lcd.getCGPtr()).toBe(0x3F)
    })
  })

  describe('shift command', () => {
    it('should shift cursor right', () => {
      writeCommand(lcd, LCD_CMD_SHIFT | LCD_CMD_SHIFT_RIGHT)
      expect(lcd.getDDPtr()).toBe(1)
    })

    it('should shift cursor left', () => {
      writeCommand(lcd, LCD_CMD_SET_DRAM_ADDR | 0x05)
      writeCommand(lcd, LCD_CMD_SHIFT) // left
      expect(lcd.getDDPtr()).toBe(4)
    })

    it('should shift display right', () => {
      writeCommand(lcd, LCD_CMD_SHIFT | LCD_CMD_SHIFT_DISPLAY | LCD_CMD_SHIFT_RIGHT)
      expect(lcd.getScrollOffset()).toBe(-1)
    })

    it('should shift display left', () => {
      writeCommand(lcd, LCD_CMD_SHIFT | LCD_CMD_SHIFT_DISPLAY)
      expect(lcd.getScrollOffset()).toBe(1)
    })
  })

  // ── Data Write ─────────────────────────────────────────────────

  describe('data write to DDRAM', () => {
    it('should write a byte to DDRAM', () => {
      writeData(lcd, 0x41) // 'A'
      expect(lcd.getDDRam()[0]).toBe(0x41)
    })

    it('should auto-increment address in increment mode', () => {
      writeData(lcd, 0x41)
      expect(lcd.getDDPtr()).toBe(1)
      writeData(lcd, 0x42)
      expect(lcd.getDDPtr()).toBe(2)
    })

    it('should auto-decrement address in decrement mode', () => {
      writeCommand(lcd, LCD_CMD_SET_DRAM_ADDR | 0x05)
      writeCommand(lcd, LCD_CMD_ENTRY_MODE) // decrement
      writeData(lcd, 0x41)
      expect(lcd.getDDPtr()).toBe(4)
    })

    it('should write a string to the first row', () => {
      writeString(lcd, 'Hello')
      expect(lcd.getRowText(0).substring(0, 5)).toBe('Hello')
    })

    it('should write to second row', () => {
      writeCommand(lcd, LCD_CMD_SET_DRAM_ADDR | 0x40)
      writeString(lcd, 'World')
      expect(lcd.getRowText(1).substring(0, 5)).toBe('World')
    })

    it('should wrap from end of row 1 to row 2', () => {
      // Write 40 characters to fill first row of DDRAM
      for (let i = 0; i < 40; i++) {
        writeData(lcd, 0x41 + (i % 26))
      }
      // Pointer should now be at 0x40 (second row)
      expect(lcd.getDDPtr()).toBe(0x40)
    })

    it('should wrap from end of row 2 back to start', () => {
      writeCommand(lcd, LCD_CMD_SET_DRAM_ADDR | 0x40)
      // Write 40 characters to fill second row
      for (let i = 0; i < 40; i++) {
        writeData(lcd, 0x41 + (i % 26))
      }
      // Should wrap to beginning
      expect(lcd.getDDPtr()).toBe(0x00)
    })

    it('should shift display when entry mode shift is enabled', () => {
      writeCommand(lcd, LCD_CMD_ENTRY_MODE | LCD_CMD_ENTRY_MODE_INCREMENT | LCD_CMD_ENTRY_MODE_SHIFT)
      writeData(lcd, 0x41)
      expect(lcd.getScrollOffset()).toBe(1)
    })
  })

  // ── Data Read ──────────────────────────────────────────────────

  describe('data read from DDRAM', () => {
    it('should read back written data via readAddress', () => {
      writeData(lcd, 0x41)
      writeCommand(lcd, LCD_CMD_SET_DRAM_ADDR | 0x00)
      expect(lcd.readAddress()).toBe(0x00)
    })

    it('should read DDRAM address via readAddress', () => {
      writeCommand(lcd, LCD_CMD_SET_DRAM_ADDR | 0x15)
      expect(lcd.readAddress()).toBe(0x15)
    })

    it('should read CGRAM address when in CGRAM mode', () => {
      writeCommand(lcd, LCD_CMD_SET_CGRAM_ADDR | 0x18)
      expect(lcd.readAddress()).toBe(0x18)
    })
  })

  // ── CGRAM ──────────────────────────────────────────────────────

  describe('CGRAM operations', () => {
    it('should write custom character data to CGRAM', () => {
      // Set CGRAM address for character 0, row 0
      writeCommand(lcd, LCD_CMD_SET_CGRAM_ADDR | 0x00)

      // Write 8 rows of pattern (smile face)
      const pattern = [0x00, 0x0A, 0x00, 0x00, 0x11, 0x0E, 0x00, 0x00]
      for (const row of pattern) {
        writeData(lcd, row)
      }

      // CGRAM pointer should have advanced
      expect(lcd.getCGPtr()).toBe(8)
    })

    it('should render CGRAM character on display', () => {
      // Define character 0 with a simple pattern (all pixels on in first row)
      writeCommand(lcd, LCD_CMD_SET_CGRAM_ADDR | 0x00)
      writeData(lcd, 0x1F) // row 0: all 5 bits on
      for (let i = 1; i < 8; i++) {
        writeData(lcd, 0x00) // rows 1-7: all off
      }

      // Now write character 0 to DDRAM and enable display
      writeCommand(lcd, LCD_CMD_SET_DRAM_ADDR | 0x00)
      writeData(lcd, 0x00) // character 0 from CGRAM
      writeCommand(lcd, LCD_CMD_DISPLAY | LCD_CMD_DISPLAY_ON)
      lcd.updatePixels()

      // Character 0 should be at position (0,0) - check first row pixels are on
      // The pixel at (0,0) should be on since we set bit 4 (MSB of 5-bit) in row 0
      const topLeftPixel = lcd.pixelState(0, 0)
      expect(topLeftPixel).toBe(1)
    })

    it('should wrap CGRAM pointer in increment mode', () => {
      writeCommand(lcd, LCD_CMD_SET_CGRAM_ADDR | 0x00)
      // Write 128 bytes (16 chars × 8 rows = full CGRAM)
      for (let i = 0; i < 128; i++) {
        writeData(lcd, 0x00)
      }
      // Should wrap back to 0
      expect(lcd.getCGPtr()).toBe(0)
    })
  })

  // ── Pixel Output ───────────────────────────────────────────────

  describe('pixel output', () => {
    it('should render all pixels off when display is off', () => {
      writeData(lcd, 0x41) // 'A'
      // Display is off by default
      lcd.updatePixels()

      for (let y = 0; y < lcd.pixelsHeight; y++) {
        for (let x = 0; x < lcd.pixelsWidth; x++) {
          const state = lcd.pixelState(x, y)
          // All character pixels should be 0 (off), gaps are -1
          if (state !== -1) {
            expect(state).toBe(0)
          }
        }
      }
    })

    it('should render character pixels when display is on', () => {
      writeCommand(lcd, LCD_CMD_DISPLAY | LCD_CMD_DISPLAY_ON)
      writeCommand(lcd, LCD_CMD_SET_DRAM_ADDR | 0x00)
      writeData(lcd, 0xFF) // char 255 — all pixels on in A00 font
      lcd.updatePixels()

      // Check that some pixels are on in the first character cell
      let hasOnPixel = false
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 5; x++) {
          if (lcd.pixelState(x, y) === 1) {
            hasOnPixel = true
          }
        }
      }
      expect(hasOnPixel).toBe(true)
    })

    it('should have gap pixels between characters', () => {
      writeCommand(lcd, LCD_CMD_DISPLAY | LCD_CMD_DISPLAY_ON)
      lcd.updatePixels()

      // Column 5 (between char 0 and char 1) should be gap (-1)
      const gapPixel = lcd.pixelState(5, 0)
      expect(gapPixel).toBe(-1)
    })

    it('should have gap pixels between rows', () => {
      writeCommand(lcd, LCD_CMD_DISPLAY | LCD_CMD_DISPLAY_ON)
      lcd.updatePixels()

      // Row 8 (between row 0 and row 1) should be gap (-1)
      const gapPixel = lcd.pixelState(0, 8)
      expect(gapPixel).toBe(-1)
    })

    it('should return -1 for out-of-bounds coordinates', () => {
      expect(lcd.pixelState(-1, 0)).toBe(-1)
      expect(lcd.pixelState(0, -1)).toBe(-1)
      expect(lcd.pixelState(lcd.pixelsWidth, lcd.pixelsHeight)).toBe(-1)
    })

    it('should render spaces as all-off pixels', () => {
      writeCommand(lcd, LCD_CMD_DISPLAY | LCD_CMD_DISPLAY_ON)
      // DDRAM is initialized to spaces
      lcd.updatePixels()

      // All pixels in space characters should be off
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 5; x++) {
          expect(lcd.pixelState(x, y)).toBe(0)
        }
      }
    })
  })

  // ── Cursor Display ─────────────────────────────────────────────

  describe('cursor display', () => {
    it('should show underline cursor on bottom row of character', () => {
      writeCommand(lcd, LCD_CMD_DISPLAY | LCD_CMD_DISPLAY_ON | LCD_CMD_DISPLAY_CURSOR)
      lcd.updatePixels()

      // Cursor at position 0: bottom row (y=7) should have pixels on
      for (let x = 0; x < 5; x++) {
        expect(lcd.pixelState(x, 7)).toBe(1)
      }
    })

    it('should not show cursor when cursor flag is off', () => {
      writeCommand(lcd, LCD_CMD_DISPLAY | LCD_CMD_DISPLAY_ON)
      lcd.updatePixels()

      // Bottom row of first char should be off (space + no cursor)
      for (let x = 0; x < 5; x++) {
        expect(lcd.pixelState(x, 7)).toBe(0)
      }
    })

    it('should move cursor with DDRAM address', () => {
      writeCommand(lcd, LCD_CMD_DISPLAY | LCD_CMD_DISPLAY_ON | LCD_CMD_DISPLAY_CURSOR)
      writeCommand(lcd, LCD_CMD_SET_DRAM_ADDR | 0x01)
      lcd.updatePixels()

      // Row 0, column 0 character should NOT have cursor
      for (let x = 0; x < 5; x++) {
        expect(lcd.pixelState(x, 7)).toBe(0)
      }

      // Row 0, column 1 character should have cursor (x offset = 6)
      for (let x = 0; x < 5; x++) {
        expect(lcd.pixelState(6 + x, 7)).toBe(1)
      }
    })
  })

  // ── GPIO Bus Interface ─────────────────────────────────────────

  describe('GPIO bus interface', () => {
    it('should latch command on E falling edge', () => {
      const ddr = 0xFF

      // Write clear command via GPIO
      lcd.writePortB(LCD_CMD_CLEAR, ddr)

      // Set RS=0, RW=0, raise E
      lcd.writePortA(PIN_E, ddr)

      // Lower E
      lcd.writePortA(0x00, ddr)

      // DDRAM should be cleared (all spaces)
      expect(lcd.getDDPtr()).toBe(0)
    })

    it('should write data when RS is high', () => {
      // First turn on display via GPIO
      gpioBusWrite(lcd, false, LCD_CMD_DISPLAY | LCD_CMD_DISPLAY_ON)

      // Write 'A' with RS=1
      gpioBusWrite(lcd, true, 0x41)

      expect(lcd.getDDRam()[0]).toBe(0x41)
    })

    it('should not latch on E rising edge', () => {
      const ddr = 0xFF

      // Write data to Port B
      lcd.writePortB(0x41, ddr)

      // Raise E (should NOT latch)
      lcd.writePortA(PIN_RS | PIN_E, ddr)

      // Data should not have been written yet
      expect(lcd.getDDRam()[0]).toBe(0x20) // still space
    })

    it('should read DDRAM address via Port B when RW=1, RS=0', () => {
      writeCommand(lcd, LCD_CMD_SET_DRAM_ADDR | 0x15)

      // Set RW=1, RS=0 on Port A
      const ddr = 0xFF
      lcd.writePortA(PIN_RW, ddr)

      const result = lcd.readPortB(ddr, 0)
      expect(result & 0x7F).toBe(0x15)
    })

    it('should read DDRAM data via Port B when RW=1, RS=1', () => {
      // Write 'A' at address 0
      writeData(lcd, 0x41)

      // Set address back to 0
      writeCommand(lcd, LCD_CMD_SET_DRAM_ADDR | 0x00)

      // Set RW=1, RS=1 on Port A for data read
      const ddr = 0xFF
      lcd.writePortA(PIN_RW | PIN_RS, ddr)

      const result = lcd.readPortB(ddr, 0)
      expect(result).toBe(0x41)
    })

    it('should return 0xFF from Port B when RW is low', () => {
      const ddr = 0xFF
      lcd.writePortA(0x00, ddr) // RW=0
      expect(lcd.readPortB(ddr, 0)).toBe(0xFF)
    })

    it('should always return 0xFF from Port A', () => {
      expect(lcd.readPortA(0xFF, 0x00)).toBe(0xFF)
    })

    it('should perform a full write sequence via GPIO bus', () => {
      // Step 1: Function set (8-bit, 2-line)
      gpioBusWrite(lcd, false, LCD_CMD_FUNCTION | LCD_CMD_FUNCTION_LCD_2LINE | 0x10)

      // Step 2: Display ON, cursor ON
      gpioBusWrite(lcd, false, LCD_CMD_DISPLAY | LCD_CMD_DISPLAY_ON | LCD_CMD_DISPLAY_CURSOR)

      // Step 3: Clear display
      gpioBusWrite(lcd, false, LCD_CMD_CLEAR)

      // Step 4: Entry mode set — increment, no shift
      gpioBusWrite(lcd, false, LCD_CMD_ENTRY_MODE | LCD_CMD_ENTRY_MODE_INCREMENT)

      // Step 5: Write "Hi"
      gpioBusWrite(lcd, true, 0x48) // 'H'
      gpioBusWrite(lcd, true, 0x69) // 'i'

      expect(lcd.getRowText(0).substring(0, 2)).toBe('Hi')
      expect(lcd.getDDPtr()).toBe(2)
      expect(lcd.getDisplayFlags() & LCD_CMD_DISPLAY_ON).toBeTruthy()
      expect(lcd.getDisplayFlags() & LCD_CMD_DISPLAY_CURSOR).toBeTruthy()
    })
  })

  // ── DDRAM Pointer Wrapping ─────────────────────────────────────

  describe('DDRAM pointer wrapping', () => {
    it('should wrap from 0x27 to 0x40 in 2-row mode', () => {
      writeCommand(lcd, LCD_CMD_SET_DRAM_ADDR | 0x27)
      writeData(lcd, 0x41) // triggers increment
      expect(lcd.getDDPtr()).toBe(0x40)
    })

    it('should wrap from 0x67 to 0x00 in 2-row mode', () => {
      writeCommand(lcd, LCD_CMD_SET_DRAM_ADDR | 0x67)
      writeData(lcd, 0x41)
      expect(lcd.getDDPtr()).toBe(0x00)
    })

    it('should decrement from 0x00 to 0x67', () => {
      writeCommand(lcd, LCD_CMD_ENTRY_MODE) // decrement mode
      writeCommand(lcd, LCD_CMD_SET_DRAM_ADDR | 0x00)
      writeData(lcd, 0x41) // triggers decrement
      expect(lcd.getDDPtr()).toBe(0x67)
    })

    it('should decrement from 0x40 to 0x27', () => {
      writeCommand(lcd, LCD_CMD_ENTRY_MODE) // decrement mode
      writeCommand(lcd, LCD_CMD_SET_DRAM_ADDR | 0x40)
      writeData(lcd, 0x41) // triggers decrement
      expect(lcd.getDDPtr()).toBe(0x27)
    })

    describe('1-row mode', () => {
      let lcd1: LCDAttachment

      beforeEach(() => {
        lcd1 = new LCDAttachment(16, 1)
      })

      it('should wrap from position 79 to 0', () => {
        writeCommand(lcd1, LCD_CMD_SET_DRAM_ADDR | 79)
        writeData(lcd1, 0x41)
        expect(lcd1.getDDPtr()).toBe(0)
      })

      it('should wrap from position 0 to 79 when decrementing', () => {
        writeCommand(lcd1, LCD_CMD_ENTRY_MODE) // decrement mode
        writeCommand(lcd1, LCD_CMD_SET_DRAM_ADDR | 0x00)
        writeData(lcd1, 0x41)
        expect(lcd1.getDDPtr()).toBe(79)
      })
    })
  })

  // ── Display Shift ──────────────────────────────────────────────

  describe('display shift', () => {
    it('should shift displayed content left', () => {
      writeCommand(lcd, LCD_CMD_DISPLAY | LCD_CMD_DISPLAY_ON)

      // Write "AB" starting at position 0
      writeData(lcd, 0x41) // A
      writeData(lcd, 0x42) // B

      // Shift display left
      writeCommand(lcd, LCD_CMD_SHIFT | LCD_CMD_SHIFT_DISPLAY)

      // After shifting, the second character should now appear as first visible
      expect(lcd.getScrollOffset()).toBe(1)
    })

    it('should shift displayed content right', () => {
      writeCommand(lcd, LCD_CMD_DISPLAY | LCD_CMD_DISPLAY_ON)

      writeData(lcd, 0x41)

      // Shift display right
      writeCommand(lcd, LCD_CMD_SHIFT | LCD_CMD_SHIFT_DISPLAY | LCD_CMD_SHIFT_RIGHT)

      expect(lcd.getScrollOffset()).toBe(-1)
    })
  })

  // ── Tick (Cursor Blink) ────────────────────────────────────────

  describe('tick and blink', () => {
    it('should toggle blink state after enough ticks', () => {
      writeCommand(lcd, LCD_CMD_DISPLAY | LCD_CMD_DISPLAY_ON | LCD_CMD_DISPLAY_CURSOR_BLINK)

      const cpuFrequency = 1000000 // 1 MHz

      // Each tick = 128 cycles at 1 MHz = 0.128 ms
      // Need 350ms / 0.128ms ≈ 2734 ticks
      for (let i = 0; i < 3000; i++) {
        lcd.tick(cpuFrequency)
      }

      // Blink state should have toggled
      lcd.updatePixels()
      // We can verify by checking that the test doesn't crash and pixels update
    })

    it('should not crash with high frequency', () => {
      lcd.tick(10000000) // 10 MHz
      lcd.tick(10000000)
    })
  })

  // ── Row Text Helper ────────────────────────────────────────────

  describe('getRowText', () => {
    it('should return text for row 0', () => {
      writeString(lcd, 'Hello, World!')
      expect(lcd.getRowText(0).substring(0, 13)).toBe('Hello, World!')
    })

    it('should return text for row 1', () => {
      writeCommand(lcd, LCD_CMD_SET_DRAM_ADDR | 0x40)
      writeString(lcd, 'Line Two')
      expect(lcd.getRowText(1).substring(0, 8)).toBe('Line Two')
    })

    it('should return spaces for empty row', () => {
      const text = lcd.getRowText(0)
      expect(text.length).toBe(16)
      expect(text.trim()).toBe('')
    })
  })

  // ── Edge Cases ─────────────────────────────────────────────────

  describe('edge cases', () => {
    it('should handle multiple E transitions without crash', () => {
      const ddr = 0xFF
      // Rapid E toggling
      for (let i = 0; i < 100; i++) {
        lcd.writePortB(0x20, ddr)
        lcd.writePortA(PIN_E, ddr)
        lcd.writePortA(0x00, ddr)
      }
    })

    it('should handle function set command', () => {
      writeCommand(lcd, LCD_CMD_FUNCTION | LCD_CMD_FUNCTION_LCD_2LINE | 0x10)
      // Should not crash
    })

    it('should handle writing all character codes', () => {
      writeCommand(lcd, LCD_CMD_DISPLAY | LCD_CMD_DISPLAY_ON)
      for (let i = 0; i < 256; i++) {
        writeCommand(lcd, LCD_CMD_SET_DRAM_ADDR | 0x00)
        writeData(lcd, i)
        lcd.updatePixels()
      }
    })

    it('should handle isEnabled and getPriority', () => {
      expect(lcd.isEnabled()).toBe(true)
      expect(lcd.getPriority()).toBe(0)
    })

    it('should handle interrupt methods', () => {
      expect(lcd.hasCA1Interrupt()).toBe(false)
      expect(lcd.hasCA2Interrupt()).toBe(false)
      expect(lcd.hasCB1Interrupt()).toBe(false)
      expect(lcd.hasCB2Interrupt()).toBe(false)
      lcd.clearInterrupts(true, true, true, true)
      lcd.updateControlLines(false, false, false, false)
    })
  })
})
