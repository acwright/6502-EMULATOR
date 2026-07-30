import { Machine } from '../core/Machine'
import type { SlotConfig } from '../core/Machine'
import { Scheduler } from './Scheduler'
import type { RunMode, SchedulerOptions } from './Scheduler'
import { Breakpoints } from './Breakpoints'
import type { Breakpoint, BreakpointHit } from './Breakpoints'
import type { EvalContext } from './Expression'

/**
 * Why the machine stopped advancing.
 *
 * Breakpoint, watchpoint and trap variants arrive with the debug core; the
 * shape is fixed now so callers can switch exhaustively from the start.
 */
export type StopReason =
  | { kind: 'paused' }
  | { kind: 'step' }
  | { kind: 'cycle-budget'; cycles: number }
  | { kind: 'breakpoint'; id: number; address: number }
  | { kind: 'watchpoint'; id: number; address: number; access: 'read' | 'write' }
  | { kind: 'trap'; detail: string }

export type StepKind = 'instruction' | 'cycle' | 'over' | 'out'

/**
 * Ceiling on how far step-over and step-out will run before giving up.
 *
 * They track call depth across JSR and RTS, which hand-rolled stack juggling
 * can desynchronise. A bound means that shows up as a stop rather than a hang.
 */
export const STEP_CYCLE_LIMIT = 50_000_000

/**
 * A machine plus the state needed to drive and inspect it.
 *
 * The single owner of forward progress: nothing else calls `tick` or
 * `runCycles` on the machine. That is what makes the same emulator usable from
 * a GUI running in real time, a test running flat out, and a debugger stepping
 * one instruction at a time.
 */
export class Session {
  readonly machine: Machine
  readonly breakpoints = new Breakpoints()

  private readonly scheduler: Scheduler
  private readonly stopListeners = new Set<(reason: StopReason) => void>()
  private readonly resumeListeners = new Set<(mode: RunMode) => void>()

  /**
   * Called between chunks of execution.
   *
   * A set rather than the single callback the Scheduler takes, because more than
   * one thing legitimately wants this cadence — the headless host feeds paced
   * input on it, and the debug server evaluates `wait.for` conditions on it.
   * Sharing the cadence keeps both measured in emulated cycles rather than one
   * of them falling back to a wall-clock timer.
   */
  private readonly chunkListeners = new Set<() => void>()

  /** Set by a bus tap when a watchpoint fires mid-instruction. */
  private pendingWatch?: BreakpointHit

  /** A stop discovered mid-chunk, delivered once the chunk unwinds. */
  private pendingStop?: StopReason

  /** Resolves a symbol name for breakpoint conditions. */
  symbolResolver?: (name: string) => number | undefined

  /**
   * Why the machine stopped the last time it did, or undefined while running.
   *
   * Retained because a one-shot client cannot be listening at the moment it
   * happens. In turbo the machine covers hundreds of thousands of cycles between
   * two `6502 dbg` processes, so a breakpoint routinely fires before the next
   * command has even connected — the same race the console stream needed a
   * cursor for (§5.13). Keeping the reason means "did it stop, and why" is
   * answerable after the fact instead of only as it happens.
   */
  lastStop?: StopReason

  constructor(slots: SlotConfig = {}, now?: () => number, options: SchedulerOptions = {}) {
    this.machine = new Machine(slots)
    // Breakpoint checks need a cadence; without an explicit chunk size they
    // would only be tested once per scheduler slice, which for turbo could be
    // millions of cycles.
    if (options.onChunk) this.chunkListeners.add(options.onChunk)

    this.scheduler = new Scheduler(this.machine, now, {
      ...options,
      runCycles: (cycles) => this.runCyclesChecked(cycles),
      onChunk: () => {
        for (const listener of this.chunkListeners) listener()
        this.checkBreakpointsWhileRunning()
      }
    })
  }

  /**
   * Observe the chunk cadence. Returns an unsubscribe.
   *
   * Fires every `chunkCycles` of emulated time while running — a Session always
   * hands the Scheduler a chunk callback, because breakpoints need one, so the
   * cadence exists whether or not the constructor was given an `onChunk`.
   */
  onChunk(callback: () => void): () => void {
    this.chunkListeners.add(callback)
    return () => this.chunkListeners.delete(callback)
  }

  /** What a breakpoint condition can see. */
  private evalContext(): EvalContext {
    const cpu = this.machine.cpu
    return {
      registers: {
        A: cpu.a,
        X: cpu.x,
        Y: cpu.y,
        PC: cpu.pc,
        SP: cpu.sp,
        P: cpu.st,
        ST: cpu.st
      },
      read: (address) => this.machine.read(address),
      ...(this.symbolResolver ? { symbol: this.symbolResolver } : {})
    }
  }

  /**
   * Attach or detach the bus taps that catch watchpoints.
   *
   * Only attached while a watchpoint is armed, so an ordinary run pays one
   * undefined check per bus access and nothing more.
   */
  private syncBusTaps(): void {
    if (!this.breakpoints.watchArmed) {
      this.machine.onRead = undefined
      this.machine.onWrite = undefined
      return
    }

    const tap = (access: 'read' | 'write') => (address: number) => {
      if (this.pendingWatch) return
      if (!this.breakpoints.hasWatchAt(address, access)) return
      const hit = this.breakpoints.match(address, access, this.evalContext())
      if (hit) this.pendingWatch = hit
    }

    this.machine.onRead = tap('read')
    this.machine.onWrite = tap('write')
  }

  /** Arm a breakpoint or watchpoint. */
  addBreakpoint(spec: Parameters<Breakpoints['add']>[0]): Breakpoint {
    const breakpoint = this.breakpoints.add(spec)
    this.syncBusTaps()
    return breakpoint
  }

  removeBreakpoint(id: number): boolean {
    const removed = this.breakpoints.remove(id)
    this.syncBusTaps()
    return removed
  }

  clearBreakpoints(): void {
    this.breakpoints.clear()
    this.syncBusTaps()
  }

  setBreakpointEnabled(id: number, enabled: boolean): boolean {
    const changed = this.breakpoints.setEnabled(id, enabled)
    this.syncBusTaps()
    return changed
  }

  get mode(): RunMode {
    return this.scheduler.mode
  }

  get isRunning(): boolean {
    return this.scheduler.isRunning
  }

  /** Clock cycles elapsed since the machine was created. */
  get cycles(): number {
    return this.machine.cycles
  }

  /**
   * Start advancing the machine.
   *
   * `turbo` discards queued audio and does not pace itself, so audio produced
   * while in turbo is not meaningful — it is for tests and headless runs.
   */
  run(mode: 'realtime' | 'turbo' = 'realtime'): void {
    if (mode === 'turbo') this.machine.flushAudio?.()
    this.resumeScheduler(mode)
  }

  /**
   * Announce the machine is running, then let it run.
   *
   * The order is load-bearing. `Scheduler.resume()` executes a whole slice
   * synchronously — tens of thousands of cycles — so a breakpoint inside it
   * stops the machine before this method returns. Announcing afterwards would
   * emit `resumed` *after* the `stopped` it caused, telling every listener that
   * a stopped machine is running and clearing the stop reason a one-shot client
   * needs to read back later.
   */
  private resumeScheduler(mode: 'realtime' | 'turbo'): void {
    this.scheduler.arm(mode)
    this.emitResume(mode)
    this.scheduler.resume()
  }

  pause(): StopReason {
    if (!this.scheduler.isRunning) return this.emitStop({ kind: 'paused' })
    this.scheduler.stop()
    this.machine.flushAudio?.()
    return this.emitStop({ kind: 'paused' })
  }

  /**
   * Advance by whole instructions or single cycles, pausing first if needed.
   *
   * Instruction stepping ticks the CPU and the I/O cards together, exactly as
   * running does, so a stepped instruction leaves the machine in the state it
   * would have reached had it simply run. (Machine.step() interleaves them
   * differently — it completes the instruction before ticking I/O — which is
   * fine for the throughput tests that use it but wrong for a debugger.)
   */
  step(kind: StepKind = 'instruction', count = 1): StopReason {
    if (this.scheduler.isRunning) this.scheduler.stop()

    for (let i = 0; i < count; i++) {
      let reason: StopReason | undefined
      switch (kind) {
        case 'cycle':
          this.machine.tick()
          break
        case 'instruction':
          this.stepOneInstruction()
          break
        case 'over':
          reason = this.stepOverOrOut('over')
          break
        case 'out':
          reason = this.stepOverOrOut('out')
          break
      }
      // A breakpoint or a blown budget ends the whole request, not just this
      // iteration — carrying on would step past the thing that stopped us.
      if (reason) return this.emitStop(reason)
    }

    return this.emitStop({ kind: 'step' })
  }

  /**
   * Step over a subroutine call, or run out of the current one.
   *
   * Both are the same idea: note the call depth, then run instructions until it
   * comes back to where it started. Depth moves on JSR and RTS/RTI, counted at
   * instruction boundaries.
   *
   * `over` on anything that is not a JSR is just a single step, which is what
   * a debugger user expects.
   */
  private stepOverOrOut(mode: 'over' | 'out'): StopReason | undefined {
    const startCycles = this.machine.cycles

    if (mode === 'over') {
      const opcode = this.machine.read(this.machine.cpu.pc)
      const JSR = 0x20
      if (opcode !== JSR) {
        this.stepOneInstruction()
        return undefined
      }
    }

    // 'over' has just seen a JSR, so it is stepping down one level and waiting
    // for depth to come back to zero. 'out' starts inside the routine already,
    // so it waits for depth to go one level negative — the RTS that leaves.
    const target = mode === 'out' ? -1 : 0
    let depth = 0

    for (;;) {
      const opcode = this.machine.read(this.machine.cpu.pc)
      const JSR = 0x20
      const RTS = 0x60
      const RTI = 0x40

      if (opcode === JSR) depth++
      else if (opcode === RTS || opcode === RTI) depth--

      this.stepOneInstruction()

      if (depth <= target) return undefined

      const hit = this.hitAtPC()
      if (hit) return this.stopReasonFor(hit)

      if (this.machine.cycles - startCycles > STEP_CYCLE_LIMIT) {
        return {
          kind: 'trap',
          detail:
            `step-${mode} ran ${STEP_CYCLE_LIMIT} cycles without returning; ` +
            'the call depth may have been desynchronised by stack manipulation'
        }
      }
    }
  }

  /** A breakpoint matching the current PC, if any. */
  private hitAtPC(): BreakpointHit | undefined {
    if (!this.breakpoints.execArmed) return undefined
    const pc = this.machine.cpu.pc
    if (!this.breakpoints.hasExecAt(pc)) return undefined
    return this.breakpoints.match(pc, 'exec', this.evalContext())
  }

  private stopReasonFor(hit: BreakpointHit): StopReason {
    return hit.access
      ? {
          kind: 'watchpoint',
          id: hit.breakpoint.id,
          address: hit.address,
          access: hit.access
        }
      : { kind: 'breakpoint', id: hit.breakpoint.id, address: hit.address }
  }

  /**
   * Run a chunk of cycles, stopping at the first breakpoint.
   *
   * With nothing armed this is a straight call into the engine, so a machine
   * with no breakpoints set runs exactly as fast as one that has never heard of
   * them. That fast path is the whole reason breakpoints are checked here
   * rather than inside the engine.
   *
   * Once something is armed the loop drops to one instruction at a time, which
   * is the only granularity at which "stop before executing $C000" is a
   * meaningful statement.
   */
  private runCyclesChecked(cycles: number): number {
    if (!this.breakpoints.armed) {
      this.machine.runCycles(cycles)
      return cycles
    }

    const start = this.machine.cycles
    while (this.machine.cycles - start < cycles) {
      const hit = this.hitAtPC()
      if (hit) {
        this.pendingStop = this.stopReasonFor(hit)
        break
      }

      this.stepOneInstruction()

      if (this.pendingWatch) {
        this.pendingStop = this.stopReasonFor(this.pendingWatch)
        this.pendingWatch = undefined
        break
      }
    }
    return this.machine.cycles - start
  }

  /** Called between chunks; turns a recorded hit into an actual stop. */
  private checkBreakpointsWhileRunning(): void {
    if (!this.pendingStop) return
    const reason = this.pendingStop
    this.pendingStop = undefined
    this.scheduler.stop()
    this.emitStop(reason)
  }

  private stepOneInstruction(): void {
    // Finish whatever is mid-flight, then run exactly one more instruction.
    // cpu.tick() loads the next opcode only when cyclesRem has reached zero.
    while (this.machine.cpu.cyclesRem > 0) this.machine.tick()
    do {
      this.machine.tick()
    } while (this.machine.cpu.cyclesRem > 0)
  }

  /**
   * Run exactly `cycles` cycles with no pacing, then stop.
   *
   * The deterministic execution primitive: given the same starting state and
   * the same budget, the machine lands in the same place every time, on any
   * host. Tests and headless runs are built on this rather than on wall time.
   */
  runCycles(cycles: number): StopReason {
    if (this.scheduler.isRunning) this.scheduler.stop()
    this.machine.runCycles(cycles)
    return this.emitStop({ kind: 'cycle-budget', cycles })
  }

  /** Reset the machine, preserving whether it was running. */
  reset(coldStart: boolean): void {
    const mode = this.scheduler.mode
    if (this.scheduler.isRunning) this.scheduler.stop()

    this.machine.reset(coldStart)

    if (mode !== 'paused') this.resumeScheduler(mode)
  }

  /**
   * Replace the machine's state, safely.
   *
   * A snapshot restore cannot happen under a running scheduler: `apply` rewrites
   * the CPU's registers and every card's accumulators, and a slice that was
   * part-way through an instruction would finish it against the new state. So
   * this stops first and resumes afterwards in whatever mode it found — the same
   * contract `reset()` already has, for the same reason.
   *
   * Any breakpoint hit noticed but not yet delivered is dropped: it belongs to
   * the program that was running a moment ago, and reporting it against the
   * restored machine would point at an address that means something else now.
   */
  loadState(apply: () => void): void {
    const mode = this.scheduler.mode
    if (this.scheduler.isRunning) this.scheduler.stop()
    this.machine.flushAudio?.()

    this.pendingStop = undefined
    this.pendingWatch = undefined

    apply()

    // The taps live on the Machine, and a restore does not touch them — but
    // re-syncing costs nothing and means a future change to how they attach
    // cannot leave a restored machine with watchpoints armed and untapped.
    this.syncBusTaps()

    if (mode !== 'paused') this.resumeScheduler(mode)
  }

  onStop(callback: (reason: StopReason) => void): () => void {
    this.stopListeners.add(callback)
    return () => this.stopListeners.delete(callback)
  }

  /**
   * Notified whenever the machine starts advancing again.
   *
   * The counterpart to onStop, so a remote debugger can keep its idea of the
   * machine's state correct without polling — it is told about transitions it
   * did not itself cause, such as another client resuming the session.
   */
  onResume(callback: (mode: RunMode) => void): () => void {
    this.resumeListeners.add(callback)
    return () => this.resumeListeners.delete(callback)
  }

  private emitStop(reason: StopReason): StopReason {
    this.lastStop = reason
    for (const listener of this.stopListeners) listener(reason)
    return reason
  }

  private emitResume(mode: RunMode): void {
    // The reason describes a machine that is no longer where it stopped, so it
    // is cleared rather than left to be reported against the new position.
    this.lastStop = undefined
    for (const listener of this.resumeListeners) listener(mode)
  }
}
