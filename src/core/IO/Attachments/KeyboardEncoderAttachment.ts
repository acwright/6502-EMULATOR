import { AttachmentBase } from './Attachment'
import { KeyboardMatrixAttachment, pullThrough } from './KeyboardMatrixAttachment'
import { StateError, expectKind, readBoolean, readByteList, readNumber, readString } from '../../DeviceState'
import type { DeviceState } from '../../DeviceState'

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
 * The firmware's matrixMap: each matrix position's base ASCII code, letters in
 * capitals. $FF is a switch that types nothing (CAPS, META, ALT, FN), $FE a
 * modifier (SHIFT at row 5 column 4, CTRL at row 7 column 0). Copied from the
 * AB Controller (6502-ACE `Firmware/AB Controller/src/main.cpp`), which the
 * COB's KEH Controller and the VCS's IB Controller share.
 */
const MATRIX_MAP: readonly (readonly number[])[] = [
  // PB0   PB1   PB2   PB3   PB4   PB5   PB6   PB7
  [0x60, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37], // PA0: ` 1 2 3 4 5 6 7
  [0x38, 0x39, 0x30, 0x2D, 0x3D, 0x08, 0x1B, 0x09], // PA1: 8 9 0 - = BS ESC TAB
  [0x51, 0x57, 0x45, 0x52, 0x54, 0x59, 0x55, 0x49], // PA2: Q W E R T Y U I
  [0x4F, 0x50, 0x5B, 0x5D, 0x5C, 0x1A, 0xFF, 0x41], // PA3: O P [ ] \ INS (CAPS) A
  [0x53, 0x44, 0x46, 0x47, 0x48, 0x4A, 0x4B, 0x4C], // PA4: S D F G H J K L
  [0x3B, 0x27, 0x0D, 0x7F, 0xFE, 0x5A, 0x58, 0x43], // PA5: ; ' ENTER DEL SHIFT Z X C
  [0x56, 0x42, 0x4E, 0x4D, 0x2C, 0x2E, 0x2F, 0x1E], // PA6: V B N M , . / UP
  [0xFE, 0xFF, 0xFF, 0x20, 0xFF, 0x1C, 0x1F, 0x1D]  // PA7: CTRL (META) (ALT) SPACE (FN) LEFT DOWN RIGHT
]

/** Shift on a digit or symbol, as the firmware maps it; letters are capitals either way. */
const SHIFTED: { readonly [base: number]: number } = {
  0x31: 0x21, 0x32: 0x40, 0x33: 0x23, 0x34: 0x24, 0x35: 0x25, // 1-5 -> ! @ # $ %
  0x36: 0x5E, 0x37: 0x26, 0x38: 0x2A, 0x39: 0x28, 0x30: 0x29, // 6-0 -> ^ & * ( )
  0x2D: 0x5F, 0x3D: 0x2B, 0x5B: 0x7B, 0x5D: 0x7D, 0x5C: 0x7C, // - = [ ] \ -> _ + { } |
  0x3B: 0x3A, 0x27: 0x22, 0x60: 0x7E, 0x2C: 0x3C, 0x2E: 0x3E, // ; ' ` , . -> : " ~ < >
  0x2F: 0x3F                                                   // / -> ?
}

/**
 * KeyboardEncoderAttachment - Emulates the keyboard encoder, the ATmega1284
 * that hands one ASCII byte per keystroke to the VIA: the AB Controller on the
 * ACE, the KEH Controller on a COB, the IB Controller on a VCS. Port A is the
 * PS/2 keyboard's, Port B the matrix keyboard's.
 *
 * The VIA control lines:
 * - CA2 LOW enables Port A, CB2 LOW enables Port B; high asks for the port back
 * - CA1 / CB1 is the strobe that raises the VIA's flag for a new byte
 *
 * It models the encoder's firmware as it runs on the board:
 *
 * - **Keys queue.** Each port has a queue of 16 keys. A key typed while its
 *   queue is full is dropped; the keys already queued are kept.
 * - **One key at a time, for 20 ms.** A strobed code stays on its port for
 *   20 ms, unless the 6502 asks for the port first, and only then can the next
 *   key on either port go out. A program that polls the VIA's flag rather than
 *   taking the interrupt has that long to read it, and no longer: the VIA does
 *   not latch, so a later read returns the idle port.
 * - **A held stick holds a key back.** The joysticks share the ports' lines,
 *   and the firmware drives a code open-drain and reads it back before the
 *   strobe. A key with a 1 where the stick on its port holds a 0 waits until the
 *   stick lets go, and the keys behind it wait too. It arrives late, never
 *   wrong. `portLines` tells the encoder what the stick holds.
 * - **The matrix keyboard is scanned, not typed.** Port B's keys are switches
 *   at a row and a column, and the firmware sees a key go down only in a row
 *   and a column no stick is holding: a held stick line reads as every key on
 *   it pressed, so the sweep leaves those keys as they were. A key pressed in
 *   a held stick's row or column is typed only if it is still down when the
 *   stick lets go, and lost if it is released first. Shift and Ctrl count only
 *   while the firmware sees them.
 * - **Held keys can fail a read-back too.** The matrix has no diodes, so a
 *   code's 0 bit driven low pulls through any held key on that line, and on
 *   through further keys: Shift and ; held together join column 4 to column 0,
 *   so `:` ($3A, column 0 low and column 4 high) reads back wrong and waits
 *   until one of them is released. A failure that no held stick or key the
 *   firmware knows of explains waits `UNEXPLAINED_WAIT_MICROS`, then goes out
 *   anyway, as the firmware's does.
 * - **Letting go.** Raising CA2/CB2 ends a held code. The port goes on reading
 *   the encoder's last code for `releaseDelayMicros` before it reads idle: the
 *   worst case of the firmware's release, so a program that reads the stick too
 *   soon fails here as it can on the board. Nothing is re-sent on re-enable: a
 *   code the 6502 did not read before it took the port is gone, as on the board.
 *
 * Letters are always output as uppercase ASCII (0x41-0x5A).
 * Supported modifier combinations:
 * - Ctrl+letter: Control codes 0x01-0x1A
 * - Ctrl+special: Ctrl+2=NUL, Ctrl+6=RS, Ctrl+-=US, Ctrl+[=ESC, Ctrl+\=FS, Ctrl+]=GS
 * - Shift+number/symbol: Standard US keyboard shifted symbols
 */
export class KeyboardEncoderAttachment extends AttachmentBase {
  protected readonly kind = 'keyboard-encoder'

  /** Keys each port's queue holds, as the firmware's CircularBuffer does. */
  static readonly QUEUE_SIZE = 16

  /** Microseconds a strobed code stays on its port (the firmware's CODE_HOLD_US). */
  static readonly HOLD_MICROS = 20_000

  /**
   * Microseconds a key waits on a read-back that no held stick or key explains,
   * before it is sent anyway (the firmware's UNEXPLAINED_WAIT_US).
   */
  static readonly UNEXPLAINED_WAIT_MICROS = 50_000

  // Selects which port(s) receive data and fire interrupts:
  // 'A' = PS/2 encoder on Port A (CA1 IRQ only)
  // 'B' = Matrix encoder on Port B (CB1 IRQ only)
  // 'both' = both ports active
  activePort: 'A' | 'B' | 'both' = 'B'

  // Microseconds the encoder keeps owning a port after its enable line goes
  // high, before it goes high-impedance and the joystick becomes visible on the
  // raw port. Real firmware polls CB2/CA2 and takes tens of microseconds to let
  // go; modelling zero latency (the old behaviour) certifies a BIOS settle wait
  // that cannot run on hardware. Defaults to the 100 us guaranteed ceiling —
  // not the firmware's ~17 us typical — and is public so a test can sweep it.
  releaseDelayMicros: number = 100

  /**
   * The levels everything else on a port holds its lines at, active low, so
   * $FF when nothing is holding one down: in practice the joystick on that
   * port. The machine wires it up; left unset, nothing ever holds a key back.
   */
  portLines?: (port: 'A' | 'B') => number

  // Microseconds still owed on the release window per port. > 0 means the
  // encoder is no longer actively enabled but has not yet let go of the port,
  // so the stick must not be visible yet. Counted down in tick().
  private releaseRemainingA: number = 0
  private releaseRemainingB: number = 0

  // Keys waiting to go out, oldest first
  private queueA: number[] = []
  private queueB: number[] = []

  // The last code strobed onto each port, and how long it stays driven
  private codeA: number = 0x00
  private codeB: number = 0x00
  private holdRemainingA: number = 0
  private holdRemainingB: number = 0

  // The strobe: true for the one tick a code goes out, which is when the VIA
  // reads it and raises its flag. The flag is the VIA's from then on.
  private strobeA: boolean = false
  private strobeB: boolean = false

  private enabledA: boolean = false
  private enabledB: boolean = false

  // The matrix keyboard: per row, the columns whose switch is closed (held) and
  // the columns the firmware's sweep sees as down (seen). They differ only
  // while a stick hides a key's row or column.
  private matrixHeld: number[] = [0, 0, 0, 0, 0, 0, 0, 0]
  private matrixSeen: number[] = [0, 0, 0, 0, 0, 0, 0, 0]
  private matrixDirty: boolean = false

  // How long the key at the head of each queue has failed its read-back in a
  // way nothing the firmware knows of explains; -1 when it hasn't
  private unexplainedMicrosA: number = -1
  private unexplainedMicrosB: number = -1

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
    this.queueA = []
    this.queueB = []
    this.codeA = 0x00
    this.codeB = 0x00
    this.holdRemainingA = 0
    this.holdRemainingB = 0
    this.strobeA = false
    this.strobeB = false
    this.enabledA = false
    this.enabledB = false
    this.shiftPressed = false
    this.ctrlPressed = false
    this.releaseRemainingA = 0
    this.releaseRemainingB = 0
    this.matrixHeld = [0, 0, 0, 0, 0, 0, 0, 0]
    this.matrixSeen = [0, 0, 0, 0, 0, 0, 0, 0]
    this.matrixDirty = false
    this.unexplainedMicrosA = -1
    this.unexplainedMicrosB = -1
  }

  tick(cpuFrequency: number): void {
    // A strobe lasts one tick: the VIA has read it by now
    this.strobeA = false
    this.strobeB = false

    if (cpuFrequency <= 0) return
    const microsPerTick = 1_000_000 / cpuFrequency

    // Bleed off the release window. When it reaches zero the encoder has let go
    // of the port and the joystick becomes visible on the raw read.
    if (this.releaseRemainingA > 0) {
      this.releaseRemainingA = Math.max(0, this.releaseRemainingA - microsPerTick)
    }
    if (this.releaseRemainingB > 0) {
      this.releaseRemainingB = Math.max(0, this.releaseRemainingB - microsPerTick)
    }

    // A held code goes once it has been on the port long enough
    if (this.holdRemainingA > 0) {
      this.holdRemainingA = Math.max(0, this.holdRemainingA - microsPerTick)
    }
    if (this.holdRemainingB > 0) {
      this.holdRemainingB = Math.max(0, this.holdRemainingB - microsPerTick)
    }
    if (this.unexplainedMicrosA >= 0) this.unexplainedMicrosA += microsPerTick
    if (this.unexplainedMicrosB >= 0) this.unexplainedMicrosB += microsPerTick

    // A key a stick is hiding is looked for again on every tick until the
    // firmware's view and the switches agree
    if (this.matrixDirty) this.sweep()

    // One port holds a code at a time; the next key waits for it. PS/2 first,
    // as the firmware tries it, and a PS/2 key a stick is holding back does not
    // hold up the matrix keyboard.
    if (this.holdRemainingA > 0 || this.holdRemainingB > 0) return
    if (!this.trySend('A')) this.trySend('B')
  }

  /** The lines a stick holds low on a port (1 = held). */
  private stickLows(port: 'A' | 'B'): number {
    return ~(this.portLines?.(port) ?? 0xFF) & 0xFF
  }

  /**
   * The lines of a port pulled low while `code` is on it: its 0 bits driven
   * low, the sticks, and every pull those carry through the held keys. For
   * the matrix keyboard's switches; a PS/2 keyboard has none in the matrix.
   */
  private pulledLow(port: 'A' | 'B', code: number, rows: readonly number[], withSticks: boolean): number {
    const drive = ~code & 0xFF
    const lowA = (port === 'A' ? drive : 0) | (withSticks ? this.stickLows('A') : 0)
    const lowB = (port === 'B' ? drive : 0) | (withSticks ? this.stickLows('B') : 0)
    const lows = pullThrough(rows, lowA, lowB)
    return port === 'A' ? lows.a : lows.b
  }

  /** Strobe the key at the head of a port's queue, unless its read-back fails. */
  private trySend(port: 'A' | 'B'): boolean {
    const enabled = port === 'A' ? this.enabledA : this.enabledB
    const queue = port === 'A' ? this.queueA : this.queueB
    if (!enabled || queue.length === 0) return false

    // The read-back: what the port's lines read with the code on them. A 1 bit
    // a stick holds low, or held keys join to a line the code drives low, reads
    // back 0, and nothing is strobed.
    const code = queue[0]!
    const lines = code & ~this.pulledLow(port, code, this.matrixHeld, true) & 0xFF
    if (lines !== code) {
      // The firmware waits as long as a held stick, or held keys it has seen
      // (its matrixPull()), explain the failure; otherwise for
      // UNEXPLAINED_WAIT_MICROS, then sends anyway.
      const known = this.stickLows(port) | this.pulledLow(port, code, this.matrixSeen, false)
      const explained = ((code & ~lines) & ~known) === 0
      const waited = port === 'A' ? this.unexplainedMicrosA : this.unexplainedMicrosB
      if (explained) {
        this.setUnexplained(port, -1)
        return false
      }
      if (waited < 0) {
        this.setUnexplained(port, 0)
        return false
      }
      if (waited < KeyboardEncoderAttachment.UNEXPLAINED_WAIT_MICROS) return false
    }

    queue.shift()
    this.setUnexplained(port, -1)
    if (port === 'A') {
      this.codeA = code
      this.holdRemainingA = KeyboardEncoderAttachment.HOLD_MICROS
      this.strobeA = true
    } else {
      this.codeB = code
      this.holdRemainingB = KeyboardEncoderAttachment.HOLD_MICROS
      this.strobeB = true
    }
    return true
  }

  private setUnexplained(port: 'A' | 'B', micros: number): void {
    if (port === 'A') this.unexplainedMicrosA = micros
    else this.unexplainedMicrosB = micros
  }

  /**
   * What a port reads while a code is on it: the code, less any 1 bit held
   * keys pull low through a line the code drives. (The sticks' own pull is the
   * joystick attachment's, which the VIA ANDs in.)
   */
  private heldCode(port: 'A' | 'B', code: number): number {
    if (this.matrixHeld.every((cols) => cols === 0)) return code
    return code & ~this.pulledLow(port, code, this.matrixHeld, true) & 0xFF
  }

  readPortA(ddrA: number, orA: number): number {
    // A code on the port: its 0 bits driven low, its 1s left to the pull-ups.
    // The VIA ANDs it with the stick, as the wires do.
    if (this.enabledA && this.holdRemainingA > 0) {
      return this.heldCode('A', this.codeA)
    }

    // Enable line went high but the encoder has not let go yet: it may still be
    // driving the port, so the stick is NOT visible. This is what makes "raise
    // the line and read in the next instruction" read stale data in emulation
    // the way it can on hardware.
    if (this.releaseRemainingA > 0) {
      return this.codeA
    }

    // Idle: every line an input with its pull-up, so the stick shows through.
    return 0xFF
  }

  readPortB(ddrB: number, orB: number): number {
    if (this.enabledB && this.holdRemainingB > 0) {
      return this.heldCode('B', this.codeB)
    }

    if (this.releaseRemainingB > 0) {
      return this.codeB
    }

    return 0xFF
  }

  updateControlLines(ca1: boolean, ca2: boolean, cb1: boolean, cb2: boolean): void {
    this.stateCA1 = ca1
    this.stateCA2 = ca2
    this.stateCB1 = cb1
    this.stateCB2 = cb2

    // Enabled when CA2 is LOW for Port A, CB2 LOW for Port B.
    const nextEnabledA = !ca2
    const nextEnabledB = !cb2

    // Falling edge of enable (line raised): a held code goes with the port, and
    // the release window opens, so the port goes on reading the encoder's last
    // code for releaseDelayMicros before the stick appears. Re-enabling reclaims
    // the port at once. Queued keys stay queued either way.
    if (this.enabledA && !nextEnabledA) {
      this.holdRemainingA = 0
      this.releaseRemainingA = this.releaseDelayMicros
    } else if (!this.enabledA && nextEnabledA) {
      this.releaseRemainingA = 0
    }

    if (this.enabledB && !nextEnabledB) {
      this.holdRemainingB = 0
      this.releaseRemainingB = this.releaseDelayMicros
    } else if (!this.enabledB && nextEnabledB) {
      this.releaseRemainingB = 0
    }

    this.enabledA = nextEnabledA
    this.enabledB = nextEnabledB
  }

  hasCA1Interrupt(): boolean {
    return this.strobeA
  }

  hasCB1Interrupt(): boolean {
    return this.strobeB
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
    if (this.activePort !== 'B') this.updatePS2Key(usbHidKeycode, pressed)
    if (this.activePort !== 'A') this.updateMatrixKey(usbHidKeycode, pressed)
  }

  /** The PS/2 keyboard on Port A: one code per key press, by its HID code. */
  private updatePS2Key(usbHidKeycode: number, pressed: boolean): void {
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

    // A full queue drops the new key and keeps the ones already waiting, as
    // the firmware does.
    this.queueKey(this.queueA, mappedValue)
  }

  /**
   * The matrix keyboard on Port B: the key's switches open or close, and the
   * firmware's sweep decides what it sees. A second press of a key already
   * down is the host's auto-repeat, which types the key again if the firmware
   * can see it (the machine's keyboard has no repeat of its own).
   */
  private updateMatrixKey(usbHidKeycode: number, pressed: boolean): void {
    const positions = KeyboardMatrixAttachment.positionsOf(usbHidKeycode)
    let repeat = pressed && positions.length > 0
    for (const [row, col] of positions) {
      const bit = 1 << col
      if (pressed) {
        if ((this.matrixHeld[row]! & bit) === 0) repeat = false
        this.matrixHeld[row] = this.matrixHeld[row]! | bit
      } else {
        this.matrixHeld[row] = this.matrixHeld[row]! & ~bit
      }
    }

    if (repeat) {
      for (const [row, col] of positions) {
        if ((this.matrixSeen[row]! & (1 << col)) !== 0) this.queueMatrixKey(row, col)
      }
      return
    }
    this.sweep()
  }

  /**
   * The firmware's sweep, without its timing: with no row driven, a line low is
   * a stick's (or a stick's pulled through a held key), and every key in such
   * a row or column is left as the firmware last saw it. Every other key is
   * seen as it is, and a key seen going down is typed.
   */
  private sweep(): void {
    const idle = pullThrough(this.matrixHeld, this.stickLows('A'), this.stickLows('B'))
    const before = this.matrixSeen
    const after = before.map((seen, row) =>
      (idle.a & (1 << row)) !== 0 ? seen : (seen & idle.b) | (this.matrixHeld[row]! & ~idle.b & 0xFF)
    )
    this.matrixSeen = after

    for (let row = 0; row < 8; row++) {
      const down = after[row]! & ~before[row]!
      if (down === 0) continue
      for (let col = 0; col < 8; col++) {
        if ((down & (1 << col)) !== 0) this.queueMatrixKey(row, col)
      }
    }

    this.matrixDirty = after.some((seen, row) => seen !== this.matrixHeld[row])
  }

  /** Queue the code for a matrix key, with the modifiers the firmware sees. */
  private queueMatrixKey(row: number, col: number): void {
    const code = this.mapMatrixKey(row, col)
    if (code !== 0xFF) this.queueKey(this.queueB, code)
  }

  /**
   * The firmware's mapMatrixToAscii(): $FF for a key that types nothing. Ctrl
   * wins over Shift, and Ctrl with a key that has no control code types
   * nothing.
   */
  private mapMatrixKey(row: number, col: number): number {
    const base = MATRIX_MAP[row]![col]!
    if (base === 0xFF || base === 0xFE) return 0xFF

    if ((this.matrixSeen[7]! & 0x01) !== 0) {
      if (base === 0x32) return 0x00 // Ctrl+2 = NUL
      if (base >= 0x41 && base <= 0x5A) return base - 0x40
      switch (base) {
        case 0x5B: return 0x1B // Ctrl+[ = ESC
        case 0x5C: return 0x1C // Ctrl+\ = FS
        case 0x5D: return 0x1D // Ctrl+] = GS
        case 0x36: return 0x1E // Ctrl+6 = RS
        case 0x2D: return 0x1F // Ctrl+- = US
      }
      return 0xFF
    }

    if ((this.matrixSeen[5]! & 0x10) !== 0) {
      const shifted = SHIFTED[base]
      if (shifted !== undefined) return shifted
    }
    return base
  }

  private queueKey(queue: number[], code: number): void {
    if (queue.length < KeyboardEncoderAttachment.QUEUE_SIZE) queue.push(code)
  }

  /** Keys waiting on a port, not counting one already on it. */
  queueLength(port: 'A' | 'B'): number {
    return port === 'A' ? this.queueA.length : this.queueB.length
  }

  /** True while a strobed code is on the port. */
  isHolding(port: 'A' | 'B'): boolean {
    return port === 'A'
      ? this.enabledA && this.holdRemainingA > 0
      : this.enabledB && this.holdRemainingB > 0
  }

  /**
   * True when every active port's queue has room for another key. What types
   * into the machine (`input.type`, the app's paste) waits for this, as a typist
   * would, instead of typing faster than the keyboard can hand keys over.
   */
  canTakeKey(): boolean {
    const size = KeyboardEncoderAttachment.QUEUE_SIZE
    if (this.activePort !== 'B' && this.queueA.length >= size) return false
    if (this.activePort !== 'A' && this.queueB.length >= size) return false
    return true
  }

  serialize(): DeviceState {
    return {
      ...super.serialize(),
      activePort: this.activePort,
      queueA: [...this.queueA],
      queueB: [...this.queueB],
      codeA: this.codeA,
      codeB: this.codeB,
      holdRemainingA: this.holdRemainingA,
      holdRemainingB: this.holdRemainingB,
      strobeA: this.strobeA,
      strobeB: this.strobeB,
      enabledA: this.enabledA,
      enabledB: this.enabledB,
      releaseDelayMicros: this.releaseDelayMicros,
      releaseRemainingA: this.releaseRemainingA,
      releaseRemainingB: this.releaseRemainingB,
      matrixHeld: [...this.matrixHeld],
      matrixSeen: [...this.matrixSeen],
      unexplainedMicrosA: this.unexplainedMicrosA,
      unexplainedMicrosB: this.unexplainedMicrosB,
      shiftPressed: this.shiftPressed,
      ctrlPressed: this.ctrlPressed,
      stateCA1: this.stateCA1,
      stateCA2: this.stateCA2,
      stateCB1: this.stateCB1,
      stateCB2: this.stateCB2
    }
  }

  deserialize(state: DeviceState): void {
    super.deserialize(state)
    expectKind(state, this.kind)

    const activePort = readString(state, 'activePort')
    if (activePort !== 'A' && activePort !== 'B' && activePort !== 'both') {
      throw new StateError(`keyboard-encoder.activePort: expected A, B or both, got "${activePort}"`)
    }
    this.activePort = activePort

    this.enabledA = readBoolean(state, 'enabledA')
    this.enabledB = readBoolean(state, 'enabledB')

    if (state.queueA !== undefined) {
      this.queueA = readByteList(state, 'queueA').slice(0, KeyboardEncoderAttachment.QUEUE_SIZE)
      this.queueB = readByteList(state, 'queueB').slice(0, KeyboardEncoderAttachment.QUEUE_SIZE)
      this.codeA = readNumber(state, 'codeA')
      this.codeB = readNumber(state, 'codeB')
      this.holdRemainingA = readNumber(state, 'holdRemainingA')
      this.holdRemainingB = readNumber(state, 'holdRemainingB')
      this.strobeA = readBoolean(state, 'strobeA')
      this.strobeB = readBoolean(state, 'strobeB')
    } else {
      // A snapshot from before the encoder queued (version 1-3): one byte per
      // port and a flag for whether the 6502 had read it. An unread byte on an
      // enabled port was strobed, so it is on the port; on a disabled one it
      // never went out, so it is queued.
      this.codeA = readNumber(state, 'asciiDataA')
      this.codeB = readNumber(state, 'asciiDataB')
      const readyA = readBoolean(state, 'dataReadyA')
      const readyB = readBoolean(state, 'dataReadyB')
      this.queueA = readyA && !this.enabledA ? [this.codeA] : []
      this.queueB = readyB && !this.enabledB ? [this.codeB] : []
      this.holdRemainingA = readyA && this.enabledA ? KeyboardEncoderAttachment.HOLD_MICROS : 0
      this.holdRemainingB = readyB && this.enabledB ? KeyboardEncoderAttachment.HOLD_MICROS : 0
      this.strobeA = false
      this.strobeB = false
    }

    this.releaseDelayMicros = readNumber(state, 'releaseDelayMicros')
    this.releaseRemainingA = readNumber(state, 'releaseRemainingA')
    this.releaseRemainingB = readNumber(state, 'releaseRemainingB')

    // The matrix keyboard's switches and the firmware's view of them. A state
    // saved before they were kept had every key up.
    if (state.matrixHeld !== undefined) {
      this.matrixHeld = readByteList(state, 'matrixHeld').slice(0, 8)
      this.matrixSeen = readByteList(state, 'matrixSeen').slice(0, 8)
      this.unexplainedMicrosA = readNumber(state, 'unexplainedMicrosA')
      this.unexplainedMicrosB = readNumber(state, 'unexplainedMicrosB')
    } else {
      this.matrixHeld = [0, 0, 0, 0, 0, 0, 0, 0]
      this.matrixSeen = [0, 0, 0, 0, 0, 0, 0, 0]
      this.unexplainedMicrosA = -1
      this.unexplainedMicrosB = -1
    }
    while (this.matrixHeld.length < 8) this.matrixHeld.push(0)
    while (this.matrixSeen.length < 8) this.matrixSeen.push(0)
    this.matrixDirty = this.matrixSeen.some((seen, row) => seen !== this.matrixHeld[row])
    this.shiftPressed = readBoolean(state, 'shiftPressed')
    this.ctrlPressed = readBoolean(state, 'ctrlPressed')
    this.stateCA1 = readBoolean(state, 'stateCA1')
    this.stateCA2 = readBoolean(state, 'stateCA2')
    this.stateCB1 = readBoolean(state, 'stateCB1')
    this.stateCB2 = readBoolean(state, 'stateCB2')
  }
}
