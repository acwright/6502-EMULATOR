import { KeypadAttachment } from '../../../components/IO/Attachments/KeypadAttachment'

describe('KeypadAttachment', () => {
  let keypadA: KeypadAttachment   // attached to Port A
  let keypadB: KeypadAttachment   // attached to Port B

  beforeEach(() => {
    keypadA = new KeypadAttachment(true, 0)
    keypadB = new KeypadAttachment(false, 0)
  })

  // ---------------------------------------------------------------------------
  describe('Initialization', () => {
    it('should have no data ready after construction', () => {
      expect(keypadA.hasDataReady()).toBe(false)
      expect(keypadB.hasDataReady()).toBe(false)
    })

    it('should have no interrupt pending after construction', () => {
      expect(keypadA.hasCA1Interrupt()).toBe(false)
      expect(keypadA.hasCB1Interrupt()).toBe(false)
      expect(keypadB.hasCA1Interrupt()).toBe(false)
      expect(keypadB.hasCB1Interrupt()).toBe(false)
    })

    it('should return 0xFF on port reads when idle (Port A)', () => {
      expect(keypadA.readPortA(0x00, 0x00)).toBe(0xFF)
    })

    it('should return 0xFF on port reads when idle (Port B)', () => {
      expect(keypadB.readPortB(0x00, 0x00)).toBe(0xFF)
    })

    it('should be enabled by default', () => {
      expect(keypadA.isEnabled()).toBe(true)
    })

    it('should report the correct priority', () => {
      const kp = new KeypadAttachment(true, 7)
      expect(kp.getPriority()).toBe(7)
    })

    it('getCurrentKey should return 0xFF when no data is ready', () => {
      expect(keypadA.getCurrentKey()).toBe(0xFF)
    })
  })

  // ---------------------------------------------------------------------------
  describe('Reset', () => {
    it('should clear data ready, interrupt, and keypad value', () => {
      keypadA.updateKey(0x1E, true)  // press '1'
      expect(keypadA.hasDataReady()).toBe(true)

      keypadA.reset()

      expect(keypadA.hasDataReady()).toBe(false)
      expect(keypadA.hasCA1Interrupt()).toBe(false)
      expect(keypadA.getCurrentKey()).toBe(0xFF)
    })
  })

  // ---------------------------------------------------------------------------
  describe('Key press → keypad value mapping', () => {
    // Helpers: assert OE (CA2/CB2 LOW) then press and read
    const pressAndReadA = (kp: KeypadAttachment, hid: number) => {
      kp.updateControlLines(false, false, false, true)  // CA2 LOW → OE asserted for Port A
      kp.updateKey(hid, true)
      return kp.readPortA(0x00, 0x00)
    }
    const pressAndReadB = (kp: KeypadAttachment, hid: number) => {
      kp.updateControlLines(false, true, false, false)  // CB2 LOW → OE asserted for Port B
      kp.updateKey(hid, true)
      return kp.readPortB(0x00, 0x00)
    }

    it('Left Arrow (0x50) → $00  ◄', () => {
      expect(pressAndReadA(new KeypadAttachment(true), 0x50)).toBe(0x00)
    })

    it('Backspace is not on this keypad', () => {
      const kp = new KeypadAttachment(true)
      kp.updateControlLines(false, false, false, true)
      kp.updateKey(0x2A, true)  // Backspace – unmapped
      expect(kp.readPortA(0x00, 0x00)).toBe(0xFF)
    })

    it('1 (0x1E) → $01', () => {
      expect(pressAndReadA(new KeypadAttachment(true), 0x1E)).toBe(0x01)
    })

    it('2 (0x1F) → $02', () => {
      expect(pressAndReadA(new KeypadAttachment(true), 0x1F)).toBe(0x02)
    })

    it('3 (0x20) → $03', () => {
      expect(pressAndReadA(new KeypadAttachment(true), 0x20)).toBe(0x03)
    })

    it('4 (0x21) → $04', () => {
      expect(pressAndReadA(new KeypadAttachment(true), 0x21)).toBe(0x04)
    })

    it('5 (0x22) → $05', () => {
      expect(pressAndReadA(new KeypadAttachment(true), 0x22)).toBe(0x05)
    })

    it('6 (0x23) → $06', () => {
      expect(pressAndReadA(new KeypadAttachment(true), 0x23)).toBe(0x06)
    })

    it('7 (0x24) → $07', () => {
      expect(pressAndReadA(new KeypadAttachment(true), 0x24)).toBe(0x07)
    })

    it('8 (0x25) → $08', () => {
      expect(pressAndReadA(new KeypadAttachment(true), 0x25)).toBe(0x08)
    })

    it('9 (0x26) → $09', () => {
      expect(pressAndReadA(new KeypadAttachment(true), 0x26)).toBe(0x09)
    })

    it('0 (0x27) → $0A', () => {
      expect(pressAndReadA(new KeypadAttachment(true), 0x27)).toBe(0x0A)
    })

    it('Right Arrow (0x4F) → $0B  ►', () => {
      expect(pressAndReadA(new KeypadAttachment(true), 0x4F)).toBe(0x0B)
    })

    it('Enter is not mapped to $0B (it maps to $14)', () => {
      const kp = new KeypadAttachment(true)
      kp.updateControlLines(false, false, false, true)
      kp.updateKey(0x28, true)  // Enter → $14
      expect(kp.readPortA(0x00, 0x00)).toBe(0x14)
    })

    it('f (0x09) → $0C  F', () => {
      expect(pressAndReadA(new KeypadAttachment(true), 0x09)).toBe(0x0C)
    })

    it('e (0x08) → $0D  E', () => {
      expect(pressAndReadA(new KeypadAttachment(true), 0x08)).toBe(0x0D)
    })

    it('d (0x07) → $0E  D', () => {
      expect(pressAndReadA(new KeypadAttachment(true), 0x07)).toBe(0x0E)
    })

    it('c (0x06) → $0F  C', () => {
      expect(pressAndReadA(new KeypadAttachment(true), 0x06)).toBe(0x0F)
    })

    it('Escape (0x29) → $10  ESC', () => {
      expect(pressAndReadA(new KeypadAttachment(true), 0x29)).toBe(0x10)
    })

    it('Insert (0x49) → $11  INS', () => {
      expect(pressAndReadA(new KeypadAttachment(true), 0x49)).toBe(0x11)
    })

    it('Page Up (0x4B) → $12  PGUP', () => {
      expect(pressAndReadA(new KeypadAttachment(true), 0x4B)).toBe(0x12)
    })

    it('a (0x04) → $13  A', () => {
      expect(pressAndReadA(new KeypadAttachment(true), 0x04)).toBe(0x13)
    })

    it('Up Arrow (0x52) → $14  ▲', () => {
      expect(pressAndReadA(new KeypadAttachment(true), 0x52)).toBe(0x14)
    })

    it('Enter (0x28) → $14  ▲', () => {
      expect(pressAndReadA(new KeypadAttachment(true), 0x28)).toBe(0x14)
    })

    it('Delete (0x4C) → $15  DEL', () => {
      expect(pressAndReadA(new KeypadAttachment(true), 0x4C)).toBe(0x15)
    })

    it('Page Down (0x4E) → $16  PGDN', () => {
      expect(pressAndReadA(new KeypadAttachment(true), 0x4E)).toBe(0x16)
    })

    it('b (0x05) → $17  B', () => {
      expect(pressAndReadA(new KeypadAttachment(true), 0x05)).toBe(0x17)
    })

    it('should also map correctly on Port B', () => {
      expect(pressAndReadB(new KeypadAttachment(false), 0x1E)).toBe(0x01)  // '1' → $01
      expect(pressAndReadB(new KeypadAttachment(false), 0x05)).toBe(0x17)  // 'b' → $17
    })
  })

  // ---------------------------------------------------------------------------
  describe('Bits 5–7 are always 0 when data is present', () => {
    it('should mask bits 5–7 to 0 on Port A reads', () => {
      keypadA.updateControlLines(false, false, false, true)  // CA2 LOW → OE asserted
      keypadA.updateKey(0x05, true)  // HID 0x05 (b) → keypad $17 = 0b10111 – highest valid code
      const value = keypadA.readPortA(0x00, 0x00)
      expect(value & 0xE0).toBe(0x00)  // bits 5, 6, 7 must be 0
    })

    it('should mask bits 5–7 to 0 on Port B reads', () => {
      keypadB.updateControlLines(false, true, false, false)  // CB2 LOW → OE asserted
      keypadB.updateKey(0x05, true)  // HID 0x05 (b) → keypad $17
      const value = keypadB.readPortB(0x00, 0x00)
      expect(value & 0xE0).toBe(0x00)
    })

    it('getCurrentKey should never have bits 5–7 set', () => {
      keypadA.updateKey(0x29, true)  // HID 0x29 (Escape) → keypad $10; bit 4 set
      expect(keypadA.getCurrentKey() & 0xE0).toBe(0x00)  // getCurrentKey is independent of OE
    })
  })

  // ---------------------------------------------------------------------------
  describe('Port attachment routing', () => {
    it('Port A attachment should not drive Port B', () => {
      keypadA.updateKey(0x1E, true)  // press '1'
      expect(keypadA.readPortB(0x00, 0x00)).toBe(0xFF)
    })

    it('Port B attachment should not drive Port A', () => {
      keypadB.updateKey(0x1E, true)  // press '1'
      expect(keypadB.readPortA(0x00, 0x00)).toBe(0xFF)
    })
  })

  // ---------------------------------------------------------------------------
  describe('Interrupt behaviour (Port A)', () => {
    it('should assert CA1 after a key press', () => {
      keypadA.updateKey(0x1E, true)
      expect(keypadA.hasCA1Interrupt()).toBe(true)
    })

    it('should not assert CB1 when attached to Port A', () => {
      keypadA.updateKey(0x1E, true)
      expect(keypadA.hasCB1Interrupt()).toBe(false)
    })

    it('clearInterrupts(ca1) should deassert CA1 and clear data ready', () => {
      keypadA.updateKey(0x1E, true)
      keypadA.clearInterrupts(true, false, false, false)
      expect(keypadA.hasCA1Interrupt()).toBe(false)
      expect(keypadA.hasDataReady()).toBe(false)
    })

    it('clearInterrupts(cb1) should not affect CA1 keypad', () => {
      keypadA.updateKey(0x1E, true)
      keypadA.clearInterrupts(false, false, true, false)  // wrong line
      expect(keypadA.hasCA1Interrupt()).toBe(true)
      expect(keypadA.hasDataReady()).toBe(true)
    })

    it('port reads after clearInterrupts should return 0xFF', () => {
      keypadA.updateKey(0x1E, true)
      keypadA.clearInterrupts(true, false, false, false)
      expect(keypadA.readPortA(0x00, 0x00)).toBe(0xFF)
    })
  })

  // ---------------------------------------------------------------------------
  describe('Interrupt behaviour (Port B)', () => {
    it('should assert CB1 after a key press', () => {
      keypadB.updateKey(0x1E, true)
      expect(keypadB.hasCB1Interrupt()).toBe(true)
    })

    it('should not assert CA1 when attached to Port B', () => {
      keypadB.updateKey(0x1E, true)
      expect(keypadB.hasCA1Interrupt()).toBe(false)
    })

    it('clearInterrupts(cb1) should deassert CB1 and clear data ready', () => {
      keypadB.updateKey(0x1E, true)
      keypadB.clearInterrupts(false, false, true, false)
      expect(keypadB.hasCB1Interrupt()).toBe(false)
      expect(keypadB.hasDataReady()).toBe(false)
    })

    it('clearInterrupts(ca1) should not affect CB1 keypad', () => {
      keypadB.updateKey(0x1E, true)
      keypadB.clearInterrupts(true, false, false, false)  // wrong line
      expect(keypadB.hasCB1Interrupt()).toBe(true)
      expect(keypadB.hasDataReady()).toBe(true)
    })
  })

  // ---------------------------------------------------------------------------
  describe('Key release events', () => {
    it('should not set dataReady on key release', () => {
      keypadA.updateKey(0x1E, false)
      expect(keypadA.hasDataReady()).toBe(false)
    })

    it('should not change the port value on key release', () => {
      // Press then read, then release – port stays at 0xFF (interrupt already fired)
      keypadA.updateKey(0x1E, true)
      keypadA.clearInterrupts(true, false, false, false)
      keypadA.updateKey(0x1E, false)  // release
      expect(keypadA.readPortA(0x00, 0x00)).toBe(0xFF)
    })
  })

  // ---------------------------------------------------------------------------
  describe('Unmapped keys', () => {
    it('should not set dataReady for a key not on the keypad', () => {
      keypadA.updateKey(0x3A, true)  // F1 – not on this keypad
      expect(keypadA.hasDataReady()).toBe(false)
      expect(keypadA.readPortA(0x00, 0x00)).toBe(0xFF)
    })

    it('should not fire an interrupt for an unmapped key', () => {
      keypadA.updateKey(0x3A, true)
      expect(keypadA.hasCA1Interrupt()).toBe(false)
    })
  })

  // ---------------------------------------------------------------------------
  describe('Successive key presses', () => {
    it('should latch the latest key code when a second key is pressed', () => {
      keypadA.updateControlLines(false, false, false, true)  // CA2 LOW → OE asserted
      keypadA.updateKey(0x1E, true)  // '1' → $01
      keypadA.clearInterrupts(true, false, false, false)

      keypadA.updateKey(0x1F, true)  // '2' → $02
      expect(keypadA.readPortA(0x00, 0x00)).toBe(0x02)
      expect(keypadA.hasCA1Interrupt()).toBe(true)
    })
  })

  // ---------------------------------------------------------------------------
  describe('OE (Output Enable) via CA2/CB2', () => {
    it('Port A: data is not driven when CA2 is HIGH (OE disabled)', () => {
      keypadA.updateControlLines(false, true, false, true)  // CA2 HIGH → OE deasserted
      keypadA.updateKey(0x1E, true)  // '1'
      expect(keypadA.readPortA(0x00, 0x00)).toBe(0xFF)
    })

    it('Port A: data IS driven when CA2 is LOW (OE enabled)', () => {
      keypadA.updateControlLines(false, false, false, true)  // CA2 LOW → OE asserted
      keypadA.updateKey(0x1E, true)
      expect(keypadA.readPortA(0x00, 0x00)).toBe(0x01)
    })

    it('Port B: data is not driven when CB2 is HIGH (OE disabled)', () => {
      keypadB.updateControlLines(false, true, false, true)  // CB2 HIGH → OE deasserted
      keypadB.updateKey(0x1E, true)
      expect(keypadB.readPortB(0x00, 0x00)).toBe(0xFF)
    })

    it('Port B: data IS driven when CB2 is LOW (OE enabled)', () => {
      keypadB.updateControlLines(false, true, false, false)  // CB2 LOW → OE asserted
      keypadB.updateKey(0x1E, true)
      expect(keypadB.readPortB(0x00, 0x00)).toBe(0x01)
    })

    it('CA1 interrupt fires regardless of OE state', () => {
      keypadA.updateControlLines(false, true, false, true)  // OE disabled
      keypadA.updateKey(0x1E, true)
      expect(keypadA.hasCA1Interrupt()).toBe(true)  // DA line is independent of OE
    })

    it('CB1 interrupt fires regardless of OE state', () => {
      keypadB.updateControlLines(false, true, false, true)  // OE disabled
      keypadB.updateKey(0x1E, true)
      expect(keypadB.hasCB1Interrupt()).toBe(true)
    })

    it('toggling OE HIGH then LOW reveals the latched value', () => {
      keypadA.updateKey(0x20, true)  // '3' → $03
      // OE still disabled – bus should be high-Z
      expect(keypadA.readPortA(0x00, 0x00)).toBe(0xFF)
      // Now the 6522 asserts CA2 LOW to enable OE
      keypadA.updateControlLines(false, false, false, true)
      expect(keypadA.readPortA(0x00, 0x00)).toBe(0x03)
    })

    it('reset clears OE state to disabled', () => {
      keypadA.updateControlLines(false, false, false, true)  // OE asserted
      keypadA.updateKey(0x1E, true)
      keypadA.reset()
      // After reset OE should be HIGH (disabled) and dataReady cleared
      expect(keypadA.readPortA(0x00, 0x00)).toBe(0xFF)
    })
  })
})
