import { KeyboardEncoderAttachment } from '../../../components/IO/Attachments/KeyboardEncoderAttachment'

describe('KeyboardEncoderAttachment', () => {
  let encoder: KeyboardEncoderAttachment

  beforeEach(() => {
    encoder = new KeyboardEncoderAttachment(5)
  })

  describe('Initialization', () => {
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
      encoder.updateKey(0x04, true)  // 'a'
      expect(encoder.hasCA1Interrupt()).toBe(false)
      expect(encoder.hasCB1Interrupt()).toBe(false)
    })

    it('should have correct priority', () => {
      expect(encoder.getPriority()).toBe(5)
    })
  })

  describe('Reset', () => {
    it('should clear all data and states', () => {
      // Enable and generate some data
      encoder.updateControlLines(false, false, false, false)
      encoder.updateKey(0x04, true)  // 'a'
      expect(encoder.hasDataReadyA()).toBe(true)

      // Reset
      encoder.reset()
      expect(encoder.hasDataReadyA()).toBe(false)
      expect(encoder.hasDataReadyB()).toBe(false)
      expect(encoder.hasCA1Interrupt()).toBe(false)
      expect(encoder.hasCB1Interrupt()).toBe(false)
    })
  })

  describe('Enable/Disable Control', () => {
    it('should enable Port A when CA2 is LOW', () => {
      encoder.updateControlLines(false, false, false, true)
      encoder.updateKey(0x04, true)  // 'a'
      expect(encoder.hasCA1Interrupt()).toBe(true)
      expect(encoder.hasCB1Interrupt()).toBe(false)
    })

    it('should enable Port B when CB2 is LOW', () => {
      encoder.updateControlLines(false, true, false, false)
      encoder.updateKey(0x04, true)  // 'a'
      expect(encoder.hasCA1Interrupt()).toBe(false)
      expect(encoder.hasCB1Interrupt()).toBe(true)
    })

    it('should enable both ports when both CA2 and CB2 are LOW', () => {
      encoder.updateControlLines(false, false, false, false)
      encoder.updateKey(0x04, true)  // 'a'
      expect(encoder.hasCA1Interrupt()).toBe(true)
      expect(encoder.hasCB1Interrupt()).toBe(true)
    })

    it('should disable Port A when CA2 is HIGH', () => {
      encoder.updateControlLines(false, true, false, false)
      encoder.updateKey(0x04, true)  // 'a'
      expect(encoder.hasCA1Interrupt()).toBe(false)
    })

    it('should disable Port B when CB2 is HIGH', () => {
      encoder.updateControlLines(false, false, false, true)
      encoder.updateKey(0x04, true)  // 'a'
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
      encoder.updateKey(0x04, true)  // 'a' = 0x61
      const value = encoder.readPortA(0xFF, 0x00)
      expect(value).toBe(0x61)
    })

    it('should return ASCII data when data ready on Port B', () => {
      encoder.updateControlLines(false, false, false, false)
      encoder.updateKey(0x04, true)  // 'a' = 0x61
      const value = encoder.readPortB(0xFF, 0x00)
      expect(value).toBe(0x61)
    })

    it('should return 0xFF on disabled port even with data ready', () => {
      encoder.updateControlLines(false, true, false, true)  // Both disabled
      encoder.updateKey(0x04, true)  // 'a'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0xFF)
      expect(encoder.readPortB(0xFF, 0x00)).toBe(0xFF)
    })

    it('should provide same data on both ports', () => {
      encoder.updateControlLines(false, false, false, false)
      encoder.updateKey(0x04, true)  // 'a'
      const valueA = encoder.readPortA(0xFF, 0x00)
      const valueB = encoder.readPortB(0xFF, 0x00)
      expect(valueA).toBe(valueB)
      expect(valueA).toBe(0x61)
    })
  })

  describe('Interrupt Handling', () => {
    it('should trigger CA1 interrupt when Port A enabled and key pressed', () => {
      encoder.updateControlLines(false, false, false, true)
      expect(encoder.hasCA1Interrupt()).toBe(false)
      encoder.updateKey(0x04, true)  // 'a'
      expect(encoder.hasCA1Interrupt()).toBe(true)
    })

    it('should trigger CB1 interrupt when Port B enabled and key pressed', () => {
      encoder.updateControlLines(false, true, false, false)
      expect(encoder.hasCB1Interrupt()).toBe(false)
      encoder.updateKey(0x04, true)  // 'a'
      expect(encoder.hasCB1Interrupt()).toBe(true)
    })

    it('should clear CA1 interrupt and data ready when cleared', () => {
      encoder.updateControlLines(false, false, false, false)
      encoder.updateKey(0x04, true)  // 'a'
      expect(encoder.hasCA1Interrupt()).toBe(true)
      expect(encoder.hasDataReadyA()).toBe(true)

      encoder.clearInterrupts(true, false, false, false)
      expect(encoder.hasCA1Interrupt()).toBe(false)
      expect(encoder.hasDataReadyA()).toBe(false)
    })

    it('should clear CB1 interrupt and data ready when cleared', () => {
      encoder.updateControlLines(false, false, false, false)
      encoder.updateKey(0x04, true)  // 'a'
      expect(encoder.hasCB1Interrupt()).toBe(true)
      expect(encoder.hasDataReadyB()).toBe(true)

      encoder.clearInterrupts(false, false, true, false)
      expect(encoder.hasCB1Interrupt()).toBe(false)
      expect(encoder.hasDataReadyB()).toBe(false)
    })

    it('should not trigger interrupt when port is disabled', () => {
      encoder.updateControlLines(false, true, false, true)  // Both disabled
      encoder.updateKey(0x04, true)  // 'a'
      expect(encoder.hasCA1Interrupt()).toBe(false)
      expect(encoder.hasCB1Interrupt()).toBe(false)
    })
  })

  describe('Basic Key Mapping', () => {
    beforeEach(() => {
      encoder.updateControlLines(false, false, false, false)
    })

    it('should map lowercase letters correctly', () => {
      encoder.updateKey(0x04, true)  // 'a'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x61)

      encoder.clearInterrupts(true, false, true, false)
      encoder.updateKey(0x1D, true)  // 'z'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x7A)
    })

    it('should map numbers correctly', () => {
      encoder.updateKey(0x1E, true)  // '1'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x31)

      encoder.clearInterrupts(true, false, true, false)
      encoder.updateKey(0x27, true)  // '0'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x30)
    })

    it('should map special keys correctly', () => {
      encoder.updateKey(0x28, true)  // Enter
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x0D)

      encoder.clearInterrupts(true, false, true, false)
      encoder.updateKey(0x29, true)  // Escape
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x1B)

      encoder.clearInterrupts(true, false, true, false)
      encoder.updateKey(0x2C, true)  // Space
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x20)
    })

    it('should ignore key releases', () => {
      encoder.updateKey(0x04, true)   // Press 'a'
      expect(encoder.hasDataReadyA()).toBe(true)

      encoder.clearInterrupts(true, false, true, false)
      encoder.updateKey(0x04, false)  // Release 'a'
      expect(encoder.hasDataReadyA()).toBe(false)  // No new data
    })

    it('should ignore unknown keycodes', () => {
      encoder.updateKey(0xFF, true)  // Invalid keycode
      expect(encoder.hasDataReadyA()).toBe(false)
    })
  })

  describe('Modifier Keys', () => {
    beforeEach(() => {
      encoder.updateControlLines(false, false, false, false)
    })

    it('should not generate output for modifier keys alone', () => {
      encoder.updateKey(0xE0, true)  // Left Ctrl
      expect(encoder.hasDataReadyA()).toBe(false)

      encoder.updateKey(0xE1, true)  // Left Shift
      expect(encoder.hasDataReadyA()).toBe(false)

      encoder.updateKey(0xE2, true)  // Left Alt
      expect(encoder.hasDataReadyA()).toBe(false)
    })

    it('should track modifier key state across presses', () => {
      // Press Shift
      encoder.updateKey(0xE1, true)
      encoder.updateKey(0x04, true)  // 'a' -> 'A'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x41)

      // Release Shift
      encoder.clearInterrupts(true, false, true, false)
      encoder.updateKey(0xE1, false)
      encoder.updateKey(0x04, true)  // 'a'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x61)
    })

    it('should handle both left and right modifiers', () => {
      // Left Ctrl
      encoder.updateKey(0xE0, true)
      encoder.updateKey(0x04, true)  // Ctrl+a
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x01)

      encoder.clearInterrupts(true, false, true, false)
      encoder.updateKey(0xE0, false)

      // Right Ctrl
      encoder.updateKey(0xE4, true)
      encoder.updateKey(0x04, true)  // Ctrl+a
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x01)
    })
  })

  describe('Shift Key Mapping', () => {
    beforeEach(() => {
      encoder.updateControlLines(false, false, false, false)
    })

    it('should map Shift+letter to uppercase', () => {
      encoder.updateKey(0xE1, true)  // Press Shift
      encoder.updateKey(0x04, true)  // 'a' -> 'A'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x41)
    })

    it('should map Shift+number to symbols', () => {
      encoder.updateKey(0xE1, true)  // Press Shift
      encoder.updateKey(0x1E, true)  // '1' -> '!'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x21)

      encoder.clearInterrupts(true, false, true, false)
      encoder.updateKey(0x25, true)  // '8' -> '*'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x2A)
    })

    it('should map Shift+special keys to shifted symbols', () => {
      encoder.updateKey(0xE1, true)  // Press Shift

      encoder.updateKey(0x2D, true)  // '-' -> '_'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x5F)

      encoder.clearInterrupts(true, false, true, false)
      encoder.updateKey(0x2E, true)  // '=' -> '+'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x2B)

      encoder.clearInterrupts(true, false, true, false)
      encoder.updateKey(0x2F, true)  // '[' -> '{'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x7B)
    })
  })

  describe('Ctrl Key Mapping', () => {
    beforeEach(() => {
      encoder.updateControlLines(false, false, false, false)
    })

    it('should map Ctrl+letter to control codes', () => {
      encoder.updateKey(0xE0, true)  // Press Ctrl
      encoder.updateKey(0x04, true)  // Ctrl+a -> 0x01
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x01)

      encoder.clearInterrupts(true, false, true, false)
      encoder.updateKey(0x1D, true)  // Ctrl+z -> 0x1A
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x1A)
    })

    it('should map Ctrl+special keys to control codes', () => {
      encoder.updateKey(0xE0, true)  // Press Ctrl

      encoder.updateKey(0x2F, true)  // Ctrl+[ -> ESC (0x1B)
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x1B)

      encoder.clearInterrupts(true, false, true, false)
      encoder.updateKey(0x31, true)  // Ctrl+\ -> FS (0x1C)
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x1C)

      encoder.clearInterrupts(true, false, true, false)
      encoder.updateKey(0x30, true)  // Ctrl+] -> GS (0x1D)
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x1D)
    })

    it('should map Ctrl+2 to NUL', () => {
      encoder.updateKey(0xE0, true)  // Press Ctrl
      encoder.updateKey(0x1F, true)  // Ctrl+2 -> 0x00
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x00)
    })

    it('should map Ctrl+6 to RS (UP arrow)', () => {
      encoder.updateKey(0xE0, true)  // Press Ctrl
      encoder.updateKey(0x23, true)  // Ctrl+6 -> 0x1E
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x1E)
    })

    it('should map Ctrl+- to US (DOWN arrow)', () => {
      encoder.updateKey(0xE0, true)  // Press Ctrl
      encoder.updateKey(0x2D, true)  // Ctrl+- -> 0x1F
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x1F)
    })
  })

  describe('MENU Key Mapping', () => {
    beforeEach(() => {
      encoder.updateControlLines(false, false, false, false)
    })

    it('should map MENU key to 0x80', () => {
      encoder.updateKey(0xE3, true)  // Left GUI (MENU)
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x80)
    })

    it('should map Alt+MENU to 0x90', () => {
      encoder.updateKey(0xE2, true)  // Press Alt
      encoder.updateKey(0xE3, true)  // MENU
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x90)
    })

    it('should handle Right GUI as MENU', () => {
      encoder.updateKey(0xE7, true)  // Right GUI (MENU)
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x80)
    })
  })

  describe('Function Key Mapping', () => {
    beforeEach(() => {
      encoder.updateControlLines(false, false, false, false)
    })

    it('should map F1-F12 to 0x81-0x8C', () => {
      encoder.updateKey(0x3A, true)  // F1
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x81)

      encoder.clearInterrupts(true, false, true, false)
      encoder.updateKey(0x3B, true)  // F2
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x82)

      encoder.clearInterrupts(true, false, true, false)
      encoder.updateKey(0x45, true)  // F12
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x8C)
    })

    it('should map F13-F15 to 0x8D-0x8F', () => {
      encoder.updateKey(0x68, true)  // F13
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x8D)

      encoder.clearInterrupts(true, false, true, false)
      encoder.updateKey(0x6A, true)  // F15
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x8F)
    })

    it('should map Alt+F1-F12 to 0x91-0x9C', () => {
      encoder.updateKey(0xE2, true)  // Press Alt

      encoder.updateKey(0x3A, true)  // Alt+F1
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x91)

      encoder.clearInterrupts(true, false, true, false)
      encoder.updateKey(0x45, true)  // Alt+F12
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x9C)
    })

    it('should map Alt+F13-F15 to 0x9D-0x9F', () => {
      encoder.updateKey(0xE2, true)  // Press Alt

      encoder.updateKey(0x68, true)  // Alt+F13
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x9D)

      encoder.clearInterrupts(true, false, true, false)
      encoder.updateKey(0x6A, true)  // Alt+F15
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x9F)
    })
  })

  describe('Alt Key Mapping', () => {
    beforeEach(() => {
      encoder.updateControlLines(false, false, false, false)
    })

    it('should map Alt+letter to extended character set', () => {
      encoder.updateKey(0xE2, true)  // Press Alt

      encoder.updateKey(0x04, true)  // Alt+a -> 0xE1
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0xE1)

      encoder.clearInterrupts(true, false, true, false)
      encoder.updateKey(0x1D, true)  // Alt+z -> 0xFA
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0xFA)
    })

    it('should map Alt+number to extended character set', () => {
      encoder.updateKey(0xE2, true)  // Press Alt

      encoder.updateKey(0x1E, true)  // Alt+1 -> 0xB1
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0xB1)

      encoder.clearInterrupts(true, false, true, false)
      encoder.updateKey(0x27, true)  // Alt+0 -> 0xB0
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0xB0)
    })

    it('should map Alt+Space to 0xA0', () => {
      encoder.updateKey(0xE2, true)  // Press Alt
      encoder.updateKey(0x2C, true)  // Alt+Space -> 0xA0
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0xA0)
    })

    it('should map Alt+DEL to 0xFF', () => {
      encoder.updateKey(0xE2, true)  // Press Alt
      encoder.updateKey(0x4C, true)  // Alt+DEL -> 0xFF
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0xFF)
    })
  })

  describe('Alt+Shift Key Mapping', () => {
    beforeEach(() => {
      encoder.updateControlLines(false, false, false, false)
    })

    it('should map Alt+Shift+letter to extended character set', () => {
      encoder.updateKey(0xE2, true)  // Press Alt
      encoder.updateKey(0xE1, true)  // Press Shift

      encoder.updateKey(0x04, true)  // Alt+Shift+a -> 0xC1
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0xC1)

      encoder.clearInterrupts(true, false, true, false)
      encoder.updateKey(0x1D, true)  // Alt+Shift+z -> 0xDA
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0xDA)
    })

    it('should map Alt+Shift+number to extended character set', () => {
      encoder.updateKey(0xE2, true)  // Press Alt
      encoder.updateKey(0xE1, true)  // Press Shift

      encoder.updateKey(0x1E, true)  // Alt+Shift+1 -> 0xA1
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0xA1)

      encoder.clearInterrupts(true, false, true, false)
      encoder.updateKey(0x1F, true)  // Alt+Shift+2 -> 0xC0
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0xC0)
    })

    it('should map Alt+Shift+symbols to extended character set', () => {
      encoder.updateKey(0xE2, true)  // Press Alt
      encoder.updateKey(0xE1, true)  // Press Shift

      encoder.updateKey(0x2D, true)  // Alt+Shift+- -> 0xDF
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0xDF)

      encoder.clearInterrupts(true, false, true, false)
      encoder.updateKey(0x2F, true)  // Alt+Shift+[ -> 0xFB
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0xFB)
    })
  })

  describe('Complex Key Combinations', () => {
    beforeEach(() => {
      encoder.updateControlLines(false, false, false, false)
    })

    it('should handle Ctrl+C combination', () => {
      encoder.updateKey(0xE0, true)  // Press Ctrl
      encoder.updateKey(0x06, true)  // c
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x03)  // ETX
    })

    it('should prioritize Ctrl over Shift', () => {
      encoder.updateKey(0xE0, true)  // Press Ctrl
      encoder.updateKey(0xE1, true)  // Press Shift
      encoder.updateKey(0x04, true)  // a
      // When both Ctrl and Shift are pressed, shift is ignored for Ctrl combinations
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x01)  // Ctrl+a
    })

    it('should prioritize Alt+Shift over Alt alone', () => {
      encoder.updateKey(0xE2, true)  // Press Alt
      encoder.updateKey(0xE1, true)  // Press Shift
      encoder.updateKey(0x04, true)  // a
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0xC1)  // Alt+Shift+a, not Alt+a (0xE1)
    })

    it('should apply Alt when both Ctrl and Alt are active', () => {
      encoder.updateKey(0xE0, true)  // Press Ctrl
      encoder.updateKey(0xE2, true)  // Press Alt
      encoder.updateKey(0x04, true)  // a
      // Alt takes effect when both Ctrl and Alt are pressed (per C++ implementation)
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0xE1)  // Alt+a
    })
  })

  describe('Sequential Key Presses', () => {
    beforeEach(() => {
      encoder.updateControlLines(false, false, false, false)
    })

    it('should handle multiple sequential key presses', () => {
      encoder.updateKey(0x04, true)  // 'a'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x61)

      encoder.clearInterrupts(true, false, true, false)
      encoder.updateKey(0x05, true)  // 'b'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x62)

      encoder.clearInterrupts(true, false, true, false)
      encoder.updateKey(0x06, true)  // 'c'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x63)
    })

    it('should overwrite previous data with new key press', () => {
      encoder.updateKey(0x04, true)  // 'a'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x61)

      // New key press without clearing interrupts
      encoder.updateKey(0x05, true)  // 'b'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x62)  // Overwritten
    })
  })

  describe('Edge Cases', () => {
    beforeEach(() => {
      encoder.updateControlLines(false, false, false, false)
    })

    it('should handle rapid modifier changes', () => {
      encoder.updateKey(0xE1, true)   // Press Shift
      encoder.updateKey(0xE1, false)  // Release Shift
      encoder.updateKey(0xE1, true)   // Press Shift again
      encoder.updateKey(0x04, true)   // 'a' -> 'A'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x41)
    })

    it('should handle all modifiers released', () => {
      encoder.updateKey(0xE0, true)   // Press Ctrl
      encoder.updateKey(0xE1, true)   // Press Shift
      encoder.updateKey(0xE2, true)   // Press Alt
      encoder.updateKey(0xE0, false)  // Release Ctrl
      encoder.updateKey(0xE1, false)  // Release Shift
      encoder.updateKey(0xE2, false)  // Release Alt
      encoder.updateKey(0x04, true)   // 'a'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x61)  // Plain 'a'
    })

    it('should handle port disabled mid-operation', () => {
      encoder.updateKey(0x04, true)  // 'a'
      expect(encoder.hasCA1Interrupt()).toBe(true)

      // Disable port
      encoder.updateControlLines(false, true, false, true)
      expect(encoder.hasCA1Interrupt()).toBe(false)  // Interrupt not visible when disabled
    })

    it('should handle re-enabling port with data still present', () => {
      encoder.updateKey(0x04, true)  // 'a'
      encoder.updateControlLines(false, true, false, true)  // Disable

      // Re-enable
      encoder.updateControlLines(false, false, false, false)
      // Data should still be there
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x61)
    })
  })

  describe('Alt+Shift Symbol Mapping (Extended Character Set)', () => {
    beforeEach(() => {
      encoder.updateControlLines(false, false, false, false)
      encoder.updateKey(0xE2, true)  // Press Alt
      encoder.updateKey(0xE1, true)  // Press Shift
    })

    afterEach(() => {
      encoder.clearInterrupts(true, false, true, false)
      encoder.updateKey(0xE2, false)  // Release Alt
      encoder.updateKey(0xE1, false)  // Release Shift
    })

    it('should map Alt+Shift+1 to ¡ (0xA1)', () => {
      encoder.updateKey(0x1E, true)  // '1'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0xA1)
    })

    it('should map Alt+Shift+\' to ¢ (0xA2)', () => {
      encoder.updateKey(0x34, true)  // '\'' (apostrophe, USB HID 0x34)
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0xA2)
    })

    it('should map Alt+Shift+3 to £ (0xA3)', () => {
      encoder.updateKey(0x20, true)  // '3'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0xA3)
    })

    it('should map Alt+Shift+4 to ¤ (0xA4)', () => {
      encoder.updateKey(0x21, true)  // '4'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0xA4)
    })

    it('should map Alt+Shift+5 to ¥ (0xA5)', () => {
      encoder.updateKey(0x22, true)  // '5'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0xA5)
    })

    it('should map Alt+Shift+7 to ¦ (0xA6)', () => {
      encoder.updateKey(0x24, true)  // '7'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0xA6)
    })

    it('should map Alt+Shift+9 to ¨ (0xA8)', () => {
      encoder.updateKey(0x26, true)  // '9'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0xA8)
    })

    it('should map Alt+Shift+0 to © (0xA9)', () => {
      encoder.updateKey(0x27, true)  // '0'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0xA9)
    })

    it('should map Alt+Shift+8 to ª (0xAA)', () => {
      encoder.updateKey(0x25, true)  // '8'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0xAA)
    })

    it('should map Alt+Shift+= to « (0xAB)', () => {
      encoder.updateKey(0x2E, true)  // '='
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0xAB)
    })

    it('should map Alt+Shift+; to º (0xBA)', () => {
      encoder.updateKey(0x33, true)  // ';'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0xBA)
    })

    it('should map Alt+Shift+, to ¼ (0xBC)', () => {
      encoder.updateKey(0x36, true)  // ','
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0xBC)
    })

    it('should map Alt+Shift+. to ¾ (0xBE)', () => {
      encoder.updateKey(0x37, true)  // '.'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0xBE)
    })

    it('should map Alt+Shift+/ to ¿ (0xBF)', () => {
      encoder.updateKey(0x38, true)  // '/'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0xBF)
    })

    it('should map Alt+Shift+2 to À (0xC0)', () => {
      encoder.updateKey(0x1F, true)  // '2'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0xC0)
    })

    it('should map Alt+Shift+b to Â (0xC2)', () => {
      encoder.updateKey(0x05, true)  // 'b'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0xC2)
    })

    it('should map Alt+Shift+c to Ã (0xC3)', () => {
      encoder.updateKey(0x06, true)  // 'c'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0xC3)
    })

    it('should map Alt+Shift+d to Ä (0xC4)', () => {
      encoder.updateKey(0x07, true)  // 'd'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0xC4)
    })

    it('should map Alt+Shift+e to Å (0xC5)', () => {
      encoder.updateKey(0x08, true)  // 'e'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0xC5)
    })

    it('should map Alt+Shift+f to Æ (0xC6)', () => {
      encoder.updateKey(0x09, true)  // 'f'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0xC6)
    })

    it('should map Alt+Shift+g to Ç (0xC7)', () => {
      encoder.updateKey(0x0A, true)  // 'g'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0xC7)
    })

    it('should map Alt+Shift+h to È (0xC8)', () => {
      encoder.updateKey(0x0B, true)  // 'h'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0xC8)
    })

    it('should map Alt+Shift+6 to Þ (0xDE)', () => {
      encoder.updateKey(0x23, true)  // '6'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0xDE)
    })

    it('should map Alt+Shift+- to ß (0xDF)', () => {
      encoder.updateKey(0x2D, true)  // '-'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0xDF)
    })

    it('should map Alt+Shift+[ to û (0xFB)', () => {
      encoder.updateKey(0x2F, true)  // '['
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0xFB)
    })

    it('should map Alt+Shift+\\ to ü (0xFC)', () => {
      encoder.updateKey(0x31, true)  // '\\'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0xFC)
    })

    it('should map Alt+Shift+] to ý (0xFD)', () => {
      encoder.updateKey(0x30, true)  // ']'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0xFD)
    })

    it('should map Alt+Shift+` to þ (0xFE)', () => {
      encoder.updateKey(0x35, true)  // '`'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0xFE)
    })
  })

  describe('Alt Symbol Mapping (Without Shift)', () => {
    beforeEach(() => {
      encoder.updateControlLines(false, false, false, false)
      encoder.updateKey(0xE2, true)  // Press Alt
    })

    afterEach(() => {
      encoder.clearInterrupts(true, false, true, false)
      encoder.updateKey(0xE2, false)  // Release Alt
    })

    it('should map Alt+\' to § (0xA7)', () => {
      encoder.updateKey(0x34, true)  // '\''
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0xA7)
    })

    it('should map Alt+, to ¬ (0xAC)', () => {
      encoder.updateKey(0x36, true)  // ','
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0xAC)
    })

    it('should map Alt+- to soft hyphen (0xAD)', () => {
      encoder.updateKey(0x2D, true)  // '-'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0xAD)
    })

    it('should map Alt+. to ® (0xAE)', () => {
      encoder.updateKey(0x37, true)  // '.'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0xAE)
    })

    it('should map Alt+/ to ¯ (0xAF)', () => {
      encoder.updateKey(0x38, true)  // '/'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0xAF)
    })

    it('should map Alt+; to » (0xBB)', () => {
      encoder.updateKey(0x33, true)  // ';'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0xBB)
    })

    it('should map Alt+= to ½ (0xBD)', () => {
      encoder.updateKey(0x2E, true)  // '='
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0xBD)
    })

    it('should map Alt+[ to Û (0xDB)', () => {
      encoder.updateKey(0x2F, true)  // '['
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0xDB)
    })

    it('should map Alt+\\ to Ü (0xDC)', () => {
      encoder.updateKey(0x31, true)  // '\\'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0xDC)
    })

    it('should map Alt+] to Ý (0xDD)', () => {
      encoder.updateKey(0x30, true)  // ']'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0xDD)
    })

    it('should map Alt+` to à (0xE0)', () => {
      encoder.updateKey(0x35, true)  // '`'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0xE0)
    })
  })

  describe('Ctrl Combinations Coverage', () => {
    beforeEach(() => {
      encoder.updateControlLines(false, false, false, false)
      encoder.updateKey(0xE0, true)  // Press Ctrl
    })

    afterEach(() => {
      encoder.clearInterrupts(true, false, true, false)
      encoder.updateKey(0xE0, false)  // Release Ctrl
    })

    it('should map Ctrl+b to 0x02', () => {
      encoder.updateKey(0x05, true)  // 'b'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x02)
    })

    it('should map Ctrl+d to 0x04', () => {
      encoder.updateKey(0x07, true)  // 'd'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x04)
    })

    it('should map Ctrl+e to 0x05', () => {
      encoder.updateKey(0x08, true)  // 'e'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x05)
    })

    it('should map Ctrl+f to 0x06', () => {
      encoder.updateKey(0x09, true)  // 'f'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x06)
    })

    it('should map Ctrl+g to 0x07', () => {
      encoder.updateKey(0x0A, true)  // 'g'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x07)
    })

    it('should map Ctrl+h to 0x08', () => {
      encoder.updateKey(0x0B, true)  // 'h'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x08)
    })

    it('should map Ctrl+i to 0x09', () => {
      encoder.updateKey(0x0C, true)  // 'i'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x09)
    })

    it('should map Ctrl+j to 0x0A', () => {
      encoder.updateKey(0x0D, true)  // 'j'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x0A)
    })

    it('should map Ctrl+k to 0x0B', () => {
      encoder.updateKey(0x0E, true)  // 'k'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x0B)
    })

    it('should map Ctrl+l to 0x0C', () => {
      encoder.updateKey(0x0F, true)  // 'l'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x0C)
    })

    it('should map Ctrl+m to 0x0D', () => {
      encoder.updateKey(0x10, true)  // 'm'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x0D)
    })

    it('should map Ctrl+n to 0x0E', () => {
      encoder.updateKey(0x11, true)  // 'n'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x0E)
    })

    it('should map Ctrl+o to 0x0F', () => {
      encoder.updateKey(0x12, true)  // 'o'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x0F)
    })

    it('should map Ctrl+p to 0x10', () => {
      encoder.updateKey(0x13, true)  // 'p'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x10)
    })

    it('should map Ctrl+q to 0x11', () => {
      encoder.updateKey(0x14, true)  // 'q'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x11)
    })

    it('should map Ctrl+r to 0x12', () => {
      encoder.updateKey(0x15, true)  // 'r'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x12)
    })

    it('should map Ctrl+s to 0x13', () => {
      encoder.updateKey(0x16, true)  // 's'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x13)
    })

    it('should map Ctrl+t to 0x14', () => {
      encoder.updateKey(0x17, true)  // 't'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x14)
    })

    it('should map Ctrl+u to 0x15', () => {
      encoder.updateKey(0x18, true)  // 'u'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x15)
    })

    it('should map Ctrl+v to 0x16', () => {
      encoder.updateKey(0x19, true)  // 'v'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x16)
    })

    it('should map Ctrl+w to 0x17', () => {
      encoder.updateKey(0x1A, true)  // 'w'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x17)
    })

    it('should map Ctrl+x to 0x18', () => {
      encoder.updateKey(0x1B, true)  // 'x'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x18)
    })

    it('should map Ctrl+y to 0x19', () => {
      encoder.updateKey(0x1C, true)  // 'y'
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x19)
    })
  })
})
