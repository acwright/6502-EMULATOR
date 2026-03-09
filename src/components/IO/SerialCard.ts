import { IO } from '../IO'

/**
 * SerialCard - Emulates a 6551 ACIA (Asynchronous Communications Interface Adapter)
 * 
 * Register Map:
 * $00: Data Register (read/write)
 * $01: Status Register (read) / Programmed Reset (write)
 * $02: Command Register (write)
 * $03: Control Register (write)
 */
export class SerialCard implements IO {

  raiseIRQ = () => {}
  raiseNMI = () => {}
  transmit?: (data: number) => void

  // Registers
  private dataRegister: number = 0
  private statusRegister: number = 0x10  // Transmit Data Register Empty
  private commandRegister: number = 0
  private controlRegister: number = 0

  // Buffers
  private transmitBuffer: number[] = []
  private receiveBuffer: number[] = []

  // Status flags
  private parityError: boolean = false
  private framingError: boolean = false
  private overrun: boolean = false
  private irqFlag: boolean = false
  private echoMode: boolean = false

  // Timing
  private cycleCounter: number = 0
  private baudRate: number = 115200

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
        this.writeControl(data)
        break
    }
  }

  /**
   * Read data from receive buffer
   */
  private readData(): number {
    if (this.receiveBuffer.length > 0) {
      const data = this.receiveBuffer.shift()!
      this.dataRegister = data
      
      // Update status: clear Receive Data Register Full
      this.statusRegister &= ~0x08
      
      // Check for overrun if more data arrives
      if (this.receiveBuffer.length === 0) {
        this.overrun = false
        this.statusRegister &= ~0x04
      }

      // Clear IRQ if receive IRQ was enabled
      if ((this.commandRegister & 0x04) && this.receiveBuffer.length === 0) {
        this.irqFlag = false
        this.statusRegister &= ~0x80
      }

      return data
    }
    
    return this.dataRegister
  }

  /**
   * Write data to transmit buffer
   */
  private writeData(data: number): void {
    this.transmitBuffer.push(data & 0xFF)
    
    // Clear Transmit Data Register Empty flag
    this.statusRegister &= ~0x10
  }

  /**
   * Read status register
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
    if (this.receiveBuffer.length > 0) status |= 0x08
    
    // Bit 4: Transmit Data Register Empty
    if (this.transmitBuffer.length === 0) status |= 0x10
    
    // Bit 5: Data Carrier Detect (DCD) - always clear (connected)
    status &= ~0x20
    
    // Bit 6: Data Set Ready (DSR) - always set (ready)
    status |= 0x40
    
    // Bit 7: Interrupt (IRQ)
    if (this.irqFlag) status |= 0x80

    this.statusRegister = status
    return status
  }

  /**
   * Write to command register
   */
  private writeCommand(data: number): void {
    this.commandRegister = data & 0xFF

    // Bits 0-1: DTR control
    // const dtrControl = data & 0x03
    
    // Bit 2: Receive IRQ Enable
    const receiveIRQEnabled = (data & 0x04) !== 0
    
    // Bits 3-4: Transmit control and IRQ enable
    // const transmitControl = (data >> 3) & 0x03
    
    // Bit 5: Echo mode
    this.echoMode = (data & 0x20) !== 0
    
    // Bits 6-7: Parity control
    // const parityControl = (data >> 6) & 0x03

    // Handle receive IRQ
    if (receiveIRQEnabled && this.receiveBuffer.length > 0) {
      this.irqFlag = true
      this.statusRegister |= 0x80
      this.raiseIRQ()
    } else if (!receiveIRQEnabled) {
      this.irqFlag = false
      this.statusRegister &= ~0x80
    }
  }

  /**
   * Write to control register
   */
  private writeControl(data: number): void {
    this.controlRegister = data & 0xFF

    // Bits 0-3: Baud rate
    const baudRateCode = data & 0x0F
    this.baudRate = this.getBaudRate(baudRateCode)
    
    // Bit 4: Receiver clock source (internal/external)
    const receiverClockSource = (data & 0x10) !== 0
    
    // Bits 5-6: Word length (5, 6, 7, or 8 bits)
    const wordLength = ((data >> 5) & 0x03) + 5
    
    // Bit 7: Stop bits (1 or 2)
    const stopBits = (data & 0x80) ? 2 : 1
  }

  /**
   * Get baud rate from control register code
   */
  private getBaudRate(code: number): number {
    const baudRates = [
      115200,    // 0000 (actually 16x external clock, using 115200 as default)
      50,      // 0001
      75,      // 0010
      110,     // 0011
      135,     // 0100
      150,     // 0101
      300,     // 0110
      600,     // 0111
      1200,    // 1000
      1800,    // 1001
      2400,    // 1010
      3600,    // 1011
      4800,    // 1100
      7200,    // 1101
      9600,    // 1110
      19200    // 1111
    ]
    return baudRates[code] || 115200
  }

  /**
   * Programmed reset
   */
  private programmedReset(): void {
    this.statusRegister = 0x10  // Transmit Data Register Empty
    this.parityError = false
    this.framingError = false
    this.overrun = false
    this.irqFlag = false
  }

  /**
   * Tick - emulate ACIA timing
   */
  tick(frequency: number): void {
    this.cycleCounter++

    // Calculate cycles per byte: (CPU_CLOCK / baud_rate) * bits_per_frame
    // Assuming 10 bits per frame (1 start + 8 data + 1 stop)
    const cyclesPerByte = Math.floor((frequency / this.baudRate) * 10)

    // Simulate transmission based on actual baud rate
    if (this.cycleCounter >= cyclesPerByte && this.transmitBuffer.length > 0) {
      this.cycleCounter = 0
      
      // Transmit one byte
      const byte = this.transmitBuffer.shift()
      
      if (byte !== undefined && this.transmit) {
        this.transmit(byte)
      }
      
      // Set Transmit Data Register Empty if buffer is empty
      if (this.transmitBuffer.length === 0) {
        this.statusRegister |= 0x10
        
        // Trigger transmit complete IRQ if enabled
        if ((this.commandRegister & 0x18) === 0x08) {
          this.irqFlag = true
          this.statusRegister |= 0x80
          this.raiseIRQ()
        }
      }
    }
  }

  /**
   * Reset the ACIA
   */
  reset(coldStart: boolean): void {
    this.dataRegister = 0
    this.statusRegister = 0x10  // Transmit Data Register Empty
    this.commandRegister = 0
    this.controlRegister = 0
    
    this.transmitBuffer = []
    this.receiveBuffer = []
    
    this.parityError = false
    this.framingError = false
    this.overrun = false
    this.irqFlag = false
    this.echoMode = false
    
    this.cycleCounter = 0
    this.baudRate = 115200
  }

  /**
   * Receive data from external source
   */
  onData(data: number): void {
    if (this.receiveBuffer.length > 0 && (this.statusRegister & 0x08)) {
      // Overrun condition: data arrives before previous data was read
      this.overrun = true
      this.statusRegister |= 0x04
    }

    this.receiveBuffer.push(data & 0xFF)
    
    // Set Receive Data Register Full flag
    this.statusRegister |= 0x08
    
    // Trigger receive IRQ if enabled
    if (this.commandRegister & 0x04) {
      this.irqFlag = true
      this.statusRegister |= 0x80
      this.raiseIRQ()
    }

    // Echo mode: automatically transmit received data
    if (this.echoMode) {
      this.transmitBuffer.push(data & 0xFF)
      // Clear Transmit Data Register Empty flag
      this.statusRegister &= ~0x10
    }
  }
}