import { AttachmentBase } from './Attachment'

/**
 * USB HID Keycode to ASCII mapping table
 * Maps USB HID usage IDs to ASCII characters
 */
const USB_HID_TO_ASCII: { [key: number]: number } = {
  0x04: 0x61, // a
  0x05: 0x62, // b
  0x06: 0x63, // c
  0x07: 0x64, // d
  0x08: 0x65, // e
  0x09: 0x66, // f
  0x0A: 0x67, // g
  0x0B: 0x68, // h
  0x0C: 0x69, // i
  0x0D: 0x6A, // j
  0x0E: 0x6B, // k
  0x0F: 0x6C, // l
  0x10: 0x6D, // m
  0x11: 0x6E, // n
  0x12: 0x6F, // o
  0x13: 0x70, // p
  0x14: 0x71, // q
  0x15: 0x72, // r
  0x16: 0x73, // s
  0x17: 0x74, // t
  0x18: 0x75, // u
  0x19: 0x76, // v
  0x1A: 0x77, // w
  0x1B: 0x78, // x
  0x1C: 0x79, // y
  0x1D: 0x7A, // z
  0x1E: 0x31, // 1
  0x1F: 0x32, // 2
  0x20: 0x33, // 3
  0x21: 0x34, // 4
  0x22: 0x35, // 5
  0x23: 0x36, // 6
  0x24: 0x37, // 7
  0x25: 0x38, // 8
  0x26: 0x39, // 9
  0x27: 0x30, // 0
  0x28: 0x0D, // Enter
  0x29: 0x1B, // Escape
  0x2A: 0x08, // Backspace
  0x2B: 0x09, // Tab
  0x2C: 0x20, // Space
  0x2D: 0x2D, // -
  0x2E: 0x3D, // =
  0x2F: 0x5B, // [
  0x30: 0x5D, // ]
  0x31: 0x5C, // backslash
  0x33: 0x3B, // ;
  0x34: 0x27, // '
  0x35: 0x60, // `
  0x36: 0x2C, // ,
  0x37: 0x2E, // .
  0x38: 0x2F, // /
  0x4C: 0x7F, // Delete
  0x4F: 0x1D, // Right Arrow
  0x50: 0x1C, // Left Arrow
  0x51: 0x1F, // Down Arrow
  0x52: 0x1E, // Up Arrow
  0x49: 0x1A, // Insert
}

/**
 * KeyboardMatrixAttachment - Emulates a keyboard matrix connected to GPIO ports
 * 
 * The keyboard matrix uses:
 * - Port A (PA0-PA7): Rows (8 rows)
 * - Port B (PB0-PB7): Columns (8 columns)
 * 
 * Keys are active-low: when a key is pressed, the corresponding row/column intersection
 * pulls the row line low when the column is selected (low).
 */
export class KeyboardMatrixAttachment extends AttachmentBase {
  // Keyboard matrix layout mapping
  // Rows are PA0-PA7, Columns are PB0-PB7
  private static readonly KEYBOARD_LAYOUT: number[][] = [
    // PB0    PB1    PB2    PB3    PB4    PB5    PB6    PB7
    [0x60, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37], // PA0: ` 1 2 3 4 5 6 7
    [0x38, 0x39, 0x30, 0x2D, 0x3D, 0x08, 0x1B, 0x09], // PA1: 8 9 0 - = BS ESC TAB
    [0x71, 0x77, 0x65, 0x72, 0x74, 0x79, 0x75, 0x69], // PA2: q w e r t y u i
    [0x6F, 0x70, 0x5B, 0x5D, 0x5C, 0x1A, 0x00, 0x61], // PA3: o p [ ] \ INS CAPS a
    [0x73, 0x64, 0x66, 0x67, 0x68, 0x6A, 0x6B, 0x6C], // PA4: s d f g h j k l
    [0x3B, 0x27, 0x0D, 0x7F, 0x00, 0x7A, 0x78, 0x63], // PA5: ; ' ENTER DEL SHIFT z x c
    [0x76, 0x62, 0x6E, 0x6D, 0x2C, 0x2E, 0x2F, 0x1E], // PA6: v b n m , . / UP
    [0x00, 0x00, 0x00, 0x20, 0x00, 0x1C, 0x1F, 0x1D], // PA7: CTRL META ALT SPACE FN LEFT DOWN RIGHT
  ]

  // Keyboard matrix state - 8 rows, each storing which columns have keys pressed (bit mask)
  private keyboardMatrix: number[] = [0, 0, 0, 0, 0, 0, 0, 0]
  
  // Currently selected columns from Port B write
  private selectedColumns: number = 0xFF

  constructor(priority: number = 0) {
    super(priority, false, false, false, false)
    this.reset()
  }

  reset(): void {
    super.reset()
    for (let i = 0; i < 8; i++) {
      this.keyboardMatrix[i] = 0x00
    }
    this.selectedColumns = 0xFF
  }

  readPortA(ddr: number, or: number): number {
    let rowStates = 0xFF // All rows high (not pressed) by default

    // Check keyboard matrix based on selected columns
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        // If column is selected (low) and key is pressed in matrix
        if (!(this.selectedColumns & (1 << col)) && (this.keyboardMatrix[row] & (1 << col))) {
          rowStates &= ~(1 << row) // Pull row low (active-low)
        }
      }
    }

    return rowStates & 0xFF
  }

  readPortB(ddr: number, or: number): number {
    return 0xFF // Don't interfere with Port B reads
  }

  writePortB(value: number, ddr: number): void {
    // Store the column selection for matrix scanning
    this.selectedColumns = value & 0xFF
  }

  /**
   * Update a key state based on USB HID keycode
   * @param usbHidKeycode - USB HID usage ID for the key
   * @param pressed - true if key is pressed, false if released
   */
  updateKey(usbHidKeycode: number, pressed: boolean): void {
    let targetRow = -1
    let targetCol = -1

    // Direct USB HID keycode to matrix position mapping for special/modifier keys
    switch (usbHidKeycode) {
      // Modifier keys
      case 0xE0: // Left Ctrl
      case 0xE4: // Right Ctrl
        targetRow = 7
        targetCol = 0 // PA7, PB0 (CTRL)
        break
      case 0xE1: // Left Shift
      case 0xE5: // Right Shift
        targetRow = 5
        targetCol = 4 // PA5, PB4 (SHIFT)
        break
      case 0xE2: // Left Alt
      case 0xE6: // Right Alt
        targetRow = 7
        targetCol = 2 // PA7, PB2 (ALT)
        break
      case 0xE3: // Left GUI (Windows/Command)
      case 0xE7: // Right GUI
        targetRow = 7
        targetCol = 1 // PA7, PB1 (META/GUI)
        break

      // Special keys
      case 0x39: // Caps Lock
        targetRow = 3
        targetCol = 6 // PA3, PB6 (CAPS LOCK)
        break

      // Function keys (F1-F10) - map to FN + number combination
      case 0x3A: // F1
      case 0x3B: // F2
      case 0x3C: // F3
      case 0x3D: // F4
      case 0x3E: // F5
      case 0x3F: // F6
      case 0x40: // F7
      case 0x41: // F8
      case 0x42: // F9
      case 0x43: // F10
        {
          // Always set the FN key (PA7, PB4)
          if (pressed) {
            this.keyboardMatrix[7] |= (1 << 4)
          } else {
            this.keyboardMatrix[7] &= ~(1 << 4)
          }

          // Map to corresponding number key
          let numberKey: number
          if (usbHidKeycode >= 0x3A && usbHidKeycode <= 0x42) {
            // F1-F9 map to '1'-'9'
            numberKey = 0x31 + (usbHidKeycode - 0x3A) // '1' = 0x31
          } else {
            // F10 maps to '0'
            numberKey = 0x30 // '0' = 0x30
          }

          // Find and set the number key in the matrix
          for (let row = 0; row < 8; row++) {
            for (let col = 0; col < 8; col++) {
              if (KeyboardMatrixAttachment.KEYBOARD_LAYOUT[row][col] === numberKey) {
                if (pressed) {
                  this.keyboardMatrix[row] |= (1 << col)
                } else {
                  this.keyboardMatrix[row] &= ~(1 << col)
                }
                return // Done processing
              }
            }
          }
          return // If number key not found, still return
        }

      default:
        {
          // For all other keys, try ASCII mapping
          const asciiKey = USB_HID_TO_ASCII[usbHidKeycode]

          // If no ASCII mapping, ignore the key
          if (asciiKey === undefined || asciiKey === 0x00) {
            return
          }

          // Find the ASCII key in the keyboard layout
          for (let row = 0; row < 8; row++) {
            for (let col = 0; col < 8; col++) {
              if (KeyboardMatrixAttachment.KEYBOARD_LAYOUT[row][col] === asciiKey) {
                targetRow = row
                targetCol = col
                break
              }
            }
            if (targetRow !== -1) break
          }
        }
        break
    }

    // Update the keyboard matrix if we found a valid position
    if (targetRow !== -1 && targetCol !== -1) {
      if (pressed) {
        this.keyboardMatrix[targetRow] |= (1 << targetCol) // Set bit (key pressed)
      } else {
        this.keyboardMatrix[targetRow] &= ~(1 << targetCol) // Clear bit (key released)
      }
    }
  }

  /**
   * Update a specific matrix position directly
   * @param row - Row index (0-7)
   * @param col - Column index (0-7)
   * @param pressed - true if key is pressed, false if released
   */
  updateMatrixPosition(row: number, col: number, pressed: boolean): void {
    if (row < 8 && col < 8) {
      if (pressed) {
        this.keyboardMatrix[row] |= (1 << col)
      } else {
        this.keyboardMatrix[row] &= ~(1 << col)
      }
    }
  }

  /**
   * Get the current state of the keyboard matrix
   * @returns Array of 8 bytes representing the matrix state
   */
  getMatrixState(): number[] {
    return [...this.keyboardMatrix]
  }

  /**
   * Get the currently selected columns
   * @returns Byte representing selected columns
   */
  getSelectedColumns(): number {
    return this.selectedColumns
  }
}
