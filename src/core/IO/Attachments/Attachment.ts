/**
 * Interface for devices that can be attached to GPIO ports
 */
export interface Attachment {
  /**
   * Reset the attachment to its initial state
   */
  reset(): void

  /**
   * Update the attachment state based on CPU clock ticks
   * @param cpuFrequency - The CPU frequency in Hz
   */
  tick(cpuFrequency: number): void

  /**
   * Read data from Port A
   * @param ddr - Data Direction Register value
   * @param or - Output Register value
   * @returns The data to be read from the port
   */
  readPortA(ddr: number, or: number): number

  /**
   * Read data from Port B
   * @param ddr - Data Direction Register value
   * @param or - Output Register value
   * @returns The data to be read from the port
   */
  readPortB(ddr: number, or: number): number

  /**
   * Write data to Port A
   * @param value - The value being written
   * @param ddr - Data Direction Register value
   */
  writePortA(value: number, ddr: number): void

  /**
   * Write data to Port B
   * @param value - The value being written
   * @param ddr - Data Direction Register value
   */
  writePortB(value: number, ddr: number): void

  /**
   * Check if the attachment is enabled
   * @returns true if enabled, false otherwise
   */
  isEnabled(): boolean

  /**
   * Get the priority of this attachment (lower values = higher priority)
   * @returns The priority value
   */
  getPriority(): number

  /**
   * Clear interrupt flags
   * @param ca1 - Clear CA1 interrupt
   * @param ca2 - Clear CA2 interrupt
   * @param cb1 - Clear CB1 interrupt
   * @param cb2 - Clear CB2 interrupt
   */
  clearInterrupts(ca1: boolean, ca2: boolean, cb1: boolean, cb2: boolean): void

  /**
   * Update control line states
   * @param ca1 - CA1 control line state
   * @param ca2 - CA2 control line state
   * @param cb1 - CB1 control line state
   * @param cb2 - CB2 control line state
   */
  updateControlLines(ca1: boolean, ca2: boolean, cb1: boolean, cb2: boolean): void

  /**
   * Check if CA1 interrupt is pending
   * @returns true if interrupt is pending
   */
  hasCA1Interrupt(): boolean

  /**
   * Check if CA2 interrupt is pending
   * @returns true if interrupt is pending
   */
  hasCA2Interrupt(): boolean

  /**
   * Check if CB1 interrupt is pending
   * @returns true if interrupt is pending
   */
  hasCB1Interrupt(): boolean

  /**
   * Check if CB2 interrupt is pending
   * @returns true if interrupt is pending
   */
  hasCB2Interrupt(): boolean
}

/**
 * Base abstract class for GPIO attachments with common functionality
 */
export abstract class AttachmentBase implements Attachment {
  protected priority: number
  protected enabled: boolean
  protected ca1Interrupt: boolean
  protected ca2Interrupt: boolean
  protected cb1Interrupt: boolean
  protected cb2Interrupt: boolean

  constructor(
    priority: number,
    ca1Interrupt: boolean = false,
    ca2Interrupt: boolean = false,
    cb1Interrupt: boolean = false,
    cb2Interrupt: boolean = false
  ) {
    this.priority = priority
    this.enabled = true
    this.ca1Interrupt = ca1Interrupt
    this.ca2Interrupt = ca2Interrupt
    this.cb1Interrupt = cb1Interrupt
    this.cb2Interrupt = cb2Interrupt
  }

  reset(): void {
    this.enabled = true
    this.ca1Interrupt = false
    this.ca2Interrupt = false
    this.cb1Interrupt = false
    this.cb2Interrupt = false
  }

  tick(cpuFrequency: number): void {
    // Default: no action
  }

  readPortA(ddr: number, or: number): number {
    return 0xFF
  }

  readPortB(ddr: number, or: number): number {
    return 0xFF
  }

  writePortA(value: number, ddr: number): void {
    // Default: no action
  }

  writePortB(value: number, ddr: number): void {
    // Default: no action
  }

  isEnabled(): boolean {
    return this.enabled
  }

  getPriority(): number {
    return this.priority
  }

  clearInterrupts(ca1: boolean, ca2: boolean, cb1: boolean, cb2: boolean): void {
    if (ca1) this.ca1Interrupt = false
    if (ca2) this.ca2Interrupt = false
    if (cb1) this.cb1Interrupt = false
    if (cb2) this.cb2Interrupt = false
  }

  updateControlLines(ca1: boolean, ca2: boolean, cb1: boolean, cb2: boolean): void {
    // Default: no action
  }

  hasCA1Interrupt(): boolean {
    return this.ca1Interrupt
  }

  hasCA2Interrupt(): boolean {
    return this.ca2Interrupt
  }

  hasCB1Interrupt(): boolean {
    return this.cb1Interrupt
  }

  hasCB2Interrupt(): boolean {
    return this.cb2Interrupt
  }
}
