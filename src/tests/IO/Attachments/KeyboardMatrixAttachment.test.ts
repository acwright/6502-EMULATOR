import { KeyboardMatrixAttachment } from '../../../components/IO/Attachments/KeyboardMatrixAttachment'

describe('KeyboardMatrixAttachment', () => {
  let keyboard: KeyboardMatrixAttachment

  beforeEach(() => {
    keyboard = new KeyboardMatrixAttachment(0)
  })

  describe('Initialization', () => {
    it('should initialize with empty matrix', () => {
      const matrix = keyboard.getMatrixState()
      expect(matrix).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
    })

    it('should initialize with all columns selected', () => {
      expect(keyboard.getSelectedColumns()).toBe(0xFF)
    })

    it('should be enabled by default', () => {
      expect(keyboard.isEnabled()).toBe(true)
    })

    it('should have correct priority', () => {
      const kb = new KeyboardMatrixAttachment(5)
      expect(kb.getPriority()).toBe(5)
    })
  })

  describe('Reset', () => {
    it('should clear all pressed keys', () => {
      keyboard.updateKey(0x04, true) // Press 'a'
      keyboard.reset()
      const matrix = keyboard.getMatrixState()
      expect(matrix).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
    })

    it('should reset selected columns', () => {
      keyboard.writePortB(0x00, 0xFF)
      keyboard.reset()
      expect(keyboard.getSelectedColumns()).toBe(0xFF)
    })
  })

  describe('Port B Write (Column Selection)', () => {
    it('should update selected columns', () => {
      keyboard.writePortB(0xAA, 0xFF)
      expect(keyboard.getSelectedColumns()).toBe(0xAA)
    })

    it('should select all columns with 0x00', () => {
      keyboard.writePortB(0x00, 0xFF)
      expect(keyboard.getSelectedColumns()).toBe(0x00)
    })

    it('should select individual columns', () => {
      keyboard.writePortB(0xFE, 0xFF) // Select column 0 only
      expect(keyboard.getSelectedColumns()).toBe(0xFE)
    })
  })

  describe('Port A Read (Row State)', () => {
    it('should return all rows high when no keys pressed', () => {
      keyboard.writePortB(0x00, 0xFF) // Select all columns
      expect(keyboard.readPortA(0x00, 0xFF)).toBe(0xFF)
    })

    it('should return row low when key is pressed in selected column', () => {
      // Press 'a' key which is at PA3, PB7
      keyboard.updateKey(0x04, true) // 'a' USB HID code
      keyboard.writePortB(0x7F, 0xFF) // Select column 7 only (bit 7 = 0)
      
      const rowState = keyboard.readPortA(0x00, 0xFF)
      expect(rowState & (1 << 3)).toBe(0) // Row 3 should be low
    })

    it('should not affect row when key column is not selected', () => {
      // Press 'a' at PA3, PB7
      keyboard.updateKey(0x04, true)
      keyboard.writePortB(0xFF, 0xFF) // No columns selected
      
      expect(keyboard.readPortA(0x00, 0xFF)).toBe(0xFF) // All rows high
    })

    it('should handle multiple keys in same row', () => {
      // Press 'q' (PA2, PB0) and 'w' (PA2, PB1)
      keyboard.updateKey(0x14, true) // 'q'
      keyboard.updateKey(0x1A, true) // 'w'
      
      keyboard.writePortB(0xFC, 0xFF) // Select columns 0 and 1
      const rowState = keyboard.readPortA(0x00, 0xFF)
      
      expect(rowState & (1 << 2)).toBe(0) // Row 2 should be low
    })

    it('should handle multiple keys in different rows', () => {
      // Press '1' (PA0, PB1) and 'a' (PA3, PB7)
      keyboard.updateKey(0x1E, true) // '1'
      keyboard.updateKey(0x04, true) // 'a'
      
      keyboard.writePortB(0x00, 0xFF) // Select all columns
      const rowState = keyboard.readPortA(0x00, 0xFF)
      
      expect(rowState & (1 << 0)).toBe(0) // Row 0 low
      expect(rowState & (1 << 3)).toBe(0) // Row 3 low
    })
  })

  describe('Port B Read', () => {
    it('should always return 0xFF (not interfere)', () => {
      expect(keyboard.readPortB(0x00, 0x00)).toBe(0xFF)
      expect(keyboard.readPortB(0xFF, 0xFF)).toBe(0xFF)
    })
  })

  describe('USB HID Key Mapping - Letters', () => {
    it('should map letter keys correctly', () => {
      keyboard.updateKey(0x04, true) // 'a'
      keyboard.writePortB(0x7F, 0xFF) // Select column 7 (PB7)
      
      const rowState = keyboard.readPortA(0x00, 0xFF)
      expect(rowState & (1 << 3)).toBe(0) // PA3 should be low
    })

    it('should map q key', () => {
      keyboard.updateKey(0x14, true) // 'q'
      keyboard.writePortB(0xFE, 0xFF) // Select column 0
      
      const rowState = keyboard.readPortA(0x00, 0xFF)
      expect(rowState & (1 << 2)).toBe(0) // PA2 should be low
    })

    it('should map z key', () => {
      keyboard.updateKey(0x1D, true) // 'z'
      keyboard.writePortB(0xDF, 0xFF) // Select column 5 (PB5)
      
      const rowState = keyboard.readPortA(0x00, 0xFF)
      expect(rowState & (1 << 5)).toBe(0) // PA5 should be low
    })
  })

  describe('USB HID Key Mapping - Numbers', () => {
    it('should map number 1', () => {
      keyboard.updateKey(0x1E, true) // '1'
      keyboard.writePortB(0xFD, 0xFF) // Select column 1
      
      const rowState = keyboard.readPortA(0x00, 0xFF)
      expect(rowState & (1 << 0)).toBe(0) // PA0 should be low
    })

    it('should map number 0', () => {
      keyboard.updateKey(0x27, true) // '0'
      keyboard.writePortB(0xFB, 0xFF) // Select column 2 (PB2)
      
      const rowState = keyboard.readPortA(0x00, 0xFF)
      expect(rowState & (1 << 1)).toBe(0) // PA1 should be low
    })
  })

  describe('USB HID Key Mapping - Special Keys', () => {
    it('should map Enter key', () => {
      keyboard.updateKey(0x28, true) // Enter
      keyboard.writePortB(0xFB, 0xFF) // Select column 2 (PB2)
      
      const rowState = keyboard.readPortA(0x00, 0xFF)
      expect(rowState & (1 << 5)).toBe(0) // PA5 should be low
    })

    it('should map Escape key', () => {
      keyboard.updateKey(0x29, true) // Escape
      keyboard.writePortB(0xBF, 0xFF) // Select column 6
      
      const rowState = keyboard.readPortA(0x00, 0xFF)
      expect(rowState & (1 << 1)).toBe(0) // PA1 should be low
    })

    it('should map Backspace key', () => {
      keyboard.updateKey(0x2A, true) // Backspace
      keyboard.writePortB(0xDF, 0xFF) // Select column 5
      
      const rowState = keyboard.readPortA(0x00, 0xFF)
      expect(rowState & (1 << 1)).toBe(0) // PA1 should be low
    })

    it('should map Tab key', () => {
      keyboard.updateKey(0x2B, true) // Tab
      keyboard.writePortB(0x7F, 0xFF) // Select column 7
      
      const rowState = keyboard.readPortA(0x00, 0xFF)
      expect(rowState & (1 << 1)).toBe(0) // PA1 should be low
    })

    it('should map Space key', () => {
      keyboard.updateKey(0x2C, true) // Space
      keyboard.writePortB(0xF7, 0xFF) // Select column 3 (PB3)
      
      const rowState = keyboard.readPortA(0x00, 0xFF)
      expect(rowState & (1 << 7)).toBe(0) // PA7 should be low
    })
  })

  describe('USB HID Key Mapping - Modifier Keys', () => {
    it('should map Left Ctrl', () => {
      keyboard.updateKey(0xE0, true) // Left Ctrl
      keyboard.writePortB(0xFE, 0xFF) // Select column 0
      
      const rowState = keyboard.readPortA(0x00, 0xFF)
      expect(rowState & (1 << 7)).toBe(0) // PA7 should be low
    })

    it('should map Right Ctrl', () => {
      keyboard.updateKey(0xE4, true) // Right Ctrl
      keyboard.writePortB(0xFE, 0xFF) // Select column 0
      
      const rowState = keyboard.readPortA(0x00, 0xFF)
      expect(rowState & (1 << 7)).toBe(0) // PA7 should be low
    })

    it('should map Left Shift', () => {
      keyboard.updateKey(0xE1, true) // Left Shift
      keyboard.writePortB(0xEF, 0xFF) // Select column 4
      
      const rowState = keyboard.readPortA(0x00, 0xFF)
      expect(rowState & (1 << 5)).toBe(0) // PA5 should be low
    })

    it('should map Right Shift', () => {
      keyboard.updateKey(0xE5, true) // Right Shift
      keyboard.writePortB(0xEF, 0xFF) // Select column 4
      
      const rowState = keyboard.readPortA(0x00, 0xFF)
      expect(rowState & (1 << 5)).toBe(0) // PA5 should be low
    })

    it('should map Left Alt', () => {
      keyboard.updateKey(0xE2, true) // Left Alt
      keyboard.writePortB(0xFB, 0xFF) // Select column 2
      
      const rowState = keyboard.readPortA(0x00, 0xFF)
      expect(rowState & (1 << 7)).toBe(0) // PA7 should be low
    })

    it('should map Left GUI (Windows/Command)', () => {
      keyboard.updateKey(0xE3, true) // Left GUI
      keyboard.writePortB(0xFD, 0xFF) // Select column 1
      
      const rowState = keyboard.readPortA(0x00, 0xFF)
      expect(rowState & (1 << 7)).toBe(0) // PA7 should be low
    })
  })

  describe('USB HID Key Mapping - Function Keys', () => {
    it('should map F1 as FN+1', () => {
      keyboard.updateKey(0x3A, true) // F1
      keyboard.writePortB(0xEF, 0xFF) // Select column 4 (FN key)
      
      let rowState = keyboard.readPortA(0x00, 0xFF)
      expect(rowState & (1 << 7)).toBe(0) // PA7 should be low (FN)
      
      keyboard.writePortB(0xFD, 0xFF) // Select column 1 ('1' key)
      rowState = keyboard.readPortA(0x00, 0xFF)
      expect(rowState & (1 << 0)).toBe(0) // PA0 should be low ('1')
    })

    it('should map F10 as FN+0', () => {
      keyboard.updateKey(0x43, true) // F10
      keyboard.writePortB(0xEF, 0xFF) // Select column 4 (FN key)
      
      let rowState = keyboard.readPortA(0x00, 0xFF)
      expect(rowState & (1 << 7)).toBe(0) // PA7 should be low (FN)
      
      keyboard.writePortB(0xFB, 0xFF) // Select column 2 ('0' key)
      rowState = keyboard.readPortA(0x00, 0xFF)
      expect(rowState & (1 << 1)).toBe(0) // PA1 should be low ('0')
    })

    it('should release F key properly', () => {
      keyboard.updateKey(0x3A, true) // Press F1
      keyboard.updateKey(0x3A, false) // Release F1
      
      keyboard.writePortB(0x00, 0xFF) // Select all columns
      const rowState = keyboard.readPortA(0x00, 0xFF)
      expect(rowState).toBe(0xFF) // All rows should be high
    })
  })

  describe('USB HID Key Mapping - Arrow Keys', () => {
    it('should map Up Arrow', () => {
      keyboard.updateKey(0x52, true) // Up
      keyboard.writePortB(0x7F, 0xFF) // Select column 7
      
      const rowState = keyboard.readPortA(0x00, 0xFF)
      expect(rowState & (1 << 6)).toBe(0) // PA6 should be low
    })

    it('should map Down Arrow', () => {
      keyboard.updateKey(0x51, true) // Down
      keyboard.writePortB(0xBF, 0xFF) // Select column 6
      
      const rowState = keyboard.readPortA(0x00, 0xFF)
      expect(rowState & (1 << 7)).toBe(0) // PA7 should be low
    })

    it('should map Left Arrow', () => {
      keyboard.updateKey(0x50, true) // Left
      keyboard.writePortB(0xDF, 0xFF) // Select column 5
      
      const rowState = keyboard.readPortA(0x00, 0xFF)
      expect(rowState & (1 << 7)).toBe(0) // PA7 should be low
    })

    it('should map Right Arrow', () => {
      keyboard.updateKey(0x4F, true) // Right
      keyboard.writePortB(0x7F, 0xFF) // Select column 7
      
      const rowState = keyboard.readPortA(0x00, 0xFF)
      expect(rowState & (1 << 7)).toBe(0) // PA7 should be low
    })
  })

  describe('Key Press and Release', () => {
    it('should press and release a key', () => {
      keyboard.updateKey(0x04, true) // Press 'a'
      keyboard.writePortB(0x7F, 0xFF)
      
      let rowState = keyboard.readPortA(0x00, 0xFF)
      expect(rowState & (1 << 3)).toBe(0) // Row should be low
      
      keyboard.updateKey(0x04, false) // Release 'a'
      rowState = keyboard.readPortA(0x00, 0xFF)
      expect(rowState & (1 << 3)).not.toBe(0) // Row should be high
    })

    it('should handle simultaneous key presses', () => {
      keyboard.updateKey(0x04, true) // 'a'
      keyboard.updateKey(0x16, true) // 's'
      keyboard.updateKey(0x07, true) // 'd'
      
      keyboard.writePortB(0x00, 0xFF) // Select all columns
      const rowState = keyboard.readPortA(0x00, 0xFF)
      
      expect(rowState & (1 << 3)).toBe(0) // 'a' row
      expect(rowState & (1 << 4)).toBe(0) // 's' and 'd' row
    })
  })

  describe('Direct Matrix Position Update', () => {
    it('should update matrix position directly', () => {
      keyboard.updateMatrixPosition(0, 0, true)
      keyboard.writePortB(0xFE, 0xFF) // Select column 0
      
      const rowState = keyboard.readPortA(0x00, 0xFF)
      expect(rowState & (1 << 0)).toBe(0)
    })

    it('should handle out of bounds positions', () => {
      expect(() => {
        keyboard.updateMatrixPosition(10, 10, true)
      }).not.toThrow()
    })

    it('should release matrix position', () => {
      keyboard.updateMatrixPosition(2, 3, true)
      keyboard.updateMatrixPosition(2, 3, false)
      
      keyboard.writePortB(0xF7, 0xFF) // Select column 3
      const rowState = keyboard.readPortA(0x00, 0xFF)
      expect(rowState & (1 << 2)).not.toBe(0) // Should be high
    })
  })

  describe('Complex Scenarios', () => {
    it('should handle Ctrl+C combination', () => {
      keyboard.updateKey(0xE0, true) // Ctrl
      keyboard.updateKey(0x06, true) // 'c'
      
      keyboard.writePortB(0x00, 0xFF) // Select all columns
      const rowState = keyboard.readPortA(0x00, 0xFF)
      
      expect(rowState & (1 << 7)).toBe(0) // Ctrl row
      expect(rowState & (1 << 5)).toBe(0) // 'c' row
    })

    it('should handle column scanning sequence', () => {
      keyboard.updateKey(0x04, true) // 'a' at PA3, PB7
      
      // Scan each column
      for (let col = 0; col < 8; col++) {
        keyboard.writePortB(~(1 << col) & 0xFF, 0xFF)
        const rowState = keyboard.readPortA(0x00, 0xFF)
        
        if (col === 7) {
          expect(rowState & (1 << 3)).toBe(0) // Should detect 'a'
        } else {
          expect(rowState).toBe(0xFF) // No keys in other columns
        }
      }
    })

    it('should handle rapid key press/release', () => {
      for (let i = 0; i < 10; i++) {
        keyboard.updateKey(0x04, true)
        keyboard.updateKey(0x04, false)
      }
      
      keyboard.writePortB(0x00, 0xFF)
      const rowState = keyboard.readPortA(0x00, 0xFF)
      expect(rowState).toBe(0xFF) // Should be released
    })
  })

  describe('Matrix State Inspection', () => {
    it('should return current matrix state', () => {
      keyboard.updateMatrixPosition(0, 0, true)
      keyboard.updateMatrixPosition(1, 1, true)
      
      const matrix = keyboard.getMatrixState()
      expect(matrix[0] & (1 << 0)).not.toBe(0)
      expect(matrix[1] & (1 << 1)).not.toBe(0)
    })

    it('should not modify internal state when getting matrix', () => {
      keyboard.updateMatrixPosition(0, 0, true)
      const matrix1 = keyboard.getMatrixState()
      matrix1[0] = 0xFF // Modify returned array
      
      const matrix2 = keyboard.getMatrixState()
      expect(matrix2[0]).not.toBe(0xFF) // Internal state unchanged
    })
  })

  describe('Invalid/Unknown Keys', () => {
    it('should ignore unknown USB HID codes', () => {
      keyboard.updateKey(0xFF, true) // Invalid code
      keyboard.writePortB(0x00, 0xFF)
      
      const rowState = keyboard.readPortA(0x00, 0xFF)
      expect(rowState).toBe(0xFF) // No keys pressed
    })

    it('should ignore keys with no ASCII mapping', () => {
      keyboard.updateKey(0x46, true) // Print Screen (no ASCII)
      keyboard.writePortB(0x00, 0xFF)
      
      const rowState = keyboard.readPortA(0x00, 0xFF)
      expect(rowState).toBe(0xFF) // No keys pressed
    })
  })
})
