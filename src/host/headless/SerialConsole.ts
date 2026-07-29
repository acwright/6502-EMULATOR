import type { Machine } from '../../core/Machine'

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
   * The pacing is not cosmetic. The ACIA's receive queue is unbounded and
   * drains a byte per CPU tick, but the BIOS's `INPUT_BUFFER` is 256 bytes and
   * its RTS flow control has nothing to push back on here. Dumping a pasted
   * program in one go would overrun that buffer and silently lose input.
   */
  private readonly pending: number[] = []

  /** Emulated cycles owed before the next byte may be released. */
  private cycleDebt = 0

  private lastCycles = 0

  constructor(
    private readonly machine: Machine,
    /** Serial line rate; the real machine boots at 19200 8-N-1. */
    private readonly baudRate = 19200
  ) {
    this.lastCycles = machine.cycles
  }

  /** Cycles per byte on the wire: 8 data bits plus a start and a stop bit. */
  private get cyclesPerByte(): number {
    return (this.machine.frequency * 10) / this.baudRate
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
