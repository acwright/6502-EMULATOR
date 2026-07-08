import { AttachmentBase } from './Attachment'

/**
 * USB HID Keycode to ASCII mapping table
 * Maps USB HID usage IDs to uppercase ASCII characters
 */
const USB_HID_TO_ASCII: { [key: number]: number } = {
  0x04: 0x41, // A
  0x05: 0x42, // B
  0x06: 0x43, // C
  0x07: 0x44, // D
  0x08: 0x45, // E
  0x09: 0x46, // F
  0x0A: 0x47, // G
  0x0B: 0x48, // H
  0x0C: 0x49, // I
  0x0D: 0x4A, // J
  0x0E: 0x4B, // K
  0x0F: 0x4C, // L
  0x10: 0x4D, // M
  0x11: 0x4E, // N
  0x12: 0x4F, // O
  0x13: 0x50, // P
  0x14: 0x51, // Q
  0x15: 0x52, // R
  0x16: 0x53, // S
  0x17: 0x54, // T
  0x18: 0x55, // U
  0x19: 0x56, // V
  0x1A: 0x57, // W
  0x1B: 0x58, // X
  0x1C: 0x59, // Y
  0x1D: 0x5A, // Z
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
 * KeyboardEncoderAttachment - Emulates a keyboard encoder that provides ASCII-encoded
 * key data on both GPIO ports A and B.
 *
 * This attachment uses the VIA control lines to signal data availability:
 * - CA2 LOW enables Port A
 * - CB2 LOW enables Port B
 * - CA1 interrupt signals data ready on Port A
 * - CB1 interrupt signals data ready on Port B
 *
 * Letters are always output as uppercase ASCII (0x41-0x5A).
 * Supported modifier combinations:
 * - Ctrl+letter: Control codes 0x01-0x1A
 * - Ctrl+special: Ctrl+2=NUL, Ctrl+6=RS, Ctrl+-=US, Ctrl+[=ESC, Ctrl+\=FS, Ctrl+]=GS
 * - Shift+number/symbol: Standard US keyboard shifted symbols
 */
export class KeyboardEncoderAttachment extends AttachmentBase {
  // Selects which port(s) receive data and fire interrupts:
  // 'A' = PS/2 encoder on Port A (CA1 IRQ only)
  // 'B' = Matrix encoder on Port B (CB1 IRQ only)
  // 'both' = both ports active (default)
  activePort: 'A' | 'B' | 'both' = 'B'

  // Port A state
  private asciiDataA: number = 0x00
  private dataReadyA: boolean = false
  private interruptPendingA: boolean = false
  private enabledA: boolean = false

  // Port B state
  private asciiDataB: number = 0x00
  private dataReadyB: boolean = false
  private interruptPendingB: boolean = false
  private enabledB: boolean = false

  // Modifier key states
  private shiftPressed: boolean = false
  private ctrlPressed: boolean = false

  // Control line states
  private stateCA1: boolean = false
  private stateCA2: boolean = false
  private stateCB1: boolean = false
  private stateCB2: boolean = false

  constructor(priority: number = 0) {
    // Uses CA1, CA2, CB1, CB2
    super(priority, true, true, true, true)
    this.reset()
  }

  reset(): void {
    super.reset()
    this.asciiDataA = 0x00
    this.dataReadyA = false
    this.interruptPendingA = false
    this.enabledA = false
    this.asciiDataB = 0x00
    this.dataReadyB = false
    this.interruptPendingB = false
    this.enabledB = false
    this.shiftPressed = false
    this.ctrlPressed = false
  }

  readPortA(ddrA: number, orA: number): number {
    // Only provide data when enabled and data is ready
    if (this.enabledA && this.dataReadyA) {
      // Reading the port will clear data ready flag (done via clearInterrupts)
      return this.asciiDataA
    }

    // No data to provide
    return 0xFF
  }

  readPortB(ddrB: number, orB: number): number {
    // Only provide data when enabled and data is ready
    if (this.enabledB && this.dataReadyB) {
      // Reading the port will clear data ready flag (done via clearInterrupts)
      return this.asciiDataB
    }

    // No data to provide
    return 0xFF
  }

  updateControlLines(ca1: boolean, ca2: boolean, cb1: boolean, cb2: boolean): void {
    this.stateCA1 = ca1
    this.stateCA2 = ca2
    this.stateCB1 = cb1
    this.stateCB2 = cb2

    // Enabled when CA2 is LOW for Port A
    this.enabledA = !ca2

    // Enabled when CB2 is LOW for Port B
    this.enabledB = !cb2
  }

  hasCA1Interrupt(): boolean {
    return this.interruptPendingA && this.enabledA
  }

  hasCB1Interrupt(): boolean {
    return this.interruptPendingB && this.enabledB
  }

  clearInterrupts(ca1: boolean, ca2: boolean, cb1: boolean, cb2: boolean): void {
    if (ca1) {
      this.interruptPendingA = false
      this.dataReadyA = false  // Clear data ready flag when Port A is read
    }
    if (cb1) {
      this.interruptPendingB = false
      this.dataReadyB = false  // Clear data ready flag when Port B is read
    }
  }

  /**
   * Map a USB HID keycode to ASCII with modifier keys applied
   */
  private mapKeyWithModifiers(usbHidKeycode: number): number {
    // Get base ASCII character from USB HID keycode
    const baseChar = USB_HID_TO_ASCII[usbHidKeycode] || 0x00

    // If no base mapping, return 0x00
    if (baseChar === 0x00) {
      return 0x00
    }

    // Handle Ctrl combinations - control codes
    if (this.ctrlPressed) {
      // Ctrl with letters produces control codes 0x01-0x1A
      if (baseChar >= 0x41 && baseChar <= 0x5A) {  // A-Z
        return baseChar - 0x41 + 0x01
      }

      // Ctrl with other special keys
      switch (baseChar) {
        case 0x32: return 0x00  // Ctrl+2 = NUL
        case 0x36: return 0x1E  // Ctrl+6 = RS
        case 0x2D: return 0x1F  // Ctrl+- = US
        case 0x5B: return 0x1B  // Ctrl+[ = ESC
        case 0x5C: return 0x1C  // Ctrl+\ = FS
        case 0x5D: return 0x1D  // Ctrl+] = GS
      }
    }

    // Handle Shift combinations - shifted symbols only (letters are always uppercase)
    if (this.shiftPressed && !this.ctrlPressed) {
      switch (baseChar) {
        case 0x31: return 0x21  // '1' -> '!'
        case 0x32: return 0x40  // '2' -> '@'
        case 0x33: return 0x23  // '3' -> '#'
        case 0x34: return 0x24  // '4' -> '$'
        case 0x35: return 0x25  // '5' -> '%'
        case 0x36: return 0x5E  // '6' -> '^'
        case 0x37: return 0x26  // '7' -> '&'
        case 0x38: return 0x2A  // '8' -> '*'
        case 0x39: return 0x28  // '9' -> '('
        case 0x30: return 0x29  // '0' -> ')'
        case 0x2D: return 0x5F  // '-' -> '_'
        case 0x3D: return 0x2B  // '=' -> '+'
        case 0x5B: return 0x7B  // '[' -> '{'
        case 0x5D: return 0x7D  // ']' -> '}'
        case 0x5C: return 0x7C  // '\\' -> '|'
        case 0x3B: return 0x3A  // ';' -> ':'
        case 0x27: return 0x22  // '\'' -> '"'
        case 0x2C: return 0x3C  // ',' -> '<'
        case 0x2E: return 0x3E  // '.' -> '>'
        case 0x2F: return 0x3F  // '/' -> '?'
        case 0x60: return 0x7E  // '`' -> '~'
      }
    }

    // No modifiers or unhandled combination - return base character
    return baseChar
  }

  /**
   * Update the keyboard state based on a USB HID key press or release
   * @param usbHidKeycode USB HID keycode
   * @param pressed true for key press, false for key release
   */
  updateKey(usbHidKeycode: number, pressed: boolean): void {
    // Handle modifier keys - update state
    switch (usbHidKeycode) {
      case 0xE0:  // Left Ctrl
      case 0xE4:  // Right Ctrl
        this.ctrlPressed = pressed
        return  // Don't generate output for modifier keys alone

      case 0xE1:  // Left Shift
      case 0xE5:  // Right Shift
        this.shiftPressed = pressed
        return
    }

    // Only process key presses, not releases (encoder only reports keypress events)
    if (!pressed) {
      return
    }

    // Map the key with active modifiers
    const mappedValue = this.mapKeyWithModifiers(usbHidKeycode)

    // Ignore keys with no mapping (0x00 unless it's a valid control code like Ctrl+2 = NUL)
    // Valid 0x00: Ctrl+2
    if (mappedValue === 0x00 && !this.ctrlPressed) {
      return
    }

    // Update active port(s) with the mapped data
    if (this.activePort !== 'B') {
      this.asciiDataA = mappedValue
      this.dataReadyA = true
      if (this.enabledA) {
        this.interruptPendingA = true
      }
    }
    if (this.activePort !== 'A') {
      this.asciiDataB = mappedValue
      this.dataReadyB = true
      if (this.enabledB) {
        this.interruptPendingB = true
      }
    }
  }

  /**
   * Check if Port A has data ready
   */
  hasDataReadyA(): boolean {
    return this.dataReadyA && this.enabledA
  }

  /**
   * Check if Port B has data ready
   */
  hasDataReadyB(): boolean {
    return this.dataReadyB && this.enabledB
  }
}
