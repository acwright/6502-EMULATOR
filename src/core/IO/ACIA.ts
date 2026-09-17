import { IO } from '../IO'
import { expectKind, readBoolean, readByteList, readNumber } from '../DeviceState'
import type { DeviceState } from '../DeviceState'

/**
 * ACIA - Emulates the Rockwell R6551 ACIA (Asynchronous Communications
 * Interface Adapter) on the Serial Card, and the far end of its cable.
 *
 * The chip is modelled register for register from Rockwell's R6551 data sheet
 * (Document No. 29651N90, Rev. 4, June 1987; "the data sheet" below), where it
 * is explicit, and from the 1981 Rev. 1 sheet and Synertek's SY6551 sheet where
 * they agree with it. It is not a WDC 65C51, which differs.
 *
 * No baud rate timing: a byte is sent the tick after it is written, and the far
 * end sends its next byte only once the receive register is empty. Overrun can
 * therefore never happen here, as it can on a board.
 *
 * Register Map:
 * $00: Data Register (read/write)
 * $01: Status Register (read) / Programmed Reset (write)
 * $02: Command Register (read/write)
 * $03: Control Register (read/write)
 */
export class ACIA implements IO {

  readonly kind = 'acia'

  transmit?: (data: number) => void

  /**
   * Whether the far end of the line honours RTS, as a terminal set to RTS/CTS
   * flow control does. Off by default, and with it off input is never held.
   *
   * Host configuration, not machine state: it says what is plugged into the
   * port, so it is neither reset nor serialized.
   *
   * Off by default because software that raises RTS has to lower it again, and
   * not all of it does. BIOS 1.6's BASIC reads its input buffer
   * without ever lowering RTS once the IRQ handler has raised it, so with flow
   * control on a long paste stalls there for good.
   */
  flowControl: boolean = false

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

  /**
   * Bytes the far end has not sent yet: the terminal's side of the cable, not
   * the chip's. The R6551 holds one received byte, in its receive register, and
   * nothing else.
   *
   * The far end sends the next byte once the receive register is empty (see
   * `tick`), and, when it honours RTS, only while RTS is low. A byte it sends
   * while the chip's receiver is disabled is lost on the line, as it would be
   * at the board: nothing here keeps it for later.
   */
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

    // Bit 4: Receiver Echo Mode (REM)
    this.echoMode = (data & 0x10) !== 0
  }

  /**
   * Programmed reset: a write of any value to $01.
   *
   * Per the data sheet's register tables and "Program Reset Operation", it
   * clears bits 4-0 of the command register — so DTR goes high, the receiver,
   * transmitter and interrupts are disabled, RTS goes high and echo mode ends —
   * and the overrun bit of the status register. The control register, the
   * other status bits and any byte waiting in the transmit register are left
   * as they were, and a pending interrupt is not withdrawn ("if IRQ is low when
   * the reset occurs, it stays low until serviced").
   */
  private programmedReset(): void {
    this.commandRegister &= 0xE0
    this.echoMode = false
    this.overrun = false
  }

  /**
   * DTR, command register bit 0. The data sheet ("Miscellaneous", item 2):
   * with bit 0 clear, all interrupts are disabled, the transmitter is disabled
   * immediately, and the receiver is disabled. Synertek's sheet says the same:
   * "0: disable receiver and all interrupts (DTR high)". The reset state.
   */
  get dataTerminalReady(): boolean {
    return (this.commandRegister & 0x01) !== 0
  }

  /**
   * Whether the RTS pin is low ("request to send": the far end may send).
   *
   * RTS is driven by the transmitter interrupt control bits (TIC, bits 3-2):
   * 00 is RTS high, and 01, 10 and 11 all drive it low. Receiver echo mode
   * (bit 4) needs TIC 00 and drives RTS low regardless ("If Echo Mode is
   * selected, RTS goes low"). RTS is active low, so high is the machine saying
   * *stop sending*. The BIOS uses exactly that: its IRQ handler writes `$01`
   * (TIC 00) when `INPUT_BUFFER` is nearly full, and `ReadBuffer` writes `$09`
   * (TIC 10) once it has drained. The reset state, `$00`, is RTS high.
   *
   * RTS does not depend on DTR: the two are separate pins.
   *
   * Both data sheets from 1987 on (Rockwell Rev. 4 and Synertek) also call TIC
   * 00 "transmitter disabled"; Rockwell's Rev. 1 sheet says only "transmit
   * interrupt disabled". That is not modelled: bytes written with RTS high are
   * still sent. See the note on `tick`.
   */
  get requestToSend(): boolean {
    return (this.commandRegister & 0x1C) !== 0
  }

  /**
   * Whether the receiver is on. It needs DTR (bit 0 set) and, per the data
   * sheet's "Effect of DCD on Receiver", DCD low; DCD is always low here (see
   * `readStatus`).
   */
  get receiverEnabled(): boolean {
    return this.dataTerminalReady
  }

  /**
   * Whether the far end would send a byte now: always with `flowControl` off,
   * and otherwise only while RTS is low (`requestToSend`). This is about the
   * terminal, not the chip. A byte sent while the receiver is disabled is lost.
   */
  get readyToReceive(): boolean {
    return !this.flowControl || this.requestToSend
  }

  /** Bytes the far end has been handed and not yet sent. */
  get queuedBytes(): number {
    return this.rxQueue.length
  }

  /**
   * Tick - process TX/RX each cycle, return interrupt status
   *
   * Transmit: a byte written to the data register is sent on the next tick,
   * once the transmitter is enabled (DTR). With DTR off it waits in the
   * transmit register, and TDRE stays clear, until DTR comes on. CTS is always
   * low here (the Serial Card ties it low, or to a terminal asserting it), so
   * it never disables the transmitter.
   *
   * TIC 00 is not treated as "transmitter disabled" (see `requestToSend`). If
   * the chip does disable it there, firmware that raises RTS for flow control
   * and then waits for TDRE — BIOS 2.0's `SerialChrout` echoing a paste — would
   * wait for good on a board. That needs confirming against a real R6551 before
   * the emulator copies it.
   */
  tick(frequency: number): number {
    const dtr = this.dataTerminalReady

    if (this.txPending && dtr) {
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

    // The far end sends its next byte once the receive register is empty — and
    // if it honours RTS, only while RTS is low: a terminal doing RTS/CTS flow
    // control stops sending, so the byte waits on its side of the cable.
    if (!this.rxRegFull && this.rxQueue.length > 0 && this.readyToReceive) {
      const byte = this.rxQueue.shift()!

      // A receiver that is off never sees the byte. It is gone.
      if (this.receiverEnabled) {
        this.rxRegister = byte
        this.rxRegFull = true

        // Receive IRQ: bit 1 (IRD) clear enables it, and DTR is already on.
        if (!(this.commandRegister & 0x02)) {
          this.irqFlag = true
        }

        // Echo mode: automatically transmit received data
        if (this.echoMode && this.transmit) {
          this.transmit(byte)
        }
      }
    }

    // With DTR off "all interrupts are disabled": IRQB is not driven.
    return this.irqFlag && dtr ? 0x80 : 0
  }

  /**
   * Hardware reset (RES): command and control registers cleared, status cleared
   * but for TDRE (set) and the DSR and DCD levels.
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
   * Hand the far end a byte to send. It goes when `tick` says the line will
   * take it, and is lost if the receiver is disabled when it does.
   */
  onData(data: number): void {
    this.rxQueue.push(data & 0xFF)
  }

  /**
   * The receive queue is part of the state.
   *
   * It holds bytes the host has handed over but the machine has not yet read,
   * and dropping them would lose a keystroke or a line of pasted input across a
   * restore — the same class of bug §5.4 was written to avoid.
   */
  serialize(): DeviceState {
    return {
      kind: this.kind,
      txRegister: this.txRegister,
      rxRegister: this.rxRegister,
      commandRegister: this.commandRegister,
      controlRegister: this.controlRegister,
      txRegEmpty: this.txRegEmpty,
      rxRegFull: this.rxRegFull,
      txPending: this.txPending,
      overrun: this.overrun,
      parityError: this.parityError,
      framingError: this.framingError,
      irqFlag: this.irqFlag,
      echoMode: this.echoMode,
      rxQueue: [...this.rxQueue]
    }
  }

  deserialize(state: DeviceState): void {
    expectKind(state, this.kind)
    this.txRegister = readNumber(state, 'txRegister')
    this.rxRegister = readNumber(state, 'rxRegister')
    this.commandRegister = readNumber(state, 'commandRegister')
    this.controlRegister = readNumber(state, 'controlRegister')
    this.txRegEmpty = readBoolean(state, 'txRegEmpty')
    this.rxRegFull = readBoolean(state, 'rxRegFull')
    this.txPending = readBoolean(state, 'txPending')
    this.overrun = readBoolean(state, 'overrun')
    this.parityError = readBoolean(state, 'parityError')
    this.framingError = readBoolean(state, 'framingError')
    this.irqFlag = readBoolean(state, 'irqFlag')
    this.echoMode = readBoolean(state, 'echoMode')
    this.rxQueue = readByteList(state, 'rxQueue')
  }
}
