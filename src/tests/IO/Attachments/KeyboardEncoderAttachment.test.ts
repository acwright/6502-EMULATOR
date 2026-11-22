import { KeyboardEncoderAttachment } from '../../../core/IO/Attachments/KeyboardEncoderAttachment'

describe('KeyboardEncoderAttachment', () => {
  let encoder: KeyboardEncoderAttachment

  // Joystick lines on each port, active low, as the machine wires them in
  let linesA: number
  let linesB: number

  const HOLD = KeyboardEncoderAttachment.HOLD_MICROS

  /** Both encoders enabled: CA2 and CB2 low */
  const enableBoth = (): void => encoder.updateControlLines(false, false, false, false)
  /** Both encoders told to let go: CA2 and CB2 high, as KBDisable does */
  const disableBoth = (): void => encoder.updateControlLines(false, true, false, true)

  /** Advance by whole microseconds at 1 MHz */
  const micros = (n: number): void => {
    for (let i = 0; i < n; i++) encoder.tick(1_000_000)
  }
  /** One tick 20 ms long: ends a held code, and sends the next key if one waits */
  const step = (): void => encoder.tick(1_000_000 / HOLD)

  /** Type a key (press and release) and return what Port A reads once it is sent */
  const typeA = (hid: number): number => {
    encoder.updateKey(hid, true)
    encoder.updateKey(hid, false)
    step()
    return encoder.readPortA(0xFF, 0x00)
  }

  beforeEach(() => {
    encoder = new KeyboardEncoderAttachment(5)
    encoder.activePort = 'A'
    linesA = 0xFF
    linesB = 0xFF
    encoder.portLines = (port) => (port === 'A' ? linesA : linesB)
  })

  describe('Initialization', () => {
    it('defaults to Port B only', () => {
      const fresh = new KeyboardEncoderAttachment(5)
      expect(fresh.activePort).toBe('B')
    })

    it('starts with nothing queued, nothing on the ports and no strobe', () => {
      expect(encoder.queueLength('A')).toBe(0)
      expect(encoder.queueLength('B')).toBe(0)
      expect(encoder.isHolding('A')).toBe(false)
      expect(encoder.hasCA1Interrupt()).toBe(false)
      expect(encoder.hasCB1Interrupt()).toBe(false)
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0xFF)
      expect(encoder.readPortB(0xFF, 0x00)).toBe(0xFF)
    })

    it('has the priority it was given', () => {
      expect(encoder.getPriority()).toBe(5)
    })
  })

  describe('Reset', () => {
    it('clears the queues, the held code and the modifiers', () => {
      enableBoth()
      encoder.updateKey(0xE1, true)  // Left Shift down
      encoder.updateKey(0x04, true)  // 'A'
      encoder.updateKey(0x05, true)  // 'B'
      step()
      expect(encoder.isHolding('A')).toBe(true)
      expect(encoder.queueLength('A')).toBe(1)

      encoder.reset()
      expect(encoder.queueLength('A')).toBe(0)
      expect(encoder.isHolding('A')).toBe(false)

      // Shift is released too: '1' is '1', not '!'
      enableBoth()
      expect(typeA(0x1E)).toBe(0x31)
    })
  })

  describe('Sending a key', () => {
    it('queues a key and strobes it on the next tick', () => {
      enableBoth()
      encoder.updateKey(0x04, true)  // 'A'
      expect(encoder.queueLength('A')).toBe(1)
      expect(encoder.hasCA1Interrupt()).toBe(false)

      encoder.tick(1_000_000)
      expect(encoder.queueLength('A')).toBe(0)
      expect(encoder.hasCA1Interrupt()).toBe(true)
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x41)
    })

    it('strobes for one tick only: the flag is the VIA\'s from then on', () => {
      enableBoth()
      encoder.updateKey(0x04, true)
      encoder.tick(1_000_000)
      expect(encoder.hasCA1Interrupt()).toBe(true)
      encoder.tick(1_000_000)
      expect(encoder.hasCA1Interrupt()).toBe(false)
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x41)  // still on the port
    })

    it('uses CB1 and Port B for the matrix keyboard', () => {
      encoder.activePort = 'B'
      enableBoth()
      encoder.updateKey(0x04, true)
      encoder.tick(1_000_000)
      expect(encoder.hasCB1Interrupt()).toBe(true)
      expect(encoder.hasCA1Interrupt()).toBe(false)
      expect(encoder.readPortB(0xFF, 0x00)).toBe(0x41)
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0xFF)
    })

    it('sends nothing on a disabled port, and sends the key once it is enabled', () => {
      disableBoth()
      micros(200)
      encoder.updateKey(0x04, true)
      encoder.tick(1_000_000)
      expect(encoder.hasCA1Interrupt()).toBe(false)
      expect(encoder.queueLength('A')).toBe(1)

      enableBoth()
      encoder.tick(1_000_000)
      expect(encoder.hasCA1Interrupt()).toBe(true)
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x41)
    })

    it('reading the port does not take the key back', () => {
      enableBoth()
      encoder.updateKey(0x04, true)
      encoder.tick(1_000_000)
      encoder.clearInterrupts(true, false, false, false)  // the VIA's ORA read
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x41)
      expect(encoder.queueLength('A')).toBe(0)
    })
  })

  describe('Holding a code for 20 ms', () => {
    beforeEach(() => {
      enableBoth()
      encoder.updateKey(0x04, true)  // 'A'
      encoder.tick(1_000_000)
    })

    it('keeps the code on the port for the whole hold, then reads idle', () => {
      micros(HOLD - 2)
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x41)
      micros(2)
      expect(encoder.isHolding('A')).toBe(false)
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0xFF)
    })

    it('sends the next key only once the hold is over', () => {
      encoder.updateKey(0x05, true)  // 'B'
      micros(HOLD - 2)
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x41)
      expect(encoder.queueLength('A')).toBe(1)
      micros(2)  // the tick that ends the hold sends the next key
      expect(encoder.hasCA1Interrupt()).toBe(true)
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x42)
    })

    it('holds one port at a time: a matrix key waits for a PS/2 code', () => {
      encoder.activePort = 'B'
      encoder.updateKey(0x05, true)  // 'B', on Port B
      micros(100)
      expect(encoder.isHolding('B')).toBe(false)
      expect(encoder.queueLength('B')).toBe(1)
      micros(HOLD)
      expect(encoder.isHolding('B')).toBe(true)
      expect(encoder.readPortB(0xFF, 0x00)).toBe(0x42)
    })

    it('scales the hold with the CPU clock', () => {
      for (let i = 0; i < 2 * HOLD - 4; i++) encoder.tick(2_000_000)
      expect(encoder.isHolding('A')).toBe(true)
      for (let i = 0; i < 4; i++) encoder.tick(2_000_000)
      expect(encoder.isHolding('A')).toBe(false)
    })
  })

  describe('A held stick holds a key back', () => {
    beforeEach(() => {
      enableBoth()
    })

    it('waits while the stick holds one of the code\'s 1 bits low, then sends it right', () => {
      linesA = 0xFF & ~0x40  // left held: bit 6, which every letter has
      encoder.updateKey(0x0B, true)  // 'H' = $48
      micros(1000)
      expect(encoder.hasCA1Interrupt()).toBe(false)
      expect(encoder.queueLength('A')).toBe(1)
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0xFF)

      linesA = 0xFF
      encoder.tick(1_000_000)
      expect(encoder.hasCA1Interrupt()).toBe(true)
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x48)
    })

    it('sends at once when the stick holds only lines the code has as 0', () => {
      linesA = 0xFF & ~0x80  // right held: no key code sets bit 7
      encoder.updateKey(0x0B, true)  // 'H'
      encoder.tick(1_000_000)
      expect(encoder.hasCA1Interrupt()).toBe(true)
    })

    it('keeps the keys typed behind a waiting key waiting, in order', () => {
      linesA = 0xFF & ~0x40  // left held
      encoder.updateKey(0x0B, true)  // 'H', waits
      encoder.updateKey(0x1E, true)  // '1' = $31, has no bit 6, but is behind 'H'
      micros(1000)
      expect(encoder.queueLength('A')).toBe(2)

      linesA = 0xFF
      encoder.tick(1_000_000)
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x48)
      step()
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x31)
    })

    it('does not hold up the other keyboard', () => {
      encoder.activePort = 'both'
      linesA = 0xFF & ~0x40  // joystick 2 holds left on Port A
      encoder.updateKey(0x0B, true)  // 'H' on both ports
      encoder.tick(1_000_000)
      expect(encoder.hasCA1Interrupt()).toBe(false)
      expect(encoder.hasCB1Interrupt()).toBe(true)
      expect(encoder.readPortB(0xFF, 0x00)).toBe(0x48)
    })

    it('turns C with left held into a late C, not a Ctrl-C', () => {
      linesA = 0xFF & ~0x40
      encoder.updateKey(0x06, true)  // 'C' = $43; $03 if bit 6 were lost
      micros(500)
      linesA = 0xFF
      encoder.tick(1_000_000)
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x43)
    })
  })

  describe('A full queue', () => {
    it('holds 16 keys, drops new ones and keeps the oldest', () => {
      disableBoth()  // nothing goes out while disabled, so they all queue
      const size = KeyboardEncoderAttachment.QUEUE_SIZE
      for (let i = 0; i < size; i++) encoder.updateKey(0x04 + i, true)  // A..P
      expect(encoder.canTakeKey()).toBe(false)
      encoder.updateKey(0x1D, true)  // 'Z', dropped
      expect(encoder.queueLength('A')).toBe(size)

      enableBoth()
      const sent: number[] = []
      for (let i = 0; i < size + 1; i++) {
        step()
        if (encoder.isHolding('A')) sent.push(encoder.readPortA(0xFF, 0x00))
      }
      expect(sent).toEqual(Array.from({ length: size }, (_, i) => 0x41 + i))
    })

    it('has room again once a key has gone out', () => {
      disableBoth()
      for (let i = 0; i < KeyboardEncoderAttachment.QUEUE_SIZE; i++) encoder.updateKey(0x04, true)
      expect(encoder.canTakeKey()).toBe(false)
      enableBoth()
      encoder.tick(1_000_000)
      expect(encoder.canTakeKey()).toBe(true)
    })

    it('counts only the active port\'s queue', () => {
      encoder.activePort = 'B'
      disableBoth()
      for (let i = 0; i < KeyboardEncoderAttachment.QUEUE_SIZE; i++) encoder.updateKey(0x04, true)
      expect(encoder.queueLength('A')).toBe(0)
      expect(encoder.canTakeKey()).toBe(false)
    })
  })

  describe('Letter Key Mapping', () => {
    beforeEach(() => {
      encoder.updateControlLines(false, false, false, false)
    })

    it('should output uppercase letters A-Z', () => {
      // 'A' (HID 0x04)
      expect(typeA(0x04)).toBe(0x41)
      // 'Z' (HID 0x1D)
      expect(typeA(0x1D)).toBe(0x5A)
    })

    it('should output uppercase letters even with Shift held', () => {
      encoder.updateKey(0xE1, true)  // Left Shift down
      expect(typeA(0x04)).toBe(0x41)  // Still uppercase A
      expect(typeA(0x10)).toBe(0x4D)  // Still uppercase M
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
        expect(typeA(hid)).toBe(ascii)
      }
    })
  })

  describe('Number Key Mapping', () => {
    beforeEach(() => {
      encoder.updateControlLines(false, false, false, false)
    })

    it('should map numbers correctly', () => {
      expect(typeA(0x1E)).toBe(0x31)
      expect(typeA(0x27)).toBe(0x30)
    })

    it('should map all number keys 0-9', () => {
      const numberMap: [number, number][] = [
        [0x1E, 0x31], [0x1F, 0x32], [0x20, 0x33], [0x21, 0x34],
        [0x22, 0x35], [0x23, 0x36], [0x24, 0x37], [0x25, 0x38],
        [0x26, 0x39], [0x27, 0x30],
      ]
      for (const [hid, ascii] of numberMap) {
        expect(typeA(hid)).toBe(ascii)
      }
    })
  })

  describe('Special Key Mapping', () => {
    beforeEach(() => {
      encoder.updateControlLines(false, false, false, false)
    })

    it('should map Enter to CR (0x0D)', () => {
      expect(typeA(0x28)).toBe(0x0D)
    })

    it('should map Escape to ESC (0x1B)', () => {
      expect(typeA(0x29)).toBe(0x1B)
    })

    it('should map Backspace to BS (0x08)', () => {
      expect(typeA(0x2A)).toBe(0x08)
    })

    it('should map Tab to HT (0x09)', () => {
      expect(typeA(0x2B)).toBe(0x09)
    })

    it('should map Space to SP (0x20)', () => {
      expect(typeA(0x2C)).toBe(0x20)
    })

    it('should map Delete to DEL (0x7F)', () => {
      expect(typeA(0x4C)).toBe(0x7F)
    })

    it('should map Insert to SUB (0x1A)', () => {
      expect(typeA(0x49)).toBe(0x1A)
    })

    it('should map arrow keys correctly', () => {
      expect(typeA(0x4F)).toBe(0x1D)
      expect(typeA(0x50)).toBe(0x1C)
      expect(typeA(0x51)).toBe(0x1F)
      expect(typeA(0x52)).toBe(0x1E)
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
        expect(typeA(hid)).toBe(ascii)
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
        expect(typeA(hid)).toBe(ascii)
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
        expect(typeA(hid)).toBe(ascii)
      }
    })

    it('should not change letter output when Shift is held (already uppercase)', () => {
      expect(typeA(0x04)).toBe(0x41)  // Still 'A'
    })

    it('should track right Shift the same as left Shift', () => {
      encoder.updateKey(0xE1, false)  // Release left Shift
      encoder.updateKey(0xE5, true)   // Right Shift down
      expect(typeA(0x1E)).toBe(0x21)  // '!'
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
        expect(typeA(hid)).toBe(ascii)
      }
    })

    it('should produce Ctrl+C = 0x03 (BASIC break)', () => {
      expect(typeA(0x06)).toBe(0x03)
    })

    it('should produce Ctrl+2 = NUL (0x00)', () => {
      expect(typeA(0x1F)).toBe(0x00)
    })

    it('should produce Ctrl+6 = RS (0x1E)', () => {
      expect(typeA(0x23)).toBe(0x1E)
    })

    it('should produce Ctrl+- = US (0x1F)', () => {
      expect(typeA(0x2D)).toBe(0x1F)
    })

    it('should produce Ctrl+[ = ESC (0x1B)', () => {
      expect(typeA(0x2F)).toBe(0x1B)
    })

    it('should produce Ctrl+\\ = FS (0x1C)', () => {
      expect(typeA(0x31)).toBe(0x1C)
    })

    it('should produce Ctrl+] = GS (0x1D)', () => {
      expect(typeA(0x30)).toBe(0x1D)
    })

    it('should track right Ctrl the same as left Ctrl', () => {
      encoder.updateKey(0xE0, false)  // Release left Ctrl
      encoder.updateKey(0xE4, true)   // Right Ctrl down
      expect(typeA(0x04)).toBe(0x01)  // Ctrl+A
    })
  })

  describe('Modifier Key Behavior', () => {
    beforeEach(() => {
      enableBoth()
    })

    it('queues nothing for Ctrl or Shift alone', () => {
      encoder.updateKey(0xE0, true)
      encoder.updateKey(0xE0, false)
      encoder.updateKey(0xE1, true)
      encoder.updateKey(0xE1, false)
      expect(encoder.queueLength('A')).toBe(0)
    })

    it('queues nothing for a key release', () => {
      encoder.updateKey(0x04, true)
      expect(encoder.queueLength('A')).toBe(1)
      encoder.updateKey(0x04, false)
      expect(encoder.queueLength('A')).toBe(1)
    })

    it('ignores Alt (no output, no modifier effect)', () => {
      encoder.updateKey(0xE2, true)
      expect(encoder.queueLength('A')).toBe(0)
      expect(typeA(0x04)).toBe(0x41)
    })

    it('ignores Caps Lock, GUI and keys with no mapping', () => {
      encoder.updateKey(0x39, true)  // Caps Lock
      encoder.updateKey(0xE3, true)  // Left GUI
      encoder.updateKey(0x3A, true)  // F1
      expect(encoder.queueLength('A')).toBe(0)
    })

    it('applies the modifier held when the key was typed', () => {
      encoder.updateKey(0xE0, true)  // Ctrl down
      expect(typeA(0x06)).toBe(0x03)  // Ctrl+C
      encoder.updateKey(0xE0, false)  // Ctrl up
      expect(typeA(0x06)).toBe(0x43)  // C
    })

    it('sends Ctrl+2 as NUL (0x00)', () => {
      encoder.updateKey(0xE0, true)
      expect(typeA(0x1F)).toBe(0x00)
      expect(encoder.isHolding('A')).toBe(true)
    })
  })

  describe('Active Port Selection', () => {
    beforeEach(() => {
      enableBoth()
    })

    it('queues on both ports when activePort is both', () => {
      encoder.activePort = 'both'
      encoder.updateKey(0x04, true)
      expect(encoder.queueLength('A')).toBe(1)
      expect(encoder.queueLength('B')).toBe(1)
    })

    it('queues on Port A only when activePort is A', () => {
      encoder.activePort = 'A'
      encoder.updateKey(0x04, true)
      expect(encoder.queueLength('A')).toBe(1)
      expect(encoder.queueLength('B')).toBe(0)
    })

    it('queues on Port B only when activePort is B', () => {
      encoder.activePort = 'B'
      encoder.updateKey(0x04, true)
      expect(encoder.queueLength('A')).toBe(0)
      expect(encoder.queueLength('B')).toBe(1)
    })
  })

  // The single most important behaviour for the joystick-read contract: the
  // encoder must NOT release the port the instant the enable line goes high.
  // Real firmware polls CB2/CA2 and takes tens of microseconds; an emulator with
  // zero latency certifies a BIOS settle wait that cannot run on hardware.
  describe('Release latency (§3.1)', () => {
    beforeEach(() => {
      encoder.activePort = 'both'
      enableBoth()
      encoder.updateKey(0x04, true)  // 'A' = 0x41
      step()  // on Port A
      step()  // and then on Port B
      expect(encoder.readPortB(0xFF, 0x00)).toBe(0x41)
    })

    it('still owns the port immediately after the enable line is raised', () => {
      disableBoth()
      expect(encoder.readPortB(0xFF, 0x00)).toBe(0x41)
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x41)
    })

    it('holds the port for the whole settle delay, then releases it', () => {
      encoder.releaseDelayMicros = 100
      disableBoth()
      micros(99)
      expect(encoder.readPortB(0xFF, 0x00)).toBe(0x41)
      micros(2)
      expect(encoder.readPortB(0xFF, 0x00)).toBe(0xFF)
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0xFF)
    })

    it('scales the settle delay with the CPU clock', () => {
      encoder.releaseDelayMicros = 100
      disableBoth()
      for (let i = 0; i < 199; i++) encoder.tick(2_000_000)
      expect(encoder.readPortB(0xFF, 0x00)).toBe(0x41)  // still owned at 99.5 µs
      encoder.tick(2_000_000)
      encoder.tick(2_000_000)
      expect(encoder.readPortB(0xFF, 0x00)).toBe(0xFF)  // released past 100 µs
    })
  })

  // A program that has not read a strobed code before it takes the port for a
  // joystick read loses it, as on the board: raising CA2/CB2 ends the hold, and
  // nothing is sent again on re-enable. Keys still queued are not lost.
  describe('Taking the port for a joystick read', () => {
    beforeEach(() => {
      enableBoth()
    })

    it('ends a held code: after re-enabling, the port reads idle', () => {
      encoder.updateKey(0x04, true)
      encoder.tick(1_000_000)
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x41)

      disableBoth()
      micros(200)
      enableBoth()
      expect(encoder.isHolding('A')).toBe(false)
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0xFF)
      encoder.tick(1_000_000)
      expect(encoder.hasCA1Interrupt()).toBe(false)
    })

    it('keeps queued keys, and sends them once the port is back', () => {
      encoder.updateKey(0x04, true)  // 'A', sent
      encoder.updateKey(0x05, true)  // 'B', queued behind it
      encoder.tick(1_000_000)

      disableBoth()
      micros(200)
      enableBoth()
      encoder.tick(1_000_000)
      expect(encoder.hasCA1Interrupt()).toBe(true)
      expect(encoder.readPortA(0xFF, 0x00)).toBe(0x42)
    })
  })

  describe('Saved state', () => {
    it('round-trips the queues and the held code', () => {
      encoder.activePort = 'both'
      enableBoth()
      encoder.updateKey(0x04, true)
      encoder.updateKey(0x05, true)
      encoder.tick(1_000_000)
      micros(1234)

      const copy = new KeyboardEncoderAttachment(5)
      copy.deserialize(encoder.serialize())
      expect(copy.serialize()).toEqual(encoder.serialize())
      expect(copy.readPortA(0xFF, 0x00)).toBe(0x41)
      expect(copy.queueLength('A')).toBe(1)
      expect(copy.queueLength('B')).toBe(2)
    })

    it('reads a version 1-3 state: an unread byte on an enabled port is on the port', () => {
      const legacy = {
        kind: 'keyboard-encoder', enabled: true,
        ca1Interrupt: false, ca2Interrupt: false, cb1Interrupt: false, cb2Interrupt: false,
        activePort: 'B',
        asciiDataA: 0, dataReadyA: false, interruptPendingA: false, enabledA: true,
        asciiDataB: 0x48, dataReadyB: true, interruptPendingB: true, enabledB: true,
        releaseDelayMicros: 100, releaseRemainingA: 0, releaseRemainingB: 0,
        shiftPressed: false, ctrlPressed: false,
        stateCA1: false, stateCA2: false, stateCB1: false, stateCB2: false
      }
      encoder.deserialize(legacy)
      expect(encoder.isHolding('B')).toBe(true)
      expect(encoder.readPortB(0xFF, 0x00)).toBe(0x48)
      expect(encoder.queueLength('B')).toBe(0)
    })

    it('reads a version 1-3 state: an unread byte on a disabled port is queued', () => {
      const legacy = {
        kind: 'keyboard-encoder', enabled: true,
        ca1Interrupt: false, ca2Interrupt: false, cb1Interrupt: false, cb2Interrupt: false,
        activePort: 'B',
        asciiDataA: 0, dataReadyA: false, interruptPendingA: false, enabledA: false,
        asciiDataB: 0x48, dataReadyB: true, interruptPendingB: false, enabledB: false,
        releaseDelayMicros: 100, releaseRemainingA: 0, releaseRemainingB: 0,
        shiftPressed: false, ctrlPressed: false,
        stateCA1: false, stateCA2: true, stateCB1: false, stateCB2: true
      }
      encoder.deserialize(legacy)
      expect(encoder.isHolding('B')).toBe(false)
      expect(encoder.queueLength('B')).toBe(1)
    })
  })
})
