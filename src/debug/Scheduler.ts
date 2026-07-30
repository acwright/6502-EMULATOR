import type { Machine } from '../core/Machine'

/**
 * How the machine is being driven forward.
 *
 * - `paused`   — not advancing. The debugger can read and write freely.
 * - `realtime` — paced against the wall clock, so one emulated second takes one
 *                real second. What a person watching the screen wants.
 * - `turbo`    — as fast as the host manages, yielding often enough to stay
 *                responsive. What a test or an agent wants.
 */
export type RunMode = 'paused' | 'realtime' | 'turbo'

export interface SchedulerOptions {
  /** Cycles between onChunk calls. Ignored when onChunk is not set. */
  chunkCycles?: number
  /**
   * Periodic work to run between chunks of execution — feeding paced input,
   * checking exit conditions, applying a deferred program fixup. Runs at chunk
   * granularity in every mode, so callers get a predictable cadence in emulated
   * cycles rather than one that depends on how fast the host happens to be.
   */
  onChunk?: () => void
  /**
   * Execute a chunk of cycles. Returns how many actually ran, which may be
   * fewer if something asked to stop part way.
   *
   * Exists so a caller can substitute an instrumented loop — checking
   * breakpoints at each instruction boundary — without the Scheduler knowing
   * anything about breakpoints, and without the uninstrumented path paying for
   * the option.
   */
  runCycles?: (cycles: number) => number
}

/**
 * Wall-clock pacing, lifted out of the Machine.
 *
 * The engine knows how to execute cycles; deciding how many and when is this
 * class's job. Keeping the two apart is what lets the same machine be run at
 * full speed in a test, stepped in a debugger, or paced against a display.
 */
export class Scheduler {
  /**
   * Longest stretch of missed time the realtime loop will try to make up. Past
   * this the machine simply loses time rather than running a burst that would
   * flood the audio queue.
   */
  static readonly MAX_CATCH_UP_MS = 250

  /**
   * How long a turbo slice runs before yielding to the host. Short enough that
   * a UI or an IPC reply is never held up for a noticeable time.
   */
  static readonly TURBO_SLICE_MS = 8

  /**
   * Cycles run between wall-clock checks inside a turbo slice. Reading the clock
   * per cycle would dominate the loop.
   */
  static readonly DEFAULT_CHUNK_CYCLES = 20_000

  private handle?: ReturnType<typeof setImmediate> | ReturnType<typeof setTimeout>
  private previousTime = 0
  private accumulatorMs = 0
  private currentMode: RunMode = 'paused'

  private readonly chunkCycles: number
  private readonly onChunk?: () => void
  private readonly runCyclesImpl: (cycles: number) => number

  constructor(
    private readonly machine: Machine,
    private readonly now: () => number = () => performance.now(),
    options: SchedulerOptions = {}
  ) {
    this.chunkCycles = options.chunkCycles ?? Scheduler.DEFAULT_CHUNK_CYCLES
    this.onChunk = options.onChunk
    this.runCyclesImpl =
      options.runCycles ??
      ((cycles) => {
        machine.runCycles(cycles)
        return cycles
      })
  }

  /**
   * Run `cycles` cycles, breaking them into chunks so periodic work lands at a
   * predictable granularity.
   *
   * Without an onChunk hook this is a single call — a caller that wants nothing
   * done between chunks should pay nothing for the option.
   */
  private runChunked(cycles: number): void {
    if (!this.onChunk) {
      this.runCyclesImpl(cycles)
      return
    }

    let remaining = cycles
    while (remaining > 0 && this.isRunning) {
      const chunk = Math.min(remaining, this.chunkCycles)
      remaining -= this.runCyclesImpl(chunk)
      this.onChunk()
    }
  }

  get mode(): RunMode {
    return this.currentMode
  }

  get isRunning(): boolean {
    return this.currentMode !== 'paused'
  }

  /**
   * Enter a running mode without executing anything yet.
   *
   * Split out from start() because `resume()` runs a whole slice synchronously,
   * and a caller that wants to announce the machine is running has to be able to
   * do so *before* that slice — otherwise a breakpoint hit inside the slice is
   * reported first and the announcement arrives after it, claiming a stopped
   * machine is running. See Session.run().
   */
  arm(mode: 'realtime' | 'turbo'): void {
    this.currentMode = mode

    // Start the clock from now. Without this the first iteration sees every
    // millisecond since the scheduler was created (or since it last stopped)
    // and runs a catch-up burst, dumping a quarter second of audio into the
    // host in one go.
    this.previousTime = this.now()
    this.accumulatorMs = 0
  }

  /**
   * Begin executing in the armed mode. Runs the first slice synchronously.
   *
   * Cancels any iteration already scheduled first, because every iteration
   * schedules the next one: resuming a machine that was already running would
   * otherwise leave two self-perpetuating chains, and each further resume would
   * add another. `exec.run` on a machine that is already going is an ordinary
   * thing for a client to do, so this was easy to reach.
   *
   * The damage is to responsiveness rather than to throughput, which is worth
   * being precise about. A turbo slice is bounded by wall time, not by work, so
   * extra chains do not make the machine any faster — they each hold the event
   * loop for a full TURBO_SLICE_MS before yielding, which is exactly the
   * guarantee that constant exists to provide. Measured against the debug
   * server's own reply latency, with the machine running in turbo: one chain
   * answers in 8 ms and stays there however many times `exec.run` is called;
   * without this line the same calls took 16, 24, 40 and 72 ms.
   */
  resume(): void {
    this.cancelPending()
    this.loop()
  }

  start(mode: 'realtime' | 'turbo'): void {
    this.arm(mode)
    this.resume()
  }

  stop(): void {
    this.currentMode = 'paused'
    this.cancelPending()
  }

  private cancelPending(): void {
    if (this.handle === undefined) return
    if (typeof clearImmediate !== 'undefined') {
      clearImmediate(this.handle as ReturnType<typeof setImmediate>)
    } else {
      clearTimeout(this.handle as ReturnType<typeof setTimeout>)
    }
    this.handle = undefined
  }

  private loop(): void {
    if (this.currentMode === 'realtime') {
      this.runRealtimeSlice()
    } else if (this.currentMode === 'turbo') {
      this.runTurboSlice()
    }

    this.presentFrame()

    if (this.isRunning) {
      this.handle =
        typeof setImmediate !== 'undefined'
          ? setImmediate(() => this.loop())
          : setTimeout(() => this.loop(), 0)
    }
  }

  /**
   * Run however many cycles the elapsed wall time paid for, carrying the
   * remainder so fractional cycles are not lost across iterations.
   */
  private runRealtimeSlice(): void {
    const now = this.now()
    const elapsedMs = now - this.previousTime
    this.previousTime = now

    const cyclesPerMs = this.machine.frequency / 1000
    let accumulator = this.accumulatorMs + elapsedMs

    if (accumulator > Scheduler.MAX_CATCH_UP_MS) accumulator = Scheduler.MAX_CATCH_UP_MS

    const cycles = Math.floor(accumulator * cyclesPerMs)
    if (cycles > 0) {
      this.runChunked(cycles)
      accumulator -= cycles / cyclesPerMs
    }

    this.accumulatorMs = accumulator
  }

  /** Run flat out for a bounded stretch of real time, then let the host breathe. */
  private runTurboSlice(): void {
    const deadline = this.now() + Scheduler.TURBO_SLICE_MS
    do {
      this.runChunked(this.chunkCycles)
      // isRunning as well as the deadline: a breakpoint stops the machine
      // part-way through a slice, and without this the rest of the slice spins
      // through runChunked calls that can no longer execute anything.
    } while (this.isRunning && this.now() < deadline)

    // Keep the realtime clock honest in case the mode changes back, so the
    // switch doesn't hand realtime a slice's worth of debt to catch up on.
    this.previousTime = this.now()
  }

  /**
   * Hand a completed video frame to the host. Checked once per slice, so turbo
   * naturally coalesces the many frames it produces into one draw.
   */
  private presentFrame(): void {
    if (!this.machine.render) return
    const video = this.machine.video()
    if (!video?.frameReady) return

    video.frameReady = false
    this.machine.render()
  }
}
