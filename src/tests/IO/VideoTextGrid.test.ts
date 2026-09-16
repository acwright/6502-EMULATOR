/**
 * `Video.textGrid`, which `screen.text` returns, as the picture shows it:
 * layer 0's scroll applied (§13).
 *
 * Not in `Video.test.ts`, because that file is also run against 6502-PICOVDP's
 * C core (`jest.picovdp.cjs`), and what a debugger reads back is this
 * emulator's business, not the card's.
 */
import { Video } from '../../core/IO/Video'

const REG_VMODE = 0x0d
const REG_L0NAME = 0x10
const REG_L0SCRX = 0x13
const REG_L0SCRY = 0x14
const REG_L0CTRL = 0x15

/** A register write through port A's command protocol (§4). */
const setReg = (vdp: Video, reg: number, value: number): void => {
  vdp.write(1, value)
  vdp.write(1, 0x80 | reg)
}

/** Label every cell of a `cols` x `rows` name table at `base` with its row, as a letter. */
const labelRows = (vdp: Video, base: number, cols: number, rows: number): void => {
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) vdp.writeVRAM(base + row * cols + col, 0x41 + row)
  }
}

/** Label every cell with its column, as a letter or digit. */
const labelCols = (vdp: Video, base: number, cols: number, rows: number): void => {
  const marks = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!#$%'
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) vdp.writeVRAM(base + row * cols + col, marks.charCodeAt(col))
  }
}

describe('textGrid with layer 0 scrolled (§13)', () => {
  it('starts one row down at L0SCRY = 8, and wraps the top row to the bottom', () => {
    const vdp = new Video()
    setReg(vdp, REG_VMODE, 0x01) // Text: 40 x 24
    labelRows(vdp, 0x0000, 40, 24)
    setReg(vdp, REG_L0SCRY, 8)

    const grid = vdp.textGrid()
    expect(grid).toHaveLength(24)
    expect(grid[0]).toBe('B'.repeat(40))
    expect(grid[22]).toBe('X'.repeat(40))
    expect(grid[23]).toBe('A'.repeat(40))
  })

  it('reads unscrolled as the name table in order', () => {
    const vdp = new Video()
    setReg(vdp, REG_VMODE, 0x01)
    labelRows(vdp, 0x0000, 40, 24)
    expect(vdp.textGrid()[0]).toBe('A'.repeat(40))
  })

  it('shows the row the top pixel falls in when L0SCRY is not a multiple of 8', () => {
    const vdp = new Video()
    setReg(vdp, REG_VMODE, 0x01)
    labelRows(vdp, 0x0000, 40, 24)
    setReg(vdp, REG_L0SCRY, 23) // two rows and seven pixels
    expect(vdp.textGrid()[0]).toBe('C'.repeat(40))
  })

  it('wraps L0SCRY at the picture height: 200 in Text is 8 lines', () => {
    const vdp = new Video()
    setReg(vdp, REG_VMODE, 0x01) // 192 lines
    labelRows(vdp, 0x0000, 40, 24)
    setReg(vdp, REG_L0SCRY, 200)
    expect(vdp.textGrid()[0]).toBe('B'.repeat(40))
  })

  it('starts L0SCRX / 6 columns in, in Text', () => {
    const vdp = new Video()
    setReg(vdp, REG_VMODE, 0x01)
    labelCols(vdp, 0x0000, 40, 24)
    setReg(vdp, REG_L0SCRX, 12)

    const line = vdp.textGrid()[0]!
    expect(line.startsWith('CDE')).toBe(true)
    expect(line.endsWith('%AB')).toBe(true)
  })

  it('takes L0CTRL b6 as bit 8 of X, in Full mode', () => {
    const vdp = new Video()
    setReg(vdp, REG_VMODE, 0x04) // Full: 40 x 30, 320 wide
    setReg(vdp, REG_L0NAME, 0x04) // $1000
    labelCols(vdp, 0x1000, 40, 30)
    setReg(vdp, REG_L0CTRL, 0x3c | 0x40)
    setReg(vdp, REG_L0SCRX, 0x08) // 264 pixels: 33 columns

    expect(vdp.textGrid()[0]!.startsWith('789')).toBe(true)
  })

  it('applies in the legacy submode too', () => {
    const vdp = new Video()
    setReg(vdp, 0x01, 0x50) // legacy Text: M1, display on
    setReg(vdp, 0x02, 0x0e) // name table at $3800
    labelRows(vdp, 0x3800, 40, 24)
    setReg(vdp, REG_L0SCRY, 16)
    expect(vdp.textGrid()[0]).toBe('C'.repeat(40))
  })
})
