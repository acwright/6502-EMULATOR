import { readFileSync } from 'node:fs'
import { Session } from '../../debug/Session'
import { Empty } from '../../core/IO/Empty'
import { RTC } from '../../core/IO/RTC'
import type { ClockReading } from '../../core/IO/RTC'
import { Storage } from '../../core/IO/Storage'
import { Video } from '../../core/IO/Video'
import type { SlotName } from '../../core/Machine'
import type { SlotConfig } from '../../core/Machine'
import {
  loadProgramImage,
  applyProgramPointers,
  loadBinary,
  MAX_PROGRAM_SIZE
} from '../../core/ProgramImage'
import { SerialConsole } from './SerialConsole'
import { SymbolTable } from '../../debug/symbols/Symbols'

/** Which device the BIOS should use as its console. */
export type ConsoleMode = 'serial' | 'video'

export interface BinaryLoad {
  address: number
  bytes: Uint8Array
}

export interface HeadlessOptions {
  /** BIOS/ROM image. Required — the machine has nothing to run without one. */
  rom: Uint8Array
  cart?: Uint8Array
  program?: Uint8Array
  binaries?: BinaryLoad[]
  cf?: Uint8Array
  /** Battery-backed bytes for the clock card, as the app's NVRAM file holds them. */
  nvram?: Uint8Array

  /**
   * `serial` leaves the video slot empty so the BIOS routes its console to the
   * ACIA. `video` populates it, which means output goes to a framebuffer
   * nothing is reading yet — useful only for running a program blind until
   * screen capture arrives.
   */
  console?: ConsoleMode

  /**
   * Slots to leave unpopulated. The machine fits a working card in every slot
   * by default, which means the BIOS's hardware probe always finds everything
   * and its graceful-degradation paths are unreachable — `NO DEVICE`, the
   * silent returns from SOUND and COLOR, the console falling back to serial.
   * Naming a slot here fits an Empty instead, which is what an absent card
   * looks like on the bus.
   *
   * `--console serial` already empties io8; anything listed here is emptied on
   * top of that.
   */
  emptySlots?: SlotName[]

  /** PHI2 in Hz. The real board offers 1 MHz and 2 MHz. */
  frequency?: number
  baudRate?: number

  /**
   * What the real-time clock reads at boot, instead of the host's wall clock.
   *
   * The last non-deterministic input to the engine (§5.11): with this set, the
   * same ROM plus the same input plus the same cycle budget produces
   * byte-identical results on every run and every machine, which is what makes
   * an emulator-based test trustworthy in CI. The clock still advances from here
   * in emulated time — a fixed origin, not a stopped clock.
   */
  rtc?: ClockReading

  /** Stop after this many CPU cycles. */
  maxCycles?: number
  /** Stop after this much wall-clock time. */
  timeoutMs?: number
  /** Stop when the machine's serial output matches. */
  exitOn?: RegExp
  /**
   * Hold host input back until the machine's output matches.
   *
   * The BIOS boot menu reads the console for its first few emulated seconds,
   * looking for ESC or ENTER, and swallows whatever else arrives. Piped input
   * sent at t=0 therefore lands in the boot menu rather than at the prompt.
   * Gating on the prompt is how a script says "wait until it's listening".
   */
  inputAfter?: RegExp

  /** Where the machine's console output goes. */
  onOutput?: (data: Uint8Array) => void
}

export type ExitReason = 'max-cycles' | 'timeout' | 'exit-on' | 'stopped' | 'error'

/** Retained console output, positioned in the stream it came from. */
export interface SerialRead {
  data: string
  /** Total bytes the console has produced — the stream position after `data`. */
  cursor: number
  /** True when output before the requested `since` had already been dropped. */
  truncated: boolean
}

export interface RunResult {
  reason: ExitReason
  cycles: number
  wallMs: number
  /** Everything the machine wrote to its console, when a match was being sought. */
  output?: string
  error?: string
}

/** CF card size on the real machine: 256 disks x 1 MB. */
const DEFAULT_CF_SIZE = 256 * 1024 * 1024

/**
 * How long the tail kept for `--exit-on` matching may grow. Long enough for a
 * pattern to span several lines, bounded so a long run can't grow without end.
 */
const MATCH_WINDOW = 64 * 1024

/**
 * Runs a machine with no window, wiring its console to a byte stream.
 *
 * Possible because `src/core` has no browser or Node dependencies — the same
 * engine the desktop app runs in a renderer runs here in a bare Node process,
 * with no Electron and no display.
 */
export class HeadlessHost {
  readonly session: Session
  readonly serial: SerialConsole

  /**
   * Symbols loaded for this machine.
   *
   * Owned by the host rather than by whoever loaded them, so a `--symbols` flag
   * on the command line and a `sym.load` over the debug protocol contribute to
   * the same table.
   */
  readonly symbols = new SymbolTable()

  private readonly options: HeadlessOptions
  private readonly onOutput?: (data: Uint8Array) => void

  /** Extra consumers of console output — the debug server subscribes here. */
  private readonly outputListeners = new Set<(data: Uint8Array) => void>()

  /** Rolling tail of console output, kept only when someone is reading it. */
  private outputTail = ''

  /**
   * Total bytes the console has ever produced.
   *
   * The tail is bounded, so an absolute position in the stream is the only
   * stable way to say "output after this point". A caller that writes a command
   * and then asks to wait for its reply needs that: between the two calls the
   * machine may run millions of cycles and the reply can arrive — and be
   * scrolled out of a "from now on" window — before the wait is even set up.
   */
  private outputProduced = 0

  /** Outstanding requests to retain output, from retainOutput(). */
  private retainRequests = 0

  /** False while input is held back waiting for `inputAfter` to match. */
  private inputGateOpen: boolean

  /** A program written before BASIC booted, still awaiting its pointer fixup. */
  private pendingProgramLength: number | null = null

  private startedAt = 0
  private deadline = Infinity
  private finished = false
  private settle?: (result: RunResult) => void
  private result?: RunResult

  constructor(options: HeadlessOptions) {
    this.options = options
    this.onOutput = options.onOutput
    this.inputGateOpen = options.inputAfter === undefined

    const consoleMode = options.console ?? 'serial'
    const rtc = options.rtc
    const slots: SlotConfig = {
      // The fixed reading is handed to the card at construction rather than
      // written into its registers afterwards, so a cold reset re-reads the same
      // date instead of quietly falling back to wall time.
      ...(rtc ? { io3: new RTC(() => rtc) } : {}),
      io4: new Storage(options.cf?.length || DEFAULT_CF_SIZE),
      // An empty video slot is not a degraded mode — it is how the BIOS is told
      // to talk serial. ProbeVideo writes $A5 to VRAM and reads it back; Empty
      // returns 0, the probe fails, and console auto-detection picks the ACIA.
      io8: consoleMode === 'serial' ? new Empty() : new Video()
    }

    // Emptied last so it wins over the defaults above, and so `--empty video`
    // and `--console serial` agree rather than fighting.
    for (const slot of options.emptySlots ?? []) slots[slot] = new Empty()

    // The scheduler drives periodic work at a byte's worth of emulated time, so
    // paced input lands at the same point in the program at any host speed.
    const frequency = options.frequency ?? 1_000_000
    const baudRate = options.baudRate ?? 19200
    this.session = new Session(slots, undefined, {
      chunkCycles: Math.max(1, Math.floor((frequency * 10) / baudRate)),
      onChunk: () => this.onChunk()
    })

    const machine = this.session.machine
    machine.frequency = frequency
    this.serial = new SerialConsole(machine, baudRate)

    machine.loadROM(options.rom)
    if (options.cf) (machine.io4 as Storage).loadData(options.cf)
    if (options.nvram) (machine.io3 as RTC).loadNVRAM(options.nvram)
    if (options.cart) machine.loadCart(options.cart)

    machine.transmit = (byte) => this.emit(byte)

    // Everything above changed what the CPU will fetch, so re-read the vectors.
    machine.reset(true)

    this.loadMedia()
  }

  private loadMedia(): void {
    const machine = this.session.machine

    for (const binary of this.options.binaries ?? []) {
      const status = loadBinary(machine, binary.address, binary.bytes)
      if (status !== 'ok') {
        throw new Error(
          `binary at $${binary.address.toString(16).toUpperCase().padStart(4, '0')}: ${status}`
        )
      }
    }

    const program = this.options.program
    if (!program) return

    const status = loadProgramImage(machine, program)
    if (status === 'empty') throw new Error('program file is empty')
    if (status === 'too-large') {
      throw new Error(
        `program is ${program.length} bytes; only ${MAX_PROGRAM_SIZE} fit in $0800-$7FFF`
      )
    }

    // BASIC has not booted yet, so its cold start would overwrite the
    // end-of-program pointers. Retry as the machine runs — this is exactly the
    // preload-then-boot case ProgramImage was built for.
    if (status === 'basic-not-ready') this.pendingProgramLength = program.length
  }

  private emit(byte: number): void {
    const data = Uint8Array.of(byte)
    this.outputProduced++
    this.onOutput?.(data)
    for (const listener of this.outputListeners) listener(data)

    const { exitOn, inputAfter } = this.options
    if (!exitOn && !inputAfter && this.retainRequests === 0) return

    this.outputTail += String.fromCharCode(byte)
    if (this.outputTail.length > MATCH_WINDOW) {
      this.outputTail = this.outputTail.slice(-MATCH_WINDOW)
    }

    if (!this.inputGateOpen && inputAfter?.test(this.outputTail)) {
      this.inputGateOpen = true
      // Start pacing from here, or the held-back bytes all go at once.
      this.serial.resync()
    }
  }

  /** Send bytes to the machine's console, paced at the serial line rate. */
  write(data: Uint8Array | string): void {
    this.serial.write(data)
  }

  /** Watch console output as the machine produces it. Returns an unsubscribe. */
  onSerialOutput(listener: (data: Uint8Array) => void): () => void {
    this.outputListeners.add(listener)
    return () => this.outputListeners.delete(listener)
  }

  /**
   * Ask for console output to be kept for later reading. Returns a release.
   *
   * Reference-counted rather than a flag, because retaining costs a string
   * append per emitted byte and a run that nobody is reading back should not
   * pay it. `--exit-on` and `--input-after` retain implicitly.
   */
  retainOutput(): () => void {
    this.retainRequests++
    let released = false
    return () => {
      if (released) return
      released = true
      this.retainRequests--
    }
  }

  /** How many bytes the console has produced. A position in the output stream. */
  get outputCursor(): number {
    return this.outputProduced
  }

  /**
   * Console output retained so far, most recent last.
   *
   * `since` reads from an absolute stream position — see outputCursor. `clear`
   * drops what is returned, so a caller can read one command's output without
   * seeing it again next time.
   */
  readOutput(options: { since?: number; max?: number; clear?: boolean } = {}): SerialRead {
    // Where the retained tail starts in the stream. Anything before this has
    // been trimmed and cannot be recovered.
    const base = this.outputProduced - this.outputTail.length

    let text = this.outputTail
    let truncated = false

    if (options.since !== undefined) {
      truncated = options.since < base
      text = this.outputTail.slice(Math.max(0, options.since - base))
    }
    if (options.max !== undefined) text = text.slice(-options.max)

    if (options.clear) this.outputTail = ''
    return { data: text, cursor: this.outputProduced, truncated }
  }

  get baudRate(): number {
    return this.serial.baudRate
  }

  get consoleMode(): ConsoleMode {
    return this.options.console ?? 'serial'
  }

  /**
   * Run until one of the configured exit conditions fires, or stop() is called.
   *
   * `turbo` runs flat out; without it the machine is paced against the wall
   * clock the way the desktop app runs it.
   */
  run(mode: 'turbo' | 'realtime' = 'turbo', startPaused = false): Promise<RunResult> {
    this.startedAt = Date.now()
    this.deadline =
      this.options.timeoutMs === undefined ? Infinity : this.startedAt + this.options.timeoutMs

    return new Promise<RunResult>((resolve) => {
      this.settle = resolve

      // Starting paused has to mean *not started*, not started-and-then-stopped:
      // Scheduler.start() runs a whole slice synchronously, so pausing after the
      // fact would already be tens of thousands of cycles into the BIOS. A
      // debugger attaching at reset has to see the reset vector.
      if (startPaused) return

      this.session.run(mode)
      // A budget small enough to be met before the first chunk still has to end.
      this.onChunk()
    })
  }

  /** End the run early — a signal, or the caller deciding it has seen enough. */
  stop(reason: ExitReason = 'stopped'): void {
    this.finish(reason)
  }

  private onChunk(): void {
    if (this.finished) return

    if (this.inputGateOpen) this.serial.pump()
    this.applyPendingProgram()

    const { maxCycles, exitOn } = this.options

    if (maxCycles !== undefined && this.session.cycles >= maxCycles) {
      this.finish('max-cycles')
      return
    }
    if (exitOn && exitOn.test(this.outputTail)) {
      this.finish('exit-on')
      return
    }
    if (Date.now() >= this.deadline) {
      this.finish('timeout')
    }
  }

  /**
   * Set BASIC's end-of-program pointers once its cold start has finished.
   *
   * Cheap to attempt — three reads until BASIC is up. Skipping it would leave a
   * `.prg`'s trailing machine code below VARTAB, where the first variable
   * assignment would land on top of it.
   */
  private applyPendingProgram(): void {
    if (this.pendingProgramLength === null) return
    if (applyProgramPointers(this.session.machine, this.pendingProgramLength)) {
      this.pendingProgramLength = null
    }
  }

  private finish(reason: ExitReason, error?: string): void {
    if (this.finished) return
    this.finished = true
    this.session.pause()

    this.result = {
      reason,
      cycles: this.session.cycles,
      wallMs: Date.now() - this.startedAt,
      ...(this.options.exitOn ? { output: this.outputTail } : {}),
      ...(error ? { error } : {})
    }

    this.settle?.(this.result)
  }
}

/** Read a ROM image from disk, checking it is the 32 KB the address space expects. */
export function readROM(path: string): Uint8Array {
  const bytes = new Uint8Array(readFileSync(path))
  if (bytes.length !== 0x8000) {
    throw new Error(`${path}: ROM must be exactly 32768 bytes, got ${bytes.length}`)
  }
  return bytes
}
