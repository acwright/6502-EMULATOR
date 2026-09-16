/**
 * Types for `traces.js`, which is plain JavaScript so that the trace scripts and
 * the test can share it. See that file, and `6502-PICOVDP/docs/TRACE.md`.
 */
import type { Video, VideoObserver } from '../../core/IO/Video'
import type { Capture, Engine, Fixture } from './fixtures'

export interface TraceHeader {
  fixture: string
  /** The emulator commit the trace was recorded at, `-dirty` if the tree was. */
  emulator: string
  /** PHI2, in Hz. */
  frequency: number
}

export interface Trace {
  header: TraceHeader
  /** Event lines, without the header or the `end` footer. */
  lines: string[]
}

export interface TraceEngine extends Engine {
  Video: typeof Video
}

export interface ReplayedCheckpoint {
  name: string
  cycles: number
  capture: Capture
  /** The golden frame's number; the frame in progress at the cold start is 0. */
  frame: number
  /** Reads and writes before the golden frame's first row was latched. */
  settle: number
  /** Reads and writes between its first row's latch and its last's. */
  window: number
  /** Set by `analyseTrace`. */
  class?: 'static' | 'dynamic'
}

export interface ReplayOptions {
  freezeAt?: { settle: number; frame: number }
}

export interface ReplayResult {
  checkpoints: ReplayedCheckpoint[]
  /** With `freezeAt`: the frame presented with nothing applied past the settle point. */
  frozen?: Uint8Array
}

export interface Annotation {
  frame?: number
  settle?: number
  window?: number
  class?: 'static' | 'dynamic'
}

export declare const TRACE_VERSION: number

export declare class TraceRecorder implements VideoObserver {
  constructor(video: Video)
  readonly lines: string[]
  read(port: number, value: number): void
  write(port: number, value: number): void
  lineStart(screenLine: number, displayLine: number): void
  reset(coldStart: boolean, screenLine: number): void
  checkpoint(name: string): void
}

export declare class TraceDivergence extends Error {}

export declare function tracePath(fixtureName: string): string
export declare function recordFixture(
  engine: TraceEngine,
  fixture: Fixture,
  options?: { emulator?: string }
): { trace: Trace; captures: Map<string, Capture> }
export declare function encodeTrace(trace: Trace): Buffer
export declare function decodeTrace(file: Uint8Array): Trace
/** Event lines with the replay's annotations removed. */
export declare function eventsOf(trace: Trace): string[]
export declare function replayTrace(
  engine: TraceEngine,
  trace: Trace,
  options?: ReplayOptions
): ReplayResult
export declare function analyseTrace(engine: TraceEngine, trace: Trace): ReplayedCheckpoint[]
export declare function annotateTrace(trace: Trace, checkpoints: ReplayedCheckpoint[]): Trace
export declare function annotationsOf(trace: Trace): Map<string, Annotation>
