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
   * flow control does. On by default: that is how a terminal should be set up
   * for the board. Off stands for a far end that ignores RTS and sends
   * regardless, into a receiver that may be off.
   *
   * Host configuration, not machine state: it says what is plugged into the
   * port, so it is neither reset nor serialized.
   *
   * Software that raises RTS has to lower it again. Firmware that does not (as
   * BIOS 1.6's BASIC did not before `27bd4e0`) stalls a long paste for good
   * with this on, as it would on a board.
   *
   * Raising RTS also stops the transmitter (see `transmitterEnabled`), so
   * firmware that echoes while RTS is high deadlocks instead — on a board as
   * here. BIOS 1.6 and 2.0 both did until 6502-BIOS tags `v1.6` and `v2.0.1`,
   * where the serial output path lowers RTS around each byte it sends, and
   * above the high-water mark declines to send at all rather than reopen the
   * gate on a full buffer. That was the firmware's bug, not this one, and the
   * bench proved both halves of it.
   */
  flowControl: boolean = true

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
   * Read the receive data register.
   *
   * Clears RDRF and, per the data sheet ("Parity Error (Bit 0), Framing Error
   * (Bit 1), and Overrun (Bit 2)": "automatically cleared after a read of the
   * Receiver Data Register"), the three error bits. It also clears a pending
   * IRQ, as this emulator always has; the data sheet names only a status read
   * for that.
   */
  private readData(): number {
    this.rxRegFull = false
    this.overrun = false
    this.parityError = false
    this.framingError = false

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
   * Read the status register. Reading it clears bit 7 (IRQ) and nothing else;
   * the returned byte holds the value from before the clear.
   *
   * Bits 5 and 6 are the levels on the DCDB and DSRB pins: 0 is low (carrier
   * detected, data set ready), 1 is high (not detected, not ready). Both data
   * sheets and Synertek's say so in those words. On every board these pins are
   * low in normal use, so both bits read 0:
   *
   * - Serial Card (6502-COB): DCDB and DSRB are tied to ground.
   * - Serial Card Pro (6502-COB): DSRB comes from the cable's DSR through the
   *   MAX232, and the "DCD Select" jumper picks ground or the cable's DCD.
   * - ACE: DSRB comes from the cable's DSR through the MAX238, and "DCD EN"
   *   picks ground or the cable's DCD.
   *
   * With a full null-modem cable the laptop's DTR, asserted while its port is
   * open, arrives as DSR and DCD, which the level shifter turns into a low pin.
   * A cable that leaves DSR unconnected would read 1 on the Pro and the ACE;
   * nothing emulated models a cable, and no firmware here reads the bit. DCD
   * matters more than DSR: the R6551 raises no receiver interrupts while DCDB
   * is high ("Effect of DCD on Receiver"), and Synertek's sheet says it "must
   * be low for the Receiver to operate".
   *
   * CTSB has no status bit. Every board ties it low or to the cable's CTS
   * ("CTS EN"), so the transmitter is never disabled by it here.
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
    
    // Bit 5: DCDB low (carrier detected) — see above
    // Bit 6: DSRB low (data set ready) — see above
    
    // Bit 7: Interrupt (IRQ)
    if (this.irqFlag) status |= 0x80

    this.irqFlag = false

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
   * *stop sending*. The BIOS uses exactly that: `ScRts` writes `$01` (TIC 00)
   * once `INPUT_BUFFER` passes its high-water mark and `$09` (TIC 10) once it
   * has drained below the low one. The reset state, `$00`, is RTS high.
   *
   * RTS does not depend on DTR: the two are separate pins.
   *
   * TIC 00 turns the transmitter off as well as raising RTS — see
   * `transmitterEnabled`.
   */
  get requestToSend(): boolean {
    return (this.commandRegister & 0x1C) !== 0
  }

  /**
   * Whether the transmitter is on.
   *
   * It needs DTR (bit 0 set; with it clear "the transmitter is disabled
   * immediately") and a TIC (bits 3-2) other than `00`. The data sheet's
   * command register table spells the four TIC values out as
   *
   *   00 = Transmit Interrupt Disabled, RTSB = High, Transmitter Off
   *   01 = Transmit Interrupt Enabled,  RTSB = Low,  Transmitter On
   *   10 = Transmit Interrupt Disabled, RTSB = Low,  Transmitter On
   *   11 = Transmit Interrupt Disabled, RTSB = Low,  Transmit BRK
   *
   * so `00` is not merely "transmit interrupt disabled", as Rockwell's Rev. 1
   * sheet of 1981 has it. Synertek's SY6551 sheet agrees with Rev. 4.
   *
   * CTSB would disable it too, but every board ties it low (see `readStatus`).
   *
   * **Confirmed on the bench (2026-09-17)**, on an AC6502 KIM with a Serial
   * Card and a real R6551, BIOS 1.6 (`27bd4e0`) over an FTDI RS-232 cable:
   *
   * - `POKE 36866,9` (`$09`: DTR on, TIC 10, RTS low) then `PRINT "B"` printed
   *   `B` and `OK`.
   * - `POKE 36866,1` (`$01`: DTR on, TIC 00, RTS high) echoed the command line
   *   and then stopped transmitting mid-reply. Its `OK` never came, RTS stayed
   *   high, a following `PRINT "C"` produced nothing, and the machine ignored
   *   CR and Ctrl-C: `SerialChrout` was spinning on TDRE.
   *
   * Which settles the 1981/1987 disagreement, and settles TDRE with it: see
   * `tick`.
   *
   * That second transcript no longer reproduces on either bundled ROM, and must
   * not: from 6502-BIOS `v1.6` and `v2.0.1`, `SerialChrout` lowers RTS around
   * each byte, so the same `POKE` is undone by the next character out and the
   * board keeps running. The chip is unchanged — TIC 00 still means transmitter
   * off — and the tests that hold it to that drive the register directly rather
   * than through the firmware.
   */
  get transmitterEnabled(): boolean {
    return this.dataTerminalReady && (this.commandRegister & 0x0C) !== 0
  }

  /**
   * Whether the receiver is on. It needs DTR (bit 0 set) and DCDB low (see
   * `readStatus`), which it always is here.
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
   * but only while the transmitter is on — DTR set and TIC (bits 3-2) not `00`
   * (see `transmitterEnabled`). With the transmitter off the byte waits in the
   * transmit register and TDRE stays clear, and both go when it comes back on.
   *
   * TDRE (status bit 4) says the transmit data register has been emptied into
   * the transmit shift register. A disabled transmitter never shifts anything
   * out, so it never empties the register and the bit stays clear. That is what
   * makes firmware spin: `SerialChrout` in every BIOS here writes the byte and
   * then loops on TDRE, so a write made while RTS is high (TIC `00`) never
   * returns. The bench test in `transmitterEnabled` is exactly that hang, on a
   * real R6551, and this models it.
   *
   * It is the same thing DTR off already did, and for the same reason; TIC `00`
   * now joins it.
   */
  tick(frequency: number): number {
    const dtr = this.dataTerminalReady

    if (this.txPending && this.transmitterEnabled) {
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
