/**
 * Types for `fixtures.js`, which is plain JavaScript so that the capture script
 * and the test can share it. See that file for why.
 */
import type { Machine } from '../../core/Machine'
import type { RTC } from '../../core/IO/RTC'
import type { TmsMode } from '../../core/IO/Video'

export type FixtureStep = { run: number } | { type: string } | { capture: string }

export interface Fixture {
  name: string
  description: string
  /** Path to the ROM image, relative to the repository root. */
  rom: string
  /** Path to a cartridge image, relative to the repository root, or null. */
  cart: string | null
  steps: FixtureStep[]
}

/** What a debugger would print: exact, and the first thing to read on a failure. */
export interface StructuralGolden {
  cycles: number
  mode: TmsMode
  displayEnabled: boolean
  status: number
  registers: number[]
  vramSha256: string
  textGrid: string[]
}

export interface Capture {
  structural: StructuralGolden
  vram: Uint8Array
  /** The frame as palette indices — the strict oracle. */
  indices: Uint8Array
  /** The frame as RGBA, compared within {@link PIXEL_TOLERANCE}. */
  rgba: Uint8Array
}

/** The engine's classes, so the module works against `src/` or `out/` alike. */
export interface Engine {
  Machine: typeof Machine
  RTC: typeof RTC
}

export interface GoldenPaths {
  structural: string
  vram: string
  indices: string
  rgba: string
}

export interface DiffOptions {
  tolerance?: number
  stride?: number
  label?: string
}

export interface FrameDiffOptions {
  tolerance?: number
  channels?: number
}

export declare const FIXTURES: Fixture[]
export declare const FRAME_WIDTH: number
export declare const FRAME_HEIGHT: number
export declare const FREQUENCY: number
export declare const CYCLES_PER_FRAME: number
export declare const PIXEL_TOLERANCE: number
export declare const GOLDENS_DIR: string

export declare function checkpointsOf(fixture: Fixture): string[]
export declare function runFixture(
  engine: Engine,
  fixture: Fixture,
  onCapture: (checkpoint: string, capture: Capture) => void
): Machine
export declare function captureState(machine: Machine): Capture

export declare function goldenPaths(fixtureName: string, checkpoint: string): GoldenPaths
export declare function writeGolden(
  fixtureName: string,
  checkpoint: string,
  capture: Capture
): GoldenPaths
export declare function readGolden(fixtureName: string, checkpoint: string): Capture

/** A sentence describing the first difference, or null when there is none. */
export declare function diffBytes(
  actual: Uint8Array,
  expected: Uint8Array,
  options?: DiffOptions
): string | null
export declare function diffFrame(
  actual: Uint8Array,
  expected: Uint8Array,
  options?: FrameDiffOptions
): string | null

export declare function encodePNG(width: number, height: number, rgba: Uint8Array): Buffer
export declare function decodePNG(file: Buffer, width: number, height: number): Uint8Array
