import type { VdpModel } from '../core/IO/VideoCard'

/**
 * Choosing the video card: one source for the CLI, the app, the web build and
 * the embed.
 *
 * The card is named the same way everywhere — `--vdp`, `vdp=`,
 * `AppSettings.vdp`, a snapshot's `vdp`, `session.info.vdp` — and the values
 * are `VdpModel`'s. Import-free apart from that type, so every host can take it.
 */

/**
 * The video card a machine gets when nothing names one.
 *
 * The TMS9918A until the PICOVDP clears its hardware gate (firmware proven on
 * the board, BIOS 2.0 released, the docs rewritten); the flip is a release of
 * its own. Unpinned callers — an embed without `vdp=`, `make run`, WIZARDSLAB —
 * keep the machine they had in 2.7.0 until then.
 */
export const DEFAULT_VDP: VdpModel = 'tms9918a'

/**
 * The bundled ROM each card boots when no ROM is named, as a file name under
 * `assets/roms/` (the app and CLI) and `roms/` (the web build).
 *
 * A ROM never selects a card; the card selects the bundled ROM. `BIOS.bin`
 * keeps its meaning — the 1.x BIOS — for good, and the PICOVDP boots it in the
 * legacy submode until BIOS 2.0 is bundled under a name of its own.
 */
export const BUNDLED_ROM: Record<VdpModel, string> = {
  tms9918a: 'BIOS.bin',
  picovdp: 'BIOS.bin'
}

/**
 * A card's name as a person typed it, or null if it names no card. Trimmed and
 * case-insensitive, so `--vdp PicoVDP` and `vdp=%20picovdp` both work.
 */
export function parseVdp(raw: string | null | undefined): VdpModel | null {
  if (raw === null || raw === undefined) return null
  const value = raw.trim().toLowerCase()
  return value === 'tms9918a' || value === 'picovdp' ? value : null
}

/**
 * Whether a ROM is a BIOS that needs the PICOVDP: its text says `6502 BIOS v2.`.
 *
 * 2.x has no TMS9918A support, so a 2.x ROM on a TMS9918A draws garbage rather
 * than failing. Used for a warning, never to change the card.
 */
export function romWantsPicovdp(rom: Uint8Array): boolean {
  let text = ''
  for (let i = 0; i < rom.length; i++) text += String.fromCharCode(rom[i]!)
  return /6502 BIOS v2\./.test(text)
}

/** The one line a host shows when `romWantsPicovdp` is true on the TMS9918A. */
export const VDP_MISMATCH_WARNING = 'BIOS 2.x needs the PICOVDP card (--vdp picovdp)'
