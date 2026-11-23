import { AttachmentBase } from './Attachment'
import { expectKind, readBytes, toBase64 } from '../../DeviceState'
import type { DeviceState } from '../../DeviceState'

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
 * Every line pulled low once held keys have carried each pull across. `rows`
 * holds, per row (PA line), the columns (PB lines) with a held key; `lowA` and
 * `lowB` are the lines something pulls low to begin with. A low row pulls the
 * column of every held key on it, and a low column every row with a held key in
 * it, on through further keys until nothing more changes: the matrix has no
 * diodes, so a pull crosses a key either way round.
 *
 * The keyboard encoder uses the same walk for its read-back, as the firmware's
 * matrixPull() does.
 */
export function pullThrough(rows: readonly number[], lowA: number, lowB: number): { a: number; b: number } {
  let a = lowA & 0xFF
  let b = lowB & 0xFF

  let changed = true
  while (changed) {
    changed = false
    for (let row = 0; row < 8; row++) {
      const keys = rows[row]!
      if (keys === 0) continue
      const rowBit = 1 << row
      // A low row pulls every column with a held key on it
      if ((a & rowBit) !== 0 && (b | keys) !== b) {
        b |= keys
        changed = true
      }
      // A low column pulls every row with a held key on it
      if ((a & rowBit) === 0 && (b & keys) !== 0) {
        a |= rowBit
        changed = true
      }
    }
  }

  return { a, b }
}

/**
 * KeyboardMatrixAttachment - Emulates the keyboard matrix as wiring: 64 switches
 * between the eight Port A lines (rows) and the eight Port B lines (columns),
 * with no diodes, as on the board.
 *
 * A held key joins its row line to its column line, so a line pulled low on
 * one side pulls the line across every held key on it low too, whichever side
 * is pulled, and on through further keys. What pulls a line low is the VIA
 * driving it (its DDR bit set and its OR bit 0) or a joystick holding it
 * (`stickLows`). That covers both ways of scanning the keyboard by hand: drive
 * a row low on Port A and read the columns on Port B (the way the DOCS show),
 * or drive a column on Port B and read the rows on Port A. It also gives the
 * phantom keys the board has: a stick holding a row low shows every held key on
 * that row in its column, and three held keys in a rectangle show a fourth.
 *
 * Nothing is driven high through a key: a line the VIA drives high is left to
 * the low side, as the low side wins on the board. The keyboard encoder's own
 * scanning is not modelled here; it hands the 6502 ASCII instead (see
 * KeyboardEncoderAttachment).
 */
export class KeyboardMatrixAttachment extends AttachmentBase {
  protected readonly kind = 'keyboard-matrix'

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

  // The lines the VIA drives low on each port (1 = driven low). Derived from the
  // VIA's registers, which it reports through writePortA/B, so not saved.
  private drivenLowA: number = 0
  private drivenLowB: number = 0

  /**
   * The lines a joystick holds low on a port (1 = held). The machine wires it
   * up; left unset, no stick pulls through a key.
   */
  stickLows?: (port: 'A' | 'B') => number

  constructor(priority: number = 0) {
    super(priority, false, false, false, false)
    this.reset()
  }

  reset(): void {
    super.reset()
    for (let i = 0; i < 8; i++) {
      this.keyboardMatrix[i] = 0x00
    }
    this.drivenLowA = 0
    this.drivenLowB = 0
  }

  /**
   * Every line pulled low on each port once the held keys have carried each
   * pull across: start from what the VIA drives and the sticks hold, then cross
   * each held key from whichever side is low until nothing more changes.
   */
  private lowLines(): { a: number; b: number } {
    return pullThrough(
      this.keyboardMatrix,
      this.drivenLowA | ((this.stickLows?.('A') ?? 0) & 0xFF),
      this.drivenLowB | ((this.stickLows?.('B') ?? 0) & 0xFF)
    )
  }

  readPortA(ddr: number, or: number): number {
    return ~this.lowLines().a & 0xFF
  }

  readPortB(ddr: number, or: number): number {
    return ~this.lowLines().b & 0xFF
  }

  writePortA(value: number, ddr: number): void {
    this.drivenLowA = ddr & ~value & 0xFF
  }

  writePortB(value: number, ddr: number): void {
    this.drivenLowB = ddr & ~value & 0xFF
  }

  /**
   * The switches a USB HID key closes, as [row, column] pairs: none for a key
   * the matrix doesn't have, two for F1-F10 (FN and a digit). The keyboard
   * encoder places keys with the same table.
   */
  static positionsOf(usbHidKeycode: number): Array<[number, number]> {
    switch (usbHidKeycode) {
      case 0xE0: // Left Ctrl
      case 0xE4: // Right Ctrl
        return [[7, 0]] // PA7, PB0 (CTRL)
      case 0xE1: // Left Shift
      case 0xE5: // Right Shift
        return [[5, 4]] // PA5, PB4 (SHIFT)
      case 0xE2: // Left Alt
      case 0xE6: // Right Alt
        return [[7, 2]] // PA7, PB2 (ALT)
      case 0xE3: // Left GUI (Windows/Command)
      case 0xE7: // Right GUI
        return [[7, 1]] // PA7, PB1 (META/GUI)
      case 0x39: // Caps Lock
        return [[3, 6]] // PA3, PB6 (CAPS LOCK)
    }

    // Function keys F1-F10: FN (PA7, PB4) and the digit, F10 being 0
    if (usbHidKeycode >= 0x3A && usbHidKeycode <= 0x43) {
      const digit = usbHidKeycode === 0x43 ? 0x30 : 0x31 + (usbHidKeycode - 0x3A)
      const at = KeyboardMatrixAttachment.find(digit)
      return at ? [[7, 4], at] : [[7, 4]]
    }

    // Everything else by its ASCII character's place in the layout
    const asciiKey = USB_HID_TO_ASCII[usbHidKeycode]
    if (asciiKey === undefined || asciiKey === 0x00) return []
    const at = KeyboardMatrixAttachment.find(asciiKey)
    return at ? [at] : []
  }

  private static find(ascii: number): [number, number] | undefined {
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        if (KeyboardMatrixAttachment.KEYBOARD_LAYOUT[row]![col] === ascii) return [row, col]
      }
    }
    return undefined
  }

  /**
   * Update a key state based on USB HID keycode
   * @param usbHidKeycode - USB HID usage ID for the key
   * @param pressed - true if key is pressed, false if released
   */
  updateKey(usbHidKeycode: number, pressed: boolean): void {
    for (const [row, col] of KeyboardMatrixAttachment.positionsOf(usbHidKeycode)) {
      this.updateMatrixPosition(row, col, pressed)
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

  serialize(): DeviceState {
    return {
      ...super.serialize(),
      keyboardMatrix: toBase64(this.keyboardMatrix)
    }
  }

  deserialize(state: DeviceState): void {
    super.deserialize(state)
    expectKind(state, this.kind)
    const matrix = readBytes(state, 'keyboardMatrix', 8)
    for (let row = 0; row < 8; row++) this.keyboardMatrix[row] = matrix[row]!
    // A snapshot from version 1-3 also carries `selectedColumns`, from the old
    // model that took any ORB write as columns driven low. The VIA's restored
    // registers say what is driven now, so it is ignored.
  }
}
