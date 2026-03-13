import { AttachmentBase } from './Attachment'

/**
 * USB HID keycode to keypad value mapping
 * Maps USB HID usage IDs to the 5-bit keypad codes ($00-$17) per the 6502 Keypad Mapping table
 *
 * Keypad layout (4 columns × 6 rows = 24 keys):
 *   $00 = ◄  $01=1  $02=2  $03=3
 *   $04 = 4  $05=5  $06=6  $07=7
 *   $08 = 8  $09=9  $0A=0  $0B=►
 *   $0C = F  $0D=E  $0E=D  $0F=C
 *   $10 = ESC  $11=INS  $12=PGUP  $13=A
 *   $14 = ▲/Enter  $15=DEL  $16=PGDN  $17=B
 */
const USB_HID_TO_KEYPAD: { [key: number]: number } = {
  0x50: 0x00,  // Left Arrow → ◄
  0x1E: 0x01,  // 1
  0x1F: 0x02,  // 2
  0x20: 0x03,  // 3
  0x21: 0x04,  // 4
  0x22: 0x05,  // 5
  0x23: 0x06,  // 6
  0x24: 0x07,  // 7
  0x25: 0x08,  // 8
  0x26: 0x09,  // 9
  0x27: 0x0A,  // 0
  0x4F: 0x0B,  // Right Arrow → ►
  0x09: 0x0C,  // f → F
  0x08: 0x0D,  // e → E
  0x07: 0x0E,  // d → D
  0x06: 0x0F,  // c → C
  0x29: 0x10,  // Escape → ESC
  0x49: 0x11,  // Insert → INS
  0x4B: 0x12,  // Page Up → PGUP
  0x04: 0x13,  // a → A
  0x52: 0x14,  // Up Arrow → ▲
  0x28: 0x14,  // Enter → ▲
  0x4C: 0x15,  // Delete → DEL
  0x4E: 0x16,  // Page Down → PGDN
  0x05: 0x17,  // b → B
}

/**
 * KeypadAttachment - Emulates a 4×6 matrix keypad with a built-in hardware encoder
 *
 * The encoder converts a key press into a 5-bit code (PA0–PA4) that appears on the GPIO
 * port.  Bits 5–7 are never driven by the keypad and always read as 0 when data is present.
 *
 * Behaviour mirrors a typical 74C922-style encoder:
 * - On key press  → the 5-bit keypad code is latched and a CA1/CB1 interrupt is asserted
 * - On port read  → the latched code is returned on bits 0–4 (bits 5–7 = 0)
 * - clearInterrupts → clears the interrupt and the data-ready latch
 * - Key releases  → ignored (encoder only reports on the falling edge of a keypress)
 *
 * The attachment may be wired to either Port A or Port B via the constructor parameter.
 * CA1/CB1 is the DA (Data Available) interrupt line from the 74C922.
 * CA2/CB2 is connected to the 74C922 OE (Output Enable) pin; data is only driven onto the
 * bus when OE is asserted LOW by the 6522.
 */
export class KeypadAttachment extends AttachmentBase {
  private keypadValue: number = 0x00
  private dataReady: boolean = false
  private interruptPending: boolean = false
  private readonly attachedToPortA: boolean

  // OE state: CA2 for Port A, CB2 for Port B.  HIGH = output disabled (default).
  private oeState: boolean = true

  constructor(attachToPortA: boolean = true, priority: number = 0) {
    super(priority, false, false, false, false)
    this.attachedToPortA = attachToPortA
    this.reset()
  }

  reset(): void {
    super.reset()
    this.keypadValue = 0x00
    this.dataReady = false
    this.interruptPending = false
    this.oeState = true  // OE disabled until explicitly asserted by the 6522
  }

  updateControlLines(ca1: boolean, ca2: boolean, cb1: boolean, cb2: boolean): void {
    // CA2 controls OE for Port A; CB2 controls OE for Port B.
    // 74C922 OE is active-LOW, so a LOW signal enables the output.
    this.oeState = this.attachedToPortA ? ca2 : cb2
  }

  readPortA(ddr: number, or: number): number {
    // Only drive the bus when attached to Port A, OE is asserted (LOW), and data is latched
    if (this.attachedToPortA && !this.oeState && this.dataReady) {
      return this.keypadValue & 0x1F  // bits 0–4 only; bits 5–7 = 0
    }
    return 0xFF  // not driving the bus
  }

  readPortB(ddr: number, or: number): number {
    // Only drive the bus when attached to Port B, OE is asserted (LOW), and data is latched
    if (!this.attachedToPortA && !this.oeState && this.dataReady) {
      return this.keypadValue & 0x1F  // bits 0–4 only; bits 5–7 = 0
    }
    return 0xFF  // not driving the bus
  }

  hasCA1Interrupt(): boolean {
    return this.attachedToPortA && this.interruptPending
  }

  hasCB1Interrupt(): boolean {
    return !this.attachedToPortA && this.interruptPending
  }

  clearInterrupts(ca1: boolean, ca2: boolean, cb1: boolean, cb2: boolean): void {
    if ((this.attachedToPortA && ca1) || (!this.attachedToPortA && cb1)) {
      this.interruptPending = false
      this.dataReady = false
    }
  }

  /**
   * Notify the attachment of a USB HID key event.
   * Key releases are ignored; only presses generate output on the GPIO port.
   *
   * @param usbHidKeycode - USB HID usage ID for the key
   * @param pressed       - true for key-down, false for key-up
   */
  updateKey(usbHidKeycode: number, pressed: boolean): void {
    if (!pressed) {
      return
    }

    const keypadCode = USB_HID_TO_KEYPAD[usbHidKeycode]
    if (keypadCode === undefined) {
      return  // key is not present on this keypad
    }

    this.keypadValue = keypadCode
    this.dataReady = true
    this.interruptPending = true
  }

  /**
   * Returns the current latched keypad code (bits 0–4) or 0xFF if no data is ready.
   */
  getCurrentKey(): number {
    return this.dataReady ? (this.keypadValue & 0x1F) : 0xFF
  }

  /** Returns true when a key has been pressed and the latch has not yet been cleared. */
  hasDataReady(): boolean {
    return this.dataReady
  }
}
