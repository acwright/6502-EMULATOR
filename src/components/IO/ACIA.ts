import { IO } from '../IO'

/**
 * ACIA - Emulates a R6551 ACIA (Asynchronous Communications Interface Adapter)
 * 
 * Simplified to match real R6551 hardware: single-byte TX/RX registers,
 * no buffers, no baud rate timing (USB serial operates at USB speeds).
 * 
 * Register Map:
 * $00: Data Register (read/write)
 * $01: Status Register (read) / Programmed Reset (write)
 * $02: Command Register (write)
 * $03: Control Register (write)
 */
export class ACIA implements IO {

  transmit?: (data: number) => void

  // Registers
  private txRegister: number = 0
  private rxRegister: number = 0
  private commandRegister: number = 0
  private controlRegister: number = 0

  // Status flags
  private txRegEmpty: boolean = true
  private rxRegFull: boolean = false
  private txPending: boolean = false
  private overrun: boolean = false
  private parityError: boolean = false
  private framingError: boolean = false
  private irqFlag: boolean = false
  private echoMode: boolean = false

  // Receive queue — buffers incoming bytes from host serial port
  // and delivers them one at a time via tick() to the single-byte rxRegister
  private rxQueue: number[] = []

  /**
   * Read from ACIA register
   */
  read(address: number): number {
    const register = address & 0x03

    switch (register) {
      case 0x00: // Data Register
        return this.readData()
      
      case 0x01: // Status Register
        return this.readStatus()
      
      case 0x02: // Command Register
        return this.commandRegister
      
      case 0x03: // Control Register
        return this.controlRegister
      
      default:
        return 0
    }
  }

  /**
   * Write to ACIA register
   */
  write(address: number, data: number): void {
    const register = address & 0x03

    switch (register) {
      case 0x00: // Data Register
        this.writeData(data)
        break
      
      case 0x01: // Programmed Reset
        this.programmedReset()
        break
      
      case 0x02: // Command Register
        this.writeCommand(data)
        break
      
      case 0x03: // Control Register
        this.controlRegister = data & 0xFF
        break
    }
  }

  /**
   * Read data from receive register
   */
  private readData(): number {
    // Clear Receive Data Register Full
    this.rxRegFull = false
    this.overrun = false

    // Clear IRQ if it was from RX
    this.irqFlag = false

    return this.rxRegister
  }

  /**
   * Write data to transmit register
   */
  private writeData(data: number): void {
    this.txRegister = data & 0xFF
    this.txRegEmpty = false
    this.txPending = true
  }

  /**
   * Read status register
   *
   * Per the R6551 datasheet, reading the status register clears:
   *   - Bit 7 (IRQ)
   *   - Bit 0 (Parity Error), Bit 1 (Framing Error), Bit 2 (Overrun)
   * The returned byte contains the values BEFORE the clear.
   */
  private readStatus(): number {
    let status = 0

    // Bit 0: Parity Error
    if (this.parityError) status |= 0x01
    
    // Bit 1: Framing Error
    if (this.framingError) status |= 0x02
    
    // Bit 2: Overrun
    if (this.overrun) status |= 0x04
    
    // Bit 3: Receive Data Register Full
    if (this.rxRegFull) status |= 0x08
    
    // Bit 4: Transmit Data Register Empty
    if (this.txRegEmpty) status |= 0x10
    
    // Bit 5: Data Carrier Detect (DCD) - always connected
    status &= ~0x20
    
    // Bit 6: Data Set Ready (DSR) - always ready
    status |= 0x40
    
    // Bit 7: Interrupt (IRQ)
    if (this.irqFlag) status |= 0x80

    // Clear IRQ and error flags after reading (R6551 spec)
    this.irqFlag = false
    this.parityError = false
    this.framingError = false
    this.overrun = false

    return status
  }

  /**
   * Write to command register
   */
  private writeCommand(data: number): void {
    this.commandRegister = data & 0xFF

    // Bit 4: Echo Mode Enable (EME)
    this.echoMode = (data & 0x10) !== 0
  }

  /**
   * Programmed reset
   */
  private programmedReset(): void {
    this.txRegEmpty = true
    this.txPending = false
    this.parityError = false
    this.framingError = false
    this.overrun = false
    this.irqFlag = false
  }

  /**
   * Tick - process TX/RX each cycle, return interrupt status
   */
  tick(frequency: number): number {
    // Handle pending transmit - send immediately (no baud timing)
    if (this.txPending) {
      this.txPending = false

      if (this.transmit) {
        this.transmit(this.txRegister)
      }

      this.txRegEmpty = true

      // Trigger transmit complete IRQ if enabled (TIC bits 3-2 = 01)
      if ((this.commandRegister & 0x0C) === 0x04) {
        this.irqFlag = true
      }
    }

    // Deliver next queued byte to rxRegister when empty
    if (!this.rxRegFull && this.rxQueue.length > 0) {
      this.rxRegister = this.rxQueue.shift()!
      this.rxRegFull = true

      // Trigger receive IRQ if enabled (bit 1 = 0 means enabled, active low)
      if (!(this.commandRegister & 0x02)) {
        this.irqFlag = true
      }

      // Echo mode: automatically transmit received data
      if (this.echoMode && this.transmit) {
        this.transmit(this.rxRegister)
      }
    }

    // Return IRQ status
    return this.irqFlag ? 0x80 : 0
  }

  /**
   * Reset the ACIA
   */
  reset(coldStart: boolean): void {
    this.txRegister = 0
    this.rxRegister = 0
    this.commandRegister = 0
    this.controlRegister = 0

    this.txRegEmpty = true
    this.rxRegFull = false
    this.txPending = false
    this.overrun = false
    this.parityError = false
    this.framingError = false
    this.irqFlag = false
    this.echoMode = false
    this.rxQueue = []
  }

  /**
   * Receive data from external source — queues the byte for delivery via tick()
   */
  onData(data: number): void {
    this.rxQueue.push(data & 0xFF)
  }
}