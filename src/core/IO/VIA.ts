import { IO } from '../IO'
import { Attachment } from './Attachments/Attachment'

/**
 * VIA - Emulates the 6522 VIA (Versatile Interface Adapter)
 * 
 * The 6522 VIA provides:
 * - Two 8-bit bidirectional I/O ports (Port A and Port B)
 * - Two 16-bit timers with interrupt generation
 * - Shift register for serial I/O
 * - Handshaking lines for data transfer
 */
export class VIA implements IO {
  // VIA Register addresses (offset from base address)
  private static readonly VIA_ORB = 0x00      // Output Register B
  private static readonly VIA_ORA = 0x01      // Output Register A
  private static readonly VIA_DDRB = 0x02     // Data Direction Register B
  private static readonly VIA_DDRA = 0x03     // Data Direction Register A
  private static readonly VIA_T1CL = 0x04     // Timer 1 Counter Low
  private static readonly VIA_T1CH = 0x05     // Timer 1 Counter High
  private static readonly VIA_T1LL = 0x06     // Timer 1 Latch Low
  private static readonly VIA_T1LH = 0x07     // Timer 1 Latch High
  private static readonly VIA_T2CL = 0x08     // Timer 2 Counter Low
  private static readonly VIA_T2CH = 0x09     // Timer 2 Counter High
  private static readonly VIA_SR = 0x0A       // Shift Register
  private static readonly VIA_ACR = 0x0B      // Auxiliary Control Register
  private static readonly VIA_PCR = 0x0C      // Peripheral Control Register
  private static readonly VIA_IFR = 0x0D      // Interrupt Flag Register
  private static readonly VIA_IER = 0x0E      // Interrupt Enable Register
  private static readonly VIA_ORA_NH = 0x0F   // Output Register A (No Handshake)

  // Interrupt flags
  private static readonly IRQ_CA2 = 0x01
  private static readonly IRQ_CA1 = 0x02
  private static readonly IRQ_SR = 0x04
  private static readonly IRQ_CB2 = 0x08
  private static readonly IRQ_CB1 = 0x10
  private static readonly IRQ_T2 = 0x20
  private static readonly IRQ_T1 = 0x40
  private static readonly IRQ_IRQ = 0x80      // Master IRQ flag

  private static readonly MAX_ATTACHMENTS_PER_PORT = 8

  // VIA Registers
  private regORB: number = 0x00
  private regORA: number = 0x00
  private regDDRB: number = 0x00
  private regDDRA: number = 0x00
  private regT1C: number = 0xFFFF
  private regT1L: number = 0xFFFF
  private regT2C: number = 0xFFFF
  private regT2L: number = 0xFF
  private regSR: number = 0x00
  private regACR: number = 0x00
  private regPCR: number = 0x00
  private regIFR: number = 0x00
  private regIER: number = 0x00

  // Control lines
  private CA1: boolean = false
  private CA2: boolean = false
  private CB1: boolean = false
  private CB2: boolean = false

  // Timer states
  private T1_running: boolean = false
  private T2_running: boolean = false
  private T1_IRQ_enabled: boolean = false
  private T2_IRQ_enabled: boolean = false

  // Timing
  private tickCounter: number = 0
  private ticksPerMicrosecond: number = 1

  // Attachments
  private portA_attachments: (Attachment | null)[] = []
  private portB_attachments: (Attachment | null)[] = []
  private portA_attachmentCount: number = 0
  private portB_attachmentCount: number = 0

  constructor() {
    this.reset(true)
  }

  reset(coldStart: boolean): void {
    // Reset all VIA registers
    this.regORB = 0x00
    this.regORA = 0x00
    this.regDDRB = 0x00
    this.regDDRA = 0x00
    this.regT1C = 0xFFFF
    this.regT1L = 0xFFFF
    this.regT2C = 0xFFFF
    this.regT2L = 0xFF
    this.regSR = 0x00
    this.regACR = 0x00
    this.regPCR = 0x00
    this.regIFR = 0x00
    this.regIER = 0x00

    // Reset control lines
    this.CA1 = false
    this.CA2 = false
    this.CB1 = false
    this.CB2 = false

    // Reset timer states
    this.T1_running = false
    this.T2_running = false
    this.T1_IRQ_enabled = false
    this.T2_IRQ_enabled = false

    // Reset all attachments (keep registrations — they represent physical wiring)
    for (let i = 0; i < this.portA_attachmentCount; i++) {
      if (this.portA_attachments[i] !== null) {
        this.portA_attachments[i]!.reset()
      }
    }
    for (let i = 0; i < this.portB_attachmentCount; i++) {
      if (this.portB_attachments[i] !== null) {
        this.portB_attachments[i]!.reset()
      }
    }

    // Re-notify attachments of current (reset) control line states
    this.notifyAttachmentsControlLines()

    // Reset timing
    this.tickCounter = 0
    this.ticksPerMicrosecond = 1
  }

  read(address: number): number {
    const reg = address & 0x0F
    let value = 0x00

    switch (reg) {
      case VIA.VIA_ORB:
        // Reading ORB clears CB1 and CB2 interrupt flags
        this.clearIRQFlag(VIA.IRQ_CB1 | VIA.IRQ_CB2)
        value = this.readPortB()
        // Notify attachments that interrupts were cleared
        for (let i = 0; i < this.portB_attachmentCount; i++) {
          if (this.portB_attachments[i] !== null) {
            this.portB_attachments[i]!.clearInterrupts(false, false, true, true)
          }
        }
        break

      case VIA.VIA_ORA:
        // Reading ORA clears CA1 and CA2 interrupt flags
        this.clearIRQFlag(VIA.IRQ_CA1 | VIA.IRQ_CA2)
        value = this.readPortA()
        // Notify attachments that interrupts were cleared
        for (let i = 0; i < this.portA_attachmentCount; i++) {
          if (this.portA_attachments[i] !== null) {
            this.portA_attachments[i]!.clearInterrupts(true, true, false, false)
          }
        }
        break

      case VIA.VIA_DDRB:
        value = this.regDDRB
        break

      case VIA.VIA_DDRA:
        value = this.regDDRA
        break

      case VIA.VIA_T1CL:
        // Reading T1CL clears T1 interrupt flag
        this.clearIRQFlag(VIA.IRQ_T1)
        value = this.regT1C & 0xFF
        break

      case VIA.VIA_T1CH:
        value = (this.regT1C >> 8) & 0xFF
        break

      case VIA.VIA_T1LL:
        value = this.regT1L & 0xFF
        break

      case VIA.VIA_T1LH:
        value = (this.regT1L >> 8) & 0xFF
        break

      case VIA.VIA_T2CL:
        // Reading T2CL clears T2 interrupt flag
        this.clearIRQFlag(VIA.IRQ_T2)
        value = this.regT2C & 0xFF
        break

      case VIA.VIA_T2CH:
        value = (this.regT2C >> 8) & 0xFF
        break

      case VIA.VIA_SR:
        // Reading SR clears SR interrupt flag
        this.clearIRQFlag(VIA.IRQ_SR)
        value = this.regSR
        break

      case VIA.VIA_ACR:
        value = this.regACR
        break

      case VIA.VIA_PCR:
        value = this.regPCR
        break

      case VIA.VIA_IFR:
        value = this.regIFR
        // Bit 7 is set if any enabled interrupt is active
        if (this.regIFR & this.regIER & 0x7F) {
          value |= VIA.IRQ_IRQ
        }
        break

      case VIA.VIA_IER:
        value = this.regIER | 0x80  // Bit 7 always reads as 1
        break

      case VIA.VIA_ORA_NH:
        // Reading ORA without handshake (no interrupt flag clearing)
        value = this.readPortA()
        break
    }

    return value & 0xFF
  }

  write(address: number, data: number): void {
    const reg = address & 0x0F
    const value = data & 0xFF

    switch (reg) {
      case VIA.VIA_ORB:
        // Writing ORB clears CB1 and CB2 interrupt flags
        this.clearIRQFlag(VIA.IRQ_CB1 | VIA.IRQ_CB2)
        this.regORB = value
        this.writePortB(value)
        break

      case VIA.VIA_ORA:
        // Writing ORA clears CA1 and CA2 interrupt flags
        this.clearIRQFlag(VIA.IRQ_CA1 | VIA.IRQ_CA2)
        this.regORA = value
        this.writePortA(value)
        break

      case VIA.VIA_DDRB:
        this.regDDRB = value
        break

      case VIA.VIA_DDRA:
        this.regDDRA = value
        break

      case VIA.VIA_T1CL:
      case VIA.VIA_T1LL:
        // Write to T1 low latch
        this.regT1L = (this.regT1L & 0xFF00) | value
        break

      case VIA.VIA_T1CH:
        // Write to T1 high counter - loads latch into counter and starts timer
        this.regT1L = (this.regT1L & 0x00FF) | (value << 8)
        this.regT1C = this.regT1L
        this.clearIRQFlag(VIA.IRQ_T1)
        this.T1_running = true
        break

      case VIA.VIA_T1LH:
        // Write to T1 high latch
        this.regT1L = (this.regT1L & 0x00FF) | (value << 8)
        this.clearIRQFlag(VIA.IRQ_T1)
        break

      case VIA.VIA_T2CL:
        // Write to T2 low latch
        this.regT2L = value
        break

      case VIA.VIA_T2CH:
        // Write to T2 high counter - loads latch into counter and starts timer
        this.regT2C = (value << 8) | this.regT2L
        this.clearIRQFlag(VIA.IRQ_T2)
        this.T2_running = true
        break

      case VIA.VIA_SR:
        this.regSR = value
        this.clearIRQFlag(VIA.IRQ_SR)
        break

      case VIA.VIA_ACR:
        this.regACR = value
        // ACR controls timer modes, shift register, and latching
        break

      case VIA.VIA_PCR:
        this.regPCR = value
        // PCR controls CA1, CA2, CB1, CB2 behavior
        this.updateCA2()
        this.updateCB2()
        break

      case VIA.VIA_IFR:
        // Writing to IFR clears the corresponding interrupt flags
        this.regIFR &= ~(value & 0x7F)
        this.updateIRQ()
        break

      case VIA.VIA_IER:
        // Bit 7 determines set (1) or clear (0)
        if (value & 0x80) {
          this.regIER |= (value & 0x7F)
        } else {
          this.regIER &= ~(value & 0x7F)
        }
        this.updateIRQ()
        break

      case VIA.VIA_ORA_NH:
        // Writing ORA without handshake (no interrupt flag clearing)
        this.regORA = value
        this.writePortA(value)
        break
    }
  }

  tick(frequency: number): number {
    this.tickCounter++

    // Update Timer 1
    if (this.T1_running && this.regT1C > 0) {
      this.regT1C--
      if (this.regT1C <= 0) {
        this.setIRQFlag(VIA.IRQ_T1)

        // Check if timer is in free-run mode (ACR bit 6)
        if (this.regACR & 0x40) {
          this.regT1C = this.regT1L + this.regT1C  // Reload from latch, carry over undershoot
        } else {
          this.regT1C = 0
          this.T1_running = false
        }

        // Toggle PB7 if enabled (ACR bit 7)
        if (this.regACR & 0x80) {
          this.regORB ^= 0x80
        }
      }
    }

    // Update Timer 2
    if (this.T2_running && this.regT2C > 0) {
      this.regT2C--
      if (this.regT2C <= 0) {
        this.setIRQFlag(VIA.IRQ_T2)
        this.regT2C = 0
        this.T2_running = false
      }
    }

    // Tick all attachments
    for (let i = 0; i < this.portA_attachmentCount; i++) {
      if (this.portA_attachments[i] !== null) {
        this.portA_attachments[i]!.tick(frequency)
      }
    }
    for (let i = 0; i < this.portB_attachmentCount; i++) {
      if (this.portB_attachments[i] !== null) {
        this.portB_attachments[i]!.tick(frequency)
      }
    }

    // Check for attachment interrupts
    for (let i = 0; i < this.portA_attachmentCount; i++) {
      if (this.portA_attachments[i] !== null) {
        if (this.portA_attachments[i]!.hasCA1Interrupt()) {
          this.setIRQFlag(VIA.IRQ_CA1)
        }
        if (this.portA_attachments[i]!.hasCA2Interrupt()) {
          this.setIRQFlag(VIA.IRQ_CA2)
        }
      }
    }
    for (let i = 0; i < this.portB_attachmentCount; i++) {
      if (this.portB_attachments[i] !== null) {
        if (this.portB_attachments[i]!.hasCB1Interrupt()) {
          this.setIRQFlag(VIA.IRQ_CB1)
        }
        if (this.portB_attachments[i]!.hasCB2Interrupt()) {
          this.setIRQFlag(VIA.IRQ_CB2)
        }
      }
    }

    // Return IRQ status if any enabled interrupt is active
    if (this.regIFR & this.regIER & 0x7F) {
      return 0x80
    }
    return 0
  }

  private updateIRQ(): void {
    // Update bit 7 of IFR based on enabled interrupts
    if (this.regIFR & this.regIER & 0x7F) {
      this.regIFR |= VIA.IRQ_IRQ
    } else {
      this.regIFR &= ~VIA.IRQ_IRQ
    }
  }

  private setIRQFlag(flag: number): void {
    this.regIFR |= flag
    this.updateIRQ()
  }

  private clearIRQFlag(flag: number): void {
    this.regIFR &= ~flag
    this.updateIRQ()
  }

  private readPortA(): number {
    let value = 0xFF

    // Determine input sources from attachments (priority-based multiplexing)
    let externalInput = 0xFF

    // Query all Port A attachments in priority order
    for (let i = 0; i < this.portA_attachmentCount; i++) {
      if (this.portA_attachments[i] !== null && this.portA_attachments[i]!.isEnabled()) {
        const attachmentData = this.portA_attachments[i]!.readPortA(this.regDDRA, this.regORA)
        // First enabled attachment with data (not 0xFF) wins, or AND all values together
        externalInput &= attachmentData
      }
    }

    // Apply DDR settings: output bits come from ORA, input bits from external
    for (let bit = 0; bit < 8; bit++) {
      if (this.regDDRA & (1 << bit)) {
        // Output mode - read from register
        if (this.regORA & (1 << bit)) {
          value |= (1 << bit)
        } else {
          value &= ~(1 << bit)
        }
      } else {
        // Input mode - read from external source
        if (externalInput & (1 << bit)) {
          value |= (1 << bit)
        } else {
          value &= ~(1 << bit)
        }
      }
    }

    return value & 0xFF
  }

  private readPortB(): number {
    let value = 0xFF

    // Determine input sources from attachments (priority-based multiplexing)
    let externalInput = 0xFF

    // Query all Port B attachments in priority order
    for (let i = 0; i < this.portB_attachmentCount; i++) {
      if (this.portB_attachments[i] !== null && this.portB_attachments[i]!.isEnabled()) {
        const attachmentData = this.portB_attachments[i]!.readPortB(this.regDDRB, this.regORB)
        // First enabled attachment with data (not 0xFF) wins, or AND all values together
        externalInput &= attachmentData
      }
    }

    // Apply DDR settings: output bits come from ORB, input bits from external
    for (let bit = 0; bit < 8; bit++) {
      if (this.regDDRB & (1 << bit)) {
        // Output mode - read from register
        if (this.regORB & (1 << bit)) {
          value |= (1 << bit)
        } else {
          value &= ~(1 << bit)
        }
      } else {
        // Input mode - read from external source
        if (externalInput & (1 << bit)) {
          value |= (1 << bit)
        } else {
          value &= ~(1 << bit)
        }
      }
    }

    return value & 0xFF
  }

  private writePortA(value: number): void {
    // Notify all Port A attachments of the write
    for (let i = 0; i < this.portA_attachmentCount; i++) {
      if (this.portA_attachments[i] !== null) {
        this.portA_attachments[i]!.writePortA(value, this.regDDRA)
      }
    }
  }

  private writePortB(value: number): void {
    // Notify all Port B attachments of the write
    for (let i = 0; i < this.portB_attachmentCount; i++) {
      if (this.portB_attachments[i] !== null) {
        this.portB_attachments[i]!.writePortB(value, this.regDDRB)
      }
    }
  }

  private updateCA2(): void {
    // CA2 control based on PCR bits 1-3
    const ca2_control = (this.regPCR >> 1) & 0x07

    switch (ca2_control) {
      case 0x00:  // Input mode - negative edge
      case 0x01:  // Independent interrupt input - negative edge
      case 0x02:  // Input mode - positive edge
      case 0x03:  // Independent interrupt input - positive edge
        // Input modes
        break

      case 0x04:  // Handshake output
      case 0x05:  // Pulse output
        // Output modes
        break

      case 0x06:  // Manual output LOW
        this.CA2 = false
        break

      case 0x07:  // Manual output HIGH
        this.CA2 = true
        break
    }

    // Notify all attachments of control line changes
    this.notifyAttachmentsControlLines()
  }

  private updateCB2(): void {
    // CB2 control based on PCR bits 5-7
    const cb2_control = (this.regPCR >> 5) & 0x07

    switch (cb2_control) {
      case 0x00:  // Input mode - negative edge
      case 0x01:  // Independent interrupt input - negative edge
      case 0x02:  // Input mode - positive edge
      case 0x03:  // Independent interrupt input - positive edge
        // Input modes
        break

      case 0x04:  // Handshake output
      case 0x05:  // Pulse output
        // Output modes
        break

      case 0x06:  // Manual output LOW
        this.CB2 = false
        break

      case 0x07:  // Manual output HIGH
        this.CB2 = true
        break
    }

    // Notify all attachments of control line changes
    this.notifyAttachmentsControlLines()
  }

  private notifyAttachmentsControlLines(): void {
    // Notify all attachments of control line state changes
    for (let i = 0; i < this.portA_attachmentCount; i++) {
      if (this.portA_attachments[i] !== null) {
        this.portA_attachments[i]!.updateControlLines(this.CA1, this.CA2, this.CB1, this.CB2)
      }
    }
    for (let i = 0; i < this.portB_attachmentCount; i++) {
      if (this.portB_attachments[i] !== null) {
        this.portB_attachments[i]!.updateControlLines(this.CA1, this.CA2, this.CB1, this.CB2)
      }
    }
  }

  private sortAttachmentsByPriority(): void {
    // Simple bubble sort for Port A attachments by priority (lower = higher priority)
    for (let i = 0; i < this.portA_attachmentCount - 1; i++) {
      for (let j = 0; j < this.portA_attachmentCount - i - 1; j++) {
        if (this.portA_attachments[j] !== null && this.portA_attachments[j + 1] !== null) {
          if (this.portA_attachments[j]!.getPriority() > this.portA_attachments[j + 1]!.getPriority()) {
            // Swap
            const temp = this.portA_attachments[j]
            this.portA_attachments[j] = this.portA_attachments[j + 1]
            this.portA_attachments[j + 1] = temp
          }
        }
      }
    }

    // Simple bubble sort for Port B attachments by priority
    for (let i = 0; i < this.portB_attachmentCount - 1; i++) {
      for (let j = 0; j < this.portB_attachmentCount - i - 1; j++) {
        if (this.portB_attachments[j] !== null && this.portB_attachments[j + 1] !== null) {
          if (this.portB_attachments[j]!.getPriority() > this.portB_attachments[j + 1]!.getPriority()) {
            // Swap
            const temp = this.portB_attachments[j]
            this.portB_attachments[j] = this.portB_attachments[j + 1]
            this.portB_attachments[j + 1] = temp
          }
        }
      }
    }
  }

  /**
   * Attach a GPIO device to Port A
   * @param attachment - The attachment to add
   */
  attachToPortA(attachment: Attachment): void {
    if (attachment !== null && this.portA_attachmentCount < VIA.MAX_ATTACHMENTS_PER_PORT) {
      this.portA_attachments[this.portA_attachmentCount++] = attachment
      this.sortAttachmentsByPriority()
      // Notify the attachment of current control line states
      attachment.updateControlLines(this.CA1, this.CA2, this.CB1, this.CB2)
    }
  }

  /**
   * Attach a GPIO device to Port B
   * @param attachment - The attachment to add
   */
  attachToPortB(attachment: Attachment): void {
    if (attachment !== null && this.portB_attachmentCount < VIA.MAX_ATTACHMENTS_PER_PORT) {
      this.portB_attachments[this.portB_attachmentCount++] = attachment
      this.sortAttachmentsByPriority()
      // Notify the attachment of current control line states
      attachment.updateControlLines(this.CA1, this.CA2, this.CB1, this.CB2)
    }
  }

  /**
   * Get a Port A attachment by index
   * @param index - The attachment index
   * @returns The attachment or null if not found
   */
  getPortAAttachment(index: number): Attachment | null {
    if (index < this.portA_attachmentCount) {
      return this.portA_attachments[index]
    }
    return null
  }

  /**
   * Get a Port B attachment by index
   * @param index - The attachment index
   * @returns The attachment or null if not found
   */
  getPortBAttachment(index: number): Attachment | null {
    if (index < this.portB_attachmentCount) {
      return this.portB_attachments[index]
    }
    return null
  }
}