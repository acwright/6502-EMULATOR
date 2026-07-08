import { KeyboardEncoderAttachment } from '../../../core/IO/Attachments/KeyboardEncoderAttachment'

describe('KeyboardEncoderAttachment', () => {
  let encoder: KeyboardEncoderAttachment

  beforeEach(() => {
    encoder = new KeyboardEncoderAttachment(5)
    encoder.activePort = 'both' // Enable both ports for testing
  })

  describe('Initialization', () => {
    it('should default to Port B only', () => {
      const fresh = new KeyboardEncoderAttachment(5)
      expect(fresh.activePort).toBe('B')
    })

    it('should initialize with no data ready', () => {
      expect(encoder.hasDataReadyA()).toBe(false)
      expect(encoder.hasDataReadyB()).toBe(false)
    })

    it('should initialize with no interrupts pending', () => {
      expect(encoder.hasCA1Interrupt()).toBe(false)
      expect(encoder.hasCB1Interrupt()).toBe(false)
    })

    it('should be disabled by default (CA2/CB2 high)', () => {
      encoder.updateControlLines(false, true, false, true)
      encoder.updateKey(0x04, true)  // 'A'
      expect(encoder.hasCA1Interrupt()).toBe(false)
      expect(encoder.hasCB1Interrupt()).toBe(false)
    })

    it('should have correct priority', () => {
      expect(encoder.getPriority()).toBe(5)
    })
  })

  describe('Reset', () => {
    it('should clear all data and states', () => {
      encoder.updateControlLines(false, false, false, false)
      encoder.updateKey(0x04, true)  // 'A'
      expect(encoder.hasDataReadyA()).toBe(true)

      encoder.reset()
      expect(encoder.hasDataReadyA()).toBe(false)
      expect(encoder.hasDataReadyB()).toBe(false)
      expect(encoder.hasCA1Interrupt()).toBe(false)
      expect(encoder.hasCB1Interrupt()).toBe(false)
    })

    it('should clear modifier states on reset', () => {
      encoder.updateControlLines(false, false, false, false)
      // Press Shift, then reset
      encoder.updateKey(0xE1, true)  // Left Shift down
      encoder.reset()
      encoder.updateControlLines(false, false, false, false)
      // After reset, Shift should be released - numbers produce numbers, not symbols
      encoder.updateKey(0x1E, true)  // '1'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x31)  // '1', not '!'
    })
  })

  describe('Enable/Disable Control', () => {
    it('should enable Port A when CA2 is LOW', () => {
      encoder.updateControlLines(false, false, false, true)
      encoder.updateKey(0x04, true)  // 'A'
      expect(encoder.hasCA1Interrupt()).toBe(true)
      expect(encoder.hasCB1Interrupt()).toBe(false)
    })

    it('should enable Port B when CB2 is LOW', () => {
      encoder.updateControlLines(false, true, false, false)
      encoder.updateKey(0x04, true)  // 'A'
      expect(encoder.hasCA1Interrupt()).toBe(false)
      expect(encoder.hasCB1Interrupt()).toBe(true)
    })

    it('should enable both ports when both CA2 and CB2 are LOW', () => {
      encoder.updateControlLines(false, false, false, false)
      encoder.updateKey(0x04, true)  // 'A'
      expect(encoder.hasCA1Interrupt()).toBe(true)
      expect(encoder.hasCB1Interrupt()).toBe(true)
    })

    it('should disable Port A when CA2 is HIGH', () => {
      encoder.updateControlLines(false, true, false, false)
      encoder.updateKey(0x04, true)  // 'A'
      expect(encoder.hasCA1Interrupt()).toBe(false)
    })

    it('should disable Port B when CB2 is HIGH', () => {
      encoder.updateControlLines(false, false, false, true)
      encoder.updateKey(0x04, true)  // 'A'
      expect(encoder.hasCB1Interrupt()).toBe(false)
    })
  })

  describe('Port Reading', () => {
    it('should return 0xFF when no data ready on Port A', () => {
      const value = encoder.readPortA(0xFF, 0x00)
      expect(value).toBe(0xFF)
    })

    it('should return 0xFF when no data ready on Port B', () => {
      const value = encoder.readPortB(0xFF, 0x00)
      expect(value).toBe(0xFF)
    })

    it('should return ASCII data when data ready on Port A', () => {
      encoder.updateControlLines(false, false, false, false)
      encoder.updateKey(0x04, true)  // 'A' = 0x41
      const value = encoder.readPortA(0xFF, 0x00)
      expect(value).toBe(0x41)
    })

    it('should return ASCII data when data ready on Port B', () => {
      encoder.updateControlLines(false, false, false, false)
      encoder.updateKey(0x04, true)  // 'A' = 0x41
      const value = encoder.readPortB(0xFF, 0x00)
      expect(value).toBe(0x41)
    })

    it('should return 0xFF on disabled port even with data ready', () => {
      encoder.updateControlLines(false, true, false, true)  // Both disabled
      encoder.updateKey(0x04, true)  // 'A'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0xFF)
      expect(encoder.readPortB(0xFF, 0x00)).toBe(0xFF)
    })

    it('should provide same data on both ports', () => {
      encoder.updateControlLines(false, false, false, false)
      encoder.updateKey(0x04, true)  // 'A'
      const valueA = encoder.readPortA(0xFF, 0x00)
      const valueB = encoder.readPortB(0xFF, 0x00)
      expect(valueA).toBe(valueB)
      expect(valueA).toBe(0x41)
    })
  })

  describe('Interrupt Handling', () => {
    it('should trigger CA1 interrupt when Port A enabled and key pressed', () => {
      encoder.updateControlLines(false, false, false, true)
      expect(encoder.hasCA1Interrupt()).toBe(false)
      encoder.updateKey(0x04, true)  // 'A'
      expect(encoder.hasCA1Interrupt()).toBe(true)
    })

    it('should trigger CB1 interrupt when Port B enabled and key pressed', () => {
      encoder.updateControlLines(false, true, false, false)
      expect(encoder.hasCB1Interrupt()).toBe(false)
      encoder.updateKey(0x04, true)  // 'A'
      expect(encoder.hasCB1Interrupt()).toBe(true)
    })

    it('should clear CA1 interrupt and data ready when cleared', () => {
      encoder.updateControlLines(false, false, false, false)
      encoder.updateKey(0x04, true)  // 'A'
      expect(encoder.hasCA1Interrupt()).toBe(true)
      expect(encoder.hasDataReadyA()).toBe(true)

      encoder.clearInterrupts(true, false, false, false)
      expect(encoder.hasCA1Interrupt()).toBe(false)
      expect(encoder.hasDataReadyA()).toBe(false)
    })

    it('should clear CB1 interrupt and data ready when cleared', () => {
      encoder.updateControlLines(false, false, false, false)
      encoder.updateKey(0x04, true)  // 'A'
      expect(encoder.hasCB1Interrupt()).toBe(true)
      expect(encoder.hasDataReadyB()).toBe(true)

      encoder.clearInterrupts(false, false, true, false)
      expect(encoder.hasCB1Interrupt()).toBe(false)
      expect(encoder.hasDataReadyB()).toBe(false)
    })

    it('should not trigger interrupt when port is disabled', () => {
      encoder.updateControlLines(false, true, false, true)  // Both disabled
      encoder.updateKey(0x04, true)  // 'A'
      expect(encoder.hasCA1Interrupt()).toBe(false)
      expect(encoder.hasCB1Interrupt()).toBe(false)
    })
  })

  describe('Letter Key Mapping', () => {
    beforeEach(() => {
      encoder.updateControlLines(false, false, false, false)
    })

    it('should output uppercase letters A-Z', () => {
      // 'A' (HID 0x04)
      encoder.updateKey(0x04, true)
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x41)

      encoder.clearInterrupts(true, false, true, false)
      // 'Z' (HID 0x1D)
      encoder.updateKey(0x1D, true)
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x5A)
    })

    it('should output uppercase letters even with Shift held', () => {
      encoder.updateKey(0xE1, true)  // Left Shift down
      encoder.updateKey(0x04, true)  // 'A'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x41)  // Still uppercase A

      encoder.clearInterrupts(true, false, true, false)
      encoder.updateKey(0x10, true)  // 'M'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x4D)  // Still uppercase M
    })

    it('should map all letters correctly', () => {
      const letterMap: [number, number][] = [
        [0x04, 0x41], [0x05, 0x42], [0x06, 0x43], [0x07, 0x44],
        [0x08, 0x45], [0x09, 0x46], [0x0A, 0x47], [0x0B, 0x48],
        [0x0C, 0x49], [0x0D, 0x4A], [0x0E, 0x4B], [0x0F, 0x4C],
        [0x10, 0x4D], [0x11, 0x4E], [0x12, 0x4F], [0x13, 0x50],
        [0x14, 0x51], [0x15, 0x52], [0x16, 0x53], [0x17, 0x54],
        [0x18, 0x55], [0x19, 0x56], [0x1A, 0x57], [0x1B, 0x58],
        [0x1C, 0x59], [0x1D, 0x5A],
      ]
      for (const [hid, ascii] of letterMap) {
        encoder.clearInterrupts(true, false, true, false)
        encoder.updateKey(hid, true)
        expect(encoder.readPortA(0xFF, 0x00)).toBe(ascii)
      }
    })
  })

  describe('Number Key Mapping', () => {
    beforeEach(() => {
      encoder.updateControlLines(false, false, false, false)
    })

    it('should map numbers correctly', () => {
      encoder.updateKey(0x1E, true)  // '1'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x31)

      encoder.clearInterrupts(true, false, true, false)
      encoder.updateKey(0x27, true)  // '0'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x30)
    })

    it('should map all number keys 0-9', () => {
      const numberMap: [number, number][] = [
        [0x1E, 0x31], [0x1F, 0x32], [0x20, 0x33], [0x21, 0x34],
        [0x22, 0x35], [0x23, 0x36], [0x24, 0x37], [0x25, 0x38],
        [0x26, 0x39], [0x27, 0x30],
      ]
      for (const [hid, ascii] of numberMap) {
        encoder.clearInterrupts(true, false, true, false)
        encoder.updateKey(hid, true)
        expect(encoder.readPortA(0xFF, 0x00)).toBe(ascii)
      }
    })
  })

  describe('Special Key Mapping', () => {
    beforeEach(() => {
      encoder.updateControlLines(false, false, false, false)
    })

    it('should map Enter to CR (0x0D)', () => {
      encoder.updateKey(0x28, true)
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x0D)
    })

    it('should map Escape to ESC (0x1B)', () => {
      encoder.updateKey(0x29, true)
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x1B)
    })

    it('should map Backspace to BS (0x08)', () => {
      encoder.updateKey(0x2A, true)
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x08)
    })

    it('should map Tab to HT (0x09)', () => {
      encoder.updateKey(0x2B, true)
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x09)
    })

    it('should map Space to SP (0x20)', () => {
      encoder.updateKey(0x2C, true)
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x20)
    })

    it('should map Delete to DEL (0x7F)', () => {
      encoder.updateKey(0x4C, true)
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x7F)
    })

    it('should map Insert to SUB (0x1A)', () => {
      encoder.updateKey(0x49, true)
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x1A)
    })

    it('should map arrow keys correctly', () => {
      encoder.updateKey(0x4F, true)  // Right Arrow
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x1D)

      encoder.clearInterrupts(true, false, true, false)
      encoder.updateKey(0x50, true)  // Left Arrow
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x1C)

      encoder.clearInterrupts(true, false, true, false)
      encoder.updateKey(0x51, true)  // Down Arrow
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x1F)

      encoder.clearInterrupts(true, false, true, false)
      encoder.updateKey(0x52, true)  // Up Arrow
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x1E)
    })

    it('should map symbol keys correctly', () => {
      const symbolMap: [number, number][] = [
        [0x2D, 0x2D], // -
        [0x2E, 0x3D], // =
        [0x2F, 0x5B], // [
        [0x30, 0x5D], // ]
        [0x31, 0x5C], // backslash
        [0x33, 0x3B], // ;
        [0x34, 0x27], // '
        [0x35, 0x60], // `
        [0x36, 0x2C], // ,
        [0x37, 0x2E], // .
        [0x38, 0x2F], // /
      ]
      for (const [hid, ascii] of symbolMap) {
        encoder.clearInterrupts(true, false, true, false)
        encoder.updateKey(hid, true)
        expect(encoder.readPortA(0xFF, 0x00)).toBe(ascii)
      }
    })
  })

  describe('Shift Key Mapping', () => {
    beforeEach(() => {
      encoder.updateControlLines(false, false, false, false)
      encoder.updateKey(0xE1, true)  // Left Shift down
    })

    it('should produce shifted number symbols', () => {
      const shiftNumberMap: [number, number][] = [
        [0x1E, 0x21], // '1' -> '!'
        [0x1F, 0x40], // '2' -> '@'
        [0x20, 0x23], // '3' -> '#'
        [0x21, 0x24], // '4' -> '$'
        [0x22, 0x25], // '5' -> '%'
        [0x23, 0x5E], // '6' -> '^'
        [0x24, 0x26], // '7' -> '&'
        [0x25, 0x2A], // '8' -> '*'
        [0x26, 0x28], // '9' -> '('
        [0x27, 0x29], // '0' -> ')'
      ]
      for (const [hid, ascii] of shiftNumberMap) {
        encoder.clearInterrupts(true, false, true, false)
        encoder.updateKey(hid, true)
        expect(encoder.readPortA(0xFF, 0x00)).toBe(ascii)
      }
    })

    it('should produce shifted symbol keys', () => {
      const shiftSymbolMap: [number, number][] = [
        [0x2D, 0x5F], // '-' -> '_'
        [0x2E, 0x2B], // '=' -> '+'
        [0x2F, 0x7B], // '[' -> '{'
        [0x30, 0x7D], // ']' -> '}'
        [0x31, 0x7C], // '\\' -> '|'
        [0x33, 0x3A], // ';' -> ':'
        [0x34, 0x22], // '\'' -> '"'
        [0x36, 0x3C], // ',' -> '<'
        [0x37, 0x3E], // '.' -> '>'
        [0x38, 0x3F], // '/' -> '?'
        [0x35, 0x7E], // '`' -> '~'
      ]
      for (const [hid, ascii] of shiftSymbolMap) {
        encoder.clearInterrupts(true, false, true, false)
        encoder.updateKey(hid, true)
        expect(encoder.readPortA(0xFF, 0x00)).toBe(ascii)
      }
    })

    it('should not change letter output when Shift is held (already uppercase)', () => {
      encoder.updateKey(0x04, true)  // 'A'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x41)  // Still 'A'
    })

    it('should track right Shift the same as left Shift', () => {
      encoder.updateKey(0xE1, false)  // Release left Shift
      encoder.updateKey(0xE5, true)   // Right Shift down
      encoder.updateKey(0x1E, true)   // '1'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x21)  // '!'
    })
  })

  describe('Ctrl Key Mapping', () => {
    beforeEach(() => {
      encoder.updateControlLines(false, false, false, false)
      encoder.updateKey(0xE0, true)  // Left Ctrl down
    })

    it('should produce control codes for Ctrl+A through Ctrl+Z', () => {
      const ctrlLetterMap: [number, number][] = [
        [0x04, 0x01], // Ctrl+A
        [0x05, 0x02], // Ctrl+B
        [0x06, 0x03], // Ctrl+C
        [0x07, 0x04], // Ctrl+D
        [0x08, 0x05], // Ctrl+E
        [0x09, 0x06], // Ctrl+F
        [0x0A, 0x07], // Ctrl+G
        [0x0B, 0x08], // Ctrl+H
        [0x0C, 0x09], // Ctrl+I
        [0x0D, 0x0A], // Ctrl+J
        [0x0E, 0x0B], // Ctrl+K
        [0x0F, 0x0C], // Ctrl+L
        [0x10, 0x0D], // Ctrl+M
        [0x11, 0x0E], // Ctrl+N
        [0x12, 0x0F], // Ctrl+O
        [0x13, 0x10], // Ctrl+P
        [0x14, 0x11], // Ctrl+Q
        [0x15, 0x12], // Ctrl+R
        [0x16, 0x13], // Ctrl+S
        [0x17, 0x14], // Ctrl+T
        [0x18, 0x15], // Ctrl+U
        [0x19, 0x16], // Ctrl+V
        [0x1A, 0x17], // Ctrl+W
        [0x1B, 0x18], // Ctrl+X
        [0x1C, 0x19], // Ctrl+Y
        [0x1D, 0x1A], // Ctrl+Z
      ]
      for (const [hid, ascii] of ctrlLetterMap) {
        encoder.clearInterrupts(true, false, true, false)
        encoder.updateKey(hid, true)
        expect(encoder.readPortA(0xFF, 0x00)).toBe(ascii)
      }
    })

    it('should produce Ctrl+C = 0x03 (BASIC break)', () => {
      encoder.updateKey(0x06, true)  // 'C'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x03)
    })

    it('should produce Ctrl+2 = NUL (0x00)', () => {
      encoder.updateKey(0x1F, true)  // '2'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x00)
    })

    it('should produce Ctrl+6 = RS (0x1E)', () => {
      encoder.updateKey(0x23, true)  // '6'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x1E)
    })

    it('should produce Ctrl+- = US (0x1F)', () => {
      encoder.updateKey(0x2D, true)  // '-'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x1F)
    })

    it('should produce Ctrl+[ = ESC (0x1B)', () => {
      encoder.updateKey(0x2F, true)  // '['
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x1B)
    })

    it('should produce Ctrl+\\ = FS (0x1C)', () => {
      encoder.updateKey(0x31, true)  // '\\'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x1C)
    })

    it('should produce Ctrl+] = GS (0x1D)', () => {
      encoder.updateKey(0x30, true)  // ']'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x1D)
    })

    it('should track right Ctrl the same as left Ctrl', () => {
      encoder.updateKey(0xE0, false)  // Release left Ctrl
      encoder.updateKey(0xE4, true)   // Right Ctrl down
      encoder.updateKey(0x04, true)   // 'A'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x01)  // Ctrl+A
    })
  })

  describe('Modifier Key Behavior', () => {
    beforeEach(() => {
      encoder.updateControlLines(false, false, false, false)
    })

    it('should not generate output for Ctrl press/release alone', () => {
      encoder.updateKey(0xE0, true)   // Left Ctrl down
      expect(encoder.hasDataReadyA()).toBe(false)
      encoder.updateKey(0xE0, false)  // Left Ctrl up
      expect(encoder.hasDataReadyA()).toBe(false)
    })

    it('should not generate output for Shift press/release alone', () => {
      encoder.updateKey(0xE1, true)   // Left Shift down
      expect(encoder.hasDataReadyA()).toBe(false)
      encoder.updateKey(0xE1, false)  // Left Shift up
      expect(encoder.hasDataReadyA()).toBe(false)
    })

    it('should not generate output for key release events', () => {
      encoder.updateKey(0x04, true)   // 'A' pressed
      expect(encoder.hasDataReadyA()).toBe(true)
      encoder.clearInterrupts(true, false, true, false)

      encoder.updateKey(0x04, false)  // 'A' released
      expect(encoder.hasDataReadyA()).toBe(false)  // No new data from release
    })

    it('should ignore Alt key (no output, no modifier effect)', () => {
      encoder.updateKey(0xE2, true)   // Left Alt down - ignored
      expect(encoder.hasDataReadyA()).toBe(false)
      encoder.updateKey(0x04, true)   // 'A'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x41)  // Normal 'A', no alt mapping
    })

    it('should ignore Caps Lock key', () => {
      encoder.updateKey(0x39, true)   // Caps Lock - ignored
      expect(encoder.hasDataReadyA()).toBe(false)
    })

    it('should ignore GUI/MENU keys', () => {
      encoder.updateKey(0xE3, true)   // Left GUI - ignored (no mapping in table)
      expect(encoder.hasDataReadyA()).toBe(false)
    })

    it('should ignore unrecognized keycodes', () => {
      encoder.updateKey(0x3A, true)   // F1 - no mapping
      expect(encoder.hasDataReadyA()).toBe(false)
    })
  })

  describe('Sequential Key Presses', () => {
    beforeEach(() => {
      encoder.updateControlLines(false, false, false, false)
    })

    it('should overwrite data with new key press', () => {
      encoder.updateKey(0x04, true)  // 'A'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x41)

      encoder.updateKey(0x05, true)  // 'B' overwrites without clearing
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x42)
    })

    it('should handle read-clear-press cycle', () => {
      encoder.updateKey(0x04, true)  // 'A'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x41)
      encoder.clearInterrupts(true, false, true, false)
      expect(encoder.hasDataReadyA()).toBe(false)

      encoder.updateKey(0x05, true)  // 'B'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x42)
      expect(encoder.hasDataReadyA()).toBe(true)
    })

    it('should handle modifier press then key press', () => {
      encoder.updateKey(0xE0, true)  // Ctrl down
      encoder.updateKey(0x06, true)  // 'C' -> Ctrl+C = 0x03
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x03)

      encoder.clearInterrupts(true, false, true, false)
      encoder.updateKey(0xE0, false)  // Ctrl up
      encoder.updateKey(0x06, true)   // 'C' -> normal 'C' = 0x43
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x43)
    })
  })

  describe('Active Port Selection', () => {
    beforeEach(() => {
      encoder.updateControlLines(false, false, false, false)
    })

    it('should default to both ports active', () => {
      expect(encoder.activePort).toBe('both')
      encoder.updateKey(0x04, true)  // 'A'
      expect(encoder.hasDataReadyA()).toBe(true)
      expect(encoder.hasDataReadyB()).toBe(true)
    })

    it('should only update Port A when activePort is A', () => {
      encoder.activePort = 'A'
      encoder.updateKey(0x04, true)  // 'A'
      expect(encoder.hasDataReadyA()).toBe(true)
      expect(encoder.hasDataReadyB()).toBe(false)
    })

    it('should only update Port B when activePort is B', () => {
      encoder.activePort = 'B'
      encoder.updateKey(0x04, true)  // 'A'
      expect(encoder.hasDataReadyA()).toBe(false)
      expect(encoder.hasDataReadyB()).toBe(true)
    })
  })

  describe('Edge Cases', () => {
    beforeEach(() => {
      encoder.updateControlLines(false, false, false, false)
    })

    it('should handle port disable mid-operation', () => {
      encoder.updateKey(0x04, true)  // 'A'
      expect(encoder.hasCA1Interrupt()).toBe(true)

      // Disable Port A
      encoder.updateControlLines(false, true, false, false)
      expect(encoder.hasCA1Interrupt()).toBe(false)
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0xFF)  // Disabled, returns 0xFF
    })

    it('should allow re-enabling port and reading existing data', () => {
      encoder.updateKey(0x04, true)  // 'A'
      encoder.updateControlLines(false, true, false, true)  // Disable both
      encoder.updateControlLines(false, false, false, false)  // Re-enable both
      // Data should still be readable (dataReady is still true, just interrupt was gated)
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x41)
    })

    it('should handle Ctrl+2 producing NUL (0x00) correctly', () => {
      encoder.updateKey(0xE0, true)  // Ctrl down
      encoder.updateKey(0x1F, true)  // '2'
      // Should produce 0x00 and data should be ready
      expect(encoder.hasDataReadyA()).toBe(true)
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x00)
    })
  })
})
