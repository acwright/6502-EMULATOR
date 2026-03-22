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
 * KeyboardEncoderAttachment - Emulates a keyboard encoder that provides ASCII-encoded
 * key data on both GPIO ports A and B.
 * 
 * This attachment uses the VIA control lines to signal data availability:
 * - CA2 LOW enables Port A
 * - CB2 LOW enables Port B
 * - CA1 interrupt signals data ready on Port A
 * - CB1 interrupt signals data ready on Port B
 * 
 * The encoder supports extensive modifier key combinations:
 * - MENU key: 0x80 (alone), 0x90 (with Alt)
 * - Function keys F1-F15: 0x81-0x8F (alone), 0x91-0x9F (with Alt)
 * - Ctrl combinations: Control codes 0x00-0x1F
 * - Alt+Shift: Extended character set 0xA0-0xFF
 * - Alt: Extended character set 0xE0-0xFF
 * - Shift: Uppercase letters and shifted symbols
 */
export class KeyboardEncoderAttachment extends AttachmentBase {
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
  private altPressed: boolean = false
  private menuPressed: boolean = false
  private capsLockActive: boolean = false

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
    this.altPressed = false
    this.menuPressed = false
    this.capsLockActive = false
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
    // Handle MENU key (USB HID 0xE3 Left GUI, 0xE7 Right GUI)
    if (usbHidKeycode === 0xE3 || usbHidKeycode === 0xE7) {
      if (this.altPressed) {
        return 0x90  // Alt+MENU
      }
      return 0x80  // MENU alone
    }

    // Handle function keys F1-F15 (USB HID 0x3A-0x45 for F1-F12, 0x68-0x6A for F13-F15)
    // F1-F15 without Alt → 0x81-0x8F
    // Alt+F1-F15 → 0x91-0x9F
    if (usbHidKeycode >= 0x3A && usbHidKeycode <= 0x45) {
      // F1-F12 (0x3A-0x45)
      const fKeyOffset = usbHidKeycode - 0x3A  // 0-11 for F1-F12
      if (this.altPressed) {
        return 0x91 + fKeyOffset  // Alt+F1-F12 → 0x91-0x9C
      }
      return 0x81 + fKeyOffset  // F1-F12 → 0x81-0x8C
    }
    if (usbHidKeycode >= 0x68 && usbHidKeycode <= 0x6A) {
      // F13-F15 (0x68-0x6A)
      const fKeyOffset = usbHidKeycode - 0x68 + 12  // 12-14 for F13-F15
      if (this.altPressed) {
        return 0x91 + fKeyOffset  // Alt+F13-F15 → 0x9D-0x9F
      }
      return 0x81 + fKeyOffset  // F13-F15 → 0x8D-0x8F
    }

    // Get base ASCII character from USB HID keycode
    const baseChar = USB_HID_TO_ASCII[usbHidKeycode] || 0x00

    // If no base mapping, return 0x00
    if (baseChar === 0x00) {
      return 0x00
    }

    // Handle Ctrl combinations - control codes
    if (this.ctrlPressed && !this.altPressed) {
      // Ctrl with letters produces control codes 0x01-0x1A
      if (baseChar >= 0x61 && baseChar <= 0x7A) {  // a-z
        return baseChar - 0x61 + 0x01
      }
      if (baseChar >= 0x41 && baseChar <= 0x5A) {  // A-Z
        return baseChar - 0x41 + 0x01
      }

      // Ctrl with other special keys
      switch (baseChar) {
        case 0x32: case 0x40: return 0x00  // Ctrl+2 or Ctrl+@ = NUL
        case 0x36: case 0x5E: return 0x1E  // Ctrl+6 or Ctrl+^ = RS (UP arrow position)
        case 0x2D: case 0x5F: return 0x1F  // Ctrl+- or Ctrl+_ = US (DOWN arrow position)
        case 0x5B: case 0x7B: return 0x1B  // Ctrl+[ or Ctrl+{ = ESC
        case 0x5C: case 0x7C: return 0x1C  // Ctrl+\ or Ctrl+| = FS (LEFT arrow position)
        case 0x5D: case 0x7D: return 0x1D  // Ctrl+] or Ctrl+} = GS (RIGHT arrow position)
      }
    }

    // Handle Alt+Shift combinations - extended character set
    if (this.altPressed && this.shiftPressed) {
      switch (baseChar) {
        case 0x31: return 0xA1  // '1' -> ¡
        case 0x27: return 0xA2  // '\'' -> ¢
        case 0x33: return 0xA3  // '3' -> £
        case 0x34: return 0xA4  // '4' -> ¤
        case 0x35: return 0xA5  // '5' -> ¥
        case 0x37: return 0xA6  // '7' -> ¦
        case 0x39: return 0xA8  // '9' -> ¨
        case 0x30: return 0xA9  // '0' -> ©
        case 0x38: return 0xAA  // '8' -> ª
        case 0x3D: return 0xAB  // '=' -> «
        case 0x3B: return 0xBA  // ';' -> º
        case 0x2C: return 0xBC  // ',' -> ¼
        case 0x2E: return 0xBE  // '.' -> ¾
        case 0x2F: return 0xBF  // '/' -> ¿
        case 0x32: return 0xC0  // '2' -> À
        case 0x61: case 0x41: return 0xC1  // 'a'/'A' -> Á
        case 0x62: case 0x42: return 0xC2  // 'b'/'B' -> Â
        case 0x63: case 0x43: return 0xC3  // 'c'/'C' -> Ã
        case 0x64: case 0x44: return 0xC4  // 'd'/'D' -> Ä
        case 0x65: case 0x45: return 0xC5  // 'e'/'E' -> Å
        case 0x66: case 0x46: return 0xC6  // 'f'/'F' -> Æ
        case 0x67: case 0x47: return 0xC7  // 'g'/'G' -> Ç
        case 0x68: case 0x48: return 0xC8  // 'h'/'H' -> È
        case 0x69: case 0x49: return 0xC9  // 'i'/'I' -> É
        case 0x6A: case 0x4A: return 0xCA  // 'j'/'J' -> Ê
        case 0x6B: case 0x4B: return 0xCB  // 'k'/'K' -> Ë
        case 0x6C: case 0x4C: return 0xCC  // 'l'/'L' -> Ì
        case 0x6D: case 0x4D: return 0xCD  // 'm'/'M' -> Í
        case 0x6E: case 0x4E: return 0xCE  // 'n'/'N' -> Î
        case 0x6F: case 0x4F: return 0xCF  // 'o'/'O' -> Ï
        case 0x70: case 0x50: return 0xD0  // 'p'/'P' -> Ð
        case 0x71: case 0x51: return 0xD1  // 'q'/'Q' -> Ñ
        case 0x72: case 0x52: return 0xD2  // 'r'/'R' -> Ò
        case 0x73: case 0x53: return 0xD3  // 's'/'S' -> Ó
        case 0x74: case 0x54: return 0xD4  // 't'/'T' -> Ô
        case 0x75: case 0x55: return 0xD5  // 'u'/'U' -> Õ
        case 0x76: case 0x56: return 0xD6  // 'v'/'V' -> Ö
        case 0x77: case 0x57: return 0xD7  // 'w'/'W' -> ×
        case 0x78: case 0x58: return 0xD8  // 'x'/'X' -> Ø
        case 0x79: case 0x59: return 0xD9  // 'y'/'Y' -> Ù
        case 0x7A: case 0x5A: return 0xDA  // 'z'/'Z' -> Ú
        case 0x5B: return 0xFB  // '[' -> û
        case 0x5C: return 0xFC  // '\\' -> ü
        case 0x5D: return 0xFD  // ']' -> ý
        case 0x60: return 0xFE  // '`' -> þ
        case 0x36: return 0xDE  // '6' -> Þ
        case 0x2D: return 0xDF  // '-' -> ß
      }
    }

    // Handle Alt combinations (without shift)
    if (this.altPressed && !this.shiftPressed) {
      switch (baseChar) {
        case 0x20: return 0xA0  // Space -> nbsp
        case 0x27: return 0xA7  // '\'' -> §
        case 0x2C: return 0xAC  // ',' -> ¬
        case 0x2D: return 0xAD  // '-' -> soft hyphen
        case 0x2E: return 0xAE  // '.' -> ®
        case 0x2F: return 0xAF  // '/' -> ¯
        case 0x30: return 0xB0  // '0' -> °
        case 0x31: return 0xB1  // '1' -> ±
        case 0x32: return 0xB2  // '2' -> ²
        case 0x33: return 0xB3  // '3' -> ³
        case 0x34: return 0xB4  // '4' -> ´
        case 0x35: return 0xB5  // '5' -> µ
        case 0x36: return 0xB6  // '6' -> ¶
        case 0x37: return 0xB7  // '7' -> ·
        case 0x38: return 0xB8  // '8' -> ¸
        case 0x39: return 0xB9  // '9' -> ¹
        case 0x3B: return 0xBB  // ';' -> »
        case 0x3D: return 0xBD  // '=' -> ½
        case 0x5B: return 0xDB  // '[' -> Û
        case 0x5C: return 0xDC  // '\\' -> Ü
        case 0x5D: return 0xDD  // ']' -> Ý
        case 0x60: return 0xE0  // '`' -> à
        case 0x61: case 0x41: return 0xE1  // 'a'/'A' -> á
        case 0x62: case 0x42: return 0xE2  // 'b'/'B' -> â
        case 0x63: case 0x43: return 0xE3  // 'c'/'C' -> ã
        case 0x64: case 0x44: return 0xE4  // 'd'/'D' -> ä
        case 0x65: case 0x45: return 0xE5  // 'e'/'E' -> å
        case 0x66: case 0x46: return 0xE6  // 'f'/'F' -> æ
        case 0x67: case 0x47: return 0xE7  // 'g'/'G' -> ç
        case 0x68: case 0x48: return 0xE8  // 'h'/'H' -> è
        case 0x69: case 0x49: return 0xE9  // 'i'/'I' -> é
        case 0x6A: case 0x4A: return 0xEA  // 'j'/'J' -> ê
        case 0x6B: case 0x4B: return 0xEB  // 'k'/'K' -> ë
        case 0x6C: case 0x4C: return 0xEC  // 'l'/'L' -> ì
        case 0x6D: case 0x4D: return 0xED  // 'm'/'M' -> í
        case 0x6E: case 0x4E: return 0xEE  // 'n'/'N' -> î
        case 0x6F: case 0x4F: return 0xEF  // 'o'/'O' -> ï
        case 0x70: case 0x50: return 0xF0  // 'p'/'P' -> ð
        case 0x71: case 0x51: return 0xF1  // 'q'/'Q' -> ñ
        case 0x72: case 0x52: return 0xF2  // 'r'/'R' -> ò
        case 0x73: case 0x53: return 0xF3  // 's'/'S' -> ó
        case 0x74: case 0x54: return 0xF4  // 't'/'T' -> ô
        case 0x75: case 0x55: return 0xF5  // 'u'/'U' -> õ
        case 0x76: case 0x56: return 0xF6  // 'v'/'V' -> ö
        case 0x77: case 0x57: return 0xF7  // 'w'/'W' -> ÷
        case 0x78: case 0x58: return 0xF8  // 'x'/'X' -> ø
        case 0x79: case 0x59: return 0xF9  // 'y'/'Y' -> ù
        case 0x7A: case 0x5A: return 0xFA  // 'z'/'Z' -> ú
        case 0x7F: return 0xFF  // DEL -> ÿ
      }
    }

    // Handle Shift combinations - uppercase and shifted symbols
    // Caps Lock XORs with Shift for letters (they cancel each other out)
    const effectiveUppercase = this.capsLockActive !== this.shiftPressed
    if (effectiveUppercase && !this.ctrlPressed && !this.altPressed) {
      if (baseChar >= 0x61 && baseChar <= 0x7A) {  // a-z
        return baseChar - 0x61 + 0x41  // A-Z
      }
    }
    if (this.shiftPressed && !this.ctrlPressed && !this.altPressed) {
      // Shifted symbols (Caps Lock does not affect symbols)
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

      case 0x39:  // Caps Lock - toggle on press, ignore release
        if (pressed) {
          this.capsLockActive = !this.capsLockActive
        }
        return

      case 0xE1:  // Left Shift
      case 0xE5:  // Right Shift
        this.shiftPressed = pressed
        return

      case 0xE2:  // Left Alt
      case 0xE6:  // Right Alt
        this.altPressed = pressed
        return

      case 0xE3:  // Left GUI (MENU)
      case 0xE7:  // Right GUI (MENU)
        this.menuPressed = pressed
        // MENU key generates output, so don't return - fall through
        break
    }

    // Only process key presses, not releases (encoder only reports keypress events)
    if (!pressed) {
      return
    }

    // Map the key with active modifiers
    const mappedValue = this.mapKeyWithModifiers(usbHidKeycode)

    // Ignore keys with no mapping (0x00 unless it's a valid control code like Ctrl+2 = NUL)
    // Valid 0x00: Ctrl+2, Ctrl+@
    if (mappedValue === 0x00 && !this.ctrlPressed) {
      return
    }

    // Update both ports with the mapped data
    this.asciiDataA = mappedValue
    this.asciiDataB = mappedValue
    this.dataReadyA = true
    this.dataReadyB = true

    // Trigger interrupts on both ports if enabled
    if (this.enabledA) {
      this.interruptPendingA = true
    }
    if (this.enabledB) {
      this.interruptPendingB = true
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
