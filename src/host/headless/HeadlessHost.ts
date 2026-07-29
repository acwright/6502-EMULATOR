import { readFileSync } from 'node:fs'
import { Session } from '../../debug/Session'
import { Empty } from '../../core/IO/Empty'
import { Storage } from '../../core/IO/Storage'
import { Video } from '../../core/IO/Video'
import type { SlotConfig } from '../../core/Machine'
import {
  loadProgramImage,
  applyProgramPointers,
  loadBinary,
  MAX_PROGRAM_SIZE
} from '../../core/ProgramImage'
import { SerialConsole } from './SerialConsole'

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

  /**
   * `serial` leaves the video slot empty so the BIOS routes its console to the
   * ACIA. `video` populates it, which means output goes to a framebuffer
   * nothing is reading yet — useful only for running a program blind until
   * screen capture arrives.
   */
  console?: ConsoleMode

  /** PHI2 in Hz. The real board offers 1 MHz and 2 MHz. */
  frequency?: number
  baudRate?: number

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

  private readonly options: HeadlessOptions
  private readonly onOutput?: (data: Uint8Array) => void

  /** Rolling tail of console output, kept only when a match is being sought. */
  private outputTail = ''

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
    const slots: SlotConfig = {
      io4: new Storage(options.cf?.length || DEFAULT_CF_SIZE),
      // An empty video slot is not a degraded mode — it is how the BIOS is told
      // to talk serial. ProbeVideo writes $A5 to VRAM and reads it back; Empty
      // returns 0, the probe fails, and console auto-detection picks the ACIA.
      io8: consoleMode === 'serial' ? new Empty() : new Video()
    }

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
    this.onOutput?.(data)

    const { exitOn, inputAfter } = this.options
    if (!exitOn && !inputAfter) return

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

  /**
   * Run until one of the configured exit conditions fires, or stop() is called.
   *
   * `turbo` runs flat out; without it the machine is paced against the wall
   * clock the way the desktop app runs it.
   */
  run(mode: 'turbo' | 'realtime' = 'turbo'): Promise<RunResult> {
    this.startedAt = Date.now()
    this.deadline =
      this.options.timeoutMs === undefined ? Infinity : this.startedAt + this.options.timeoutMs

    return new Promise<RunResult>((resolve) => {
      this.settle = resolve
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
