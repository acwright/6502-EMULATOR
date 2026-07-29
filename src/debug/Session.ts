import { Machine } from '@core/Machine'
import type { SlotConfig } from '@core/Machine'
import { Scheduler } from './Scheduler'
import type { RunMode } from './Scheduler'

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

export type StepKind = 'instruction' | 'cycle'

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
  private readonly scheduler: Scheduler
  private readonly stopListeners = new Set<(reason: StopReason) => void>()

  constructor(slots: SlotConfig = {}, now?: () => number) {
    this.machine = new Machine(slots)
    this.scheduler = new Scheduler(this.machine, now)
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
    this.scheduler.start(mode)
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
      if (kind === 'cycle') {
        this.machine.tick()
      } else {
        this.stepOneInstruction()
      }
    }

    return this.emitStop({ kind: 'step' })
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

    if (mode !== 'paused') this.scheduler.start(mode)
  }

  onStop(callback: (reason: StopReason) => void): () => void {
    this.stopListeners.add(callback)
    return () => this.stopListeners.delete(callback)
  }

  private emitStop(reason: StopReason): StopReason {
    for (const listener of this.stopListeners) listener(reason)
    return reason
  }
}
