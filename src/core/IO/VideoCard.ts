import type { IO } from '../IO'

/**
 * The two video cards io8 can hold, and what the rest of the emulator may ask
 * of either.
 *
 * `Video.ts` is the 6502-PICOVDP (VDP-SPEC). `TMS9918A.ts` is the card of
 * emulator 2.7.0, restored. They are chosen by one name everywhere — `--vdp`,
 * `vdp=`, `AppSettings.vdp`, a snapshot's `vdp` and `session.info.vdp` — and
 * this is where that name is defined.
 *
 * Import-free apart from types, so that naming the cards does not pull either
 * one in. `createVideoCard.ts` builds them.
 */

/** A video card, by the name the CLI, the URL and snapshots use. */
export type VdpModel = 'tms9918a' | 'picovdp'

/** Every model, in the order they are offered. */
export const VDP_MODELS: readonly VdpModel[] = ['tms9918a', 'picovdp']

/**
 * The output frame of both cards: 320 x 240, one RGBA quad per pixel in
 * `buffer` and one palette index per pixel in `frameIndices()`. The TMS9918A
 * centres its 256 x 192 in it; the PICOVDP's §3 virtual frame is this size.
 */
export const DISPLAY_WIDTH = 320
export const DISPLAY_HEIGHT = 240

/** What a host, the debugger and the goldens use of a card, on either model. */
export interface VideoCard extends IO {
  readonly model: VdpModel
  /** How many registers `getRegister` reaches: 8 on the TMS9918A, 128 on the PICOVDP. */
  readonly registerCount: number
  /** The last complete frame, RGBA. */
  buffer: Buffer
  /** Set when a frame completes; the host clears it once presented. */
  frameReady: boolean
  /** 16 KB on the TMS9918A, 64 KB on the PICOVDP. */
  readonly vramSize: number
  readVRAM(offset: number): number
  writeVRAM(offset: number, value: number): void
  textGrid(): string[]
  frameIndices(): Uint8Array
  getRegister(reg: number): number
  setRegister(reg: number, value: number): void
  getStatus(): number
  isDisplayEnabled(): boolean
}
