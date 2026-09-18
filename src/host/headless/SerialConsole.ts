import type { Machine } from '../../core/Machine'
import { LINES_ASSERTED } from '../../core/SerialPeer'
import type { SerialLines, SerialPeer } from '../../core/SerialPeer'

/**
 * Bridges a byte stream to the emulated 6551 ACIA, so the host's stdio becomes
 * the machine's console.
 *
 * This works with no firmware changes because the BIOS already does the hard
 * part: `KernalInit` probes for video, and finding none it sets `IO_MODE = 1`
 * and routes `Chrout` to the ACIA. On the input side the IRQ handler reads
 * `SC_DATA` into the same `INPUT_BUFFER` the keyboard feeds, which `Chrin`
 * drains. Boot a machine with an empty video slot and it comes up talking
 * serial.
 */
export class SerialConsole {
  /**
   * Bytes waiting to be handed to the ACIA, released at the configured baud
   * rate rather than all at once.
   *
   * The pacing is not cosmetic. The far end's queue in the ACIA is unbounded
   * and drains a byte per CPU tick, but the BIOS's `INPUT_BUFFER` is 256 bytes.
   * Dumping a pasted program in one go would overrun that buffer and silently
   * lose input.
   *
   * Pacing alone is not always enough: crunching a line of BASIC can take
   * longer than a hundred characters of line time, so a paste at 19,200 baud
   * can still fill the buffer. The BIOS raises RTS before it does, and with
   * the machine's `flowControl` on (the default) this holds the queue while RTS
   * is up, as a terminal doing RTS/CTS flow control would — including from
   * reset until the firmware programs the ACIA. With it off RTS is ignored.
   */
  private readonly pending: number[] = []

  /** Emulated cycles owed before the next byte may be released. */
  private cycleDebt = 0

  private lastCycles = 0

  /** Serial line rate; the real machine boots at 19200 8-N-1. */
  private rate: number

  private _lines: SerialLines = { ...LINES_ASSERTED }

  constructor(
    private readonly machine: Machine,
    baudRate = 19200
  ) {
    this.rate = baudRate
    this.lastCycles = machine.cycles
  }

  get baudRate(): number {
    return this.rate
  }

  /**
   * Whether this end holds its bytes while the machine raises RTS, as a
   * terminal doing RTS/CTS does (`--peer-rts`, `--[no-]flow-control`). The
   * holding itself is the machine's queue (`ACIA.readyToReceive`) together
   * with `pump`, so this is the machine's `flowControl`.
   */
  get honoursRts(): boolean {
    return this.machine.flowControl
  }

  set honoursRts(on: boolean) {
    this.machine.flowControl = on
  }

  /** CTS, DCD and DSR as this end drives them: true is asserted. */
  get lines(): Readonly<SerialLines> {
    return this._lines
  }

  /**
   * Assert or drop some of the lines. They reach the machine on the host's
   * next `SerialLink.sync`.
   */
  setLines(lines: Partial<SerialLines>): void {
    this._lines = {
      cts: lines.cts ?? this._lines.cts,
      dcd: lines.dcd ?? this._lines.dcd,
      dsr: lines.dsr ?? this._lines.dsr
    }
  }

  /**
   * Nothing to do: whether RTS holds this end's bytes is decided where they
   * wait, in `pump` and the machine's queue, which read RTS as they go.
   */
  receiveRequestToSend(_asserted: boolean): void {}

  set baudRate(value: number) {
    if (!Number.isFinite(value) || value <= 0) return
    this.rate = value
    // Credit banked at the old rate would release a burst at the new one.
    this.resync()
  }

  /** Cycles per byte on the wire: 8 data bits plus a start and a stop bit. */
  private get cyclesPerByte(): number {
    return (this.machine.frequency * 10) / this.rate
  }

  /** Queue host bytes for delivery to the machine. */
  write(data: Uint8Array | string): void {
    const bytes = typeof data === 'string' ? Buffer.from(data, 'binary') : data
    for (const byte of bytes) this.pending.push(byte & 0xff)
  }

  get pendingBytes(): number {
    return this.pending.length
  }

  /**
   * Restart the pacing clock from now, discarding banked credit.
   *
   * Needed when input has been held back — otherwise the first pump after the
   * hold sees every cycle that passed during it and releases the whole backlog
   * at once, which is exactly the overrun the pacing exists to prevent.
   */
  resync(): void {
    this.lastCycles = this.machine.cycles
    this.cycleDebt = 0
  }

  /**
   * Release however many bytes the elapsed emulated time has paid for.
   *
   * Call this between chunks of execution. Because the budget is measured in
   * emulated cycles rather than wall time, input arrives at the same point in
   * the program whether the machine is running in real time or flat out.
   */
  pump(): void {
    const elapsed = this.machine.cycles - this.lastCycles
    this.lastCycles = this.machine.cycles
    if (elapsed <= 0) return

    // RTS raised with flow control on: send nothing, and bank nothing, so that
    // when it drops the next byte takes a whole byte's line time to arrive
    // rather than the backlog going in a burst. Never taken with flow control
    // off, where `serialReady` is always true.
    if (!this.machine.serialReady) {
      this.cycleDebt = 0
      return
    }

    this.cycleDebt += elapsed

    const perByte = this.cyclesPerByte
    while (this.pending.length > 0 && this.cycleDebt >= perByte) {
      this.cycleDebt -= perByte
      this.machine.onReceive(this.pending.shift()!)
    }

    // Don't bank credit while idle, or a long quiet stretch would let a later
    // paste through in one unpaced burst.
    if (this.pending.length === 0) this.cycleDebt = 0
  }
}
