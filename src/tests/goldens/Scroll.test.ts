/**
 * The BIOS console's scroll, held structurally.
 *
 * `bios/screenful` is the screen with its last row in use and `bios/scroll` is
 * the same screen after `PRINT "SCROLLED"`, which scrolls it four rows: the line
 * typed on row 23, its output, the blank line and `OK`. Whatever the BIOS draws
 * and however it scrolls (BIOS 2.0 on the PICOVDP moves the picture with the
 * layer-0 scroll register), the rows that did not change must be the rows above
 * them moved up: in the text, and in the index frame, pixel row for pixel row.
 *
 * Goldens.test.ts checks each capture against itself; this checks the two
 * captures against each other, so a re-capture that got the scroll wrong could
 * not pass by being self-consistent.
 */
import { FRAME_WIDTH, readGolden } from './fixtures'

/** Rows of text the console scrolled between the two checkpoints. */
const SCROLLED_ROWS = 4

/** Rows and cell height of the 40 × 24 Text console, and where it starts on the frame. */
const TEXT_ROWS = 24
const CELL_HEIGHT = 8
const ORIGIN_Y = 24

describe('bios: the console scroll', () => {
  const screenful = readGolden('bios', 'screenful')
  const scroll = readGolden('bios', 'scroll')

  const trimmed = (grid: string[]): string[] => grid.map((row) => row.trimEnd())

  it('fills the screen at screenful: something on the last row but one, the cursor row free', () => {
    const rows = trimmed(screenful.structural.textGrid)
    expect(rows).toHaveLength(TEXT_ROWS)
    expect(rows[TEXT_ROWS - 2]).toBe('OK')
    expect(rows[TEXT_ROWS - 1]).toBe('')
  })

  it('moves the unchanged text up by the scrolled rows, with the new lines below', () => {
    const before = trimmed(screenful.structural.textGrid)
    const after = trimmed(scroll.structural.textGrid)
    const kept = TEXT_ROWS - SCROLLED_ROWS - 1 // screenful's cursor row is typed over

    expect(after.slice(0, kept)).toEqual(before.slice(SCROLLED_ROWS, SCROLLED_ROWS + kept))
    expect(after.slice(kept)).toEqual(['PRINT "SCROLLED"', 'SCROLLED', '', 'OK', ''])
  })

  it('draws the unchanged rows where screenful drew them, higher by the scrolled rows', () => {
    const kept = TEXT_ROWS - SCROLLED_ROWS - 1
    const shift = SCROLLED_ROWS * CELL_HEIGHT
    const line = (frame: Uint8Array, y: number): number[] =>
      Array.from(frame.subarray(y * FRAME_WIDTH, (y + 1) * FRAME_WIDTH))

    for (let y = ORIGIN_Y; y < ORIGIN_Y + kept * CELL_HEIGHT; y++) {
      expect([y, line(scroll.indices, y)]).toEqual([y, line(screenful.indices, y + shift)])
    }
  })
})
