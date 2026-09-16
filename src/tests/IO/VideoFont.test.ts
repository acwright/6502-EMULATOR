/**
 * The built-in font (VDP-SPEC §7), as generated into `VideoFont.ts`.
 *
 * `scripts/sync-font.mjs --check` proves the generated file is 6502-PICOVDP's
 * `fonts/cp437-6x8.bin`, and needs that checkout. This proves what needs no
 * sibling: the spec's size, and that the font is the character set BIOS 1.x
 * uploads from ROM. `assets/roms/BIOS.bin` is the 1.x ROM for good, so the
 * check is permanent.
 *
 * Not in `Video.test.ts`, which also runs against 6502-PICOVDP's C core.
 */

import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'
import { FONT_6X8_CP437, FONT_SOURCE } from '../../core/IO/VideoFont'

const BIOS = readFileSync(join(__dirname, '../../../assets/roms/BIOS.bin'))

/** `$B800` in the address space: the ROM image starts at `$8000`. */
const CHARS_OFFSET = 0x3800

describe('VideoFont', () => {
  it('is 2,048 bytes: 256 glyphs of 8 rows', () => {
    expect(FONT_6X8_CP437.length).toBe(2048)
  })

  it('is byte-identical to BIOS.bin $B800-$BFFF, the 1.x character set', () => {
    const chars = BIOS.subarray(CHARS_OFFSET, CHARS_OFFSET + 0x800)
    expect(Buffer.from(FONT_6X8_CP437).equals(chars)).toBe(true)
  })

  it('draws character 1 as 70 88 D8 88 A8 88 70 00', () => {
    expect(Array.from(FONT_6X8_CP437.subarray(8, 16))).toEqual([
      0x70, 0x88, 0xd8, 0x88, 0xa8, 0x88, 0x70, 0x00
    ])
  })

  it('has the SHA-256 the spec makes normative, and records it', () => {
    const sha256 = createHash('sha256').update(FONT_6X8_CP437).digest('hex')
    expect(sha256).toBe('b2adc19efd10870196bad05d84eae51500599935c80f13d608a4f62278260577')
    expect(FONT_SOURCE.sha256).toBe(sha256)
  })

  it('leaves b1:0 of every row clear, outside the 6-pixel cell', () => {
    expect(FONT_6X8_CP437.every((row) => (row & 0x03) === 0)).toBe(true)
  })
})
